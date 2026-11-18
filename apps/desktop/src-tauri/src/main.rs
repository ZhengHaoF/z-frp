// z-frp 桌面客户端：Tauri 外壳，把多个 frpc-core 实例的状态/日志事件桥接到前端。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use frpc_core::{ClientOptions, ClientStatus, ConnState, FrpcClient, LogEvent, LogLevel, ProxySpec};
use serde::{Deserialize, Serialize};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};
use tokio::sync::Mutex;

/// 托盘图标 id，用于从 AppHandle 取回图标更新 tooltip
const TRAY_ID: &str = "zfrp-tray";
/// 托盘菜单项 id
const MENU_SHOW: &str = "tray-show";
const MENU_QUIT: &str = "tray-quit";

// ---------- 设置 ----------

/// 一条隧道的本地配置。id 由前端生成，在设置文件、事件与命令里稳定标识这条隧道。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TunnelSettings {
    #[serde(default)]
    id: String,
    #[serde(default)]
    note: String,
    #[serde(default)]
    key: String,
    #[serde(default)]
    local: String,
}

impl Default for TunnelSettings {
    fn default() -> Self {
        Self {
            id: new_id(),
            note: String::new(),
            key: String::new(),
            local: String::new(),
        }
    }
}

/// 持久化到 app_config_dir/settings.json 的用户设置
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Settings {
    #[serde(default)]
    server: String,
    #[serde(default = "default_true")]
    remember: bool,
    #[serde(default)]
    auto_connect: bool,
    #[serde(default)]
    tunnels: Vec<TunnelSettings>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            server: "wss://frp.infocloud.top/_frp".into(),
            remember: true,
            auto_connect: false,
            tunnels: vec![TunnelSettings::default()],
        }
    }
}

fn default_true() -> bool {
    true
}

impl Settings {
    fn sanitized(mut self) -> Self {
        if self.server.trim().is_empty() {
            self.server = "wss://frp.infocloud.top/_frp".into();
        }
        if self.tunnels.is_empty() {
            self.tunnels.push(TunnelSettings::default());
        }
        for tunnel in &mut self.tunnels {
            if tunnel.id.is_empty() {
                tunnel.id = new_id();
            }
        }
        self
    }
}

fn new_id() -> String {
    use std::sync::atomic::AtomicU64;
    static SEQ: AtomicU64 = AtomicU64::new(0);
    format!("t{}-{}", now_millis(), SEQ.fetch_add(1, Ordering::Relaxed))
}

// ---------- 应用状态 ----------

struct AppState {
    /// 一个窗口里同时跑多条隧道，按前端给的 id 索引
    clients: Mutex<HashMap<String, Arc<FrpcClient>>>,
    /// 每条隧道最近一次连接状态，用于托盘 tooltip 聚合
    statuses: Mutex<HashMap<String, String>>,
    settings_path: PathBuf,
    /// 真正的退出请求（托盘菜单「退出」或系统关机），与「关窗仅隐藏」区分开
    quitting: AtomicBool,
}

impl AppState {
    fn request_quit(&self) {
        self.quitting.store(true, Ordering::SeqCst);
    }

    fn is_quitting(&self) -> bool {
        self.quitting.load(Ordering::SeqCst)
    }
}

