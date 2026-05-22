# Hermes Desktop · v2 · 后端契约

> **文档状态**：v0.1 草稿（2026-05-16）
>
> **关联文档**：[`01-prd.md`](./01-prd.md)、[`02-information-architecture.md`](./02-information-architecture.md)、[`03-feature-specs.md`](./03-feature-specs.md)
>
> **目标**：把原型 / PRD / IA / Specs 各处假设的"后端能力"逐项对照 Hermes Dashboard 与 Gateway 的真实接口，标出**已有、需要扩、确认不做**三种状态，作为桌面端实现的契约依据。

> **后端来源**：
> - REST：`hermes-agent-cn/hermes_cli/web_server.py`
> - Gateway JSON-RPC + SSE：`hermes-agent-cn/tui_gateway/server.py`
> - 桌面端调用面：`hermes-agent-cn-desktop/web/src/hooks/*` + `lib/transport.ts`

---

## 1. 后端架构总览

Hermes Dashboard 给桌面端提供**两条并行通道**，职责互补：

### 1.1 REST `/api/*`（HTTP）

定位：**系统级配置 + 一次性操作 + 离线查询**。

主要覆盖：

- 配置：`/api/config`、`/api/model/*`、`/api/env`
- 鉴权：`/api/providers/oauth/*`
- Profile（P-008 fork 扩展）：`/api/profiles/*`
- 资源列表：`/api/skills`、`/api/mcp-servers`、`/api/cron/jobs`
- 文件系统：`/api/fs/list`、`/api/upload`、`/api/logs`
- 监控：`/api/analytics/*`、`/api/status`
- 会话存档（FTS5 检索）：`/api/sessions/*`

### 1.2 Gateway JSON-RPC `/api/v2/rpc` + SSE `/api/v2/events`

定位：**实时双向通讯，所有"任务运行中"的流式交互**。

主要覆盖：

- Session 生命周期：create / resume / close / branch / interrupt / steer
- 消息流：`prompt.submit` ↔ `message.delta` / `message.complete`
- 工具执行：`tool.progress` / `tool.complete` / `tool.generating`
- 思考与推理：`thinking.delta` / `reasoning.delta` / `reasoning.available`
- 审批回路：`approval.request` ↔ `clarify.respond` / `sudo.respond` / `secret.respond` / `approval.respond`
- 命令与补全：`slash.exec`、`command.dispatch`、`complete.path`、`complete.slash`
- 配置同步：`config.get` / `config.set` / `skin.changed`
- "奇异"能力（v2 桌面端不用）：`voice.*`、`browser.*`

### 1.3 桌面端怎么选用

- **写状态 / 启动动作**：走 REST
- **实时事件 / 流式输出**：走 Gateway SSE + RPC
- **配置查询**：优先 REST（缓存简单），但 RPC 的 `config.get` 是同源数据
- **Session CRUD**：**只走 Gateway RPC**（虽然 REST 有 `/api/sessions/*`，但桌面端没用 — 桌面端把 session 视为"实时上下文"而非"档案"）

> ⚠️ **重要原则**：桌面端**不要绕过 transport 层**直接调 REST 或开 EventSource。所有 HTTP 通过 [`web/src/lib/transport.ts`](../../web/src/lib/transport.ts)（注入 auth header + 路由 native IPC / fetch），所有 SSE/WS 通过 [`web/src/lib/gateway-sse-client.ts`](../../web/src/lib/gateway-sse-client.ts)。CLAUDE.md 里写明的规则。

---

## 2. REST 路由现状清单

> 来源：`hermes-agent-cn/hermes_cli/web_server.py`。**√** 表示桌面端 v2 已经用上；**·** 表示未用。

### 2.1 配置 / 模型 / 环境变量

