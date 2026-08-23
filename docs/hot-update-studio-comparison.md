# hermes-studio 热更新机制调查 与 CN 桌面版对照

> 状态：调查报告（2026-07-18） · 调查对象：`hermes-studio`（上游 Electron 版桌面/Web UI）
> 对照对象：`Hermes-CN-Desktop`（Tauri 外壳，v0.6.3）+ `Hermes-CN-Core`（Python 内核，0.18.2）
> 相关文档：[`hot-update-plan.md`](./hot-update-plan.md)（能力矩阵与路线图）、[`hot-update-impl-plan.md`](./hot-update-impl-plan.md)（落地实施方案）

本报告回答两个问题：**(1) hermes-studio 的"热更新"具体如何实现；(2) CN 桌面版与之对照的差距与补齐路径**。
所有 hermes-studio 结论均基于本地源码核对（路径相对其仓库根），CN 侧结论以 v0.6.3 代码为准。

## TL;DR

1. hermes-studio 的"热更新"不是单一机制，而是**三条彼此独立的链路**：electron-updater 外壳自更新、运行时（Python+Node）独立 OTA、会话内 `/reload-mcp` `/reload-skills` 热重载（另有面向服务器部署的 npm 自更新，与桌面无关）。**没有**文件监听式的"改文件即生效"生产热加载。
2. CN 桌面版的**内核 runtime OTA（轨道 A）已实现且在安全性上超越上游**（上游只有 SHA256，CN 侧是 Ed25519 验签 + SHA256 双校验 + 冒烟测试 + 原子换入 + 单步回滚）；会话内热重载与上游**等价**（同在 Core 侧）。
3. 真正的差距是两块：**外壳自更新（轨道 C）缺失**——这正对应上游的 electron-updater；**UI 热更通道（轨道 B）缺失**——上游也没有这个能力，属于超越项。两者的落地方案见 [`hot-update-impl-plan.md`](./hot-update-impl-plan.md)。

---

## 一、hermes-studio 的热更新实现（逐链路）

### 1.1 外壳自更新 — electron-updater（更新整个 App 安装包）

- 依赖：`electron-updater ^6.3.9`（`packages/desktop/package.json:40`）。
- 核心文件：`packages/desktop/src/main/updater.ts`。
- 更新源双通道：**Cloudflare 优先、GitHub Releases 兜底**——
  `CLOUDFLARE_LATEST_FEED_URL = https://download.ekkolearnai.com/latest`（`updater.ts:16`），
  `GITHUB_LATEST_FEED_URL = https://github.com/EKKOLearnAI/hermes-studio/releases/latest/download`（`updater.ts:17`）；
  `checkForUpdatesWithFallback()` 先打 Cloudflare，失败切 GitHub（`updater.ts:33-47`）。
- 交互流程：`autoDownload=false` → `update-available` 弹窗让用户确认下载 → 下载完 `update-downloaded` 再弹窗 → `autoUpdater.quitAndInstall()` 重启安装。启动时自动检查一次（可用 `HERMES_DESKTOP_ENABLE_AUTO_UPDATE=false` 关闭），托盘菜单可手动触发。
- Windows 专项：安装前用 PowerShell 关闭其它同路径实例、清理卡住的 pending 更新目录（`updater.ts` + `updater-helpers.ts`）。
- 完整性保障：electron-updater 内置的 feed（`latest*.yml`）SHA512 校验；**无额外的自有签名体系**。

### 1.2 运行时独立 OTA — runtime-manager.ts（只更新内置 Python/Node 运行时，不动 Electron 壳）

这是与 CN 轨道 A 同构的机制：桌面 App 内捆绑的"运行时"（Python + hermes-agent + Node + Git）走独立下载通道。

- 核心文件：`packages/desktop/src/main/runtime-manager.ts`；入口 `ensureDesktopRuntime()`（:366），启动 bootstrap 时调用。
- 链路：解析 manifest（Cloudflare `download.ekkolearnai.com` 或 GitHub Releases）→ 带进度下载（进度打到启动闪屏）→ **SHA256 校验**（:395-401）→ tar.gz 解压到临时目录 → **原子 rename** 落地 → 写 `active-version.json` 活动版本记录（:264-278）。
- 触发条件：运行时缺失、`HERMES_DESKTOP_RUNTIME_FORCE_UPDATE`、或 URL/manifest 覆盖。App 升级本身不会仅因版本变化重下运行时。
- 版本比较：`runtime-version.ts`（`compareHermesAgentVersions` 等），打包期写入 `build/runtime-release.json` 提供期望版本。
- **安全性边界：只有 SHA256 摘要，无签名验证、无冒烟测试、无一键回滚**——这是 CN 轨道 A 超越的部分（见 §2）。

### 1.3 会话内热重载 — /reload-mcp 与 /reload-skills（不重启进程）

- 聊天会话命令 `reload-mcp` / `reload-skills`（`packages/server/src/services/hermes/run-chat/session-command.ts:779/:807`，仅会话 idle 时允许），经 agent-bridge 转发给底层 Python hermes-agent 进程（`agent-bridge/client.ts:770/:775`），在不重启 agent 的前提下重新加载 MCP 连接与技能。另有 HTTP 入口 `POST /api/hermes/mcp/reload`。
- 性质：**用户显式触发的 reload，不是文件监听自动生效**。全仓无 chokidar / `fs.watch` / SIGHUP 式的生产热加载。

### 1.4 npm 自更新（服务器/独立部署形态，与桌面无关）

