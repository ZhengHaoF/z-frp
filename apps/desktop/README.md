# z-frp 桌面客户端

用 Tauri 包一层 `frpc-core`，把「敲一长串命令行」变成「填 key → 点连接」。
一个窗口里能看到连接状态、服务端下发的代理、实时日志。

## 为什么是单隧道

服务端（Node 版 frps）里，**key 唯一对应一条隧道配置**（一或多条代理），客户端连上后由 `config-push` 下发。
所以界面只需要一个 key 输入框，不需要「隧道列表」——换隧道就换 key。
真正想同时跑多条隧道时，开两个窗口（或继续用 CLI 起两个进程）即可。

## 开发

```bash
pnpm install
cd apps/desktop
pnpm app:dev           # 等同 npx tauri dev；首次会编译 Rust 依赖，约 5~15 分钟
```

前端是纯静态页（`src/index.html` + `styles.css` + `main.js`），没有打包器、没有 `devUrl`，
Tauri 直接把 `src/` 作为 `frontendDist` 加载。改前端只需改文件后重开窗口（或在 dev 模式下按 F5）。

## 构建安装包

```bash
cd apps/desktop
pnpm app:build         # 等同 npx tauri build；产物在 src-tauri/target/release/
```

- 可执行文件：`src-tauri/target/release/zfrp-desktop.exe`（免安装，双击即用）
- 安装包：`src-tauri/target/release/bundle/nsis/z-frp_0.1.0_x64-setup.exe`

图标由 `scripts/make-icon.mjs` 生成源图，再用 `npx tauri icon icon-source.png` 出全套尺寸。

## 界面行为

| 区域 | 说明 |
|---|---|
| 状态胶囊 | 未连接 / 连接中 / 已连接 / 重连中，颜色随状态变化 |
| 隧道 Key | 密码框，可切换明文；支持从剪贴板一键粘贴 |
| 服务端地址 | 可下拉选预置（`wss://frp.infocloud.top/_frp`、`ws://127.0.0.1:17000/_frp`），也可手填 |
| 本地服务覆盖 | 留空 = 用服务端登记的本地地址；跨机器时才需要填 |
| 隧道状态 | 隧道 ID、客户端 ID、已连接时长、代理列表（类型/域名或端口/本地目标） |
| 运行日志 | 实时滚动，可复制/清空，超过 800 行自动截断 |

「记住设置与 Key」勾选后写入系统应用配置目录：

- Windows：`%APPDATA%\top.infocloud.zfrp\settings.json`
- macOS：`~/Library/Application Support/top.infocloud.zfrp/settings.json`
- Linux：`~/.config/top.infocloud.zfrp/settings.json`

不勾选则只在本次运行内存中保留 key。**key 是明文存的**——它等价于一条隧道的通行证，别再往外传。

## 和 CLI 的关系

| 场景 | 用什么 |
|---|---|
| 日常在电脑上手动起隧道 | 本桌面端 |
| 服务器/无桌面环境常驻 | `zfrpc`（`crates/frpc-cli`）或 Node 版 `packages/frpc` |
| 排查协议问题 | `zfrpc` + `scripts/e2e-rust.mjs` |

两者共用 `crates/frpc-core`，行为一致。
