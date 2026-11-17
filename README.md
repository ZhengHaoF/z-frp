# z-frp

自研的内网穿透工具：本地 `frpc` 主动连到公网 VPS 上的 `frps`，把本地 HTTP 服务和数据库 TCP 端口暴露成固定域名（如 `a.b.com`）或公网端口，供自己与少数可信的人访问。每条 HTTP 隧道对应一个完整域名，不再使用泛域名 + 子域名拼接（[ADR-0012](docs/adr/0012-fixed-domain-per-tunnel.md)）。

设计背景与决策见 [`docs/DESIGN.md`](docs/DESIGN.md) 及 [`docs/adr/`](docs/adr/)。二期改为**服务端托管配置 + key 凭证**（[ADR-0010](docs/adr/0010-key-based-tunnel-provisioning.md)）：在服务端建好隧道拿到 key，客户端只需 `run.js -key <key>` 一句命令，无需配置文件。三期给 dashboard 加了**网页隧道管理面**（[ADR-0011](docs/adr/0011-writable-dashboard.md)）：建/轮换/删隧道都能在网页点，与 CLI 共用同一份 `tunnels.json`。域名模型随后改为**一条隧道一个完整域名**（[ADR-0012](docs/adr/0012-fixed-domain-per-tunnel.md)）。

## 架构

```
浏览器 ──HTTPS──> Caddy(自动证书/TLS终止) ──HTTP──> frps:8080 ──wss──> frpc ──> 本地 Web 服务
数据库客户端 ──TCP+AUTH──> frps:remotePort ──wss──> frpc ──> 本地数据库
```

- 一条 WebSocket 承载控制帧与数据帧，用 `streamId` 多路复用。
- 控制帧 JSON（可读），数据帧 binary（高效）。
- 服务端存每条隧道的完整配置，key 是随机凭证；一条 wss + key 认证；TCP 入口额外一次 token 握手。

## 前置条件

- 一台有**固定公网 IP** 的 Linux VPS，已备案域名（国内节点必须备案，非标端口也躲不掉）。
- DNS：每个要暴露的 HTTP 域名（如 `a.b.com`）都加一条 A/CNAME 记录指向 VPS；不需要泛域名解析。
- VPS 上装 Node.js ≥ 20、Caddy、pnpm。
- 本地机器装 Node.js ≥ 20（无需 pnpm，跑编译好的 dist 即可）。
- 想用 Rust 客户端或桌面端：装 Rust 工具链（Windows 需 MSVC Build Tools，桌面端还需 WebView2 运行时，Win10 1803+ 一般自带）。

## 构建

```bash
pnpm install
pnpm build
```

产物在 `packages/{shared,frps,frpc}/dist/`。

## 服务端配置

```bash
cp config/frps.example.json config/frps.json      # VPS 上，按需改
```

**frps.json 要点**

- `tunnelsFile`：隧道存储文件，默认 `config/tunnels.json`。**首次启动会自动创建**。
- `http`：给 Caddy 转发的入口，默认 `127.0.0.1:8080`。
- `tcp.bindAddr`：TCP 入口监听地址，默认 `0.0.0.0`；安全组只放行用到的 `remotePort`。
- `dashboard`：隧道管理面板，默认 `127.0.0.1:7500`，自带 basic auth，可建/轮换/删隧道并看状态。

> 二期不再需要 `clients` 字段（旧配置里留着也不影响）。

## 新建隧道（在服务端，CLI）

```bash
NODE=node
# HTTP 隧道：把 a.b.com 映射到本地服务的 5173
$NODE packages/frps/dist/index.js tunnel create \
  --host a.b.com --local http://127.0.0.1:5173
# → 输出一串 64 位 key（只显示一次，保存好）

# TCP 隧道：VPS 的 33061 映射到本地 3306，访客需 AUTH token
$NODE packages/frps/dist/index.js tunnel create \
  --remote-port 33061 --local 127.0.0.1:3306 --auth-token <至少8位>

# 管理
$NODE packages/frps/dist/index.js tunnel list                 # 列出隧道（key 只显示前缀）
$NODE packages/frps/dist/index.js tunnel rotate <id 或 key>   # 轮换 key，旧 key 立即失效
$NODE packages/frps/dist/index.js tunnel delete <id 或 key>   # 删除，旧 key 立即失效
```

所有子命令可选 `--tunnels-file <路径>` 指定存储文件（默认 `config/tunnels.json`）。

**key 与 tunnel ID**：`tunnelId` 是稳定身份（统计、dashboard 条目都靠它），`key` 是可轮换凭证。轮换 key 不影响身份与统计。轮换/删除后，已在线的客户端会在巡检周期内（默认约 30 秒）被自动断开。

## 桌面客户端（推荐）

Windows 上不想敲命令就用桌面端：填 key → 点「连接」，界面里能看到状态、代理和实时日志。

```bash
pnpm install
cd apps/desktop
pnpm app:build          # 等同 npx tauri build；首次编译 Rust 依赖 5~15 分钟
```

产物：

- `apps/desktop/src-tauri/target/release/zfrp-desktop.exe` —— 免安装，双击即用
- `apps/desktop/src-tauri/target/release/bundle/nsis/z-frp_0.1.0_x64-setup.exe` —— 安装包