| 状态 | 路由 | 桌面端 hook |
|------|------|-------------|
| √ | `GET /api/config` | `useConfig` |
| √ | `GET /api/config/schema` | `useConfigSchema` |
| · | `GET /api/config/defaults` | 未用 |
| · | `GET/PUT /api/config/raw` | 未用（管理员 YAML） |
| √ | `PUT /api/config` | `useConfigMutation` |
| √ | `GET /api/model/info` | `useModelInfo` |
| · | `GET /api/model/options` | 未用（gateway RPC `model.options` 替代） |
| · | `GET /api/model/auxiliary` | 未用 |
| · | `POST /api/model/set` | 未用 |
| √ | `GET/PUT/DELETE /api/env` | `useEnvVars` / `useSetEnvVar` / `useDeleteEnvVar` |
| √ | `POST /api/env/reveal` | `useRevealEnv`（token-protected） |
| √ | `GET /api/status` | bootstrap 检测 |

### 2.2 OAuth（鉴权）

| 状态 | 路由 | 桌面端 hook |
|------|------|-------------|
| √ | `GET /api/providers/oauth` | `useOAuthProviders` |
| √ | `POST /api/providers/oauth/{id}/start` | `useStartOAuthLogin` |
| √ | `POST /api/providers/oauth/{id}/submit` | `useSubmitOAuthCode` |
| √ | `GET /api/providers/oauth/{id}/poll/{sid}` | `usePollOAuthSession`（2s 轮询） |
| √ | `DELETE /api/providers/oauth/{id}` | `useDisconnectOAuth` |
| √ | `DELETE /api/providers/oauth/sessions/{sid}` | `useCancelOAuthSession` |

### 2.3 Profile（P-008 fork）

| 状态 | 路由 | 桌面端 hook |
|------|------|-------------|
| √ | `GET /api/profiles` | `useProfiles` |
| √ | `GET/PUT /api/profiles/active` | `useActiveProfile` / `useSetActiveProfile` |
| √ | `POST /api/profiles` | `useCreateProfile` |
| √ | `DELETE /api/profiles/{name}` | `useDeleteProfile` |
| · | `PATCH /api/profiles/{name}` | 未用（编辑） |
| · | `GET /api/profiles/{name}/setup-command` | 未用 |
| · | `POST /api/profiles/{name}/open-terminal` | 未用（v2 项目详情会用到） |
| · | `GET/PUT /api/profiles/{name}/soul` | 未用（"灵魂"/人格设定，v2 不暴露） |

### 2.4 Skills / MCP / Cron

| 状态 | 路由 | 桌面端 hook |
|------|------|-------------|
| √ | `GET /api/skills` | `useSkills` |
| √ | `PUT /api/skills/toggle` | `useToggleSkill` |
| ❌ | （没有 Skill CRUD） | — |
| · | `GET /api/tools/toolsets` | 未用 |
| √ | `GET /api/mcp-servers` | `useMcpServers` |
| ❌ | （没有 MCP CRUD） | — |
| √ | `GET /api/cron/jobs` | `useCronJobs` |
| √ | `POST /api/cron/jobs` | `useCreateCronJob` |
| √ | `PUT /api/cron/jobs/{id}` | `useUpdateCronJob` |
| √ | `DELETE /api/cron/jobs/{id}` | `useDeleteCronJob` |
| √ | `POST /api/cron/jobs/{id}/{pause\|resume\|trigger}` | `useCronJobAction` |
| · | `GET /api/cron/jobs/{id}` | 未用（详情走列表筛过） |

### 2.5 Session 存档（v2 桌面端**不用 REST**，仅走 Gateway RPC）

| 状态 | 路由 | 备注 |
|------|------|------|
| · | `GET /api/sessions` | 桌面端走 RPC `session.list` |
| · | `GET /api/sessions/search` | 桌面端 v2 命令面板用此（待接入） |
| · | `GET /api/sessions/{id}` / `messages` / `latest-descendant` | 走 RPC `session.history` |
| · | `DELETE /api/sessions/{id}` | 走 RPC `session.delete` |

### 2.6 文件 / 日志 / 上传

| 状态 | 路由 | 桌面端 hook |
|------|------|-------------|
| √ | `GET /api/fs/list` | `useFsListing`（工作区选择器） |
| √ | `GET /api/logs` | `useLogs` |
| √ | `POST /api/upload` | `uploadAttachmentFile`（XHR） |

### 2.7 监控与系统