- 版本轮询：`packages/server/src/controllers/health.ts:106` 每 30 分钟查 npm registry，经 health 接口暴露 `webui_update_available`。
- 执行：`POST /api/hermes/update` → `npm install -g hermes-web-ui@latest` → 3 秒后经 **SIGUSR2** 优雅重启守护进程（`controllers/update.ts:1039-1058`、`services/shutdown.ts:132`、`bin/hermes-web-ui.mjs`）。
- 桌面内嵌的 Web UI 通过 `HERMES_WEB_UI_DISABLE_UPDATE_CHECK=true` 关闭了这条链路（`webui-server.ts:389`），避免误提示。
- 另有超管专用的 **Version Preview**（`git clone` 指定 tag 到隔离端口另起一份 dev 实例做 A/B 试新版，`controllers/update.ts` preview 系列）——属运维辅助，非用户侧热更。

### 1.5 开发态 HMR（仅开发环境）

前端 Vite HMR + 后端 nodemon 重启（`nodemon.json` 监听 `packages/server/src`、`packages/ekko-agent/src`）。生产运行的是构建产物，不存在这套机制。

---

## 二、CN 桌面版三轨道对照

CN 桌面版的更新体系按 [`hot-update-impl-plan.md`](./hot-update-impl-plan.md) 划分为三条独立轨道：

| 能力 | hermes-studio（上游） | Hermes-CN-Desktop（v0.6.3） | 对照结论 |
|---|---|---|---|
| **内核/运行时 OTA** | ✅ `runtime-manager.ts`：manifest → 下载 → **仅 SHA256** → 解压 → 原子 rename → active-version.json；无签名/冒烟/回滚 | ✅ **轨道 A** `src/process/runtime.rs`：manifest → **Ed25519 验签（下载前，签名覆盖 artifactUrl+sha256 等 12 字段）** → 强制 https 下载 → **SHA256 复验** → zip 护栏解压 → **冒烟测试** → 原子换入 `versions/<v>/` + `current.json` 指针 → **单步回滚** | **CN 已超越**。遗留保险栓：`minAppVersion` 死字段、更新判定纯字符串 `!=` 无防降级、`update_stage.rs` 进度状态机未接活 |
| **外壳自更新** | ✅ electron-updater（双源 feed、弹窗确认、`quitAndInstall`） | ❌ **轨道 C 缺失**：仅 `src/commands/desktop_update.rs` 检查通知（拉未签名的 `latest.json`、弹窗引导去官网手动重装），无 `tauri-plugin-updater` | **CN 最大差距**，对应上游 electron-updater 的位置。补齐路径：接 `tauri-plugin-updater`（minisign + `latest.json` + CI 产 `.sig`） |
| **UI 层热更** | ❌ 无独立通道（UI 随 Electron 壳整包更新） | ❌ **轨道 B 缺失**：`web/dist` 编译进二进制（`tauri.conf.json` frontendDist） | 双方都没有；CN 落地后属**超越项**（纯前端改动秒级下发，无需整包重装）。方案：签名 UI 包 + `hermesui://` 自定义协议 + `appVersionFloor` 闸门 + 回退内嵌包 |
| **会话内热重载** | ✅ `/reload-mcp` `/reload-skills`（经 agent-bridge 转发） | ✅ Core 侧原生 `/reload-mcp` `/reload-skills`（`gateway/slash_commands.py`、`agent/skill_commands.py`） | **等价**（本质是同一 Core 能力），桌面端无需动作 |
| **更新分发基础设施** | Cloudflare（`download.ekkolearnai.com`）主源 + GitHub Releases 兜底 | GitHub Releases 为主，官网 `latest.json` 在 Cloudflare Pages（`desktop.hermesagent.org.cn`）；runtime `artifactUrl` 在签名载荷内（迁移镜像须签名前改 URL 重签） | 上游的"双源 + 大陆可达 CDN"思路值得对齐；CN 侧约束见 impl-plan §2/§3.2 |
| **npm 自更新** | ✅（服务器部署形态） | 不适用（CN 桌面无 npm 分发形态） | — |

### 关键架构差异对比

- **上游**：Electron 单进程家族，UI 与壳一体（UI 更新=整包更新），运行时是"下载到 app-data 的目录 + active-version.json"。
- **CN**：Tauri 壳（Rust）+ 内嵌 React UI + **managed runtime**（PyInstaller onedir 的 Core，作为托管子进程被 spawn，`versions/<v>/ + current.json` 指针树）。内核可独立热更并只重启子进程，天然比上游解耦更彻底；代价是壳与 UI 的更新通道需要各自新建。

---

## 三、差距结论与补齐路径

1. **轨道 A（内核 OTA）**：机制已完备，只需"上保险栓"——`minAppVersion` 纳入签名并启用强升闸门（signer schema 2→3，**客户端先行**）、semver 防降级、接活 `update_stage.rs` 进度状态机。→ impl-plan §3。
2. **轨道 C（外壳自更新）**：对标上游 electron-updater，接 `tauri-plugin-updater`（minisign 签名、`latest.json` endpoint、CI 产 `.sig`；macOS 公证后重打 `.app.tar.gz`；Windows Authenticode 就位前不开静默安装）。→ impl-plan §5。
3. **轨道 B（UI 热更）**：新建签名 UI 包通道（复用轨道 A 引擎约 90%），`hermesui://` 自定义协议 + 可写目录版本树 + 签名 `appVersionFloor` 闸门 + 永不砖化的内嵌包回退。→ impl-plan §4。
4. **热重载**：无需动作，Core 已等价。

实施排程（阶段依赖、双仓分支、发布顺序约束）见 [`hot-update-impl-plan.md`](./hot-update-impl-plan.md) 与对应落地计划。
