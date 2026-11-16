/** 只读 dashboard：basic auth + 状态页 + JSON API。不提供任何写操作。 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Logger } from "@zfrp/shared";
import type { Registry } from "./registry.js";
import { loadTunnels } from "./tunnels.js";

export interface DashboardOptions {
  bindAddr: string;
  port: number;
  user: string;
  password: string;
  tunnelsFile: string;
  log: Logger;
}

function tunnelList(
  tunnelsFile: string,
  onlineClientIds: Set<string>,
): Array<{ id: string; proxy: string; online: boolean; keyPrefix: string }> {
  try {
    const file = loadTunnels(tunnelsFile);
    return file.tunnels.map((t) => {
      const proxy = t.proxies
        .map((p) => (p.type === "http" ? `${p.subdomain} → ${p.local}` : `:${p.remotePort} → ${p.localHost}:${p.localPort}`))
        .join(", ");
      return {
        id: t.tunnelId,
        proxy,
        online: onlineClientIds.has(t.clientId),
        keyPrefix: `${t.key.slice(0, 8)}…`,
      };
    });
  } catch {
    return [];
  }
}

function parseBasicAuth(header: string | undefined): { user: string; pass: string } | null {
  if (!header?.startsWith("Basic ")) return null;
  try {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const idx = decoded.indexOf(":");
    if (idx < 0) return null;
    return { user: decoded.slice(0, idx), pass: decoded.slice(idx + 1) };
  } catch {
    return null;
  }
}

function esc(s: unknown): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function startDashboard(registry: Registry, opts: DashboardOptions): Server {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const auth = parseBasicAuth(req.headers.authorization);
    if (!auth || auth.user !== opts.user || auth.pass !== opts.password) {
      res.writeHead(401, {
        "www-authenticate": 'Basic realm="z-frp dashboard", charset="UTF-8"',
        "content-type": "text/plain; charset=utf-8",
      });
      res.end("Unauthorized");
      return;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    const snapBase = registry.snapshot() as {
      clients: Array<{ clientId: string; online: boolean }>;
    };
    const onlineIds = new Set(snapBase.clients.filter((c) => c.online).map((c) => c.clientId));
    const tunnels = tunnelList(opts.tunnelsFile, onlineIds);
    if (url.pathname === "/api/state") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ...registry.snapshot(), tunnels }, null, 2));
      return;
    }
    const snap = registry.snapshot() as {
      clients: Array<{
        clientId: string;
        online: boolean;
        lastSeen: number;
        proxies: Array<Record<string, unknown>>;
        activeStreams: number;
      }>;
      httpHosts: string[];
      tcpPorts: number[];
      totals: { clients: number; online: number; activeStreams: number };
    };
    const rows = snap.clients
      .map(
        (c) => `<tr>
          <td>${esc(c.clientId)}</td>
          <td>${c.online ? '<span class="on">在线</span>' : '<span class="off">离线</span>'}</td>
          <td>${c.proxies.map((p) => esc(p.type === "http" ? `${p.subdomain}.` : `:${p.remotePort}`)).join("<br>") || "—"}</td>
          <td>${c.activeStreams}</td>
          <td>${new Date(c.lastSeen).toLocaleString("zh-CN")}</td>
        </tr>`,
      )
      .join("");
    const tunnelRows = tunnels
      .map(
        (t) => `<tr>
          <td>${esc(t.id)}</td>
          <td>${esc(t.keyPrefix)}</td>
          <td>${t.online ? '<span class="on">在线</span>' : '<span class="off">离线</span>'}</td>
          <td>${esc(t.proxy)}</td>
        </tr>`,
      )
      .join("");
    const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>z-frp dashboard</title>
<meta http-equiv="refresh" content="10">
<style>
body{font:14px/1.6 system-ui,sans-serif;margin:2rem;color:#2c2c2a;background:#faf9f6}
h1{font-size:20px;font-weight:500} h2{font-size:16px;font-weight:500;margin-top:2rem}
table{border-collapse:collapse;width:100%;background:#fff}
th,td{border:1px solid #ddd;padding:8px 10px;text-align:left} th{background:#f1efe8;font-weight:500}
.on{color:#3b6d11}.off{color:#993c1d} .meta{color:#5f5e5a;margin-bottom:1rem}
</style></head><body>
<h1>z-frp 运行状态</h1>
<p class="meta">客户端 ${snap.totals.clients} · 在线 ${snap.totals.online} · 活跃流 ${snap.totals.activeStreams} · 每 10 秒刷新</p>
<table><thead><tr><th>客户端</th><th>状态</th><th>代理</th><th>活跃流</th><th>最后心跳</th></tr></thead>
<tbody>${rows || '<tr><td colspan="5">暂无客户端</td></tr>'}</tbody></table>
<p class="meta">HTTP 域名: ${snap.httpHosts.map(esc).join(", ") || "—"} · TCP 端口: ${snap.tcpPorts.join(", ") || "—"}</p>

<h2>隧道清单（只读）</h2>
<p class="meta">共 ${tunnels.length} 条。新建/轮换请在服务端用 CLI；key 只显示前缀。</p>
<table><thead><tr><th>隧道 ID</th><th>key</th><th>状态</th><th>代理映射</th></tr></thead>
<tbody>${tunnelRows || '<tr><td colspan="4">暂无隧道</td></tr>'}</tbody></table>
</body></html>`;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  });

  server.listen(opts.port, opts.bindAddr, () => {
    opts.log.info("dashboard 已监听", { addr: `${opts.bindAddr}:${opts.port}` });
  });
  return server;
}
