# Session Lifecycle — Python → TypeScript Rewrite Plan

## 1. Summary

Feature: the user-facing **session lifecycle** command set — `/new` (alias `/reset`), `/clear`, `/history`, `/save`, `/resume`, `/sessions` (TUI alias `/switch`), `/title`, `/branch` (alias `/fork`), `/retry`, `/undo`, `/stop`, `/queue`, `/steer`, `/background` (alias `/bg`), `/handoff`. These commands mutate or inspect the session store (create/rotate/resume/rename/branch/rewind) or steer the running agent loop (stop/queue/steer/background).

Today all of this runs in Python: the CLI dispatches via `COMMAND_REGISTRY` + `cli.py` handlers; the messaging gateway reuses the same registry through `gateway/run.py` + `gateway/slash_commands.py`; persistence lives in `state.db` (SQLite, `SessionDB`); the Desktop app reaches the Python runtime over REST (`/api/sessions*`) and WS RPC (`session.create`, `session.resume`, `session.title`, `session.branch`, `command.dispatch`).

Target: a pure-TypeScript **in-process session store + slash-command engine** inside `web/src`, with SQLite persistence owned by Rust via Tauri IPC (README: "Rust stays for … SQLite if needed"). The Python `SessionDB`/`SessionStore` semantics (compression lineage, title provenance, soft-delete rewind, branch markers) are ported so existing `state.db` data and `/resume <id>` behavior remain compatible. `/handoff` is a messaging-platform adapter (Core marks it `cli_only`); it is recorded out of scope for the desktop standalone with justification, but gets a plan entry here per README.

## 2. Current Python implementation

Source of truth files (all under `D:/hermes-agent-cn`):

- **Command registry**: `hermes_cli/commands.py` — `COMMAND_REGISTRY` list of `CommandDef` (name, description, category, aliases, `busy_policy` ∈ {dispatch, reject, interrupt_then_dispatch}, `busy_handler`, `cli_only`/`gateway_only`). Key entries: `new` (alias `reset`), `clear` (cli_only), `history` (cli_only), `save` (cli_only), `retry`, `undo`, `title`, `handoff` (cli_only), `branch` (alias `fork`), `resume`, `sessions`, `stop`, `queue` (alias `q`, busy_handler queue), `steer` (busy_handler steer), `background` (aliases `bg`,`btw`, busy_policy dispatch).
- **CLI handlers**: `cli.py` (19k lines, REPL/state machine, `/clear` → `("", False)` at line 12036, `/undo` turn-count parse at 10426) and `hermes_cli/cli_commands_mixin.py` — `_handle_stop_command`, `_handle_resume_command` (number/title/id resolution → `resolve_resume_session_id` compression-tip redirect → end old session `resumed_other` → reopen target → reload `get_resume_conversations`), `_handle_sessions_command` (delegates to resume), `_handle_branch_command` (flush → `end_session(...,"branched")` → `create_session` with `model_config._branched_from` marker + `parent_session_id` → `append_messages_batch` copy → switch to branch), `_handle_background_command` (background session via `run_background`).
- **Session DB** (`hermes_state.py`, 11623 lines; schema in `hermes_state_common.py`): `SessionDB` — `create_session`, `end_session`, `reopen_session`, `set_session_title`/`set_auto_title` (provenance ranks: derived < llm < user; `sanitize_title`, `MAX_TITLE_LENGTH=100`), `resolve_session_id` (exact or unique-prefix), `resolve_resume_session_id` (walks compression chain to msg-bearing descendant; skips `_branched_from`/`_delegate_from`/tool children, depth cap 32), `list_sessions_rich` (freshest-of recency SQL, branch/listable filtering), `get_messages` / `get_messages_as_conversation` / `get_resume_conversations` (lineage + alternation repair), `replace_messages`, `rewind_to_message` (soft-delete `active=0`, increments `rewind_count`, returns target user message for prefill — `/undo`), `clear_messages`, `delete_session`/`archive_sessions`/`set_session_archived` (compression-chain aware), `search_sessions` (FTS5 + trigram CJK).
- **Schema** (`hermes_state_common.py`): `SCHEMA_VERSION = 25`; `sessions` (id, source, user_id, session_key, chat_id/type, thread_id, parent_session_id, model_config, title/title_source, started/ended_at, end_reason, cwd, git_branch, handoff_state, archived, pinned, rewind_count, …), `messages` (id, session_id, role, content, tool_calls, timestamp, active, compacted, reasoning_*, …), `session_model_usage`, `state_meta`, `gateway_routing`, `compression_locks`, `async_delegations`; FTS5 `messages_fts` + trigram `messages_fts_trigram` (CJK).
- **Gateway side**: `gateway/session.py` — `SessionSource` (origin identity), `SessionEntry` (persisted routing entry, `to_dict`/`from_dict`), `build_session_context_prompt`; `gateway/slash_commands.py` — `GatewaySlashCommandsMixin` with `_handle_reset_command`, `_handle_stop_command`, resume/permission checks (`_resume_caller_is_admin`, `_resume_target_allowed`, `_resume_row_visible`); `gateway/run.py` — Guard-2 busy dispatcher (`_dispatch_busy_slash_command`) implementing `interrupt_then_dispatch` for `/new`/`/reset`/`/stop` and busy `dispatch` for `/queue` (FIFO enqueue) / `/steer` (inject after next tool call).
- **Sessions CLI tool** (`hermes_cli/sessions_cmd.py`, `hermes sessions`): list/export (md/html/jsonl/trace)/archive/delete/prune/recover/repair — the backing surface for `/sessions` and `/save`.
- **REST surface consumed by Desktop** (`gateway/platforms/api_server.py`): `GET/POST /api/sessions`, `GET/PATCH/DELETE /api/sessions/{id}`, `GET .../messages`, `POST .../fork`, `POST .../chat[/stream]`, plus search/archive endpoints consumed by `web/src/hooks/use-sessions.ts`.

