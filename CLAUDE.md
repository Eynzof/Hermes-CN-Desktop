# Claude 工作指引

## 项目概述

Hermes Agent CN 桌面端 — 用 Tauri v2 + React 构建的独立桌面应用，替代原 Electron 壳。
对接后端是 [Hermes-CN-Core](https://github.com/Eynzof/Hermes-CN-Core)（CN 核心 runtime，原名 hermes-agent-cn）内置 Dashboard；桌面端 managed runtime 默认使用端口 9120，避开用户全局 Hermes Agent 常用的 9119。当前版本 **0.5.4**，bundle identifier 固定为 `cn.org.hermesagent.desktop`（升级安全承重标识，勿改）。版本号由 `pnpm version:sync` 以 `package.json` 为真相，传播到 `tauri.conf.json` / `Cargo.toml` / `Cargo.lock` / 各 workspace `package.json` / README，`pnpm version:check` 校验。

## 项目结构

```
Hermes-CN-Desktop/
├── src/                    Rust Tauri 后端（~24,000 行，crate lib 名 hermes_agent_cn）
│   ├── main.rs               入口：解析 HERMES_HOME、启动 dashboard、注册 60 个命令（generate_handler!）、系统托盘
│   ├── lib.rs / state.rs     库入口（声明 18 个 module）+ AppState（Mutex<AppStateInner>）
│   ├── tray.rs               系统托盘菜单
│   ├── error.rs              AppError 统一错误类型
│   ├── environment.rs / bootstrap.rs / connection.rs / path_resolver.rs / env_file.rs
│   ├── supervisor.rs / prevent_sleep.rs / cron_runs.rs / update_stage.rs / util.rs / ui_store.rs
│   ├── session_archive.rs / session_log.rs   会话归档与日志读取
│   ├── commands/             60 个 #[tauri::command]（22 个模块，列表见 main.rs 的 generate_handler!）
│   │   ├── api_proxy.rs         HTTP 代理（api_request / external_request / upload_file）
│   │   ├── ws_proxy.rs          /api/ws WebSocket 中继（webview 原生 WS 被拦时的兜底）
│   │   ├── gateway.rs           runtime config + gateway URL 刷新
│   │   ├── runtime_manager.rs   managed runtime 下载/更新/回滚
│   │   ├── desktop_update.rs    桌面端自更新
│   │   ├── profiles.rs          profile 切换（含故障恢复）
│   │   ├── config_migration.rs  配置迁移
│   │   ├── im_onboarding.rs     飞书/钉钉/企微/微信 接入引导
│   │   └── connection/memory/skills/terminal/backup/log_export/debug_bundle/notify/
│   │       preview/environment/file_dialogs/restart/ui_store/yolo/mod.rs
│   └── process/
│       ├── dashboard.rs         dashboard 子进程管理（probe/spawn/port fallback）
│       ├── gateway.rs           gateway 子进程 / 冲突检测
│       └── runtime.rs           managed runtime 安装/签名验证
├── web/                    React 前端（Vite + TanStack Query + Jotai）
│   ├── src/
│   │   ├── lib/tauri-bridge.ts    Tauri invoke 包装 + hermesDesktop shim
│   │   ├── lib/runtime.ts         平台检测（web / electron / tauri）
│   │   ├── lib/transport.ts       HTTP 路由（native IPC vs fetch）+ auth header 注入
│   │   ├── lib/gateway-client.ts  网关 WS 客户端（JSON-RPC over /api/ws，退避/唤醒重连/session.resume）
│   │   └── lib/gateway-socket-path.ts  原生 WS vs Rust 中继的 socket 路径选择与自动回退
│   └── vite.config.ts
├── packages/
│   ├── protocol/              Zod schemas（hermes-api.ts）、IPC 类型、会话日志解析
│   └── shared-ui/             设计 token（tokens/*.css）、components/composites/hooks
├── e2e/                       Playwright E2E（真实 web → 真实 Core 后端 → 本地 fake model）
├── tests/                     Rust 集成测试（crate 名 hermes_agent_cn）
├── static/                    打包 stage 目标（bundled-runtime / -skills / -plugins / dashboard）
├── Cargo.toml                 Rust 依赖
├── tauri.conf.json            Tauri 窗口/打包/CSP 配置
├── pnpm-workspace.yaml        pnpm monorepo（web + packages/* + e2e）
└── package.json               workspace root + 构建脚本
```

## 后端事实来源

UI 对接的是 hermes-agent Dashboard。**不要凭参数名猜后端行为**。

后端源码在同级的 `../Hermes-CN-Core`（`pnpm tauri:dev` 默认从这里安装 managed runtime，可用 `--source` 覆盖）。查：
- REST 路由：`hermes_cli/web_server.py`
- Gateway 事件：`tui_gateway/server.py`
- 上游 Web 实现：`web/src/lib/api.ts`、`gatewayClient.ts`

## 开发流程

### 开发前预检（双仓同步 + Worktree 隔离）

Hermes CN 的需求与 bug 修复通常**同时横跨 Desktop 与 Core 两个仓库**。正式动手写代码前，两个仓库都必须先过这道预检，**不要直接在 `main` 上改**：

1. **确认主分支已与远端同步**。对 Desktop 与 Core 分别 `git fetch origin`，确认本地 `main` 与 `origin/main` 一致（`git rev-list --left-right --count main...origin/main` 应为 `0  0`）；落后就先快进，工作区脏就先收拾干净。
2. **为每个仓库开独立的功能分支 + git worktree**，让 Desktop 与 Core 的改动互不干扰、可并行：
   ```bash
   git -C <repo> fetch origin
   git -C <repo> worktree add ../wt/<repo>-<topic> -b <branch> origin/main
   ```
   分支命名沿用 Conventional 风格（`feat/` `fix/` `docs/` `chore/` …）。同一任务在两仓用同名分支，方便对应。
3. 不要在同一个工作目录里来回 `git checkout` 切分支——双仓并行时极易串味；每条线一个 worktree。

**收尾流程（每个仓库都要走完，缺一不可）**：改完 → `pnpm typecheck && pnpm test:unit && cargo check` → commit → push → 开 PR → **盯 PR 上 GitHub Actions 的构建与测试全绿**（`rust-test.yml` / `web-test.yml`），没过就回去修，别把任务当完成。

### 仓库技能

双仓库（Desktop + Core）最新分支启动、dev 冒烟或打包态补验，必须参考：
`.codex/skills/desktop-dual-repo-test/SKILL.md`。

发版、版本号更新、安装包发布或 GitHub Release 相关任务必须参考仓库内技能。**发版前先过**发版前预检（覆盖升级安全性：防内核静默降级 / 防 schema 重置 / identifier 不变 / 公证签名 / 国内镜像 / 先发 canary）：
`.codex/skills/desktop-release-preflight/SKILL.md`；
随后再做版本同步与官网清单：
`.codex/skills/desktop-release-sync-landing/SKILL.md`。
只要桌面端公开版本发生变化，就必须同步处理 `Eynzof/hermes-agent-cn-desktop-landing`，
更新官网版本与 `https://desktop.hermesagent.org.cn/latest.json` 清单；如果 release 资产尚未生成，
需要明确说明 Landing 同步被阻塞，不能把桌面端发版任务当作已经完整结束。

### 启动顺序

一步起 Tauri dev（推荐）。`scripts/tauri-dev-managed.mjs` 会先把后端装进桌面 managed runtime 目录、禁用 PATH 上的全局 hermes，再启动 Tauri dev（自动加载 Vite devUrl 9545）：

```bash
pnpm tauri:dev                                 # 托管 runtime
pnpm tauri:dev -- --source ../Hermes-CN-Core   # 指定本地后端源码安装进 runtime
# pnpm tauri:dev:external 现已是 deprecated 别名：桌面端锁 managed runtime，它现在跑的就是和 tauri:dev 相同的 managed 路径
```

手动分步（调试 Rust 时用）：
```bash
hermes dashboard --no-open   # 终端 1：先起后端 Dashboard
pnpm web:dev                 # 终端 2：Vite dev server（9545）
pnpm tauri:run               # 终端 3：cargo run
```

### 改完代码必做

```bash
pnpm typecheck        # license:check + version:check + 各 workspace typecheck
pnpm test:unit        # 全部 vitest 单元测试（~93 个测试文件，逐 workspace 串行 workspace-concurrency=1）
cargo check           # Rust 编译检查
```

### 打包

```bash
pnpm tauri:build           # Release：web build + cargo tauri build
pnpm tauri:build:debug     # Debug：带调试信息的 .app / .dmg

# 带内置 runtime / dashboard / skills / plugins 的发布包（先 stage 再打包）
pnpm tauri:build:bundled-windows         # NSIS
pnpm tauri:build:bundled-macos-arm64     # dmg (aarch64)
pnpm tauri:build:bundled-macos-intel     # dmg (x86_64)
```

产物在 `target/release/bundle/` 或 `target/debug/bundle/`。`scripts/stage-bundled-runtime.mjs`、`stage-bundled-skills.mjs`、`stage-bundled-plugins.mjs`、`stage-dashboard-web-dist.mjs` 负责把后端 runtime、dashboard web dist、skills、plugins 拷进 `static/` 打包目录。

## 架构约定

### Dev 模式 vs 生产模式

| | Dev 模式 | 生产模式 |
|--|---------|---------|
| WebView 加载 | `http://localhost:9545`（Vite） | 打包的 `web/dist/` |
| REST API | Vite proxy → dashboard（同源） | Rust IPC 代理（`api_request` command） |
| 网关 WebSocket | `ws://localhost:9545/api/ws` → Vite proxy（`ws: true`） | webview 直连 `ws://127.0.0.1:<port>/api/ws`；被拦则 Rust 中继（`ws_proxy.rs`） |
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

唯一传输是 **JSON-RPC over WebSocket（官方 `/api/ws`）**，与官方桌面端（Core `apps/desktop`）
架构一致；SSE+POST 旧路径（P-009）已删除。`gateway-client.ts` 是协议层 + 重连编排
（1→15s 指数退避、唤醒/online/visibility 触发、重连后 `session.resume`；**对齐官方桌面端不主动发 synthetic ping**，半开连接靠 close/error + RPC 超时 + OS 唤醒兜底）。
socket 载体由 `gateway-socket-path.ts` 选择：默认 webview 原生 WebSocket 直连；打包态
webview 拦 `ws://` 时自动回退到 Rust 中继（`ws_proxy.rs`，线协议不变），结果粘性记忆在
`HERMES_WS_PATH_LEARNED`，QA 可用 `?wspath=native|relay` 强制覆盖。
详见 `docs/gateway-connection-overhaul.md`。

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
- **CI**（PR / push 到 main）：`rust-test.yml`（`cargo fmt --check`、`cargo clippy -D warnings`、`cargo test`）、`web-test.yml`（typecheck + vitest）、`web-e2e.yml`（Playwright E2E，checkout `Eynzof/Hermes-CN-Core` 真实后端 + fake model）；`release-desktop.yml` 负责发布构建
- **本地**：改完后跑 `cargo test --all-features`；运行 dashboard 相关测试不需要起 hermes 后端，全部走 mock
