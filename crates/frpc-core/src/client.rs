//! frpc 连接状态机：connect → hello → config-pull → register → 心跳/数据。
//! 断线指数退避重连，重连后重走完整握手。
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, Mutex};
use tokio::task::JoinHandle;
use tokio::time::{interval, Instant};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};
use url::Url;

use crate::control::{decode_server_frame, encode_client_frame, ClientFrame, ProxySpec, RegisterProxy, ServerFrame};
use crate::frame::decode_data_frame;
use crate::stream::{spawn_http_stream, spawn_tcp_stream, StreamRegistry, WsWriter};

pub const TUNNEL_PATH: &str = "/_frp";
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_BACKOFF: Duration = Duration::from_secs(30);
const RECONNECT_BASE: Duration = Duration::from_secs(1);

#[derive(Debug, Clone)]
pub struct ClientOptions {
    pub key: String,
    pub server: String,
    /// 本地覆盖地址：HTTP 用 URL，TCP 用 host:port
    pub local: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnState {
    Disconnected,
    Connecting,
    Online,
    Reconnecting,
}

impl ConnState {
    pub fn label(&self) -> &'static str {
        match self {
            ConnState::Disconnected => "offline",
            ConnState::Connecting => "connecting",
            ConnState::Online => "online",
            ConnState::Reconnecting => "reconnecting",
        }
    }
}

#[derive(Debug, Clone)]
pub struct ClientStatus {
    pub state: ConnState,
    pub tunnel_id: Option<String>,
    pub client_id: Option<String>,
    pub proxies: Vec<ProxySpec>,
    pub last_error: Option<String>,
}

impl Default for ClientStatus {
    fn default() -> Self {
        Self {
            state: ConnState::Disconnected,
            tunnel_id: None,
            client_id: None,
            proxies: Vec::new(),
            last_error: None,
        }
    }
}

#[derive(Debug, Clone)]
pub enum LogLevel {
    Info,
    Warn,
    Error,
}

#[derive(Debug, Clone)]
pub struct LogEvent {
    pub level: LogLevel,
    pub message: String,
}

type WsStream = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// 一个隧道客户端实例。可 new 多个，由上层（CLI/Tauri）管理。
pub struct FrpcClient {
    opts: ClientOptions,
    status_tx: mpsc::Sender<ClientStatus>,
    log_tx: mpsc::Sender<LogEvent>,
    stop_tx: tokio::sync::watch::Sender<bool>,
    task: Mutex<Option<JoinHandle<()>>>,
}

impl FrpcClient {
    pub fn new(opts: ClientOptions) -> (Self, mpsc::Receiver<ClientStatus>, mpsc::Receiver<LogEvent>) {
        let (status_tx, status_rx) = mpsc::channel(16);
        let (log_tx, log_rx) = mpsc::channel(256);
        let (stop_tx, _) = tokio::sync::watch::channel(false);
        let client = Self {
            opts,
            status_tx,
            log_tx,
            stop_tx,
            task: Mutex::new(None),
        };
        (client, status_rx, log_rx)
    }

    pub async fn start(self: &Arc<Self>) {
        let mut guard = self.task.lock().await;
        if guard.is_some() {
            return;
        }
        let this = Arc::clone(self);
        let handle = tokio::spawn(async move { this.run().await; });
        *guard = Some(handle);
    }

    pub async fn stop(&self) {
        let _ = self.stop_tx.send(true);
        let handle = self.task.lock().await.take();
        if let Some(h) = handle {
            h.abort();
        }
        let mut status = ClientStatus::default();
        status.state = ConnState::Disconnected;
        let _ = self.status_tx.send(status).await;
    }

    async fn emit(&self, state: ConnState, tunnel_id: Option<String>, client_id: Option<String>, proxies: Vec<ProxySpec>, err: Option<String>) {
        let _ = self.status_tx.send(ClientStatus {
            state,
            tunnel_id,
            client_id,
            proxies,
            last_error: err,
        }).await;
    }

    async fn log(&self, level: LogLevel, msg: impl Into<String>) {
        let _ = self.log_tx.send(LogEvent { level, message: msg.into() }).await;
    }

    fn server_url(&self) -> Result<String, String> {
        let mut url = Url::parse(&self.opts.server).map_err(|e| format!("server 地址非法: {e}"))?;
        if url.path().is_empty() || url.path() == "/" {
            url.set_path(TUNNEL_PATH);
        }
        Ok(url.to_string())
    }

