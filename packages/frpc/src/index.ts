#!/usr/bin/env node
import { Logger } from "@zfrp/shared";
import { loadConfig } from "./config.js";
import { FrpcClient } from "./client.js";

const configPath = process.env["ZFRP_FRPC_CONFIG"] ?? "config/frpc.json";

try {
  const bootLog = new Logger("frpc", "info");
  const cfg = loadConfig(configPath, bootLog);
  const log = new Logger("frpc", cfg.logLevel ?? "info");
  const client = new FrpcClient(cfg, log);
  client.start();

  const shutdown = (sig: string): void => {
    log.info("收到退出信号", { signal: sig });
    client.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
} catch (err) {
  process.stderr.write(`frpc 启动失败: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exitCode = 1;
}
