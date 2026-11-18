/* z-frp 桌面客户端前端：一个窗口管理多条隧道，每条隧道一个独立的客户端实例。 */
(function () {
  "use strict";

  /**
   * 浏览器里直接打开 index.html 时没有 Tauri 运行时，这里给一个假实现，
   * 方便调样式时看到两条隧道的形态；在 Tauri 里永远走真实现。
   */
  const isTauri = Boolean(window.__TAURI__);
  const bridge = isTauri
    ? { invoke: window.__TAURI__.core.invoke, listen: window.__TAURI__.event.listen }
    : (() => {
        const handlers = new Map();
        const emit = (name, payload) =>
          (handlers.get(name) || []).forEach((fn) => fn({ payload }));
        return {
          invoke: async (cmd, args = {}) => {
            if (cmd === "app_version") return "0.2.0-preview";
            if (cmd === "get_settings")
              return {
                server: "wss://frp.infocloud.top/_frp",
                remember: true,
                autoConnect: false,
                tunnels: [
                  { id: "demo-1", note: "官网", key: "demo-key-1", local: "" },
                  { id: "demo-2", note: "数据库", key: "demo-key-2", local: "127.0.0.1:3306" },
                ],
              };
            if (cmd === "start_client") {
              const id = args.id;
              setTimeout(() => {
                emit("zfrp://log", { id, level: "info", message: "认证通过, clientId=demo" });
                emit("zfrp://log", { id, level: "info", message: "已获取隧道配置: 代理数=2" });
                emit("zfrp://status", {
                  id,
                  state: "online",
                  tunnelId: `t_demo_${id}`,
                  clientId: `t_demo_${id}`,
                  since: Date.now(),
                  error: null,
                  proxies: [
                    { name: "官网", kind: "http", target: "www.example.com" },
                    { name: "数据库", kind: "tcp", target: ":33061 → 127.0.0.1:3306" },
                  ],
                });
              }, 300);
            }
            if (cmd === "stop_client") {
              emit("zfrp://status", {
                id: args.id,
                state: "offline",
                tunnelId: null,
                clientId: null,
                since: null,
                error: null,
                proxies: [],
              });
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
  const $ = (id) => document.getElementById(id);
  const el = {
    statusPill: $("statusPill"),
    statusText: $("statusText"),
    versionText: $("versionText"),
    serverInput: $("serverInput"),
    remember: $("remember"),
    autoConnect: $("autoConnect"),
    tunnelList: $("tunnelList"),
    tunnelTabs: $("tunnelTabs"),
    tunnelCount: $("tunnelCount"),
    addTunnel: $("addTunnel"),
    logBody: $("logBody"),
    autoScroll: $("autoScroll"),
    clearLogs: $("clearLogs"),
    copyLogs: $("copyLogs"),
    toast: $("toast"),
  };

  const STATE_TEXT = {
    offline: "未连接",
    connecting: "连接中…",
    online: "已连接",
    reconnecting: "重连中…",
  };
  const ACTIVE = new Set(["connecting", "online", "reconnecting"]);
  const DEFAULT_SERVER = "wss://frp.infocloud.top/_frp";

  const settings = { server: DEFAULT_SERVER, remember: true, autoConnect: false, tunnels: [] };
  const runtime = new Map(); // id → 最近一次 status 事件

  let toastTimer = null;
  let persistTimer = null;
  let activeTunnelId = null; // tab 当前选中的隧道 id

  function newId() {
    return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  }

  function makeTunnel(partial = {}) {
    return {
      id: partial.id || newId(),
      note: partial.note || "",
      key: partial.key || "",
      local: partial.local || "",
    };
  }

  function tunnelLabel(id) {
    const i = settings.tunnels.findIndex((t) => t.id === id);
    return i < 0 ? "隧道?" : settings.tunnels[i].note.trim() || `隧道 ${i + 1}`;
  }

  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove("show"), 2200);
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
    line.innerHTML = `<span class="log-time"></span><span class="log-level">${label}</span><span class="log-msg"></span>`;
    line.querySelector(".log-time").textContent = time || nowTime();
    line.querySelector(".log-msg").textContent = message;
    el.logBody.appendChild(line);
    // 日志过多时截断，避免长时间运行占用内存
    while (el.logBody.childElementCount > 800) el.logBody.removeChild(el.logBody.firstChild);
    if (el.autoScroll.checked) el.logBody.scrollTop = el.logBody.scrollHeight;
  }

  function persist(immediate = false) {
    clearTimeout(persistTimer);
    const write = async () => {
      try {
        await invoke("save_settings", {
          settings: {
            server: settings.server,
            remember: settings.remember,
            autoConnect: settings.autoConnect,
            tunnels: settings.tunnels,
          },
        });
      } catch (err) {
        appendLog("error", `保存设置失败: ${err}`);
      }
    };
    if (immediate) return write();
    persistTimer = setTimeout(write, 300);
  }

  function formatSince(since) {
    const sec = Math.max(0, Math.floor((Date.now() - since) / 1000));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    return h > 0 ? `${h} 小时 ${m} 分` : m > 0 ? `${m} 分 ${s} 秒` : `${s} 秒`;
  }

  function card(id) {
    return el.tunnelList.querySelector(`[data-id="${CSS.escape(id)}"]`);
  }

  function setCardHint(id, msg, isError = false) {
    const node = card(id)?.querySelector(".js-hint");
    if (!node) return;
    node.textContent = msg || "";
    node.classList.toggle("error", Boolean(isError));
  }

  function renderProxies(list, count, proxies) {
    list.innerHTML = "";
    count.textContent = proxies && proxies.length ? `${proxies.length} 个` : "";
    if (!proxies || proxies.length === 0) {
      const li = document.createElement("li");
      li.className = "empty";
      li.textContent = "连接后显示服务端下发的代理";
      list.appendChild(li);
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
      list.appendChild(li);
    }
  }

  function updateCard(id) {
    const node = card(id);
    if (!node) return;
    const s = runtime.get(id);
    const state = s?.state || "offline";
    const active = ACTIVE.has(state);

    const pill = node.querySelector(".js-status");
    pill.dataset.state = state;
    node.querySelector(".js-state-text").textContent = STATE_TEXT[state] || state;
    node.querySelector(".js-tunnel-id").textContent = s?.tunnelId || "—";
    node.querySelector(".js-client-id").textContent = s?.clientId || "—";

    const uptime = node.querySelector(".js-uptime");
    uptime.textContent = state === "online" && s?.since ? formatSince(s.since) : "—";
    uptime.dataset.since = state === "online" ? String(s.since || Date.now()) : "";

    renderProxies(node.querySelector(".js-proxy-list"), node.querySelector(".js-proxy-count"), s?.proxies);

    node.querySelector(".js-connect").hidden = active;
    node.querySelector(".js-connect").disabled = active;
    node.querySelector(".js-disconnect").hidden = !active;
    for (const sel of [".js-key", ".js-local", ".js-toggle-key", ".js-paste-key", ".js-remove"]) {
      node.querySelector(sel).disabled = active;
    }

    if (state === "reconnecting" && s?.error) setCardHint(id, s.error, true);
    else if (state === "online") setCardHint(id, "隧道已就绪");
    else if (!active) setCardHint(id, "");
  }

  function updateGlobalStatus() {
    const states = Array.from(runtime.values()).map((s) => s.state);
    const total = settings.tunnels.length;
    const online = states.filter((s) => s === "online").length;
    const reconnecting = states.filter((s) => s === "reconnecting").length;
    const connecting = states.filter((s) => s === "connecting").length;

    let state = "offline";
    let text = "未连接";
    if (total > 0 && online === total) {
      state = "online";
      text = `${total} 条已连接`;
    } else if (reconnecting > 0) {
      state = "reconnecting";
      text = `${online}/${total} 已连接 · 重连中`;
    } else if (connecting > 0) {
      state = "connecting";
      text = `${online}/${total} 已连接 · 连接中`;
    } else if (online > 0) {
      state = "online";
      text = `${online}/${total} 已连接`;
    }
    el.statusPill.dataset.state = state;
    el.statusText.textContent = text;
  }

  function tab(id) {
    return el.tunnelTabs.querySelector(`[data-id="${CSS.escape(id)}"]`);
  }

  function updateTab(id) {
    const node = tab(id);
    if (!node) return;
    const i = settings.tunnels.findIndex((t) => t.id === id);
    if (i < 0) return;
    const s = runtime.get(id);
    const state = s?.state || "offline";
    node.dataset.state = state;
    node.querySelector(".js-tab-label").textContent =
      settings.tunnels[i].note.trim() || `隧道 ${i + 1}`;
    node.title = `${settings.tunnels[i].note.trim() || `隧道 ${i + 1}`} · ${STATE_TEXT[state] || state}`;
  }

  function renderTabs() {
    el.tunnelTabs.innerHTML = "";
    settings.tunnels.forEach((t, i) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "tunnel-tab";
      btn.setAttribute("role", "tab");
      btn.dataset.id = t.id;
      btn.innerHTML = `
        <span class="tab-dot"></span>
        <span class="tab-index">${i + 1}</span>
        <span class="js-tab-label"></span>
      `;
      btn.addEventListener("click", () => selectTunnel(t.id));
      el.tunnelTabs.appendChild(btn);
      updateTab(t.id);
    });
    for (const node of el.tunnelTabs.children) {
      const active = node.dataset.id === activeTunnelId;
      node.classList.toggle("active", active);
      node.setAttribute("aria-selected", String(active));
    }
  }

  function selectTunnel(id) {
    if (!settings.tunnels.some((t) => t.id === id)) return;
    activeTunnelId = id;
    renderTabs();
    renderCard();
    // 切 tab 后把选中的标签滚进可视区
    tab(id)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  /** 只渲染当前 tab 选中的那条隧道卡片 */
  function renderCard() {
    el.tunnelList.innerHTML = "";
    const t = settings.tunnels.find((x) => x.id === activeTunnelId);
    if (!t) return;
    const i = settings.tunnels.findIndex((x) => x.id === t.id);
      const article = document.createElement("article");
      article.className = "card tunnel";
      article.dataset.id = t.id;
      article.innerHTML = `
        <div class="tunnel-head">
          <div class="tunnel-title">
            <span class="tunnel-index">隧道 ${i + 1}</span>
            <input class="note-input js-note" placeholder="备注（可选）" />
          </div>
          <div class="tunnel-head-actions">
            <span class="status-pill js-status" data-state="offline"><span class="dot"></span><span class="js-state-text">未连接</span></span>
            <button class="icon-btn js-remove" title="删除这条隧道">×</button>
          </div>
        </div>
        <label>隧道 Key</label>
        <div class="input-row">
          <input type="password" class="js-key" spellcheck="false" placeholder="在 dashboard 隧道详情里复制" />
          <button class="icon-btn js-toggle-key" title="显示/隐藏">👁</button>
          <button class="icon-btn js-paste-key" title="从剪贴板粘贴">粘贴</button>
        </div>
        <label>本地服务覆盖 <span class="muted">（可选，一般留空）</span></label>
        <input class="js-local" spellcheck="false" placeholder="http://127.0.0.1:8080 或 127.0.0.1:3306" />
        <div class="tunnel-meta">
          <dl class="kv">
            <dt>隧道 ID</dt><dd class="js-tunnel-id">—</dd>
            <dt>客户端 ID</dt><dd class="js-client-id">—</dd>
            <dt>已连接时长</dt><dd class="js-uptime">—</dd>
          </dl>
          <div class="proxy-wrap">
            <h3>代理 <span class="count js-proxy-count"></span></h3>
            <ul class="proxy-list js-proxy-list"><li class="empty">连接后显示服务端下发的代理</li></ul>
          </div>
        </div>
        <p class="hint js-hint"></p>
        <div class="actions">
          <button class="ghost js-disconnect" hidden>断开</button>
          <button class="primary js-connect">连接</button>
        </div>
      `;
      // 用 value 赋值而不是拼进 HTML，避免备注里的引号破坏结构
      article.querySelector(".js-note").value = t.note;
      article.querySelector(".js-key").value = t.key;
      article.querySelector(".js-local").value = t.local;
      el.tunnelList.appendChild(article);
      updateCard(t.id);
  }

  function renderTunnels() {
    if (!settings.tunnels.some((t) => t.id === activeTunnelId)) {
      activeTunnelId = settings.tunnels[0]?.id || null;
    }
    renderTabs();
    renderCard();
  }

  async function connect(id) {
    const t = settings.tunnels.find((x) => x.id === id);
    if (!t) return;
    const key = t.key.trim();
    if (!key) {
      setCardHint(id, "请先填入隧道 Key", true);
      card(id)?.querySelector(".js-key").focus();
      return;
    }
    const server = settings.server.trim() || DEFAULT_SERVER;
    setCardHint(id, "");
    try {
      await persist(true);
      runtime.set(id, { state: "connecting" });
      updateCard(id);
      updateTab(id);
      updateGlobalStatus();
      await invoke("start_client", { id, key, server, local: t.local.trim() || null });
    } catch (err) {
      const msg = String(err);
      setCardHint(id, msg, true);
      appendLog("error", `[${tunnelLabel(id)}] ${msg}`);
    }
  }

  async function disconnect(id) {
    try {
      await invoke("stop_client", { id });
    } catch (err) {
      appendLog("error", `[${tunnelLabel(id)}] ${err}`);
    }
  }

  function addTunnel() {
    const t = makeTunnel();
    settings.tunnels.push(t);
    activeTunnelId = t.id;
    renderTunnels();
    updateGlobalStatus();
    persist(true);
    appendLog("info", `已添加 ${tunnelLabel(t.id)}`);
    card(t.id)?.querySelector(".js-key").focus();
  }

  async function removeTunnel(id) {
    const idx = settings.tunnels.findIndex((t) => t.id === id);
    if (idx < 0) return;
    const label = tunnelLabel(id);
    if (ACTIVE.has(runtime.get(id)?.state)) await disconnect(id);
    settings.tunnels.splice(idx, 1);
    runtime.delete(id);
    if (activeTunnelId === id) {
      activeTunnelId = settings.tunnels[Math.min(idx, settings.tunnels.length - 1)]?.id || null;
    }
    renderTunnels();
    updateGlobalStatus();
    persist(true);
    appendLog("info", `已移除 ${label}`);
  }

  /* ---------- 交互 ---------- */

  el.addTunnel.addEventListener("click", addTunnel);

  el.tunnelList.addEventListener("input", (e) => {
    const article = e.target.closest(".tunnel");
    if (!article) return;
    const t = settings.tunnels.find((x) => x.id === article.dataset.id);
    if (!t) return;
    if (e.target.matches(".js-key")) t.key = e.target.value;
    else if (e.target.matches(".js-local")) t.local = e.target.value;
    else if (e.target.matches(".js-note")) {
      t.note = e.target.value;
      updateTab(t.id); // 备注就是 tab 标题，实时同步
    } else return;
    persist();
  });

  el.tunnelList.addEventListener("click", async (e) => {
    const btn = e.target.closest("button");
    const article = e.target.closest(".tunnel");
    if (!btn || !article) return;
    const id = article.dataset.id;
    if (btn.matches(".js-connect")) await connect(id);
    else if (btn.matches(".js-disconnect")) await disconnect(id);
    else if (btn.matches(".js-remove")) await removeTunnel(id);
    else if (btn.matches(".js-toggle-key")) {
      const input = article.querySelector(".js-key");
      input.type = input.type === "password" ? "text" : "password";
    } else if (btn.matches(".js-paste-key")) {
      try {
        const text = (await navigator.clipboard.readText()).trim();
        if (!text) return toast("剪贴板为空");
        const input = article.querySelector(".js-key");
        input.value = text;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        toast("已粘贴 Key");
      } catch {
        toast("无法读取剪贴板，请手动粘贴");
      }
    }
  });

  el.serverInput.addEventListener("input", () => {
    settings.server = el.serverInput.value;
    persist();
  });

  el.remember.addEventListener("change", () => {
    settings.remember = el.remember.checked;
    if (!settings.remember) {
      settings.autoConnect = false;
      el.autoConnect.checked = false;
    }
    persist(true);
  });

  el.autoConnect.addEventListener("change", () => {
    settings.autoConnect = el.autoConnect.checked;
    persist(true);
  });

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.target.tagName !== "INPUT") return;
    const article = e.target.closest(".tunnel");
    if (!article || ACTIVE.has(runtime.get(article.dataset.id)?.state)) return;
    e.preventDefault();
    connect(article.dataset.id);
  });

  el.logBody.addEventListener("scroll", () => {
    el.logBody.classList.toggle("scrolled", el.logBody.scrollTop > 2);
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

  /* ---------- 事件订阅 ---------- */

  listen("zfrp://status", ({ payload }) => {
    if (!payload?.id) return;
    runtime.set(payload.id, payload);
    updateCard(payload.id);
    updateTab(payload.id); // 后台状态变化同步到 tab 圆点，不必等切回来
    updateGlobalStatus();
  });

  listen("zfrp://log", ({ payload }) => {
    appendLog(payload.level, payload.id ? `[${tunnelLabel(payload.id)}] ${payload.message}` : payload.message, payload.time);
  });

  /* ---------- 启动 ---------- */

  (async () => {
    try {
      const s = await invoke("get_settings");
      settings.server = s.server || DEFAULT_SERVER;
      settings.remember = s.remember !== false;
      settings.autoConnect = Boolean(s.autoConnect);
      settings.tunnels = (s.tunnels || []).map(makeTunnel);
    } catch {
      /* 用默认值 */
    }
    if (!settings.tunnels.length) settings.tunnels.push(makeTunnel());

    el.serverInput.value = settings.server;
    el.remember.checked = settings.remember;
    el.autoConnect.checked = settings.autoConnect;
    try {
      el.versionText.textContent = `v${await invoke("app_version")}`;
    } catch {
      /* 保持默认 */
    }

    renderTunnels();
    updateGlobalStatus();
    appendLog("info", "客户端已启动，填入隧道 Key 后点击「连接」；可添加多条隧道");
    setInterval(() => {
      for (const [id, s] of runtime) {
        if (s.state !== "online") continue;
        const node = card(id);
        if (node) node.querySelector(".js-uptime").textContent = formatSince(s.since || Date.now());
      }
    }, 1000);

    if (settings.autoConnect) {
      const withKey = settings.tunnels.filter((t) => t.key.trim());
      if (withKey.length) {
        appendLog("info", `已启用自动连接，正在连接 ${withKey.length} 条隧道…`);
        for (const t of withKey) await connect(t.id);
      }
    }
  })();
})();
