import type { Logger } from "@zfrp/shared";

export interface ClientOptions {
  key: string;
  server: string;
  /** 本地覆盖地址：HTTP 用 URL，TCP 用 host:port；不填则用服务端登记值 */
  local?: string;
}

const DEFAULT_SERVER = "ws://127.0.0.1:7000/_frp";

/** 解析命令行：run.js -key <key> [-server <wss://...>] [-local <addr>] */
export function parseArgs(argv: string[], log: Logger): ClientOptions {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    if (i < 0) return undefined;
    const v = argv[i + 1];
    if (!v || v.startsWith("-")) throw new Error(`${flag} 缺少参数值`);
    return v;
  };

  const key = get("-key") ?? get("--key");
  if (!key) throw new Error("缺少 -key <key> 参数。用法：run.js -key <key> [-server <url>] [-local <addr>]");

  const opts: ClientOptions = {
    key,
    server: get("-server") ?? get("--server") ?? DEFAULT_SERVER,
  };
  const local = get("-local") ?? get("--local");
  if (local) opts.local = local;

  log.info("启动参数已解析", {
    server: opts.server,
    key: `${key.slice(0, 8)}…`,
    localOverride: opts.local ?? "用服务端登记值",
  });
  return opts;
}
