# Subagent Delegation — Python → TypeScript Rewrite Plan

## 1. Summary

Port Hermes 的 **subagent delegation**（`delegate_task` / `agent_swarm`）从 Python
运行时（`D:/hermes-agent-cn`）搬进 TS 桌面 monorepo，最终在 Tauri webview 内
**in-process** 运行，不再依赖 Dashboard `/api/ws` 与 REST 桥接。特性面：

- `delegate_task` 生成**上下文完全隔离**的子 agent（fresh conversation、自己的
  terminal 会话、继承父 toolset 且剥除子级禁用工具）。
- 并行 batch：默认 `max_concurrent_children=3`，超限报错而非静默截断；结果按
  task index 排序返回。
- `role="leaf" | "orchestrator"` + `delegation.max_spawn_depth`（默认 1 = 扁平）
  + `orchestrator_enabled` 全局开关 —— 嵌套深度限制。
- 模型/provider 覆盖：`delegation.model/provider/base_url/api_mode` 解析顺序
  base_url > provider > 继承父级；`delegation.model` 全局 pin（无 per-task model）。
- 可选 git worktree 隔离（`delegation.worktree_isolation`，Muse Code 语义，仅
  local terminal backend）。
- 每任务 append-only live transcript（`cache/delegation/live/<id>/task-<n>.log`）。
- `/agents` 监控（实时树、kill/pause、steer）、`steer_subagent`（不打断在飞工具，
  queued/missed_steer 语义）、`interrupt_subagent`。
- 进度式 **stall monitor**（450s idle / 1200s in-tool / 120s grace，`stalled` 终态事件）。
- **durable background completions**（SQLite `async_delegations`，重启恢复 +
  claim 投递）。

## 2. Current Python implementation

数据流（当前）：`config.yaml delegation.*` → `tools/delegate_tool.py` 构建子
`AIAgent`（`_build_child_agent`）→ `_run_single_child` 线程内运行 → 结果合并；
`background=true` 时整批交给 `tools/async_delegation.py` 的 daemon executor，
完成事件写 `state.db` 后投回会话。核心文件（均在 `D:/hermes-agent-cn`）：

- **`tools/delegate_tool.py`**（4534 行）— 主工具。
  - `DELEGATE_BLOCKED_TOOLS = {delegate_task, clarify, memory, send_message, cronjob}`；
    orchestrator 保留 `delegation` toolset（`_strip_blocked_tools` + role 判定）。
  - 子 agent 隔离：`_build_child_agent()`（L1402）新建 `AIAgent`，`subagent_id =
    sa-<task_index>-<hex8>`，`parent_subagent_id` 继承 `_subagent_id`，toolset 与父级
    求交集、MCP 保留、`disabled_toolsets` 追加 blocked + `kanban`；depth =
    `parent._delegate_depth + 1`，`max_spawn_depth` 与 `orchestrator_enabled` 在此
    单点降级 role。
  - `_run_single_child()`（L2201）— 每子独立线程、credential pool lease、心跳
    `_heartbeat_loop`（activity 传播 + 同步路径 stale 计数 `_HEARTBEAT_STALE_CYCLES_*`）、
    输出 tail 提取 `_extract_output_tail`、timeout 诊断 `_dump_subagent_timeout_diagnostic`。
  - 运行期 registry：`_active_subagents`（`_register_subagent` /
    `_unregister_subagent`），对外 API `list_active_subagents()`、`set_spawn_paused()`、
    `interrupt_subagent()`、`steer_subagent()`（owner_session 三件套 authority 校验 +
    `missed_steer` 排空）。
  - 配置读取：`_get_max_concurrent_children()`（默认 3，env
    `DELEGATION_MAX_CONCURRENT_CHILDREN`）、`_get_worktree_isolation()`、
    `_get_child_timeout()`（默认无）、`_get_max_spawn_depth()`（默认 1）、
    `_get_orchestrator_enabled()`、`_get_max_async_children()`（已并入前者）。
  - `delegate_task()`（L3321）：spawn-pause 闸、depth 闸、`_validate_batch_tasks`
    batch 质量门、`coerce_output_schema` per-task schema、live transcript 创建
    （`tools/delegation_live_log.py`：`create_live_transcripts` /
    `update_manifest_statuses` / `wrap_progress_callback`）、同步
    `_execute_and_aggregate` vs 后台 `dispatch_async_delegation_batch`（含
    `async_delivery_supported` 回退同步）。
  - 凭据解析 `_resolve_delegation_credentials`（base_url > provider > 继承），
    动态 schema `_build_dynamic_schema_overrides`。
