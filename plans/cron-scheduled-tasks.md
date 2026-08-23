# Cron / Scheduled Tasks — Python → TypeScript Rewrite Plan

> 设计文档（design-only，不实现代码）。目标：把 Python 后端（`D:/hermes-agent-cn`）的
> cron 调度能力搬进 TypeScript 前端 monorepo（`D:/Hermes-CN-Desktop`），最终去掉
> Dashboard `/api/ws` + REST 依赖，cron 在 Tauri webview 内以进程内引擎运行。
> 本文件覆盖：自然语言/cron 表达式调度、单一 `cronjob` 工具（create/list/update/pause/
> resume/run/remove）、skill-backed 任务、任意平台投递含 `all` 扇出、no-agent 纯脚本任务、
> `context_from` 链式任务、per-job 模型固定 + drift guard、执行账本（execution ledger）、
> workdir 支持、`[SILENT]` 抑制、`hermes cron` CLI + `/cron`。

## 1. Summary

- Python 侧 cron 是“gateway 守护进程内 60s ticker + `~/.hermes/cron/jobs.json` 持久化 +
  SQLite 执行账本 + 平台 adapter 投递”的完整子系统（`D:/hermes-agent-cn/cron/`，
  47 个测试文件）。TS 侧 kimi-code 已有**自包含 5 字段 cron 解析器 + 进程内 scheduler +
  会话级 JSON 持久化**（`packages/agent-core/src/agent/cron`、`src/tools/cron`），可作
  为调度引擎与表达式解析的直接移植证据；但 kimi-code 没有投递、skills、no-agent 脚本、
  model 固定、执行账本、`context_from` 等 Hermes 独有能力，这些必须 from scratch。
- 桌面端现状：`web/src/routes/cron.tsx` + `web/src/hooks/use-cron.ts` 已经完整覆盖
  Cron 页（列表/创建/暂停/恢复/触发/删除/运行历史），但全部走 REST `/api/cron/*` 与本地
  路由 `/__hermes_cron_runs`，数据源是托管 Python runtime。迁移的核心不是重写 UI，而是
  把 `use-cron.ts` 背后的数据源从“REST 调用”换成“进程内 `CronService`”，UI 与协议
  schema 保持不变作为冻结契约。
- 本计划把 cron 引擎拆成三层：`CronExpressionParser`（纯函数，移植 kimi-code cron-expr）、
  `CronJobStore` + `CronExecutionLedger`（持久化）、`CronScheduler` + `CronRunner`
  （调度与执行，含 no-agent 脚本、agent 任务、投递、`[SILENT]`）。Rust 侧保留
  `src/cron_runs.rs` 的输出读取与 SQLite 能力，新增子进程/原子写命令。
- 迁移分 5 阶段：契约冻结 → 表达式与存储 → scheduler + no-agent 脚本 → agent 任务 +
  投递 → 删除 Python 路径。每阶段都有 vitest/Rust 单测与 Playwright E2E 对拍
  （parity test）映射 Python `tests/cron/`。

## 2. Current Python implementation

实现路径（`D:/hermes-agent-cn`，均为已核实事实）：

