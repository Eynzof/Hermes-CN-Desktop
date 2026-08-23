# Self-Improvement Loop — Python → TypeScript Rewrite Plan

> Feature: background memory/skill review (memory ~every 10 prompts, skill review
> ~every 10 tool iterations), `/refine`, `/learn`, skill write-approval gate; design-only.

## 1. Summary

The Python runtime learns from every session in two ways: (1) a **background
review fork** (`AIAgent` clone in a daemon thread) that replays the finished
conversation snapshot and decides what to write to the persistent memory store
(`MEMORY.md`/`USER.md`) and the skill library — triggered by turn count (default
10, `memory.nudge_interval`) for memory and tool-iteration count (default 10,
`skills.creation_nudge_interval`) for skills; (2) two user-facing slash commands
— `/refine [focus]` (run the review now with optional steering) and `/learn`
(build a standards-guided prompt that turns anything the user describes into a
`SKILL.md` via the agent's own tools). All agent skill/memory writes pass an
optional **write-approval gate** (`skills.write_approval` / `memory.write_approval`)
that stages writes to `~/.hermes/pending/{memory,skills}/<id>.json` for
out-of-band approve/reject.

This plan ports the whole loop into the TypeScript in-process runtime:
- a `SelfImprovementService` with nudge counters, an event-bus trigger, and a
  background review task (kimi-code `BackgroundManager` pattern) that runs a
  **restricted-toolset child agent** (memory + skill tools only) against a
  conversation snapshot;
- TS ports of the three review prompts, the provenance `ContextVar` (→ Node
  `AsyncLocalStorage`), the `.usage.json` skill telemetry sidecar, the pending
  write store, the gate decision matrix, and `build_learn_prompt`;
- Desktop UI: `/refine` + `/learn` in the composer slash palette, a "pending
  skill writes" review surface in `routes/skills.tsx`, and a review-completion
  toast fed by a new `self-improvement.review.completed` gateway event.

**No TS equivalent exists in kimi-code for the core learning machinery** — it
has no persistent memory store, no skill authoring, no background review fork,
no `/refine`/`/learn`. kimi-code does provide the reusable substrate: background
task lifecycle, event bus, approval broker, and SkillManager activation; the
learning logic itself is implemented from scratch in TS, using those patterns as
scaffolding.

## 2. Current Python implementation

Source files under `D:/hermes-agent-cn`:

- **`agent/background_review.py`** (1144 lines) — the core review fork:
  - Prompt constants: `_MEMORY_REVIEW_PROMPT`, `_SKILL_REVIEW_PROMPT`,
    `_COMBINED_REVIEW_PROMPT` (plus `focus` appended when `/refine [focus]`).
  - `_resolve_review_runtime(agent)` — aux-model selector: default inherits the
    parent's live runtime (`routed=False`, full replay reuses the warm provider
    prefix cache); with `auxiliary.background_review.{provider,model}` set to a
    *different* model (`routed=True`) it replays a compact digest
    (`_digest_history`, tail=24) to minimise cold-cache tokens.
  - `summarize_background_review_actions(...)` — walks fork tool messages →
    `💾 Self-improvement review: …` summary (`off|on|verbose`), skipping stale
    inherited results.
  - `_run_review_in_thread(agent, messages_snapshot, prompt)` — daemon thread
    constructs a forked `AIAgent` with: inherited runtime + cached system prompt
    (same-model only), `max_iterations=16`, `quiet_mode=True`,
    `_memory_write_origin="background_review"`, `_persist_disabled=True`,
    `_session_db=None`, `compression_enabled=False`, `_end_session_on_close=False`,
    `skip_memory=True`, thread tool whitelist restricted to `memory` + `skills`
    toolsets, auto-deny approval callback, `thread_scoped_silence`, registration
    in `agent._active_children` + `_background_review_agent` for next-turn cancel.
  - `spawn_background_review_thread(agent, messages_snapshot, review_memory,
    review_skills, focus)` — returns `(target, prompt)`; called by
    `AIAgent._spawn_background_review` in `run_agent.py` (thread construction).
