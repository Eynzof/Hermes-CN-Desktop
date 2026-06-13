# 官方桌面端 vs Hermes-CN-Desktop 功能差距盘点

> **文档状态**：v0.1（2026-06-13）
>
> **目的**：盘点**官方上游 Electron 桌面端有、而我们 Tauri 重写版（Hermes-CN-Desktop）尚缺**的功能，**重点突出最新 v0.16.0 同步带来的新增**，并给出优先级与「是否已在现有 PRD 计划内」的标注，作为后续对齐排期的依据。
>
> **参考（不重复其内容）**：
> - 原型逐页功能：[`00-feature-inventory.md`](./00-feature-inventory.md)
> - 范围 / 决策 / 非目标：[`01-prd.md`](./01-prd.md)
> - 后端 API 契约：[`04-backend-contract.md`](./04-backend-contract.md)
> - 架构：[`../../CLAUDE.md`](../../CLAUDE.md)、[`../managed-runtime.md`](../managed-runtime.md)、[`../gateway-connection-overhaul.md`](../gateway-connection-overhaul.md)

---

## 1. 概述

| | 官方桌面端 | 我们 |
|---|---|---|
| 形态 | **Electron**（Vite + React 19） | **Tauri v2**（Rust + React） |
| 来源 | 上游 vendored 进 `Hermes-CN-Core/apps/desktop`，随上游整块同步 | 独立仓库 `Hermes-CN-Desktop`，对接 Core 内置 Dashboard，只做外接壳层 |
| 版本 | app `0.15.1` / runtime **v0.16.0**（`runtime-v0.16.0-cn.6`） | `0.3.x` |
| 路径 | `Hermes-CN-Core/apps/desktop/src/app/*` | `Hermes-CN-Desktop/web/src/routes/*` + `src/commands/*` |

**一句话结论**：两端后端共用同一个 Dashboard，因此「能力上限」一致；差距集中在**前端功能面**——官方桌面端把更多后端能力做成了页面/交互，而我们 Tauri 端目前聚焦核心闭环 + 中文社区差异化（签名 runtime、YOLO、CN IM 扫码、备份迁移），尚未铺开官方的产物归档、子代理监视、命令面板、富预览、多 profile 等。

**差距概览**：

| 优先级 | 数量 | 主要条目 |
|---|---|---|
| 🔴 高 | 3 | 对话右栏富预览（三栏）、全局命令面板 ⌘K、多 Profile / 单 global-remote 架构 |
| 🟡 中 | 5 | 富 Composer（队列/`@`/URL 弹窗）、产物归档页、子代理监视页、Profile rail 交互、统一消息平台页 |
| 🟢 低 | 5 | Composer 语音 I/O、命令中心聚合、拖会话成 `@session`、onboarding 跳过、深链接（已主动推后） |

> 标注约定：**PRD 状态** = 「已计划(原型号)」表示 [`01-prd.md`](./01-prd.md) 已纳入范围但未实现；「非目标」表示 PRD §3.2 明确推后；「未提及」表示现有 PRD 未覆盖、需新立项。

---

## 2. 重点：v0.16.0 最新版本带来的桌面差距

以下为本次（及邻近几次）上游同步**新引入**的桌面能力，commit 均可在 `Hermes-CN-Core` 当前分支 `git log -- apps/desktop` 查到。

