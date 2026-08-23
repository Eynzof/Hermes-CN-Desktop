# Session Heartbeat — Python → TypeScript Rewrite Plan

## 1. Summary

`/heartbeat` gives the **current session** one recurring instruction
(`/heartbeat every 10m Check the deployment and report meaningful changes`).
When the interval has elapsed AND the session is idle, the prompt is injected
as a **normal user turn** — same conversation, same context, same prompt
cache. If the agent is busy at the due moment, the tick coalesces: it fires
exactly once when the session next goes idle (no backlog; the timer
re-anchors on every fire). State is persisted per-session (`SessionDB
state_meta` key `heartbeat:<session_id>` today) so `/resume` and
context-compression session rotation pick it up.

This plan ports the feature to TypeScript so the desktop web app can run it
**in-process** (renderer, Tauri webview) without the Python runtime: a
`HeartbeatManager`-shaped TS module + a poll scheduler that reuses the
existing chat-runtime busy/idle detection, plus a new client-side slash
command (`/heartbeat`, alias `/hb`) alongside the existing `/compress`
builtin. The Python reference implementation is `hermes_cli/heartbeat.py`
with drivers in `cli.py` and `gateway/run.py`; **kimi-code has no equivalent
feature** (verified — only connection-level heartbeats and a different
idle-gated cron scheduler), so the TS side is designed from scratch, reusing
kimi-code's *idle-gated delivery + coalescing* pattern where it applies.

> Correction to the feature inventory: `run_agent.py`'s "heartbeat" strings
> and `agent/session_activity.py` are an **unrelated** observation-only
> liveness projection (durable SessionDB activity stamps, cadence 60s). The
> actual `/heartbeat` feature lives in `hermes_cli/heartbeat.py` +
> `cli.py` + `gateway/run.py` + `gateway/slash_commands.py`.

## 2. Current Python implementation

Source of truth: `D:/hermes-agent-cn`.

- **Core module** — `hermes_cli/heartbeat.py` (332 lines):
  - `MIN_INTERVAL_SECONDS = 60`, `POLL_SECONDS = 5.0`,
    `HEARTBEAT_PROMPT_TEMPLATE` (banner + prompt + "don't invent work" guard).
  - `parse_interval()` / `format_interval()` — `10m`/`every 2h`/`90 minutes`
    parsing; too-small returns `-1`; formatting to `10m`/`2h`/`1d`/`90s`.
  - `HeartbeatState` dataclass: `prompt`, `interval_seconds`, `status`
    (`active|paused|cleared`), `created_at`, `last_fired_at`, `fire_count`;
    `is_due(now)` anchors on `last_fired_at or created_at`; `render_prompt()`.
    Persistence via `load_heartbeat`/`save_heartbeat` — SessionDB `state_meta`
    key `heartbeat:<session_id>`, reusing `hermes_cli.goals._get_session_db()`.
  - `HeartbeatManager` — `set` (validates empty prompt / min interval),
    `pause`, `resume` (re-anchors `last_fired_at = now` so resume never
    instantly fires), `clear`, and the driver entry `due_prompt()`: if due,
    **records the fire immediately** (`last_fired_at = now`, `fire_count +=
    1`, persists) then returns the rendered prompt — so overlapping polls or
    a long turn can never double-fire; missed ticks coalesce by re-anchoring
    to NOW, not the theoretical schedule.
  - `migrate_heartbeat_to_session(old, new)` — compression rotation copy
    (parent archived as `cleared`), mirroring `goals.migrate_goal_to_session`.
- **CLI driver** — `cli.py`: `_get_heartbeat_manager()` (~10978) returns a
  lazy cached `HeartbeatManager` bound to `self.session_id` (mirrors
  `_get_goal_manager`); `_start_heartbeat_watchdog()` (~11002) starts a daemon
  `heartbeat-watchdog` thread polling `time.sleep(POLL_SECONDS)`; busy =
  `_agent_running or _voice_recording or _voice_processing or not
  _pending_input.empty()`; when idle and `due_prompt()` returns a prompt it
  pushes into `_pending_input` as a normal user turn. Idempotent start.