- **Triggers (scheduling):**
  - Memory: turn-based. `agent/agent_init.py` sets `_memory_nudge_interval = 10`
    (config `memory.nudge_interval`), `_turns_since_memory`, `_iters_since_skill`;
    `agent/turn_context.py` increments `_turns_since_memory` and sets
    `should_review_memory` when `>=` interval (counter hydrated from history as
    `prior_user_turns % interval`).
  - Skill: tool-iteration-based. `agent/conversation_loop.py` increments
    `_iters_since_skill` per tool iteration; `agent/tool_executor.py` resets it
    on any `skill_manage` call; `agent/turn_finalizer.py` checks the trigger
    after the turn and spawns the review *after* the response is delivered
    (suppressed for cron/`skip_background_review`, interrupts, missing final
    response). `agent/codex_runtime.py` has a parallel codex app-server path
    (increments by `turn.tool_iterations`).
- **`agent/learn_prompt.py`** — `build_learn_prompt(user_request)` returns one
  prompt combining house authoring standards (`_AUTHORING_STANDARDS`, ≤60-char
  description, section order, Hermes-tool framing), knowledge-base layout
  (`_KNOWLEDGE_SKILL_STANDARDS`), and untrusted-source hygiene
  (`_SOURCE_HYGIENE`). `/learn` injects it as a normal user turn (CLI
  `cli_commands_mixin.py::_handle_learn_command` + gateway).
- **`tools/skill_usage.py`** — per-skill telemetry sidecar
  `~/.hermes/skills/.usage.json` (use/view/patch counts, timestamps), lifecycle
  states (`active/stale/archived/pinned`), atomic writes + cross-process lock
  (fcntl/msvcrt), provenance filters (`mark_agent_created`, bundled/hub/external
  exclusion, `PROTECTED_BUILTIN_SKILLS = {"plan"}`).
- **`tools/skill_provenance.py`** — `contextvars.ContextVar("skill_write_origin")`
  default `"foreground"`; `set_current_write_origin/reset/get`,
  `is_background_review()`; set to `"background_review"` by the review fork so
  `skill_manage` marks agent-created skills.
- **`tools/write_approval.py`** — the gate: `write_approval_enabled(subsystem)`
  reads `<subsystem>.write_approval` (default false); `evaluate_gate` matrix —
  gate off → `allow`; gate on + skills (any origin) → `stage`; gate on + memory
  + background/gateway → `stage`; gate on + memory + interactive CLI → inline
  prompt (`allow`/`blocked`/fallback `stage`); `stage_write` / `list_pending` /
  `get_pending` / `discard_pending` / `pending_count` under
  `~/.hermes/pending/{memory,skills}/<id>.json`.
- **`tools/skill_manager_tool.py`** — `_apply_skill_write_gate(action, name,
  **payload)` returns a staged JSON result instead of writing when the gate
  fires (create/edit/patch/delete/write_file/remove_file);
  `apply_skill_pending(payload)` replays an approved staged write bypassing the
  gate; `mark_background_review_skill_read` requires the review fork to have
  actually read a skill file before patching it.
- **Slash surfaces:** `/refine` (CLI `cli_commands_mixin.py` + gateway
  `slash_commands.py`); `/skills pending|diff|approve|reject|approval` and
  `/memory pending|approve|reject|approval`
  (`hermes_cli/write_approval_commands.py`). Dashboard REST
  (`hermes_cli/web_routers/skills.py`) exposes only `GET/POST /api/skills`,
  `PUT /api/skills/toggle`, `GET/PUT /api/skills/content` + hub endpoints —
  **no pending/approve/reject REST surface today**.
- **Docs:** `website/docs/user-guide/features/skills.md` (`/learn`,
  `Gating agent skill writes (skills.write_approval)`, `Skill Config Settings`);
  `website/docs/reference/slash-commands.md` (`/refine`, `/learn`, `/skills`,
  `/memory` rows).
