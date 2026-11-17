//! 与 Node 端协议实现的字节级对拍测试。
//! vectors.json 由 scripts/export-vectors.mjs 从 Node dist 导出。
use frpc_core::control::{self, ClientFrame, RegisterProxy, ServerFrame};
use frpc_core::frame::{self, DataFrame};
use serde_json::Value;
use std::fs;

fn vectors() -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/vectors.json");
    fs::read_to_string(path).expect("vectors.json 不存在，请先运行 node scripts/export-vectors.mjs")
        .parse::<Value>()
        .unwrap()
}

#[test]
fn data_frames_match_node_bytes() {
    let v = vectors();
    for case in v["dataFrames"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let stream_id = case["streamId"].as_u64().unwrap() as u32;
        let flags = case["flags"].as_u64().unwrap() as u8;
        let expected = case["bytes"].as_str().unwrap();

        // 从 Node 编码结果反推 payload（去掉 8 字节头）
        let all = hex::decode(expected).unwrap();
        let payload = &all[8..];

        let encoded = frame::encode_data_frame(stream_id, payload, flags)
            .unwrap_or_else(|e| panic!("[{name}] 编码失败: {e}"));
        assert_eq!(hex::encode(&encoded), expected, "data frame [{name}] 字节不匹配");

        // 反向解码也要一致
        let decoded = frame::decode_data_frame(&all).unwrap_or_else(|| panic!("[{name}] 解码失败"));
        assert_eq!(decoded, DataFrame { stream_id, flags, payload: payload.to_vec() }, "[{name}] 解码结果不匹配");
    }
}

#[test]
fn control_frames_match_node_json() {
    let v = vectors();
    for case in v["controlFrames"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let expected: Value = serde_json::from_str(case["json"].as_str().unwrap()).unwrap();

        let actual: Value = match name {
            "hello" => {
                let key = expected["key"].as_str().unwrap().to_string();
                let s = control::encode_client_frame(&ClientFrame::Hello { v: 1, key });
                serde_json::from_str(&s).unwrap()
            }
            "config-pull" => {
                let key = expected["key"].as_str().unwrap().to_string();
                let local = expected["local"].as_str().map(|s| s.to_string());
                let s = control::encode_client_frame(&ClientFrame::ConfigPull { v: 1, key, local });
                serde_json::from_str(&s).unwrap()
            }
            "register-tcp" => {
                let src = expected["proxies"][0].as_object().unwrap();
                let p = RegisterProxy::Tcp {
                    name: src["name"].as_str().unwrap().to_string(),
                    kind: src["type"].as_str().unwrap().to_string(),
                    remote_port: src["remotePort"].as_i64().unwrap(),
                    auth_token: src["authToken"].as_str().unwrap().to_string(),
                };
                let s = control::encode_client_frame(&ClientFrame::Register { v: 1, proxies: vec![p] });
                serde_json::from_str(&s).unwrap()
            }
            "heartbeat" => {
                let at = expected["at"].as_i64().unwrap();
                let s = control::encode_client_frame(&ClientFrame::Heartbeat { v: 1, at });
                serde_json::from_str(&s).unwrap()
            }
            other => panic!("未知向量: {other}"),
        };
        assert_eq!(actual, expected, "control frame [{name}] JSON 不匹配");
    }
}

#[test]
fn server_frames_decode_node_shapes() {
    // 直接拿服务端实际会发的 JSON 形状，确认 ServerFrame 能正确解析
    let samples = [
        r#"{"v":1,"type":"hello-ok","clientId":"t_1","heartbeatIntervalMs":30000}"#,
        r#"{"v":1,"type":"hello-reject","reason":"key 无效"}"#,
        r#"{"v":1,"type":"config-push","tunnelId":"t_1","clientId":"t_1","proxies":[{"name":"web","type":"http","host":"demo.test.local","local":"http://127.0.0.1:19090"}]}"#,
        r#"{"v":1,"type":"register-ok","rejected":[{"name":"x","reason":"占用"}]}"#,
        r#"{"v":1,"type":"stream-open","streamId":5,"proxyName":"web","req":{"method":"GET","path":"/","host":"demo.test.local","headers":{"accept":"*/*"}}}"#,
        r#"{"v":1,"type":"heartbeat-ack","at":1700000000000}"#,
        r#"{"v":1,"type":"error","reason":"x","streamId":9}"#,
    ];
    for raw in samples {
        let frame = control::decode_server_frame(raw)
            .unwrap_or_else(|| panic!("无法解析: {raw}"));
        assert!(frame != ServerFrame::Other, "被误判为 Other: {raw}");
    }
}
