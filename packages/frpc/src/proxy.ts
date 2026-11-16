/** 本地代理：HTTP 与 TCP。每个 stream 对应一个本地连接。 */
import http from "node:http";
import net from "node:net";
import { FLAG_FIN, FLAG_RST, type DataFrame, type Logger } from "@zfrp/shared";

export interface StreamIO {
  send(payload: Buffer, flags?: number): void;
  end(): void;
  reset(reason: string): void;
}

export interface StreamRequest {
  proxyName: string;
  meta?: {
    method: string;
    path: string;
    host: string;
    headers: Record<string, string>;
  };
}

export type Sender = (streamId: number, payload: Buffer, flags?: number) => void;
export type HeadSender = (streamId: number, statusCode: number, headers: Record<string, string>) => void;

/** 为某个 HTTP 请求开到本地服务的连接，返回 feeder。 */
export function openHttpStream(
  streamId: number,
  target: string,
  meta: NonNullable<StreamRequest["meta"]>,
  send: Sender,
  sendHead: HeadSender,
  unregister: (id: number) => void,
  log: Logger,
): (frame: DataFrame) => void {
  const io = makeStreamIo(streamId, send);
  const url = new URL(meta.path, target);
  const headers = { ...meta.headers };
  delete headers["host"];
  delete headers["connection"];
  delete headers["transfer-encoding"];
  const req = http.request(
    url,
    { method: meta.method, headers },
    (res) => {
      const respHeaders: Record<string, string> = {};
      for (const [k, v] of Object.entries(res.headers)) {
        if (v === undefined) continue;
        respHeaders[k] = Array.isArray(v) ? v.join(", ") : v;
      }
      sendHead(streamId, res.statusCode ?? 502, respHeaders);
      res.on("data", (chunk: Buffer) => send(streamId, chunk));
      res.on("end", () => {
        io.end();
        unregister(streamId);
      });
      res.on("error", (err) => {
        io.reset(err.message);
        unregister(streamId);
      });
    },
  );
  req.on("error", (err) => {
    io.reset(`连接本地服务失败: ${err.message}`);
    unregister(streamId);
  });

  let finished = false;
  return (frame: DataFrame) => {
    if (frame.payload.length) req.write(frame.payload);
    if (frame.flags & FLAG_FIN) {
      if (!finished) {
        finished = true;
        req.end();
      }
    }
    if (frame.flags & FLAG_RST) {
      req.destroy(new Error("流被复位"));
      unregister(streamId);
    }
  };
}

/** 为某个 TCP 会话开到本地服务的连接，返回 feeder。 */
export function openTcpStream(
  streamId: number,
  host: string,
  port: number,
  send: Sender,
  unregister: (id: number) => void,
  log: Logger,
): (frame: DataFrame) => void {
  const io = makeStreamIo(streamId, send);
  const socket = net.connect({ host, port });
  const queue: Buffer[] = [];
  let connected = false;

  socket.on("connect", () => {
    connected = true;
    for (const chunk of queue) socket.write(chunk);
    queue.length = 0;
  });
  socket.on("data", (chunk: Buffer) => send(streamId, chunk));
  socket.on("end", () => {
    io.end();
    unregister(streamId);
  });
  socket.on("error", (err) => {
    io.reset(`连接本地 TCP 服务失败: ${err.message}`);
    unregister(streamId);
    socket.destroy();
  });
  socket.on("close", () => unregister(streamId));

  let finished = false;
  return (frame: DataFrame) => {
    if (frame.payload.length) {
      if (connected) socket.write(frame.payload);
      else queue.push(Buffer.from(frame.payload));
    }
    if (frame.flags & FLAG_FIN) {
      if (!finished) {
        finished = true;
        socket.end();
      }
    }
    if (frame.flags & FLAG_RST) {
      socket.destroy(new Error("流被复位"));
      unregister(streamId);
    }
  };
}

function makeStreamIo(streamId: number, send: Sender): StreamIO {
  return {
    send: (payload, flags) => send(streamId, payload, flags),
    end: () => send(streamId, Buffer.alloc(0), FLAG_FIN),
    reset: (reason) => send(streamId, Buffer.from(reason, "utf8"), FLAG_RST),
  };
}
