# Kanban Multi-Agent Board — Python → TypeScript Rewrite Plan

## 1. Summary

Port the durable, SQLite-backed multi-agent kanban board from the Python core
(`D:/hermes-agent-cn`) into the TypeScript desktop monorepo so the board
(and its dispatcher/worker lanes) can run **in-process** without the Python
gateway / Dashboard WebSocket link. The port has four layers: (1) a Rust
`rusqlite` persistence facade that opens the *same* `~/.hermes/kanban*.db`
files the Python runtime uses (schema-compatible, WAL, `ui_store.rs` pattern);
(2) a TypeScript kanban kernel implementing the state machine, dependencies,
comments, tenants, block-loop breaker, review lifecycle, goal-mode cards and
circuit breaker; (3) a TypeScript dispatcher service (60 s tick, claim TTL,
crash reclaim, singleton lock, worker spawn via Rust child-process commands)
plus the 14 `kanban_*` tools registered in the in-process agent tool schema
(`BuiltinTool` pattern from kimi-code); (4) a native dashboard tab that
replaces today's `web/src/routes/kanban.tsx` link-out page. Migration is
phased: the TS kernel writes the Python DB schema directly, so Python CLI /
gateway and the desktop app can co-exist until the WS/REST path is deleted.

## 2. Current Python implementation

Source of truth under `D:/hermes-agent-cn` (all paths verified by reading):

- `hermes_cli/kanban.py` (3412 lines) — CLI + slash-command surface:
  `build_parser()` (lines 217–1005), `kanban_command()` (1006),
  `run_slash()` entry; boards subcommands, create/list/show/edit/link/claim/
  comment/complete/block/unblock/archive, request-review/request-changes/
  reopen-review, dispatch/daemon (deprecated), stats/diagnostics/runs/watch/
  notify-*/context/specify/decompose/gc/swarm.
- `hermes_cli/kanban_db.py` (11342 lines) — the kernel. Key constants:
  `VALID_STATUSES = {triage, todo, scheduled, ready, running, blocked, review,
  done, archived}` (line 103), `VALID_BLOCK_KINDS = {dependency, needs_input,
  capability, transient}` (126), `BLOCK_RECURRENCE_LIMIT = 2` (135),
  `DEFAULT_CLAIM_TTL_SECONDS = 15*60` (220),
  `DEFAULT_CLAIM_HEARTBEAT_MAX_STALE_SECONDS = 60*60` (230),
  `RECLAIM_DEFER_GRACE_SECONDS = 120` (240), `DEFAULT_CRASH_GRACE_SECONDS =
  30` (272), `KANBAN_ATTACHMENT_MAX_BYTES = 25 MB` (163). Schema (lines
  1185–1378): `tasks` (claim_lock, claim_expires, tenant, idempotency_key,
  consecutive_failures, worker_pid, current_run_id, max_runtime_seconds,
  skills, model/provider_override, reasoning_effort, max_retries, goal_mode,
  goal_max_turns, session_id, block_kind, block_recurrences, ...),
  `task_links`, `task_comments`, `task_events`, `task_runs`, `task_attachments`,
  `kanban_notify_subs`. Writes go through `write_txn` (BEGIN IMMEDIATE, WAL,
  busy_timeout 120 s) with `_assert_not_delegated_child_mutation()` guard;
  `_fire_kanban_lifecycle_hook` after commit.
- `tools/kanban_tools.py` (2477 lines) — the **14-tool registry**: schemas
  `KANBAN_SHOW/LIST/COMPLETE/BLOCK/REQUEST_REVIEW/REQUEST_CHANGES/HEARTBEAT/
  COMMENT/ATTACH/ATTACH_URL/ATTACHMENTS/CREATE/UNBLOCK/LINK_SCHEMA` (lines
  1693–2330) + handlers (518–1663). Guards: `_enforce_worker_task_ownership`,
  `_reject_delegated_child_mutation`, `_require_orchestrator_tool`; task
  scoping via `HERMES_KANBAN_TASK` env.