| 状态 | 路由 | 备注 |
|------|------|------|
| √ | `GET /api/analytics/usage` | `useAnalytics` |
| · | `GET /api/analytics/models` | 未用（Models 页可接入） |
| √ | `POST /api/gateway/restart` | 设置页"重启网关"按钮 |
| · | `POST /api/hermes/update` | 未用（runtime 更新走 Tauri 端） |
| · | `GET /api/actions/{name}/status` | 未用 |

### 2.8 Dashboard 管理（v2 桌面端**不用**）

`/api/dashboard/themes`、`/api/dashboard/plugins/*`、`/api/dashboard/agent-plugins/*` 这一组是 Dashboard Web UI 自己的管理后台，桌面端不接入。

### 2.9 Gateway transport

| 状态 | 路由 | 用途 |
|------|------|------|
| √ | `GET /api/v2/events` | SSE 通道（gateway-sse-client.ts） |
| √ | `POST /api/v2/rpc` | RPC 请求通道 |

---

## 3. Gateway JSON-RPC 方法现状清单

> 仅列**桌面端 v2 会用到的**。完整列表见 `tui_gateway/server.py`。

### 3.1 Session 生命周期（C→S 调用）

| 方法 | 用途 | 桌面端何时用 |
|------|------|---------------|
| `session.create` | 新建 session | Composer 发送 → 触发 |
| `session.list` | 列出 sessions | 工作台侧栏会话列表、`/history` |
| `session.most_recent` | 最近 session | 启动恢复 |
| `session.resume` | 恢复 session（async） | 切回旧任务 |
| `session.history` | 拉历史消息 | 进入 `/tasks/:id` 时 replay |
| `session.delete` | 删除 | history 行右键 |
| `session.title` | 改标题 | 任务详情头部双击改名 |
| `session.usage` | token 消耗 | 任务详情元信息卡 |
| `session.status` | 实时状态 | 任务详情顶部状态徽标 |
| `session.undo` | 撤销最后一轮 | 任务详情菜单 |
| `session.branch` | fork（async） | 任务详情某条消息右键"从此分叉" |
| `session.interrupt` | 中断当前请求 | 任务详情"停止"按钮 |
| `session.steer` | 引导（"再想想"） | 任务详情"steer"按钮 |
| `session.compress` | 压缩历史 | 长会话自动 / 手动 |
| `session.save` | 持久化快照 | 任务结束自动 |
| `session.close` | 关闭 session | 任务详情"完成"按钮 |

### 3.2 消息流（C→S 调用 + S→C 事件）

| 方向 | 名称 | 用途 |
|------|------|------|
| C→S | `prompt.submit` | 发消息（含 attachments） |
| C→S | `prompt.background` | 后台命令 |
| C→S | `clipboard.paste` | 粘贴 |
| C→S | `image.attach` | 附图 |
| C→S | `input.detect_drop` | OS 拖拽（v2 桌面端要用） |
| S→C | `message.start` | 助手开始回复 |
| S→C | `message.delta` | 流式 token |
| S→C | `message.complete` | 完整消息 |
| S→C | `session.info` | session 状态快照 |
| S→C | `thinking.delta` / `reasoning.delta` / `reasoning.available` | 思考流 |
| S→C | `tool.progress` / `tool.complete` / `tool.generating` | 工具执行流 |
| S→C | `status.update` | 状态消息 |
| S→C | `error` | 错误 |

### 3.3 审批回路

| 方向 | 名称 | 用途 |
|------|------|------|
| S→C | `approval.request` | 后端需要用户决策（含 `type: clarify\|sudo\|secret\|...`） |
| C→S | `clarify.respond` | 用户澄清 |
| C→S | `sudo.respond` | 高风险动作批准 |
| C→S | `secret.respond` | 凭证提供 |
| C→S | `approval.respond` | 通用 |

### 3.4 命令 / 补全 / 配置

| 方法 | 用途 |
|------|------|
| `slash.exec` | 执行 `/command`（async） |
| `cli.exec` | 执行 CLI 命令（async） |
| `command.resolve` / `command.dispatch` | 命令解析与派发 |
| `complete.path` | 文件路径补全（Composer `@file`） |
| `complete.slash` | 斜杠命令补全（Composer `/skill`） |
| `config.get` / `config.set` | RPC 通道的配置访问（与 REST 等价） |
| `model.options` | 列出可用模型（替代 REST `/api/model/options`） |
| `model.save_key` / `model.disconnect` | 凭证管理（敏感操作） |
| `skills.manage` / `skills.reload` | Skills 启用 / 重载（async） |
| `reload.mcp` / `reload.env` | 重载 MCP / 环境变量 |