- **Tests:** `tests/tools/test_skill_{usage,provenance,manager_tool,
  bundle_provenance,linter,size_limits,env_passthrough,improvements,
  view_dedup,view_path_check,view_traversal}.py`;
  `tests/agent/test_refine_focus.py`; `tests/run_agent/test_background_review*.py`
  (incl. toolset_restriction, cache_parity); `tests/agent/test_skip_background_review.py`;
  `tests/run_agent/test_memory_nudge_counter_hydration.py`;
  `tests/run_agent/test_codex_app_server_integration.py`;
  `tests/cli/test_cli_preloaded_skills.py`. ⚠️ Spec path
  `tests/hermes_cli/test_refine*.py` does **not** exist — actual `/refine`
  parity tests are `tests/agent/test_refine_focus.py` +
  `tests/run_agent/test_background_review*.py`.

### Data flow (current)

```
user turn ─▶ turn_context (turns_since_memory++ → should_review_memory)
   └▶ conversation_loop (iters_since_skill++ per tool iteration; skill_manage resets)
   └▶ turn_finalizer (after response: should_review_skills = iters_since_skill >= interval)
        └▶ _spawn_background_review(snapshot, review_memory, review_skills, focus?)
             └▶ daemon thread: forked AIAgent (same runtime/cache, whitelist memory+skills)
                  └▶ review prompt → memory/skill tool calls
                       └▶ skill_manage → write gate (allow | stage to pending/*.json)
                       └▶ summarize actions → "💾 Self-improvement review: …"
/refine → same spawner (review_memory=True, review_skills=skill_manage-available, focus)
/learn  → build_learn_prompt(req) → injected as normal user turn → authors SKILL.md
```

## 3. Target TypeScript design

New in-process module tree under `web/src/` (business logic kept out of React
components per AGENTS.md):

```
web/src/lib/self-improvement/
  types.ts            // ReviewKind, ReviewRequest, ReviewResult, PendingWrite,
                      // SkillUsageRecord, WriteOrigin, GateDecision
  prompts.ts          // MEMORY/SKILL/COMBINED_REVIEW_PROMPT + appendFocus();
                      // parity fixture vs background_review.py
  scheduler.ts        // NudgeCounters {turnsSinceMemory, itersSinceSkill};
                      // onUserTurn() / onToolIteration(toolName) / onTurnEnd()
  review-runner.ts    // spawnReview(request): BackgroundTask (child agent)
  action-summary.ts   // summarizeReviewActions(messages, priorSnapshot, mode)
  provenance.ts       // AsyncLocalStorage<WriteOrigin>; set/reset/get/isBackgroundReview
  usage-store.ts      // .usage.json sidecar read/write (atomic + lock)
  write-gate.ts       // evaluateGate(subsystem, opts) -> GateDecision
  pending-store.ts    // pending/*.json list/get/stage/discard/count; zod schemas
  skill-writer.ts     // SKILL.md authoring helpers (frontmatter validation,
                      // size limits, references/templates/scripts layout)
  learn-prompt.ts     // buildLearnPrompt(userRequest) — port of learn_prompt.py
  service.ts          // SelfImprovementService: counters + event bus + spawn/cancel
```

Key interfaces (signatures only):

```ts
interface SelfImprovementService {
  onUserTurnStart(): void;                       // turnsSinceMemory++
  onToolIteration(toolName: string): void;       // itersSinceSkill++; reset on skill_manage
  maybeSpawnAfterTurn(ctx: TurnContext): ReviewRequest | null;
  refine(focus?: string): void;                  // /refine
  learn(userRequest: string): void;              // /learn → prompt → normal turn
  listPending(subsystem): PendingWrite[];
  approvePending(subsystem, id): void; rejectPending(subsystem, id): void;
  setApprovalGate(subsystem, on: boolean): void;
}
```

