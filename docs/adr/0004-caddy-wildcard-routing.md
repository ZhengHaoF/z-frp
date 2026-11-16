# ADR-0004: 前置 Caddy 终止 TLS + 泛域名 Host 路由

- 状态：已接受
- 日期：2026-11-16

## 背景

用户有已备案域名和固定公网 IP。需要决定：HTTPS 证书由谁处理，以及子域名如何映射到本地服务。

## 决策

- VPS 最外层跑 Caddy，负责自动签发/续期证书、TLS 终止、HTTP/2；frps 只监听本机回环地址，不直接暴露公网 HTTP 端口。
- DNS 设泛域名 `*.frp.example.com` → VPS，frps 读取 HTTP 请求的 Host 头决定转发到哪条本地服务。
- 新增服务只改本地 frpc 配置，不改 DNS。

## 理由

- Caddy 自动证书省掉 certbot/cron/续期脚本，比 Node 里手写 ACME 客户端省事且可靠。
- 泛域名 + Host 路由让"加一个服务"的成本降到最低，符合"自己 + 少数人"的小规模高频迭代。
- 已备案域名让 80/443 和子域名都可用，不需要走非标端口绕备案（那条路不稳且违规）。

## 后果

- frps 必须信赖 Caddy 传来的 Host 头；需要防止伪造 Host（Caddy 侧只把合法 Host 透传，frps 侧做白名单校验）。
- 数据库等原生 TCP 协议不走 Caddy（Caddy 主要处理 HTTP），TCP 入口由 frps 直接在公网端口监听，这部分流量不经 Caddy（见 ADR-0005 / 待决项）。
- 单条泛域名意味着所有 HTTP 服务共享一个 TLS 证书和一个入口，隔离靠 Host 而非端口。
