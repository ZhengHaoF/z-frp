/**
 * 隧道协议：控制帧用 JSON 文本，数据帧用 binary。
 *
 * 二进制数据帧格式（8 字节头）：
 *   [0..3] streamId  uint32 BE
 *   [4]    flags     bit0=FIN 结束流, bit1=RST 异常复位
 *   [5..7] reserved  保留为 0
 *   [8..]  payload
 *
 * 控制帧（JSON text）：
 *   { v:1, type:"hello"|..., ... } —— 见下方类型定义
 */

import type { ProxySpec } from "./types.js";

export const PROTOCOL_VERSION = 1;
/** WebSocket 隧道路径，Caddy 需把此路径反向代理到 frps */
export const TUNNEL_PATH = "/_frp";
export const HEADER_SIZE = 8;
export const MAX_PAYLOAD = 64 * 1024;

export const FLAG_FIN = 0x01;
export const FLAG_RST = 0x02;

export interface DataFrame {
  streamId: number;
  flags: number;
  payload: Buffer;
}

/** 把一帧业务数据编码为 WebSocket binary message。 */
export function encodeDataFrame(streamId: number, payload: Buffer, flags = 0): Buffer {
  if (!Number.isInteger(streamId) || streamId < 1 || streamId > 0xffffffff) {
    throw new Error(`invalid streamId: ${streamId}`);
  }
  if (payload.length > MAX_PAYLOAD) {
    throw new Error(`payload too large: ${payload.length} > ${MAX_PAYLOAD}`);
  }
  const head = Buffer.alloc(HEADER_SIZE);
  head.writeUInt32BE(streamId, 0);
  head[4] = flags & 0xff;
  return Buffer.concat([head, payload]);
}

/** 解码 WebSocket binary message。畸形帧返回 null 而不是抛错。 */
export function decodeDataFrame(raw: Buffer): DataFrame | null {
  if (raw.length < HEADER_SIZE) return null;
  const streamId = raw.readUInt32BE(0);
  if (streamId < 1) return null;
  const flags = raw[4] ?? 0;
  const payload = Buffer.from(raw.subarray(HEADER_SIZE));
  if (payload.length > MAX_PAYLOAD) return null;
  return { streamId, flags, payload };
}

// ---------- 控制帧 ----------

export type ControlType =
  | "hello"
  | "hello-ok"
  | "hello-reject"
  | "config-pull"
  | "config-push"
  | "config-reject"
  | "register"
  | "register-ok"
  | "register-reject"
  | "stream-open"
  | "stream-head"
  | "stream-close"
  | "error"
  | "heartbeat"
  | "heartbeat-ack"
  | "stats";

export interface ControlEnvelope {
  v: number;
  type: ControlType;
  [key: string]: unknown;
}

export interface HelloFrame extends ControlEnvelope {
  type: "hello";
  /** 二期：key 凭证。clientId/token 为一期兼容字段，二期不再使用。 */
  key: string;
  clientId?: string;
  token?: string;
}

/** 客户端按 key 拉取服务端托管的隧道配置 */
export interface ConfigPullFrame extends ControlEnvelope {
  type: "config-pull";
  key: string;
  /** 客户端本地覆盖地址（可选）：HTTP 用 URL，TCP 用 host:port */
  local?: string;
}

/** 服务端下发的隧道配置：tunnel ID 稳定，proxies 已按 local 覆盖处理 */
export interface ConfigPushFrame extends ControlEnvelope {
  type: "config-push";
  tunnelId: string;
  clientId: string;
  proxies: ProxySpec[];
}

export interface ConfigRejectFrame extends ControlEnvelope {
  type: "config-reject";
  reason: string;
}
export interface HelloOkFrame extends ControlEnvelope {
  type: "hello-ok";
  clientId: string;
  heartbeatIntervalMs: number;
}
export interface HelloRejectFrame extends ControlEnvelope {
  type: "hello-reject";
  reason: string;
}
export interface RegisterFrame extends ControlEnvelope {
  type: "register";
  /** 客户端声明的代理列表。wss 加密传输，TCP authToken 需由 frps 校验访客握手。 */
  proxies: ProxySpec[];
}
export interface RegisterOkFrame extends ControlEnvelope {
  type: "register-ok";
  /** 被拒绝的代理及原因 */
  rejected: Array<{ name: string; reason: string }>;
}
export interface RegisterRejectFrame extends ControlEnvelope {
  type: "register-reject";
  reason: string;
}
export interface StreamOpenFrame extends ControlEnvelope {
  type: "stream-open";
  streamId: number;
  proxyName: string;
  /** HTTP 代理时携带请求元信息；TCP 代理时省略 */
  req?: {
    method: string;
    path: string;
    host: string;
    headers: Record<string, string>;
  };
}
export interface StreamHeadFrame extends ControlEnvelope {
  type: "stream-head";
  streamId: number;
  statusCode: number;
  headers: Record<string, string>;
}
export interface StreamCloseFrame extends ControlEnvelope {
  type: "stream-close";
  streamId: number;
}
export interface ErrorFrame extends ControlEnvelope {
  type: "error";
  streamId?: number;
  reason: string;
}
export interface HeartbeatFrame extends ControlEnvelope {
  type: "heartbeat";
  at: number;
}
export interface HeartbeatAckFrame extends ControlEnvelope {
  type: "heartbeat-ack";
  at: number;
}

export type ControlFrame =
  | HelloFrame
  | HelloOkFrame
  | HelloRejectFrame
  | ConfigPullFrame
  | ConfigPushFrame
  | ConfigRejectFrame
  | RegisterFrame
  | RegisterOkFrame
  | RegisterRejectFrame
  | StreamOpenFrame
  | StreamHeadFrame
  | StreamCloseFrame
  | ErrorFrame
  | HeartbeatFrame
  | HeartbeatAckFrame;

export function encodeControl(frame: Omit<ControlFrame, "v">): string {
  return JSON.stringify({ v: PROTOCOL_VERSION, ...frame });
}

/** 解析控制帧。版本不符或 JSON 畸形返回 null。 */
export function decodeControl(raw: string): ControlFrame | null {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null) return null;
  const frame = obj as Record<string, unknown>;
  if (frame["v"] !== PROTOCOL_VERSION) return null;
  if (typeof frame["type"] !== "string") return null;
  return frame as unknown as ControlFrame;
}

/** 生成流 ID：客户端从 1 起递增，绕开 0。 */
export function createStreamIdGenerator(): () => number {
  let n = 0;
  return () => {
    n += 1;
    if (n > 0xffffffff) n = 1;
    return n;
  };
}