**Review runner design (the fork):** run a **child `Agent` task** through
kimi-code's `BackgroundManager` pattern (`packages/agent-core/src/agent/background/index.ts`
+ `agent-task.ts`): unique task id, status lifecycle, output ring buffer, abort
controller. The child agent:
- inherits provider/model/base_url/credentials from the parent runtime;
- `maxIterations: 16`, `quiet: true`, `persistDisabled: true`, `sessionId`
  pinned to parent (cache warmth), `compressionEnabled: false`;
- gets a **tool allowlist** (`memory` + `skill_manage` only) via the tool
  manager's enabled/deny path (`src/agent/tool/index.ts`);
- replays `messages_snapshot` — full on the same model, digest when routed;
- runs the review prompt (memory-only / skill-only / combined + focus);
- registers on the parent's active-children set; `AbortController` cancels a
  still-running review when the next live turn starts.

**Trigger wiring in the TS loop:** hook `scheduler` into the turn lifecycle:
`onUserTurnStart` (≡ `turn_context.py`), `onToolIteration` (≡
`conversation_loop.py` increment + `tool_executor.py` reset), `onTurnEnd` (≡
`turn_finalizer.py` post-response check — spawn only when `finalResponse`
present, not interrupted, not a background session).

**Event-based dispatch:** `SelfImprovementService` publishes through the
kimi-code `IEventService`-style emitter: `self-improvement.review.requested`
(kind, focus?), `self-improvement.review.completed` (actionSummary[], kind),
`self-improvement.pending.changed` (subsystem, count) — drives UI badge.

**UI surfaces (Desktop):**
- `/refine [focus]` and `/learn <what>` registered in the composer slash
  palette (`web/src/lib/composer-skills.ts` pattern) → `SelfImprovementService`;
- Skills page (`web/src/routes/skills.tsx`) gains a "待审批写入" tab: gist list,
  `diff` view, approve/reject — the pending review surface Python only exposes
  via CLI/gateway slash;
- review-completion toast/banner (`💾`-style summary from `action-summary.ts`),
  delivered via `use-gateway.ts` event subscription.

## 4. Data models & persistence

Keep **JSON sidecar parity** with the Python layout so a hybrid phase can share
`~/.hermes` with the managed runtime and read existing user data:

| Store | Path | Shape (zod) |
|---|---|---|
| Skill usage telemetry | `skills/.usage.json` | `Record<name, {use_count, view_count, patch_count, last_used_at?, last_viewed_at?, last_patched_at?, state, pinned, archived_at?, created_at?}>` |
| Bundled manifest / hub / suppression | `skills/.bundled_manifest`, `skills/.hub/lock.json`, `skills/.curator_suppressed` | `"name:hash"` lines / `{installed: …}` / newline names (provenance filters) |
| Pending writes | `pending/memory/<id>.json`, `pending/skills/<id>.json` | `{id, subsystem, action, summary, origin: "foreground"\|"background_review", created_at, payload}` |
| Nudge counters | in-memory per agent; hydrated from session history | `{turnsSinceMemory, itersSinceSkill}` |
| Config | `config.yaml` (`memory.nudge_interval`, `skills.creation_nudge_interval`, `skills.write_approval`, `memory.write_approval`, `auxiliary.background_review.*`) | read via Rust `get_runtime_config` / new read-only command |

Schema strategy: zod schemas in `packages/protocol` (consistent with existing
`hermes-api.ts`) for `PendingSkillWrite`, `SelfImprovementReviewResult`,
`SkillUsageRecord`. Tolerate corrupt files (Python uses `errors="replace"` +
empty-set fallback — replicate). Atomic writes: `<file>.tmp` then `fs.rename`
(≡ `os.replace`). Cross-process lock during hybrid: `mkdir`-based lock or
`proper-lockfile` so a TS writer never corrupts a file the Python runtime is
also writing. Migrations: version tag `{version: 1}` in `.usage.json` and
pending records; preserve unknown keys on read; never destroy pending payloads
(user-facing approvals).

## 5. Third-party library strategy