- `cron/jobs.py` — 存储与任务模型：
  - `parse_schedule(schedule)`（L624）：识别 4 种 schedule kind：`once`（ISO 时间戳 /
    `30m`/`2h`/`1d` 相对时长）、`interval`（`every 30m` 等）、`cron`（5/6 字段表达式，
    依赖 `croniter`，L662）、`once` 定时戳；返回 `{kind, minutes|expr|run_at, display}`。
  - `create_job(...)`（L1701）：参数含 prompt/schedule/name/repeat/deliver/origin/
    skill(s)/model/provider/base_url/script/context_from/enabled_toolsets/workdir/
    no_agent/attach_to_session/monitor_script/monitor_url；`_validate_job_mode_invariants`
    （L1671）约束 no_agent 与 monitor 互斥；`_normalize_workdir`（L1530）要求绝对目录；
    `_compute_provider_model_snapshots`（L1616）为 unpinned provider/model 拍快照供
    drift guard。
  - 存储：`~/.hermes/cron/jobs.json`（`JOBS_FILE` L87），原子写 + 跨进程 `.jobs.lock`
    （fcntl/msvcrt，L273），profile 隔离通过 `use_cron_store()` ContextVar（L173）；
    `load_jobs`/`save_jobs` 带 shrink-merge 防并发创建被覆盖（#80624）。
  - 调度原语：`compute_next_run`（L835）、`get_due_jobs`（L2733）、`claim_dispatch`
    （L2405，一次性任务 dispatch 上限）、`claim_job_for_fire`（L2590，CAS 防并发 fire）、
    `advance_next_runs`（L2519）、`mark_job_run`（L2243）、`save_job_output`
    （L3180，`cron/output/{job_id}/{ts}.md`）；ticker 心跳/成功文件（L931）。
- `cron/scheduler.py` — 调度与执行（5613 行）：
  - `tick()`（L5276）：60s 循环入口（由 gateway `InProcessCronScheduler` 驱动，
    `cron/scheduler_provider.py` L172），文件锁 `.tick.lock` 防重叠，`advance_next_runs`
    先于执行（at-most-once），随后按 workdir 拆成顺序池/并行池（L5449-5554，`_get_parallel_pool`
    L609，`HERMES_CRON_MAX_PARALLEL`）。
  - `run_one_job()`（L4969）：共享执行体 execute→save→deliver→mark，供 ticker 与外部
    provider（Chronos `fire_due`）共用；内部创建 execution 记录、调 `run_job`。
  - `run_job()`（L3598）：构建 fresh AIAgent session（`_build_job_prompt` L3030，注入
    skills/context_from/workdir 的 AGENTS.md 等）、prompt-injection 扫描
    （`_scan_assembled_cron_prompt` L3271）、provider/model 解析 + drift guard
    （`cron_model_drift_guard_enabled`，preflight L3396-3598）、`[SILENT]` 判定
    （`_is_cron_silence_response` L315，`SILENT_MARKER` L301）、no-agent 脚本
    （`_run_job_script` L2649 + wakeAgent 门 L3004）、脚本超时与输出脱敏。
  - 投递：`_deliver_result`（L1779）经 gateway adapters 发到目标；`_resolve_delivery_targets`
    （L1601）解析 `deliver` 字符串（`origin`/`local`/平台名/`platform:chat:thread`/逗号列表/
    `all` 扇出）；`cron_delivery_targets`（L1408）枚举已配置 home channel；
    `_KNOWN_DELIVERY_PLATFORMS`（L259）白名单 20+ 平台；响应包装
    `cron.wrap_response`；continuable（mirror_delivery）能力在 L941。
- `cron/executions.py` — SQLite 账本：`~/.hermes/cron/executions.db`，状态机
  `claimed → running → completed|failed|unknown`，`recover_interrupted_executions`
  （L199）重启后把可证明孤儿置 `unknown`，`list_executions` 游标分页（L236）。
- `cron/blueprint_catalog.py` + `cron/suggestions.py` — 自动化模板（`AutomationBlueprint`
  L82、`CATALOG` L119、`fill_blueprint` L746）与建议列表，供 dashboard `/blueprint`、
  `/suggestions` 使用。
- `tools/cronjob_tools.py` — 单一模型工具 `cronjob(action=...)`（L1032）：create/list/
  update/pause/resume/run/remove；create/update 做 prompt 注入扫描
  （`_scan_cron_prompt` L260）；`run` 走 `_try_dispatch_background_run`（L823）异步
  delegate，同步降级；`_format_job`（L556）定义工具返回的 job 视图。
