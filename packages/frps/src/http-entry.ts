/** HTTP 入口：按完整域名的 Host 头路由 → 打开流 → 把 frpc 回传的数据写成 HTTP 响应。 */
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
    void handle(req, res).catch((err: unknown) => {
      // 单个请求出错不能带崩整个进程
      opts.log.warn("HTTP 请求处理异常", {
        host: req.headers.host,
        path: req.url,
        error: err instanceof Error ? err.message : String(err),
      });
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      if (!res.writableEnded) res.end("z-frp: internal error");
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const route = hub.registry.resolveHttp(req.headers.host ?? "");
    if (!route) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("z-frp: unknown host");
      return;
    }

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
    let aborted = false;
    const finish = (reason: string): void => {
      if (finished) return;
      finished = true;
      aborted = true;
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

    res.on("close", () => {
      if (!finished) finish("客户端提前关闭");
    });

    // 边读边转发：不做全量缓冲。大请求体（AI 的长 prompt、图片 base64）不再整段堆在内存里，
    // 对端也能在 body 还没传完时就开始处理，首字节更早。
    let bodyBytes = 0;
    try {
      for await (const chunk of req) {
        if (aborted) break;
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
        bodyBytes += buf.length;
        tunnel.send(buf, 0);
      }
    } catch (err) {
      // 请求体读到一半中断（客户端 abort / socket 出错）：收掉这条流再抛给外层兜底
      hub.abortStream(route.route.clientId, ctx.streamId, "读取请求体失败");
      throw err;
    }

    if (aborted) return;

    // 请求体结束（可能为空）：单独补一帧带 FIN 的空帧，告知对端请求已发完
    tunnel.send(Buffer.alloc(0), FLAG_FIN);
    opts.log.debug("HTTP 请求已转发", {
      host: req.headers.host,
      clientId: route.route.clientId,
      proxy: route.route.proxyName,
      streamId: tunnel.streamId,
      bodyBytes,
    });
  }

  server.listen(opts.port, opts.bindAddr, () => {
    opts.log.info("HTTP 入口已监听", { addr: `${opts.bindAddr}:${opts.port}` });
  });
  return server;
}