### 3.5 v2 桌面端**明确不用**

- `voice.*`（语音录制 / TTS / 转写）
- `browser.*`（浏览器自动化）
- `terminal.resize`（v2 桌面端没有终端尺寸联动）

---

## 4. PRD/IA/Specs 假设 vs 后端现状差距矩阵

> 这是本文档**核心章节**。每条对应一个产品功能，标记后端能力是否满足。

### 4.1 工作台

| 功能 | PRD 来源 | 后端能力 | 状态 | 差距 |
|------|----------|----------|------|------|
| 7 项健康探针 | 01 / 03 § 1.1 | 没有独立 `/api/health/*`，需要前端组合：`/api/status` + `/api/config` + `/api/model/info` + `/api/skills` + `/api/mcp-servers` + `/api/providers/oauth` + workspace fs/list | ⚠️ **要在前端组合** | 桌面端需要写一个 `useHealthProbes()` hook，并行调 6-7 个 endpoint 然后归一化 |
| 进行中任务列表 | 01 / 03 § 1.1 | RPC `session.list` 含状态字段 | ✓ | — |
| 跨项目活动 Feed | 01 / 03 § 1.1 | 用 RPC `session.list` 按时间倒序聚合 | ✓ | 前端做时间合并 |
| 配方 / 模板 | 01 / 03 § 1.1 | **后端没有"配方"概念** | ❌ | v2 桌面端的配方先做**前端硬编码 6 张**，后端化推到 v3 |

### 4.2 新建任务 / Composer

| 功能 | 后端能力 | 状态 | 差距 |
|------|----------|------|------|
| 提示词 + 工作区 + 模型 + 审批策略 → 发送 | RPC `session.create` + `prompt.submit` | ✓ | — |
| `@file` 补全 | RPC `complete.path` | ✓ | — |
| `/skill` 补全 | RPC `complete.slash` | ✓ | — |
| 附件拖拽 | RPC `input.detect_drop` + REST `/api/upload` | ✓ | — |
| Token 估算 | `/api/model/info` 给上下文上限；token 数前端用 tokenizer 估 | ⚠️ | 前端要带轻量 tokenizer（或调 RPC 一个"估 token"方法，**待新增**） |
| Preflight 8 项 | 各项分别有后端接口（同 § 4.1 健康探针） + workspace 可读写检查没有专用 endpoint | ⚠️ | 工作区可读写要前端通过 `/api/fs/list` 试探，外加 git lock 检查需要新接口或简化 |
| 模型 token 过期检查 | OAuth `poll` 接口 + `/api/providers/oauth` 状态字段 | ✓ | — |

### 4.3 任务详情（三栏 + Chat Timeline）

| 功能 | 后端能力 | 状态 | 差距 |
|------|----------|------|------|
| 实时消息流 | SSE + `message.*` 事件 | ✓ | — |
| 工具调用展开 | `tool.*` 事件含完整 args / result | ✓ | — |
| 思考块 | `thinking.delta` / `reasoning.*` 事件 | ✓ | — |
| 审批卡 inline | `approval.request` + `*.respond` 系列 | ✓ | — |
| **右侧文件 Tab**：文件树 + Diff | **后端没有"任务关联文件树" API**；workspace 整树通过 `/api/fs/list` 递归拉太慢；Diff 没有专用接口 | ❌ | **v2 需要新增**：任务运行期间后端跟踪改动的文件（`hermes` 已经有 audit log？）；前端按 audit log 拉对应文件 + git diff |
| **右侧产物 Tab**：生成的文件 / 代码片段 | 后端没有"任务产物清单" API | ❌ | **v2 新增**：从 audit log 推导出新建/改动文件作为产物 |
| **右侧终端 Tab**：subprocess 输出 | RPC 没有专门的"终端流"事件 | ⚠️ | tool.progress 里的 `run(cmd)` 工具结果可以作为终端输出来源，但 UI 区分度不够；可能需要新增 `tool.stream` 子类型 |
| **右侧日志 Tab**：Hermes 系统日志 | REST `/api/logs?component=...` 给静态日志 | ⚠️ | 不能按 session_id 过滤，只能按 component；需要 `/api/logs?session_id=xxx` 新参数或 RPC 事件 |
| 任务"停止"按钮 | RPC `session.interrupt` | ✓ | — |
| "从此分叉" | RPC `session.branch` | ✓ | — |
| "撤销最后一轮" | RPC `session.undo` | ✓ | — |
| Token 用量显示 | RPC `session.usage` | ✓ | — |