- `hermes_cli/cron.py` — `hermes cron` CLI：`cron_command`（L548）分发 list/status/tick/
  runs/notepad/create/edit/pause/resume/run/remove；`_cron_api`（L45）统一转调
  `cronjob` 工具，避免 CLI 与模型工具语义分叉。`/cron` 是 CLI-only slash command
  （`hermes_cli/cli_commands_mixin.py` L1539 `_handle_cron_command`）。

数据流（当前）：`gateway/run.py _start_cron_ticker` → `InProcessCronScheduler.start` →
每 60s `tick()` → `get_due_jobs()` → `advance_next_runs()` → 并行/顺序池 →
`run_one_job()` → `run_job()`（AIAgent / 脚本）→ `save_job_output()` →
`_deliver_result()`（平台 adapter）→ `mark_job_run()` + `finish_execution()`。
创建/编辑入口（CLI、agent 工具、dashboard REST `/api/cron/*`）都汇聚到
`cron.jobs.create_job/update_job/...`，再 `_notify_provider_jobs_changed()`。

## 3. Target TypeScript design

模块布局（新增 `packages/cron-core/`，纯 TS、无 React 依赖；`web/src` 只做 UI 绑定）：

```
packages/cron-core/src/
  cron-expr.ts        // 移植 kimi-code cron-expr.ts：5 字段解析 + next-run 计算 + humanize
  schedule.ts         // 自然语言 schedule 解析（对应 parse_schedule：once/interval/cron/ISO/时长）
  types.ts            // CronJob / CronSchedule / CronExecution 类型（对齐 packages/protocol）
  store.ts            // CronJobStore：jobs.json 读写、原子写、profile 隔离、CRUD、claim/advance
  ledger.ts           // CronExecutionLedger：SQLite(经 Rust) 或 IndexedDB 的 executions 记录
  scheduler.ts        // CronScheduler：进程内 tick 引擎（移植 kimi-code scheduler.ts 设计）
  runner.ts           // CronRunner：执行 job（agent 模式 / no-agent 脚本 / wakeAgent / [SILENT]）
  delivery.ts         // CronDelivery：deliver 解析 + 目标展开（含 all 扇出、origin）
  silence.ts          // [SILENT] 匹配器（对齐 gateway.response_filters.is_autonomous_silence_response）
  drift-guard.ts      // per-job model/provider 固定 + 全局默认漂移检测
  index.ts            // 统一门面 CronService：create/list/update/pause/resume/run/remove/status/runs
web/src/
  lib/cron-client.ts  // CronService 的 React 侧封装（进程内实现 + 当前 REST 实现二选一）
  hooks/use-cron.ts   // 保持现有 hook API 不变，底层换 cron-client
  routes/cron.tsx     // 复用现有 UI，按需扩展字段（skills/workdir/no_agent/model/deliver 多选）
```

核心接口（伪代码，不实现）：

```ts
interface CronService {
  create(job: CronJobInput, profile: string): Promise<CronJob>;
  list(profile: string, includeDisabled?: boolean): Promise<CronJob[]>;
  update(id: string, updates: Partial<CronJobInput>, profile: string): Promise<CronJob>;
  pause(id: string, reason?: string, profile?: string): Promise<CronJob>;
  resume(id: string, profile?: string): Promise<CronJob>;
  run(id: string, extraPrompt?: string, profile?: string): Promise<CronRunResult>;
  remove(id: string, profile?: string): Promise<boolean>;
  status(profile?: string): Promise<CronStatus>;        // ticker 心跳 + 活跃任务摘要
  runs(jobId?: string, limit?: number): Promise<CronExecution[]>;
}

interface CronScheduler {
  start(): void;                 // setInterval 60s（可配 HERMES_CRON_INTERVAL_MS / 手动 tick）
  tick(): Promise<void>;         // getDueJobs → advanceNextRuns → dispatch → runner
  stop(): Promise<void>;
}
```