- **Command handlers** — CLI `hermes_cli/cli_commands_mixin.py`
  `_handle_heartbeat_command()` (~2523) and gateway
  `gateway/slash_commands.py` `_handle_heartbeat_command()` (~2784) share the
  same grammar: `status` (default), `pause`, `resume`, `clear`/`stop`/`off`,
  set (`every <interval> <prompt>` or `<interval> <prompt>`); CLI starts the
  watchdog on set/resume, gateway registers/unregisters a watch.
- **Gateway driver** — `gateway/run.py`: `_get_heartbeat_manager_for_event()`
  (~20174); `_register_heartbeat_watch()` (~20194, in-memory
  `quick_key → (source, session_id)`); `_start_heartbeat_poller()` (~20215) —
  one gateway-wide asyncio task polls every 5s, skips sessions in
  `_running_agents`, builds a `MessageEvent` and enqueues via adapter FIFO.
- **Compression integration** — `agent/conversation_compression.py` (line
  ~3395): calls `migrate_heartbeat_to_session(old_session_id,
  agent.session_id)` when rotating sessions.
- **Docs** — `website/docs/user-guide/features/heartbeat.md` (commands table,
  idle-only/coalescing/cache-safe/persistence invariants);
  `website/docs/reference/slash-commands.md`.
- **Tests** (parity source) — `tests/hermes_cli/test_heartbeat.py` (interval
  parsing, state roundtrip, `is_due` anchor semantics, paused-never-due,
  manager lifecycle, persist across instances, fires-once-and-reanchors,
  missed-ticks-coalesce, resume-reanchors, compression migration);
  `tests/cron/test_idle_tick_config_skip.py` (idle poll tick must be cheap).
  `tests/tools/test_heartbeat_stale_thresholds.py` and
  `tests/cron/test_script_claim_heartbeat.py` are **unrelated** liveness tests.

## 3. Target TypeScript design

Runs entirely in the renderer (React web app inside the Tauri webview), so
no Python runtime / WS link is needed. One heartbeat per session, low
frequency (min interval 60s, poll 5s), so a `setInterval` in a module-scope
singleton is sufficient — **no Web Worker required** (a worker would only be
justified if we later host many concurrent sessions; the Python side uses one
daemon thread / one asyncio task, which a single timer singleton mirrors).

Module layout (all new files under the existing web app):
```
web/src/lib/heartbeat/ — types.ts (HeartbeatState/status), interval.ts (parse/format),
  state.ts (persist backend), manager.ts (set/pause/resume/clear/duePrompt),
  scheduler.ts (module-singleton 5s poll; idle gate + submit injection),
  commands.ts (/heartbeat parser)
web/src/hooks/use-heartbeat.ts — React binding: starts scheduler, surfaces status atom
web/src/stores/heartbeat.ts — heartbeatBySessionAtom + statusLine selectors
```
Key interfaces (signatures only, no implementation):
```ts
// types.ts
export type HeartbeatStatus = "active" | "paused" | "cleared";
export interface HeartbeatState {
  prompt: string;
  intervalSeconds: number;
  status: HeartbeatStatus;
  createdAt: number;      // epoch ms
  lastFiredAt: number;    // epoch ms, 0 = never
  fireCount: number;
}
export interface HeartbeatPersistBackend {
  load(persistentSessionId: string): HeartbeatState | null;
  save(persistentSessionId: string, state: HeartbeatState): void;
}
// interval.ts
export const MIN_INTERVAL_SECONDS = 60;
export const POLL_SECONDS = 5;
export function parseInterval(text: string): number | null | -1; // seconds | not-an-interval | too-small
export function formatInterval(seconds: number): string;          // "10m" | "2h" | "1d" | "90s"
export const HEARTBEAT_PROMPT_TEMPLATE: (interval: string, prompt: string) => string;
// manager.ts
export class HeartbeatManager {
  constructor(sessionId: string, persist: HeartbeatPersistBackend, now?: () => number);
  get state(): HeartbeatState | null;
  hasHeartbeat(): boolean;  isActive(): boolean;  statusLine(now?: number): string;
  set(prompt: string, intervalSeconds: number): HeartbeatState; // throws on empty/too-small
  pause(): HeartbeatState | null;  resume(): HeartbeatState | null;  clear(): boolean;
  duePrompt(now?: number): string | null; // records fire synchronously; re-anchor = coalescing
}
// scheduler.ts
export interface HeartbeatSchedulerDeps {
  isIdle(): boolean;                        // see idle gate below
  getActiveSession(): string | null;        // persistent session id, or null
  submit(prompt: string): Promise<void>;    // same submit path as a user message
  persist: HeartbeatPersistBackend;
}
export function ensureHeartbeatScheduler(deps: HeartbeatSchedulerDeps): () => void; // idempotent start, returns stop
```
Data flow:
1. User types `/heartbeat every 10m Check CI` → composer builtin parser
   (`builtin-commands.ts` extended) → `HeartbeatManager.set(...)` → persist
   (phase 1: RPC to backend; phase 2/3: client backend) →
   `ensureHeartbeatScheduler()` (idempotent).
