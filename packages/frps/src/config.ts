import { readFileSync } from "node:fs";
import { DEFAULTS, type FrpsConfig, type Logger } from "@zfrp/shared";

export function loadConfig(path: string, log: Logger): FrpsConfig {
  const raw = JSON.parse(readFileSync(path, "utf8")) as FrpsConfig;
  if (!raw.dashboard?.user || !raw.dashboard?.password) throw new Error("配置缺少 dashboard.user/password");
  const cfg: FrpsConfig = {
    ...raw,
    bindAddr: raw.bindAddr ?? DEFAULTS.bindAddr,
    bindPort: raw.bindPort ?? DEFAULTS.bindPort,
    http: {
      bindAddr: raw.http?.bindAddr ?? DEFAULTS.httpBindAddr,
      port: raw.http?.port ?? DEFAULTS.httpPort,
    },
    tcp: {
      bindAddr: raw.tcp?.bindAddr ?? DEFAULTS.tcpBindAddr,
      enabled: raw.tcp?.enabled ?? true,
    },
    dashboard: {
      ...raw.dashboard,
      enabled: raw.dashboard.enabled ?? true,
      bindAddr: raw.dashboard.bindAddr ?? DEFAULTS.dashboardBindAddr,
      port: raw.dashboard.port ?? DEFAULTS.dashboardPort,
    },
    heartbeatIntervalMs: raw.heartbeatIntervalMs ?? DEFAULTS.heartbeatIntervalMs,
    heartbeatTimeoutMs: raw.heartbeatTimeoutMs ?? DEFAULTS.heartbeatTimeoutMs,
  };
  log.info("配置已加载", {
    path,
    tunnelsFile: cfg.tunnelsFile ?? "config/tunnels.json",
    bind: `${cfg.bindAddr}:${cfg.bindPort}`,
  });
  return cfg;
}