- `CronScheduler` 直接移植 kimi-code `tools/cron/scheduler.ts` 的引擎骨架
  （`source()` 每 tick 重读、坏任务隔离、`isIdle()` 门控、coalesce 语义），但把
  `onFire` 从“steer 注入提示”替换为 Hermes 的 `runOneJob` 语义
  （执行 → 存输出 → 投递 → mark），并把 1s 轮询换成 Python 的 60s tick。
- `CronRunner` 分两路：`no_agent=true` 时经 Rust 子进程命令跑脚本（stdout 直接投递、
  空输出静默、非零退出投递错误、`{"wakeAgent":false}` 门）；否则交给进程内 TS agent
  runtime（复用其他 feature 移植的 agent loop / session 模块），prompt 组装
  （skills 注入、`context_from` 上游输出前置、workdir 的 AGENTS.md 注入）对应
  Python `_build_job_prompt`。
- 投递 `delivery.ts` 保持纯函数解析（deliver 字符串 → 目标列表，含 `all` 扇出、
  `origin` 回源、`platform:chat:thread`），实际发送在桌面端走已有的 IM 通道
  （`src/commands/im_onboarding.rs` 支持飞书/微信）与 Rust 通知/邮件能力；平台 adapter
  本体（telegram/discord/…）不在桌面 standalone 范围，标记 out of scope。

## 4. Data models & persistence

- `CronJob`（TS 类型，对齐 `packages/protocol/src/hermes-api.ts` L950 并扩展）：
  `id, name, prompt, script, schedule: {kind, minutes?, expr?, run_at?, display?},
  repeat: {times?, completed?}, deliver: string[], origin?, skills: string[],
  model?, provider?, base_url?, enabled_toolsets?, workdir?, no_agent?,
  context_from?: string[], enabled, state, next_run_at, last_run_at, last_status,
  last_error, paused_at?, paused_reason?, created_at, profile`。
- 持久化：
  - `jobs.json`（每 profile 一份，`{jobs, updated_at}`）→ 桌面端用 Rust 原子写命令
    （复用 `src/` 现有 fs 能力或新增 `cron_store_write`），浏览器兜底 localStorage/
    OPFS 时用“临时文件 + rename”模拟原子写。单进程桌面端可放弃 fcntl/msvcrt 跨进程
    锁，用模块级 mutex + `.jobs.lock` PID 检查保持与 Python 文件布局兼容。
  - `executions.db`（SQLite）→ Rust `rusqlite` 建表（`cron/executions.py` L39 同构），
    或 Web Worker + `packages/minidb`（kimi-code 已有 embedded DB 包）的 IndexedDB
    后端；保留 `claimed/running/completed/failed/unknown` 状态机与
    `recover_interrupted_executions` 等价物。
  - 输出目录 `cron/output/{job_id}/{timestamp}.md` → Rust 写文件；`src/cron_runs.rs`
    已是本地读取路由（L359 `handle_cron_runs_request`），直接复用。
  - notepad（`cron/notepad.py` KV）→ 与 ledger 同一 SQLite 库新增 `notepad` 表。
- Schema 迁移：`jobs.json` 顶层加 `schema_version`，读侧接受 Python 旧格式（字符串
  schedule、`skill` 单数、`deliver` 字符串），写侧统一新格式；protocol Zod 全部字段
  `.optional().passthrough()` 保证旧 runtime 不炸（沿用 `hermes-api.ts` 现有策略）。

## 5. Third-party library strategy