2. Scheduler ticks every `POLL_SECONDS`: no active session → skip; `!isIdle()`
   → skip (busy tick coalesces; Python parity: CLI skips while
   `_agent_running`/voice/queue non-empty, gateway skips `_running_agents`);
   `const prompt = mgr.duePrompt()` records `lastFiredAt` **synchronously**
   before any await (double-fire guard); if prompt → `submit(prompt)` through
   the exact normal-user-message path (role alternation + cache preserved).
3. `/heartbeat status|pause|resume|clear` → same `HeartbeatManager` surface,
   rendered as a chat notice via the existing notice/status mechanism.

**Idle gate (must be defined precisely, see Risks):** idle ⇔
`!isRuntimeRunning(runtime)` (i.e. `streamStatus` is `idle|complete|error`),
no `pendingApprovals`, no `tool` part with `state === "running"`, AND no
locally in-flight user submit (a queued user message wins — Python parity).
Reuse `isRuntimeRunning()` from `web/src/lib/session-activity.ts` as the base
and add the "no queued submit" condition.

## 4. Data models & persistence

State JSON stays byte-compatible with the Python shape (Phase 1 must read
rows written by the backend):
```json
{
  "prompt": "Check the deployment and report meaningful changes",
  "interval_seconds": 600,
  "status": "active",
  "created_at": 0.0,        // Python epoch seconds; TS stores ms and converts on the RPC boundary
  "last_fired_at": 0.0,
  "fire_count": 0
}
```
- **Phase 1 (backend-owned):** state stays in `SessionDB.state_meta` key
  `heartbeat:<session_id>`; desktop reads/writes via new frozen RPC methods
  (section 7). No client persistence yet.
- **Phase 2/3 (client-owned):** `HeartbeatPersistBackend` default writes
  `hermes.heartbeat.<persistentSessionId>` via the existing
  `readUiValue`/`writeUiValue` (localStorage) pattern already used by
  `gwSessionIdAtom` in `web/src/stores/chat.ts`; if a Rust-side store is
  preferred later, swap in a Tauri IPC backend (JSON file or SQLite via
  `src/commands/*`) behind the same interface. No schema migration is needed
  for a single JSON key; add a `schema_version: 1` field defensively.
- **Session rotation:** when `session.resume` returns a new gateway session
  id or context compression rotates the session, re-key the stored state
  (mirror `migrate_heartbeat_to_session` — copy to child, clear parent).
  `web/src/lib/session-map.ts` `resolvePersistentSessionId` gives the stable
  key; `gateway-reconnect.ts` is the hook point to rehydrate after reconnect.
- **In-memory:** `heartbeatBySessionAtom` (Jotai) mirrors per-session state
  for the status panel; derived atom for `nextFireInSeconds`.

## 5. Third-party library strategy

Python uses **stdlib only** (`json`, `re`, `time`, `dataclasses`, `threading`,
`asyncio`) — there is no Python third-party dependency to replace.

- TS equivalent: **no new npm package**. Timer → `window.setInterval` /
  `Date.now()` (existing precedent: `web/src/hooks/use-composer-timer.ts`
  `window.setInterval`, `web/src/hooks/use-stall-watchdog.ts`). State →
  Jotai atoms (existing). Parsing → a small regex port of
  `_INTERVAL_RE`/`_UNIT_SECONDS` (implement from scratch, ~30 lines).