- **`tools/subagent_runner.py`** — `build_and_run_subagent()`（delegate_task 与
  agent_swarm 共用，解析 delegation 凭据后 `_build_child_agent` + `_run_child_turn`）、
  `resume_subagent()`（Phase 4 雏形，尚缺 `_build_child_agent` 的 session 恢复参数）。
- **`tools/subagent_worktree.py`** — `create_subagent_worktree()` /
  `finalize_subagent_worktree()`：`<repo>/.worktrees/subagent-<id>`、
  branch `hermes-subagent/<id>`、clean+0 commit 自动 prune、非 git / 非 local
  backend 静默降级。
- **`tools/agent_swarm.py`** — `AGENT_SWARM_SCHEMA`（`prompt_template` +
  `{{item}}`、`items` ≤128、`resume_agent_ids`）、`AgentSwarmSpec`（spawn/resume）、
  `validate_swarm_args`、`render_swarm_results` XML、`_get_swarm_max_concurrency`（默认 3）。
- **`tools/swarm_scheduler.py`** — `SwarmBatchScheduler`：normal 阶段 burst 5 +
  700ms 节流；rate-limit 阶段 3s×2ⁿ 退避、容量收缩/3 分钟恢复；user cancel 保留
  已完成、非 user cancel 整批拒绝；每任务 timeout 只 fail 该任务；结果按 spec 序。
- **`tools/async_delegation.py`**（1603 行）— durable 后台注册表。
  - SQLite 表 `async_delegations`（`_initialize_schema`，含 `owner_pid`、
    `owner_started_at`、`task_json`、`delivery_claim`、`origin_session_id` 迁移列）；
    `dispatch_async_delegation` / `dispatch_async_delegation_batch`、
    `_persist_dispatch` / `_persist_completion`、`_prune_durable_records`（48h 重放上限、
    保留上限）。
  - 投递 claim：`claim_completion_delivery` / `complete_completion_delivery` /
    `release_*`；重启恢复 `recover_abandoned_delegations()` /
    `restore_undelivered_completions()`（CLI 侧按 session 正过滤）。
  - `DaemonThreadPoolExecutor`（`tools/daemon_pool.py`）常驻执行器；
    `active_count()` / `active_for_session()` 容量闸（满则同步回退）。
  - stall monitor：`_ensure_stale_monitor()` / `_stale_monitor_loop()`（30s 扫描、
    `_STALE_IDLE_SECONDS=450`、`_STALE_IN_TOOL_SECONDS=1200`、`_STALL_GRACE_SECONDS=120`）、
    `_finalize_stalled()` 发 `stalled` 终态事件；`list_async_delegations()` /
    `interrupt_all()` / `interrupt_for_session()`。
- **`agent/delegation_context.py`** — ContextVar `_DELEGATED_CHILD_CONTEXT` /
  `_NON_DISPATCHER_OWNED_CONTEXT`；`scrub_kanban_env()`（剥 `HERMES_KANBAN_*`，
  打 `HERMES_DELEGATED_CHILD_CONTEXT=1`）、`delegated_child_subprocess_env()`；
  `is_dispatcher_owned_worker_context()` 供 cron/kanban 身份闸。
