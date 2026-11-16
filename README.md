# z-frp

自研的内网穿透工具：本地 `frpc` 主动连到公网 VPS 上的 `frps`，把本地 HTTP 服务和数据库 TCP 端口暴露成 `xxx.frp.example.com` 子域名，供自己与少数可信的人访问。

设计背景与决策见 [`docs/DESIGN.md`](docs/DESIGN.md) 及 [`docs/adr/`](docs/adr/)。

## 架构

```
浏览器 ──HTTPS──> Caddy(自动证书/TLS终止) ──HTTP──> frps:8080 ──wss──> frpc ──> 本地 Web 服务
数据库客户端 ──TCP+AUTH──> frps:remotePort ──wss──> frpc ──> 本地数据库
```

- 一条 WebSocket 承载控制帧与数据帧，用 `streamId` 多路复用。
- 控制帧 JSON（可读），数据帧 binary（高效）。
- 每客户端一个 token + wss；TCP 入口额外要一次 token 握手，不裸奔。

## 前置条件

- 一台有**固定公网 IP** 的 Linux VPS，已备案域名（国内节点必须备案，非标端口也躲不掉）。
- DNS：`*.frp.example.com` 泛解析到 VPS。
- VPS 上装 Node.js ≥ 20、Caddy、pnpm。
- 本地机器装 Node.js ≥ 20。

## 构建

```bash
pnpm install
pnpm build
```

产物在 `packages/{shared,frps,frpc}/dist/`。

## 配置

```bash
cp config/frps.example.json config/frps.json      # VPS 上
cp config/frpc.example.json config/frpc.json      # 本地
```

**frps.json 要点**

- `domain`：泛域名后缀，如 `frp.example.com`。
- `clients`：`clientId → token`。token 用 `openssl rand -hex 32` 生成，一客户端一个。
- `http`：给 Caddy 转发的入口，默认 `127.0.0.1:8080`。
- `tcp.bindAddr`：TCP 入口监听地址，默认 `0.0.0.0`；安全组只放行用到的 `remotePort`。
- `dashboard`：只读面板，默认 `127.0.0.1:7500`，自带 basic auth。

**frpc.json 要点**

- `server`：`wss://frp.example.com/_frp`（`/_frp` 是隧道路径，Caddy 需反代）。
- `clientId` / `token`：与 frps `clients` 对应。
- `proxies`：一个 frpc 可声明多个代理，共用一条 WS。
  - HTTP：`{ name, type:"http", subdomain, local }`
  - TCP：`{ name, type:"tcp", remotePort, localHost, localPort, authToken }`

改配置需重启对应进程（一期不做热更新）。

## 部署

**Caddy**：把 `deploy/Caddyfile.example` 改成你的域名，用 `caddy hash-password` 生成 dashboard 的 basic auth 哈希，放到 `/etc/caddy/Caddyfile` 后 `systemctl reload caddy`。

**frps（VPS）**：

```bash
mkdir -p /opt/z-frp && cp -r packages config /opt/z-frp/
cp deploy/frps.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now frps
```

**frpc（本地）**：`deploy/frpc.service` 是 Linux 版；Windows 上用 `nssm` 或任务计划程序包 `node packages/frpc/dist/index.js` 即可。

## 使用

HTTP 服务：浏览器打开 `https://demo.frp.example.com`。

数据库 TCP：因为入口有 AUTH 握手，**原生数据库客户端直连不了**。两种办法：

1. 用支持自定义连接前置命令的客户端；
2. 在本地跑一个极小转发器，先跟 frps 完成 AUTH，再把本地端口转发过去——然后数据库客户端连本地端口。示例：

```js
// local-shim.mjs：把本地 3307 转发到 frps 的 33061
import net from "node:net";
net.createServer((c) => {
  const u = net.connect(33061, "frp.example.com");
  c.pipe(u); u.pipe(c);
  u.write("AUTH <tcp代理的authToken>\n");
}).listen(3307, "127.0.0.1");
```

Dashboard：`https://dash.frp.example.com`，输入 `dashboard.user/password`，可看在线客户端、代理、活跃流、流量。只读。

## 一期不做

UDP 代理、可写管理面、断线会话恢复（重连后全量重注册，活跃连接会断）、Prometheus 指标、多租户/计费/审计。

## 已知取舍

- 单 WS 通道同生共死：断线时上面所有流一起断，用户要重连。
- Node 单线程：靠背压、超时与多进程兜底（后续优化项）。
- 同 `clientId` 只允许一条连接，新连接顶替旧连接。
