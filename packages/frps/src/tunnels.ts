/**
 * 隧道持久化与 CLI 管理。
 * 存储策略：CLI/网页原子写（临时文件 + rename），frps 按需读、不缓存。
 * tunnelId 是稳定身份，key 是凭证——两者分离，轮换 key 不影响统计与身份。
 *
 * createTunnel / rotateTunnel / deleteTunnel 是纯逻辑（不碰 stdout、不读文件），
 * CLI 与 dashboard 写接口共用，避免校验逻辑复制两份产生行为漂移。
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isValidHost } from "@zfrp/shared";
import type {
  CreateTunnelInput,
  CreateTunnelResult,
  ProxySpec,
  TunnelRecord,
  TunnelsFile,
} from "@zfrp/shared";

export const DEFAULT_TUNNELS_FILE = "config/tunnels.json";

export function tunnelsFilePath(): string {
  return process.env["ZFRP_TUNNELS_FILE"] ?? DEFAULT_TUNNELS_FILE;
}

export function loadTunnels(path: string): TunnelsFile {
  if (!existsSync(path)) return { version: 1, tunnels: [] };
  const raw = JSON.parse(readFileSync(path, "utf8")) as TunnelsFile;
  if (raw?.version !== 1 || !Array.isArray(raw.tunnels)) {
    throw new Error(`${path} 结构非法（需要 version:1 与 tunnels 数组）`);
  }
  return raw;
}

export function saveTunnels(path: string, data: TunnelsFile): void {
  const dir = dirname(path);
  if (dir && dir !== ".") mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${randomBytes(3).toString("hex")}`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

export function findByKey(file: TunnelsFile, key: string): TunnelRecord | undefined {
  return file.tunnels.find((t) => t.key === key);
}

export function findTunnel(file: TunnelsFile, idOrKey: string): TunnelRecord | undefined {
  return file.tunnels.find((t) => t.tunnelId === idOrKey || t.key === idOrKey);
}

export function newTunnelId(): string {
  return `t_${randomBytes(6).toString("hex")}`;
}

export function newKey(): string {
  return randomBytes(32).toString("hex");
}

export function newAuthToken(): string {
  return randomBytes(12).toString("hex");
}

/** 把客户端运行时传来的 -local 覆盖应用到配置。URL 只覆盖 HTTP，host:port 只覆盖 TCP。 */
export function applyLocalOverride(proxies: ProxySpec[], local?: string): ProxySpec[] {
  if (!local) return proxies;
  if (/^https?:\/\//i.test(local)) {
    return proxies.map((p) => (p.type === "http" ? { ...p, local } : p));
  }
  const m = /^([^:]+):(\d+)$/.exec(local);
  if (!m) return proxies;
  const [, host, portStr] = m;
  return proxies.map((p) =>
    p.type === "tcp" ? { ...p, localHost: host!, localPort: Number(portStr) } : p,
  );
}

// ---------------------------------------------------------------------------
// 纯逻辑：CLI 与 dashboard 写接口共用
// ---------------------------------------------------------------------------

function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function proxyConflict(file: TunnelsFile, proxy: ProxySpec): string | null {
  for (const t of file.tunnels) {
    for (const p of t.proxies) {
      if (p.type === "http" && proxy.type === "http" && p.host === proxy.host) {
        return `域名 ${proxy.host} 已被隧道 ${t.tunnelId} 占用`;
      }
      if (p.type === "tcp" && proxy.type === "tcp" && p.remotePort === proxy.remotePort) {
        return `端口 ${proxy.remotePort} 已被隧道 ${t.tunnelId} 占用`;
      }
    }
  }
  return null;
}