- `gateway/kanban_watchers.py` (1546 lines) — `GatewayKanbanWatchersMixin`:
  dispatcher tick, `_acquire_singleton_lock` (76) / `_release_singleton_lock`
  (113), auto-decompose settings (28), `_kanban_advance` (818), notify-sub
  watcher (854), worker spawn env contract (see worker-lanes doc).
- `plugins/kanban/` — `dashboard/plugin_api.py` FastAPI router (board GET,
  task GET/POST/PATCH, bulk, comments, specify, decompose, profiles,
  orchestration, links, dispatch nudge, config, WS `/events?since=` tail) +
  `manifest.json` + `systemd/hermes-kanban-dispatcher.service` (deprecated
  standalone daemon).
- Docs: `website/docs/user-guide/features/kanban.md` (1142 lines) and
  `kanban-worker-lanes.md` (117 lines) — lane contract: assignee string,
  spawn mechanism (default `hermes -p <profile>` with the
  `HERMES_KANBAN_TASK/_DB/_BOARD/_WORKSPACES_ROOT/_WORKSPACE/_RUN_ID/
  _CLAIM_LOCK`, `HERMES_PROFILE`, `HERMES_TENANT` env vars), lifecycle
  terminator (`complete` / `request_review` / `request_changes` / `block` /
  crash/gave_up/timed_out).

Data flow today: CLI/`/kanban`/dashboard → `kanban_db` → SQLite; the
gateway-embedded dispatcher polls every 60 s → reclaim → promote → claim →
spawn; workers drive their card via `kanban_*` tool calls (never shell out);
dashboard tails `task_events` over WS and re-fetches the cheap board endpoint.

## 3. Target TypeScript design

Runs fully in-process: the React webview hosts the agent runtime (TS); Rust
provides OS-level SQLite + child-process capabilities via Tauri IPC.

```
web/src/features/kanban/
  kernel/            kanban-kernel.ts, status-machine.ts, block-loop.ts,
                     review.ts, goal-loop.ts, dependency-gate.ts, circuit-breaker.ts
  db/                kanban-db-client.ts   (Tauri IPC facade over Rust commands)
  dispatcher/        dispatcher.ts, singleton-lock.ts, reclaim.ts, spawner.ts,
                     lanes.ts, decompose.ts, tick-scheduler.ts
  tools/             registry.ts + 14 files (kanban-show.ts ... kanban-link.ts)
  dashboard/         KanbanBoardPage.tsx, columns, card, drawer, bulk-bar,
                     filters, board-switcher, event-subscription store
src/ (Rust)
  kanban.rs          rusqlite store (schema-compatible), WAL, write_txn
  kanban_worker.rs   child-process spawn/pid/liveness (reuse src/process/*)
  commands/kanban.rs Tauri command wrappers
```

- **Kernel (TS, no UI deps)**: `KanbanKernel` exposes the same operations as
  `kanban_db`: create/list/show/update/link/unlink/claim/heartbeat/complete/
  block/unblock/requestReview/requestChanges/reopenReview/comment/attach/
  schedule/setModel/archive/promote/notifySub/recomputeReady. Every mutation
  funnels through one `writeTxn(fn)` helper that calls the Rust command with
  `BEGIN IMMEDIATE` semantics; the kernel owns the invariants (status machine,
  dependency gate, block-loop breaker, circuit breaker, review routing).
- **14-tool registry (TS)**: each tool implements the kimi-code `BuiltinTool`
  shape (`name`, `description`, `parameters` from a Zod input schema,
  `resolveExecution(args) → ToolExecution {description, display, approvalRule,
  execute}`) — see §5. Dispatcher-spawned workers see the task-scoped subset
  (show/complete/block/request_review/request_changes/heartbeat/comment/
  attach/attach_url/attachments); orchestrator profiles additionally see
  list/create/link/unblock, gated by the same env-based ownership checks.