Command → implementation map (used to define parity tests):

| Command | Python handler | State mutation / effect |
|---|---|---|
| `/new`, `/reset [name] [now]` | `cli.py` / `gateway/slash_commands.py._handle_reset_command` | `end_session(old)` → `create_session(fresh_id, title=name)` → rotate active; `interrupt_then_dispatch` busy policy |
| `/clear` | `cli.py:12036` | CLI-only: clear screen + start new session |
| `/history` | `cli.py` | CLI-only: print transcript (respects `/timestamps`) |
| `/save` | `cli.py` / `hermes_cli/sessions_cmd.py` export | Export current conversation (md/html/jsonl) |
| `/resume [target]` | `cli_commands_mixin._handle_resume_command` | Resolve number/title/id → `resolve_resume_session_id` tip → `end_session(resumed_other)` → reopen target → reload `get_resume_conversations` |
| `/sessions`, `/switch` | `_handle_sessions_command`; `hermes_cli/sessions_cmd.py` | List picker; `/sessions <target>` delegates to resume; TUI `/sessions new` starts live session |
| `/title [name]` | `SessionDB.set_session_title` | `sanitize_title` + provenance `user` write; shows current when no arg |
| `/branch`, `/fork [name]` | `_handle_branch_command` | `end_session(branched)` → `create_session(parent=..., _branched_from)` → `append_messages_batch` copy → switch |
| `/retry` | `cli.py` | Resend last user message (rewind + prefill) |
| `/undo [N]` | `cli.py:10426`, `SessionDB.rewind_to_message` | Soft-delete `active=0` from target user msg forward; `rewind_count++`; prefill target |
| `/stop` | `_handle_stop_command` | `process_registry.kill_all()` + `async_delegation.interrupt_all()` |
| `/queue <prompt>` | `gateway/run.py` busy_handler `queue` | FIFO enqueue while agent busy; `busy_policy=dispatch` |
| `/steer <prompt>` | `gateway/run.py` busy_handler `steer` | Inject after next tool call, no interrupt |
| `/background <prompt>` | `_handle_background_command`, `run_background` | Detached background session; result panel |
| `/handoff <platform>` | `_handle_handoff_command` | CLI-only: re-bind session to messaging platform (out of scope for desktop) |