- **文档**：`website/docs/user-guide/features/delegation.md`（441 行）—— 单任务 /
  batch / 模型覆盖 / worktree / 深度 / `/agents` / steer / live transcript /
  stall monitor / durable 生命周期 / 配置全表。

## 3. Target TypeScript design

新增 in-process 模块 `packages/agent-core/src/agent/delegation/`（与 kimi-code
`agent-core` 同构；若团队决定先在 `web/src/agent/` 落地亦可，接口一致）。运行时由
webview 内 JS 拥有；Rust 只经 Tauri IPC 提供 git/pty/SQLite 原语。

- **`delegation-context.ts`** — `DelegationContext`（TS 版 ContextVar）：用显式
  context 对象 + `AsyncLocalStorage`（Node 侧）/ 模块级 `currentDelegationContext`
  （webview 单线程）标记 `isDelegatedChild` / `isDispatcherOwnedWorker`；子进程
  env 清洗函数 `scrubKanbanEnv(env)` 与 `delegatedChildSubprocessEnv()` 平移到
  Rust `child_process` 调用的 env 构造处（`src/commands/`）。
- **`subagent-host.ts`** — `SubagentHost`（对标 Python `_build_child_agent` +
  `_run_single_child` 与 kimi-code `SessionSubagentHost`）：
  `spawn(goal, context, toolsets?, model?, role, maxIterations)` / `resume` /
  `retry` / `interrupt(id)` / `steer(id, text, ownerSessionRecord)` /
  `listActive()` / `cancelAll(reason)`；内部 `activeChildren: Map<id, SubagentRecord>`
  运行期 registry（含 `acceptingSteer`、owner 三件套、`agent` 引用），steer
  排队通过子 agent 的 `steer(text)` 注入下一迭代边界，完成时 `drainPendingSteer()`
  → `missed_steer`。子 agent 为独立 `Agent` 实例：fresh `Context`、独立
  `TerminalSession`（经 Tauri IPC 的 pty）、继承并过滤 toolset。
- **`subagent-batch.ts`** — `SubagentBatchScheduler`（移植 Python
  `SwarmBatchScheduler` + kimi-code `SubagentBatch`）：`INITIAL_LAUNCH_LIMIT=5`、
  700ms 节流、429 指数退避（`retry` npm）、容量收缩/3min 恢复、user/non-user
  cancel 语义、per-task timeout、按输入序返回。默认 `maxConcurrency=3`。
- **`agent-swarm.ts`** — `AgentSwarmSpec` / `createAgentSwarmSpecs` /
  `validateSwarmArgs` / `renderSwarmResults`（XML 与 JSON 双格式），注册为
  `agent_swarm` 工具；max 128。
- **`subagent-worktree.ts`** — `createSubagentWorktree(parentCwd, subagentId)` /
  `finalizeSubagentWorktree(info, {prune})`，git 命令走 Rust IPC（`git rev-parse
  --show-toplevel`、`git worktree add/remove`、`git rev-list`、`git status
  --porcelain`），复用 Python 的降级契约。
- **`live-transcript.ts`** — 每任务 append-only 日志（`<appData>/cache/delegation/
  live/<delegationId>/task-<n>.log` + `manifest.json`），`wrapProgressCallback`
  包装事件 → 时间戳行；7 天 prune。
- **`async-delegation.ts`** — `AsyncDelegationRegistry`（SQLite via Rust
  `state.db` 同 schema）、`AsyncDelegationExecutor`（容量闸 + 满则同步回退）、
  `StallMonitor`（30s 扫描、450/1200/120 阈值、`stalled` 终态）、投递 claim
  （`claimCompletionDelivery` 等，重启后 `recoverAbandoned` /
  `restoreUndelivered`）。
- **`delegate-task.ts` / `agent-swarm-tool.ts`** — 工具 schema（zod）+ handler；
  `delegate_task` 参数 `goal | tasks[]`、`role`、`background`、`output_schema`；
  动态 schema 描述反映 `max_concurrent_children` 等。