- **Dispatcher (TS service)**: `startDispatcher()`/`stopDispatcher()`; a 60 s
  `setInterval` tick performs, in order: singleton lock check → reclaim stale
  claims → detect crashed workers → auto-decompose (capped per tick) →
  `recomputeReady` dependency promotion → atomic claim → spawn worker via
  Rust. A `nudge()` command triggers an immediate tick (dashboard "Nudge
  dispatcher" button). Worker spawn for the Hermes profile lane is a Rust
  child process (`hermes -p <assignee> chat -q <prompt>` with the env
  contract above); `spawn_fn` stays pluggable for future external CLI lanes.
- **Worker lanes (TS)**: `interface WorkerLane { assignee: string; spawn(
  task, workspace, board) → Promise<{pid}>; }`. Default `HermesProfileLane`
  (Python-runtime worker during migration; later an in-process TS agent).
  Unknown assignees leave the task `ready` with a `skipped_nonspawnable`
  event — no silent fallback.
- **Dashboard tab (TS)**: native React page replacing the launcher — columns
  per status (`triage todo ready running blocked review done archived`),
  drag-drop (HTML5 + pointer fallback), card drawer (title/body/assignee/
  priority/tenants/dependencies/comments/run history/attachments), bulk
  actions, filters (search/tenant/assignee/archived), Running lanes grouped
  by profile, board switcher, Orchestration Auto/Manual pill, Decompose/
  Specify buttons, worker-visibility panel, trash drop zone. Live updates via
  an in-app event bus fed by the kernel's `task_events` append (no WS).

## 4. Data models & persistence

- **SQLite (Rust, rusqlite)**: one DB per board — `~/.hermes/kanban.db`
  (default board, back-compat path) and
  `~/.hermes/kanban/boards/<slug>/kanban.db`; WAL + `busy_timeout` (120 s)
  exactly like `_sqlite_connect` (kanban_db.py 1425–1447). Copy the Python
  `SCHEMA_SQL` verbatim (tables + indexes) so Python and TS can share a DB
  during migration; additive migrations stay in the Rust `init_schema` with a
  `schema_migrations` table (ui_store.rs pattern, `SCHEMA_VERSION`).
- **Tables (unchanged)**: `tasks`, `task_links`, `task_comments`,
  `task_events`, `task_runs`, `task_attachments`, `kanban_notify_subs`.
  Status enum: the 8 requested statuses `triage→todo→ready→running→blocked→
  review→done→archived`; Python's extra `scheduled` status is preserved in the
  DB (it is set by `--scheduled-at`) but rendered as a "scheduled" chip on
  `ready` cards, not a column.
- **Attachments**: metadata rows + blobs on disk under
  `kanban/attachments/<task_id>/` (per board variant); Rust commands handle
  file copy/delete; TS passes base64 or URL through the attach tools.
- **Claim model**: `tasks.claim_lock/claim_expires/worker_pid` +
  `task_runs` rows; TTL 15 min default, heartbeat extends, dead-PID reclaim
  with `RECLAIM_DEFER_GRACE_SECONDS`, crash grace 30 s, per-run
  `max_runtime_seconds` cap.
- **Circuit breaker**: `tasks.consecutive_failures` (increment on spawn
  failure/timeout/crash; reset on success), default limit 2, per-task
  `max_retries` override; auto-block with last error as reason.
- **Board registry**: `~/.hermes/kanban/current` pointer + `boards/<slug>/`
  dirs; slug validation `^[a-z0-9][a-z0-9\-_]{0,63}$`.

## 5. Third-party library strategy

| Python dependency | TS equivalent | Evidence (kimi-code / desktop) |
|---|---|---|
| `sqlite3` (stdlib) | **Rust `rusqlite`** via Tauri IPC | `D:/Hermes-CN-Desktop/src/ui_store.rs` (rusqlite, WAL, migrations) + `src/commands/ui_store.rs`. No `better-sqlite3` in kimi-code; README assigns SQLite to Rust. |
| `argparse` CLI | **No port needed** — CLI stays Python; desktop uses tools + REST-equivalent IPC. `run_slash` surface documented for parity only. | kimi-code `tools/builtin/planning/enter-plan-mode.ts` shows CLI → tool mapping pattern. |
| tool schema (orjson dicts) | **Zod input schemas + `BuiltinTool`** | `D:/kimi-code/packages/agent-core/src/agent/tool/types.ts` (`BuiltinTool`, `parameters: Record<string, unknown>`) and `tools/builtin/planning/enter-plan-mode.ts`, `tools/builtin/state/todo-list.ts`. |
| `asyncio` dispatcher loop | **TS `setInterval` service + Rust pid liveness** | kimi-code `tools/cron/scheduler.ts`, `tools/cron/persist.ts` (tick + persistence); desktop `src/process/gateway.rs`/`dashboard.rs` (Child, pid, taskkill, drain). |
| FastAPI dashboard router | **React page + Rust IPC commands** | existing desktop `web/src/routes/*`, `packages/protocol/src/channels.ts` (IPC channel names), `hermes-api.ts` (Zod surface — extend with kanban). |
| `goals` engine (goal-mode) | **kimi-code goal engine analog** | `D:/kimi-code/packages/agent-core/src/agent/goal/` + `tools/builtin/goal/*` (create-goal, update-goal, set-goal-budget) — reuse pattern for per-card goal loop + judge. |
| `plugins`/hooks | **Tauri events / Jotai event bus** | desktop `web/src/stores/*` (Jotai), Tauri `listen` events; kernel emits lifecycle events post-commit. |
| `fastapi` WS events tail | **In-app event subscription store** | replace WS tail of `task_events` with kernel append callback + React store refresh (docs: "reloads are debounced"). |

**No TS equivalent found**: there is **no kanban feature anywhere in
`D:/kimi-code`** — the only matches are Mermaid *diagram* definitions in
`apps/kimi-code/dist-web/assets/kanban-definition-*.js`, which are unrelated
(rendering a `kanban` mermaid chart type, not a board). So the entire board
(kernel, dispatcher, lanes, dashboard) is designed from scratch in TS, using
kimi-code only for the *tool registry pattern* (`BuiltinTool`) and the *goal /
cron / todo-list* service patterns. The prompt template's "agent/tool/planning/"
path actually resolves to `packages/agent-core/src/tools/builtin/planning/`
(verified) — that is the closest planning analog and it is a plan-mode
on/off tool, not a durable board.

## 6. Integration with existing Hermes-CN-Desktop frontend

- **Replace** `web/src/routes/kanban.tsx` (currently a link-out launcher:
  "桌面端只提供入口…打开官方看板") with the native `KanbanBoardPage`; keep the
  route registered in `web/src/app.tsx` (lazy) and the sidebar entry in
  `web/src/components/app-shell/workbench-sidebar.tsx` +
  `use-active-top-tab.ts`.
- **Reuse** `packages/protocol/src/hermes-api.ts` for all kanban request/
  response Zod schemas (add a `kanban-api.ts` section), `channels.ts` for new
  Tauri channel names, `web/src/lib/tauri-bridge.ts` for the IPC shim,
  `web/src/stores/*` (Jotai) for board/UI state, `web/src/hooks/use-status.ts`
  for dashboard/gateway health gating, and shared-ui components.
- **Rust side**: new `src/kanban.rs` + `src/commands/kanban.rs` mirroring the
  `src/ui_store.rs` + `src/commands/ui_store.rs` split (snapshot/set/remove
  command pattern); reuse `src/process/*` helpers for worker spawn, pid
  tracking, stdout log files, and Windows `taskkill` termination.
- **Config**: read `kanban.*` and `dashboard.kanban.*` keys from
  `~/.hermes/config.yaml` via the existing config loader
  (`web/src/lib/config-translations.ts`, `use-config.ts`) — not hardcoded.

## 7. Removing the WebSocket dependency (migration path)

Freeze this API surface during migration (it is the contract the TS kernel
must reproduce): (a) the 14 `kanban_*` tool signatures; (b) the dashboard REST
surface (`/board`, `/tasks…`, `/links`, `/dispatch`, `/config`,
`/orchestration`, `/profiles…`, `/workers/active`, `/runs/{id}`,
`/runs/{id}/terminate`, `/inspect`); (c) `task_events` kinds (promoted,
claimed, heartbeat, completed, blocked, review_requested, changes_requested,
review_reopened, gave_up, crashed, timed_out, reclaimed, claim_extended,
spawn_auto_blocked, skipped_nonspawnable, respawn_guarded, protocol_violation,
tip_scratch_workspace).

- **Phase A (read/co-exist)**: Rust commands open the Python DB read/write;
  TS kernel behind the frozen interface; dashboard tab still links out to
  Python Dashboard; parity tests green.
- **Phase B (in-app surface)**: dashboard tab renders from TS kernel + local
  event bus; the Python WS `/events` tail is no longer consumed by the app;
  writes go through the same SQLite so Python CLI/gateway still see them.
- **Phase C (dispatcher move)**: in-app TS dispatcher becomes the active
  dispatcher; Python `kanban.dispatch_in_gateway` disabled by default; the
  Rust singleton file-lock prevents double dispatch during overlap.
- **Phase D (delete)**: remove `gateway-client.ts` kanban routes and the
  Python `/api/plugins/kanban` + WS path from the desktop's runtime surface;
  the Python feature stays for headless/CLI users.

## 8. Migration phases & task breakdown

1. **Rust DB facade** — port `SCHEMA_SQL`, `init_schema`, WAL/busy_timeout,
   write_txn, board path resolution, current-board pointer, slug validation,
   migrations; commands: `kanban_db_snapshot`, `kanban_write_txn` (generic
   op-code), `kanban_attach_store`, `kanban_worker_spawn`, `kanban_worker_list`,
   `kanban_worker_terminate`.
2. **TS kernel** — status machine, dependency gate/recomputeReady, block-loop
   breaker, circuit breaker, claim/heartbeat, review lifecycle, goal-mode
   fields, idempotency keys, notify-subs, attachments metadata, GC.
3. **14 tools** — Zod schemas + handlers + ownership guards + auto-injected
   `KANBAN_GUIDANCE` system-prompt block for workers/orchestrators.
4. **Dispatcher service** — tick scheduler, singleton lock, reclaim (TTL +
   dead PID + max_runtime), spawner (profile lane env), auto-decompose cap,
   max_in_progress(+per_profile), respawn guard, protocol-violation nudges,
   nudge endpoint.
5. **Dashboard tab** — columns/drag-drop/drawer/bulk/filters/lanes/board
   switcher/create dialog/decompose+specify buttons/orchestration pill/
   worker-visibility/trash zone; event-bus live refresh.
6. **Worker lanes hardening** — log files under `logs/<task_id>.log`,
   diagnostics (`stranded_in_ready`, `review_dependency_deadlock`), runs
   table completeness.
7. **Migration phases A–D + docs** — update `kanban.md`-equivalent desktop
   docs; delete WS path.

## 9. Risks & open questions

- **Shared-DB co-existence**: TS and Python both writing the same SQLite file
  requires byte-identical schema and locking discipline; risky during Phase B
  if the Python dispatcher is still live (claim races). Mitigation: singleton
  file lock + one active dispatcher; freeze schema; keep `scheduled` status.
- **No TS kanban reference** (see §5) — all domain rules are ported by hand;
  the block-loop breaker, review routing, and crash-reclaim semantics are
  subtle and must be parity-tested against Python, not re-derived.
- **Worker spawn still needs the Python runtime** during migration
  (`hermes -p …` child process). Full in-process TS worker lanes depend on the
  broader agent-runtime port; until then the dispatcher is TS but workers are
  Python subprocesses (same as today, minus the WS link).
- **Windows specifics**: PID liveness checks and process cleanup need the
  `tasklist`/`taskkill` paths already used in `src/process/gateway.rs`;
  `msvcrt`-style locking must be replicated in Rust for the singleton lock.
- **`scheduled` status** in Python vs the 8 requested statuses — decide
  whether to expose it as a 9th column or render as a ready-card chip.
- **External CLI worker lanes** (Codex/Claude Code/OpenCode) are explicitly
  "not yet a paved path" in `kanban-worker-lanes.md` — the TS spawner keeps
  `spawn_fn` pluggable but does not promise first-party lanes.

## 10. Test strategy

Parity suite mapping Python tests (`D:/hermes-agent-cn/tests/`) to vitest:

| Python test | TS test |
|---|---|
| `tests/hermes_cli/test_kanban_db.py`, `test_kanban_core_functionality.py` | `kernel/*.test.ts` — create/list/show/update, idempotency, tenants |
| `test_kanban_blocked_sticky.py`, `test_kanban_block_kinds.py` | `kernel/block-loop.test.ts` — kinds, recurrence breaker → triage |
| `test_kanban_review_lifecycle*.py`, `test_kanban_review_surfaces.py` | `kernel/review.test.ts` — request_review/request_changes/reopen, no block recurrence, CAS `expected_run_id` |
| `test_kanban_goal_mode.py` | `kernel/goal-loop.test.ts` — persistence, budget exhaustion blocks |
| `test_kanban_dispatch_lock.py`, `test_kanban_reclaim_claim_lock_guard.py`, `test_kanban_write_txn_busy_retry.py`, `test_kanban_init_lock_bounded.py` | `dispatcher/*.test.ts` — atomic claim, TTL reclaim, dead-PID reclaim, busy retry |
| `test_kanban_boards.py`, `test_kanban_board_project.py`, `test_kanban_project_link.py` | `db/boards.test.ts` — slug validation, per-board isolation |
| `test_kanban_comment_queries.py`, `test_kanban_comment_injection.py` (tools) | `kernel/comments.test.ts` — author/thread/redaction |
| `test_kanban_tools.py`, `test_kanban_redaction.py` (tools) | `tools/*.test.ts` — 14 tool schemas, orchestrator/worker guards |
| `test_kanban_decompose*.py`, `test_kanban_specify*.py` | `dispatcher/decompose.test.ts` — fan-out graph, fallback to specify |
| `tests/plugins/test_kanban_dashboard_plugin.py` | Playwright E2E on `KanbanBoardPage` — columns, drag-drop, drawer, bulk, filters, nudge |
| `tests/cron/test_cron_kanban_env_isolation.py` | `dispatcher/env-isolation.test.ts` — worker env contract |

Run both Python and TS suites in CI until Phase D; add a schema-diff check
(`PRAGMA table_info`) against a Python-created DB to catch drift.

## 11. Reference links

- `D:/hermes-agent-cn/hermes_cli/kanban.py`, `kanban_db.py`
- `D:/hermes-agent-cn/tools/kanban_tools.py`
- `D:/hermes-agent-cn/gateway/kanban_watchers.py`
- `D:/hermes-agent-cn/plugins/kanban/dashboard/plugin_api.py`
- `D:/hermes-agent-cn/website/docs/user-guide/features/kanban.md`,
  `kanban-worker-lanes.md`
- `D:/hermes-agent-cn/tests/hermes_cli/test_kanban_*.py` (39 files),
  `tests/tools/test_kanban_*.py`, `tests/plugins/test_kanban_dashboard_plugin.py`,
  `tests/cron/test_cron_kanban_env_isolation.py`
- `D:/kimi-code/packages/agent-core/src/agent/tool/types.ts`,
  `tools/builtin/planning/enter-plan-mode.ts`,
  `tools/builtin/state/todo-list.ts`, `agent/goal/`, `tools/cron/`
- `D:/Hermes-CN-Desktop/web/src/routes/kanban.tsx`,
  `web/src/app.tsx`, `packages/protocol/src/channels.ts`,
  `packages/protocol/src/hermes-api.ts`, `src/ui_store.rs`,
  `src/commands/ui_store.rs`, `src/process/gateway.rs`,
  `src/process/dashboard.rs`
