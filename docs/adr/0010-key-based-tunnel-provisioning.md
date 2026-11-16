# ADR-0010: 服务端托管配置 + key 凭证启动隧道

- 状态：已接受
- 日期：2026-11-16
- 取代：[0006](0006-auth-and-tcp-entry.md) 的客户端 token 模型、[0009](0009-dashboard-and-ops.md) 的"配置真相源在 frpc.json"与"手填 remotePort"

## 背景

一期实现后，客户端启动要在 `frpc.json` 里填 `server`、`clientId`、`token`、`proxies`（子域名、本地地址、TCP 端口、authToken），服务端还要在 `clients` 表里登记同一个 `clientId → token`。用户反馈这套体验不好，期望改成：

> 服务端新建隧道，新建好后生成一个 key；客户端拿 key 一句命令启动，如 `run.js -key aaaaa`。

这本质是把架构从"配置在客户端、服务端只做校验"翻转为"配置托管在服务端、key 是持有即有权"的凭证。这是 ngrok / Cloudflare Tunnel 等同类产品的通行做法。

## 决策

### 1. key 形态：服务端存配置 + key 作为随机凭证（选项 A）

- 隧道是一等公民：服务端持久化每条隧道的完整配置（公网侧：subdomain / remotePort；本地侧默认地址；TCP authToken；所属 clientId）。
- key 是服务端生成的随机串（32 字节十六进制），**仅作凭证**，不再是用户自填的 token。
- **key 与 tunnel ID 分离**（已定）：tunnel ID 是隧道的稳定身份（内部索引、流量统计、dashboard 条目），key 是可轮换的凭证。轮换 key 时身份与统计保持连续。
- 客户端只持有 key；连接后由服务端下发该隧道的配置，据此注册代理。
- 必须支持 key 的**吊销与轮换**——泄露后能作废、能换新的。
- 传输仍强制走 `wss`；key 是 bearer token，持有即有权，泄露风险等同旧 token 模型。

### 2. 新建入口：CLI 子命令（选项 B）

- 通过 frps 的 CLI 子命令新建/管理隧道：
  - `tunnel create --subdomain demo --local http://127.0.0.1:5173` → 输出 key
  - `tunnel create --remote-port 33061 --local 127.0.0.1:3306 --auth-token <token>` → 输出 key
  - `tunnel list` / `tunnel delete <key>` / `tunnel rotate <key>`（轮换）
- 一期不给 dashboard 加写操作，dashboard 保持只读（[0009](0009-dashboard-and-ops.md) 的只读结论不变），但增加隧道清单的展示。
- **持久化与并发（已定）**：配置存 `tunnels.json`。CLI 进程用**原子写**（写临时文件再 rename 替换）；frps 侧处理连接时**按需读、不缓存**。这样 frps 没启动也能建隧道，且避开 CLI 与 frps 同时写的竞态——不引入 SQLite，不新增管理 API。

### 3. 本地地址：建隧道时登记默认值，客户端可 `-local` 覆盖（选项 A）

- 新建隧道时把本地地址登记进服务端配置，作为默认值。
- 客户端 `run.js -key aaaaa` 不带参数时，用服务端登记的本地地址——这是"只用 key"的常规路径。
- 换机器/换端口时用 `-local` 覆盖，不必新建隧道。格式按类型区分（已定）：HTTP 用 URL `-local http://127.0.0.1:3000`；TCP 用 `host:port` `-local 127.0.0.1:3306`。
- 由此承认一个约束：服务端登记的本地地址来自"建隧道那台机器"，跨机器使用必须带 `-local`。

### 4. 客户端启动形态

- 主入口简化为 `run.js -key <key> [-local <addr>]`，可选 `-server <wss://...>` 覆盖服务端地址。
- **不保留 `frpc.json`（已定）**：纯命令行，客户端不再有配置文件。批量部署靠脚本循环起进程。
- 握手协议新增两步：客户端认证后先 `config-pull`（按 key 拉配置），服务端 `config-push` 下发，再进入 register。
- **协议兼容（已定）**：只加新控制帧 type（`config-pull` / `config-push`），保持 v1 不变。`decodeControl` 对未知 type 容错忽略。不做双轨，旧 token 路径直接移除（一期无外部用户）。

## 理由

- 三类配置里，公网入口和认证凭证服务端都能决定，只有本地地址是客户端环境信息——把它设为"服务端登记默认值 + 客户端可覆盖"，同时满足了"零配置启动"和"跨机器可用"。
- CLI 新建是最快落地的管理入口，不必给只读 dashboard 引入写操作与新的权限模型，把可写管理面继续推迟。
- 服务端托管配置后，隧道清单、改配置、吊销 key 都有了单一真相源；dashboard 只读地展示它即可。
- key 随机生成 + 可吊销 + 可轮换，把 bearer token 的泄露风险控制在可接受范围。

## 后果

- 推翻一期"配置真相源在 frpc.json"的假设：客户端从"配置驱动"变成"凭证驱动"，配置解析逻辑大幅简化。
- 协议要加 `config-pull` / `config-push` 两个控制帧；旧客户端与新服务端不兼容（一期无外部用户，可接受）。
- 服务端要新增隧道持久化（建议 JSON 文件 `tunnels.json`，与一期 JSON 约定一致）和 key 生命周期管理（生成/吊销/轮换）。
- 新建/删除/轮换隧道是写操作，CLI 要有最基本的防误操作（列出确认、key 只显示一次）。
- dashboard 增加隧道清单展示，但仍只读；完整可写管理面仍需另开 ADR。
- 本地地址登记值绑定建隧道的机器，跨机器用必须 `-local`——README 要写清楚，否则用户会疑惑"为什么连的是别人的 5173"。

## 细节拍板记录（2026-11-16）

五处待定细节已全部确认，无遗留：

| # | 细节 | 结论 |
|---|------|------|
| 1 | key 与 tunnel ID | **分离**：ID 稳定作身份，key 可轮换作凭证 |
| 2 | `tunnels.json` 并发 | **CLI 原子写 + frps 按需读**，不引 SQLite、不加管理 API |
| 3 | 保留 `frpc.json` | **不保留**，纯命令行 |
| 4 | `-local` 对 TCP 格式 | **`host:port`**（HTTP 仍用 URL） |
| 5 | 协议兼容 | **加新 type、保持 v1**，不双轨 |

唯一仍在实现阶段自行决定的是 `tunnels.json` 的具体字段结构（纯实现细节，不影响架构）。
