//! z-frp Rust 客户端命令行入口。
//! 用法: zfrpc -key <key> [-server <wss://...>] [-local <addr>]
use std::env;
use std::sync::Arc;

use frpc_core::{ClientOptions, ConnState, FrpcClient, LogLevel};

const DEFAULT_SERVER: &str = "ws://127.0.0.1:7000/_frp";
const USAGE: &str = "用法: zfrpc -key <key> [-server <url>] [-local <addr>]

  -key    隧道 key（在 dashboard 隧道详情里复制）
  -server 服务端地址，默认 ws://127.0.0.1:7000/_frp
          线上示例: wss://frp.example.com/_frp
  -local  本地服务地址覆盖（HTTP 用 http://127.0.0.1:8080，TCP 用 127.0.0.1:3306）
  -h      显示本帮助
  -v      显示版本";

fn parse_args(args: &[String]) -> Result<Argv, String> {
    let get = |flag: &str| -> Option<String> {
        args.iter().position(|a| a == flag).and_then(|i| args.get(i + 1)).cloned()
    };
    if args.iter().any(|a| a == "-h" || a == "--help") {
        return Ok(Argv::Help);
    }
    if args.iter().any(|a| a == "-v" || a == "--version") {
        return Ok(Argv::Version);
    }
    let key = get("-key")
        .or_else(|| get("--key"))
        .ok_or("缺少 -key <key> 参数")?;
    if key.trim().is_empty() {
        return Err("-key 不能为空".into());
    }
    let server = get("-server")
        .or_else(|| get("--server"))
        .unwrap_or_else(|| DEFAULT_SERVER.into());
    let local = get("-local").or_else(|| get("--local"));
    Ok(Argv::Run(ClientOptions { key, server, local }))
}

enum Argv {
    Run(ClientOptions),
    Help,
    Version,
}

fn stamp() -> String {
    chrono::Local::now().format("%H:%M:%S").to_string()
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    let opts = match parse_args(&args) {
        Ok(Argv::Run(o)) => o,
        Ok(Argv::Help) => {
            println!("{USAGE}");
            return;
        }
        Ok(Argv::Version) => {
            println!("zfrpc {}", env!("CARGO_PKG_VERSION"));
            return;
        }
        Err(e) => {
            eprintln!("frpc 启动失败: {e}\n\n{USAGE}");
            std::process::exit(1);
        }
    };

    let (client, mut status_rx, mut log_rx) = FrpcClient::new(opts);
    let client = Arc::new(client);

    // 日志与状态打印任务
    let printer = tokio::spawn(async move {
        loop {
            tokio::select! {
                Some(log) = log_rx.recv() => {
                    let prefix = match log.level {
                        LogLevel::Info => "INFO",
                        LogLevel::Warn => "WARN",
                        LogLevel::Error => "ERRO",
                    };
                    println!("[{}] [{prefix}] {}", stamp(), log.message);
                }
                Some(status) = status_rx.recv() => {
                    match status.state {
                        ConnState::Online => {
                            let ids = status.proxies.iter().map(|p| p.name()).collect::<Vec<_>>().join(", ");
                            println!("[{}] [ONLINE] tunnelId={} clientId={} proxies=[{}]",
                                stamp(),
                                status.tunnel_id.as_deref().unwrap_or("?"),
                                status.client_id.as_deref().unwrap_or("?"), ids);
                        }
                        ConnState::Reconnecting => {
                            if let Some(err) = &status.last_error {
                                println!("[{}] [RECONN] {err}", stamp());
                            }
                        }
                        _ => {}
                    }
                }
                else => break,
            }
        }
    });

    client.start().await;

    // Ctrl+C 优雅退出
    if tokio::signal::ctrl_c().await.is_ok() {
        println!("[{}] [INFO] 收到退出信号，停止客户端", stamp());
        client.stop().await;
    }
    printer.abort();
}
