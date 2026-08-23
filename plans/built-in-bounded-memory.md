# Built-in Bounded Memory — Python → TypeScript Rewrite Plan

## 1. Summary

The built-in bounded memory feature gives the agent a small, curated, file-backed
store of durable facts that survives across sessions: **MEMORY.md** (agent's
personal notes, 2,200-char limit) and **USER.md** (user profile, 1,375-char
limit), both under `<HERMES_HOME>/memories/`. The agent manages it through a
single `memory` tool (actions `add` / `replace` / `remove` plus an atomic
`operations` batch), with exact-duplicate prevention, threat-pattern scanning
before any write, char-budget enforcement, external-drift protection, and an
optional write-approval gate (`memory.write_approval`) that stages writes to
`<HERMES_HOME>/pending/memory/<id>.json` for review via the
`/memory pending|approve|reject|approval` slash command.

This plan ports the full behavior to TypeScript so the Desktop webview can host
it in-process once the Python runtime/WS link is removed. The target is a
`web/src/lib/builtin-memory/*` module set (store + tool + security + write
approval + slash handling) that reuses the existing `/memory` route and Rust
`src/commands/memory.rs` file bridge today, then replaces the bridge with pure
in-process FS operations behind the same interface. **No TS equivalent exists in
kimi-code** for the curated persistent-memory store, the threat scanner, or the
staged write-approval store — all three must be implemented from scratch (see
§5 and §9).

## 2. Current Python implementation

Source of truth: `D:/hermes-agent-cn`.