| Python dependency | TS equivalent | Evidence |
|---|---|---|
| `threading.Thread` + daemon fork | kimi-code `BackgroundManager` / `AgentBackgroundTask` (`packages/agent-core/src/agent/background/`) | `background/index.ts`: task id, status, ring-buffer output, abort, persistence; `agent-task.ts`/`process-task.ts` |
| `contextvars.ContextVar` (provenance) | Node `AsyncLocalStorage` (`node:async_hooks`) — no npm dep | no kimi-code equivalent; implement from scratch |
| `orjson` | native `JSON.parse/stringify` + zod | `packages/protocol` already uses zod |
| `fcntl`/`msvcrt` file locks | `proper-lockfile` (npm) or `mkdir` lockfile shim | **no kimi-code evidence** (kimi-code uses minidb/sqlite, not locked JSON sidecars); thin shim acceptable |
| event/notification triggers | kimi-code `IEventService` (`src/services/event/eventService.ts`, `Emitter` in `src/base/common/event`) | in-process pub-sub over `ProtocolEvent` |
| approval gate round-trip | kimi-code `IApprovalService` (`src/services/approval/approval.ts`) | request/resolve broker pattern; the gate stages instead of blocking |
| sub-agent fork with restricted tools | kimi-code subagent host (`src/session/subagent-host.ts`) + tool allowlist (`src/agent/tool/index.ts`) + permission policies (`src/agent/permission/`) | reuse for the review child agent |
| skill registry/activation | kimi-code `SkillManager` (`src/agent/skill/index.ts`) | **activation only** — no authoring; skill writing from scratch (`skill-writer.ts`) |
| usage telemetry / provenance / review prompts / learn prompt | **no TS equivalent — implement from scratch** | kimi-code lacks memory store, `.usage.json`, `/refine`, `/learn`, background review |

## 6. Integration with existing Hermes-CN-Desktop frontend

- **`web/src/hooks/use-skills.ts`** — add `usePendingSkillWrites()`,
  `useApprovePendingSkillWrite()`, `useRejectPendingSkillWrite()`,
  `useSkillApprovalGate()` backed by the in-process service (Phase 1: same
  interface over new REST endpoints).
- **`web/src/routes/skills.tsx`** — add the pending-writes review tab (gist
  list, `diff <id>` modal reading the staged payload, approve/reject); reuse
  existing list/markdown/toggle layout and `skills.module.css` tokens.
- **`web/src/lib/composer-skills.ts`** — extend the slash palette with `/refine`
  + `/learn` (same `getLeadingSlashToken` / `replaceLeadingSlashToken`
  mechanics); `/skills pending` sub-commands reuse namespace parsing.
- **`web/src/lib/skill-origin.ts`** — already resolves `external | user | builtin`
  provenance for display; reuse for the "agent-created" badge and the protected
  skills list in the review prompts (bundled/hub/pinned/user-owned off-limits).
- **`web/src/lib/gateway-client.ts` + `web/src/hooks/use-gateway.ts`** —
  subscribe to `self-improvement.review.completed` / `pending.changed` for the
  completion toast and pending badge (JSON-RPC event surface).
- **`web/src/routes/wander-memory/*`** (existing memory UI) — candidate home
  for memory-review summaries / memory pending writes; out of scope unless the
  memory-gate port lands in the same milestone.
- **Rust (`src/commands/*`)** — no new command in Phase 1 (service runs in the
  webview); Phase 2 adds a read-only `get_self_improvement_config` Tauri command
  returning `memory.nudge_interval` / `skills.creation_nudge_interval` /
  `skills.write_approval` / `auxiliary.background_review.*` so the TS scheduler
  matches Python config.
- **`packages/protocol`** — add Zod schemas + IPC types (§4).

## 7. Removing the WebSocket dependency (migration path)

1. **Phase 0 (today):** loop runs entirely in Python; desktop only consumes
   skills via `GET/PUT /api/skills*` REST; no review/pending surface. Freeze:
   `/api/skills`, `/api/skills/content`, `/api/skills/toggle` = shared CRUD.
