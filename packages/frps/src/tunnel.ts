/**
 * WebSocket 隧道中枢：认证、注册、流分发、心跳。
 * 每个 frpc 一条 wss 连接，控制帧走文本，业务数据走 binary。
 */
import type { IncomingMessage } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import type { Duplex } from "node:stream";
import {
  FLAG_FIN,
  FLAG_RST,
  createStreamIdGenerator,
  decodeControl,
  decodeDataFrame,
  encodeControl,
  encodeDataFrame,
  type ControlFrame,
  type DataFrame,
  type Logger,
  type ProxySpec,
} from "@zfrp/shared";
import { Registry, type HttpStreamCtx, type StreamCtx } from "./registry.js";

export interface TunnelOptions {
  domain: string;
  clients: Record<string, string>;
  heartbeatIntervalMs: number;
  heartbeatTimeoutMs: number;
  log: Logger;
}

interface StreamSink {
  /** frpc 发来的数据帧 */
  onData(frame: DataFrame): void;
  /** 流被对端关闭或异常终止 */
  onClose(reason: string): void;
}

export class TunnelHub {
  readonly registry: Registry;
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  private readonly nextId = createStreamIdGenerator();
  private readonly sinks = new Map<string, StreamSink>();
  private sweepTimer?: NodeJS.Timeout;

  constructor(
    private readonly opts: TunnelOptions,
    registry?: Registry,
  ) {
    this.registry = registry ?? new Registry();
  }

