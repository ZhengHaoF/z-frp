/**
 * frpc 连接管理：认证 → 注册 → 心跳 → 隧道数据。断线指数退避重连，重连后全量重注册。
 */
import WebSocket from "ws";
import {
  DEFAULTS,
  decodeControl,
  decodeDataFrame,
  encodeControl,
  encodeDataFrame,
  TUNNEL_PATH,
  type ControlFrame,
  type FrpcConfig,
  type Logger,
  type ProxySpec,
} from "@zfrp/shared";
import { openHttpStream, openTcpStream, type Sender } from "./proxy.js";

const MAX_BACKOFF_MS = 30_000;

export class FrpcClient {
  private ws: WebSocket | null = null;
  private heartbeatTimer?: NodeJS.Timeout;
  private reconnectTimer?: NodeJS.Timeout;
  private lastAckAt = 0;
  private stopped = false;
  private readonly feeders = new Map<number, (frame: ReturnType<typeof decodeDataFrame> & object) => void>();

  constructor(
    private readonly cfg: FrpcConfig,
    private readonly log: Logger,
  ) {}

  start(): void {
    this.stopped = false;
    this.connect(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.ws) {
      this.ws.close(1000, "stop");
      this.ws = null;
    }
    this.feeders.clear();
  }

  private serverUrl(): string {
    const url = new URL(this.cfg.server);
    if (!url.pathname || url.pathname === "/") url.pathname = TUNNEL_PATH;
    return url.toString();
  }

  private connect(attempt: number): void {
    if (this.stopped) return;
    const url = this.serverUrl();
    this.log.info("连接 frps", { url, attempt });
    const ws = new WebSocket(url, { handshakeTimeout: 10_000 });
    this.ws = ws;

    let authenticated = false;

    const failTimer = setTimeout(() => {
      if (!authenticated) {
        this.log.warn("握手超时", { url });
        ws.terminate();
      }
    }, 10_000);
    failTimer.unref();

    const heartbeatMs = this.cfg.heartbeatIntervalMs ?? DEFAULTS.heartbeatIntervalMs;

    ws.on("open", () => {
      clearTimeout(failTimer);
      this.sendControl({ type: "hello", v: 1, clientId: this.cfg.clientId, token: this.cfg.token });
    });

    ws.on("message", (raw, isBinary) => {
      if (isBinary) {
        const frame = decodeDataFrame(raw as Buffer);
        if (!frame) return;
        const feeder = this.feeders.get(frame.streamId);
        if (feeder) feeder(frame);
        return;
      }
      const ctrl = decodeControl(raw.toString());
      if (!ctrl) return;
      this.onControl(ctrl, ws, () => {
        authenticated = true;
      });
    });

    ws.on("pong", () => {
      this.lastAckAt = Date.now();
    });

    ws.on("close", (code, reason) => {
      clearTimeout(failTimer);
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      this.feeders.clear();
      if (this.ws === ws) this.ws = null;
      if (this.stopped) return;
      this.log.warn("与 frps 断开，准备重连", {
        code,
        reason: reason.toString(),
        attempt: attempt + 1,
      });
      this.scheduleReconnect(attempt + 1);
    });

    ws.on("error", (err) => {
      this.log.warn("WebSocket 错误", { error: err.message });
    });
  }

  private scheduleReconnect(attempt: number): void {
    const base = this.cfg.reconnectBaseMs ?? DEFAULTS.reconnectBaseMs;
    const delay = Math.min(base * 2 ** Math.min(attempt, 8), MAX_BACKOFF_MS);
    this.reconnectTimer = setTimeout(() => this.connect(attempt), delay);
  }

  private sendControl(frame: Omit<ControlFrame, "v">): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(encodeControl(frame as ControlFrame));
  }

  private sendData: Sender = (streamId, payload, flags) => {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(encodeDataFrame(streamId, payload, flags));
  };

  private sendHead = (streamId: number, statusCode: number, headers: Record<string, string>): void => {
    this.sendControl({ type: "stream-head", v: 1, streamId, statusCode, headers });
  };

  private onControl(ctrl: ControlFrame, ws: WebSocket, markAuthenticated: () => void): void {
    switch (ctrl.type) {
      case "hello-ok": {
        markAuthenticated();
        this.lastAckAt = Date.now();
        this.register();
        this.startHeartbeat(ws, ctrl.heartbeatIntervalMs);
        this.log.info("认证通过，代理已上线", { clientId: this.cfg.clientId });
        break;
      }
      case "hello-reject": {
        this.log.error("认证被拒", { reason: ctrl.reason });
        ws.close(1008, "rejected");
        break;
      }
      case "register-ok": {
        if (ctrl.rejected.length) {
          this.log.warn("部分代理注册被拒", { rejected: ctrl.rejected });
        } else {
          this.log.info("全部代理注册成功", { count: this.cfg.proxies.length });
        }
        break;
      }
      case "register-reject": {
        this.log.error("注册被拒", { reason: ctrl.reason });
        break;
      }
      case "stream-open": {
        this.onStreamOpen(ctrl.streamId, ctrl.proxyName, ctrl.req);
        break;
      }
      case "heartbeat-ack": {
        this.lastAckAt = Date.now();
        break;
      }
      case "error": {
        this.log.warn("frps 报错", { streamId: ctrl.streamId, reason: ctrl.reason });
        break;
      }
      default:
        break;
    }
  }

  private register(): void {
    const proxies = this.cfg.proxies.map((p) => ({
      name: p.name,
      type: p.type,
      ...(p.type === "http"
        ? { subdomain: p.subdomain }
        : { remotePort: p.remotePort, authToken: p.authToken }),
    }));
    this.sendControl({ type: "register", v: 1, proxies: proxies as ProxySpec[] });
  }

  private startHeartbeat(ws: WebSocket, intervalMs: number): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    const timeout = this.cfg.heartbeatIntervalMs ?? DEFAULTS.heartbeatIntervalMs;
    this.heartbeatTimer = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (Date.now() - this.lastAckAt > timeout * 4) {
        this.log.warn("心跳长时间无响应，主动重连");
        ws.terminate();
        return;
      }
      this.sendControl({ type: "heartbeat", v: 1, at: Date.now() });
    }, intervalMs || timeout);
    this.heartbeatTimer.unref();
  }

  private onStreamOpen(
    streamId: number,
    proxyName: string,
    req?: { method: string; path: string; host: string; headers: Record<string, string> },
  ): void {
    const proxy = this.cfg.proxies.find((p) => p.name === proxyName);
    if (!proxy) {
      this.sendData(streamId, Buffer.from("未知代理"), 0x02);
      return;
    }
    const unregister = (id: number) => this.feeders.delete(id);
    if (proxy.type === "http" && req) {
      this.feeders.set(
        streamId,
        openHttpStream(streamId, proxy.local, req, this.sendData, this.sendHead, unregister, this.log) as never,
      );
    } else if (proxy.type === "tcp") {
      this.feeders.set(
        streamId,
        openTcpStream(streamId, proxy.localHost, proxy.localPort, this.sendData, unregister, this.log) as never,
      );
    } else {
      this.sendData(streamId, Buffer.from("代理类型与请求不匹配"), 0x02);
    }
  }
}
