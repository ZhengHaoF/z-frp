# Rust 版 frpc 实施计划

- 状态：待实施
- 日期：2026-11-17
- 相关：[ADR-0010](adr/0010-key-based-tunnel-provisioning.md)（key 凭证）、[ADR-0012](adr/0012-fixed-domain-per-tunnel.md)（固定域名）
- 范围：重写**客户端**（frpc）为 Rust，服务端（frps）保持 Node 不动；最终交付一个 Tauri 桌面界面

## 1. 目标与非目标

**目标**

1. 用 Rust 实现 frpc，与现有 Node frps **协议逐字节兼容**（v1），可直接替换当前 Node 客户端。
2. 用 Tauri 做桌面界面：隧道列表、开关启停、日志面板，源码见截图那种形态。
3. 产物是单个 exe（~10MB），对方机器**无需 Node**，可分发。

**非目标**

- 不改 frps、不改协议版本、不加新代理类型（本期仍只有 HTTP / TCP）。
- 不在本期做 key 自动同步（仍走"dashboard 复制 key → 客户端粘贴"）。
- 不做 macOS / Linux 打包（先 Windows x86_64，本机工具链已具备）。

## 2. 总体架构

拆成三个 crate，一个 Cargo workspace，核心逻辑与界面解耦：

```
crates/
├── frpc-core/        # lib：协议编解码 + 连接管理 + HTTP/TCP 转发（不含 UI/CLI）
├── frpc-cli/         # bin：命令行入口，复用 core；用于无界面场景与对拍测试
└── frpc-desktop/     # Tauri app：复用 core，前端画隧道卡片/开关/日志
packages/             # 现有 Node 代码，frps 保持不动
```

**为什么这样拆**：隧道核心是"可测试的纯逻辑"，CLI 和 Tauri 只是两个外壳。Phase 0~4 只碰 `frpc-core` 和 `frpc-cli`，能在没有界面的情况下先证明"Rust 客户端能替代 Node 客户端"；Phase 5 再接 Tauri。顺序不能反——界面之下若协议不对，UI 做得再好也连不上。

Tauri 的形态是：Rust 侧跑 `frpc-core`，通过 `#[tauri::command]` 暴露 `start_tunnel / stop_tunnel / list_tunnels / get_logs`，WebView 前端调用这些命令渲染卡片。

## 3. 技术选型与依赖

| 用途 | crate | 备注 |
|---|---|---|
| 异步运行时 | `tokio`（rt-multi-thread, macros, net, time, sync, io-util） | |
| WebSocket | `tokio-tungstenite` + `futures-util`（SinkExt/StreamExt） | 需 **wss** 支持 |
| TLS | `rustls-tls-webpki-roots` | 纯 Rust、无系统依赖、打包简单；公网证书是 Let's Encrypt 通配，可正常校验 |
| 控制帧 JSON | `serde` + `serde_json` | 字段名必须与 Node 一致 |
| HTTP 转发 | `reqwest`（stream 特性） | **必须关闭自动解压**，见 §8 |
| TCP 转发 | `tokio::net::TcpStream` | |
| CLI 参数 | 手写解析（无 clap） | 只有 `-key / -server / -local / -h / -v` 五个，省掉一棵依赖树 |
| 日志 | 自定义 `LogEvent` + `mpsc` | CLI 直接打印、桌面端转成 Tauri 事件；不引 `tracing` |
| 时间戳 | `chrono`（仅 `clock`） | CLI 打 `HH:MM:SS`；桌面端交给前端 `Date` |
| URL 解析 | `url` | 解析 `local` 与 `server` |
| 异步锁 | `tokio::sync::Mutex` | 共享 WS 写端，见 §5 |
| 桌面壳 | `tauri` v2 | 前端是纯静态页，无打包器 |

本机环境已确认：Rust 1.99（MSVC toolchain）、VS Build Tools 18 + Windows SDK、WebView2 Runtime 157，构建条件齐备。

## 4. 协议兼容契约（最关键）

**这一节是硬约束**：frps 是现成的 Node 实现，Rust 端发出的每个字节都必须被它接受。

### 4.1 数据帧（binary message）