2. **Phase 1 (TS behind same interface):** implement `SelfImprovementService`
   in-process; route `/refine` + `/learn` locally; keep REST for skill CRUD.
   Add REST aliases (`/api/skills/pending|approve|reject`, `/api/refine`,
   `/api/learn`) **only** if hybrid-mode dashboard needs them — otherwise UI
   talks to the in-process service and WS/REST stays untouched.
3. **Phase 2 (delete WS/REST path):** TS writes the same `~/.hermes` sidecars;
   managed runtime no longer needed for skills/memory; remove review endpoints +
   review WebSocket events; delete `/api/skills*` REST after transition.

Frozen interface during migration: `SelfImprovementService.{refine, learn,
maybeSpawnAfterTurn, listPending, approvePending, rejectPending,
setApprovalGate}` + events `self-improvement.review.completed` /
`self-improvement.pending.changed` — the UI depends only on these, never on
Python internals.

## 8. Migration phases & task breakdown

| # | Task | Phase | Verification |
|---|---|---|---|
| 1 | Port prompts + `action-summary.ts` (byte-identical fixtures from `background_review.py`) | 1 | vitest fixture diff vs Python strings |
| 2 | `scheduler.ts` counters + turn/tool hooks in the TS agent loop | 1 | unit: 10-turn memory trigger, 10-iteration skill trigger, `skill_manage` reset, counter hydration |
| 3 | `provenance.ts` (AsyncLocalStorage) + `usage-store.ts` (atomic sidecar, lock) | 1 | unit: isolation, corrupt-file tolerance, concurrent bump |
| 4 | `write-gate.ts` + `pending-store.ts` + `skill-writer.ts` | 1 | unit: gate matrix, approve/reject replay, frontmatter validation |
| 5 | `review-runner.ts` child agent (restricted tools, digest/full replay, abort) | 1 | integration with fake LLM; restricted-tool denial |
| 6 | `learn-prompt.ts` port + `/learn` composer entry | 1 | unit + E2E: standards present; skill appears in list |
| 7 | `/refine` composer entry + completion toast via gateway events | 1 | E2E |
| 8 | Pending-writes tab in `routes/skills.tsx` + gate toggle | 1 | E2E |
| 9 | Config keys via Rust command; hybrid sidecar sharing | 2 | parity vs Python `.usage.json`/pending files |
| 10 | Cut over: delete WS/REST review path, docs update | 3 | full e2e against in-process service |

## 9. Risks & open questions

- **No kimi-code equivalent for the learning core (main risk).** kimi-code has
  background *tasks* (bash/subagent), an event bus, an approval broker, and
  skill *activation* — but no memory store, no skill authoring, no review fork,
  no `/refine`/`/learn`. Prompts, provenance, usage telemetry, pending store,
  and learn-prompt builder are all from-scratch TS; parity is test-defined, not
  upstream-defined.
- **Provider cache warmth.** Python's fork reuses the parent's cached system
  prompt + byte-identical `tools[]` to hit the same Anthropic/OpenRouter prefix
  cache; the TS child must reproduce the same request bytes or every review is a
  cold, expensive call — highest-risk detail; needs a dedicated parity test.
- **Review/live-turn race.** Python solves it with `_active_children` +
  `_background_review_agent` + cancellation; TS replicates via `AbortController`
  + an active-children registry (a still-streaming review sharing
  `sessionId`/credentials can corrupt accounting).
- **Persistence isolation.** Python sets `_persist_disabled=True` so the fork's
  harness turn never lands in the user's real session DB; the TS child must run
  `persistDisabled: true` or the "Review the conversation above…" turn becomes a
  standing instruction (curator-takeover bug class).
- **Write-approval gate UX gap.** No dashboard REST surface exists today;
  the desktop must build the pending UI from scratch (task 8) — "stage → diff →
  approve" needs a deliberate UX decision (modal vs tab).
- **Cross-process locking during hybrid.** If Python and TS both write
  `.usage.json`/pending while migrating, fcntl/msvcrt vs TS lockfiles are
  incompatible — plan a single writer during Phase 1/2.