    async fn run(self: Arc<Self>) {
        let url = match self.server_url() {
            Ok(u) => u,
            Err(e) => {
                self.log(LogLevel::Error, e.clone()).await;
                self.emit(ConnState::Disconnected, None, None, vec![], Some(e)).await;
                return;
            }
        };

        let mut attempt = 0u32;
        let mut stop_rx = self.stop_tx.subscribe();
        let was_online = Arc::new(AtomicBool::new(false));

        loop {
            if *stop_rx.borrow() {
                break;
            }
            self.emit(ConnState::Connecting, None, None, vec![], None).await;
            self.log(LogLevel::Info, format!("连接 frps：{url}（第 {} 次）", attempt + 1)).await;

            match self.connect_once(&url, &mut stop_rx, &was_online).await {
                Ok(()) => {
                    // 正常结束（被 stop）
                    break;
                }
                Err(e) => {
                    self.log(LogLevel::Warn, format!("连接中断：{e}")).await;
                    // 本次连接曾成功上线过，说明网络/服务端恢复能力正常，退避计数归零
                    if was_online.swap(false, Ordering::SeqCst) {
                        attempt = 0;
                    }
                    let delay = RECONNECT_BASE
                        .checked_mul(1u32 << attempt.min(5))
                        .unwrap_or(MAX_BACKOFF)
                        .min(MAX_BACKOFF);
                    attempt = attempt.saturating_add(1);
                    self.emit(ConnState::Reconnecting, None, None, vec![], Some(e)).await;
                    tokio::select! {
                        _ = tokio::time::sleep(delay) => {}
                        _ = stop_rx.changed() => break,
                    }
                }
            }
        }
    }

    /// 发送一个客户端控制帧（统一走共享写端）。
    async fn send_control(writer: &WsWriter, frame: ClientFrame) -> Result<(), String> {
        let text = encode_client_frame(&frame);
        let mut sink = writer.sink_lock().await;
        sink.send(Message::Text(text.into())).await
            .map_err(|e| format!("发送控制帧失败: {e}"))
    }