/** 校验输入并构造一条新隧道记录；不改 file，不写磁盘。 */
export function buildTunnelRecord(
  file: TunnelsFile,
  input: CreateTunnelInput,
): CreateTunnelResult {
  const note = typeof input.note === "string" ? input.note.trim().slice(0, 120) : "";
  let proxy: ProxySpec;

  if (input.type === "http") {
    const host = input.host?.trim().toLowerCase() ?? "";
    if (!isValidHost(host)) {
      return { ok: false, error: "请填写完整域名，如 a.b.com（字母、数字、连字符、点）" };
    }
    if (!input.local || !isHttpUrl(input.local)) {
      return { ok: false, error: "HTTP 隧道需要本地 URL，如 http://127.0.0.1:5173" };
    }
    proxy = { name: note || host, type: "http", host, local: input.local };
  } else if (input.type === "tcp") {
    const port = input.remotePort;
    if (!Number.isInteger(port) || port! < 1 || port! > 65535) {
      return { ok: false, error: "远程端口必须是 1-65535 的整数" };
    }
    const host = input.localHost?.trim() ?? "";
    if (!host || !Number.isInteger(input.localPort) || input.localPort! < 1 || input.localPort! > 65535) {
      return { ok: false, error: "本地地址需要合法的主机与端口（1-65535）" };
    }
    if (!input.authToken || input.authToken.length < 8) {
      return { ok: false, error: "访问密码（authToken）至少需要 8 位" };
    }
    proxy = {
      name: note || `tcp-${port}`,
      type: "tcp",
      remotePort: port!,
      localHost: host,
      localPort: input.localPort!,
      authToken: input.authToken,
    };
  } else {
    return { ok: false, error: "隧道类型只能是 tcp 或 http" };
  }

  const conflict = proxyConflict(file, proxy);
  if (conflict) return { ok: false, error: conflict };

  const tunnelId = newTunnelId();
  const key = newKey();
  const record: TunnelRecord = {
    tunnelId,
    key,
    clientId: tunnelId,
    proxies: [proxy],
    createdAt: Date.now(),
    note,
  };
  return { ok: true, record, key };
}

/** 创建并落盘。返回新 key（只在此刻给出完整值）。 */
export function createTunnel(path: string, input: CreateTunnelInput): CreateTunnelResult {
  const file = loadTunnels(path);
  const built = buildTunnelRecord(file, input);
  if (!built.ok) return built;
  file.tunnels.push(built.record);
  saveTunnels(path, file);
  return built;
}

export type MutateResult = { ok: true; record: TunnelRecord } | { ok: false; error: string };

/** 轮换 key。 */
export function rotateTunnel(path: string, idOrKey: string): MutateResult {
  const file = loadTunnels(path);
  const found = findTunnel(file, idOrKey);
  if (!found) return { ok: false, error: `找不到隧道 ${idOrKey}` };
  found.key = newKey();
  saveTunnels(path, file);
  return { ok: true, record: found };
}

/** 删除隧道，返回被删记录。 */
export function deleteTunnel(path: string, idOrKey: string): MutateResult {
  const file = loadTunnels(path);
  const found = findTunnel(file, idOrKey);
  if (!found) return { ok: false, error: `找不到隧道 ${idOrKey}` };
  file.tunnels = file.tunnels.filter((t) => t.tunnelId !== found.tunnelId);
  saveTunnels(path, file);
  return { ok: true, record: found };
}

export function describeProxy(p: ProxySpec): string {
  return p.type === "http" ? `${p.host} → ${p.local}` : `:${p.remotePort} → ${p.localHost}:${p.localPort}`;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

type Flags = Record<string, string | boolean>;

function parseFlags(args: string[]): Flags {
  const out: Flags = {};
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]!;
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq > 0) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
      continue;
    }
    const key = a.slice(2);
    const next = args[i + 1];
    if (next && !next.startsWith("--")) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = true;
    }
  }
  return out;
}

function flagPath(f: Flags): string {
  const v = f["tunnels-file"];
  return typeof v === "string" ? v : tunnelsFilePath();
}

