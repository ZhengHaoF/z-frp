/**
 * 服务端路由表：clientId、子域名、TCP 端口的映射，以及活跃流上下文。
 * 重注册是幂等的：先清掉该客户端的旧路由，再写入新路由。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type { WebSocket } from "ws";
import { isValidHost, type ProxySpec } from "@zfrp/shared";

export interface HttpStreamCtx {
  kind: "http";
  streamId: number;
  clientId: string;
  req: IncomingMessage;
  res: ServerResponse;
  openedAt: number;
  headSent: boolean;
  finFromClient: boolean;
  finFromServer: boolean;
}

export interface TcpStreamCtx {
  kind: "tcp";
  streamId: number;
  clientId: string;
  socket: Socket;
  openedAt: number;
  finFromClient: boolean;
  finFromServer: boolean;
}

export type StreamCtx = HttpStreamCtx | TcpStreamCtx;

export interface ClientRecord {
  clientId: string;
  ws: WebSocket | null;
  proxies: ProxySpec[];
  lastSeen: number;
  streams: Map<number, StreamCtx>;
  stats: { bytesIn: number; bytesOut: number; streamsTotal: number };
}

interface HttpRoute {
  clientId: string;
  proxyName: string;
}
interface TcpRoute {
  clientId: string;
  proxyName: string;
  authToken: string;
}

export class Registry {
  readonly clients = new Map<string, ClientRecord>();
  private readonly httpRoutes = new Map<string, HttpRoute>();
  private readonly tcpRoutes = new Map<number, TcpRoute>();

  getOrCreate(clientId: string): ClientRecord {
    let rec = this.clients.get(clientId);
    if (!rec) {
      rec = {
        clientId,
        ws: null,
        proxies: [],
        lastSeen: 0,
        streams: new Map(),
        stats: { bytesIn: 0, bytesOut: 0, streamsTotal: 0 },
      };
      this.clients.set(clientId, rec);
    }
    return rec;
  }

  /**
   * 幂等重注册。返回被拒绝的代理（冲突或非法）。
   * 注意：调用方应只在认证通过后调用。
   */
  register(clientId: string, proxies: ProxySpec[]): Array<{ name: string; reason: string }> {
    this.unregisterRoutes(clientId);
    const rec = this.getOrCreate(clientId);
    const rejected: Array<{ name: string; reason: string }> = [];
    const accepted: ProxySpec[] = [];
    const usedHosts = new Set<string>();
    const usedPorts = new Set<number>();

    for (const p of proxies) {
      if (!p.name || typeof p.name !== "string") {
        rejected.push({ name: String(p.name), reason: "代理名非法" });
        continue;
      }
      if (p.type === "http") {
        if (!isValidHost(p.host)) {
          rejected.push({ name: p.name, reason: `域名非法：${p.host}` });
          continue;
        }
        const host = p.host.toLowerCase();
        const existing = this.httpRoutes.get(host);
        if (existing && existing.clientId !== clientId) {
          rejected.push({ name: p.name, reason: `域名 ${host} 已被占用` });
          continue;
        }
        if (usedHosts.has(host)) {
          rejected.push({ name: p.name, reason: `域名 ${host} 在本配置中重复` });
          continue;
        }
        usedHosts.add(host);
        this.httpRoutes.set(host, { clientId, proxyName: p.name });
        accepted.push(p);
      } else {
        const port = p.remotePort;
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          rejected.push({ name: p.name, reason: "remotePort 非法" });
          continue;
        }
        if (!p.authToken || p.authToken.length < 8) {
          rejected.push({ name: p.name, reason: "TCP 代理必须设置至少 8 位的 authToken" });
          continue;
        }
        const existing = this.tcpRoutes.get(port);
        if (existing && existing.clientId !== clientId) {
          rejected.push({ name: p.name, reason: `端口 ${port} 已被占用` });
          continue;
        }
        if (usedPorts.has(port)) {
          rejected.push({ name: p.name, reason: `端口 ${port} 在本配置中重复` });
          continue;
        }
        usedPorts.add(port);
        this.tcpRoutes.set(port, { clientId, proxyName: p.name, authToken: p.authToken });
        accepted.push(p);
      }
    }

    rec.proxies = accepted;
    rec.lastSeen = Date.now();
    return rejected;
  }

  private unregisterRoutes(clientId: string): void {
    for (const [host, route] of this.httpRoutes) {
      if (route.clientId === clientId) this.httpRoutes.delete(host);
    }
    for (const [port, route] of this.tcpRoutes) {
      if (route.clientId === clientId) this.tcpRoutes.delete(port);
    }
  }

  /** 客户端断开：清路由、掐断所有活跃流。 */
  disconnect(clientId: string): void {
    this.unregisterRoutes(clientId);
    const rec = this.clients.get(clientId);
    if (!rec) return;
    for (const stream of rec.streams.values()) {
      this.destroyStream(stream, "客户端断开");
    }
    rec.streams.clear();
    rec.ws = null;
    rec.proxies = [];
  }

  destroyStream(stream: StreamCtx, reason: string): void {
    if (stream.kind === "http") {
      if (!stream.res.writableEnded) {
        stream.res.destroy(new Error(reason));
      }
    } else {
      stream.socket.destroy(new Error(reason));
    }
  }

  resolveHttp(hostHeader: string): { route: HttpRoute } | null {
    const host = (hostHeader || "").split(":")[0]!.toLowerCase();
    const route = this.httpRoutes.get(host);
    return route ? { route } : null;
  }

  resolveTcp(port: number): TcpRoute | undefined {
    return this.tcpRoutes.get(port);
  }

  addStream(clientId: string, stream: StreamCtx): void {
    const rec = this.getOrCreate(clientId);
    rec.streams.set(stream.streamId, stream);
    rec.stats.streamsTotal += 1;
  }

  getStream(clientId: string, streamId: number): StreamCtx | undefined {
    return this.clients.get(clientId)?.streams.get(streamId);
  }

  removeStream(clientId: string, streamId: number): void {
    this.clients.get(clientId)?.streams.delete(streamId);
  }

  snapshot(): Record<string, unknown> {
    const clients = [...this.clients.values()].map((c) => ({
      clientId: c.clientId,
      online: c.ws !== null && c.ws.readyState === 1,
      lastSeen: c.lastSeen,
      proxies: c.proxies.map((p) => ({
        name: p.name,
        type: p.type,
        ...(p.type === "http"
          ? { host: p.host }
          : { remotePort: p.remotePort }),
      })),
      activeStreams: c.streams.size,
      stats: c.stats,
    }));
    return {
      clients,
      httpHosts: [...this.httpRoutes.keys()],
      tcpPorts: [...this.tcpRoutes.keys()],
      totals: {
        clients: clients.length,
        online: clients.filter((c) => c.online).length,
        activeStreams: clients.reduce((n, c) => n + c.activeStreams, 0),
      },
    };
  }
}