数据流（in-process）：`Agent.turn` → `delegateTask()` → `SubagentHost.spawn*`
（每子一个 `Agent` + `TerminalSession`，注册进 registry）→ 同步 `await batch.run()`
或 `AsyncDelegationRegistry.dispatch()`（后台，完成事件经内部事件总线投回会话）→
结果只以 summary 进入父 context。

## 4. Data models & persistence

TS 接口（`packages/agent-core/src/agent/delegation/types.ts`）：

- `SubagentRecord { subagentId, parentId, depth, goal, model, status,
  startedAt, updatedAt, toolCount, apiCalls, costUsd, filesRead, filesWritten,
  outputTail[], currentTool, summary, acceptingSteer, ownerSessionRecord? }`
  —— 与 `web/src/stores/subagents.ts` 的 `SubagentProgress` 字段一一对应。
- `SwarmSpec { kind: 'spawn'|'resume', index, item?, prompt, agentId? }`；
  `SwarmTaskResult { index, item?, kind, agentId?, status, summary?, error? }`。
- `AsyncDelegationRecord` —— SQLite 行，字段镜像 Python
  `async_delegations`：`delegation_id`、`origin_session`、
  `origin_ui_session_id`、`parent_session_id`、`state`（running/finalizing/
  completed/failed/stalled/unknown）、`dispatched_at`、`completed_at`、
  `updated_at`、`event_json`、`result_json`、`delivery_state`（pending/claimed/
  delivered）、`delivery_attempts`、`delivered_at`、`owner_pid`、
  `owner_started_at`、`task_json`、`delivery_claim`、`delivery_claimed_at`、
  `origin_session_id`。

持久化策略：**SQLite 放 Rust**（`src/state.rs` 已有连接点；README 明确 "SQLite if
needed"），表 `async_delegations` 由 Rust 命令 `delegation_db_*` 暴露；TS 侧只经
IPC。Live transcripts / manifest 为 JSON + 文本文件（app data 目录）。迁移：首次
建表 + `PRAGMA table_info` 增列（对齐 Python `_initialize_schema` 的 ALTER 序列）。

## 5. Third-party library strategy

| Python 依赖/能力 | TS 等价 | kimi-code 证据 |
|---|---|---|
| `threading.ThreadPoolExecutor` / `DaemonThreadPoolExecutor` | 后台任务管理器 `BackgroundManager` + `AgentBackgroundTask`（Promise/AbortController 驱动） | `packages/agent-core/src/agent/background/index.ts`、`agent-task.ts`、`persist.ts` |
| `sqlite3` + WAL | Rust `rusqlite`/Tauri SQLite IPC（或 kimi-code `packages/minidb` 思路） | README 指定 SQLite 归 Rust；minidb 提供 TS 侧 embedded 先例 |
| 429 退避/重试 | `retry@0.13.1`（npm）；`isProviderRateLimitError` | `packages/agent-core/package.json` 有 `retry`；`subagent-batch.ts` 从 `@moonshot-ai/kosong` 导入 `isProviderRateLimitError` |
| `contextvars`（子级隔离） | `AsyncLocalStorage` / 显式 context 对象（webview 单线程可无依赖） | kimi-code `Agent`/`Context` 体系天然隔离 |
| `orjson`/`json` | 原生 `JSON`（zod 校验） | kimi-code 全程 `zod@4` + JSON |
| `uuid` | `ulid`（kimi-code 依赖 `ulid@^3.0.1`）或 `crypto.randomUUID` | `package.json` |
| `subprocess`（git worktree） | 经 Tauri IPC 调 Rust `git` child process（或 `simple-git`） | **kimi-code 无 worktree 隔离** —— 仅 `git-context.ts` 处理 `.git` 文件边界，须自研 |
| pty / terminal | Tauri IPC → Rust node-pty 等价能力（README：native pty 归 Rust） | kimi-code `apps/kimi-code/src/native` 用 `node-pty@1.1.0` |
| 工具 schema | `zod` + `toInputJsonSchema` | `agent.ts` / `agent-swarm.ts` 的 `AgentToolInputSchema`、`toInputJsonSchema` |
| 模型覆盖 | `secondary-model` 实验（`resolveSubagentBinding` / `stripSubagentModelParameter`） | `session/subagent-binding.ts` |
| 批调度 | `SubagentBatch`（同常数、同速率语义） | `session/subagent-batch.ts` |
| 监控/steer UI | TUI `SubAgentEventHandler` + `SubagentActivityStore` + `tasks-browser.ts` | `apps/kimi-code/src/tui/controllers/` |

