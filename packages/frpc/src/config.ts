import { readFileSync } from "node:fs";
import { DEFAULTS, type FrpcConfig, type Logger } from "@zfrp/shared";

export function loadConfig(path: string, log: Logger): FrpcConfig {
  const raw = JSON.parse(readFileSync(path, "utf8")) as FrpcConfig;
  if (!raw.server) throw new Error("配置缺少 server");
  if (!raw.clientId) throw new Error("配置缺少 clientId");
  if (!raw.token) throw new Error("配置缺少 token");
  if (!Array.isArray(raw.proxies)) throw new Error("配置缺少 proxies 数组");
  for (const p of raw.proxies) {
    if (p.type === "http" && !p.local) throw new Error(`HTTP 代理 ${p.name} 缺少 local`);
    if (p.type === "tcp" && (!p.localHost || !p.localPort)) {
      throw new Error(`TCP 代理 ${p.name} 缺少 localHost/localPort`);
    }
  }
  const cfg: FrpcConfig = {
    ...raw,
    heartbeatIntervalMs: raw.heartbeatIntervalMs ?? DEFAULTS.heartbeatIntervalMs,
    reconnectBaseMs: raw.reconnectBaseMs ?? DEFAULTS.reconnectBaseMs,
  };
  log.info("配置已加载", {
    path,
    server: cfg.server,
    clientId: cfg.clientId,
    proxies: cfg.proxies.map((p) => p.name),
  });
  return cfg;
}