// ---------- 事件负载 ----------

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ProxyView {
    name: String,
    kind: String,
    target: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct StatusEvent {
    id: String,
    state: &'static str,
    tunnel_id: Option<String>,
    client_id: Option<String>,
    proxies: Vec<ProxyView>,
    error: Option<String>,
    since: Option<i64>,
}

#[derive(Serialize, Clone)]
struct LogPayload {
    id: String,
    level: &'static str,
    message: String,
}

fn proxy_view(p: &ProxySpec) -> ProxyView {
    match p {
        ProxySpec::Http(h) => ProxyView {
            name: h.name.clone(),
            kind: "http".into(),
            target: h.host.clone(),
        },
        ProxySpec::Tcp(t) => ProxyView {
            name: t.name.clone(),
            kind: "tcp".into(),
            target: format!(":{} → {}:{}", t.remote_port, t.local_host, t.local_port),
        },
    }
}

fn status_event(id: &str, s: &ClientStatus) -> StatusEvent {
    let state = match s.state {
        ConnState::Disconnected => "offline",
        ConnState::Connecting => "connecting",
        ConnState::Online => "online",
        ConnState::Reconnecting => "reconnecting",
    };
    StatusEvent {
        id: id.to_string(),
        state,
        tunnel_id: s.tunnel_id.clone(),
        client_id: s.client_id.clone(),
        proxies: s.proxies.iter().map(proxy_view).collect(),
        error: s.last_error.clone(),
        since: if state == "online" { Some(now_millis()) } else { None },
    }
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn log_payload(id: &str, e: &LogEvent) -> LogPayload {
    LogPayload {
        id: id.to_string(),
        level: match e.level {
            LogLevel::Info => "info",
            LogLevel::Warn => "warn",
            LogLevel::Error => "error",
        },
        message: e.message.clone(),
    }
}

/// 根据所有隧道的最新状态刷新托盘悬停文字
async fn refresh_tray_tooltip(app: &AppHandle, state: &AppState) {
    let statuses = state.statuses.lock().await;
    let total = statuses.len();
    let count = |want: &str| statuses.values().filter(|s| s.as_str() == want).count();
    let online = count("online");
    let reconnecting = count("reconnecting");
    let connecting = count("connecting");

    let tip = if total == 0 {
        "z-frp · 未连接".to_string()
    } else if online == total {
        format!("z-frp · {total} 条隧道已连接")
    } else if reconnecting > 0 {
        format!("z-frp · {online}/{total} 已连接 · 重连中")
    } else if connecting > 0 {
        format!("z-frp · {online}/{total} 已连接 · 连接中")
    } else {
        format!("z-frp · {online}/{total} 已连接")
    };

    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_tooltip(Some(tip));
    }
}

// ---------- 命令 ----------

#[tauri::command]
fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[tauri::command]
fn get_settings(state: State<'_, AppState>) -> Settings {
    match std::fs::read_to_string(&state.settings_path) {
        Ok(text) => serde_json::from_str::<Settings>(&text)
            .unwrap_or_default()
            .sanitized(),
        Err(_) => Settings::default().sanitized(),
    }
}

#[tauri::command]
fn save_settings(state: State<'_, AppState>, settings: Settings) -> Result<(), String> {
    let mut settings = settings.sanitized();
    if !settings.remember {
        // 不记住 key 时，自动连接也失去意义：清掉所有隧道的 key
        for tunnel in &mut settings.tunnels {
            tunnel.key.clear();
        }
        settings.auto_connect = false;
    }
    if let Some(dir) = state.settings_path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("创建配置目录失败: {e}"))?;
    }
    let text = serde_json::to_string_pretty(&settings).map_err(|e| format!("序列化设置失败: {e}"))?;
    std::fs::write(&state.settings_path, text).map_err(|e| format!("写入设置失败: {e}"))
}