### 4.4 项目（workspace）

| 功能 | 后端能力 | 状态 | 差距 |
|------|----------|------|------|
| workspace 列表 | **后端没有"workspace"独立 API** | ❌ | profile 关联 workspace；桌面端从所有 profiles 聚合或新增 `/api/workspaces` |
| workspace 元数据（颜色 / 重命名 / 会话数） | 后端没存 | ❌ | **UI SQLite 存元数据**（颜色 / 别名），不入后端；会话数前端聚合 |
| Git 状态（分支 / 改动） | 后端没有，需要前端调 OS git 或新增 `/api/git/status?path=...` | ❌ | **v2 新增** OR **Tauri 端调用 git CLI** |
| 文件树快照 | `/api/fs/list` 已有 | ✓ | — |
| 「VSCode 打开」/「打开终端」 | Tauri 调 OS 命令，不走后端 | ✓ | Tauri 侧 |

### 4.5 能力（Skills / MCP / Profiles）

| 功能 | 后端能力 | 状态 | 差距 |
|------|----------|------|------|
| Skills 列表 + 启用 | `/api/skills` + `PUT /api/skills/toggle` | ✓ | — |
| Skill 来源标识（系统/我的/插件） | `/api/skills` 返回的字段含 `source` | ✓（**待核对**） | 需要看 Skill schema 是否真有 |
| **Skill 编辑器**（09b CRUD） | **后端没有 Skill CRUD endpoint** | ❌ | 当前 Skills 都是文件系统里的 YAML/JSON；v2 桌面端要**直接读写文件**或后端新增 `POST /api/skills` / `PUT /api/skills/{id}` |
| Skill 测试运行 | 没有专门接口 | ⚠️ | 可用 RPC `slash.exec` 在沙箱 session 跑 |
| MCP 列表 + 在线状态 + 工具列表 | `/api/mcp-servers` 含状态和 tools 字段（**待核对**） | ✓（**待核对**） | 字段对齐 |
| MCP 配置编辑 / 删除 / 添加 | 后端没有 CRUD | ❌ | **v2 新增** OR **直接编辑 `~/.hermes/mcp.yaml`** |
| MCP 重连 | `RPC reload.mcp` | ✓ | — |
| Profile 列表 / 切换 / 创建 / 删除 | `/api/profiles/*`（P-008 fork） | ✓ | — |
| Profile 编辑 | `PATCH /api/profiles/{name}` 已有，桌面端 hook 未实现 | ⚠️ | 加 hook 即可 |
| Profile 关联 workspace | 当前 profile 配置里 `workspace_path` 字段 | ✓ | — |

### 4.6 自动化（Cron）

| 功能 | 后端能力 | 状态 | 差距 |
|------|----------|------|------|
| Cron 例程 CRUD | `/api/cron/jobs/*` 全 CRUD | ✓ | — |
| Cron 启用 / 禁用 / 立即跑 | `/api/cron/jobs/{id}/{pause\|resume\|trigger}` | ✓ | — |
| 下次运行预测 | 后端没显示返回（response 字段待核对） | ⚠️ | 前端用 `cron-parser` 解析表达式自算 |
| 执行历史 | 后端用 audit log 还是单独表？**待核对** | ⚠️ | 可能要新增 `GET /api/cron/jobs/{id}/runs` |
| 触发器 / Webhooks | 后端没有 | ❌ | D4 已决定 v2 不做，OK |

### 4.7 可观测