```
字节:  0..3        4        5..7     8..
       streamId    flags    reserved payload
       uint32 BE   bit0=FIN =0       ...
                   bit1=RST
```

- `MAX_PAYLOAD = 64 * 1024`：**单次发送 payload 不得超过 64KB**，超长必须分片。
- streamId 从 1 起递增，绕回时回到 1，不用 0。
- FIN 表示流结束，RST 表示异常复位。

### 4.2 控制帧（text message）

JSON，统一含 `v: 1`。字段逐一对齐下表（名称、类型、大小写都不能差）：

| type | 方向 | 关键字段 |
|---|---|---|
| `hello` | C→S | `key` |
| `hello-ok` | S→C | `clientId`, `heartbeatIntervalMs` |
| `hello-reject` | S→C | `reason` |
| `config-pull` | C→S | `key`, `local?`（可选覆盖） |
| `config-push` | S→C | `tunnelId`, `clientId`, `proxies[]` |
| `config-reject` | S→C | `reason` |
| `register` | C→S | `proxies[]`（精简字段，见 4.4） |
| `register-ok` | S→C | `rejected[]` |
| `register-reject` | S→C | `reason` |
| `stream-open` | S→C | `streamId`, `proxyName`, `req?` |
| `stream-head` | C→S | `streamId`, `statusCode`, `headers{}` |
| `error` | S→C | `reason`, `streamId?` |
| `heartbeat` | C→S | `at`（毫秒时间戳） |
| `heartbeat-ack` | S→C | `at` |

**未知 type 一律忽略**（Node 端 `decodeControl` 对未知类型是容错跳过的）。

### 4.3 握手状态机

```
connect(wss://…/_frp)
  ├─ 10s 内未完成认证 → terminate（与 Node failTimer 一致）
  ├─ C→S  hello(key)
  ├─ S→C  hello-ok
  ├─ C→S  config-pull(key, local?)      ← local 覆盖在这里带
  ├─ S→C  config-push(tunnelId, clientId, proxies)
  ├─ C→S  register(proxies)             ← 用下发配置注册
  ├─ S→C  register-ok
  └─ 进入心跳 + 数据阶段
```

- 心跳：按 `hello-ok.heartbeatIntervalMs`（默认 30000）定时发 `heartbeat`；**超过 4 个周期未收到 ack/pong 则主动断线重连**。
- 断线重连：指数退避 `1000 * 2^attempt`，上限 30000ms；重连后**重走完整握手**（不是只重连 socket）。

### 4.4 代理字段映射

`config-push.proxies[]` 两种规格：

- HTTP：`name`, `type="http"`, `host`（完整域名，仅展示用）, `local`（本地 URL）
- TCP：`name`, `type="tcp"`, `remotePort`, `localHost`, `localPort`, `authToken`

`register` 时只发必要字段：HTTP 发 `{name, type, host}`；TCP 发 `{name, type, remotePort, authToken}`。

`stream-open` 到达时：
- HTTP 带 `req{method, path, host, headers}` → 用 `new URL(path, local)` 请求本地服务。
- TCP 不带 `req` → 连 `localHost:localPort`，双向转发。

## 5. 并发与数据流设计

这是重写中架构变化最大的部分。Node 单线程里所有 stream 直接调 `send()`；Rust 里每个 stream 是独立 task，必须共享同一条 WS 写端。

设计：

- WS `split()` 成写端 `Sink` + 读端 `Stream`。写端包进 `Arc<Mutex<Sink>>`（用 `futures::lock::Mutex`，异步锁，避免持锁跨 await 的死锁）。
- **主循环**只读读端：
  - 控制帧 → 在循环内处理（握手、心跳、stream-open 建 task）。
  - 数据帧 → 按 `streamId` 查 `HashMap<u32, mpsc::Sender<DataFrame>>`，投递到对应 stream task；查不到就丢弃并记录。
- **每个 stream 一个 task**：持 `mpsc::Receiver<DataFrame>`，负责连接本地服务、收本地数据经共享写端发回、收到 FIN/RST 时收尾并通知主循环注销路由。
- stream 的 mpsc 用**有界 channel**（如 128 帧）防止背压失控；写端发送串行化，天然限制并发写入。
- 停止隧道时：标记停止 → abort 所有 stream task → 关闭 WS → 取消定时器。