#[tauri::command]
async fn start_client(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    key: String,
    server: String,
    local: Option<String>,
) -> Result<(), String> {
    let id = id.trim().to_string();
    if id.is_empty() {
        return Err("隧道标识缺失".into());
    }
    let key = key.trim().to_string();
    if key.is_empty() {
        return Err("请先填入隧道 Key".into());
    }
    let server = server.trim().to_string();
    if !(server.starts_with("ws://") || server.starts_with("wss://")) {
        return Err("服务端地址需以 ws:// 或 wss:// 开头".into());
    }
    let local = local.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());

    // 同一 id 只停自己，不影响其他隧道
    let old = state.clients.lock().await.remove(&id);
    if let Some(old) = old {
        old.stop().await;
    }

    let (client, mut status_rx, mut log_rx) = FrpcClient::new(ClientOptions { key, server, local });
    let client = Arc::new(client);

    state.statuses.lock().await.insert(id.clone(), "connecting".into());
    refresh_tray_tooltip(&app, &state).await;

    let app_handle = app.clone();
    let event_id = id.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::select! {
                Some(status) = status_rx.recv() => {
                    let view = status_event(&event_id, &status);
                    if let Some(state) = app_handle.try_state::<AppState>() {
                        state.statuses.lock().await.insert(event_id.clone(), view.state.to_string());
                        refresh_tray_tooltip(&app_handle, &state).await;
                    }
                    let _ = app_handle.emit("zfrp://status", view);
                }
                Some(log) = log_rx.recv() => {
                    let _ = app_handle.emit("zfrp://log", log_payload(&event_id, &log));
                }
                else => break,
            }
        }
    });

    client.start().await;
    state.clients.lock().await.insert(id, client);
    Ok(())
}

#[tauri::command]
async fn stop_client(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<(), String> {
    let client = state.clients.lock().await.remove(&id);
    if let Some(c) = client {
        c.stop().await;
    }
    state.statuses.lock().await.remove(&id);
    refresh_tray_tooltip(&app, &state).await;
    Ok(())
}

/// 显示并聚焦主窗口（托盘左键 / 菜单「显示窗口」）
fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// 真正退出：先停掉所有客户端让服务端立刻感知离线，再退出进程
async fn quit_app(app: AppHandle) {
    if let Some(state) = app.try_state::<AppState>() {
        state.request_quit();
        let clients: Vec<_> = state.clients.lock().await.drain().map(|(_, c)| c).collect();
        for client in clients {
            client.stop().await;
        }
    }
    app.exit(0);
}

/// 构建系统托盘图标：左键显示窗口，右键菜单「显示窗口 / 退出」
fn build_tray(app: &AppHandle) -> tauri::Result<TrayIcon> {
    let show_item = MenuItem::with_id(app, MENU_SHOW, "显示主窗口", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, MENU_QUIT, "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_item, &quit_item])?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("z-frp · 未连接")
        .menu(&menu)
        // 左键留给「显示窗口」，不要弹菜单（菜单走右键）
        .show_menu_on_left_click(false);

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    builder
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(&tray.app_handle());
            }
        })
        .on_menu_event(|app, event| match event.id.as_ref() {
            MENU_SHOW => show_main_window(app),
            MENU_QUIT => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    quit_app(app).await;
                });
            }
            _ => {}
        })
        .build(app)
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let dir = app
                .path()
                .app_config_dir()
                .unwrap_or_else(|_| PathBuf::from("."));
            let settings_path = dir.join("settings.json");
            app.manage(AppState {
                clients: Mutex::new(HashMap::new()),
                statuses: Mutex::new(HashMap::new()),
                settings_path,
                quitting: AtomicBool::new(false),
            });
            build_tray(app.handle())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_version,
            get_settings,
            save_settings,
            start_client,
            stop_client
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let state = window.state::<AppState>();
                if state.is_quitting() {
                    // 真正退出（托盘退出 / 系统关机）时放行，不阻止关机流程
                    return;
                }
                // 关窗只隐藏窗口，所有客户端继续在后台跑
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("启动 z-frp 桌面客户端失败")
        .run(|app: &AppHandle, event: RunEvent| {
            if let RunEvent::ExitRequested { .. } = event {
                // 系统关机、注销等由外部触发的退出：标记退出并停掉所有客户端，
                // 不调用 prevent_exit，避免拖住关机流程
                let handle = app.clone();
                tauri::async_runtime::spawn(async move {
                    if let Some(state) = handle.try_state::<AppState>() {
                        state.request_quit();
                        let clients: Vec<_> = state.clients.lock().await.drain().map(|(_, c)| c).collect();
                        for client in clients {
                            client.stop().await;
                        }
                    }
                });
            }
        });
}