Data flow (CLI): user types `/title Foo` → REPL parses → `_handle_*_command` → `SessionDB` write → in-memory `conversation_history` re-targeted. (Gateway): platform message → `gateway/run.py` command dispatch → `GatewaySlashCommandsMixin` handler → `SessionDB`/agent. (Desktop today): React hook → REST `/api/sessions*` (list/detail/messages/archive) or WS RPC `session.*`/`command.dispatch` → Python gateway.

## 3. Target TypeScript design

Module layout (all under `D:/Hermes-CN-Desktop/web/src` unless noted):

- `lib/session-store/` — in-process replacement for `SessionDB`:
  - `types.ts` — `SessionRow`, `MessageRow`, `SessionSummary`, `SessionDetail`, `TitleSource`, `CreateSessionOptions`, `ForkOptions`, `RewindResult` (mirror `SessionSummary`/`SessionDetail` already in `@hermes/protocol`).
  - `session-store.ts` — `class SessionStore` implementing the same public surface as Python `SessionDB` methods used by lifecycle commands: `create`, `get`, `list` (rich list + pagination + archived/include), `resolveSessionId` (exact/prefix), `resolveResumeSessionId` (compression-tip lineage walk), `setTitle`/`setAutoTitle`/`sanitizeTitle`, `rewindToMessage`/`restoreRewound`, `clearMessages`, `fork` (copy messages via batch insert, `_branched_from` marker), `archive`, `delete`, `search`.
  - `sql.ts` — raw SQL layer; delegates to Rust `session_db` Tauri commands (`db_exec(sql, params)`, `db_query(sql, params)`, `db_transaction(fn)`) during migration, swappable to a pure in-memory/temp-file impl for tests.
- `lib/slash-commands/` — in-process command engine:
  - `registry.ts` — port of `COMMAND_REGISTRY`: `CommandDef` (name/aliases/category/argsHint/busyPolicy/busyHandler/cliOnly) + `resolveCommand`.
  - `runner.ts` — `class SlashCommandRunner` with `dispatch(command, args, ctx)`, `dispatchBusy(command, args, ctx)` implementing busy policies (dispatch / reject / interrupt-then-dispatch → `agent.cancel()` then dispatch). This replaces WS `command.dispatch`.
  - `handlers/` — one module per command group: `lifecycle.ts` (`new/reset/clear/history/save/resume/sessions/switch/title`), `edit.ts` (`retry/undo/branch/fork`), `run-control.ts` (`stop/queue/steer/background`), `handoff.ts` (stub returning "out of scope").

Sketch of the key interfaces (signatures only — no implementation):