| 能力 | 官方实现（commit / 路径） | 我们现状 | 优先级 | PRD 状态 |
|---|---|---|---|---|
| **多 Profile / 单 global-remote dashboard** | 可在**一个远端后端**上并发切换多 profile：独立 gateway socket、per-profile 远端 host、all-profiles 统一会话视图、per-profile「+」新建。`02d6bf1c3`(#39921)、`4891f9ae7`、`1a3e60852`(#39778)、`7b4acadfe`、`83c13862f`/`3045d5454` | 切 profile 走「停掉本地 owned dashboard → 重启」模型（`src/commands/profiles.rs` `switch_profile`），**无并发 socket、无 global-remote 多档、无 all-profiles 视图** | 🔴 高 | 未提及（架构级，需立项） |
| **Profile rail 交互** | rail 内 rename/删除、长按选配色、删活档可靠回退 default。`a40e20e13`、`1b01fa3ac`、`f764b0400` | `web/src/routes/profiles.tsx` 列表式，无彩色 rail / 长按配色 | 🟡 中 | 未提及 |
| **拖会话进 Chat 成 `@session` 链接** | 侧栏会话拖入 Composer 自动成 `@session` 引用 + spawn loader。`9dbd3c57d` | 无 | 🟢 低 | 未提及 |
| **Onboarding「稍后选供应商」跳过** | 首启可跳过供应商选择，后续再配；并清理残留 onboarding 错误。`9cc47b20c`(#39483)、`ab706a334` | 轻引导（PRD D9），无等价「稍后再选」跳过路径 | 🟢 低 | 部分计划（proto 16/D9） |
| **每供应商最多列 50 模型** | 模型列表默认上限提到 50。`7f016f5f3` | 列表上限策略不同 | 🟢 低 | 未提及（小项） |
| ~~i18n zh-Hans 切换并持久化~~ | `4a1907bd1`、`1d9c3ebae` | **有意分歧，非差距**：我们 CN-first，PRD §3.2 明确把「完整国际化」列为非目标 | — | 非目标 |

> 提示：v0.16.0 同步还带来一批 **Windows ANR / 性能修复**（`10e5bbd33`、`b3cf4e6e9`、`976ea4da5`、`cedae80d4`）。这些是 Electron 主线程阻塞的针对性修复，我们 Tauri 架构不同、不直接对应，**不计入欠账**。

---

## 3. 整体功能差距（按功能域）

### 3.1 对话体验（Chat）

| 能力 | 官方实现 | 我们现状 | 优先级 | PRD 状态 |
|---|---|---|---|---|
| **右栏富预览（三栏）** | `app/chat/right-rail/{preview,preview-pane,preview-file,preview-console}.tsx`：网页沙箱 iframe 预览、文件/代码/JSON 预览、工具输出 console、**磁盘文件实时 watch** | `web/src/routes/detail.tsx` + `components/chat/message-timeline.tsx` 为**单栏时间线**，无集成预览（仅有独立 `console.tsx` 终端页、`logs.tsx` 日志页） | 🔴 高 | **已计划**（proto 03–06，PRD §5.1 三栏，未实现） |
| **富 Composer** | `app/chat/composer/`：斜杠 `/skill` 弹层（`skin-slash-popover.tsx`、`trigger-popover.tsx`）、`@`-mention 内联引用文件/URL/历史会话（`inline-refs.ts`）、URL 元数据弹窗（`url-dialog.tsx`）、**队列/批量发送**（`queue-panel.tsx`）、补全抽屉（`completion-drawer.tsx`） | `components/chat/goose-composer*.tsx` 有附件 + 模型选择（`lib/composer-skills.ts` 部分能力），**缺队列 / URL 弹窗 / `@`-mention / 斜杠弹层** | 🟡 中 | 部分计划（proto 02） |
| **Composer 语音 I/O** | 麦克风录音 + 静音检测（`composer/voice-activity.tsx`）+ Whisper 转写 + TTS 朗读 | **仅在设置暴露 `voice.*`/`tts.*` 配置项**（`lib/config-translations.ts`、`lib/env-translations.ts`），无录音 / 朗读 UI（后端已支持，缺前端） | 🟢 低 | 未提及 |

### 3.2 我们缺的独立页面

| 页面 | 官方实现 | 我们现状 | 优先级 | PRD 状态 |
|---|---|---|---|---|
| **产物归档 `/artifacts`** | `app/artifacts/index.tsx`：自动从会话抽取图片/文件/链接，按类型筛选、缩放查看、回链来源会话 | 无（仅 `routes/history.tsx` 会话历史 + 会话归档，语义不同） | 🟡 中 | 未提及 |
| **子代理监视 `/agents`** | `app/agents/index.tsx`：层级子代理树 + 实时状态（排队/运行/完成/失败）+ 流式输出 + 计时 | 仅时间线内联工具活动（`components/chat/tool-activity.ts`），无独立监视页 | 🟡 中 | 未提及 |
| **全局命令面板 ⌘K `/command-palette`** | `app/command-palette/index.tsx`：模糊搜会话/文件/命令/Skills/项目 | `cmdk` 仅用于 `components/settings/model-combobox.tsx`，**无全局面板** | 🔴 高 | **已计划**（proto 17，PRD §5.7，未实现） |
| **命令中心 `/command-center`** | `app/command-center/index.tsx`（v0.16.0 大改）：会话搜索 + 系统状态 + 用量分析聚一处 | 拆在 `routes/{history,health,analytics}.tsx`，**功能在但未聚合** | 🟢 低 | 部分覆盖（分散实现） |
| **统一消息平台页 `/messaging`** | `app/messaging/index.tsx`：统管 Telegram/Discord/Slack/Email + CN IM，带状态指示 / 冲突检测 / 测试连接 | 仅 **CN IM 扫码接入**（`routes/im-onboarding.tsx` + `src/commands/im_onboarding.rs` 飞书/钉钉/企微/微信）；国际平台仅能走通用 env 配置，无统一管理页 | 🟡 中 | 分歧（我们 CN IM 更深、官方国际平台更全） |

### 3.3 壳层 / 原生能力

| 能力 | 官方实现 | 我们现状 | 优先级 | PRD 状态 |
|---|---|---|---|---|
| **深链接 `hermes://`** | 如 `hermes://settings?tab=model` | 无 | 🟢 低 | **非目标**（PRD D8 明确推后，待 Web 公网部署成熟） |
| 富链接元数据 / 从 URL·剪贴板存图 | `fetchLinkTitle`、`saveImageFromUrl`、`saveClipboardImage` | 部分可走 `external_request`，无专门 UI | 🟢 低 | 未提及（小项） |

---

## 4. 我们独有的差异化能力（平衡对照）

以下为**官方 Electron 桌面端没有、而我们有**的能力，多为中文社区 / 桌面分发场景定制，说明差距并非单向：

- **签名校验 managed runtime + 更新 / 回滚**：`src/process/runtime.rs`、`src/commands/runtime_manager.rs`（Ed25519 验签，双版本回滚）
- **YOLO 模式**（按 profile，热重启生效）：`src/commands/yolo.rs`、[`../yolo-mode.md`](../yolo-mode.md)
- **CN IM 扫码接入**（飞书/钉钉/企微/微信 begin·poll·apply 流程）：`src/commands/im_onboarding.rs`
- **v0 配置迁移**：`src/commands/config_migration.rs`
- **Profile 备份 / 恢复 ZIP**：`src/commands/backup.rs`
- **调试包导出 + 环境自检**：`src/commands/debug_bundle.rs`、`src/environment.rs`、`src/path_resolver.rs`
- **桌面端自更新 + CN 网盘镜像**（百度/夸克盘）：`src/commands/desktop_update.rs`
- **SQLite 回合统计分析**：`src/ui_store.rs`、`web/src/routes/analytics.tsx`
- **WS-only 网关 + Rust 中继兜底**（webview 拦 `ws://` 时回退）：`src/commands/ws_proxy.rs`、[`../gateway-connection-overhaul.md`](../gateway-connection-overhaul.md)

---

## 5. 小结与建议

**优先补齐（🔴 高）**：

1. **对话右栏富预览（三栏）** —— 已在 PRD 计划内（proto 03–06），是「任务详情」核心体验，建议优先落地。
2. **全局命令面板 ⌘K** —— 已在 PRD 计划内（proto 17），`cmdk` 已引入，工程量可控。
3. **多 Profile / 单 global-remote 架构** —— 当前「重启切档」模型与官方差距最大，但属架构级改动，需单独立项评估（是否要支持 global-remote 多档）。

**择机补齐（🟡 中）**：富 Composer（队列 / `@` / URL 弹窗）、产物归档页、子代理监视页、Profile rail 交互、统一消息平台页。其中产物归档 / 子代理监视 / 统一消息平台均**未在现有 PRD 覆盖**，需先决定是否纳入。

**无需追（有意非目标，勿计入欠账）**：

- **完整 i18n / zh-Hans 切换** —— 我们 CN-first（PRD §3.2 非目标）
- **深链接 `hermes://`** —— PRD D8 主动推后
- **Webhooks / 触发器、日报、Profiles 多视图变体** —— PRD §3.2 / D4 / D6 / D7 已砍

---

## 6. 复核方式

本文档结论均经代码核查，可按下列方式复验：

- 官方页面存在性：`ls Hermes-CN-Core/apps/desktop/src/app/{artifacts,agents,command-palette,command-center,messaging}/index.tsx`
- 官方富 Composer / 右栏预览：`ls Hermes-CN-Core/apps/desktop/src/app/chat/{composer,right-rail}/`
- 我们缺失路由：`ls Hermes-CN-Desktop/web/src/routes/ | grep -iE 'artifact|agents|command-palette|command-center|messaging'`（应为空）
- v0.16.0 commit：`git -C Hermes-CN-Core show --stat <hash>`（如 `02d6bf1c3`、`9dbd3c57d`）确认改动落在 `apps/desktop`