## 6. 分阶段实施

每阶段都有明确产出和验收，前一阶段不过不进入下一阶段。

### Phase 0 — 项目骨架 + 协议层（无网络）

- 建 Cargo workspace 与三个 crate 骨架；`frpc-core` 实现帧编解码和类型。
- **产出**：encode/decode 单元测试。
- **验收**：Rust 编码结果与 Node `encodeDataFrame/encodeControl` 的**字节向量**逐字节一致（测试向量由 Node 脚本导出，见 §7）。

### Phase 1 — 握手与注册跑通（无数据流）

- `frpc-cli` 实现连接、`hello` → `config-pull` → `register` → 心跳；`frpc-core` 提供连接状态机。
- **产出**：一个能连上真实 frps 并注册成功的 Rust 客户端。
- **验收**：连本地测试 frps（`config/frps.test.json`），dashboard 显示该客户端上线、代理注册成功 count=1；`hello-reject` / key 错误时正确报错退出。

### Phase 2 — TCP 数据流对拍（最大风险）

- 实现 `openTcpStream`：连接本地 TCP、双向转发、FIN/RST、连接前数据排队。
- **产出**：Rust 客户端跑通 TCP 隧道。
- **验收**：复用 `scripts/test-fixtures.mjs` 的 TCP 回显（19092），经 frps TCP 入口（19091）发 `AUTH` + 数据，回显正确；**多流并发**与 Node 客户端行为一致。

### Phase 3 — HTTP 数据流对拍

- 实现 `openHttpStream`：method/path/header 转发、`stream-head` 回写、响应分块、错误处理。
- **产出**：Rust 客户端跑通 HTTP 隧道。
- **验收**：`Host: demo.test.local` 请求返回 200，响应头/状态码/body 与 Node 客户端一致；POST、长 body（>64KB 分片）、gzip 响应均正确。

### Phase 4 — 健壮性与 CLI 收尾

- 断线重连、指数退避、心跳超时、优雅关闭；`-key / -server / -local` 参数；JSON 日志。
- **产出**：可替代 Node 客户端的完整 CLI。
- **验收**：杀掉 frps 再恢复，客户端自动重连并恢复注册；轮换 key 后按巡检周期被踢、用新 key 重连成功；长跑（≥1 小时）无 task 泄漏或死锁。

### Phase 5 — Tauri 桌面界面

- `frpc-desktop`：Rust 侧管理多个 `FrpcClient` 实例，IPC 暴露启停/列表/日志；前端实现截图形态（左导航 + 隧道卡片 + 开关 + 日志面板）。
- **验收**：粘贴 key 添加隧道 → 点开关启停 → 多条隧道并发在线 → 日志实时刷新。

### Phase 6 — 打包与过渡

- Tauri 打包单 exe；README 补 Rust 客户端用法；Node 客户端暂留作回退。
- **验收**：在未装 Node 的干净 Windows 环境双击 exe 可用。

### 6.1 实际落地与偏差

代码位置：`crates/frpc-core`（协议+转发）、`crates/frpc-cli`（bin `zfrpc`）、`apps/desktop`（Tauri，Rust 壳在 `src-tauri`，前端在 `src`）。

| 计划 | 实际 | 原因 |
|---|---|---|
| 桌面端管理「多个隧道实例 + 隧道列表」 | 单个连接卡片：key + 服务端 + 状态 + 日志 | 服务端模型里 key 唯一对应一条隧道，客户端连上由 `config-push` 下发代理；多条隧道 = 多个窗口，列表在 dashboard |
| `start_tunnel/stop_tunnel/list_tunnels` 四个命令 | `start_client / stop_client / get_settings / save_settings / app_version` | 同上，单实例无需隧道管理 |
| clap + tracing | 手写参数解析 + 自定义日志事件 | 参数只有 5 个；日志要同时喂 CLI 和 WebView |
| 「记住 key」放内存即可 | 落盘到 app_config_dir/settings.json，外加「启动后自动连接」 | 否则每次开窗都要重贴 key，失去 GUI 的意义 |