| Python 依赖 | TS 等价物 | 证据（kimi-code） |
|---|---|---|
| `croniter`（5/6 字段 cron 计算） | **from scratch 移植**：自包含 5 字段解析器 | `D:/kimi-code/packages/agent-core/src/tools/cron/cron-expr.ts`（`parseCronExpression`/`computeNextCronRun`/`cronToHuman`/`hasFireWithinYears`，无外部 npm cron 库；5 字段、本地时区、dom/dow OR 规则、5 年窗口防死循环）。⚠️ croniter 支持第 6 字段（year），kimi 版不支持 → 需要扩展或拒绝 6 字段并报清晰错误。 |
| 自然语言 schedule（`every 30m`/`2h`/ISO 时间戳） | **from scratch**：`parse_schedule` 的字符串启发式（Python 未用 NLP 库，纯正则+时长解析） | kimi-code 无对应实现；它靠模型把自然语言翻译成 5 字段 cron（`cron-create.md`）。TS 侧把 Python L603-722 的规则逐条移植即可。 |
| `sqlite3`（executions/notepad） | Rust `rusqlite`（Tauri 能力）或 `packages/minidb`（IndexedDB） | README 列出 `packages/minidb` = embedded DB/persistence engine；`tools/cron/persist.ts` 用 `per-id-json-store` 做轻量持久化（仅够 kimi 的会话级任务，不够 Hermes 账本，需升级为 SQL）。 |
| `fcntl`/`msvcrt` 文件锁 | 进程内 mutex + `.lock` PID 文件（单进程桌面端） | kimi-code 无文件锁（单进程 session 内内存 Map + 每 id JSON）。 |
| `threading.ThreadPoolExecutor`（并行池） | Web Worker / async 任务队列；workdir 任务进顺序队列（保留 Python 的串行化约束） | kimi-code scheduler 是单线程 async `onFire`，无并行池概念。 |
| `orjson`/`json` + 原子写 | `JSON.stringify` + Rust 原子写命令（tmp+rename+fsync） | `utils/per-id-json-store` 的 atomicWrite 语义相同。 |
| `AIAgent`（agent 任务执行） | 进程内 TS agent runtime（本仓其他 feature 的移植目标）；cron 侧只需“fresh session + 单轮 run”封装 | kimi-code `CronManager.handleFire → agent.turn.steer(...)`（`agent/cron/manager.ts` L177-199），给出“fire 即 steer 新 turn”的等价模式。 |
| 平台投递 adapter（telegram/discord/…） | **无 TS 等价物（kimi-code 无投递概念）**；桌面 standalone 仅覆盖本地/飞书/微信/email，其余标 out of scope | `web/src/routes/cron.tsx` L44-49 `DELIVERY_OPTIONS` 已限制桌面可接渠道。 |
| 执行账本 / skills 加载 / `context_from` / model 固定 / no-agent 脚本 / `[SILENT]` | **全部 from scratch**（kimi-code 完全没有这些概念） | 仅 `cron-create.ts` 的 zod schema + 会话级任务与“技能注入”沾边，但 kimi 无 Hermes 的 skill 系统。 |

结论：唯一能直接“拿来”的是 **cron 表达式解析 + 进程内 tick 引擎**（kimi-code
`cron-expr.ts` + `scheduler.ts`，整体约 970 行 TS 可移植）；其余（投递、账本、
no-agent、context_from、drift guard、`[SILENT]`）均为 Hermes 独有，需 from scratch，
接口按 §3 伪代码落位。

## 6. Integration with existing Hermes-CN-Desktop frontend

- `web/src/hooks/use-cron.ts`（113 行）：保留 `useCronJobs/useCreateCronJob/
  useUpdateCronJob/useDeleteCronJob/useCronAction/useCronRuns/useCronRunDetail` 签名，
  内部从 `fetchJSON/postJSON/putJSON/deleteJSON`（`web/src/lib/transport.ts`）改为调用
  `web/src/lib/cron-client.ts`（进程内 `CronService`）。`cronJobProfile()` 逻辑保留。
- `web/src/routes/cron.tsx`（685 行）+ `cron.module.css`：UI 整体复用；扩展点：
  - 创建表单加 skills 多选、`no_agent` 开关、workdir、model/provider 固定、deliver 多选
    （当前 `DELIVERY_OPTIONS` 只有 local/feishu/weixin/email，L44-49）；
  - 运行历史面板对接 `CronService.runs()`（现在走 `/__hermes_cron_runs`，由 Rust
    `src/cron_runs.rs` 读输出目录）。