桌面端和 CLI 共用同一个 Rust 核心 `crates/frpc-core`，行为一致；细节见 [`apps/desktop/README.md`](apps/desktop/README.md) 与[实施文档](docs/rust-frpc-implementation.md)。

## 客户端启动（本地）

```bash
# Rust 版（推荐，需先 cargo build --release）
./target/release/zfrpc -key <你的key> -server wss://a.b.com/_frp

# Node 版（保留作回退）
node packages/frpc/dist/index.js -key <你的key> -server wss://a.b.com/_frp

# 换机器/换端口：用 -local 覆盖服务端登记的本地地址
node packages/frpc/dist/index.js -key <你的key> \
  -server wss://a.b.com/_frp \
  -local http://127.0.0.1:3000          # HTTP 用 URL

node packages/frpc/dist/index.js -key <你的key> \
  -server wss://a.b.com/_frp \
  -local 127.0.0.1:3307                 # TCP 用 host:port
```

`-server` 不填时默认 `ws://127.0.0.1:7000/_frp`（本地调试用）。`-local` 不填则用建隧道时登记的地址；**跨机器使用必须带 `-local`**，否则连的是建隧道那台机器的本地地址。

二期没有 `frpc.json`——配置全在服务端，客户端只有命令行参数。

## 部署

**Caddy**：把 `deploy/Caddyfile.example` 改成你的域名，用 `caddy hash-password` 生成 dashboard 的 basic auth 哈希，放到 `/etc/caddy/Caddyfile` 后 `systemctl reload caddy`。

**frps（VPS）**：

```bash
mkdir -p /opt/z-frp && cp -r packages config /opt/z-frp/
cp deploy/frps.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now frps
# 然后用 tunnel create 建隧道，把输出的 key 发给客户端使用者
```

**frpc（本地）**：`deploy/frpc.service` 是 Linux 版，把 key 填进 `ExecStart`。Windows 上用 `nssm` 或任务计划程序包 `node packages/frpc/dist/index.js -key <key> ...` 即可。

## 访问

HTTP 服务：浏览器打开 `https://a.b.com`（建隧道时填的完整域名）。

新增一个域名要改三处，缺一不可：**DNS 记录指向 VPS** → **Caddy 站点地址加上该域名**（见 `deploy/Caddyfile.example`）→ `tunnel create --host` 或网页建隧道填同一个域名。frps 只按请求 Host 头精确匹配已登记的域名，不认识没登记的名字。TCP 隧道不涉及域名，直接连 VPS 的 `remotePort`。

数据库 TCP：因为入口有 AUTH 握手，**原生数据库客户端直连不了**。两种办法：

1. 用支持自定义连接前置命令的客户端；
2. 在本地跑一个极小转发器，先跟 frps 完成 AUTH，再把本地端口转发过去——然后数据库客户端连本地端口。示例：

```js
// local-shim.mjs：把本地 3307 转发到 frps 的 33061
import net from "node:net";
net.createServer((c) => {
  const u = net.connect(33061, "a.b.com");
  c.pipe(u); u.pipe(c);
  u.write("AUTH <tcp隧道的authToken>\n");
}).listen(3307, "127.0.0.1");
```

## Dashboard（网页管理）

`https://dash.b.com`，输入 `dashboard.user/password` 登录。可以：

- 看在线客户端、代理、活跃流、流量与隧道清单（每 10 秒自动刷新）；
- **新建隧道**：选 TCP 填远程端口/本地地址/访问密码（有生成按钮），选 HTTP 填完整域名（如 `a.b.com`）/本地 URL；建完页面显示完整 key 供复制（只显示这一次）；
- 隧道清单每行可**轮换 key** 或**删除**（均有二次确认）。

网页与 CLI 共用同一份 `tunnels.json`：在网页建的隧道能用 CLI 管理，反之亦然。key 轮换/删除后，在线客户端会在巡检周期内（默认约 30 秒，即心跳超时 `heartbeatTimeoutMs/3`）自动断开，需拿新 key 重启。

> **安全前提：dashboard 绝对不要裸奔公网。** basic auth 是单账号，**能登录 = 能建/删隧道、能轮换 key**。默认只绑 `127.0.0.1`，通过 SSH 隧道（`ssh -L 7500:127.0.0.1:7500`）或 Caddy 反代 + HTTPS + basic auth 访问。别把它当成只读面板随意分享账号。

CLI 仍然可用（`tunnel create/list/rotate/delete`），适合脚本化批量建隧道。界面上标注了当前不支持的类型：UDP / HTTPS（独立类型）/ WOL / 多节点 / 端口自动生成 / 自动 HTTPS 开关。

## 边界

- UDP 代理、HTTPS 独立隧道类型 / WOL / 多节点 / 端口自动生成（这些界面上已标注不支持）、断线会话恢复（重连后全量重注册，活跃连接会断）、Prometheus 指标、多租户/计费/RBAC/审计。
- 单 WS 通道同生共死：断线时上面所有流一起断，用户要重连。
- Node 单线程：靠背压、超时与多进程兜底（后续优化项）。
- 同一隧道只允许一条连接，新连接顶替旧连接。
- `tunnels.json` 是单文件，CLI 原子写 + frps 按需读；极高频并发写不在设计范围（可信人群规模够用）。