**no TS equivalent found（须自研/移植）**：
1. **Stall monitor（进度式）** —— kimi-code 只有 per-task 墙钟 timeout
   （`resolveSubagentTimeoutMs`，默认 2h），没有“有进展绝不打断、无进展 450s 才
   interrupt”的进度采样 monitor；须从 Python `_stale_monitor_loop` 移植。
2. **Worktree isolation** —— 见上表，kimi-code 无。
3. **Orchestrator role + max_spawn_depth** —— kimi-code `Agent`/`AgentSwarm` 是
   扁平 spawn，无 role / depth 概念；须按 Python 语义自研（registry 记录 depth，
   叶子剥 `delegation` toolset）。
4. **Live per-task 日志** —— kimi-code `BackgroundTaskPersistence` 存 JSON/输出
   快照，没有“tail -f 友好的逐行时间戳日志 + manifest”；日志格式须移植。
5. **Durable completion claim 语义** —— kimi-code background task 有持久化与
   lost 重分类，但无 Python 的 delivery claim/48h 重放/restart 恢复三件套；须移植。

## 6. Integration with existing Hermes-CN-Desktop frontend

- **直接复用**：`web/src/stores/subagents.ts`（Jotai 原子、`SUBAGENT_EVENT_TYPES`、
  `buildSubagentTree`、per-session 键）与 `web/src/components/chat/subagent-panel.tsx`
  —— 事件名与 payload 字段保持 `subagent.*`，in-process 事件总线发同型事件即可无改
  换用；`web/src/stores/cli-delegations.ts` / `cli-delegation-card.tsx` 是外部
  Claude Code/Codex 委派（P-047），与本文特性相邻但独立，保留。
- **protocol**：`packages/protocol/src/hermes-api.ts` 目前只登记 `delegation.cli.*`
  与通用事件，`subagent.*` 走 `RawGatewayEvent` passthrough；新增已知 schema：
  `subagent.spawn_requested/start/thinking/tool/progress/complete` +
  `delegation.async.*`（dispatched/completed/stalled）、`delegation.status`、
  `subagent.interrupt/steer` 请求/响应，供 stores 强类型消费。
- **Rust 命令**：新增/复用 `src/commands/` 的 pty、git（worktree）、SQLite
  （async_delegations CRUD + claim）、child_process（env 清洗）命令；`src/state.rs`
  扩展 `async_delegations` 表。
- **UI 新增**：`/agents` overlay 可复用 `subagent-panel.tsx` 的树渲染；`coding-agents.tsx`
  路由（外部 CLI 检测，`use-coding-agents.ts`）不冲突。

## 7. Removing the WebSocket dependency (migration path)