```ts
// lib/session-store/session-store.ts
export interface SessionStore {
  create(opts: { source: string; title?: string; parentSessionId?: string;
                 modelConfig?: Record<string, unknown>; cwd?: string }): Promise<SessionSummary>;
  get(id: string): Promise<SessionDetail | null>;
  list(opts: { limit: number; offset: number; includeArchived?: boolean;
               orderByLastActive?: boolean }): Promise<SessionsResponse>;
  resolveSessionId(input: string): Promise<string | undefined>; // exact or unique prefix
  resolveResumeSessionId(id: string): Promise<string>;           // compression-tip walk
  setTitle(id: string, title: string): Promise<boolean>;          // user provenance, sanitize
  setAutoTitle(id: string, title: string, source: TitleSource): Promise<boolean>;
  rewindToMessage(id: string, targetMessageId: number): Promise<RewindResult>;
  restoreRewound(id: string, sinceMessageId: number): Promise<number>;
  fork(parentId: string, opts: { title?: string; name?: string }): Promise<SessionSummary>;
  archive(id: string, archived: boolean): Promise<boolean>;       // compression-chain aware
  delete(id: string): Promise<void>;
  search(q: string, limit?: number): Promise<SearchResult[]>;
}

// lib/slash-commands/runner.ts
export interface CommandContext {
  store: SessionStore;
  runtime: ChatRuntimeController;      // cancel / steer / queue / background
  activity: SessionActivity;           // isBusy, activeSessionId
  notify: (msg: string) => void;       // surface-agnostic status output
}
export class SlashCommandRunner {
  dispatch(name: string, args: string, ctx: CommandContext): Promise<CommandResult>;
  dispatchBusy(name: string, args: string, ctx: CommandContext): Promise<CommandResult>;
  complete(input: string): string[];   // registry-driven autocomplete
}
```
- `lib/session-activity.ts` (exists) + new `lib/agent-control.ts` — typed wrappers for `stop` (kill background tasks), `queue` (FIFO prompt queue), `steer` (inject after next tool call), `background` (fork into a detached background session), mapping to the in-process agent loop's `cancel()`, `steer()`, `startBtw()` equivalents (see §5).
- `stores/` (Jotai, exists) — add `activeSessionIdAtom` rotation semantics for `/new`/`/reset`/`/resume`; add `queuedPromptsAtom` (FIFO) and `steerPendingAtom` for busy-mode commands.
- Rust: `src/commands/session_db.rs` — thin Tauri commands wrapping `rusqlite` (schema/migrations ported from `hermes_state_common.py`), kept behind the same `session_db` IPC interface so TS owns business logic.

Data flow (target): composer → `SlashCommandRunner.dispatch` → `SessionStore` mutation + `ChatRuntime`/agent loop in-process → Jotai atoms + React Query cache update. No REST/WS round trip.

## 4. Data models & persistence

- Port the Python schema verbatim where possible (`hermes_state_common.py` SCHEMA_SQL, `SCHEMA_VERSION=25`): `sessions`, `messages`, `session_model_usage`, `state_meta`, `gateway_routing`, `compression_locks`, `async_delegations`, FTS5 tables. Migration goal: the desktop can open an existing Core `state.db` without a data migration — same table names/columns; add a `schema_version` row check and re-run `_reconcile_columns`-style ALTERs.
- `messages` carries the full transcript shape the Desktop detail view already consumes: `role`, `content`, `tool_calls`, `tool_call_id`, `tool_name`, `effect_disposition`, `timestamp` (REAL, insertion order by `id` — never `timestamp`), `token_count`, `finish_reason`, `reasoning*`, `platform_message_id`, `observed`, `active` (undo/rewind flag), `compacted`, `api_content`, `display_kind`/`display_metadata`. `get_messages_as_conversation`'s `repair_alternation` mode (used for live replay after `/resume`) must be ported so a durable `user;user` violation does not re-trigger repair on every turn.
- FTS: `messages_fts` (external-content fts5, tool columns excluded from trigram view `messages_fts_trigram_src`) powers `/sessions search`; port the `state_meta` keys `fts_storage_version`, `fts_rebuild_high_water`/`progress`, `fts_cjk_stale` so a pre-existing DB keeps working. Desktop v1 may skip the background rebuild path and rely on inline triggers (layout 0) — record as a known parity gap.
- Key invariants to port exactly (parity critical):
  - Title provenance: `title_source` ranks `derived(0) < llm(1) < user(2)`; `sanitize_title` (strip ASCII/Unicode control chars, collapse whitespace, `MAX_TITLE_LENGTH=100`); `set_session_title` raises on duplicate/too-long.
  - Branching: `parent_session_id` + `model_config._branched_from` marker; `_BRANCH_CHILD_SQL` / `_LISTABLE_CHILD_SQL` so branches stay visible in lists while subagent/compression children stay hidden.
  - Undo: soft-delete `active=0` with `rewind_to_message` (target user message becomes the prefill; `rewind_count` increments; `restore_rewound` for undo-of-undo).
  - Resume: `resolve_resume_session_id` compression-chain walk (skip branch/delegate/tool children, cap 32) + `get_compression_tip`.
  - Recency: `_sql_session_last_active` freshest-of (`last_activity_at`, `MAX(messages.timestamp)`, `started_at`).
