/**
 * 隧道持久化与 CLI 管理。
 * 存储策略：CLI 原子写（临时文件 + rename），frps 按需读、不缓存。
 * tunnelId 是稳定身份，key 是凭证——两者分离，轮换 key 不影响统计与身份。
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ProxySpec, TunnelRecord, TunnelsFile } from "@zfrp/shared";

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
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
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

function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function describe(p: ProxySpec): string {
  return p.type === "http" ? `${p.subdomain} → ${p.local}` : `:${p.remotePort} → ${p.localHost}:${p.localPort}`;
}

function proxyConflict(file: TunnelsFile, proxy: ProxySpec): string | null {
  for (const t of file.tunnels) {
    for (const p of t.proxies) {
      if (p.type === "http" && proxy.type === "http" && p.subdomain === proxy.subdomain) {
        return `子域名 ${proxy.subdomain} 已被隧道 ${t.tunnelId} 占用`;
      }
      if (p.type === "tcp" && proxy.type === "tcp" && p.remotePort === proxy.remotePort) {
        return `端口 ${proxy.remotePort} 已被隧道 ${t.tunnelId} 占用`;
      }
    }
  }
  return null;
}

function cmdCreate(rest: string[]): number {
  const f = parseFlags(rest);
  const path = flagPath(f);
  const sub = typeof f.subdomain === "string" ? f.subdomain : undefined;
  const portRaw = typeof f["remote-port"] === "string" ? f["remote-port"] : undefined;
  const local = typeof f.local === "string" ? f.local : undefined;
  const authToken = typeof f["auth-token"] === "string" ? f["auth-token"] : undefined;
  const name = typeof f.name === "string" ? f.name : undefined;

  let proxy: ProxySpec;
  if (sub && !portRaw) {
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(sub)) {
      process.stderr.write("错误：--subdomain 只允许小写字母、数字、连字符\n");
      return 1;
    }
    if (!local || !isHttpUrl(local)) {
      process.stderr.write("错误：HTTP 隧道需要 --local http://127.0.0.1:端口\n");
      return 1;
    }
    proxy = { name: name ?? sub, type: "http", subdomain: sub, local };
  } else if (portRaw && !sub) {
    const port = Number(portRaw);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      process.stderr.write("错误：--remote-port 必须是 1-65535 的整数\n");
      return 1;
    }
    const m = local ? /^([^:]+):(\d+)$/.exec(local) : null;
    if (!m) {
      process.stderr.write("错误：TCP 隧道需要 --local 127.0.0.1:端口\n");
      return 1;
    }
    if (!authToken || authToken.length < 8) {
      process.stderr.write("错误：TCP 隧道需要至少 8 位的 --auth-token\n");
      return 1;
    }
    proxy = {
      name: name ?? `tcp-${port}`,
      type: "tcp",
      remotePort: port,
      localHost: m[1]!,
      localPort: Number(m[2]),
      authToken,
    };
  } else {
    process.stderr.write("错误：必须且只能指定 --subdomain 或 --remote-port 之一\n");
    return 1;
  }

  const data = loadTunnels(path);
  const conflict = proxyConflict(data, proxy);
  if (conflict) {
    process.stderr.write(`错误：${conflict}\n`);
    return 1;
  }

  const tunnelId = newTunnelId();
  const key = newKey();
  data.tunnels.push({ tunnelId, key, clientId: tunnelId, proxies: [proxy], createdAt: Date.now() });
  saveTunnels(path, data);
  process.stderr.write(`隧道已创建：${tunnelId}（${describe(proxy)}）\n`);
  process.stderr.write("下面的 key 只会显示一次，请保存好：\n");
  process.stdout.write(`${key}\n`);
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
    const desc = t.proxies.map(describe).join(", ");
    const created = new Date(t.createdAt).toLocaleString("zh-CN");
    process.stdout.write(`${t.tunnelId}  key=${t.key.slice(0, 8)}…  ${desc}  建于 ${created}\n`);
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
  const path = flagPath(parseFlags(rest));
  const file = loadTunnels(path);
  const found = findTunnel(file, target);
  if (!found) {
    process.stderr.write(`错误：找不到隧道 ${target}\n`);
    return 1;
  }
  file.tunnels = file.tunnels.filter((t) => t.tunnelId !== found.tunnelId);
  saveTunnels(path, file);
  process.stdout.write(`已删除隧道 ${found.tunnelId}，旧 key 立即失效。\n`);
  return 0;
}

function cmdRotate(rest: string[]): number {
  const target = cmdTarget(rest);
  if (!target) {
    process.stderr.write("用法：tunnel rotate <tunnelId 或 key>\n");
    return 1;
  }
  const path = flagPath(parseFlags(rest));
  const file = loadTunnels(path);
  const found = findTunnel(file, target);
  if (!found) {
    process.stderr.write(`错误：找不到隧道 ${target}\n`);
    return 1;
  }
  const oldKey = found.key;
  found.key = newKey();
  saveTunnels(path, file);
  process.stdout.write(`隧道 ${found.tunnelId} 的 key 已轮换；旧 key ${oldKey.slice(0, 8)}… 立即失效。\n`);
  process.stdout.write(`新 key：${found.key}\n`);
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
          "  create --subdomain demo --local http://127.0.0.1:5173 [--name web]\n" +
          "  create --remote-port 33061 --local 127.0.0.1:3306 --auth-token <至少8位>\n" +
          "  list\n" +
          "  delete <tunnelId 或 key>\n" +
          "  rotate <tunnelId 或 key>\n\n" +
          "所有命令可选 --tunnels-file <路径>\n",
      );
      return action === undefined ? 0 : 1;
  }
}