| 功能 | 后端能力 | 状态 | 差距 |
|------|----------|------|------|
| 全局日志流（SSE） | REST `/api/logs` 静态拉取，**没有 SSE 实时流** | ⚠️ | v2 暂用轮询 5s，PRD 阶段标"SSE nice to have" |
| 多来源过滤 | `/api/logs?component=...` | ✓ | — |
| Level 过滤 | `/api/logs?level=...` | ✓ | — |
| 时间范围过滤 | **待核对**（参数没列出） | ⚠️ | 可能要新增 |
| 关键字搜索 | **没有** | ❌ | v2 桌面端可以前端在拉到的批次里做，超出此范围后端要扩 |
| 7 项健康检查 | 同 § 4.1 | ⚠️ | 前端组合 |
| 修复 hint | 后端无 | ❌ | 前端硬编码（每个探针失败时给固定 hint 跳转） |

### 4.8 模型

| 功能 | 后端能力 | 状态 | 差距 |
|------|----------|------|------|
| 供应商列表 + 状态 | `/api/providers/oauth`（OAuth 供应商）+ `/api/model/options`（所有可用模型） | ✓ | — |
| 模型能力清单 | `/api/model/options` 返回模型 metadata | ✓ | — |
| 消费 / 配额 | `/api/analytics/usage` + `/api/analytics/models` | ✓ | — |
| 默认模型设置 | `POST /api/model/set`（桌面端未用，要接） | ⚠️ | 加 hook |
| 编辑凭证 | OAuth 流（已实现）或 `model.save_key` RPC（敏感操作） | ✓ | — |
| 测试连接 | 后端没有"测试 ping"接口 | ❌ | 前端调 `/api/model/info` 充当一次轻 ping，或 `model.options` |

### 4.9 设置 / 凭证

| 功能 | 后端能力 | 状态 | 差距 |
|------|----------|------|------|
| 主题 / 密度 / 语言 | 纯前端 UI SQLite（无需后端） | ✓ | — |
| 默认审批策略 | profile 配置里有字段 | ✓ | — |
| 通知规则 | 后端没存（桌面端本地存即可） | ✓ | — |
| OAuth 凭证 | 同 § 2.2 | ✓ | — |
| 第三方密钥（非 OAuth） | `/api/env/*` | ✓ | — |
| 凭证过期告警 | `/api/providers/oauth` 含过期时间 | ✓ | — |

### 4.10 命令面板 ⌘K

| 功能 | 后端能力 | 状态 | 差距 |
|------|----------|------|------|
| 会话搜索 | `/api/sessions/search`（FTS5）✓ 但桌面端未接 | ⚠️ | 加 hook |
| 文件搜索 | **后端无** | ❌ | v2 桌面端走 `/api/fs/list` 递归 + 前端 fuzzy 匹配（性能限制：限当前 workspace） |
| 命令搜索 | 前端硬编码命令清单 + fuzzy 匹配 | ✓（纯前端） | — |
| Skills 搜索 | `/api/skills` 拉全量 + 前端 fuzzy | ✓ | — |
| 项目搜索 | 同 workspaces 列表 + 前端 fuzzy | ✓ | — |

### 4.11 桌面端原生能力

| 功能 | 后端 | 差距 |
|------|------|------|
| 文件拖拽（OS 级） | RPC `input.detect_drop`（gateway 已有） | 桌面端要绑 Tauri drop event 转发到 gateway |
| 本地通知 | 完全 Tauri 侧 | — |
| 原生菜单栏 | 完全 Tauri 侧 | — |
| 系统托盘 | 完全 Tauri 侧；进行中任务列表从 RPC `session.list` 拉 | — |
| 深链接 `hermes://`（v2 不做） | 完全 Tauri 侧 | — |

---

## 5. 必须新增的后端能力（按优先级）

如果想让 v2 桌面端完整跑通，下面这些是**桌面端无法绕过的**。

### P0（不补就不能上）

1. **任务关联文件变更 audit log**：任务详情右侧"文件"和"产物" Tab 的数据源。要么扩 RPC 事件（如 `file.change` / `artifact.create`），要么提供 `GET /api/sessions/{id}/changes` REST。

### P1（强烈推荐补）

