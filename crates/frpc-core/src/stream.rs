//! 本地代理流：每个 stream 一个 tokio task，连接本地服务并双向转发。
//! 所有 stream 共享同一条 WS 写端（Arc<Mutex>），对应 Node 的单连接多路复用。
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use futures_util::{stream, SinkExt};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, Mutex};
use tokio_tungstenite::tungstenite::Message;

use crate::control::{encode_client_frame, ClientFrame, HttpRequestMeta};
use crate::frame::{encode_data_frame, DataFrame, FLAG_FIN, FLAG_RST, MAX_PAYLOAD};

type WsSink = futures_util::stream::SplitSink<
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    Message,
>;

/// 共享的 WS 写端。所有 stream task 通过它发数据帧/控制帧。
#[derive(Clone)]
pub struct WsWriter {
    sink: Arc<Mutex<WsSink>>,
}

impl WsWriter {
    pub fn new(sink: WsSink) -> Self {
        Self { sink: Arc::new(Mutex::new(sink)) }
    }

    /// 直接访问底层 sink（用于发送控制帧 / Pong）。
    pub async fn sink_lock(&self) -> tokio::sync::MutexGuard<'_, WsSink> {
        self.sink.lock().await
    }

    pub async fn send_frame(&self, frame: DataFrame) {
        match encode_data_frame(frame.stream_id, &frame.payload, frame.flags) {
            Ok(bytes) => {
                let mut sink = self.sink.lock().await;
                if let Err(e) = sink.send(Message::Binary(bytes.into())).await {
                    eprintln!("[WARN] 发送数据包失败: {e}");
                }
            }
            Err(e) => eprintln!("[WARN] 编码数据包失败: {e}"),
        }
    }

    pub async fn send_data(&self, stream_id: u32, payload: &[u8]) {
        for chunk in payload.chunks(MAX_PAYLOAD) {
            self.send_frame(DataFrame { stream_id, flags: 0, payload: chunk.to_vec() }).await;
        }
    }

    pub async fn send_fin(&self, stream_id: u32) {
        self.send_frame(DataFrame { stream_id, flags: FLAG_FIN, payload: vec![] }).await;
    }

    pub async fn send_rst(&self, stream_id: u32, reason: &str) {
        let mut payload = reason.as_bytes().to_vec();
        payload.truncate(MAX_PAYLOAD);
        self.send_frame(DataFrame { stream_id, flags: FLAG_RST, payload }).await;
    }

    pub async fn send_head(&self, stream_id: u32, status_code: u16, headers: HashMap<String, String>) {
        let frame = ClientFrame::StreamHead { v: 1, stream_id, status_code, headers };
        let mut sink = self.sink.lock().await;
        if let Err(e) = sink.send(Message::Text(encode_client_frame(&frame).into())).await {
            eprintln!("[WARN] 发送 stream-head 失败: {e}");
        }
    }

    pub async fn send_close_ws(&self) {
        let mut sink = self.sink.lock().await;
        let _ = sink.send(Message::Close(None)).await;
    }
}

/// 管理所有活跃 stream 的 sender。
pub struct StreamRegistry {
    senders: HashMap<u32, mpsc::Sender<DataFrame>>,
}

impl StreamRegistry {
    pub fn new() -> Self {
        Self { senders: HashMap::new() }
    }
    pub fn register(&mut self, stream_id: u32, sender: mpsc::Sender<DataFrame>) {
        self.senders.insert(stream_id, sender);
    }
    pub fn get(&self, id: u32) -> Option<&mpsc::Sender<DataFrame>> {
        self.senders.get(&id)
    }
    pub fn remove(&mut self, id: u32) {
        self.senders.remove(&id);
    }
    pub fn clear(&mut self) {
        self.senders.clear();
    }
    pub fn count(&self) -> usize {
        self.senders.len()
    }
}

/// 启动 TCP stream：连本地 host:port，双向转发。sender 供主循环投递 frps 数据。
pub fn spawn_tcp_stream(
    writer: WsWriter,
    registry: Arc<Mutex<StreamRegistry>>,
    stream_id: u32,
    host: String,
    port: u16,
) -> mpsc::Sender<DataFrame> {
    let (tx, mut rx) = mpsc::channel::<DataFrame>(256);
    tokio::spawn(async move {
        let socket = match TcpStream::connect((host.as_str(), port)).await {
            Ok(s) => s,
            Err(e) => {
                writer.send_rst(stream_id, &format!("连接本地 TCP 失败: {e}")).await;
                registry.lock().await.remove(stream_id);
                return;
            }
        };
        let (mut local_read, mut local_write) = socket.into_split();

        // 本地 → frps：独立 task，读到 EOF 发 FIN
        let writer_read = writer.clone();
        let mut read_task = tokio::spawn(async move {
            let mut buf = vec![0u8; MAX_PAYLOAD];
            loop {
                match local_read.read(&mut buf).await {
                    Ok(0) => {
                        writer_read.send_fin(stream_id).await;
                        break;
                    }
                    Ok(n) => writer_read.send_data(stream_id, &buf[..n]).await,
                    Err(e) => {
                        writer_read.send_rst(stream_id, &format!("读本地 TCP 失败: {e}")).await;
                        break;
                    }
                }
            }
        });

        // frps → 本地：主 task 从 rx 收数据帧
        // FIN 表示对端不再发送数据，但本地可能还有数据要回传（半关闭），
        // 因此只 shutdown 写端，再等本地读端自然结束。
        while let Some(frame) = rx.recv().await {
            if !frame.payload.is_empty() {
                if let Err(e) = local_write.write_all(&frame.payload).await {
                    writer.send_rst(stream_id, &format!("写本地 TCP 失败: {e}")).await;
                    break;
                }
            }
            if frame.flags & FLAG_RST != 0 {
                let _ = local_write.shutdown().await;
                break;
            }
            if frame.flags & FLAG_FIN != 0 {
                let _ = local_write.shutdown().await;
                // 给本地回传留出窗口，避免直接 abort 丢掉尾部数据
                let _ = tokio::time::timeout(std::time::Duration::from_secs(30), &mut read_task).await;
                break;
            }
        }

        read_task.abort();
        registry.lock().await.remove(stream_id);
    });
    tx
}