1. **Phase A（现状）**：前端照旧经 `/api/ws` 收 `subagent.*` 事件，stores 消费。
2. **Phase B（同接口 in-process）**：实现 `packages/agent-core` delegation 模块，
   前端把事件源从 WS 换成内部 `DelegationEventBus`；**冻结的 API 面**：
   - 事件：`subagent.spawn_requested/start/thinking/tool/progress/complete`
     payload 字段（与 `stores/subagents.ts` 注释核对过的 snake_case 字段）。
   - RPC：`delegation.status`、`subagent.interrupt`、`subagent.steer`、
     `delegation.pause` 的请求/响应形状。
   - 工具参数：`delegate_task`（goal/tasks/role/background/output_schema）与
     `agent_swarm`（prompt_template/items/resume_agent_ids）schema。
   网关 `tui_gateway/server.py` 与 `async_delegation.py` 的投递路径保持并行，双写
   校验（parity fixture）。
3. **Phase C（切流）**：桌面会话默认 in-process；WS 只保留给仍连 Python runtime
   的旧会话。
4. **Phase D（删除）**：删除 WS/REST 路径与 `tui_gateway` 中 delegation RPC 代理；
   保留 Python 端供 CLI/gateway 平台使用（README 范围外）。

## 8. Migration phases & task breakdown

- **P0 骨架与 parity fixture**：`packages/agent-core` 脚手架；从 Python
  tests 抽取共享 fixture（事件 payload、swarm XML、schema）。
- **P1 同步单任务**：`SubagentHost.spawn` + fresh context + toolset 继承/blocked 剥离
  + `delegation_context` 隔离 + 心跳；parity vs `test_delegate.py` /
  `test_subagent_lifecycle.py`。
- **P2 batch + swarm**：`SubagentBatchScheduler`、`agent_swarm` 工具、动态 schema；
  parity vs `test_delegate_batch_validation.py` / `test_agent_swarm_smoke.py` /
  `test_delegate_toolset_scope.py`、`test_delegate_cascade_49148.py`（嵌套树）。
- **P3 worktree + live transcript**：`subagent-worktree.ts`、`live-transcript.ts`
  （Rust git/文件 IPC）；parity vs `test_subagent_worktree.py`。
- **P4 async durable + stall monitor**：SQLite 表、daemon 池、claim 投递、重启恢复、
  `StallMonitor`；parity vs `test_async_delegation.py`、
  `test_delegate_subagent_timeout_diagnostic.py`、
  `test_delegation_session_lifecycle.py`（tui_gateway）。
- **P5 监控/steer/UI**：`/agents` overlay、`steer_subagent`、pause/kill；protocol
  zod 补齐；parity vs `test_agents_command_delegations.py` /
  `test_subagent_steer.py` / `test_subagent_progress.py`。
- **P6 切流与删除**：Phase C/D；回归 `test_iteration_budget_race.py`（迭代预算竞争）
  与全量桌面 E2E。

## 9. Risks & open questions

- **并发模型**：Python 每子一线程；webview 单线程 JS 需 worker（`node:worker_threads`
  或 Rust pty 侧执行），或沿用 kimi-code 的异步单线程 + AbortController —— 同步
  批的 `ThreadPoolExecutor` 语义（并行度=真并发）需要 worker pool 决策。
- **429 检测差异**：Python 用字符串匹配 `"429"/"rate_limit"`；TS 依赖
  `isProviderRateLimitError`（kosong 类型化错误）—— 需要 provider 适配层统一。
- **resume_subagent 在 Python 仍半成品**（`_build_child_agent` 尚无 session 恢复
  参数）：TS 移植范围需与团队确认是否含 resume（agent_swarm resume 依赖它）。
- **durable 语义简化风险**：桌面端无 gateway 多消费者，claim 机制可简化为
  单消费者 + 重启恢复；但与 Python 的 48h 重放/正过滤语义要保留 parity 测试。
- **worktree 在 Windows**：`git worktree` 支持 OK，但 `.worktrees` 路径大小写/
  驱动器差异需 Rust 侧统一；非 git 仓库静默降级契约要测。
- **stall monitor 阈值**：450/1200s 是长程网关经验值；桌面 in-process 会话较短，
  阈值是否保留待定（open question）。

## 10. Test strategy