- **Spec/test path mismatch.** `tests/hermes_cli/test_refine*.py` does not
  exist — real `/refine` tests are `tests/agent/test_refine_focus.py` +
  `tests/run_agent/test_background_review*.py`; parity tests target those.
- **Open questions:** (a) `/learn` reuses the *live* agent turn (Python injects
  into `_pending_input`) or spawns a dedicated child agent in TS? (b) surface
  memory pending writes in the desktop in the same milestone? (c) port
  `auxiliary.background_review.*` aux-model routing or ship same-model-only
  first?

## 10. Test strategy

- **Vitest unit:** `prompts.test.ts` (byte-identical prompt constants + focus
  parity with `test_refine_focus.py`); `scheduler.test.ts` (10-turn memory
  trigger, 10-iteration skill trigger, `skill_manage` reset, counter hydration +
  `skip_background_review` suppression parity); `provenance.test.ts`
  (AsyncLocalStorage isolation, port of `test_skill_provenance.py`);
  `usage-store.test.ts` (round-trip, corrupt-file tolerance, concurrent bump,
  port of `test_skill_usage.py`); `write-gate.test.ts` (allow/stage/blocked
  matrix + stage→approve→replay / reject→discard, port of
  `test_skill_manager_tool.py`); `learn-prompt.test.ts` (empty default,
  standards + hygiene text).
- **Integration:** `review-runner.test.ts` with the repo's local fake model —
  restricted-toolset denial, non-persistent session, digest vs full replay,
  action-summary parsing.
- **Playwright E2E (`e2e/`):** `/refine` → completion toast; `/learn https://…`
  → new skill in the skills list; `skills.write_approval` on → staged write in
  the pending tab → approve updates content, reject leaves it unchanged.
- **Parity harness:** run the Python clusters (`tests/tools/test_skill_*.py`,
  `tests/agent/test_refine_focus.py`, `tests/cli/test_cli_preloaded_skills.py`)
  against TS modules with the same fixtures/JSON shapes; CI gates on both
  (`web-test.yml` + `rust-test.yml` + `web-e2e.yml`).

## 11. Reference links

- Python (D:/hermes-agent-cn): `agent/background_review.py`,
  `agent/learn_prompt.py`, `agent/turn_context.py`, `agent/turn_finalizer.py`,
  `agent/conversation_loop.py`, `agent/tool_executor.py`, `agent/agent_init.py`,
  `agent/codex_runtime.py`, `tools/skill_usage.py`, `tools/skill_provenance.py`,
  `tools/write_approval.py`, `tools/skill_manager_tool.py`, `run_agent.py`,
  `hermes_cli/{cli_commands_mixin,write_approval_commands,web_routers/skills}.py`,
  `gateway/slash_commands.py`.
- Docs: `website/docs/user-guide/features/skills.md`,
  `website/docs/reference/slash-commands.md`.
- Tests: `tests/tools/test_skill_*.py`, `tests/agent/test_refine_focus.py`,
  `tests/run_agent/test_background_review*.py`,
  `tests/agent/test_skip_background_review.py`,
  `tests/run_agent/test_memory_nudge_counter_hydration.py`,
  `tests/cli/test_cli_preloaded_skills.py`.
- TS reference: `D:/kimi-code/packages/agent-core/src/agent/background/`,
  `src/agent/tool/index.ts`, `src/services/event/eventService.ts`,
  `src/services/approval/approval.ts`, `src/agent/skill/index.ts`,
  `src/session/subagent-host.ts`, `src/loop/run-turn.ts`.
- Desktop: `D:/Hermes-CN-Desktop/web/src/hooks/use-skills.ts`,
  `web/src/routes/skills.tsx`, `web/src/lib/composer-skills.ts`,
  `web/src/lib/skill-origin.ts`, `web/src/lib/gateway-client.ts`,
  `web/src/hooks/use-gateway.ts`, `packages/protocol/`.