- `packages/protocol/src/hermes-api.ts`（L937-1004）：扩展 `CronJob`/`CronSchedule`/
  `CronRun` schema（skills/context_from/no_agent/workdir/model/provider/
  enabled_toolsets/execution 状态）；`CronRunStatus` 增加 `blocked/unknown` 对齐 Python。
- Rust `src/cron_runs.rs`：保留并扩展为账本查询入口（`handle_cron_runs_request` L359 后
  增加按 `executions.db` 查询）；新增 `cron_store_*`、`cron_script_run`、`cron_output_write`
  等 Tauri 命令（进程内引擎的 fs/子进程能力）。
- 实时性：gateway 的 `/api/ws` 事件（如 job 状态变化推送）在进程内模式下由
  `CronService` 直接回调 + TanStack Query invalidate 替代，无需再订阅 WS。
- `hermes cron` CLI 与 `/cron` slash：桌面 standalone 无 Python CLI；对应能力收敛到
  Cron 页 + 进程内 agent 的 `cronjob` 工具（TS 实现），并可在设置页提供“运行状态/下次
  执行”摘要（等价 `hermes cron status`）。

## 7. Removing the WebSocket dependency (migration path)

- **冻结契约**（Phase 0）：`CronJob` wire schema（§4）与 `use-cron.ts` hook 签名是迁移期
  的稳定 API；UI 不感知数据源切换。`/api/cron/*` 与 `/__hermes_cron_runs` 保持可用直到
  Phase 5。
- **Phase A（现状）**：桌面端所有 cron 操作走 `transport.ts` → managed Python runtime
  REST `/api/cron/jobs` + WS `/api/ws` 状态流；`use-cron.ts` 直连。
- **Phase B（进程内接口先行）**：新增 `CronService` 接口 + 两个实现：
  `BackendCronService`（现状 REST，逻辑不变）与 `InProcessCronService`（§3 引擎）。
  `cron-client.ts` 按配置/feature flag 选择实现；默认仍走 Backend，仅验证引擎正确性。
- **Phase C（in-process 引擎接管）**：桌面端常驻 `CronScheduler`（webview 内 60s tick，
  或 Rust 侧 timer 经 IPC 触发）；CRUD 写 jobs.json；agent 任务经进程内 agent runtime；
  no-agent 脚本经 Rust 子进程；投递走桌面 IM 通道。此时 `/api/ws` 不再承载 cron 事件。
- **Phase D（删除 Python 路径）**：删除 `BackendCronService` 与 cron 相关的
  `/api/cron/*`、`/__hermes_cron_runs` 调用（保留 Rust 本地读取命令）；`use-cron.ts`
  只依赖 `cron-client.ts`。
- 风险护栏：Phase B→C 切换期间 `jobs.json` 仍由 Python runtime 写入，进程内引擎必须
  以“只读兼容 + 写前锁”启动，避免双写冲突；切换以 profile 维度灰度。

## 8. Migration phases & task breakdown

1. **Phase 0 — 契约与测试基线**：扩展 `packages/protocol` cron schema；为
   `use-cron.ts` 写 REST mock 的 vitest 快照；把 Python `tests/cron/` 的关键用例列成
   parity 清单（见 §10）。
2. **Phase 1 — 表达式与存储**：移植 `cron-expr.ts`（含 6 字段决定：不支持则报错）；
   写 `schedule.ts`（once/interval/cron/ISO/时长，对拍 `parse_schedule` 测试表）；
   `CronJobStore`（jobs.json CRUD、profile 隔离、claim/advance/mark、原子写）。
3. **Phase 2 — scheduler + no-agent 脚本**：`CronScheduler`（60s tick、due 检测、
   advance-first、并行/顺序池、in-flight 去重）；`CronRunner` 的 no-agent 分支（Rust
   子进程、stdout 投递、空输出静默、wakeAgent、超时）；`executions` 账本（SQLite）。
