#!/usr/bin/env node
import { createServer } from "node:https";
import { createServer as createHttpServer } from "node:http";
import { readFileSync } from "node:fs";
import { Logger, TUNNEL_PATH } from "@zfrp/shared";
import { loadConfig } from "./config.js";
import { Registry } from "./registry.js";
import { TunnelHub } from "./tunnel.js";
import { startHttpEntry } from "./http-entry.js";
import { TcpEntryManager } from "./tcp-entry.js";
import { startDashboard } from "./dashboard.js";
import { runTunnelCli, tunnelsFilePath } from "./tunnels.js";

// CLI 子命令（tunnel create/list/delete/rotate）优先处理，不启动服务
const cliExit = runTunnelCli(process.argv.slice(2));
if (cliExit !== null) {
  process.exitCode = cliExit;
} else {
  const configPath = process.env["ZFRP_FRPS_CONFIG"] ?? "config/frps.json";

  try {
    const bootLog = new Logger("frps", "info");
    const cfg = loadConfig(configPath, bootLog);
    const log = new Logger("frps", cfg.logLevel ?? "info");
    const registry = new Registry();
    const hub = new TunnelHub(
      {
        tunnelsFile: cfg.tunnelsFile ?? tunnelsFilePath(),
        heartbeatIntervalMs: cfg.heartbeatIntervalMs!,
        heartbeatTimeoutMs: cfg.heartbeatTimeoutMs!,
        log,
      },
      registry,
    );

    // wss：有证书就直接 HTTPS server；否则 HTTP server 给 Caddy 反代
    const wsServer = cfg.tls
      ? createServer(
          { cert: readFileSync(cfg.tls.cert), key: readFileSync(cfg.tls.key) },
          (_req, res) => {
            res.writeHead(404).end();
          },
        )
      : createHttpServer((_req, res) => {
          res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
          res.end("z-frp frps ok\n");
        });
    hub.attach(wsServer, TUNNEL_PATH);
    wsServer.listen(cfg.bindPort, cfg.bindAddr, () => {
      log.info("frps 控制面板/WS 已监听", {
        addr: `${cfg.bindAddr}:${cfg.bindPort}`,
        tls: Boolean(cfg.tls),
        tunnelPath: TUNNEL_PATH,
      });
    });

    startHttpEntry(hub, {
      bindAddr: cfg.http!.bindAddr!,
      port: cfg.http!.port!,
      log,
    });

    const tcpManager = new TcpEntryManager(hub, { bindAddr: cfg.tcp!.bindAddr!, log });
    if (cfg.tcp!.enabled) {
      tcpManager.sync();
      // 注册状态变化时同步 TCP 监听端口
      const origRegister = registry.register.bind(registry);
      registry.register = (...args: Parameters<typeof registry.register>) => {
        const result = origRegister(...args);
        setImmediate(() => tcpManager.sync());
        return result;
      };
      const origDisconnect = registry.disconnect.bind(registry);
      registry.disconnect = (...args: Parameters<typeof registry.disconnect>) => {
        const result = origDisconnect(...args);
        setImmediate(() => tcpManager.sync());
        return result;
      };
    }

    if (cfg.dashboard!.enabled) {
      startDashboard(registry, {
        bindAddr: cfg.dashboard!.bindAddr!,
        port: cfg.dashboard!.port!,
        user: cfg.dashboard!.user,
        password: cfg.dashboard!.password,
        tunnelsFile: cfg.tunnelsFile ?? tunnelsFilePath(),
        log,
      });
    }
  } catch (err) {
    process.stderr.write(`frps 启动失败: ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exitCode = 1;
  }
}