验收记录（本地 `config/frps.test.json` + `scripts/test-fixtures.mjs`）：

- `cargo test`：3 组字节向量对拍全绿。
- `node scripts/e2e-rust.mjs`：HTTP GET / POST 100KB（sha256 一致）/ TCP AUTH 回显，3/3 通过。
- 杀掉 frps 后客户端按 1/2/4/8/16/30s 退避重连，frps 恢复后自动回 Online 且流量恢复。
- 桌面端：seed `settings.json` → 启动即自动连接，`状态=已连接`、隧道 ID/代理列表/日志实时刷新；经 frps HTTP 入口 `18080` 请求返回 200。

## 7. 测试策略：端到端对拍

最大风险是"能连上但传输出错"，靠三类测试兜底：

1. **字节向量对拍**：写 Node 脚本导出 `encodeDataFrame` / `encodeControl` 的输出为十六进制向量，Rust 单元测试断言编码结果相同。覆盖正常帧、FIN/RST、边界长度（1 / 64KB / 64KB+1）。
2. **同隧道 A/B 对拍**：同一条测试隧道，分别用 Node 客户端和 Rust 客户端连，跑完全相同的 HTTP/TCP 请求，比对响应（状态码、头、body 字节）。
3. **复用现有 fixture**：`scripts/test-fixtures.mjs`（HTTP 19090 / TCP 19092），本地 frps 用 `config/frps.test.json`，HTTP 入口 18080、TCP 入口 19091。

## 8. 已知坑与对策

| 风险 | 对策 |
|---|---|
| 协议字节不兼容 | Phase 0 字节向量对拍；不通过不进入网络阶段 |
| `reqwest` 默认自动解压 gzip/br，改变响应 body | 构建 Client 时关掉 `gzip/brotli/deflate`，并原样透传请求头，不主动加 `accept-encoding` |
| hop-by-hop 头处理差异 | 转发前删 `host` / `connection` / `transfer-encoding`，与 Node 一致 |
| payload 超过 64KB 被 frps 拒绝 | 发送端按 ≤64KB 主动分片；**服务端同样要分片**——实测 frps 的 HTTP 入口把整个请求体塞进一帧，>64KB 时 `encodeDataFrame` 抛错并带崩整个 frps 进程（已修 `TunnelHub.sendData`） |
| 未捕获的 Promise 异常打死进程 | HTTP 入口的 `void handle()` 补 `.catch`，单请求出错只回 502 |
| Tauri v2 里前端 `listen` 报 `plugin:event|listen not allowed by ACL` | 必须在 `src-tauri/capabilities/*.json` 声明 `core:default`，否则**一条事件都收不到**，界面看起来"连上了但没反应" |
| 前端脚本在 WebView 里重复执行报 `Identifier 'x' has already been declared` | 顶层 `const` 一律包进 IIFE；热重载/重复注入时不会整页失灵 |
| `std::sync::Mutex` 持锁跨 await 死锁 | 用 `futures::lock::Mutex`，缩小临界区 |
| stream task 泄漏 | 有界 channel + FIN/RST 必注销 + 停止时 abort 全部 task |
| wss 证书校验失败 | 用 `rustls-tls-webpki-roots`，确认系统时间正确、证书链完整 |

## 9. 验收标准（DoD）

- [ ] Rust 客户端通过 §7 全部对拍测试，行为与 Node 客户端一致。
- [ ] 真实环境（82 服务器 + `wss://frp.infocloud.top/_frp`）跑通一条 HTTP 隧道和一条 TCP 隧道。
- [ ] Tauri 界面完成隧道的增删、启停、日志查看；多隧道并发可用。
- [ ] 打包 exe 在无 Node 的 Windows 机器上可运行。
- [ ] README 与 ADR 更新，记录 Rust 客户端为推荐入口、Node 客户端为回退。

## 10. 过渡与共存

- 实施期间两端并存， frps 无感知——它只认协议，不认客户端语言。
- 每个 Phase 结束后用同一套对拍测试回归，确保没有破坏 Node 客户端行为。
- 全部验收通过后，README 把 Rust 客户端标为推荐，Node 客户端保留一段时间再决定去留（另开 ADR）。