  /** 挂到 HTTP server 的 upgrade 事件，只接管 TUNNEL_PATH */
  attach(server: import("node:http").Server, path: string): void {
    server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname !== path) {
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, req));
    });
    this.sweepTimer = setInterval(() => this.sweep(), Math.min(this.opts.heartbeatTimeoutMs / 3, 30_000));
    this.sweepTimer.unref();
  }

  private key(clientId: string, streamId: number): string {
    return `${clientId}:${streamId}`;
  }

  private send(ws: WebSocket, frame: ControlFrame): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(encodeControl(frame));
  }

  private sendData(ws: WebSocket, streamId: number, payload: Buffer, flags = 0): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(encodeDataFrame(streamId, payload, flags));
  }

  private countIn(clientId: string, bytes: number): void {
    const rec = this.registry.getOrCreate(clientId);
    rec.stats.bytesIn += bytes;
  }

  private countOut(clientId: string, bytes: number): void {
    const rec = this.registry.getOrCreate(clientId);
    rec.stats.bytesOut += bytes;
  }

  private onConnection(ws: WebSocket, req: IncomingMessage): void {
    const remote = req.socket.remoteAddress ?? "?";
    this.opts.log.info("frpc 连接建立", { remote });
    let clientId: string | null = null;
    let alive = true;

    ws.on("message", (raw, isBinary) => {
      if (isBinary) {
        if (!clientId) return;
        const frame = decodeDataFrame(raw as Buffer);
        if (!frame) return;
        this.countIn(clientId, frame.payload.length);
        this.dispatchData(clientId, frame);
        return;
      }
      const ctrl = decodeControl(raw.toString());
      if (!ctrl) return;

      if (ctrl.type === "hello") {
        if (clientId) return;
        const expected = this.opts.clients[ctrl.clientId];
        if (!expected || expected !== ctrl.token) {
          this.opts.log.warn("frpc 认证失败", { clientId: ctrl.clientId, remote });
          this.send(ws, { type: "hello-reject", v: 1, reason: "clientId 或 token 不正确" });
          ws.close(1008, "auth failed");
          return;
        }
        clientId = ctrl.clientId;
        const rec = this.registry.getOrCreate(clientId);
        // 同一 clientId 只允许一条活跃连接：新连接顶替旧连接
        if (rec.ws && rec.ws !== ws && rec.ws.readyState === WebSocket.OPEN) {
          this.opts.log.warn("同 clientId 新连接顶替旧连接", { clientId });
          for (const [key, sink] of this.sinks) {
            if (key.startsWith(`${clientId}:`)) sink.onClose("被新连接顶替");
          }
          this.registry.disconnect(clientId);
          rec.ws.terminate();
        }
        rec.ws = ws;
        rec.lastSeen = Date.now();
        this.send(ws, {
          type: "hello-ok",
          v: 1,
          clientId,
          heartbeatIntervalMs: this.opts.heartbeatIntervalMs,
        });
        this.opts.log.info("frpc 认证通过", { clientId });
        return;
      }

      if (!clientId) {
        this.send(ws, { type: "error", v: 1, reason: "未认证" });
        return;
      }

      switch (ctrl.type) {
        case "register": {
          const specs = Array.isArray(ctrl.proxies) ? (ctrl.proxies as ProxySpec[]) : [];
          const rejected = this.registry.register(clientId, this.opts.domain, specs);
          this.send(ws, { type: "register-ok", v: 1, rejected });
          this.opts.log.info("代理注册完成", {
            clientId,
            accepted: specs.length - rejected.length,
            rejected: rejected.length,
          });
          break;
        }
        case "heartbeat": {
          const rec = this.registry.getOrCreate(clientId);
          rec.lastSeen = Date.now();
          this.send(ws, { type: "heartbeat-ack", v: 1, at: Date.now() });
          break;
        }
        case "stream-head": {
          const stream = this.registry.getStream(clientId, ctrl.streamId);
          if (stream?.kind === "http") {
            const ctx = stream as HttpStreamCtx;
            if (!ctx.headSent && !ctx.res.headersSent) {
              ctx.headSent = true;
              ctx.res.writeHead(ctrl.statusCode, this.cleanHeaders(ctrl.headers));
            }
          }
          break;
        }
        case "stream-close": {
          const stream = this.registry.getStream(clientId, ctrl.streamId);
          if (stream) this.finishStream(clientId, ctrl.streamId, stream, "对端关闭");
          break;
        }
        case "error": {
          this.opts.log.warn("frpc 报错", { clientId, streamId: ctrl.streamId, reason: ctrl.reason });
          if (ctrl.streamId !== undefined) {
            const stream = this.registry.getStream(clientId, ctrl.streamId);
            if (stream) this.finishStream(clientId, ctrl.streamId, stream, ctrl.reason);
          }
          break;
        }
        default:
          break;
      }
    });

    ws.on("pong", () => {
      if (clientId) this.registry.getOrCreate(clientId).lastSeen = Date.now();
    });

    ws.on("close", (code, reason) => {
      alive = false;
      if (!clientId) return;
      // 只有当前活跃连接断开才清路由；被顶替的旧连接断开不影响新连接
      const rec = this.registry.getOrCreate(clientId);
      if (rec.ws !== ws) {
        this.opts.log.debug("旧连接关闭（已被顶替）", { clientId, code });
        return;
      }
      this.opts.log.info("frpc 断开", { clientId, code, reason: reason.toString() });
      for (const [key, sink] of this.sinks) {
        if (key.startsWith(`${clientId}:`)) sink.onClose("客户端断开");
      }
      this.registry.disconnect(clientId);
    });

    ws.on("error", (err) => {
      this.opts.log.warn("frpc 连接错误", { clientId: clientId ?? "未认证", error: err.message });
      if (alive) ws.terminate();
    });
  }

  private cleanHeaders(headers: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers ?? {})) {
      const lower = k.toLowerCase();
      if (["connection", "transfer-encoding", "content-length", "keep-alive", "upgrade"].includes(lower)) continue;
      out[k] = v;
    }
    return out;
  }

  private dispatchData(clientId: string, frame: DataFrame): void {
    const sink = this.sinks.get(this.key(clientId, frame.streamId));
    if (!sink) return;
    if (frame.flags & FLAG_RST) {
      sink.onClose("流被复位");
      return;
    }
    sink.onData(frame);
    if (frame.flags & FLAG_FIN) {
      sink.onClose("正常结束");
    }
  }

  private finishStream(clientId: string, streamId: number, stream: StreamCtx, reason: string): void {
    const sink = this.sinks.get(this.key(clientId, streamId));
    this.sinks.delete(this.key(clientId, streamId));
    this.registry.removeStream(clientId, streamId);
    if (sink) sink.onClose(reason);
    else this.registry.destroyStream(stream, reason);
  }

  /**
   * 开一条新流。返回 null 表示该客户端不在线。
   * ctx 由调用方在拿到 streamId 后构造并登记（HTTP 带 res，TCP 带 socket）。
   */
  openStream(
    clientId: string,
    proxyName: string,
    req: IncomingMessage | undefined,
    ctx: (streamId: number) => StreamCtx,
    sink: StreamSink,
  ): { streamId: number; send: (payload: Buffer, flags?: number) => void; close: () => void } | null {
    const rec = this.registry.getOrCreate(clientId);
    if (!rec.ws || rec.ws.readyState !== WebSocket.OPEN) return null;
    const streamId = this.nextId();
    const key = this.key(clientId, streamId);
    this.sinks.set(key, sink);
    this.registry.addStream(clientId, ctx(streamId));
    const meta = req
      ? {
          method: req.method ?? "GET",
          path: req.url ?? "/",
          host: req.headers.host ?? "",
          headers: this.collectHeaders(req),
        }
      : undefined;
    this.send(rec.ws, { type: "stream-open", v: 1, streamId, proxyName, ...(meta ? { req: meta } : {}) });
    return {
      streamId,
      send: (payload: Buffer, flags = 0) => {
        this.countOut(clientId, payload.length);
        this.sendData(rec.ws!, streamId, payload, flags);
      },
      close: () => this.sendData(rec.ws!, streamId, Buffer.alloc(0), FLAG_FIN),
    };
  }

  private collectHeaders(req: IncomingMessage): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined) continue;
      out[k] = Array.isArray(v) ? v.join(", ") : v;
    }
    return out;
  }

  /** frpc → frps 未绑定流的清理（AUTH 失败等）由入口自行处理；这里做全局兜底 */
  abortStream(clientId: string, streamId: number, reason: string): void {
    const stream = this.registry.getStream(clientId, streamId);
    if (stream) this.finishStream(clientId, streamId, stream, reason);
    const rec = this.registry.getOrCreate(clientId);
    if (rec.ws?.readyState === WebSocket.OPEN) {
      this.sendData(rec.ws, streamId, Buffer.from(reason), FLAG_RST);
    }
  }

  private sweep(): void {
    const now = Date.now();
    for (const rec of this.registry.clients.values()) {
      if (!rec.ws || rec.ws.readyState !== WebSocket.OPEN) continue;
      if (now - rec.lastSeen > this.opts.heartbeatTimeoutMs) {
        this.opts.log.warn("心跳超时，断开客户端", {
          clientId: rec.clientId,
          idleMs: now - rec.lastSeen,
        });
        rec.ws.terminate();
      }
    }
  }
}