- **kimi-code evidence (verified by search):** there is **no `/heartbeat` or
  "recurring prompt while idle" feature** anywhere in `D:/kimi-code`.
  Searches for `heartbeat`, `idle`, `recurring prompt` only surface:
  - connection/transport heartbeats (`kap-server/src/transport/ws/*`,
    `protocol/src/events.ts`); lock liveness
    (`tools/cron/clock.ts`); `GlobalIdleValue`/`requestIdleCallback` host-idle
    deferral (`di/util/idleValue.ts`) — all unrelated;
  - **closest analogue**: the cron scheduler's **idle-gated delivery** —
    `agent/cron/manager.ts` `isIdle: () => !agent.turn.hasActiveTurn` and
    `tools/cron/scheduler.ts` (`isIdle()` gates fires, not state updates;
    missed occurrences collapse into ONE `onFire` with `coalescedCount`).
    Proves the TS pattern for "hold a fire until idle, then coalesce" — reuse
    the *pattern*, not the code (cron is multi-task, isolated-session;
    heartbeat is one-per-session, same-context).
- Decision: implement the heartbeat module **from scratch** as sketched in
  section 3, borrowing only the idle-gate + coalesce semantics from
  kimi-code's cron scheduler. No Web Worker, no cron lib — the feature needs
  one monotonic 5s poll per active session.

## 6. Integration with existing Hermes-CN-Desktop frontend

- `web/src/lib/builtin-commands.ts` — extend `BuiltinCommandName` with
  `"heartbeat"` (alias `hb`) following the `/compress` pattern:
  `BUILTIN_ALIASES`, `parseBuiltinComposerCommand`, and a palette entry in
  `BUILTIN_COMMAND_SPECS` so `/heartbeat …` submits client-side instead of
  going to the model. `web/src/lib/composer-skills.ts` parsing utilities are
  reused as-is.
