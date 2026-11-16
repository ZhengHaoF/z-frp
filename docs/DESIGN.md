# z-frp 设计总览

> 状态：**待确认**。本文是 grill-with-docs 过程的收口产物，汇总所有已拍板的设计决策。
> 在用户确认"达成共识"之前，不开始写代码。

## 一句话

自研的内网穿透工具：本地 `frpc` 主动连到公网 VPS 上的 `frps`，把本地 HTTP 服务和数据库 TCP 端口暴露成 `xxx.frp.example.com` 子域名，供自己与少数可信的人访问。

## 架构

```
访问者 ──HTTPS──> Caddy (TLS终止/泛域名) ──HTTP──> frps ──wss 隧道──> frpc ──> 本地服务
数据库客户端 ──TCP+token握手──> frps:remotePort ──wss 隧道──> frpc ──> 本地数据库
```

- **frps**：Linux VPS，Node.js，固定公网 IP，只监听本机回环（HTTP 经 Caddy 转发）。
- **frpc**：本地开发机，Node.js，主动连出，一条 wss 连接上注册多个代理。
- **隧道**：单条 WebSocket，`type + streamId` 信封；JSON 控制帧 + binary 数据帧。
- **协议**：TypeScript + pnpm monorepo，`packages/shared` 放帧定义与类型，两端共用。

## 决策清单

| # | 决策 | 结论 | ADR |
|---|------|------|-----|
| 1 | 自建方式 | 自己写代码，非部署官方 frp | [0001](adr/0001-build-own-frp.md) |
| 2 | 技术栈 | 服务端与客户端均 Node.js + TypeScript | [0002](adr/0002-node-both-ends.md), [0008](adr/0008-project-shape.md) |
| 3 | 数据面 | 单 WS 通道 + streamId 多路复用 | [0003](adr/0003-websocket-multiplexing.md) |
| 4 | HTTPS/路由 | 前置 Caddy 自动证书 + 泛域名 Host 路由 | [0004](adr/0004-caddy-wildcard-routing.md) |
| 5 | 范围 | HTTP + TCP 两类代理，不做 UDP；访问者限可信人群 | [0005](adr/0005-scope-and-access.md) |
| 6 | 认证 | 每客户端一 token + wss；TCP 入口先握手再放行 | [0006](adr/0006-auth-and-tcp-entry.md) |
| 7 | 帧与重连 | JSON 控制帧 + binary 数据帧；断线自动重连 + 全量重注册 | [0007](adr/0007-protocol-and-reconnect.md) |
| 8 | 工程 | TS + pnpm monorepo；一 frpc 多代理 | [0008](adr/0008-project-shape.md) |
| 9 | 运维 | 只读 dashboard（子域名 + basic auth）；JSON 配置；手填 remotePort；多 frpc 各自 token；30s/90s 心跳 | [0009](adr/0009-dashboard-and-ops.md) |

## 一期不做

- UDP 代理
- 可写管理面（增删改代理、token 吊销、配置热更新）
- 会话级断线恢复（未确认数据续传）
- Prometheus 指标导出
- 多租户、计费、RBAC、WAF

术语定义见 [glossary.md](glossary.md)。

## 已知取舍

1. **数据库 TCP 握手是自定义协议**：原生数据库客户端直连不了，需要一个本地小代理或支持自定义连接串的客户端。这项体验成本是"TCP 入口不裸奔"换来的。
2. **单通道同生共死**：WS 断开时上面所有流一起断，活跃连接需要用户重连。断线恢复复杂度暂不引入。
3. **改配置要重启**：配置真相源是 JSON 文件，没有热更新。
4. **Node 单线程**：一个写坏的客户端可能拖慢 frps，靠背压、超时与多进程兜底（实现阶段处理）。
