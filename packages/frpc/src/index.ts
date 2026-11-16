#!/usr/bin/env node
import { Logger } from "@zfrp/shared";
import { parseArgs } from "./config.js";
import { FrpcClient } from "./client.js";

try {
  const log = new Logger("frpc", "info");
  const opts = parseArgs(process.argv.slice(2), log);
  const client = new FrpcClient(opts, log);
  client.start();

  const shutdown = (sig: string): void => {
    log.info("收到退出信号", { signal: sig });
    client.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
} catch (err) {
  process.stderr.write(`frpc 启动失败: ${err instanceof Error ? err.message : String(err)}\n`);
  process.stderr.write("用法：run.js -key <key> [-server <wss://...>] [-local <addr>]\n");
  process.exitCode = 1;
}