- `web/src/components/chat/goose-composer.tsx` — the submit path branches on
  `parseBuiltinComposerCommand` (e.g. `/compress`); add a `heartbeat` branch
  calling `heartbeat.commands.ts` + `use-heartbeat` (status replies rendered
  as a chat notice matching Python's `♥`/`⏸` lines).
- `web/src/hooks/use-gateway.ts` — reuse `dispatchCommand`/`command.dispatch`
  in Phase 1 (or thin `heartbeat.*` wrappers); `ensureSubscribed`/
  `getGatewayClient` for RPC; the existing `startPrompt` path in
  `web/src/stores/chat.ts` is the injector (keeps role alternation).
- `web/src/lib/session-activity.ts` — reuse `isRuntimeRunning()` (+ `hasRunningTool()`,
  `pendingApprovals`) as the idle gate base; `stores/chat.ts`
  `streamStatus`/`pendingApprovals`/`lastActivityAt` feed it, and
  `gwSessionIdAtom` + `session-map.ts` give the session key.
- `web/src/lib/gateway-reconnect.ts` — after `reattachAfterReconnect`
  re-pins a session, rehydrate/re-key heartbeat state for the (possibly new)
  gateway session id so an active heartbeat resumes after reconnect.
- `use-stall-watchdog.ts` / `use-composer-timer.ts` — interval-hook
  precedent; poller mirrors their `useEffect` cleanup discipline (StrictMode
  safe via module-singleton `ensureHeartbeatScheduler`).
- Rust side: no new Tauri commands required (localStorage suffices); if
  SQLite/JSON persistence is chosen, add one IPC pair in `src/commands/*`.

## 7. Removing the WebSocket dependency (migration path)

Today `/heartbeat` state flows through the backend gateway poller
(`gateway/run.py::_start_heartbeat_poller`) and SessionDB, and the desktop
only sees the fired prompt as an ordinary message. Migration phases:

**Phase A — freeze the API surface (keep backend firing).**
Expose the state behind a small, stable RPC surface so both sides can be
swapped independently:
- `heartbeat.get` (`session_id`) → `HeartbeatState | null`;
  `heartbeat.set` (`session_id`, `prompt`, `interval_seconds`) → state;
  `heartbeat.pause` / `heartbeat.resume` / `heartbeat.clear` (`session_id`);
  `heartbeat.status` (alias of get with `status_line` string).

Desktop slash command talks to these RPCs; backend `HeartbeatManager` + poller
still owns firing. State JSON schema is the frozen contract.

**Phase B — move the scheduler in-process.** Desktop starts
`HeartbeatScheduler` with `isIdle` from the chat runtime and `submit` = the
existing user-message submit RPC; fired prompts arrive as normal user turns.
Backend poller is disabled for desktop-served sessions (opt-in flag) while
storage stays in SessionDB via `heartbeat.*` RPCs; parity tests compare TS
`duePrompt` vs Python `due_prompt`.

**Phase C — delete the WS path.** State persists client-side
(`HeartbeatPersistBackend`); `/heartbeat` is fully renderer-side; remove the
backend poller + `heartbeat:<session_id>` handling from the desktop-facing
surface (keep CLI/gateway-platform code for the Python runtime). Delete the
`command.dispatch`/WS round-trip; the frozen RPC surface can be retired or
kept as a compat shim.

## 8. Migration phases & task breakdown

- **P0 (map):** read `hermes_cli/heartbeat.py`, `cli.py` watchdog, `gateway/run.py`
  poller, `tests/hermes_cli/test_heartbeat.py`; document behavior table.
- **P1 (RPC + UI):** add `heartbeat.get/set/pause/resume/clear` RPCs
  (backend wraps `HeartbeatManager`; `gateway/slash_commands.py` reuses);
  extend `builtin-commands.ts` + `goose-composer.tsx` with `/heartbeat`/`/hb`;
  add `web/src/stores/heartbeat.ts` atoms + status notice; wire
  `use-heartbeat.ts` to fetch/display via RPC.
- **P2 (in-process scheduler):** implement `web/src/lib/heartbeat/*` (types,
  interval, state, manager, scheduler, commands) with injected clock +
  persist backend; idle gate = `isRuntimeRunning` + queued-submit flag, guard
  StrictMode double-mount and reconnect double-fire; submit fired prompts via
  `startPrompt` with `lastFiredAt` recorded before await; parity vitest suite;
  reconnect/compression re-key via `gateway-reconnect.ts`/`session-map.ts`.
- **P3 (decommission):** switch persistence to `HeartbeatPersistBackend`
  (localStorage → Tauri IPC if needed), migrate live backend rows once;
  disable backend poller for desktop sessions, remove WS heartbeat methods,
  delete compat shim after a release window; E2E pass + docs update.

## 9. Risks & open questions

- **No TS equivalent found (kimi-code)** — the feature must be built from
  scratch; the only reusable evidence is the idle-gate + coalesce pattern in
  `agent/cron/manager.ts` / `tools/cron/scheduler.ts`. Risk: idle-detection
  semantics drift between Python and TS. Python's "idle" is defined by the
  driver (`_agent_running`, `_voice_*`, empty `_pending_input`; gateway
  `_running_agents`); TS must pin an equivalent contract:
  `!isRuntimeRunning(runtime) && pendingApprovals.length === 0 &&
  !hasRunningTool(runtime) && !queuedUserSubmit`. Voice state has no TS
  equivalent today (desktop has no CLI voice); acceptable, but document it.
- **Double-fire races:** reconnect, React StrictMode double-mount, and a
  slow submit all threaten the Python invariant "record fire before the turn
  runs". Must write `lastFiredAt` synchronously in `duePrompt()` before any
  `await`, and keep the scheduler a module singleton with a `started` flag
  (mirror `_heartbeat_watchdog_started` / `_start_heartbeat_poller`
  idempotency).
- **Session id rotation:** `session.resume` after reconnect can return a new
  gateway session id, and context compression rotates the session — the
  stored heartbeat key must be re-mapped or the heartbeat silently dies
  (Python handles this via `migrate_heartbeat_to_session`).
- **Multiple webview/tabs:** two renderers could each run a scheduler and
  double-fire. Decide single-owner semantics (module singleton per webview +
  server-side guard in Phase B, or a Tauri-IPC mutex) before Phase B ships.
- **Injection must remain a user-role message** — never a system message or
  tool injection, or prompt-cache/role-alternation invariants break.
- **Idle-tick cost:** mirror `tests/cron/test_idle_tick_config_skip.py` —
  an idle poll tick must do near-zero work (no config load, no store writes
  unless a fire occurs).
- Open questions: localStorage vs Rust SQLite for final persistence; whether
  to keep `heartbeat.*` RPCs as a compat surface after Phase C; exact status
  notice UX (`♥`/`⏸` vs a dedicated panel).

## 10. Test strategy

- **Vitest unit (parity with Python)** — port each case from
  `D:/hermes-agent-cn/tests/hermes_cli/test_heartbeat.py`:

  | Python test | TS test |
  |---|---|
  | `test_parse_interval_valid` | `parseInterval("10m"/"every 10m"/"2h"/…)` |
  | `test_parse_interval_not_an_interval` | `parseInterval("banana"/"check CI"/…) === null` |
  | `test_parse_interval_too_small_is_rejected` | `parseInterval("5s") === -1`, `"60s" === 60` |
  | `test_format_interval` | `formatInterval(600)==="10m"`, `90s`, `1d` |
  | `test_state_roundtrip` | serialize/deserialize parity |
  | `test_is_due_anchors_on_created_then_last_fired` | same anchor math (injected clock) |
  | `test_paused_never_due` | same |
  | `test_render_prompt_contains_instruction_and_interval` | template parity |
  | `test_manager_set_pause_resume_clear` | same lifecycle |
  | `test_manager_rejects_bad_input` | empty prompt / sub-min interval throws |
  | `test_manager_persists_across_instances` | persist backend round-trip |
  | `test_due_prompt_fires_once_and_reanchors` | fire → `fireCount===1`, immediately not due |
  | `test_missed_ticks_coalesce` | busy through 5 intervals → exactly ONE fire |
  | `test_resume_reanchors_instead_of_instant_fire` | same |
  | `test_migrate_heartbeat_to_session` | re-key copy-on-rotation |

- **Scheduler tests (fake timers):** tick with idle gate open fires; busy
  gate (streaming / running tool / pending approval / queued submit) holds
  the tick; state written before submit resolves; scheduler start idempotent.
- **React hook tests:** `renderHook` for `use-heartbeat` — state atom
  updates, cleanup on unmount, StrictMode double-mount single scheduler.
- **Playwright E2E:** set `/heartbeat every 60s …`; assert injected prompt
  appears while idle; assert no injection while streaming a long turn; after
  a busy gap assert exactly one injected turn (coalescing); `pause`/`resume`/
  `clear` end-to-end; session resume re-hydrates the heartbeat.
- **Idle-tick cheapness:** assert an idle poll tick performs no persistence
  writes / RPC calls (parity with `test_idle_tick_config_skip.py`).

## 11. Reference links

- Core: `hermes_cli/heartbeat.py`; `cli.py` (`_get_heartbeat_manager` ~10978,
  `_start_heartbeat_watchdog` ~11002); `hermes_cli/cli_commands_mixin.py`
  (`_handle_heartbeat_command` ~2523)
- Gateway: `gateway/run.py` (`_get_heartbeat_manager_for_event` ~20174,
  `_register_heartbeat_watch` ~20194, `_start_heartbeat_poller` ~20215);
  `gateway/slash_commands.py` (`_handle_heartbeat_command` ~2784)
- Compression: `agent/conversation_compression.py` (~3395,
  `migrate_heartbeat_to_session` call); `agent/session_activity.py` (unrelated
  liveness heartbeat — do not conflate)
- Docs: `website/docs/user-guide/features/heartbeat.md`;
  `website/docs/reference/slash-commands.md`
- Tests: `tests/hermes_cli/test_heartbeat.py` (parity source);
  `tests/cron/test_idle_tick_config_skip.py`
- kimi-code: `packages/agent-core/src/agent/cron/manager.ts`
  (`isIdle: () => !agent.turn.hasActiveTurn`); `tools/cron/scheduler.ts`
  (`isIdle()` gating + `coalescedCount`); `di/util/idleValue.ts` (unrelated)
- Desktop libs: `web/src/lib/builtin-commands.ts`; `session-activity.ts`
  (`isRuntimeRunning`, `hasRunningTool`); `gateway-reconnect.ts`; `session-map.ts`
- Desktop hooks/stores: `web/src/hooks/use-gateway.ts` (`command.dispatch`,
  reconnect/resume); `stores/chat.ts` (`gwSessionIdAtom`, `ChatSessionRuntime`,
  `startPromptAtom`); `hooks/use-composer-timer.ts` + `hooks/use-stall-watchdog.ts`
- Protocol: `packages/protocol/src/hermes-api.ts` (`CommandDispatchResult` ~1327)