4. **Phase 3 — agent 任务 + 投递**：agent 分支（fresh session、prompt 组装、skills、
   `context_from`、workdir 注入、prompt-injection 扫描）；`delivery.ts`（含 `all` 扇出、
   origin、`[SILENT]`）；model/provider 固定 + drift guard；preflight 配置校验。
5. **Phase 4 — 桌面整合**：`cron-client.ts` + `use-cron.ts` 数据源切换；`cron.tsx`
   扩展表单与运行历史；Rust 命令补充（cron_store_*/cron_script_run）；`src/cron_runs.rs`
   账本化。
6. **Phase 5 — 清理**：删除 `BackendCronService`、REST/WS cron 路径；文档与
   `EXPECTED_BACKEND_VERSION` 无关性确认（cron 不再依赖 runtime 版本）；E2E 全绿。

## 9. Risks & open questions

- **croniter 6 字段（含 year）与秒级支持**：kimi-code `cron-expr.ts` 仅 5 字段；
  Python `parse_schedule` 接受 5/6 字段。TS 需决定：扩解析器支持第 6 字段，或明确拒绝
  并给出可迁移提示（建议拒绝，Hermes 文档只示例 5 字段）。
- **时区语义**：Python 用 `hermes_time`（配置时区）处理 `once` 时间戳与 naive 值
  （`_ensure_aware` L725、`_timezone_offset_mismatch` L746）。TS 必须复刻“naive 按
  系统本地、aware 转配置时区”的规则，否则一次性任务早/晚触发（Python 已有 #51021/#806
  事故先例）。
- **平台投递无 TS 等价物**：telegram/discord/slack/… adapter 均不在桌面 standalone
  范围（`DELIVERY_OPTIONS` 只有 local/飞书/微信/email）。`all` 扇出解析可纯函数移植，
  但“连到平台”仍需后端/未来 adapter 移植；迁移期投递走 REST 兜底。
- **agent 任务依赖 agent runtime 移植进度**：cron 的 agent 分支（run_job 语义）依赖
  进程内 TS agent loop；若该 feature 未完成，Phase 3 会阻塞，需保持
  `BackendCronService` 兜底。
- **并发与文件兼容**：Python 有跨进程 `.tick.lock`/`.jobs.lock`（Docker/CLI 并行写），
  桌面单进程可简化，但若用户同时跑全局 CLI 会双写 jobs.json → 保留 `.jobs.lock` PID
  检查。
- **`[SILENT]` 语义细节**：Python 放宽为“整段/首行/末行匹配”（L315-327），且失败任务
  必投递、空输出视为软失败（L5148-5153）。TS 必须逐条对拍，避免静默吞掉错误。
- **monitor（monitor_script/monitor_url）与 notepad**：规格未点名，但 jobs.py 已支持；
  若桌面要 1:1 parity 需一并移植，否则在计划中显式标 out of scope（建议 Phase 5 后）。
- **外部 scheduler provider（Chronos）**：`cron.provider` 实验接口不适用桌面 standalone
  （单进程常驻），可忽略但需在文档说明。

## 10. Test strategy

- **vitest 单元**（`packages/cron-core`）：
  - `cron-expr.test.ts`：对拍 Python `test_jobs.py` 的 schedule 表（once/interval/cron/
    ISO/时长/非法输入）；非法表达式、`0 0 31 2 *` 永不触发、dow/dom OR 规则。
  - `store.test.ts`：CRUD、pause/resume/run/remove、name 引用解析与歧义拒绝
    （`AmbiguousJobReference` L1936）、claim/advance/mark 语义（对拍
    `test_claim_job_for_fire.py`、`test_jobs.py`）。
  - `scheduler.test.ts`：tick 的 due 检测、advance-first、并行/顺序池拆分（对拍
    `test_parallel_pool.py`、`test_run_one_job.py`、`test_scheduler.py`）。
  - `silence.test.ts`：`[SILENT]` 整段/首行/末行/中间句中（对拍
    `gateway.response_filters` 行为）。
  - `delivery.test.ts`：`all` 扇出、origin、逗号列表、去重（对拍 scheduler
    `_resolve_delivery_targets`）。
  - `drift-guard.test.ts`：unpinned 快照 + 全局默认变化 fail-closed（对拍
    `test_cron_provider_pin.py`）。
  - `cronjob-schema.test.ts`：工具 schema 的 `action` 描述强制 create 必填 schedule
    （对拍 `test_cronjob_schema.py`）。