    /// 单次连接：握手 + 注册 + 数据循环。返回 Err 表示需要重连。
    async fn connect_once(
        &self,
        url: &str,
        stop_rx: &mut tokio::sync::watch::Receiver<bool>,
        was_online: &AtomicBool,
    ) -> Result<(), String> {
        let (ws, _resp) = connect_async(url).await.map_err(|e| format!("WebSocket 连接失败: {e}"))?;
        let (write, mut read): (futures_util::stream::SplitSink<WsStream, Message>, _) = ws.split();
        let writer = WsWriter::new(write);

        // 握手第一步：连接建立后立即发 hello（对应 Node 的 ws.on("open")）
        Self::send_control(&writer, ClientFrame::Hello { v: 1, key: self.opts.key.clone() }).await?;

        let mut authenticated = false;
        let handshake_deadline = Instant::now() + HANDSHAKE_TIMEOUT;
        let mut heartbeat_interval = Duration::from_millis(30_000);
        let mut heartbeat_timer = interval(heartbeat_interval);
        heartbeat_timer.tick().await;
        let mut last_ack = Instant::now();
        let mut proxies: Vec<ProxySpec> = Vec::new();
        let mut tunnel_id: Option<String> = None;
        let mut client_id: Option<String> = None;
        let registry = Arc::new(Mutex::new(StreamRegistry::new()));

        loop {
            if *stop_rx.borrow() {
                writer.send_close_ws().await;
                registry.lock().await.clear();
                return Ok(());
            }

            if !authenticated && Instant::now() >= handshake_deadline {
                return Err("握手超时（10s 未完成认证）".into());
            }

            tokio::select! {
                _ = stop_rx.changed() => {
                    writer.send_close_ws().await;
                    registry.lock().await.clear();
                    return Ok(());
                }

                _ = heartbeat_timer.tick(), if authenticated => {
                    if Instant::now().duration_since(last_ack) > heartbeat_interval * 4 {
                        return Err("心跳长时间无响应，主动重连".into());
                    }
                    let _ = Self::send_control(&writer, ClientFrame::Heartbeat { v: 1, at: now_millis() }).await;
                }

                msg = read.next() => {
                    let msg = match msg {
                        Some(Ok(m)) => m,
                        Some(Err(e)) => return Err(format!("WebSocket 错误: {e}")),
                        None => return Err("连接被服务端关闭".into()),
                    };
                    match msg {
                        Message::Text(text) => {
                            let frame = match decode_server_frame(&text) {
                                Some(f) => f,
                                None => {
                                    self.log(LogLevel::Warn, format!("忽略无法解析的控制帧: {text}")).await;
                                    continue;
                                }
                            };
                            match frame {
                                ServerFrame::HelloOk { client_id: cid, heartbeat_interval_ms, .. } => {
                                    authenticated = true;
                                    client_id = Some(cid.clone());
                                    heartbeat_interval = Duration::from_millis(heartbeat_interval_ms);
                                    heartbeat_timer = interval(heartbeat_interval);
                                    heartbeat_timer.tick().await;
                                    last_ack = Instant::now();
                                    self.log(LogLevel::Info, format!("认证通过，clientId={cid}")).await;
                                    Self::send_control(&writer, ClientFrame::ConfigPull {
                                        v: 1,
                                        key: self.opts.key.clone(),
                                        local: self.opts.local.clone(),
                                    }).await?;
                                }
                                ServerFrame::HelloReject { reason, .. } => {
                                    return Err(format!("认证被拒: {reason}"));
                                }
                                ServerFrame::ConfigPush { tunnel_id: tid, client_id: cid, proxies: ps, .. } => {
                                    tunnel_id = Some(tid.clone());
                                    client_id = Some(cid.clone());
                                    proxies = ps;
                                    self.log(LogLevel::Info, format!("已获取隧道配置：tunnelId={tid}，代理数={}", proxies.len())).await;
                                    let reg_proxies: Vec<RegisterProxy> = proxies.iter().map(RegisterProxy::from).collect();
                                    Self::send_control(&writer, ClientFrame::Register { v: 1, proxies: reg_proxies }).await?;
                                }
                                ServerFrame::ConfigReject { reason, .. } => {
                                    return Err(format!("配置拉取被拒: {reason}"));
                                }
                                ServerFrame::RegisterOk { rejected, .. } => {
                                    was_online.store(true, Ordering::SeqCst);
                                    if rejected.is_empty() {
                                        self.log(LogLevel::Info, format!("全部代理注册成功（{}）", proxies.len())).await;
                                        self.emit(ConnState::Online, tunnel_id.clone(), client_id.clone(), proxies.clone(), None).await;
                                    } else {
                                        let reasons: Vec<String> = rejected.iter().map(|r| format!("{}: {}", r.name, r.reason)).collect();
                                        self.log(LogLevel::Warn, format!("部分代理注册被拒：{}", reasons.join("；"))).await;
                                        self.emit(ConnState::Online, tunnel_id.clone(), client_id.clone(), proxies.clone(), Some(reasons.join("; "))).await;
                                    }
                                }
                                ServerFrame::RegisterReject { reason, .. } => {
                                    return Err(format!("注册被拒: {reason}"));
                                }
                                ServerFrame::HeartbeatAck { .. } => {
                                    last_ack = Instant::now();
                                }
                                ServerFrame::StreamOpen { stream_id, proxy_name, req, .. } => {
                                    let proxy = proxies.iter().find(|p| p.name() == proxy_name).cloned();
                                    let sender = match proxy {
                                        Some(ProxySpec::Tcp(t)) => {
                                            self.log(LogLevel::Info, format!("打开 TCP stream id={stream_id} → {}:{}", t.local_host, t.local_port)).await;
                                            Some(spawn_tcp_stream(writer.clone(), registry.clone(), stream_id, t.local_host.clone(), t.local_port))
                                        }
                                        Some(ProxySpec::Http(h)) => {
                                            if let Some(meta) = &req {
                                                self.log(LogLevel::Info, format!("打开 HTTP stream id={stream_id} → {}", h.local)).await;
                                                Some(spawn_http_stream(writer.clone(), registry.clone(), stream_id, &h.local, meta))
                                            } else {
                                                self.log(LogLevel::Warn, format!("HTTP stream id={stream_id} 缺少请求元信息")).await;
                                                None
                                            }
                                        }
                                        None => {
                                            self.log(LogLevel::Warn, format!("未知代理: {proxy_name}")).await;
                                            None
                                        }
                                    };
                                    if let Some(sender) = sender {
                                        registry.lock().await.register(stream_id, sender);
                                    }
                                }
                                ServerFrame::Error { reason, .. } => {
                                    self.log(LogLevel::Warn, format!("frps 报错: {reason}")).await;
                                }
                                ServerFrame::Other => {}
                            }
                        }
                        Message::Binary(raw) => {
                            if let Some(frame) = decode_data_frame(&raw) {
                                let sid = frame.stream_id;
                                let sender = registry.lock().await.get(sid).cloned();
                                if let Some(sender) = sender {
                                    if sender.send(frame).await.is_err() {
                                        registry.lock().await.remove(sid);
                                    }
                                }
                            }
                        }
                        Message::Ping(payload) => {
                            writer.sink_lock().await.send(Message::Pong(payload)).await.ok();
                        }
                        Message::Pong(_) => {
                            last_ack = Instant::now();
                        }
                        Message::Close(_) => {
                            return Err("服务端关闭连接".into());
                        }
                        _ => {}
                    }
                }
            }
        }
    }
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