- Storage strategy: SQLite file via Rust (`rusqlite`) in production; IndexedDB or in-memory SQLite for web-dev mode is a stretch goal. Session id generation must match Python's `YYYYmmdd_HHMMSS_<hex6>` scheme so ids remain stable across the migration.
- Schema migrations: single `state_meta`-keyed version bump; port `repair_state_db_schema`/`recover` as Rust-side maintenance commands (out of desktop scope v1, keep as `hermes sessions` parity note).

## 5. Third-party library strategy

| Python dependency | Role in feature | TS equivalent | Evidence |
|---|---|---|---|
| `sqlite3` (stdlib) + FTS5 | `SessionDB` persistence, `/sessions` search, compression chains | Rust `rusqlite` behind Tauri IPC (README explicitly keeps "SQLite if needed" in Rust); TS `SessionStore` facade | No kimi-code SQLite evidence — kimi-code stores sessions as **filesystem dirs + JSONL index** (`packages/agent-core/src/session/store/session-store.ts`, `session-index.ts`: `session_index.jsonl`, per-session `state.json`). SQLite FTS/trigram must be implemented from scratch in Rust (note FTS5 trigram requires build flag). |
| kimi-code `SessionStore` (TS, not Python) | Reference for create/fork/rename/list summaries | Direct inspiration: `SessionStore.create/fork/rename/get`, `fork()` copies source dir + truncate-at-turn, `session-index.jsonl` append-only with tombstones | `packages/agent-core/src/session/store/session-store.ts`, `session-index.ts` |
| `prompt_toolkit` | CLI autocomplete for slash commands | Existing React autocomplete/mention UI; registry `resolveCommand` drives suggestions | Not needed in desktop; keep registry-only parity |
| `rich` | CLI table/panel rendering for `/sessions`, `/history` | Existing `packages/shared-ui` table/list components | Not core logic |
| Python `re` title sanitization | `sanitize_title` | Port regexes to JS `RegExp` (control-char/zero-width classes) | kimi-code `renameSession` only trims + empty check (`packages/agent-core/src/session/rpc.ts:56`) — sanitizer parity must come from Core |
| Python `datetime`/`uuid` | session id minting | `crypto.randomUUID`-style hex + timestamp format matching Python | kimi-code `assertSafeSessionId` + id scheme differs; must keep Python format |
| Python agent loop | `/stop /queue /steer /background` | kimi-code agent RPCs: `cancel`, `steer` (SteerPayload), `undoHistory`, `stopBackground`, `clearContext`, `startBtw` | `packages/agent-core/src/session/rpc.ts` (lines 135–262); `session/index.ts` print-mode drain/steer |
| `process_registry` / `async_delegation` | `/stop` kills background processes | kimi-code `listBackgroundTasks` + `stopBackground`/`detachBackground` (`tui/controllers/tasks-browser.ts`, `rpc.ts`) | Same TS-side concept exists; port to desktop's in-process task registry |
| Input/history recall | `/history` display | kimi-code `utils/history/input-history.ts` is **input recall** (JSONL), not transcript history — desktop `/history` = existing message view, no lib needed | `apps/kimi-code/src/utils/history/input-history.ts` |
| Session switching UI | `/sessions`, `/switch` | kimi-code `kimi-tui.ts` `resumeSession()` + `listSessionsPage()`; `tui/commands/session.ts` `handleTitleCommand`/`handleForkCommand` | `apps/kimi-code/src/tui/kimi-tui.ts:2547`, `apps/kimi-code/src/tui/commands/session.ts` |
| `/save`, `/handoff` | export current conversation; hand off to messaging | Export: kimi-code `handleExportMdCommand` (`tui/commands/session.ts:127`); handoff: **no TS equivalent** — messaging-platform adapter, out of scope for standalone desktop | kimi-code has no messaging handoff |