function cmdCreate(rest: string[]): number {
  const f = parseFlags(rest);
  const host = typeof f.host === "string" ? f.host : undefined;
  const portRaw = typeof f["remote-port"] === "string" ? f["remote-port"] : undefined;
  const local = typeof f.local === "string" ? f.local : undefined;
  const authToken = typeof f["auth-token"] === "string" ? f["auth-token"] : undefined;
  const note = typeof f.note === "string" ? f.note : undefined;

  let input: CreateTunnelInput;
  if (host && !portRaw) {
    input = { type: "http", host, local, note };
  } else if (portRaw && !host) {
    const m = local ? /^([^:]+):(\d+)$/.exec(local) : null;
    input = {
      type: "tcp",
      remotePort: Number(portRaw),
      localHost: m?.[1],
      localPort: m ? Number(m[2]) : undefined,
      authToken,
      note,
    };
  } else {
    process.stderr.write("错误：必须且只能指定 --host 或 --remote-port 之一\n");
    return 1;
  }

  const result = createTunnel(flagPath(f), input);
  if (!result.ok) {
    process.stderr.write(`错误：${result.error}\n`);
    return 1;
  }
  process.stderr.write(
    `隧道已创建：${result.record.tunnelId}（${result.record.proxies.map(describeProxy).join(", ")}）\n`,
  );
  process.stderr.write("下面的 key 只会显示一次，请保存好：\n");
  process.stdout.write(`${result.key}\n`);
  return 0;
}

function cmdList(rest: string[]): number {
  const path = parseFlags(rest)["tunnels-file"];
  const file = loadTunnels(typeof path === "string" ? path : tunnelsFilePath());
  if (!file.tunnels.length) {
    process.stdout.write("暂无隧道。用 tunnel create 新建。\n");
    return 0;
  }
  for (const t of file.tunnels) {
    const desc = t.proxies.map(describeProxy).join(", ");
    const created = new Date(t.createdAt).toLocaleString("zh-CN");
    process.stdout.write(
      `${t.tunnelId}  key=${t.key.slice(0, 8)}…  ${desc}${t.note ? `  [${t.note}]` : ""}  建于 ${created}\n`,
    );
  }
  return 0;
}

function cmdTarget(rest: string[]): string | undefined {
  return rest.find((a) => !a.startsWith("--"));
}

function cmdDelete(rest: string[]): number {
  const target = cmdTarget(rest);
  if (!target) {
    process.stderr.write("用法：tunnel delete <tunnelId 或 key>\n");
    return 1;
  }
  const result = deleteTunnel(flagPath(parseFlags(rest)), target);
  if (!result.ok) {
    process.stderr.write(`错误：${result.error}\n`);
    return 1;
  }
  process.stdout.write(`已删除隧道 ${result.record.tunnelId}，旧 key 立即失效。\n`);
  return 0;
}

function cmdRotate(rest: string[]): number {
  const target = cmdTarget(rest);
  if (!target) {
    process.stderr.write("用法：tunnel rotate <tunnelId 或 key>\n");
    return 1;
  }
  const result = rotateTunnel(flagPath(parseFlags(rest)), target);
  if (!result.ok) {
    process.stderr.write(`错误：${result.error}\n`);
    return 1;
  }
  process.stdout.write(
    `隧道 ${result.record.tunnelId} 的 key 已轮换；新 key（只显示一次）：${result.record.key}\n`,
  );
  return 0;
}

/**
 * 若 argv 是 tunnel 子命令则执行并返回退出码；否则返回 null（表示应启动服务）。
 */
export function runTunnelCli(argv: string[]): number | null {
  if (argv[0] !== "tunnel") return null;
  const action = argv[1];
  const rest = argv.slice(2);
  switch (action) {
    case "create":
      return cmdCreate(rest);
    case "list":
      return cmdList(rest);
    case "delete":
      return cmdDelete(rest);
    case "rotate":
      return cmdRotate(rest);
    default:
      process.stderr.write(
        "zfrps tunnel <命令>\n\n" +
          "  create --host a.b.com --local http://127.0.0.1:5173 [--note web]\n" +
          "  create --remote-port 33061 --local 127.0.0.1:3306 --auth-token <至少8位> [--note mysql]\n" +
          "  list\n" +
          "  delete <tunnelId 或 key>\n" +
          "  rotate <tunnelId 或 key>\n\n" +
          "所有命令可选 --tunnels-file <路径>\n",
      );
      return action === undefined ? 0 : 1;
  }
}