- **Rust 集成测试**（`tests/`，crate `hermes_agent_cn`）：executions 账本状态机与
  recovery（对拍 `test_execution_ledger.py`）；`cron_runs.rs` 输出读取；脚本子进程
  超时/脱敏；文件锁与原子写（tempfile + wiremock 惯例）。
- **Playwright E2E**（`e2e/`）：Cron 页创建（含 skills/workdir/no_agent）→ 列表 →
  pause/resume/trigger → 运行历史面板 → 删除；no-agent 脚本空输出不投递；`[SILENT]`
  任务不产生投递记录。
- **Parity 映射表**：`test_scheduler.py`→scheduler.test.ts、`test_jobs.py`→store.test.ts、
  `test_cronjob_schema.py`→cronjob-schema.test.ts、`test_execution_ledger.py`→Rust
  ledger、`test_claim_job_for_fire.py`→store.test.ts、`test_parallel_pool.py`→
  scheduler.test.ts、`test_run_one_job.py`→runner.test.ts、`test_cron_prompt_injection_
  skill.py`→runner prompt 扫描用例。

## 11. Reference links

- Python 源：`D:/hermes-agent-cn/cron/jobs.py`、`cron/scheduler.py`、
  `cron/executions.py`、`cron/blueprint_catalog.py`、`cron/suggestions.py`、
  `cron/scheduler_provider.py`、`cron/notepad.py`、`tools/cronjob_tools.py`、
  `hermes_cli/cron.py`、`hermes_cli/cli_commands_mixin.py`（`_handle_cron_command`）。
- 文档：`D:/hermes-agent-cn/website/docs/user-guide/features/cron.md`；
  清单：`D:/hermes-agent-cn/features_report.md`（cron 段 L59）。
- 测试：`D:/hermes-agent-cn/tests/cron/`（47 文件）、`tests/tools/test_cronjob_tools.py`、
  `tests/tools/test_cronjob_run_immediate.py`、`tests/tools/test_cronjob_run_background.py`、
  `tests/hermes_cli/test_cron*.py`、`tests/performance/test_cron_scheduler.py`、
  `tests/monitoring/test_cron_health_export.py`、`tests/plugins/test_chronos_cron.py`。
- TS 参考：`D:/kimi-code/packages/agent-core/src/agent/cron/manager.ts`、
  `agent/cron/index.ts`、`src/tools/cron/cron-expr.ts`、`src/tools/cron/scheduler.ts`、
  `src/tools/cron/session-store.ts`、`src/tools/cron/persist.ts`、`src/tools/cron/types.ts`、
  `src/tools/cron/cron-create.ts`、`src/tools/cron/cron-create.md`、
  `src/tools/cron/{clock,jitter,time-format,telemetry-events,cron-fire-xml}.ts`。
- 桌面：`D:/Hermes-CN-Desktop/web/src/routes/cron.tsx`、`web/src/hooks/use-cron.ts`、
  `web/src/routes/cron.module.css`、`packages/protocol/src/hermes-api.ts`（cron L937-1004）、
  `src/cron_runs.rs`、`web/src/lib/transport.ts`、`web/src/lib/tauri-bridge.ts`、
  `web/src/lib/gateway-client.ts`。