**No TS equivalent found (risks)**: (1) SQLite-backed session store with FTS5 trigram CJK search — kimi-code uses JSONL + no full-text search; needs Rust `rusqlite` + FTS5 trigram compile flag. (2) Messaging handoff (`/handoff`) — no TS equivalent anywhere in kimi-code; desktop standalone has no messaging adapters. (3) Compression-lineage resume logic — kimi-code has compaction but no `resolve_resume_session_id`-style parent-chain walk; must port from Core SQL.

## 6. Integration with existing Hermes-CN-Desktop frontend

- **Reuse (unchanged hooks, retarget data source)**:
  - `web/src/hooks/use-sessions.ts` — list/detail/messages/search/delete/archive hooks; swap `fetchJSON` for `SessionStore` calls behind the same return shapes (`SessionsResponse`, `SessionDetail`, `MessagesResponse`).
  - `web/src/hooks/use-session-resolution.ts` + `web/src/lib/session-map.ts` — keep during migration for gateway↔persistent id mapping; after WS removal collapse to a single persistent id (no map needed).
  - `web/src/hooks/use-session-branch.ts` + `web/src/lib/session-branch.ts` — keep the optimistic-branch UX; retarget `createBranchSession` (WS `session.branch`) to `SessionStore.fork()`.
  - `web/src/hooks/use-create-and-send-session.ts` — `/new`-style create+send flow; retarget `createSession` (WS `session.create`) to `SessionStore.create()`.
  - `web/src/lib/session-rename.ts` — `/title` logic (live gateway → resume-and-retry → local override); retarget `setSessionTitle` (WS `session.title`) to `SessionStore.setTitle()`; keep `rememberSessionTitleOverride`.
- **Replace**: `web/src/lib/gateway-client.ts` WS RPC calls (`session.resume`, `session.title`, `session.branch`, `command.dispatch` in `web/src/hooks/use-gateway.ts`) with local `SlashCommandRunner` + `SessionStore`.
- **UI**: `web/src/routes/history.tsx` becomes the `/sessions` surface (already has rename, archive, delete, branch, search); `web/src/routes/detail.tsx` gains lifecycle actions (undo/retry/stop/queue/steer/background) in the composer/menu; add a `/history` transcript panel and `/save` export (reuse `lib/session-export.ts`).
- **Rust**: add `src/commands/session_db.rs` alongside existing 60 Tauri commands; wire into `src/state.rs` for the per-profile DB path (mirror `DEFAULT_DB_PATH` resolution in `hermes_state.py`).

## 7. Removing the WebSocket dependency (migration path)

1. **Freeze the API surface** (must keep byte-compatible during migration): REST `/api/sessions*` (list/get/messages/fork/archive/delete/search) and WS RPC `session.create`, `session.resume`, `session.title`, `session.branch`, `command.dispatch`.
2. **Phase A (behind same interface)**: implement `SessionStore` + `SlashCommandRunner` in TS; route Desktop UI through them but keep the Python gateway as an optional sync source (read-only REST revalidation) for one release — detect skew via `schema_version`/`last_activity_at`.
3. **Phase B (dual-write compare)**: run parity checks in dev — same command against `SessionStore` and Python `SessionDB` fixtures, diff results (see §10). Ship with a feature flag `sessionStoreInProcess`; default off, then on for canary.
4. **Phase C (delete WS/REST path)**: remove `gateway-client.ts` session RPCs and `use-gateway` resume/reattach logic; delete the `session_db` Rust IPC fallback to Python only if no external client needs it. Keep the in-process `SessionStore` as the single writer.
5. **Watch items**: reconnect/resume semantics (`gateway-reconnect.ts`, `use-gateway.ts` reattach path) become obsolete once the agent is in-process — the runtime bucket (`chatRuntimeBySessionAtom`) is the new "live" source; ensure detail.tsx's compression-tip follow (issue #305) still works via `resolveResumeSessionId`. Also remove the `session-map.ts` gateway↔persistent id indirection once a single persistent id is used everywhere.

