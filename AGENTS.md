# Codex 工作指引

## 项目概述

Hermes Agent CN 桌面端 — 用 Tauri v2 + React 构建的独立桌面应用，替代原 Electron 壳。
对接后端是 [hermes-agent](https://github.com/Eynzof/hermes-agent-cn) 内置 Dashboard；桌面端 managed runtime 默认使用端口 9120，避开用户全局 Hermes Agent 常用的 9119。

## 项目结构

```
hermes-agent-cn-desktop/
├── src/                    Rust Tauri 后端（~2700 行）
│   ├── main.rs               入口：解析 HERMES_HOME、启动 dashboard、注册命令
│   ├── state.rs               AppState（Mutex<AppStateInner>）
│   ├── commands/              15 个 #[tauri::command]
│   │   ├── api_proxy.rs         HTTP 代理（api_request / external_request / upload_file）
│   │   ├── file_dialogs.rs      原生文件/目录对话框
│   │   ├── gateway.rs           runtime config + gateway URL 刷新
│   │   ├── runtime_manager.rs   runtime 下载/更新/回滚
│   │   ├── profiles.rs          profile 切换（含故障恢复）
│   │   └── ws_proxy.rs          Rust WS 中继（兜底连接官方 /api/ws）
│   ├── process/
│   │   ├── dashboard.rs         dashboard 子进程管理（probe/spawn/port fallback）
│   │   └── runtime.rs           managed runtime 安装/签名验证
│   ├── session_archive.rs       会话归档（本地 JSON 状态）
│   └── session_log.rs           会话日志文件读取
├── web/                    React 前端（Vite + TanStack Query + Jotai）
│   ├── src/
│   │   ├── lib/tauri-bridge.ts    Tauri invoke 包装 + hermesDesktop shim
│   │   ├── lib/runtime.ts         平台检测（web / electron / tauri）
│   │   ├── lib/transport.ts       HTTP 路由（native IPC vs fetch）
│   │   ├── lib/gateway-client.ts      JSON-RPC over WebSocket 客户端
│   │   └── lib/gateway-socket-path.ts 路径选择（原生 WS / Rust 中继）
│   └── vite.config.ts
├── packages/
│   ├── protocol/              Zod schemas、IPC 类型、会话日志解析
│   └── shared-ui/             设计 token（CSS 变量）、Dialog/Popover 组件
├── Cargo.toml                 Rust 依赖
├── tauri.conf.json            Tauri 窗口/打包/CSP 配置
├── pnpm-workspace.yaml        pnpm monorepo（web + packages/*）
└── package.json               workspace root + 构建脚本
```

## 后端事实来源

UI 对接的是 hermes-agent Dashboard。**不要凭参数名猜后端行为**。

如果有 `ref/hermes-agent/` 本地 checkout，查：
- REST 路由：`hermes_cli/web_server.py`
- Gateway 事件：`tui_gateway/server.py`
- 上游 Web 实现：`web/src/lib/api.ts`、`gatewayClient.ts`

## 开发流程

### 仓库技能

双仓库（Desktop + Core）最新分支启动、dev 冒烟或打包态补验，必须使用：
`.codex/skills/desktop-dual-repo-test/SKILL.md`。

发版、版本号更新、安装包发布或 GitHub Release 相关任务必须使用仓库内技能：
`.codex/skills/desktop-release-sync-landing/SKILL.md`。
只要桌面端公开版本发生变化，就必须同步处理 `Eynzof/hermes-agent-cn-desktop-landing`，
更新官网版本与 `https://desktop.hermesagent.org.cn/latest.json` 清单；如果 release 资产尚未生成，
需要明确说明 Landing 同步被阻塞，不能把桌面端发版任务当作已经完整结束。

### 启动顺序

```bash
# 终端 1：Hermes Dashboard（必须先起）
hermes dashboard --no-open

# 终端 2：Web dev server + Tauri dev（自动热更新）
pnpm web:dev
# 终端 3：
cargo run
```

或一步起 Tauri dev（自动加载 Vite devUrl）：
```bash
pnpm tauri:dev
```

### 改完代码必做

```bash
pnpm typecheck        # 3 个 workspace 全部 typecheck
pnpm test:unit        # 244 个 vitest 测试
cargo check           # Rust 编译检查
```

### 打包

```bash
pnpm tauri:build           # Release：web build + cargo tauri build
pnpm tauri:build:debug     # Debug：带调试信息的 .app / .dmg
```

产物在 `target/release/bundle/` 或 `target/debug/bundle/`。

## 架构约定

### Dev 模式 vs 生产模式

| | Dev 模式 | 生产模式 |
|--|---------|---------|
| WebView 加载 | `http://localhost:9545`（Vite） | 打包的 `web/dist/` |
| REST API | Vite proxy → dashboard（同源） | Rust IPC 代理（`api_request` command） |
| Gateway 事件流 | WebSocket → Vite proxy 的 `/api/ws` | 官方 `/api/ws`，必要时 Rust WS 中继（`ws_proxy.rs`） |
| Session token | Vite `/__hermes_token` 端点 | Rust `get_runtime_config` command |
| `apiBaseUrl` | 不设置（走相对路径） | 设置为 dashboard URL |

### 前端兼容 shim

`web/src/lib/tauri-bridge.ts` 在启动时把 Tauri invoke 包装挂载到 `window.hermesDesktop`。
这样所有原来检查 `window.hermesDesktop?.someMethod` 的代码**无需修改**即可工作。

### 状态管理

- **服务端状态**：TanStack Query（REST API 数据）
- **本地/实时流**：Jotai atom
- **Rust 端**：`AppState`（`Mutex<AppStateInner>`），所有 command 通过 `tauri::State` 注入

### 样式

- CSS Modules，不用 Tailwind / styled-components
- 视觉变量在 `packages/shared-ui/src/tokens/*.css`，不要硬编码颜色/圆角/字号

### Gateway transport

唯一传输是 **JSON-RPC over WebSocket（官方 `/api/ws`）**，与 Core 官方桌面端架构一致。
`gateway-client.ts` 负责协议层与重连编排，`gateway-socket-path.ts` 在原生 WebSocket 和 Rust 中继之间选择；打包态 webview 拦截 `ws://` 时回退到 `ws_proxy.rs`，线协议仍保持 `/api/ws` 不变。

## 不要做的事

- ❌ 不要在 `web/src/lib/transport.ts` 之外手写 fetch — auth header 注入在 transport 层
- ❌ 不要直接调 `gateway-client.ts` 的 raw socket — 走 `hooks/use-gateway.ts`
- ❌ 不要在 `web/src/routes/` 里塞业务逻辑 — 抽到 `hooks/` 或 `lib/`
- ❌ 不要在组件里写硬编码颜色 — 用 `packages/shared-ui/src/tokens/` 里的 CSS 变量

## Commit 风格

- Conventional commit：`feat` / `fix` / `style` / `docs` / `refactor` / `chore`
- 标题用英文短句、命令式（"add ...", "fix ...", "rework ..."）
- 描述可中英混用，写"为什么"而不是"做了什么"

## 端口

- **9120**：Hermes Dashboard（桌面端 managed runtime 默认后端；9119 通常留给用户全局 Hermes Agent）
- **9545**：Vite dev server（`web/vite.config.ts` 写死，strictPort）

## Rust 测试约定

- **单元测试**：`#[cfg(test)] mod tests { ... }` 内嵌在源文件底部，可触及私有函数；新增 module 一定要带
- **集成测试**：跨模块或带 HTTP/FS mock 的测试放仓库根 `tests/` 目录，仅依赖 `pub` API；用 crate 名 `hermes_agent_cn` 引入
- **env 依赖测试**：必须 `#[serial_test::serial]`，否则会被并行测试污染
- **文件系统测试**：用 `tempfile::TempDir`，禁止写 `/tmp`、cwd 或固定路径
- **HTTP 测试**：用 `wiremock::MockServer`，禁止打真实网络
- **断言**：优先 `pretty_assertions::assert_eq` 拿更好的 diff
- **CI**：`.github/workflows/rust-test.yml` 在 PR / push 到 main 时跑 `cargo fmt --check`、`cargo clippy -D warnings`、`cargo test`
- **本地**：改完后跑 `cargo test --all-features`；运行 dashboard 相关测试不需要起 hermes 后端，全部走 mock
