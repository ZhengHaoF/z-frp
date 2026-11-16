/**
 * dashboard：basic auth + 状态页 + 隧道管理（建/轮换/删）。
 * 隧道写操作复用 tunnels.ts 的纯函数，与 CLI 共用同一份 tunnels.json。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { CreateTunnelInput, Logger } from "@zfrp/shared";
import type { Registry } from "./registry.js";
import {
  createTunnel,
  deleteTunnel,
  loadTunnels,
  rotateTunnel,
} from "./tunnels.js";

export interface DashboardOptions {
  bindAddr: string;
  port: number;
  user: string;
  password: string;
  tunnelsFile: string;
  log: Logger;
}

interface TunnelRow {
  id: string;
  note: string;
  proxy: string;
  online: boolean;
  keyPrefix: string;
}

function tunnelList(tunnelsFile: string, onlineClientIds: Set<string>): TunnelRow[] {
  try {
    const file = loadTunnels(tunnelsFile);
    return file.tunnels.map((t) => ({
      id: t.tunnelId,
      note: t.note ?? "",
      proxy: t.proxies
        .map((p) => (p.type === "http" ? `${p.subdomain} → ${p.local}` : `:${p.remotePort} → ${p.localHost}:${p.localPort}`))
        .join(", "),
      online: onlineClientIds.has(t.clientId),
      keyPrefix: `${t.key.slice(0, 8)}…`,
    }));
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

interface Snapshot {
  clients: Array<{ clientId: string; online: boolean; lastSeen: number; proxies: Array<Record<string, unknown>>; activeStreams: number }>;
  httpHosts: string[];
  tcpPorts: number[];
  totals: { clients: number; online: number; activeStreams: number };
}

function snapshot(registry: Registry): Snapshot {
  return registry.snapshot() as unknown as Snapshot;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 64 * 1024) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? (JSON.parse(raw) as Record<string, unknown>) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function toCreateInput(body: Record<string, unknown>): CreateTunnelInput {
  const str = (k: string) => (typeof body[k] === "string" ? (body[k] as string) : undefined);
  const num = (k: string) => {
    const v = body[k];
    if (typeof v === "number") return v;
    if (typeof v === "string" && v.trim() !== "") return Number(v);
    return undefined;
  };
  return {
    type: str("type") === "http" ? "http" : "tcp",
    note: str("note"),
    subdomain: str("subdomain"),
    local: str("local"),
    remotePort: num("remotePort"),
    localHost: str("localHost"),
    localPort: num("localPort"),
    authToken: str("authToken"),
  };
}

const PAGE = String.raw`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>z-frp dashboard</title>
<style>
body{font:14px/1.6 system-ui,sans-serif;margin:0;color:#2c2c2a;background:#faf9f6}
.wrap{max-width:1100px;margin:0 auto;padding:28px 24px 60px}
.topbar{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:18px}
h1{font-size:20px;font-weight:500;margin:0}h2{font-size:16px;font-weight:500;margin:1.5rem 0 .5rem}
table{border-collapse:collapse;width:100%;background:#fff}
th,td{border:1px solid #ddd;padding:8px 10px;text-align:left;vertical-align:top}
th{background:#f1efe8;font-weight:500}
.on{color:#3b6d11}.off{color:#993c1d}.meta{color:#5f5e5a;margin:.25rem 0 1rem}
label{display:flex;flex-direction:column;gap:4px;font-size:13px}
input,select,button{font:inherit;padding:6px 8px}
.row{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px}
.hint{font-size:12px;color:#888;margin:.25rem 0 .5rem}
.actions{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}
button{cursor:pointer}button.primary{background:#1d6f42;color:#fff;border:1px solid #1d6f42;border-radius:5px}
button.ghost{background:#fff;border:1px solid #ccc;border-radius:5px}
button.danger{color:#993c1d}button.link{background:none;border:none;color:#185fa5;padding:0;text-decoration:underline}
.modal-backdrop{position:fixed;inset:0;background:rgba(20,20,18,.45);display:flex;align-items:center;justify-content:center;padding:20px;z-index:20}
.modal-backdrop[hidden]{display:none}
.modal{background:#fff;border-radius:10px;width:min(560px,100%);max-height:90vh;overflow:auto;box-shadow:0 16px 40px rgba(0,0,0,.22)}
.modal-head{display:flex;align-items:center;justify-content:space-between;padding:14px 20px;border-bottom:1px solid #eee}
.modal-head h2{margin:0}
.modal-body{padding:18px 20px}
.modal-foot{display:flex;justify-content:flex-end;gap:8px;padding:12px 20px;border-top:1px solid #eee}
.icon-btn{border:none;background:none;font-size:22px;line-height:1;color:#777;padding:0 4px}
.keybox{background:#f1efe8;border-radius:6px;padding:10px 12px;margin-top:10px}
code{font-family:ui-monospace,monospace;word-break:break-all}
</style></head><body>
<div class="wrap">
  <div class="topbar">
    <div>
      <h1>z-frp 运行状态</h1>
      <p class="meta" id="meta">加载中…</p>
    </div>
    <button type="button" id="open-create" class="primary">+ 新建隧道</button>
  </div>
  <div id="live"></div>
</div>

<div class="modal-backdrop" id="create-modal" hidden>
  <div class="modal" role="dialog" aria-modal="true" aria-labelledby="create-title">
    <div class="modal-head"><h2 id="create-title">新建隧道</h2><button type="button" class="icon-btn" data-close="create-modal" aria-label="关闭">×</button></div>
    <form id="create-form">
      <div class="modal-body">
        <div class="row">
          <label>备注名<input name="note" placeholder="例如：开发机 MySQL" maxlength="120"></label>
          <label>隧道类型<select name="type" id="type">
            <option value="tcp">TCP 端口映射</option>
            <option value="http">HTTP 子域名</option>
          </select></label>
        </div>
        <p class="hint">UDP / HTTPS（独立类型）/ WOL：当前版本不支持。HTTPS 由前置 Caddy 统一处理，HTTP 隧道天然支持。</p>

        <div id="tcp-fields">
          <div class="row">
            <label>本地 IP<input name="localHost" value="127.0.0.1"></label>
            <label>本地端口<input name="localPort" type="number" min="1" max="65535" value="3306"></label>
          </div>
          <div class="row">
            <label>远程端口<input name="remotePort" type="number" min="1" max="65535" value="33061" placeholder="如 33061"></label>
            <label>访问密码（authToken）<span style="display:flex;gap:8px">
              <input name="authToken" id="authToken" placeholder="至少 8 位">
              <button type="button" id="gen-token">生成</button>
            </span></label>
          </div>
          <p class="hint">访客须先 AUTH 握手；远程端口需在 VPS 安全组放行。</p>
        </div>

        <div id="http-fields" style="display:none">
          <div class="row">
            <label>子域名<input name="subdomain" placeholder="如 demo → demo.frp.example.com"></label>
            <label>本地 URL<input name="local" placeholder="http://127.0.0.1:5173"></label>
          </div>
          <p class="hint">需泛域名 *.frp.example.com 已解析到 VPS。</p>
        </div>
      </div>
      <div class="modal-foot">
        <button type="button" class="ghost" data-close="create-modal">取消</button>
        <button type="submit" class="primary">创建隧道</button>
      </div>
    </form>
  </div>
</div>

<div class="modal-backdrop" id="key-modal" hidden>
  <div class="modal" role="dialog" aria-modal="true" aria-labelledby="key-title">
    <div class="modal-head"><h2 id="key-title">隧道已创建</h2><button type="button" class="icon-btn" data-close="key-modal" aria-label="关闭">×</button></div>
    <div class="modal-body">
      <div style="margin-bottom:8px">隧道 ID：<code id="new-id"></code></div>
      <div>下面的 key 只显示这一次，请立即复制：</div>
      <div class="keybox"><code id="new-key"></code></div>
    </div>
    <div class="modal-foot">
      <button type="button" class="ghost" data-close="key-modal">关闭</button>
      <button type="button" class="primary" id="copy-key">复制 key</button>
    </div>
  </div>
</div>

<script>
(function(){
  var typeSel = document.getElementById('type');
  var tcpFields = document.getElementById('tcp-fields');
  var httpFields = document.getElementById('http-fields');
  function toggleFields(){
    var isTcp = typeSel.value === 'tcp';
    tcpFields.style.display = isTcp ? '' : 'none';
    httpFields.style.display = isTcp ? 'none' : '';
  }
  typeSel.addEventListener('change', toggleFields);

  function openModal(id){ document.getElementById(id).hidden = false; }
  function closeModal(id){ document.getElementById(id).hidden = true; }
  function showKey(id, key, title){
    document.getElementById('key-title').textContent = title;
    document.getElementById('new-id').textContent = id;
    document.getElementById('new-key').textContent = key;
    document.getElementById('copy-key').textContent = '复制 key';
    openModal('key-modal');
  }
  document.getElementById('open-create').addEventListener('click', function(){ openModal('create-modal'); });
  document.addEventListener('click', function(e){
    if(!e.target || !e.target.closest) return;
    var closer = e.target.closest('[data-close]');
    if(closer){ closeModal(closer.getAttribute('data-close')); return; }
    if(e.target.classList && e.target.classList.contains('modal-backdrop')) closeModal(e.target.id);
  });
  document.addEventListener('keydown', function(e){
    if(e.key === 'Escape'){ closeModal('create-modal'); closeModal('key-modal'); }
  });

  document.getElementById('gen-token').addEventListener('click', function(){
    var bytes = new Uint8Array(12);
    crypto.getRandomValues(bytes);
    document.getElementById('authToken').value = Array.prototype.map.call(bytes, function(b){
      return ('0'+b.toString(16)).slice(-2);
    }).join('');
  });

  var esc = function(s){ return String(s).replace(/[&<>"']/g, function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
  }); };

  function renderLive(data){
    var meta = data.totals || {};
    document.getElementById('meta').textContent =
      '客户端 ' + meta.clients + ' · 在线 ' + meta.online + ' · 活跃流 ' + meta.activeStreams +
      ' · HTTP 域名: ' + ((data.httpHosts||[]).join(', ') || '—') +
      ' · TCP 端口: ' + ((data.tcpPorts||[]).join(', ') || '—') + ' · 每 10 秒刷新';

    var clientRows = (data.clients||[]).map(function(c){
      var proxies = (c.proxies||[]).map(function(p){
        return p.type === 'http' ? esc(p.subdomain)+'.' : ':'+esc(p.remotePort);
      }).join('<br>') || '—';
      return '<tr><td>'+esc(c.clientId)+'</td><td>'+(c.online?'<span class="on">在线</span>':'<span class="off">离线</span>')+
        '</td><td>'+proxies+'</td><td>'+c.activeStreams+'</td><td>'+new Date(c.lastSeen).toLocaleString('zh-CN')+'</td></tr>';
    }).join('');

    var tunnelRows = (data.tunnels||[]).map(function(t){
      return '<tr><td>'+esc(t.id)+'</td><td>'+esc(t.note||'—')+'</td><td>'+esc(t.keyPrefix)+'</td><td>'+
        (t.online?'<span class="on">在线</span>':'<span class="off">离线</span>')+'</td><td>'+esc(t.proxy)+
        '</td><td><button class="link" data-act="rotate" data-id="'+esc(t.id)+'">轮换 key</button> '+
        '<button class="link danger" data-act="delete" data-id="'+esc(t.id)+'">删除</button></td></tr>';
    }).join('');

    document.getElementById('live').innerHTML =
      '<h2>客户端</h2><table><thead><tr><th>客户端</th><th>状态</th><th>代理</th><th>活跃流</th><th>最后心跳</th></tr></thead><tbody>'+
      (clientRows || '<tr><td colspan="5">暂无客户端</td></tr>')+'</tbody></table>'+
      '<h2>隧道清单</h2><table><thead><tr><th>隧道 ID</th><th>备注</th><th>key</th><th>状态</th><th>映射</th><th>操作</th></tr></thead><tbody>'+
      (tunnelRows || '<tr><td colspan="6">暂无隧道</td></tr>')+'</tbody></table>';
  }

  function refresh(){
    fetch('/api/state').then(function(r){return r.json();}).then(renderLive).catch(function(){});
  }

  document.getElementById('live').addEventListener('click', function(e){
    var btn = e.target.closest('button[data-act]');
    if(!btn) return;
    var id = btn.getAttribute('data-id');
    var act = btn.getAttribute('data-act');
    if(act === 'delete'){
      if(!confirm('确定删除隧道 '+id+'？此操作不可撤销，旧 key 立即失效。')) return;
      fetch('/api/tunnels/'+encodeURIComponent(id), {method:'DELETE'})
        .then(function(r){return r.json();}).then(function(res){
          if(!res.ok) alert('删除失败：'+res.error); else refresh();
        }).catch(function(err){alert('请求失败：'+err);});
    } else if(act === 'rotate'){
      if(!confirm('轮换隧道 '+id+' 的 key？当前连接的客户端会被踢下线，需用新 key 重启。')) return;
      fetch('/api/tunnels/'+encodeURIComponent(id)+'/rotate', {method:'POST'})
        .then(function(r){return r.json();}).then(function(res){
          if(!res.ok){alert('轮换失败：'+res.error);return;}
          showKey(id, res.key, 'key 已轮换');
          refresh();
        }).catch(function(err){alert('请求失败：'+err);});
    }
  });

  document.getElementById('create-form').addEventListener('submit', function(e){
    e.preventDefault();
    var form = e.target;
    var fd = new FormData(form);
    var type = fd.get('type');
    var body = {type:type, note:fd.get('note')||''};
    if(type === 'http'){
      body.subdomain = fd.get('subdomain')||'';
      body.local = fd.get('local')||'';
    } else {
      body.localHost = fd.get('localHost')||'127.0.0.1';
      body.localPort = Number(fd.get('localPort'));
      body.remotePort = Number(fd.get('remotePort'));
      body.authToken = fd.get('authToken')||'';
    }
    fetch('/api/tunnels', {
      method:'POST',
      headers:{'content-type':'application/json'},
      body:JSON.stringify(body)
    }).then(function(r){return r.json();}).then(function(res){
      if(!res.ok){alert('创建失败：'+res.error);return;}
      showKey(res.record.tunnelId, res.key, '隧道已创建');
      closeModal('create-modal');
      form.reset();
      toggleFields();
      refresh();
    }).catch(function(err){alert('请求失败：'+err);});
  });

  document.getElementById('copy-key').addEventListener('click', function(){
    var text = document.getElementById('new-key').textContent;
    if(navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(text).then(function(){
        document.getElementById('copy-key').textContent = '已复制';
      });
    } else {
      alert('请手动复制：'+text);
    }
  });

  refresh();
  setInterval(refresh, 10000);
})();
</script>
</body></html>`;

export function startDashboard(registry: Registry, opts: DashboardOptions): Server {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
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
      const path = url.pathname;
      const method = req.method ?? "GET";

      try {
        if (path === "/api/state" && method === "GET") {
          const snap = snapshot(registry);
          const onlineIds = new Set(snap.clients.filter((c) => c.online).map((c) => c.clientId));
          json(res, 200, { ...snap, tunnels: tunnelList(opts.tunnelsFile, onlineIds) });
          return;
        }

        if (path === "/api/tunnels" && method === "POST") {
          const body = await readBody(req);
          const result = createTunnel(opts.tunnelsFile, toCreateInput(body));
          if (!result.ok) {
            json(res, 400, { ok: false, error: result.error });
            return;
          }
          opts.log.info("dashboard 创建隧道", { tunnelId: result.record.tunnelId });
          json(res, 201, { ok: true, key: result.key, record: result.record });
          return;
        }

        const rotateMatch = /^\/api\/tunnels\/([^/]+)\/rotate$/.exec(path);
        if (rotateMatch && method === "POST") {
          const result = rotateTunnel(opts.tunnelsFile, decodeURIComponent(rotateMatch[1]!));
          if (!result.ok) {
            json(res, 404, { ok: false, error: result.error });
            return;
          }
          opts.log.info("dashboard 轮换 key", { tunnelId: result.record.tunnelId });
          json(res, 200, { ok: true, key: result.record.key, record: result.record });
          return;
        }

        const deleteMatch = /^\/api\/tunnels\/([^/]+)$/.exec(path);
        if (deleteMatch && method === "DELETE") {
          const result = deleteTunnel(opts.tunnelsFile, decodeURIComponent(deleteMatch[1]!));
          if (!result.ok) {
            json(res, 404, { ok: false, error: result.error });
            return;
          }
          opts.log.warn("dashboard 删除隧道", { tunnelId: result.record.tunnelId });
          json(res, 200, { ok: true, record: result.record });
          return;
        }

        if (path === "/" || path === "/index.html") {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          res.end(PAGE);
          return;
        }

        json(res, 404, { error: "not found" });
      } catch (err) {
        json(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
    })();
  });

  server.listen(opts.port, opts.bindAddr, () => {
    opts.log.info("dashboard 已监听", { addr: `${opts.bindAddr}:${opts.port}` });
  });
  return server;
}
