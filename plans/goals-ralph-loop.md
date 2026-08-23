# Goals (Ralph Loop) — Python → TypeScript Rewrite Plan

## 1. Summary

`/goal` gives a session a standing objective that survives across turns ("Ralph loop",
adapted from OpenAI Codex CLI's `/goal`). After every turn a small **judge model** decides
`done / continue / wait`; on `continue` Hermes feeds a continuation prompt back into the
*same* session and keeps working until the goal is done, the user pauses/clears it, or the
turn budget (`goals.max_turns`, default 20) is exhausted. The feature also includes:
structured **completion contracts** (`/goal draft` + inline `verify:` lines), mid-loop
**subgoals** (`/subgoal`), deterministic **quality gates** (`/goal gate add`, shell commands
that must pass before the judge may declare done), and **background-process parking**
(`/goal wait`, plus the judge auto-returning `wait` on live processes so the loop quiesces
instead of re-poking). State persists in `SessionDB.state_meta` keyed `goal:<session_id>`
so `/resume` restores it; context compression migrates it to the rotated session id.

This plan moves the whole engine into the TypeScript web app (in-process), keeping the
same JSON-RPC surface the Dashboard gateway exposes today (`slash.exec` / `command.dispatch`
/ `status.update {kind:"goal"}`), so the UI is identical before and after the Python backend
is removed.

## 2. Current Python implementation

Source of truth: `D:/hermes-agent-cn`.

- **`hermes_cli/goals.py`** — the entire engine (~2,140 lines):
  - Prompt templates: `CONTINUATION_PROMPT_*` (plain / with contract / with subgoals /
    gate-failed), `JUDGE_SYSTEM_PROMPT`, `JUDGE_USER_PROMPT_*`, `JUDGE_BACKGROUND_BLOCK_TEMPLATE`,
    `DRAFT_CONTRACT_SYSTEM_PROMPT`.
  - `GoalContract` (5 fields: `outcome/verification/constraints/boundaries/stop_when`),
    `parse_contract()` (inline `field: value` aliases, e.g. `verify:`, `stop when:`),
    `draft_contract()` (aux model expands plain text; falls back to free-form goal on failure).
  - `GoalGate` / `run_gate()` / `workspace_fingerprint()` — gates run through the shell with
    a 300 s timeout and 3 retries; unchanged-workspace failures are replayed, not re-run
    (fingerprint = `git rev-parse HEAD` + `git status --porcelain`, sha256; empty outside git).
  - `GoalState` dataclass (JSON-serialized): `goal, status(active|paused|done|cleared),
    turns_used, max_turns, created_at, last_turn_at, last_verdict, last_reason,
    paused_reason, consecutive_parse_failures, consecutive_transport_failures, subgoals[],
    waiting_on_pid, waiting_on_session, waiting_until, waiting_reason, waiting_since,
    contract, gates[]`.
  - Persistence: `load_goal/save_goal/clear_goal` on `SessionDB.state_meta` under key
    `goal:<session_id>` (cached `SessionDB` per `HERMES_HOME`); `migrate_goal_to_session()`
    copies an active goal to the rotated session after compression and archives the old row.
  - `judge_goal()` → `(verdict, reason, parse_failed, wait_directive, transport_failed)`;
    calls `agent.auxiliary_client.call_llm(task="goal_judge", temperature=0,
    max_tokens=auxiliary.goal_judge.max_tokens|4096, timeout=30)`. Verdict JSON:
    `{"verdict":"done|continue|wait", ...}` plus legacy `{"done":bool}`. Fail-open:
    transport/parse errors become `continue`, auto-pause after 3 consecutive parse failures
    or 5 transport failures. `_render_background_block()` feeds live
    `process_registry.list_sessions()` entries (pid/session/uptime/watch_patterns/
    notify_on_complete/output preview) to the judge.
  - `GoalManager` — per-session facade both CLI and gateway wire in:
    `set/set_contract/pause/resume/clear/mark_done`, `add_subgoal/remove_subgoal/
    clear_subgoals/render_subgoals`, `add_gate/remove_gate/clear_gates/render_gates`,
    `wait_on/wait_on_session/wait_for_seconds/stop_waiting/is_waiting`,
    `evaluate_after_turn(last_response, user_initiated, background_processes)` → decision
    dict `{status, should_continue, continuation_prompt, verdict, reason, message}`,
    `next_continuation_prompt()`, `status_line()`. Wait barrier lazy auto-clears when the
    pid exits / session trigger fires / deadline passes.
  - `run_kanban_goal_loop()` — same engine borrowed by Kanban goal-mode cards (out of scope
    for the desktop rewrite but the engine is shared).
- **`cli.py`** (repo root): slash dispatch routes `/goal`/`/subgoal`; status-bar snapshot
  adds `goal_active / goal_turns_used / goal_max_turns`; `_get_goal_manager()` (~line 10945);
  `_maybe_continue_goal_after_turn()` (~line 11120) runs after each CLI turn, auto-pauses on
  Ctrl+C interrupt, skips judge on empty responses.
- **`hermes_cli/cli_commands_mixin.py`** (~line 2648): `_handle_goal_command()` parses
  `set/draft/show/status/pause/resume/clear/wait/unwait/gate <add|list|remove|clear>` and
  queues the goal text as the kickoff prompt (`_pending_input`); `_handle_goal_draft()`;
  `_handle_subgoal_command()`.
- **`gateway/run.py`** (~line 20331): `_post_turn_goal_continuation()` — after each gateway
  turn, offloads `evaluate_after_turn()` to an executor (avoids blocking Discord heartbeats),
  sends the verdict message through the adapter, enqueues the continuation prompt into the
  same FIFO so a real user message preempts it. `_goal_max_turns_from_config()` reads
  `goals.max_turns` (default 20).
- **`tui_gateway/server.py`** (this is the surface the desktop talks to):
  - Slash handling: `slash.exec {command}` routes `/goal…` internally to `command.dispatch`
    (test `test_slash_exec_routes_goal_to_command_dispatch`); `command.dispatch {name:"goal",
    arg, session_id}` returns `{type:"exec"|"send", output|notice|message}`; `/goal` is in
    `_PENDING_INPUT_COMMANDS` so the kickoff prompt queues correctly.
  - Post-turn hook (~line 10543): on a successful goal turn, runs `GoalManager.evaluate_after_turn`
    and emits `status.update {kind:"goal", text: verdict_msg}`; when `should_continue`,
    feeds `next_continuation_prompt()` as the follow-up prompt.
  - Compression recovery `_plan_goal_compression_recovery()` (~line 9908): one bounded retry
    after compression exhaustion, then pauses the goal (tests lock this in).
- **`agent/iteration_budget.py`** — per-agent thread-safe `IterationBudget` counter
  (`consume/refund/used/remaining`, max_iterations default 500, subagent 50). This is the
  agent-loop iteration budget; the goal loop has its own `max_turns` counter in `GoalState`.

Docs: `website/docs/user-guide/features/goals.md` (commands table, contracts, subgoals,
gates, parking, judge behavior).

## 3. Target TypeScript design

End-state: the React web app hosts the goal engine in-process — no Python, no WS. The
engine is split into pure TS modules under `web/src/lib/goals/` plus a Jotai store and
protocol schemas, mirroring how `web/src/stores/subagents.ts` already ports a Core desktop
feature.

Module layout:

```
packages/protocol/src/goals.ts          # Zod schemas: GoalStatus, GoalContract, GoalGate,
                                        #   GoalState, GoalDecision, GoalEvent, GoalSnapshot
web/src/lib/goals/goal-contract.ts      # GoalContract + parseContract + renderBlock + draftContract
web/src/lib/goals/goal-judge.ts         # judgeGoal(): prompt builders + strict JSON parser +
                                        #   auxiliary-LLM client wrapper (fail-open)
web/src/lib/goals/goal-gates.ts         # GoalGate + runGate(cmd,{timeout,retries,cwd}) +
                                        #   workspaceFingerprint()
web/src/lib/goals/goal-wait.ts          # wait barrier (pid/session/seconds) + liveness checks
web/src/lib/goals/goal-manager.ts       # GoalManager (port of hermes_cli/goals.GoalManager)
web/src/lib/goals/persistence.ts        # load/save/clear/migrate via storage adapter
web/src/stores/goals.ts                 # Jotai atoms + routeGoalGatewayEventAtom
web/src/components/…/goal-indicator.tsx # composer status-stack indicator + panel badge
```

Core interfaces (signatures only):

```ts
type GoalStatus = "active" | "paused" | "done" | "cleared"; // "waiting" is a UI rendering of active+barrier
interface GoalContract { outcome?; verification?; constraints?; boundaries?; stop_when?; }
interface GoalGate { command; timeoutSeconds; maxRetries; attempts; lastExitCode?; lastOutputTail; lastFailedFingerprint; }
interface GoalState { goal; status; turnsUsed; maxTurns; createdAt; lastTurnAt; lastVerdict?; lastReason?;
  pausedReason?; consecutiveParseFailures; consecutiveTransportFailures; subgoals: string[];
  waitingOnPid?; waitingOnSession?; waitingUntil; waitingReason?; waitingSince; contract: GoalContract; gates: GoalGate[]; }
interface GoalDecision { status: GoalStatus; shouldContinue: boolean; continuationPrompt: string | null;
  verdict: "done"|"continue"|"wait"|"skipped"|"inactive"|"waiting"|"gate_failed"; reason: string; message: string; }

class GoalManager {
  constructor(sessionId: string, opts?: { defaultMaxTurns?: number; storage?: GoalStorage; judge?: GoalJudge; runGate?: GateRunner; registry?: ProcessRegistry });
  // mutations: set, setContract, pause, resume, clear, markDone
  // subgoals: addSubgoal, removeSubgoal, clearSubgoals, renderSubgoals
  // gates: addGate, removeGate, clearGates, renderGates, checkGates
  // wait: waitOnPid, waitOnSession, waitForSeconds, stopWaiting, isWaiting
  // loop: evaluateAfterTurn(lastResponse, opts) => GoalDecision; nextContinuationPrompt() => string | null;
  // view: statusLine(), renderContract(), toSnapshot()
}
```

Data flow (in-process, post-migration): user types `/goal …` → composer sends
`prompt.submit` → the in-process agent loop runs a normal turn → on turn end the
`GoalManager.evaluateAfterTurn()` hook fires: (1) skip if not active or parked (`isWaiting`);
(2) count the turn; (3) run quality gates — a red gate short-circuits the judge and its
output becomes the continuation prompt; (4) call `judgeGoal()` with contract/subgoals/
background-process snapshot; (5) `done` → emit `goal.updated` completion + clear-ish status;
`wait` → set barrier and park; `continue` → queue `nextContinuationPrompt()` as the next
user message in the same session. A real user message preempts the queued continuation
(kept as a FIFO like Python's `_pending_input`).

The judge and draft-contract calls go through a small `AuxLlmClient` interface
(`callLlm(task:"goal_judge", messages, {temperature:0, maxTokens, timeout})`) so tests can
stub it and production can swap providers without touching the loop.

## 4. Data models & persistence

Python persists `GoalState.to_json()` in `SessionDB.state_meta` (`goal:<session_id>`).
TS mirrors the exact JSON shape (orjson-compatible field names) so a migrated session can
still be read by the old backend during the transition.

Final persistence options:
- **Recommended: SQLite owned by Rust.** Add a `goal_state(session_id TEXT PRIMARY KEY,
  state_json TEXT NOT NULL, updated_at INTEGER)` table in the existing Rust state layer
  (`src/state.rs` / new `src/commands/goals.rs` Tauri commands `goal_load` / `goal_save` /
  `goal_clear` / `goal_migrate`). Web code never touches disk directly — it calls the
  `GoalStorage` interface implemented over Tauri IPC (same pattern as `tauri-bridge.ts` /
  `transport.ts`).
- Fallback for the transition: keep the Python `SessionDB` via `slash.exec`-style REST/WS
  (Phase 1/2), and swap the `GoalStorage` implementation when the WS link is removed.

Key data rules to port:
- One active goal row per logical conversation; `migrate_goal_to_session()` on session
  rotation (context compression) — copy to new `session_id`, archive old row as `cleared`;
  never clobber a goal already set on the child.
- `status="cleared"` is an audit tombstone; `clear()` keeps the row, `GoalManager.state`
  returns null after clear.
- `resume()` resets `turns_used` to 0 and drops any wait barrier; `pause()` drops the
  barrier too.
- Barrier fields are lazily auto-cleared by `isWaiting()` (dead pid / fired session trigger /
  passed deadline must never wedge the loop).
- `goal.updated` events: `{snapshot: GoalSnapshot, change: {kind:"lifecycle"|"completion",
  status?, reason?, actor?, stats?}}` (kimi-code `GoalChange` shape) for UI rendering.

Schema migration: none needed if the TS JSON matches the Python `GoalState` dict exactly;
add `schema_version` field for future extension.

## 5. Third-party library strategy

| Python dependency | TS equivalent | Evidence / plan |
|---|---|---|
| `orjson` (state JSON) | native `JSON.stringify/parse` | no dep needed; kimi uses `JSON` throughout |
| `agent.auxiliary_client.call_llm` (judge + draft) | **from scratch** `web/src/lib/goals/goal-judge.ts` `AuxLlmClient` (provider-agnostic `callLlm`); no kimi judge exists | kimi-code goals are **model-driven** (`UpdateGoal` tool), there is no judge model — see `src/tools/builtin/goal/update-goal.ts` |
| `prompt_toolkit` / ANSI status lines | CSS/React components; keep the same emoji prefixes (`⊙`, `↻`, `⏳`, `⏸`, `✓`) for parity | Core desktop `apps/desktop/src/store/goals.ts` already parses these exact strings |
| `subprocess` gate runner (`shell=True`, timeout, output tail) | **from scratch** `goal-gates.ts` over `child_process.execFile`/`spawn` with `shell:true` + timeout kill + `stdout+stderr` tail (3 KB); Windows shell caveat | no kimi goal-gate equivalent; kimi does have process/terminal infra (`apps/kimi-code/src/native`, `services/terminal`) to reuse for spawning |
| `git` fingerprint (`rev-parse HEAD` + `status --porcelain`, sha256) | `workspaceFingerprint()` using `execFile("git", …)` + `crypto` sha256 | kimi has git utils: `apps/kimi-code/src/utils/git/*` — reuse the same git invocation pattern |
| `tools/process_registry` (background sessions, `watch_patterns`, `notify_on_complete`) | **from scratch** `goal-wait.ts` + a TS `ProcessRegistry` mirroring `list_sessions()`; pid liveness must avoid Windows `kill(pid,0)` semantics (use `tasklist`/`process.kill(pid,0)`-safe check or a Rust command) | no kimi equivalent (kimi has no goal parking) |
| `SessionDB.state_meta` | **from scratch** `persistence.ts` over Rust SQLite Tauri commands (or IndexedDB fallback) | kimi persists goals in its agent record log + `state.json` via `packages/minidb` — Desktop has no equivalent package yet |
| `threading.Lock` `IterationBudget` | in-process JS is single-threaded; a simple counter class suffices; kimi's `GoalBudgetReport` (token/turn/wall-clock) is the richer target | kimi `src/agent/goal/index.ts` `computeBudgetReport()` + `src/agent/turn/index.ts` `driveGoal()` budget checks |
| `re` (JSON extraction, `\{.*?\}` first-object fallback) | `goal-judge.ts` regex + `JSON.parse` fallback, port `_parse_judge_response` exactly | from scratch; keep the legacy `{"done":bool}` acceptance |

kimi-code equivalents that DO exist and should be mirrored for the state machine:
- `packages/agent-core/src/agent/goal/index.ts` — `GoalMode` class: lifecycle statuses
  (`active/paused/blocked/complete`), durable record log (`goal.create/update/clear`),
  `goal.updated` events with `GoalChange`, budget report, `normalizeAfterReplay()`
  (active goal demoted to paused on resume). Python's statuses differ slightly
  (`done` persists; `blocked` doesn't exist) — the TS design keeps Python semantics for
  backward parity but borrows kimi's event/snapshot model.
- `packages/agent-core/src/agent/injection/goal.ts` — `GoalInjector` injects the active
  goal as `<untrusted_objective>` + budget guidance once per turn; Python achieves the same
  via continuation prompts, so this is the kimi reference for "goal visible to the model
  without mutating the system prompt" (Python's stated invariant).
- `packages/agent-core/src/agent/turn/index.ts` — `driveGoal()`: loop that counts the turn,
  runs a normal turn, reads goal status at the boundary, stops on complete/blocked, pauses
  on interrupt/failure; per-turn-step-limit exemption. This is the kimi equivalent of
  `_maybe_continue_goal_after_turn` + gateway `_post_turn_goal_continuation`.
- `packages/agent-core/src/tools/builtin/goal/{create-goal,update-goal,get-goal}.ts` —
  model-facing tools with zod schemas; `serialize.ts` shapes `goalForModel()`. Not needed
  for the desktop UI path, but the zod-schema style is the precedent for
  `packages/protocol/src/goals.ts`.
- `packages/agent-core/src/agent/plan/index.ts` — `PlanMode` is a *plan-file* feature,
  unrelated to the goal loop; no reuse.

## 6. Integration with existing Hermes-CN-Desktop frontend

- **RPC surface (today)**: `web/src/lib/gateway-client.ts` exposes generic
  `request(method, params)`; goal commands already work through `slash.exec {command:
  "goal …", session_id}` (routes to `command.dispatch`) and `prompt.submit` for the
  `/goal …` kickoff. `packages/protocol/src/hermes-api.ts` has **no** typed goal event in
  `GatewayKnownEvent` — goal notices arrive as `status.update {kind:"goal", text}` and fall
  through `RawGatewayEvent` (passthrough). Plan: add `GoalEvent` schemas
  (`status.update.kind="goal"`, and a new structured `goal.updated`) to
  `packages/protocol/src/goals.ts` and extend the `GatewayKnownEvent` union.
- **Event funnel**: `web/src/hooks/use-gateway.ts` `applyGatewayEventAtom` → `web/src/stores/chat.ts`
  `reduceGatewayEvent()` is the single funnel; add a `routeGoalGatewayEventAtom` that
  `chat.ts` calls, following `stores/subagents.ts` (`routeSubagentGatewayEventAtom`,
  pure-function reducer + Jotai atoms + `SUBAGENT_EVENT_TYPES` set). Port the Core desktop
  `apps/desktop/src/store/goals.ts` (nanostores) parser into this Jotai store — it already
  handles `⊙ Goal set`, `⏳ Goal parked`, `⏸ Goal paused`, `↻ Continuing toward goal`,
  `✓ Goal achieved`, and hydrates via `slash.exec('goal status')`.
- **UI**: `web/src/routes/panel.tsx` (`TaskCard`, active-task grid) and the chat route
  (`web/src/routes/detail.tsx`) — add a goal indicator in the composer status stack
  (port `apps/desktop/src/app/chat/composer/status-stack/goal-indicator.tsx` +
  `goal-indicator.test.tsx` behavior: scoped to session, shows title/status/detail,
  auto-clears 8 s after `done`). Reuse `packages/shared-ui` tokens; no hard-coded colors.
- **Config**: `web/src/lib/config-translations.ts` already maps `goals.max_turns` →
  "目标模式最大轮数" — surface it in the settings UI (goal/judge auxiliary config) once the
  engine is in-process.
- **Rust**: no new Rust needed in Phase 1; Phase 3 adds `src/commands/goals.rs`
  (SQLite storage commands) — reuse `src/state.rs` AppState pattern.

## 7. Removing the WebSocket dependency (migration path)

API surface to freeze during migration (identical before/after):
- Commands: `slash.exec {command:"goal|subgoal …"}` and `command.dispatch {name:"goal|subgoal",
  arg, session_id}`; `prompt.submit` for kickoff/continuation messages.
- Events: `status.update {kind:"goal", text}`; new structured `goal.updated {snapshot,
  change}`; `message.complete` drives post-turn evaluation.

Phases:
1. **Phase 1 (keep backend)**: ship `web/src/lib/goals/*` engine as the *parsing/rendering*
   layer only — Jotai goals store + goal indicator driven by `status.update` text and
   `slash.exec` hydration. No behavior change; proves UI parity against the live Python
   gateway.
2. **Phase 2 (in-process behind same interface)**: move the real `GoalManager`/judge/gates/
   wait engine into `web/src/lib/goals/`; the agent loop calls `evaluateAfterTurn()` locally
   after each turn instead of waiting for Python's post-turn hook. Persistence switches from
   `slash.exec`-round-trips to the `GoalStorage` interface backed by Rust SQLite Tauri
   commands. `gateway-client.ts` still exists for sessions/messages, but goal state no
   longer round-trips.
3. **Phase 3 (delete WS/REST goal path)**: remove Python goal handling from the desktop's
   managed runtime usage; delete the `status.update` goal parser fallback and the
   `slash.exec` goal hydration; protocol keeps `goal.updated` as the only goal event.

## 8. Migration phases & task breakdown

1. **Protocol + schemas**: add `packages/protocol/src/goals.ts` (`GoalState/GoalDecision/
   GoalContract/GoalGate/GoalEvent` Zod) + extend `GatewayKnownEvent`; update
   `hermes-api.test.ts`.
2. **UI read path (parity)**: port Core `apps/desktop/src/store/goals.ts` parser to
   `web/src/stores/goals.ts`; wire `routeGoalGatewayEventAtom` into `chat.ts`; add
   `goal-indicator.tsx` to composer status stack; hydrate via `slash.exec('goal status')`.
   Vitest for the parser (all `⊙/⏳/⏸/↻/✓` lines) — mirrors `store/goals.test.ts`.
3. **Engine core**: `goal-contract.ts` (parse_contract aliases + render + draft via
   `AuxLlmClient`), `goal-judge.ts` (prompt builders, `_parse_judge_response` port,
   fail-open counters), `goal-manager.ts` (`set/pause/resume/clear`, subgoals,
   `evaluateAfterTurn`, `nextContinuationPrompt`, `statusLine`).
4. **Gates**: `goal-gates.ts` (`runGate` with timeout+tail, `workspaceFingerprint`,
   unchanged-workspace replay, retry exhaustion → pause) — parity with
   `tests/hermes_cli/test_goal_gates.py`.
5. **Wait/parking**: `goal-wait.ts` (`waitOnPid/waitOnSession/waitForSeconds/stopWaiting/
   isWaiting` lazy auto-clear) + `ProcessRegistry` snapshot; judge `wait` verdict wiring.
6. **Persistence**: `persistence.ts` (GoalStorage interface); Phase 1 impl = no-op passthrough;
   Phase 3 impl = Rust SQLite commands `goal_load/save/clear/migrate` + `src/commands/goals.rs`.
7. **Loop integration**: hook `evaluateAfterTurn` at turn boundary (mirror kimi
   `driveGoal()` + Python `_maybe_continue_goal_after_turn`); interrupt auto-pause;
   compression-recovery single retry; continuation FIFO preemption by real user messages.
8. **Cleanup**: remove Python goal path from desktop runtime usage; delete WS goal parser;
   docs (`docs/` + settings UI for `goals.max_turns` / `auxiliary.goal_judge`).

## 9. Risks & open questions

- **Judge-loop fidelity**: the judge is the highest-risk piece — prompt templates, JSON
  parse fallbacks (fence stripping, first-object regex), and the 3-parse/5-transport
  auto-pause counters must be byte-for-byte ported or loops will burn budget or wedge.
  No kimi equivalent to copy.
- **Windows shell differences**: Python gates run `shell=True` via cmd; TS must pick the
  right shell (`cmd.exe /c` vs `bash -c`), handle codepage/UTF-8 replace decoding, and avoid
  console-flash. Pid liveness must not use POSIX `kill(pid,0)` semantics.
- **Persistence cut-over**: SessionDB `state_meta` JSON must load in TS unchanged during
  Phase 2, and `migrate_goal_to_session` must be reimplemented exactly (copy + archive, no
  clobber) or active goals silently die at compression — the exact bug #33618 fixed in Python.
- **Structured `goal.updated` event is new**: Python only emits `status.update {kind:"goal",
  text}`; adding a structured event requires backend changes (or a shim in the TS engine
  that synthesizes snapshots from parsed text) — decide whether to extend
  `tui_gateway/server.py` in Phase 1 or keep text-only until Phase 3.
- **Auxiliary LLM client**: the Desktop currently has no in-process LLM client; the
  `AuxLlmClient` interface and provider/config resolution (`auxiliary.goal_judge`) need a
  home (kimi's `services/modelCatalog` is the reference) — open question whether the desktop
  can reuse the managed runtime's OpenAI-compatible endpoint during Phase 2.

## 10. Test strategy

Vitest unit tests (parity vs Python):
- **Lifecycle**: `GoalManager` set/status/pause/resume/clear + persistence round-trip —
  mirrors `tests/hermes_cli/test_goals.py` (`TestGoalManager`, subgoals, wait barriers).
- **Gates**: `runGate` pass/fail/timeout, fingerprint unchanged-replay, retry exhaustion →
  paused — mirrors `tests/hermes_cli/test_goal_gates.py`.
- **Judge parser**: verdict shapes (new + legacy), fence stripping, empty/prose/non-JSON
  fail-open, wait directives (session/pid/seconds, no-target downgrade), parse/transport
  counters — mirrors `judge_goal` unit coverage in `test_goals.py`.
- **Interrupt**: Ctrl+C auto-pause + resume — mirrors `tests/cli/test_cli_goal_interrupt.py`.
- **Wait barrier**: dead pid / fired session / passed deadline lazy auto-clear — mirrors
  `test_goals.py` wait cases and `test_goal_status_notice.py`.
- **Store parser**: `routeGoalGatewayEventAtom` on all `status.update` goal lines + `goal.updated`
  structured events + done-linger clear — mirrors `apps/desktop/src/store/goals.test.ts`
  and `goal-indicator.test.tsx`.
- **Protocol**: `packages/protocol` Zod schema round-trips (`hermes-api.test.ts` style).

Integration tests (Vitest + real backend in CI):
- Post-turn continuation drains and real-user preemption — mirrors
  `tests/gateway/test_goal_continuation_drain.py`, `test_goal_verdict_send.py`,
  `test_goal_max_turns_config.py`.
- `slash.exec`/`command.dispatch` routing for `/goal`, `/subgoal`, `/goal gate`,
  `/goal wait` — mirrors `tests/tui_gateway/test_goal_command.py`.

Playwright E2E (against a fake model like the existing `e2e/` suite): set `/goal`, observe
`⊙ Goal set`, judge-continue produces `↻ Continuing toward goal`, gate failure feeds the
gate output, `⏳ parked` on `wait`, `✓ Goal achieved` clears the indicator, `/resume`
persists after session reattach.

## 11. Reference links

- `D:/hermes-agent-cn/hermes_cli/goals.py` (engine)
- `D:/hermes-agent-cn/hermes_cli/cli_commands_mixin.py` (`_handle_goal_command`, `_handle_subgoal_command`)
- `D:/hermes-agent-cn/cli.py` (`_get_goal_manager`, `_maybe_continue_goal_after_turn`, status-bar snapshot)
- `D:/hermes-agent-cn/gateway/run.py` (`_post_turn_goal_continuation`)
- `D:/hermes-agent-cn/tui_gateway/server.py` (post-turn hook, `status.update {kind:"goal"}`, slash routing, compression recovery)
- `D:/hermes-agent-cn/agent/iteration_budget.py`
- `D:/hermes-agent-cn/website/docs/user-guide/features/goals.md`
- Tests: `tests/cli/test_cli_goal_interrupt.py`, `tests/hermes_cli/test_goals.py`,
  `tests/hermes_cli/test_goal_gates.py`, `tests/gateway/test_goal_verdict_send.py`,
  `tests/gateway/test_goal_status_notice.py`, `tests/gateway/test_goal_continuation_drain.py`,
  `tests/gateway/test_goal_max_turns_config.py`, `tests/tui_gateway/test_goal_command.py`
- kimi-code: `packages/agent-core/src/agent/goal/index.ts`, `src/agent/injection/goal.ts`,
  `src/agent/turn/index.ts` (`driveGoal`), `src/agent/turn/tool-result-budget.ts`,
  `src/tools/builtin/goal/{create-goal,update-goal,get-goal,serialize}.ts`, `src/agent/plan/index.ts`
- Desktop: `web/src/hooks/use-gateway.ts`, `web/src/stores/chat.ts`, `web/src/stores/subagents.ts`,
  `web/src/lib/gateway-client.ts`, `web/src/routes/panel.tsx`, `web/src/lib/config-translations.ts`,
  `packages/protocol/src/hermes-api.ts`
- Core desktop UI reference: `apps/desktop/src/store/goals.ts`,
  `apps/desktop/src/app/chat/composer/status-stack/goal-indicator.test.tsx`