## 8. Migration phases & task breakdown

- **M1 — Store + schema**: port `hermes_state_common.py` schema to Rust `session_db.rs` (rusqlite, migrations, FTS5); TS `SessionStore` CRUD (create/get/list/resolve/archive/delete) with unit tests. Parity vs `SessionDB` fixtures. **Done when** `list`/`get`/`resolveSessionId` match Python on shared fixtures.
- **M2 — Lifecycle commands**: `registry.ts` + `runner.ts`; handlers `new/reset`, `clear`, `history`, `save`, `resume`, `sessions/switch` (with `resolveResumeSessionId` port + compression-tip redirect), `title` (sanitize + provenance + rename-retry). Wire history.tsx/detail.tsx UI. **Done when** Playwright covers `/new`, `/title`, `/resume`, `/sessions`.
- **M3 — Edit commands**: `branch/fork` (batch message copy, `_branched_from`, lineage title numbering), `retry` (rewind + resend last user turn), `undo` (rewind N, prefill). Reuse `use-session-branch.ts`. **Done when** branch/undo parity tests ported from `test_branch_command.py` / `test_undo_rewind_session.py`.
- **M4 — Run-control commands**: `stop` (kill in-process background tasks), `queue` (FIFO atom + busy dispatch), `steer` (pending steer atom), `background` (detached background session; port `run_background` semantics). **Done when** busy-mode dispatch tests (queue FIFO, steer-after-tool, stop kills background) pass.
- **M5 — Handoff decision + WS removal**: write `/handoff` as out-of-scope stub (justification: messaging-platform adapter, no platform adapters in standalone desktop); delete WS session RPC path; remove `session-map.ts` if single-id model lands. **Done when** `gateway-client.ts` has no session.* RPCs and no REST `/api/sessions` caller remains in `web/src`.
- **M6 — Maintenance parity** (optional): `hermes sessions`-style repair/recover/export CLI parity via Rust commands. **Done when** `hermes sessions list/export` equivalents exist behind Tauri commands.

Per-milestone acceptance checklist: (1) new TS unit tests ported from the named Python tests; (2) existing Desktop vitest suite still green; (3) no WS/REST session call in the changed code path; (4) session id/title/cwd behavior matches Core on the same fixture.

## 9. Risks & open questions

- **Compression-lineage parity**: `resolve_resume_session_id`/`get_compression_tip` and chain-aware archiving are the subtlest SQL; porting must include the branch/delegate/tool exclusion and the 32-depth cap. Verify with `tests/hermes_state/test_resolve_resume_session_id.py` + `test_session_archiving.py` equivalents.
- **FTS5 trigram (CJK)**: rusqlite bundles may not enable trigram tokenizer; `/sessions search` parity for CJK may need a LIKE fallback (Python already routes CJK tool-role queries to LIKE — same strategy).
- **Concurrent writers**: today gateway + desktop may both write `state.db`; after moving in-process there is one writer, but keep WAL + busy timeout semantics from `SessionDB._execute_write` retry logic.
- **Session id scheme**: must match Python `YYYYmmdd_HHMMSS_hex6` for `/resume` compat and `session-map` continuity.
- **`/clear` and `/save` are `cli_only` in Core**: define desktop equivalents (clear view + new session; export to Markdown/HTML via existing `lib/session-export.ts`) and record the mapping.
- **`/handoff`**: no TS equivalent; out of scope for standalone desktop (needs messaging adapters + gateway). Marked in plan per README convention.
- **Busy-policy drift**: Core distinguishes `reject` vs `dispatch` vs `interrupt_then_dispatch` per command; the desktop in-process runner must honor the same table or `/queue`/`/steer` mid-turn behavior diverges from docs.
- **Open question**: keep `state.db` file format forever, or migrate to kimi-code-style JSONL dirs once WS is gone? Recommendation: keep SQLite (search, lineage, existing user data); JSONL only if Rust SQLite becomes a maintenance burden.
- **Open question**: should `/history`/`/save` stay command-driven, or become native UI (transcript panel / export menu)? Recommend UI-first with command aliases for parity.
- **Open question**: `/stop` parity — Core stops background processes and async delegations; the desktop agent loop has no OS-process registry yet, so v1 `stop` cancels in-process background turns and records the gap for process-registry-backed tools.

