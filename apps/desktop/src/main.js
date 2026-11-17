/* z-frp 桌面客户端前端：通过 Tauri 命令控制 Rust 核心，事件回推状态与日志。 */

(function () {


/**
 * 浏览器里直接打开 index.html 时没有 Tauri 运行时，这里给一个假实现，
 * 方便调样式时看到「已连接」的完整形态；在 Tauri 里永远走真实现。
 */
const isTauri = Boolean(window.__TAURI__);
const bridge = isTauri
  ? { invoke: window.__TAURI__.core.invoke, listen: window.__TAURI__.event.listen }
  : (() => {
      const handlers = new Map();
      const emit = (name, payload) =>
        (handlers.get(name) || []).forEach((fn) => fn({ payload }));
      return {
        invoke: async (cmd) => {
          if (cmd === "app_version") return "0.1.0-preview";
          if (cmd === "get_settings")
            return {
              key: "demo-key-not-real",
              server: "wss://frp.infocloud.top/_frp",
              local: "",
              remember: true,
              autoConnect: true,
            };
          if (cmd === "start_client") {
            setTimeout(() => {
              emit("zfrp://log", { level: "info", message: "认证通过, clientId=demo" });
              emit("zfrp://log", { level: "info", message: "已获取隧道配置: 代理数=2" });
              emit("zfrp://status", {
                state: "online",
                tunnelId: "t_demo00000000",
                clientId: "t_demo00000000",
                since: Date.now(),
                error: null,
                proxies: [
                  { name: "官网", kind: "http", target: "www.example.com" },
                  { name: "数据库", kind: "tcp", target: ":33061 → 127.0.0.1:3306" },
                ],
              });
            }, 300);
            return null;
          }
          return null;
        },
        listen: async (name, fn) => {
          if (!handlers.has(name)) handlers.set(name, []);
          handlers.get(name).push(fn);
          return () => {};
        },
      };
    })();

const { invoke, listen } = bridge;

const el = {
  statusPill: document.getElementById("statusPill"),
  statusText: document.getElementById("statusText"),
  keyInput: document.getElementById("keyInput"),
  toggleKey: document.getElementById("toggleKey"),
  pasteKey: document.getElementById("pasteKey"),
  serverInput: document.getElementById("serverInput"),
  localInput: document.getElementById("localInput"),
  remember: document.getElementById("remember"),
  autoConnect: document.getElementById("autoConnect"),
  connectBtn: document.getElementById("connectBtn"),
  disconnectBtn: document.getElementById("disconnectBtn"),
  hintText: document.getElementById("hintText"),
  tunnelId: document.getElementById("tunnelId"),
  clientId: document.getElementById("clientId"),
  uptime: document.getElementById("uptime"),
  serverShown: document.getElementById("serverShown"),
  proxyList: document.getElementById("proxyList"),
  logBody: document.getElementById("logBody"),
  autoScroll: document.getElementById("autoScroll"),
  clearLogs: document.getElementById("clearLogs"),
  copyLogs: document.getElementById("copyLogs"),
  toast: document.getElementById("toast"),
  versionText: document.getElementById("versionText"),
};

const STATE_TEXT = {
  offline: "未连接",
  connecting: "连接中…",
  online: "已连接",
  reconnecting: "重连中…",
};

let onlineSince = null;
let running = false;
let toastTimer = null;

/* ---------- 小工具 ---------- */

function toast(msg) {
  el.toast.textContent = msg;
  el.toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove("show"), 2200);
}

function setHint(msg, isError = false) {
  el.hintText.textContent = msg || "";
  el.hintText.classList.toggle("error", Boolean(isError));
}

function setState(state) {
  el.statusPill.dataset.state = state;
  el.statusText.textContent = STATE_TEXT[state] ?? state;
  running = state === "online" || state === "connecting" || state === "reconnecting";
  el.connectBtn.hidden = running;
  el.disconnectBtn.hidden = !running;
  el.connectBtn.disabled = running;
  [el.keyInput, el.serverInput, el.localInput, el.remember].forEach((n) => {
    n.disabled = running;
  });
  if (state !== "online") onlineSince = null;
  renderUptime();
}

function renderUptime() {
  if (!onlineSince) {
    el.uptime.textContent = "—";
    return;
  }
  const sec = Math.max(0, Math.floor((Date.now() - onlineSince) / 1000));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  el.uptime.textContent = h > 0
    ? `${h} 小时 ${m} 分`
    : m > 0
      ? `${m} 分 ${s} 秒`
      : `${s} 秒`;
}

function pad(n) {
  return String(n).padStart(2, "0");
}

function nowTime() {
  const d = new Date();
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function appendLog(level, message, time) {
  const line = document.createElement("div");
  line.className = `log-line ${level}`;
  const label = level === "error" ? "ERRO" : level === "warn" ? "WARN" : "INFO";
  line.innerHTML = `<span class="log-time">${time || nowTime()}</span><span class="log-level">${label}</span><span class="log-msg"></span>`;
  line.querySelector(".log-msg").textContent = message;
  el.logBody.appendChild(line);
  // 日志过多时截断，避免长时间运行占用内存
  while (el.logBody.childElementCount > 800) el.logBody.removeChild(el.logBody.firstChild);
  if (el.autoScroll.checked) el.logBody.scrollTop = el.logBody.scrollHeight;
}

function renderProxies(proxies) {
  el.proxyList.innerHTML = "";
  if (!proxies || proxies.length === 0) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "连接后显示服务端下发的代理";
    el.proxyList.appendChild(li);
    return;
  }
  for (const p of proxies) {
    const li = document.createElement("li");
    const tag = document.createElement("span");
    tag.className = `tag ${p.kind}`;
    tag.textContent = p.kind;
    const name = document.createElement("span");
    name.className = "proxy-name";
    name.textContent = p.name;
    const addr = document.createElement("span");
    addr.className = "proxy-addr";
    addr.textContent = p.target;
    addr.title = p.target;
    li.append(tag, name, addr);
    el.proxyList.appendChild(li);
  }
}

/* ---------- 交互 ---------- */

el.toggleKey.addEventListener("click", () => {
  el.keyInput.type = el.keyInput.type === "password" ? "text" : "password";
});

el.pasteKey.addEventListener("click", async () => {
  try {
    const text = (await navigator.clipboard.readText()).trim();
    if (!text) return toast("剪贴板为空");
    el.keyInput.value = text;
    toast("已粘贴 Key");
  } catch {
    toast("无法读取剪贴板，请手动粘贴");
  }
});

el.clearLogs.addEventListener("click", () => {
  el.logBody.innerHTML = "";
});

el.copyLogs.addEventListener("click", async () => {
  const text = Array.from(el.logBody.children)
    .map((n) => n.textContent.replace(/\s+/g, " ").trim())
    .join("\n");
  if (!text) return toast("没有日志");
  try {
    await navigator.clipboard.writeText(text);
    toast("日志已复制");
  } catch {
    toast("复制失败");
  }
});

el.connectBtn.addEventListener("click", async () => {
  const key = el.keyInput.value.trim();
  if (!key) {
    setHint("请先填入隧道 Key", true);
    el.keyInput.focus();
    return;
  }
  const server = el.serverInput.value.trim() || "wss://frp.infocloud.top/_frp";
  const local = el.localInput.value.trim();
  setHint("");
  el.connectBtn.disabled = true;
  el.serverShown.textContent = server;
  try {
    if (el.remember.checked) {
      await invoke("save_settings", {
        settings: { key, server, local, remember: true, autoConnect: el.autoConnect.checked },
      });
    }
    await invoke("start_client", { key, server, local: local || null });
  } catch (err) {
    el.connectBtn.disabled = false;
    setHint(String(err), true);
    appendLog("error", String(err));
  }
});

el.disconnectBtn.addEventListener("click", async () => {
  try {
    await invoke("stop_client");
  } catch (err) {
    appendLog("error", String(err));
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !running && document.activeElement?.tagName === "INPUT") {
    el.connectBtn.click();
  }
});

/* ---------- 事件订阅 ---------- */

listen("zfrp://status", (event) => {
  const s = event.payload;
  setState(s.state);
  el.tunnelId.textContent = s.tunnelId || "—";
  el.clientId.textContent = s.clientId || "—";
  if (s.state === "online") {
    if (!onlineSince) onlineSince = s.since || Date.now();
    el.disconnectBtn.disabled = false;
    setHint("隧道已就绪");
  }
  if (s.state === "reconnecting" && s.error) setHint(s.error, true);
  if (s.state === "offline") {
    setHint("");
    el.disconnectBtn.disabled = false;
  }
  renderProxies(s.proxies);
});

listen("zfrp://log", (event) => {
  const l = event.payload;
  appendLog(l.level, l.message, l.time);
});

/* ---------- 启动 ---------- */

(async () => {
  let settings = {};
  try {
    settings = await invoke("get_settings");
    el.keyInput.value = settings.key || "";
    el.serverInput.value = settings.server || "wss://frp.infocloud.top/_frp";
    el.localInput.value = settings.local || "";
    el.remember.checked = settings.remember !== false;
    el.autoConnect.checked = Boolean(settings.autoConnect);
  } catch {
    el.serverInput.value = "wss://frp.infocloud.top/_frp";
  }
  try {
    el.versionText.textContent = await invoke("app_version");
  } catch {
    /* 保持默认 */
  }
  setState("offline");
  appendLog("info", "客户端已启动，填入隧道 Key 后点击「连接」");
  setInterval(renderUptime, 1000);

  // 勾了「启动后自动连接」且本地存了 key，就直接连
  if (settings.autoConnect && settings.key) {
    appendLog("info", "已启用自动连接，正在连接隧道…");
    el.connectBtn.click();
  }
})();
})();
