# ADR-0012: 一条 HTTP 隧道对应一个完整域名

- 状态：已接受
- 日期：2026-11-16
- 取代：[ADR-0004](0004-caddy-wildcard-routing.md) 中的泛域名子域路由部分

## 背景

一期按 ADR-0004 采用 `*.frp.example.com` 泛域名解析 + 子域名拼接：建隧道填 `demo`，frps 注册时拼成 `demo.frp.example.com`。用户反馈这套心智模型别扭：实际想要的只是"把 `a.b.com` 解析到 VPS，这个域名就是一条隧道"，不理解为什么还有一层后缀和拼接规则。项目尚未上线，可以承受一次破坏性字段变更。

## 决策

- **去掉 `frps.json` 的 `domain` 字段**，不再有全局域名后缀。
- HTTP 代理字段 `subdomain` 改为 **`host`**，存完整域名（如 `a.b.com`）。CLI 用 `--host a.b.com`，dashboard 的 HTTP 表单填"域名"。
- 校验规则统一放在 `packages/shared/src/host.ts`：合法主机名，至少两段，只允许小写字母、数字、连字符和点；建隧道与 frps 注册共用。
- frps 按请求 `Host` 头**精确匹配**完整域名，不做任何拼接或通配匹配；一个域名只能被一条隧道占用。
- DNS 与 Caddy 由使用者配置：每个域名加 A/CNAME 记录指向 VPS，并在 Caddy 站点地址中列出该域名。单域名证书走 HTTP-01 即可，不再需要泛域名 DNS challenge。
- 协议保持 v1，只换字段名；TCP 隧道不变，仍按 `remotePort + authToken`。
- 旧 `tunnels.json` 中的 `subdomain` 记录**不自动迁移**（项目未上线），升级前手工改成 `host` 并填完整域名。

## 理由

- "一个域名对应一个服务"是用户直接表达的心智模型，少一层概念就少一类填错的情况（例如把 `a.b.com` 填进子域名栏，拼成 `a.b.com.frp.example.com`）。
- 单域名证书配置更简单，不需要给 Caddy 配 DNS API 凭据来签通配符证书。
- 代价是新增一个域名要动三处：DNS 记录、Caddy 站点名、建隧道。当前规模是"自己 + 少数可信用户"，这个成本可接受。

## 后果

- 两端必须一起升级：`config-push` 下发的 HTTP 代理字段从 `subdomain` 变成 `host`。
- 删除一期遗留的 `config/frpc.example.json`、`config/frpc.test.json`（二期已不用 `frpc.json`，留着会误导）。
- README、DESIGN、术语表、Caddyfile 示例和 dashboard 文案同步改为"完整域名"。
- dashboard 的 HTTP 提示从"需泛域名已解析"改为"域名 A/CNAME 指向 VPS，并在 Caddy 配置中加入站点名"。