## 10. Test strategy

- **Vitest unit (TS SessionStore)**: port parity tests from `D:/hermes-agent-cn/tests/hermes_state/` — `test_append_messages_batch.py` (atomic batch insert + counters), `test_get_anchored_view.py` (window/bookends for search), `test_session_archiving.py` (compression-chain archive/unarchive), `test_resolve_resume_session_id.py` (lineage walk, middle-of-chain, skip branch children), `test_session_read_state.py`, `test_session_md_export.py`.
- **Vitest unit (commands)**: `tests/cli/test_branch_command.py` parity (new session + copy + `_branched_from` + lineage title + reasoning fields survive), `tests/cli/test_cli_new_session.py` (fresh session rotation, confirmation `now/--yes`), `test_cli_resume_command.py` / `test_resume_latest_and_in_dir.py` (id/title/number resolution, compression redirect), `tests/hermes_cli/test_session_listing.py`, `test_session_filters.py`, `test_sessions_delete.py`.
- **Agent-control tests**: FIFO queue order, steer injection after tool call, stop cancels background tasks, background session isolation — model on `tests/gateway/test_session*.py` intent (busy-session dispatch, undo/rewind in `test_undo_rewind_session.py`).
- **Rust integration**: rusqlite round-trip, schema migration to v25, FTS5 query smoke; Tauri command tests for `session_db`.
- **Playwright E2E**: `/new` → fresh session; `/title` rename persists + survives reload; `/sessions` list + resume; `/branch` navigates to fork with copied transcript; `/undo` removes last exchange and restores on retry; `/stop` while busy; `/queue`/`/steer` while busy; `/background` shows detached result panel.
- **Parity harness**: shared JSON fixture of session/message graphs → run against Python `SessionDB` and TS `SessionStore`, diff `list/resolveResumeSessionId/rewind/fork` outputs (Phase B dual-write compare).

## 11. Reference links

- Core Python: `D:/hermes-agent-cn/hermes_state.py`, `hermes_state_common.py`, `hermes_cli/commands.py`, `hermes_cli/cli_commands_mixin.py`, `hermes_cli/sessions_cmd.py`, `cli.py`, `gateway/session.py`, `gateway/slash_commands.py`, `gateway/run.py`, `gateway/platforms/api_server.py`.
- Core docs: `website/docs/reference/slash-commands.md`, `website/docs/user-guide/messaging/index.md`.
- Core tests: `tests/hermes_state/` (13 files), `tests/gateway/test_session*.py` (~25), `tests/hermes_cli/test_session_*.py`, `tests/cli/test_cli_new_session.py`, `test_cli_resume_command.py`, `test_branch_command.py`, `test_resume_latest_and_in_dir.py`.
- kimi-code TS: `packages/agent-core/src/session/index.ts`, `store/session-store.ts`, `store/session-index.ts`, `rpc.ts`, `hooks/`, `export/`; `apps/kimi-code/src/tui/commands/session.ts`, `tui/kimi-tui.ts` (resumeSession/listSessionsPage), `cli/prompt-session.ts`, `utils/history/input-history.ts`, `tui/controllers/session-replay.ts`.
- Desktop: `web/src/hooks/use-sessions.ts`, `use-session-resolution.ts`, `use-session-branch.ts`, `use-create-and-send-session.ts`, `use-gateway.ts`, `lib/gateway-client.ts`, `lib/session-map.ts`, `lib/session-rename.ts`, `lib/session-branch.ts`, `routes/history.tsx`, `routes/detail.tsx`.