- **Vitest 单元**（parity 表）：`delegate-task.test.ts`（schema/校验/blocked
  tools）、`subagent-batch.test.ts`（burst/退避/cancel/order，对齐
  `test_delegate.py` + kimi-code `SubagentBatch` 语义）、`agent-swarm.test.ts`
  （specs/XML，对齐 `test_agent_swarm_smoke.py`）、`subagent-worktree.test.ts`
  （mock git IPC，对齐 `test_subagent_worktree.py`）、`async-delegation.test.ts`
  （SQLite 内存版 claim/recover/prune，对齐 `test_async_delegation.py`）、
  `stall-monitor.test.ts`（fake progress，对齐 stall 阈值）、`delegation-context
  .test.ts`（env 清洗）。
- **集成**：fake provider 驱动 `test_subagent_lifecycle.py` /
  `test_subagent_stop_hook.py` / `test_subagent_progress.py` / `test_subagent_steer.py`
  场景（interrupt/steer 边界、missed_steer）；`test_iteration_budget_race.py`
  （父/子迭代预算竞争）与 `test_delegate_cascade_49148.py`（深度树）转
  `delegation-tree.test.ts`。
- **Playwright E2E**：subagent panel 树渲染/steer/`/agents`，复用
  `subagent-panel.test.tsx` 的交互矩阵；`test_delegation_session_lifecycle.py`
  （后台完成投递、重启恢复）转 `delegation-session.e2e.ts`。
- **Parity fixture**：双仓共享 JSON fixture（`web/src/lib/cli-delegation.ts` 先例：
  Core `tests/tui_gateway/test_cli_delegation_classifier.py` 与
  `cli-delegation.test.ts` 字面一致）。

## 11. Reference links

- Python：`D:/hermes-agent-cn/tools/delegate_tool.py`、
  `tools/subagent_runner.py`、`tools/subagent_worktree.py`、`tools/agent_swarm.py`、
  `tools/swarm_scheduler.py`、`tools/async_delegation.py`、`tools/daemon_pool.py`、
  `tools/delegation_live_log.py`、`agent/delegation_context.py`、
  `website/docs/user-guide/features/delegation.md`；
  tests：`tests/tools/test_delegate.py`、`tests/tools/test_delegate_*.py`（11 个）、
  `tests/tools/test_subagent_*.py`（7 个）、`tests/tools/test_async_delegation.py`、
  `tests/tools/test_agent_swarm_smoke.py`、`tests/agent/test_subagent_lifecycle.py`、
  `tests/run_agent/test_iteration_budget_race.py`、
  `tests/gateway/test_agents_command_delegations.py`、
  `tests/test_delegate_cascade_49148.py`、`tests/tui_gateway/test_delegation_session_lifecycle.py`。
- kimi-code：`packages/agent-core/src/session/subagent-host.ts`、
  `session/subagent-batch.ts`、`session/subagent-binding.ts`、
  `tools/builtin/collaboration/agent.ts`、`tools/builtin/collaboration/agent-swarm.ts`、
  `agent/background/{index,agent-task,persist}.ts`、`agent/swarm/index.ts`、
  `apps/kimi-code/src/tui/controllers/subagent-event-handler.ts`、
  `subagent-activity-store.ts`、`tasks-browser.ts`、`packages/agent-core/package.json`
  （`zod@4.3.6`、`retry@0.13.1`、`ulid@^3.0.1`、`node-pty@^1.1.0`）。
- Desktop：`D:/Hermes-CN-Desktop/web/src/stores/subagents.ts`、
  `web/src/components/chat/subagent-panel.tsx`、`web/src/lib/cli-delegation.ts`、
  `web/src/hooks/use-coding-agents.ts`、`web/src/routes/coding-agents.tsx`、
  `web/src/stores/cli-delegations.ts`、`packages/protocol/src/hermes-api.ts`、
  `src/commands/*`、`src/state.rs`、`plans/README.md`。
