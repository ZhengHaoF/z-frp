//! 控制帧（WebSocket text message）类型与编解码。
//! 与 Node 端 packages/shared/src/protocol.ts 逐字段兼容：JSON 顶层统一含 v=1。
use serde::{Deserialize, Serialize};

pub const PROTOCOL_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HttpProxy {
    pub name: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub host: String,
    pub local: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TcpProxy {
    pub name: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub remote_port: i64,
    pub local_host: String,
    pub local_port: u16,
    pub auth_token: String,
}

/// 代理描述：HTTP 与 TCP 字段不同，用 untagged 枚举按 type 判别。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(untagged)]
pub enum ProxySpec {
    Http(HttpProxy),
    Tcp(TcpProxy),
}

impl ProxySpec {
    pub fn name(&self) -> &str {
        match self {
            ProxySpec::Http(p) => &p.name,
            ProxySpec::Tcp(p) => &p.name,
        }
    }
    pub fn is_http(&self) -> bool {
        matches!(self, ProxySpec::Http(_))
    }
}

/// 客户端注册时只发必要字段（与 Node client.ts register() 一致）。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(untagged, rename_all_fields = "camelCase")]
pub enum RegisterProxy {
    Http {
        name: String,
        #[serde(rename = "type")]
        kind: String,
        host: String,
    },
    Tcp {
        name: String,
        #[serde(rename = "type")]
        kind: String,
        remote_port: i64,
        auth_token: String,
    },
}

impl From<&ProxySpec> for RegisterProxy {
    fn from(p: &ProxySpec) -> Self {
        match p {
            ProxySpec::Http(h) => RegisterProxy::Http {
                name: h.name.clone(),
                kind: h.kind.clone(),
                host: h.host.clone(),
            },
            ProxySpec::Tcp(t) => RegisterProxy::Tcp {
                name: t.name.clone(),
                kind: t.kind.clone(),
                remote_port: t.remote_port,
                auth_token: t.auth_token.clone(),
            },
        }
    }
}

// ---------- 控制帧 ----------
// 用 serde(untagged) 按 type 字段分发到具体结构，每个结构都带 v 字段。

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HelloFrame {
    pub v: u32,
    #[serde(rename = "type")]
    pub kind: String,
    pub key: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct HelloOkFrame {
    pub v: u32,
    #[serde(rename = "type")]
    pub kind: String,
    pub client_id: String,
    pub heartbeat_interval_ms: u64,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct RejectFrame {
    pub v: u32,
    #[serde(rename = "type")]
    pub kind: String,
    pub reason: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct ConfigPushFrame {
    pub v: u32,
    #[serde(rename = "type")]
    pub kind: String,
    pub tunnel_id: String,
    pub client_id: String,
    pub proxies: Vec<ProxySpec>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct StreamOpenFrame {
    pub v: u32,
    #[serde(rename = "type")]
    pub kind: String,
    pub stream_id: u32,
    pub proxy_name: String,
    pub req: Option<HttpRequestMeta>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct HttpRequestMeta {
    pub method: String,
    pub path: String,
    pub host: String,
    pub headers: std::collections::HashMap<String, String>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct HeartbeatAckFrame {
    pub v: u32,
    #[serde(rename = "type")]
    pub kind: String,
    pub at: i64,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct ErrorFrame {
    pub v: u32,
    #[serde(rename = "type")]
    pub kind: String,
    pub reason: String,
    pub stream_id: Option<u32>,
}

/// 服务端下发的控制帧。未知 type 归入 Other（对应 Node 的容错忽略）。
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum ServerFrame {
    HelloOk {
        v: u32,
        client_id: String,
        heartbeat_interval_ms: u64,
    },
    HelloReject {
        v: u32,
        reason: String,
    },
    ConfigPush {
        v: u32,
        tunnel_id: String,
        client_id: String,
        proxies: Vec<ProxySpec>,
    },
    ConfigReject {
        v: u32,
        reason: String,
    },
    RegisterOk {
        v: u32,
        rejected: Vec<RejectedProxy>,
    },
    RegisterReject {
        v: u32,
        reason: String,
    },
    StreamOpen {
        v: u32,
        stream_id: u32,
        proxy_name: String,
        #[serde(default)]
        req: Option<HttpRequestMeta>,
    },
    HeartbeatAck {
        v: u32,
        at: i64,
    },
    Error {
        v: u32,
        #[serde(default)]
        reason: String,
        #[serde(default)]
        stream_id: Option<u32>,
    },
    #[serde(other)]
    Other,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct RejectedProxy {
    pub name: String,
    pub reason: String,
}

/// 客户端发给服务端的控制帧。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum ClientFrame {
    Hello {
        v: u32,
        key: String,
    },
    ConfigPull {
        v: u32,
        key: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        local: Option<String>,
    },
    Register {
        v: u32,
        proxies: Vec<RegisterProxy>,
    },
    StreamHead {
        v: u32,
        stream_id: u32,
        status_code: u16,
        headers: std::collections::HashMap<String, String>,
    },
    Heartbeat {
        v: u32,
        at: i64,
    },
}

/// 解码服务端控制帧；JSON 畸形或版本不符返回 None。
pub fn decode_server_frame(raw: &str) -> Option<ServerFrame> {
    let frame: ServerFrame = serde_json::from_str(raw).ok()?;
    // 校验 v=1：Other 帧没有 v 字段，放行
    match &frame {
        ServerFrame::Other => Some(frame),
        _ => {
            let v = match &frame {
                ServerFrame::HelloOk { v, .. }
                | ServerFrame::HelloReject { v, .. }
                | ServerFrame::ConfigPush { v, .. }
                | ServerFrame::ConfigReject { v, .. }
                | ServerFrame::RegisterOk { v, .. }
                | ServerFrame::RegisterReject { v, .. }
                | ServerFrame::StreamOpen { v, .. }
                | ServerFrame::HeartbeatAck { v, .. }
                | ServerFrame::Error { v, .. } => *v,
                ServerFrame::Other => unreachable!(),
            };
            if v == PROTOCOL_VERSION { Some(frame) } else { None }
        }
    }
}

/// 编码客户端控制帧为 JSON 字符串。
pub fn encode_client_frame(frame: &ClientFrame) -> String {
    serde_json::to_string(frame).expect("ClientFrame 序列化不会失败")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_hello_matches_node() {
        // Node: {v:1, type:"hello", key:"abc"}  —— JSON 字段顺序无关，逐个字段比对
        let s = encode_client_frame(&ClientFrame::Hello { v: 1, key: "abc".into() });
        let obj: serde_json::Value = serde_json::from_str(&s).unwrap();
        assert_eq!(obj["v"], 1);
        assert_eq!(obj["type"], "hello");
        assert_eq!(obj["key"], "abc");
    }

    #[test]
    fn encode_config_pull_omits_local_when_none() {
        let s = encode_client_frame(&ClientFrame::ConfigPull {
            v: 1,
            key: "k".into(),
            local: None,
        });
        let obj: serde_json::Value = serde_json::from_str(&s).unwrap();
        assert_eq!(obj["type"], "config-pull");
        assert!(obj.get("local").is_none());
    }

    #[test]
    fn encode_register_uses_remote_port_field() {
        let p = RegisterProxy::Tcp {
            name: "db".into(),
            kind: "tcp".into(),
            remote_port: 33061,
            auth_token: "tok".into(),
        };
        let s = encode_client_frame(&ClientFrame::Register {
            v: 1,
            proxies: vec![p],
        });
        let obj: serde_json::Value = serde_json::from_str(&s).unwrap();
        let arr = obj["proxies"].as_array().unwrap();
        assert_eq!(arr[0]["remotePort"], 33061);
        assert_eq!(arr[0]["authToken"], "tok");
    }

    #[test]
    fn decode_config_push_with_http_proxy() {
        let raw = r#"{"v":1,"type":"config-push","tunnelId":"t_1","clientId":"t_1","proxies":[{"name":"web","type":"http","host":"demo.test.local","local":"http://127.0.0.1:19090"}]}"#;
        let frame = decode_server_frame(raw).unwrap();
        match frame {
            ServerFrame::ConfigPush { tunnel_id, proxies, .. } => {
                assert_eq!(tunnel_id, "t_1");
                assert_eq!(proxies.len(), 1);
                assert!(proxies[0].is_http());
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn decode_config_push_with_tcp_proxy() {
        let raw = r#"{"v":1,"type":"config-push","tunnelId":"t_2","clientId":"t_2","proxies":[{"name":"db","type":"tcp","remotePort":19091,"localHost":"127.0.0.1","localPort":19092,"authToken":"tok"}]}"#;
        let frame = decode_server_frame(raw).unwrap();
        match frame {
            ServerFrame::ConfigPush { proxies, .. } => match &proxies[0] {
                ProxySpec::Tcp(t) => {
                    assert_eq!(t.remote_port, 19091);
                    assert_eq!(t.local_port, 19092);
                }
                other => panic!("unexpected: {other:?}"),
            },
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn decode_rejects_wrong_version() {
        let raw = r#"{"v":2,"type":"hello-ok","clientId":"c","heartbeatIntervalMs":30000}"#;
        assert!(decode_server_frame(raw).is_none());
    }

    #[test]
    fn decode_unknown_type_is_ignored() {
        let raw = r#"{"v":1,"type":"stats","bytes":123}"#;
        assert_eq!(decode_server_frame(raw), Some(ServerFrame::Other));
    }
}
