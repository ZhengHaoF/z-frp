// z-frp 桌面客户端：Tauri 外壳，把 frpc-core 的状态/日志事件桥接到前端。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::sync::Arc;

use frpc_core::{ClientOptions, ClientStatus, ConnState, FrpcClient, LogEvent, LogLevel, ProxySpec};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::Mutex;

/// 持久化到 app_config_dir/settings.json 的用户设置
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Settings {
    #[serde(default)]
    key: String,
    #[serde(default)]
    server: String,
    #[serde(default)]
    local: String,
    #[serde(default = "default_true")]
    remember: bool,
    #[serde(default)]
    auto_connect: bool,
}

fn default_true() -> bool {
    true
}

impl Settings {
    fn sanitized(mut self) -> Self {
        if self.server.trim().is_empty() {
            self.server = "wss://frp.infocloud.top/_frp".into();
        }
        self
    }
}

struct AppState {
    client: Mutex<Option<Arc<FrpcClient>>>,
    settings_path: PathBuf,
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
    state: &'static str,
    tunnel_id: Option<String>,
    client_id: Option<String>,
    proxies: Vec<ProxyView>,
    error: Option<String>,
    since: Option<i64>,
}

#[derive(Serialize, Clone)]
struct LogPayload {
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

fn status_event(s: &ClientStatus) -> StatusEvent {
    let state = match s.state {
        ConnState::Disconnected => "offline",
        ConnState::Connecting => "connecting",
        ConnState::Online => "online",
        ConnState::Reconnecting => "reconnecting",
    };
    StatusEvent {
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

fn log_payload(e: &LogEvent) -> LogPayload {
    LogPayload {
        level: match e.level {
            LogLevel::Info => "info",
            LogLevel::Warn => "warn",
            LogLevel::Error => "error",
        },
        message: e.message.clone(),
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
    let mut settings = settings;
    if !settings.remember {
        // 不记住 key 时，自动连接也失去意义
        settings.key = String::new();
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
    key: String,
    server: String,
    local: Option<String>,
) -> Result<(), String> {
    let key = key.trim().to_string();
    if key.is_empty() {
        return Err("请先填入隧道 Key".into());
    }
    let server = server.trim().to_string();
    if !(server.starts_with("ws://") || server.starts_with("wss://")) {
        return Err("服务端地址需以 ws:// 或 wss:// 开头".into());
    }
    let local = local.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());

    // 已有连接先停掉，避免同 key 双连接
    {
        let mut guard = state.client.lock().await;
        if let Some(old) = guard.take() {
            old.stop().await;
        }
    }

    let (client, mut status_rx, mut log_rx) = FrpcClient::new(ClientOptions { key, server, local });
    let client = Arc::new(client);

    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::select! {
                Some(status) = status_rx.recv() => {
                    let _ = app_handle.emit("zfrp://status", status_event(&status));
                }
                Some(log) = log_rx.recv() => {
                    let _ = app_handle.emit("zfrp://log", log_payload(&log));
                }
                else => break,
            }
        }
    });

    client.start().await;
    *state.client.lock().await = Some(client);
    Ok(())
}

#[tauri::command]
async fn stop_client(state: State<'_, AppState>) -> Result<(), String> {
    let client = state.client.lock().await.take();
    if let Some(c) = client {
        c.stop().await;
    }
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let dir = app
                .path()
                .app_config_dir()
                .unwrap_or_else(|_| PathBuf::from("."));
            let settings_path = dir.join("settings.json");
            app.manage(AppState { client: Mutex::new(None), settings_path });
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
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                // 关窗时尽力停掉客户端，避免残留连接
                let app = window.app_handle().clone();
                tauri::async_runtime::spawn(async move {
                    let state = app.state::<AppState>();
                    let client = state.client.lock().await.take();
                    if let Some(c) = client {
                        c.stop().await;
                    }
                });
            }
        })
        .run(tauri::generate_context!())
        .expect("启动 z-frp 桌面客户端失败");
}
