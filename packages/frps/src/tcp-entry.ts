/**
 * TCP 入口：访客连上公网端口 → AUTH 握手 → 打开到 frpc 的流 → 双向转发。
 * 每个 remotePort 一有注册就监听；客户端断开时关掉监听。
 */
import { createServer, type Server, type Socket } from "node:net";
import { FLAG_FIN, FLAG_RST } from "@zfrp/shared";
import type { TunnelHub } from "./tunnel.js";
import type { TcpStreamCtx } from "./registry.js";
import type { Logger } from "@zfrp/shared";

const AUTH_TIMEOUT_MS = 10_000;
const MAX_AUTH_LINE = 4096;

export interface TcpEntryManagerOptions {
  bindAddr: string;
  log: Logger;
}

export class TcpEntryManager {
  private readonly servers = new Map<number, Server>();
  private readonly seenPorts = new Set<number>();

  constructor(
    private readonly hub: TunnelHub,
    private readonly opts: TcpEntryManagerOptions,
  ) {}

  /** 根据当前注册表同步监听端口（注册/断线后调用） */
  sync(): void {
    const wanted = new Set<number>();
    for (const rec of this.hub.registry.clients.values()) {
      for (const p of rec.proxies) {
        if (p.type === "tcp") wanted.add(p.remotePort);
      }
    }
    for (const [port, server] of this.servers) {
      if (!wanted.has(port) || !this.hub.registry.resolveTcp(port)) {
        server.close();
        this.servers.delete(port);
        this.opts.log.info("TCP 入口停止", { port });
      }
    }
    for (const port of wanted) {
      if (this.servers.has(port)) continue;
      this.listen(port);
    }
  }

  private listen(port: number): void {
    const server = createServer((socket) => this.onSocket(port, socket));
    server.on("error", (err) => {
      this.opts.log.error("TCP 入口监听失败", { port, error: err.message });
      this.servers.delete(port);
    });
    server.listen(port, this.opts.bindAddr, () => {
      this.servers.set(port, server);
      this.opts.log.info("TCP 入口已监听", { addr: `${this.opts.bindAddr}:${port}` });
    });
  }

  private onSocket(port: number, socket: Socket): void {
    const route = this.hub.registry.resolveTcp(port);
    if (!route) {
      socket.destroy();
      return;
    }

    let authBuf = "";
    let authenticated = false;
    const timer = setTimeout(() => {
      if (!authenticated) {
        socket.write("ERR auth timeout\n");
        socket.destroy();
      }
    }, AUTH_TIMEOUT_MS);
    timer.unref();

    const onAuthData = (chunk: Buffer): void => {
      authBuf += chunk.toString("utf8");
      if (authBuf.length > MAX_AUTH_LINE) {
        clearTimeout(timer);
        socket.write("ERR auth line too long\n");
        socket.destroy();
        return;
      }
      const nl = authBuf.indexOf("\n");
      if (nl < 0) return;
      const line = authBuf.slice(0, nl).trim();
      const rest = authBuf.slice(nl + 1);
      socket.off("data", onAuthData);
      clearTimeout(timer);

      const match = /^AUTH\s+(\S+)$/i.exec(line);
      if (!match || match[1] !== route.authToken) {
        this.opts.log.warn("TCP 访客认证失败", { port, remote: socket.remoteAddress });
        socket.write("ERR bad token\n");
        socket.destroy();
        return;
      }
      authenticated = true;
      socket.write("OK\n");
      this.startRelay(port, route.clientId, route.proxyName, socket, Buffer.from(rest, "utf8"));
    };
    socket.on("data", onAuthData);
    socket.on("error", (err) => {
      clearTimeout(timer);
      this.opts.log.debug("TCP 访客连接错误", { port, error: err.message });
    });
  }

  private startRelay(
    port: number,
    clientId: string,
    proxyName: string,
    socket: Socket,
    initial: Buffer,
  ): void {
    let finished = false;
    const ctx: TcpStreamCtx = {
      kind: "tcp",
      streamId: 0,
      clientId,
      socket,
      openedAt: Date.now(),
      finFromClient: false,
      finFromServer: false,
    };

    const finish = (reason: string): void => {
      if (finished) return;
      finished = true;
      this.hub.registry.removeStream(clientId, ctx.streamId);
      if (!socket.destroyed) socket.destroy();
    };

    const tunnel = this.hub.openStream(
      clientId,
      proxyName,
      undefined,
      (streamId) => {
        ctx.streamId = streamId;
        return ctx;
      },
      {
        onData: (frame) => {
          if (frame.payload.length && !socket.destroyed) socket.write(frame.payload);
        },
        onClose: finish,
      },
    );

    if (!tunnel) {
      socket.write("ERR client offline\n");
      socket.destroy();
      return;
    }

    if (initial.length) tunnel.send(initial);
    socket.on("data", (chunk) => tunnel.send(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    socket.on("end", () => tunnel.send(Buffer.alloc(0), FLAG_FIN));
    socket.on("close", () => finish("访客关闭"));

    this.opts.log.info("TCP 会话建立", {
      port,
      clientId,
      proxy: proxyName,
      streamId: tunnel.streamId,
      remote: socket.remoteAddress,
    });
  }
}