2. **Workspace 集合 API**：`GET /api/workspaces` 返回所有 profile 关联的 workspace 列表（去重 + 统计会话数 + 最后活动）。当前要桌面端从 `/api/profiles` 聚合，逻辑分散。
3. **Cron 执行历史 API**：`GET /api/cron/jobs/{id}/runs` 返回最近 N 次执行的 status/duration/log。
4. **日志关键字搜索**：`GET /api/logs?q=...` 全文搜索，否则命令面板搜索无法跨日志生效。

### P2（可选，前端能 workaround）

5. **Git 状态 API**：`GET /api/git/status?path=...` 返回分支 + ahead/behind + 改动列表。否则 Tauri 端用 shell 命令调 git，但跨平台路径处理麻烦。
6. **Token 估算 RPC**：`token.estimate` 给定 model + text 返回精确 token 数。否则前端用近似 tokenizer。
7. **Skill CRUD**：让用户在桌面端编辑器存盘后真的写入。否则文件 IO 走 Tauri 侧绕过后端。
8. **MCP CRUD**：同上。

### v2 明确不补

- 任何 voice / browser 相关
- 任何插件 hub / dashboard 主题管理（属于 dashboard 自己 UI）
- `hermes://` 深链接的后端配合

---

## 6. 后端协议演进的约束（不破坏桌面端的前提下）

桌面端给后端的演进约束：

### 6.1 路径稳定

- `/api/v2/events` 和 `/api/v2/rpc` 是核心通道，**不许改名**
- `/api/profiles/active` 是 P-008 fork 特有，**桌面端依赖**，要在 upstream 同步前保留 fork patch

### 6.2 字段向后兼容

- 新增字段总是允许（桌面端解析时容错）
- 删字段 / 改字段类型 必须前后端协调
- RPC 方法新加参数要可选

### 6.3 事件流契约

- 事件名（如 `message.delta`、`tool.complete`）不许改
- 事件 payload 字段可以加，不许删
- 新事件类型加完得给桌面端一个升级窗口期

### 6.4 错误码与 log_id

- 所有错误响应必须含 `log_id`（用于线上排查）
- 错误码用 string enum（如 `"token.expired"` / `"workspace.not_found"`），不要纯数字
- 5xx 必须可重试（桌面端会自动重试 3 次）

---

## 7. 待核对的字段细节

> 写完这版 PRD 后，工程实施时要逐项确认。本节列出我**没有 100% 确认**的字段，按优先级。

- [ ] `/api/skills` 返回字段是否含 `source`（系统/我的/插件）、`triggers`、`usage_count`
- [ ] `/api/mcp-servers` 返回字段是否含 `online`、`tools[]`、最近错误
- [ ] `/api/cron/jobs` 返回字段是否含 `next_run_at` 和 `last_run_at`
- [ ] `/api/logs` 是否支持 `since` / `until` 参数
- [ ] `/api/analytics/usage` 返回的字段粒度（按 profile / 按 model / 按 session）
- [ ] RPC `session.status` 的状态枚举（running / waiting_approval / done / failed / canceled）
- [ ] RPC `approval.request` 的 `type` 全部可能值
- [ ] `/api/profiles` 返回的 `workspace_path` 是单个还是数组

---

## 8. 实施建议（给到工程层）

按依赖顺序：

- [ ] 写 `useHealthProbes()` 聚合 hook（§ 4.1）
- [ ] 接 `useActiveProfileMutation()` 用于设置默认模型（§ 4.8）
- [ ] 接 `/api/sessions/search` 给命令面板（§ 4.10）
- [ ] 跟后端确认 P0「任务文件 audit log」方案（§ 5.1）
- [ ] 跟后端确认是否补 `/api/workspaces`（§ 5.2）
- [ ] 凡是 `/api/*` 调用统一走 `lib/transport.ts`
- [ ] 凡是 gateway 通讯统一走 `lib/gateway-sse-client.ts`
- [ ] § 7 待核对字段逐项跟后端 owner 对一遍

---

## 9. 变更记录

| 日期 | 版本 | 改动 | 作者 |
|------|------|------|------|
| 2026-05-16 | v0.1 | 初稿；基于 `hermes-agent-cn/hermes_cli/web_server.py` + `tui_gateway/server.py` + `web/src/hooks/*` 扫描 | Maintainers |