- **`tools/memory_tool.py`** (1,252 lines) — the core feature:
  - `MemoryStore` class: loads/parses/serializes §-delimited entries from
    `get_hermes_home()/memories/MEMORY.md` and `USER.md`; keeps a **frozen
    system-prompt snapshot** (`_system_prompt_snapshot`) captured at
    `load_from_disk()`; never mutates the snapshot mid-session (prefix-cache
    invariant).
  - Mutations: `add` (exact-duplicate rejection, char-budget check, append-only
    with `skip_drift`), `replace` / `remove` (short unique substring matching,
    multiple-match rejection with previews), `apply_batch` (all-or-nothing,
    budget checked on the final state only, duplicate `add` idempotent-skipped).
  - `_scan_memory_content()` → `tools/threat_patterns.first_threat_message(...,
    scope="strict")`; every `add`/`replace` content is scanned; poisoned entries
    load-time are replaced by `[BLOCKED: ...]` placeholders in the snapshot only
    (live state keeps raw text for user inspection).
  - External-drift guard (`_detect_external_drift`, issue #26045): refuses
    `replace`/`remove`/`apply_batch` when the file on disk does not round-trip
    (manual edits, shell appends, sister-session writes), saving a
    `.bak.<ts>` snapshot first.
  - Read-modify-write safety: `_read_raw_checked` treats an *existing but
    unreadable* file as abort (never rewrite from an assumed-empty view),
    `_file_lock` (fcntl / msvcrt) around mutations, atomic write via
    `utils.atomic_write_text` (tmp file + `os.replace`).
  - Entry point `memory_tool(action, target, content, old_text, operations,
    store)` returns JSON strings; `MEMORY_SCHEMA` (OpenAI function schema:
    `action` enum, `target` enum memory|user, `content`, `old_text`,
    `operations`); `load_on_disk_store()` (honors configured char limits);
    `apply_memory_pending()` (replays staged payloads bypassing the gate);
    success responses are **terminal** (`"done": true`, note "do not repeat
    it"), errors return `current_entries` + `usage` for model self-correction,
    and a per-turn consolidation-failure cap (3, #42405) stops retry loops.
- **`agent/memory_provider.py`** (368 lines) — `MemoryProvider` ABC (lifecycle:
  `initialize`, `system_prompt_block`, `prefetch`, `queue_prefetch`,
  `sync_turn`, `get_tool_schemas`, `handle_tool_call`, `shutdown`; optional
  hooks `on_turn_start`, `on_session_end`, `on_session_switch`, `on_pre_compress`,
  `on_memory_write`, `on_delegation`) plus `TRIVIAL_PROMPT_RE` /
  `is_trivial_prompt()` to skip recall on greetings/slash commands.
- **`agent/memory_manager.py`** (1,241 lines) — `MemoryManager` orchestrates
  the builtin provider plus **one** external provider; registers tool schemas,
  routes `handle_tool_call`, merges `prefetch_all` (builtin inline, external
  with 8 s timeout thread), serializes background `sync_all` /
  `queue_prefetch_all` on a single worker, fans out lifecycle hooks
  (`on_session_end/switch/pre_compress/delegation`), mirrors successful
  built-in memory writes to external providers via
  `notify_memory_tool_write()` (only committed non-staged writes; expands
  batch ops; injects per-op metadata), and `shutdown_all()` with a bounded 5 s
  drain. Also `sanitize_context()`, `StreamingContextScrubber`,
  `build_memory_context_block()` which wrap prefetched recall in a
  `<memory-context>` fence + system note for stream-safe UI scrubbing.
- **`tools/write_approval.py`** (493 lines) — the write gate: reads
  `memory.write_approval` from config.yaml (default off → allow);
  `evaluate_gate()` returns allow / blocked (inline CLI denial) / stage
  (gateway, background, or non-interactive); `stage_write()` persists
  `{id, subsystem, action, summary, origin, created_at, payload}` under
  `<HERMES_HOME>/pending/memory/<id>.json` (uuid4 hex[:8], atomic tmp+rename);
  `list_pending` / `get_pending` / `discard_pending` / `pending_count`;
  origin via `tools/skill_provenance.get_current_write_origin()`
  (`foreground` vs `background_review`).
- **`hermes_cli/write_approval_commands.py`** (209 lines) — shared
  `/memory` handler: `pending` list (with `[auto]` tag), `approve <id>|all`
  (replays via `apply_memory_pending` against a live or `load_on_disk_store()`
  store, then `discard_pending`), `reject <id>|all`, `approval on|off`
  (persists config). Returns plain text for terminal/chat.
- **`hermes_cli/commands.py`** line 273 — `CommandDef("memory", ...)` with
  `subcommands=("pending", "approve", "reject", "approval")`.
- **`hermes_cli/cli_commands_mixin.py`** `_handle_memory_command()` (line 1952)
  — CLI dispatch; falls back to `load_on_disk_store()` when no live agent
  (#46783).
- **`gateway/slash_commands.py`** `_handle_memory_command()` (line 3586) —
  gateway dispatch; `_set_approval` writes config raw and evicts the cached
  agent.
- **`agent/agent_init.py`** (lines ~1904–1969) — builds the built-in
  `MemoryStore` unless globally disabled (`memory_enabled` /
  `user_profile_enabled`, #65429 keeps the store even for `skip_memory` when
  the `memory` toolset is requested); registers the external provider.
- **`agent/tool_executor.py`** (line 1946) — `memory` tool dispatch calls
  `memory_tool(...)` with `store=agent._memory_store`, then
  `agent._memory_manager.notify_memory_tool_write(result, next_args, ...)`.
- **Docs**: `website/docs/user-guide/features/memory.md` — behavior contract
  (frozen snapshot, capacity management, duplicate prevention, security
  scanning, `write_approval` UX, `/memory pending|approve <id>|reject <id>|
  approval on|off`).

Data flow (agent turn): session start → `MemoryStore.load_from_disk()` renders
frozen snapshot block into system prompt → per turn the agent may call `memory`
tool → `tool_executor` → `memory_tool()` → gate check → `MemoryStore` mutation
(scan → lock → reload → dedupe → budget → atomic save) → JSON result → manager
mirrors committed writes to external providers → next session re-reads files.

## 3. Target TypeScript design

New module set under `web/src/lib/builtin-memory/` (in-process, no Python):

- **`store.ts` — `BuiltinMemoryStore`** (port of `MemoryStore`): constructor
  `({ memoryCharLimit = 2200, userCharLimit = 1375 })`; `loadFromDisk()`
  parses §-delimited entries, dedupes (keep first), sanitizes entries for the
  snapshot (BLOCKED placeholders), captures the frozen snapshot; methods
  `add(target, content)`, `replace(target, oldText, newContent)`,
  `remove(target, oldText)`, `applyBatch(target, operations)` returning the
  same JSON-shaped result dicts (success terminal response, error responses
  with `current_entries`/`usage`, consolidation-failure cap per turn,
  drift/read-failed aborts). Pure TS: parsing, char counting (JS `.length`
  matches Python `len()` for UTF-16? — verify; Python counts code points, so
  use `[...str].length`), substring matching, duplicate detection.
- **`fs.ts` — `MemoryFs` interface**: `readFile(path)`, `writeFileAtomic(path,
  content)`, `lock(path)` — implemented today by a thin wrapper over Tauri
  IPC (`window.hermesDesktop.*`), later by `src/` Tauri commands or
  node:fs when running under a TS runtime (see §5). Keeps the store
  platform-independent for vitest (in-memory fake fs).
- **`security.ts` — threat scanner** (port of `tools/threat_patterns.py`
  strict scope): `scanThreats(content): string[]` / `firstThreatMessage()`;
  regex rules for prompt injection, credential exfiltration, SSH backdoors,
  invisible Unicode. Pure TS regex.
- **`tool.ts` — `memoryTool()` + Zod schema**: mirrors `MEMORY_SCHEMA`
  (`action` enum add|replace|remove, `target` enum memory|user, `content`,
  `old_text`, `operations[]`) and the dispatch logic: validate before gate,
  `_applyWriteGate`, single-op vs batch path, return JSON strings identical to
  Python.
- **`write-approval.ts`**: `isWriteApprovalEnabled()` (reads config),
  `evaluateGate({inlineSummary, inlineDetail})` → `{allow|blocked|stage}`,
  `stageWrite(payload, summary, origin)`, `listPending()`, `getPending(id)`,
  `discardPending(id)`, `pendingCount()`, `applyPending(payload, store)`
  (bypasses gate, replays via store methods). Pending records written as JSON
  files via `MemoryFs` under `pending/memory/`.
- **`slash.ts`**: `handleMemorySlash(args: string[]): string` — parses
  `pending | approve <id|all> | reject <id|all> | approval <on|off>` and
  returns the exact text strings produced by
  `hermes_cli/write_approval_commands.py` (UX parity).
- **`injection.ts`**: `buildMemoryContextBlock(raw)` +
  `sanitizeContext()` + `StreamingContextScrubber` port (for the future
  in-process agent loop streaming path); `renderMemoryBlock(target, entries)`
  reproducing the `═`-separated header with usage percentage.
- **`manager.ts` — `MemoryManager`** (port of the provider orchestration): a
  `MemoryProvider` TS interface (same lifecycle), one-builtin + at-most-one
  external rule, tool-schema aggregation, `notifyMemoryToolWrite` bridge
  (committed-write filtering, batch expansion, metadata), background
  sync/prefetch queue. Only exercised once the agent loop is in-process; keep
  the interface ready and mirror writes today through the WS path (no-op if no
  external provider).

The memory page and slash UX call these modules directly; the tool executes
inside the TS agent loop without a WS round-trip. In the interim, the same
modules can be exposed behind a tiny IPC command surface so the existing React
route works unchanged (see §6).

## 4. Data models & persistence

- **Memory files** (format must stay byte-compatible with Python):
  - `memories/MEMORY.md` — `§` (`\n§\n`) -delimited entries; default limit
    2,200 chars, configurable `memory.memory_char_limit` (Python clamps
    1–8,000 via `normalize_memory_char_limit`).
  - `memories/USER.md` — same format; default 1,375, `memory.user_char_limit`.
  - `MemoryFileInfo` / `AgentMemoryInfo` / `MemoryInfo` shapes already exist
    in Rust (`src/commands/memory.rs` structs) and `web/src/lib/runtime.ts`;
    keep them as the stable read shape (`content`, `exists`, `lastModified`,
    `entries[{index, content}]`, `charCount`, `charLimit`).
- **Pending records**: `<HERMES_HOME>/pending/memory/<id>.json` with
  `{id, subsystem:"memory", action, summary, origin, created_at, payload}`;
  payload is the replayable tool args
  (`{action, target, content, old_text}` or `{action:"batch", target,
  operations}`). Read oldest-first, skip unreadable records with a warning.
- **Config**: `memory.write_approval: bool` in `config.yaml` (default false);
  `memory.memory_enabled` / `user_profile_enabled` / char limits. Desktop Rust
  already reads this via `serde_yaml` in `src/commands/memory.rs`; expose
  read/write through the same Rust side or a `read_config_section` command.
- **Persistence strategy**: keep **file-based** (never migrate to IndexedDB)
  so the Desktop and the Core backend can share the same `memories/` and
  `pending/memory/` directories; write via atomic tmp+rename; preserve the
  drift guard so a TS-side write never clobbers Python/sister-session content.
  No schema migration needed — formats are already shared. `MemoryFs` is the
  seam for later Rust→node fs swaps.

## 5. Third-party library strategy

| Python dependency | TS equivalent | Evidence / notes |
|---|---|---|
| `orjson` (JSON serialization) | native `JSON.stringify` / `JSON.parse`; `zod` for tool-arg validation | kimi-code uses `zod` everywhere (e.g. `packages/agent-core-v2`); no orjson port needed. |
| `pathlib` / `os.replace` atomic writes (`utils.atomic_write_text`) | `node:fs/promises` write+rename, or reuse Rust `write_file_safe` (tmp+rename, `src/commands/memory.rs:180`) | kimi-code file-based session persistence `packages/agent-core/src/session/store/session-store.ts` uses `node:fs/promises` `writeFile`/`rename` patterns. |
| `fcntl` / `msvcrt` file locks | none — single-process desktop; serialize mutations through one Rust `spawn_blocking` task or a TS mutex; no npm lib | Rust `run_memory_io` already serializes per command; drift guard remains the real cross-process protection. |
| `tools/threat_patterns.py` (strict scope) | **implement from scratch**: `security.ts` regex port | **No kimi-code equivalent found** — kimi-code "injection" hits are context-origin types (`contextMemory/types.ts`), not content scanners. |
| `uuid.uuid4().hex[:8]` | `crypto.randomUUID().slice(0,8)` | Node/browser built-in. |
| YAML config (`hermes_cli.config`) | Rust `serde_yaml` in `src/commands/memory.rs` already parses `memory.*`; expose via IPC | No new npm lib. |
| `concurrent.futures.ThreadPoolExecutor` (manager background queue) | `Promise` queue / simple async mutex in `manager.ts` | kimi-code uses async services + DI (`IAgentContextMemoryService`, `contextMemoryService.ts`). |
| OpenAI function-calling schema | Zod schema + native tool registration | kimi-code tool schemas: `packages/agent-core-v2/src/agent/toolSelect/dynamicTools.ts`. |

**Explicit "no TS equivalent" items** (see §9): (1) curated MEMORY.md/USER.md
persistent store — kimi-code's `contextMemory` is the **in-session message
history** (append/undo/compaction: `contextMemoryService.ts`), not a durable
memory file store; (2) prompt-injection/exfil content scanner; (3) staged
write-approval pending store — kimi-code's approval is a broker for tool-call
approvals (`packages/agent-core/src/services/approval/approval.ts`,
`toolApproval/toolApproval.ts`), not a review-later JSON store. All three are
greenfield TS modules with interfaces sketched in §3.

## 6. Integration with existing Hermes-CN-Desktop frontend

- **Reuse now**: `web/src/hooks/use-memory.ts` (TanStack Query hooks calling
  `window.hermesDesktop.readMemory / addMemoryEntry / updateMemoryEntry /
  removeMemoryEntry / writeUserProfile`), `web/src/routes/memory.tsx` (内置记忆
  page: capacity bars, entry CRUD, USER.md profile editor),
  `components/memory/memory-limit-control.tsx`, app-shell top tabs
  (`components/app-shell/use-active-top-tab.ts` maps `/memory` →
  `hermesMemory`), `web/src/lib/memory-page-stats.ts`.
- **Rust bridge**: `src/commands/memory.rs` already reads/writes the same
  files atomically and exposes `MemoryInfo`/`MemoryMutationResult`. Extend it
  (or add `builtin_memory_*` commands) for: pending list/get/approve/reject,
  `memory.write_approval` toggle, and (for parity) duplicate/scan/gate checks
  until the TS store replaces it. Keep `active_hermes_home` / remote-mode
  refusal semantics.
- **New UI**: pending-writes review panel inside `/memory` (list with `[auto]`
  tag, approve/reject per id or all) and an approval-gate switch; keep the
  existing entry/profile tabs. WanderMemory (`use-wander-memory.ts`,
  `wander-memory/*`) is a **separate** semantic-memory surface — per
  `docs/wander-memory-merge.md` §4 there is no overlap with built-in memory.
- **Protocol**: move `MemoryInfo` / `MemoryMutationResult` / new
  `PendingMemoryRecord` types into `packages/protocol/src/hermes-api.ts` Zod
  schemas (today they live ad hoc in `web/src/lib/runtime.ts` + Rust structs)
  so the bridge and future in-process code share one schema.

## 7. Removing the WebSocket dependency (migration path)

1. **Phase A (today)**: memory page uses Rust IPC directly (already offline
   for read/write); `/memory pending|approve|reject|approval` still flows to
   the Core backend through the chat WS. Freeze the API surface:
   `MemoryInfo` shape, `MemoryMutationResult`, memory tool result JSON, pending
   record JSON, slash-command output strings.
2. **Phase B (in-process store)**: implement `web/src/lib/builtin-memory/*`
   and wire the *read/mutate* surface behind the same Rust commands OR call the
   TS store directly through a new thin IPC command set. The `/memory` slash
   handler switches to `slash.ts` locally while the backend still exists —
   output strings must match `write_approval_commands.py` exactly.
3. **Phase C (agent-loop tool)**: when the TS agent loop hosts the `memory`
   tool, `toolExecutor` calls `memoryTool(store)` in-process; delete the
   WS/REST memory endpoint path and the `memory` tool dispatch in Core's
   `agent/tool_executor.py`. `MemoryManager.notifyMemoryToolWrite` bridge is
   re-implemented as `manager.ts` for external providers (or dropped if
   external providers remain Python-side).
4. Delete the Core memory REST/WS routes last, keeping file formats
   interoperable so a mixed deployment (Python CLI + TS Desktop) still shares
   `memories/` and `pending/memory/` safely.

## 8. Migration phases & task breakdown

- **P0 — TS store core** (`store.ts`, `fs.ts`, tests): §-parse/serialize,
  add/replace/remove/applyBatch, exact-duplicate prevention, char budgets
  (memory 1–8,000 clamp; user config), frozen snapshot + BLOCKED sanitization,
  drift detection + `.bak` snapshot, unreadable-file abort, terminal success
  response, consolidation-failure cap.
- **P0 — security scan** (`security.ts`): port strict-scope threat patterns;
  parity fixtures from Core tests (`tests/tools/test_threat_patterns.py`).
- **P1 — write approval** (`write-approval.ts`, `slash.ts`): gate evaluation
  (allow/blocked/stage), pending JSON store, apply/reject, config toggle, exact
  slash output parity.
- **P1 — bridge & UI**: extend `src/commands/memory.rs` (pending + gate +
  dedupe/scan parity), pending-review panel + gate switch in `routes/memory.tsx`,
  protocol Zod schemas.
- **P2 — injection & manager** (`injection.ts`, `manager.ts`):
  `<memory-context>` block, streaming scrubber, provider interface +
  notify-write bridge for the future in-process agent loop.
- **P3 — WS removal**: switch slash/tool to in-process modules; delete Core
  memory REST/WS path.

## 9. Risks & open questions

- **No TS equivalent in kimi-code (highest risk)**: no curated persistent
  memory store, no threat scanner, no staged write-approval store. All three
  are greenfield; the port must be behavior-exact against Python tests to avoid
  silent drift (e.g. success responses intentionally omit entries to stop model
  thrash; drift guard must not be dropped).
- **Existing Rust bridge diverges**: `src/commands/memory.rs` has **no**
  duplicate prevention, no threat scan, no batch, no write gate, no drift
  guard, and `USER.md` is a single blob (no entries). Desktop-side writes today
  can therefore duplicate/poison entries and clobber Python-side drift —
  Phase P1 must align Rust or bypass it early.
- **Cross-process writes**: the Desktop memory page writes files while the
  Core agent may write the same files via the memory tool. Without the lock +
  drift guard the two can race. Keep `MemoryFs` locking/drift semantics even in
  single-process mode.
- **Char counting**: Python `len()` counts code points; JS `.length` counts
  UTF-16 units — must use `[...str].length` (or `Intl.Segmenter`) for parity,
  including Rust's `char_count()` (already code-point correct via
  `content.chars().count()`).
- **`write_approval` origin**: `background_review` tagging depends on the
  skill-provenance ContextVar; TS must carry an equivalent origin context when
  the in-process background review exists (P2+), else `[auto]` tags vanish.
- **Inline CLI approval**: Python memory writes prompt inline on the CLI;
  Desktop has no inline prompt channel — stage-only matches the gateway path,
  which is the documented behavior to mirror.

## 10. Test strategy

- **Vitest unit (new `web/src/lib/builtin-memory/__tests__/`)**: parse/
  serialize round-trip (§, BOM, empty), dedupe keep-first, char-limit add
  reject + batch final-state budget, replace/remove substring matching and
  multi-match rejection, drift detection + backup, unreadable-file abort,
  BLOCKED snapshot sanitization, threat-scan rules, gate allow/blocked/stage,
  pending CRUD (idempotent approve, reject all), slash output strings.
- **Parity tests vs Python**: golden fixtures generated from the Core tests —
  `tests/agent/test_memory_provider.py` (manager fan-out, one-external rule,
  prefetch timeout), `test_memory_write_bridge.py` (committed-write mirroring,
  metadata, batch expansion), `test_memory_async_sync.py` (background FIFO +
  shutdown drain), `test_memory_session_switch.py`, `test_memory_user_id.py`,
  `test_memory_boundary_commit.py` (end strictly before switch),
  `test_pre_compress_memory_context.py` (memory context injected into summary
  prompts), `test_skip_memory_store_65429.py` (store exists with
  `skip_memory` + memory toolset).
- **Rust tests**: extend `src/commands/memory.rs` `#[cfg(test)]` for new
  pending/gate commands; `tempfile::TempDir` + `pretty_assertions` per
  `AGENTS.md` conventions.
- **Playwright E2E**: `/memory` CRUD, approval-gate toggle, pending list →
  approve/reject with file assertions under a temp HERMES_HOME.
- **Verification gates**: `pnpm typecheck`, `pnpm test:unit`, `cargo check`.

## 11. Reference links

- Core: `tools/memory_tool.py`, `tools/write_approval.py`,
  `tools/threat_patterns.py`, `agent/memory_provider.py`,
  `agent/memory_manager.py`, `agent/agent_init.py`, `agent/tool_executor.py`,
  `hermes_cli/commands.py`, `hermes_cli/cli_commands_mixin.py`,
  `hermes_cli/write_approval_commands.py`, `gateway/slash_commands.py`,
  `website/docs/user-guide/features/memory.md`.
- Core tests: `tests/agent/test_memory_provider.py`,
  `test_memory_async_sync.py`, `test_memory_session_switch.py`,
  `test_memory_user_id.py`, `test_memory_write_bridge.py`,
  `test_memory_boundary_commit.py`, `test_pre_compress_memory_context.py`,
  `test_skip_memory_store_65429.py`, `tests/tools/test_threat_patterns.py`.
- Desktop: `src/commands/memory.rs`, `web/src/hooks/use-memory.ts`,
  `web/src/routes/memory.tsx`, `web/src/routes/external-memory.tsx`,
  `web/src/hooks/use-wander-memory.ts`, `web/src/lib/memory-page-stats.ts`,
  `components/memory/memory-limit-control.tsx`,
  `components/app-shell/use-active-top-tab.ts`,
  `docs/wander-memory-merge.md`.
- kimi-code: `packages/agent-core-v2/src/agent/contextMemory/*` (in-session
  context, NOT persistent memory),
  `packages/agent-core/src/session/store/session-store.ts` (file persistence
  pattern), `packages/agent-core/src/services/approval/approval.ts` +
  `packages/agent-core-v2/src/agent/toolApproval/toolApproval.ts` (approval
  broker pattern), `apps/kimi-code/src/utils/history/input-history.ts` (only
  input history — no memory files).
