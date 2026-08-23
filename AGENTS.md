# Codex 工作指引

## 项目概述

Hermes Agent CN 桌面端 — 用 Tauri v2 + React 构建的独立桌面应用，替代原 Electron 壳。
对接后端是 [Hermes-CN-Core](https://github.com/Eynzof/Hermes-CN-Core)（CN 核心 runtime，原名 hermes-agent-cn）内置 Dashboard；桌面端 managed runtime 默认使用端口 9120，避开用户全局 Hermes Agent 常用的 9119。当前版本 **0.5.4**，bundle identifier `cn.org.hermesagent.desktop`（升级承重标识，勿改）。

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
├── packages/                TypeScript runtime（Python 后端已全量重写为 TS，详见 docs/typescript-runtime.md）
│   ├── agent-core/            agent 核心：回合循环、LLM provider 适配、会话、审批、压缩、记忆、skills、MoA…
│   ├── agent-tools/           工具目录/注册/分发、toolsets、Spotify/消息/HA/Meet 集成
│   ├── browser/               浏览器自动化（backend 注册、SSRF 防护、快照）
│   ├── credential-pool/       凭证池与轮换策略
│   ├── dashboard/             本地 dashboard 路由/鉴权/REST
│   ├── gateway-core/          网关服务：事件总线、会话、投递、slash 命令
│   ├── messaging-platforms/   29 个消息平台 adapter（Telegram/Discord/钉钉/飞书/企微/微信…）
│   ├── protocol/              Zod schemas、IPC 类型、会话日志解析
│   ├── shared-ui/             设计 token（tokens/*.css）、components/composites/hooks
│   └── skill-lint/            SKILL.md lint 规则与 CLI
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

> 注意：Python 后端功能已在 `packages/` monorepo 全量重写为 TypeScript（进程内运行，
> 无浏览器/无后端也可跑，架构见 `docs/typescript-runtime.md`）；managed runtime（Python
> Hermes-CN-Core）仍保留作为桌面端托管内核路径。

后端源码在同级的 `../Hermes-CN-Core`（`pnpm tauri:dev` 默认从这里把 backend 装进桌面 dev-runtime，可用 `--source` 覆盖）。查：
- REST 路由：`hermes_cli/web_server.py`
- Gateway 事件：`tui_gateway/server.py`
- 上游 Web 实现：`web/src/lib/api.ts`、`gatewayClient.ts`

### 后端版本同步

桌面端在启动时会通过 `GET /api/version` 校验所连后端的版本，期望值写死在 `web/src/lib/build-info.ts` 的 `EXPECTED_BACKEND_VERSION`。 bumps Core `pyproject.toml` 版本时，**必须在同一次发版变更里同步更新 `EXPECTED_BACKEND_VERSION`**，否则新版桌面端启动时会直接弹出版本不匹配对话框并强制退出。

## 开发流程

### Git 操作边界（铁律）

编码代理**绝不自动执行**任何 Git 写操作：不 `git commit` / `git push` / `git pull` / `git fetch` / `git checkout`、不创建 `git worktree` / 分支、不开 PR、不打 tag、不发布 Release、不同步 landing 仓库。

所有仓库同步、分支 / worktree 隔离、commit、push、PR、tag、Release 与 Landing 同步均由**人**执行（或由 CI/CD 流水线触发）。代理只做只读检查（`git status` / `git diff` / `git log` / `git rev-parse`）用于验证与报告。

完整的人工 Git 工作流（双仓同步 + worktree 预检、收尾 commit → push → PR、Commit 风格、发版 tag 与 Landing 同步）见 `docs/agents/git-workflow.md`。

### 开发前准备

- 确认当前工作目录位于**人已准备好**的仓库状态（已同步、已开好分支 / worktree）；不要自己 `git checkout` 切分支或同步远端。
- 需求同时横跨 Desktop 与 Core 时，人会用独立 worktree 隔离两仓改动；代理不要自己创建 / 操作 worktree。
- 若发现工作区状态异常（脏树、分支不对、落后远端），**报告给人处理**，不要自行 commit / stash / reset / pull。

### 仓库技能

开始任何工作前，必须先阅读项目结构技能：`.codex/skills/project-structure/SKILL.md`。

双仓库（Desktop + Core）最新分支启动、dev 冒烟或打包态补验，必须使用：
`.codex/skills/desktop-dual-repo-test/SKILL.md`。

发版、版本号更新、安装包发布或 GitHub Release 相关任务必须按顺序使用仓库内技能：**先过** `.codex/skills/desktop-release-preflight/SKILL.md`（发版前安全闸门：防内核静默降级 / 防 schema 重置 / identifier 不变 / 公证签名 / 国内镜像先有 artifactUrl 再发清单 / 先发 canary），**再做** `.codex/skills/desktop-release-sync-landing/SKILL.md`（版本同步与官网清单）。
只要桌面端 **stable/正式公开版本** 发生变化，就必须同步处理 `Eynzof/hermes-agent-cn-desktop-landing`，
更新官网版本与 `https://desktop.hermesagent.org.cn/latest.json` 清单；如果 release 资产尚未生成，
需要明确说明 Landing 同步被阻塞，不能把正式发版任务当作已经完整结束。**Landing 仓库的 commit / push / PR 由人执行**，代理只负责准备与核对内容、报告阻塞情况（见 `docs/agents/git-workflow.md` §5）。
**RC / beta / alpha / canary 等预发布或内测版本禁止修改 Landing 仓库，禁止更新官网版本，
禁止让 `https://desktop.hermesagent.org.cn/latest.json` 指向预发布版本。** 预发布版本只能通过
GitHub Release、手工分发或明确的内测渠道验证，不能暴露给全量用户的官网入口和自动更新清单。

### 启动顺序

一步起 Tauri dev（推荐）。`pnpm tauri:dev` 会先 `version:sync`，再跑 `scripts/tauri-dev-managed.mjs`：把后端装进桌面 dev-runtime、禁用 PATH 上的全局 hermes，再启动 Tauri dev（自动加载 Vite devUrl 9545）：

```bash
pnpm tauri:dev                                 # 托管 runtime（默认 source = ../Hermes-CN-Core）
pnpm tauri:dev -- --source ../Hermes-CN-Core   # 指定本地后端源码安装进 runtime
# pnpm tauri:dev:external 现已是 deprecated 别名：桌面端锁 managed runtime，跑的就是和 tauri:dev 相同的 managed 路径
```

手动分步（调试 Rust 时用）：
```bash
hermes dashboard --no-open   # 终端 1：先起后端 Dashboard
pnpm web:dev                 # 终端 2：Vite dev server（9545）
pnpm tauri:run               # 终端 3：cargo run（tauri:run = cargo run，不是 tauri dev）
```

### 改完代码必做

```bash
pnpm typecheck        # license:check + version:check + 各 workspace typecheck
pnpm test:unit        # 全部 vitest 单元测试（~93 个测试文件，逐 workspace 串行）
cargo check           # Rust 编译检查
```

### 打包

```bash
pnpm tauri:build           # Release：web build + cargo tauri build
pnpm tauri:build:debug     # Debug：带调试信息的 .app / .dmg
```

产物在 `target/release/bundle/` 或 `target/debug/bundle/`。带内置 runtime/dashboard/skills/plugins 的发布包用 `pnpm tauri:build:bundled-{windows,macos-arm64,macos-intel}`；`scripts/stage-bundled-*.mjs` 与 `stage-dashboard-web-dist.mjs` 把 runtime / dashboard web dist / skills / plugins 拷进 `static/`。

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

唯一传输是 **JSON-RPC over WebSocket（官方 `/api/ws`）**，与 Core 官方桌面端架构一致；SSE+POST 旧路径（P-009）已删。
`gateway-client.ts` 负责协议层与重连编排：1→15s 指数退避、唤醒/online/visibility 触发、重连后 `session.resume`；**对齐官方桌面端不主动发 synthetic ping**，半开连接靠 close/error + RPC 超时 + OS 唤醒兜底。`gateway-socket-path.ts` 在原生 WebSocket 和 Rust 中继之间选择（`?wspath=` query > `HERMES_WS_PATH_LEARNED` 学习值 > 默认 native 自动回退 relay）；打包态 webview 拦 `ws://` 时回退到 `ws_proxy.rs`，线协议仍是 `/api/ws` 不变。详见 `docs/gateway-connection-overhaul.md`。

## 不要做的事

- ❌ 不要在 `web/src/lib/transport.ts` 之外手写 fetch — auth header 注入在 transport 层
- ❌ 不要直接调 `gateway-client.ts` 的 raw socket — 走 `hooks/use-gateway.ts`
- ❌ 不要在 `web/src/routes/` 里塞业务逻辑 — 抽到 `hooks/` 或 `lib/`
- ❌ 不要在组件里写硬编码颜色 — 用 `packages/shared-ui/src/tokens/` 里的 CSS 变量
- ❌ **不要自动执行任何 Git 写操作**（commit / push / pull / checkout / worktree / 开 PR / 打 tag / 发 Release / 同步 landing）— 全部由人执行，见 `docs/agents/`

## 端口

- **9120**：Hermes Dashboard（桌面端 managed runtime 默认后端；9119 通常留给用户全局 Hermes Agent）
- **9545**：Vite dev server（`web/vite.config.ts` 默认值，strictPort；Windows 可能因 Hyper-V/WSL2 的“排除端口范围”屏蔽 9545 —— `run.py` 与 vite config 都会在启动时探测并自动回退到空闲端口，见 `docs/run-py-usage.md` 的 EACCES FAQ）

## Rust 测试约定

- **单元测试**：`#[cfg(test)] mod tests { ... }` 内嵌在源文件底部，可触及私有函数；新增 module 一定要带
- **集成测试**：跨模块或带 HTTP/FS mock 的测试放仓库根 `tests/` 目录，仅依赖 `pub` API；用 crate 名 `hermes_agent_cn` 引入
- **env 依赖测试**：必须 `#[serial_test::serial]`，否则会被并行测试污染
- **文件系统测试**：用 `tempfile::TempDir`，禁止写 `/tmp`、cwd 或固定路径
- **HTTP 测试**：用 `wiremock::MockServer`，禁止打真实网络
- **真实后端测试（opt-in）**：`tests/real_backend.rs` 是 wiremock 套件的真实后端版，默认跳过（无 `HERMES_REAL_BACKEND_URL` 且找不到 `../Hermes-CN-Core` 时静默通过），CI 保持封闭；配置 `HERMES_REAL_BACKEND_URL`（外部后端）或 `HERMES_CORE_DIR`（自动起 Core venv dashboard）后跑 `cargo test --test real_backend`
- **断言**：优先 `pretty_assertions::assert_eq` 拿更好的 diff
- **CI**（PR / push 到 main）：`rust-test.yml`（`cargo fmt --check`、`cargo clippy -D warnings`、`cargo test`）、`web-test.yml`（typecheck + vitest）、`web-e2e.yml`（Playwright E2E，checkout `Eynzof/Hermes-CN-Core` 真实后端 + fake model）、`release-desktop.yml`（发布构建）
- **本地**：改完后跑 `cargo test --all-features`；运行 dashboard 相关测试不需要起 hermes 后端，全部走 mock
