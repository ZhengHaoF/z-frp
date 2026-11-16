/** 两端共用的配置与代理描述类型。 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface HttpProxySpec {
  name: string;
  type: "http";
  /** 子域名，如 "demo" → demo.frp.example.com */
  subdomain: string;
  /** 本地服务地址，如 "http://127.0.0.1:5173" */
  local: string;
}

export interface TcpProxySpec {
  name: string;
  type: "tcp";
  /** frps 上监听的公网端口 */
  remotePort: number;
  /** 本地目标主机 */
  localHost: string;
  /** 本地目标端口 */
  localPort: number;
  /**
   * 访问者连 TCP 入口时必须提供的 token（AUTH 握手）。
   * 不填则该 TCP 代理不启用，避免裸奔。
   */
  authToken: string;
}

export type ProxySpec = HttpProxySpec | TcpProxySpec;

/**
 * 隧道在运行时的可变部分：客户端每次启动都能用 -local 覆盖本地地址。
 * tunnelId 稳定，key 可轮换——两者分离，轮换不影响身份与统计。
 */
export interface ClientConfig {
  tunnelId: string;
  clientId: string;
  proxies: ProxySpec[];
}

/** 隧道持久化记录：存于服务端 tunnels.json */
export interface TunnelRecord {
  tunnelId: string;
  key: string;
  createdAt: number;
  /** 客户端连接时注册用的身份；默认等于 tunnelId */
  clientId: string;
  proxies: ProxySpec[];
  /** 备注名，便于在 dashboard 识别；旧记录缺此字段时视为空 */
  note?: string;
}

/** 新建隧道的表单输入（网页与 CLI 共用） */
export interface CreateTunnelInput {
  note?: string;
  type: "tcp" | "http";
  /** HTTP：子域名 */
  subdomain?: string;
  /** HTTP：本地 URL */
  local?: string;
  /** TCP：远程端口 */
  remotePort?: number;
  /** TCP：本地主机 */
  localHost?: string;
  /** TCP：本地端口 */
  localPort?: number;
  /** TCP：访问者 AUTH 口令 */
  authToken?: string;
}

export type CreateTunnelResult =
  | { ok: true; record: TunnelRecord; key: string }
  | { ok: false; error: string };

/** tunnels.json 文件结构 */
export interface TunnelsFile {
  version: 1;
  tunnels: TunnelRecord[];
}

export interface FrpcConfig {
  /** ws(s) 服务端地址，如 "wss://frp.example.com/_tunnel" */
  server: string;
  /** 客户端标识，需与 frps clients 中的 key 一致 */
  clientId: string;
  token: string;
  /** 心跳间隔（毫秒），默认 30000 */
  heartbeatIntervalMs?: number;
  /** 断线重连基础退避（毫秒），默认 1000，指数增长到 30s */
  reconnectBaseMs?: number;
  logLevel?: LogLevel;
  proxies: ProxySpec[];
}

export interface FrpsTlsConfig {
  cert: string;
  key: string;
}

export interface FrpsConfig {
  /** frps WebSocket 监听地址，默认 "0.0.0.0" */
  bindAddr?: string;
  /** frps WebSocket 监听端口，默认 7000 */
  bindPort?: number;
  /**
   * 直接暴露 wss 时填写证书；放在 Caddy 后面时用 ws + 回环监听，留空。
   */
  tls?: FrpsTlsConfig;
  /** 泛域名后缀，如 "frp.example.com" */
  domain: string;
  /** clientId → token（一期字段，二期已由 tunnels.json 取代，保留仅为兼容旧配置） */
  clients?: Record<string, string>;
  /** 隧道持久化文件路径，默认 config/tunnels.json */
  tunnelsFile?: string;
  http: {
    /** HTTP 入口监听地址，默认 "127.0.0.1"（由 Caddy 转发） */
    bindAddr?: string;
    /** HTTP 入口端口，默认 8080 */
    port?: number;
  };
  tcp: {
    /** TCP 入口监听地址，默认 "0.0.0.0" */
    bindAddr?: string;
    /** 是否启用 TCP 入口，默认 true */
    enabled?: boolean;
  };
  dashboard: {
    enabled?: boolean;
    bindAddr?: string;
    port?: number;
    user: string;
    password: string;
  };
  /** 心跳间隔，默认 30000 */
  heartbeatIntervalMs?: number;
  /** 多久没收到心跳判定死亡，默认 90000 */
  heartbeatTimeoutMs?: number;
  logLevel?: LogLevel;
}

export const DEFAULTS = {
  bindAddr: "0.0.0.0",
  bindPort: 7000,
  httpBindAddr: "127.0.0.1",
  httpPort: 8080,
  tcpBindAddr: "0.0.0.0",
  heartbeatIntervalMs: 30_000,
  heartbeatTimeoutMs: 90_000,
  reconnectBaseMs: 1_000,
  dashboardBindAddr: "127.0.0.1",
  dashboardPort: 7500,
} as const;
