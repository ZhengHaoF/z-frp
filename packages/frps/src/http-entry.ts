/** HTTP 入口：泛域名 Host 路由 → 打开流 → 把 frpc 回传的数据写成 HTTP 响应。 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { FLAG_FIN, type Logger } from "@zfrp/shared";
import type { TunnelHub } from "./tunnel.js";
import type { HttpStreamCtx } from "./registry.js";

export interface HttpEntryOptions {
  bindAddr: string;
  port: number;
  log: Logger;
}

export function startHttpEntry(hub: TunnelHub, opts: HttpEntryOptions): Server {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(req, res);
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const route = hub.registry.resolveHttp(req.headers.host ?? "");
    if (!route) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("z-frp: unknown host");
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const body = Buffer.concat(chunks);

    const ctx: HttpStreamCtx = {
      kind: "http",
      streamId: 0,
      clientId: route.route.clientId,
      req,
      res,
      openedAt: Date.now(),
      headSent: false,
      finFromClient: false,
      finFromServer: false,
    };

    let finished = false;
    const finish = (reason: string): void => {
      if (finished) return;
      finished = true;
      hub.registry.removeStream(route.route.clientId, ctx.streamId);
      if (!res.writableEnded) {
      if (!ctx.headSent && !res.headersSent) res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      if (!res.writableEnded) res.end(reason === "正常结束" ? undefined : `z-frp: ${reason}`);
      }
    };

    const tunnel = hub.openStream(
      route.route.clientId,
      route.route.proxyName,
      req,
      (streamId) => {
        ctx.streamId = streamId;
        return ctx;
      },
      {
        onData: (frame) => {
          if (frame.payload.length) res.write(frame.payload);
        },
        onClose: finish,
      },
    );

    if (!tunnel) {
      res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      res.end("z-frp: client offline");
      return;
    }

    // 请求体可能为空；发一个带 FIN 的空帧表示请求结束
    tunnel.send(body, FLAG_FIN);
    opts.log.debug("HTTP 请求已转发", {
      host: req.headers.host,
      clientId: route.route.clientId,
      proxy: route.route.proxyName,
      streamId: tunnel.streamId,
      bodyBytes: body.length,
    });

    res.on("close", () => {
      if (!finished) finish("客户端提前关闭");
    });
  }

  server.listen(opts.port, opts.bindAddr, () => {
    opts.log.info("HTTP 入口已监听", { addr: `${opts.bindAddr}:${opts.port}` });
  });
  return server;
}