/// 启动 HTTP stream：按 req.meta 请求本地服务，转发响应。
pub fn spawn_http_stream(
    writer: WsWriter,
    registry: Arc<Mutex<StreamRegistry>>,
    stream_id: u32,
    local_base: &str,
    meta: &HttpRequestMeta,
) -> mpsc::Sender<DataFrame> {
    let (tx, rx) = mpsc::channel::<DataFrame>(256);
    let writer_http = writer.clone();
    let local = local_base.to_string();
    let request_meta = meta.clone();

    tokio::spawn(async move {
        // 构造完整 URL：new URL(path, target) 语义
        let url = match url::Url::parse(&request_meta.path)
            .or_else(|_| url::Url::parse(&local).and_then(|base| base.join(&request_meta.path)))
        {
            Ok(u) => u,
            Err(e) => {
                writer_http.send_rst(stream_id, &format!("本地 URL 非法: {e}")).await;
                registry.lock().await.remove(stream_id);
                return;
            }
        };

        let method = match reqwest::Method::from_bytes(request_meta.method.as_bytes()) {
            Ok(m) => m,
            Err(e) => {
                writer_http.send_rst(stream_id, &format!("HTTP method 非法: {e}")).await;
                registry.lock().await.remove(stream_id);
                return;
            }
        };

        // 复制请求头，删除 hop-by-hop（与 Node 端一致）
        let mut headers = HeaderMap::new();
        for (k, v) in &request_meta.headers {
            let lower = k.to_ascii_lowercase();
            if lower == "host" || lower == "connection" || lower == "transfer-encoding" {
                continue;
            }
            if let (Ok(name), Ok(value)) = (
                HeaderName::from_bytes(k.as_bytes()),
                HeaderValue::from_str(v),
            ) {
                headers.insert(name, value);
            }
        }

        // 请求体：边收边发，不再攒满整个 body。
        // 大请求（AI 的长 prompt、图片 base64）以前会整段缓冲在这里，上游要等最后一个字节才开始处理。
        let rst_seen = Arc::new(AtomicBool::new(false));
        let rst_flag = rst_seen.clone();
        let body_stream = stream::unfold(
            (rx, false),
            move |(mut rx, done): (mpsc::Receiver<DataFrame>, bool)| {
                let rst_flag = rst_flag.clone();
                async move {
                    if done {
                        return None;
                    }
                    loop {
                        let frame = rx.recv().await?;
                        if frame.flags & FLAG_RST != 0 {
                            rst_flag.store(true, Ordering::Relaxed);
                            return None;
                        }
                        let fin = frame.flags & FLAG_FIN != 0;
                        if !frame.payload.is_empty() {
                            let chunk = Ok::<_, std::io::Error>(bytes::Bytes::from(frame.payload));
                            return Some((chunk, (rx, fin)));
                        }
                        if fin {
                            return None;
                        }
                    }
                }
            },
        );

        // 构建 client：关闭自动解压，保持 body 原样（关键：reqwest 默认 gzip 会改 body）
        let client = reqwest::Client::builder()
            .no_gzip()
            .no_brotli()
            .no_deflate()
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());

        let response = client
            .request(method, url)
            .headers(headers)
            .body(reqwest::Body::wrap_stream(body_stream))
            .send()
            .await;

        if rst_seen.load(Ordering::Relaxed) {
            registry.lock().await.remove(stream_id);
            return;
        }

        let response = match response {
            Ok(r) => r,
            Err(e) => {
                writer_http.send_rst(stream_id, &format!("请求本地服务失败: {e}")).await;
                registry.lock().await.remove(stream_id);
                return;
            }
        };

        // 回写响应头
        let status = response.status().as_u16();
        let mut resp_headers = HashMap::new();
        for (k, v) in response.headers().iter() {
            resp_headers.insert(
                k.as_str().to_string(),
                v.to_str().unwrap_or("").to_string(),
            );
        }
        writer_http.send_head(stream_id, status, resp_headers).await;

        // 回写响应体（分块）
        let mut body_stream = response;
        loop {
            match body_stream.chunk().await {
                Ok(Some(chunk)) => writer_http.send_data(stream_id, &chunk).await,
                Ok(None) => break,
                Err(e) => {
                    writer_http.send_rst(stream_id, &format!("读取响应失败: {e}")).await;
                    break;
                }
            }
        }
        writer_http.send_fin(stream_id).await;
        registry.lock().await.remove(stream_id);
    });
    tx
}
