# Codex App-Server Runtime — Python → TypeScript Rewrite Plan

## 1. Summary

Feature: an **opt-in runtime** that hands `openai/*` (and `openai-codex/*`) turns to the
**Codex CLI app-server** instead of Hermes' own tool loop. When active, Codex owns the
turn: its built-in `shell`, `apply_patch`, `update_plan`, `view_image`, `web_search` run
inside Codex's sandbox; native Codex plugins (Linear, GitHub, Gmail, Calendar, Canva…)
are auto-migrated; Hermes' richer tools (web_search, web_extract, browser_*,
vision_analyze, image_generate, skill_view, skills_list, text_to_speech, kanban_*) are
reachable through a `hermes-tools` MCP callback; `/codex-runtime` toggles
`model.openai_runtime` between `auto` (Hermes default) and `codex_app_server`.

In Python today this is a sizable stack: a JSON-RPC-over-stdio subprocess client
(`agent/transports/codex_app_server.py`), a per-session adapter
(`codex_app_server_session.py`), an event projector (`codex_event_projector.py`), an
agent-loop early-return (`agent/codex_runtime.py`), a `~/.codex/config.toml` migration
(`hermes_cli/codex_runtime_plugin_migration.py`), the `/codex-runtime` toggle
(`hermes_cli/codex_runtime_switch.py`), and Codex model discovery
(`hermes_cli/codex_models.py`). The Desktop app only reaches it today through the managed
Python runtime (WS `/api/ws` + REST).

Target: a pure-TypeScript in-process implementation plus a **Rust sidecar that owns the
`codex app-server` child process**. Rust keeps the OS-level job (spawn with hidden console
on Windows, stdio pipes, JSON-RPC framing, process lifecycle) and is invoked via Tauri IPC;
`web/src/lib/codex-runtime/*` hosts the session adapter, event bridge, projector, usage
accounting, toggle, config migration, model discovery, and the `hermes-tools` MCP callback
server (Node stdio MCP server on `@modelcontextprotocol/sdk`). This removes the WS link
for this feature and keeps the same turn-result / tool-progress surface the current
Python runtime exposes.

Key decisions:
- **Codex child process lives in Rust** (`src/codex_app_server.rs`), because the Tauri
  webview cannot spawn/keep a long-lived child; port `CodexAppServerClient` 1:1
  (ndjson JSON-RPC 2.0 over stdio, reader threads, pending-request map, server-initiated
  approval requests).
- **All protocol/semantic logic moves to TS**: session adapter, event bridge, projector,
  usage accounting, toggle, migration, model discovery — so later features can consume
  the same modules in-process and the WS link dies.
- **`hermes-tools` MCP callback is a Node stdio MCP server** (from-scratch; kimi-code has
  no MCP *server* precedent, only MCP *clients* on `@modelcontextprotocol/sdk` ^1.29.0).
  It dispatches to the same TS tool implementations the default runtime uses.
- **No TS equivalent exists in kimi-code for the app-server protocol itself** — verified
  by search (see §5). Everything wire-level is a faithful port of the Python transport.

## 2. Current Python implementation

All paths under `D:/hermes-agent-cn`:

- **Wire client**: `agent/transports/codex_app_server.py` (417 lines) —
  `CodexAppServerClient`: newline-delimited JSON-RPC 2.0 over stdio; spawns
  `codex app-server` (hidden console on Windows via
  `hermes_cli/_subprocess_compat.windows_hide_flags`), `initialize`/`initialized`
  handshake, `request()`/`notify()`/`respond()`/`respond_error()`, two reader threads
  (stdout dispatch → pending replies / server requests / notifications; stderr tail),
  `take_notification()`/`take_server_request()` bounded queues, `close()` escalate-to-kill,
  `parse_codex_version()`, `check_codex_binary()` (min `MIN_CODEX_VERSION = (0,125,0)`),
  env via `tools.environments.local.hermes_subprocess_env(inherit_credentials=True)`
  (strips Tier-1 secrets, keeps provider creds), Kanban sandbox overrides
  (`sandbox_mode="workspace-write"`, extra writable roots) when `HERMES_KANBAN_TASK`.
- **Session adapter**: `agent/transports/codex_app_server_session.py` (1292 lines) —
  `CodexAppServerSession` (one Codex thread per Hermes session; `ensure_started()`,
  `run_turn(user_input)` synchronous loop, `close()`), `TurnResult` (`final_text`,
  `projected_messages`, `tool_iterations`, `interrupted`, `error`, `turn_id`,
  `thread_id`, `token_usage_last/total`, `model_context_window`, `compacted`,
  `should_retire`), `_ServerRequestRouting` (`auto_approve_exec`,
  `auto_approve_apply_patch`), approval callback bridging to
  `tools.approval.prompt_dangerous_approval()`, `_coerce_turn_input_text()` (image
  attachment → `[image attached]` marker), OAuth-failure classification
  (`_classify_oauth_failure`), `_notification_belongs_to_turn()` (multiplexed
  parent/subagent thread scoping), permission profile map
  `_HERMES_TO_CODEX_PERMISSION_PROFILE` (`auto→workspace-write`,
  `approval-required→read-only-with-approval`, `unrestricted→full-access`).
- **Event projector**: `agent/transports/codex_event_projector.py` (314 lines) —
  `CodexEventProjector.project(notification)` materializes standard
  `{role, content, tool_calls, tool_call_id}` messages from `item/completed`;
  `_deterministic_call_id()` gives stable tool_call ids (TUI/desktop tool cards survive
  resume); covers `commandExecution`, `fileChange`, `mcpToolCall`, `dynamicToolCall`,
  `agentMessage`, `userMessage`.
- **Agent-loop early return**: `agent/codex_runtime.py` (1569 lines) —
  `run_codex_app_server_turn(agent, ...)` (called from `run_conversation()` when
  `api_mode == "codex_app_server"`), `make_codex_app_server_event_bridge(agent)`
  (translates `item/started`+`item/completed` → `tool_progress_callback`,
  `item/agentMessage/delta` → `_fire_stream_delta`, `item/reasoning/*` → reasoning
  delta), `_record_codex_app_server_usage()` (thread/tokenUsage/updated →
  CanonicalUsage; cache-write stays 0), `_record_codex_app_server_compaction()`
  (records boundary without rewriting transcript rows), memory/skill nudge counters,
  `run_codex_stream()` (the separate `codex_responses` SSE path used as fallback and by
  the review fork — the fork is downgraded from `codex_app_server` to
  `codex_responses`).
- **Toggle**: `hermes_cli/codex_runtime_switch.py` (279 lines) — `parse_args`,
  `get_current_runtime`, `set_runtime`, `check_codex_binary_ok`, `apply()`; VALID_RUNTIMES
  `("auto", "codex_app_server")`; enable path verifies binary first, persists config,
  runs migration (idempotent re-apply), sets `requires_new_session`.
- **Migration**: `hermes_cli/codex_runtime_plugin_migration.py` (769 lines) —
  `migrate(config)` → `MigrationReport`; writes a `# managed by hermes-agent` /
  `# end hermes-agent managed section` block into `~/.codex/config.toml`: translated
  Hermes `mcp_servers` (stdio/streamable_http, timeouts), `[mcp_servers.hermes-tools]`
  (the callback server), native Codex plugins discovered via `plugin/list` RPC
  (`[plugins."<name>@openai-curated"]`), `default_permissions = ":workspace"`.
- **Models**: `hermes_cli/codex_models.py` (255 lines) — `get_codex_model_ids()`:
  live `https://chatgpt.com/backend-api/codex/models` (needs `ChatGPT-Account-Id` JWT
  claim), then `~/.codex/config.toml` default, `models_cache.json`, curated
  `DEFAULT_CODEX_MODELS` + forward-compat templates.
- **Runtime resolution**: `hermes_cli/runtime_provider.py`
  `_maybe_apply_codex_app_server_runtime()` (line ~419) maps
  `model.openai_runtime: codex_app_server` → `api_mode = "codex_app_server"` when the
  provider is OpenAI/Codex-scoped.
- **MCP callback**: `agent/transports/hermes_tools_mcp_server.py` (285 lines) — stdio MCP
  server exposing the curated Hermes tool list (NOT `delegate_task`, `memory`,
  `session_search`, `todo`; NOT terminal/file tools — Codex has those).
- **Docs**: `website/docs/user-guide/features/codex-app-server-runtime.md` (460 lines) —
  tool matrix, trade-offs, approvals, permission profiles, config.toml safety, MCP
  migration table, plugin migration, architecture diagram.
- **Tests** (parity source): `tests/cron/test_codex_execution_paths.py` (cron + gateway
  run through `codex_responses`, 401-refresh recovery), `tests/hermes_cli/test_codex_runtime_switch.py`
  (toggle state machine incl. re-apply-runs-migration), `tests/hermes_cli/test_codex_models.py`
  (keep `supported_in_api:false` models, model-picker flow, provider normalization),
  `tests/cli/test_cli_codex_context_reference.py` (provider-aware `@file:` sizing),
  plus `tests/agent/transports/test_codex_app_server_runtime.py`,
  `test_codex_app_server_session.py`, `test_codex_event_projector.py`,
  `tests/agent/test_codex_app_server_event_bridge.py`, `tests/run_agent/test_codex_app_server_*`.

Data flow (Python): `AIAgent.run_conversation()` → early return when
`api_mode == "codex_app_server"` → `agent._codex_session.run_turn(user_input)` →
`CodexAppServerClient` JSON-RPC `initialize` / `thread/start` / `turn/start` →
streaming `item/*` notifications → `CodexEventProjector` + event bridge → `TurnResult`
→ projected messages appended to `messages` + session DB flush → usage/compaction
accounting → dict shaped like the default runtime's return.

## 3. Target TypeScript design

Rust sidecar (`D:/Hermes-CN-Desktop/src/`):

- `codex_app_server.rs` — port of `CodexAppServerClient`: spawn `codex app-server`
  (reuse `crate::coding_agents` binary detection + `path_resolver` for PATH refresh;
  Windows `CREATE_NO_WINDOW` parity for `windows_hide_flags`), ndjson JSON-RPC 2.0
  framing, pending-request map, stdout reader thread → channel, stderr ring buffer,
  `request`/`notify`/`respond`/`respond_error`, `initialize`/`initialized` handshake,
  `turn/interrupt`, `close` escalate-to-kill, `parse_codex_version`/`check_codex_binary`
  (reuse existing `probe_commands` from `src/environment.rs`).
- `commands/codex_app_server.rs` — Tauri commands: `codex_app_server_check()`,
  `codex_app_server_start(cwd, codexHome, sandboxOverrides)`,
  `codex_app_server_run_turn(input, requestId)`, `codex_app_server_interrupt()`,
  `codex_app_server_close()`, `codex_app_server_respond(requestId, result|error)`,
  `codex_plugin_list()` (native plugin discovery RPC), `codex_apply_config_toml(patch)`
  (managed-block write).
- `migration.rs` (or fold into `codex_app_server.rs`) — `~/.codex/config.toml`
  managed-block renderer: TOML escape, marker comments, `[mcp_servers.<n>]`,
  `[plugins."<name>@openai-curated"]`, `default_permissions`.

Web TS modules (`D:/Hermes-CN-Desktop/web/src/lib/codex-runtime/`):

- `types.ts` — `CodexRuntime` (`"auto" | "codex_app_server"`), `CodexTurnResult`
  (mirrors `TurnResult`), `CodexTurnRequest`, `CodexItemEvent`, `CodexUsage`,
  `MigrationReport`, `CodexPluginInfo`, `CodexModelInfo`.
- `client.ts` — Tauri IPC facade: `start()`, `runTurn()`, `interrupt()`, `close()`,
  `respondApproval()`, `checkBinary()`, `listPlugins()`, `applyConfigToml()`; maps Rust
  JSON-RPC messages into TS event stream (single subscription per session).
- `session.ts` — port of `CodexAppServerSession`: one session per Hermes conversation,
  `runTurn(userInput)` synchronous-ish loop over IPC, approval routing
  (`autoApprove` from settings, otherwise prompt via existing approval UI), OAuth-failure
  classification, `should_retire` handling, thread/turn scoping
  (`notificationBelongsToTurn`).
- `projector.ts` — port of `CodexEventProjector` + `_deterministic_call_id`; emits
  standard assistant `tool_calls` + `tool` result messages.
- `event-bridge.ts` — port of `make_codex_app_server_event_bridge`: `item/started` /
  `item/completed` (tool-shaped) → `tool.started` / `tool.completed` events;
  `item/agentMessage/delta` + `item/reasoning/*` → stream deltas; `agentMessage`
  completed → interim assistant message.
- `usage.ts` — port of `_record_codex_app_server_usage` + `_record_codex_app_server_compaction`
  (CanonicalUsage mapping, cache-write 0, cost estimate, compaction boundary events).
- `toggle.ts` — port of `codex_runtime_switch`: `parseArgs`, `getCurrentRuntime`,
  `setRuntime`, `apply()`; persists `model.openai_runtime` into the Hermes config store
  (Jotai + Rust config commands); returns the same `CodexRuntimeStatus` shape.
- `migration.ts` — port of `codex_runtime_plugin_migration.migrate`: Hermes `mcp_servers`
  → Codex TOML section (stdio / streamable_http / timeouts / enabled), plugin discovery
  via `codex_plugin_list`, `default_permissions = ":workspace"`, `hermes-tools` server
  entry (command = node sidecar entry).
- `models.ts` — port of `codex_models.get_codex_model_ids`: fetch
  `chatgpt.com/backend-api/codex/models` (Rust reads `~/.codex/auth.json` metadata +
  builds the `ChatGPT-Account-Id` header without exposing tokens to the webview), then
  config.toml default, cache, curated defaults + forward-compat list.
- `hermes-tools-mcp.ts` — Node stdio MCP **server** (`@modelcontextprotocol/sdk`
  `McpServer` + `StdioServerTransport`): `tools/list` = curated Hermes tool set
  (web_search, web_extract, browser_*, vision_analyze, image_generate, skill_view,
  skills_list, text_to_speech, kanban_*); `tools/call` dispatches to the same in-process
  tool implementations used by the default TS agent loop; explicitly excludes
  `delegate_task` / `memory` / `session_search` / `todo` and terminal/file tools.
- `runtime-dispatcher.ts` — the agent-loop integration point: when the TS agent loop sees
  `model.openai_runtime === "codex_app_server"` (and provider is OpenAI/Codex), route the
  turn through `session.runTurn()` instead of the normal chat loop, then splice
  `projectedMessages` into the message store and run usage/compaction accounting —
  the TS analog of `run_codex_app_server_turn`'s early return.

Data flow (TS): agent loop → `runtime-dispatcher` → `session.runTurn()` → `client` Tauri
IPC → Rust `codex app-server` child (JSON-RPC) → events flow back over IPC →
`event-bridge`/`projector` → chat UI + message store; approval server-requests → existing
approval UI; `hermes-tools` MCP calls land in the same TS tool registry.

## 4. Data models & persistence

- **Config**: `model.openai_runtime: "auto" | "codex_app_server"` lives in the Hermes
  config (currently `config.yaml` via Python; Desktop already has config handling in
  `src/commands/config_migration.rs` / profiles). Toggle writes it through the existing
  config store; a Jotai atom (`codexRuntimeAtom`) mirrors it for UI.
- **`~/.codex/config.toml` managed block**: rendered by Rust (TOML escaping, marker
  comments `# managed by hermes-agent` … `# end hermes-agent managed section`); user
  content outside markers is preserved verbatim. This is a filesystem side effect, not
  a DB row — no schema migration, but the renderer is a pure function with golden-file
  tests (parity with `test_codex_runtime_switch.py` messages).
- **Messages/transcript**: projected messages are standard
  `{role, content, tool_calls, tool_call_id}` rows — same shape the session DB already
  stores (`web/src/lib/session-log.ts`, `packages/protocol/src/session-log.ts`); the
  codex path adds `codexThreadId` / `codexTurnId` / `agentPersisted` fields on the turn
  envelope so resume can hydrate tool cards via `_deterministic_call_id` parity.
- **Token/usage accounting**: port `CanonicalUsage` mapping — `inputTokens`,
  `cachedInputTokens`, `outputTokens`, `reasoningOutputTokens`, `totalTokens`;
  `cacheWriteTokens = 0`; per-session counters + cost estimate stored in the existing
  session-usage store.
- **Compaction**: codex owns thread context; Hermes records a
  `session:compress` boundary event (threadId/turnId, `in_place: false`, runtime
  `codex_app_server`) without rewriting transcript rows.
- **Model cache**: `~/.codex/models_cache.json` (read-only) + in-memory catalog; no new
  persistence.

## 5. Third-party library strategy

| Python dependency / module | TS equivalent | Evidence |
|---|---|---|
| `subprocess` + `orjson` JSON-RPC stdio client (`codex_app_server.py`) | Rust sidecar (`src/codex_app_server.rs`) — stdio + ndjson framing; TS `client.ts` over Tauri IPC | **No TS equivalent in kimi-code** (searched `app-server\|app_server\|jsonrpc.*stdio\|turn/start\|turn/completed\|thread/start`: 0 hits). Rust already owns child processes in this repo (`src/commands/terminal.rs`, `src/coding_agents.rs`). |
| `CodexAppServerSession` + `TurnResult` | TS `session.ts` + `types.ts` | **From scratch** — no kimi-code session adapter for app-server. |
| `CodexEventProjector` / event bridge | TS `projector.ts` + `event-bridge.ts` | **From scratch**. Closest precedent: `web/src/lib/cli-delegation.ts` `parseCodexJsonlLine()` already parses Codex `exec` JSONL (`item.completed` command_execution/agent_message, `turn.completed` usage) — reuse its normalization helpers (`clip`, `numOrUndef`) for event payloads, but the JSON-RPC app-server shape is new. |
| OpenAI Responses SSE path (`codex_responses`, used as fallback/review fork) | kimi-code `packages/agent-core-v2/src/kosong/provider/bases/openai/openai-responses.ts` (OpenAI Responses HTTP provider) | This is the one kimi-code precedent — but it is the *HTTP* Responses API, not app-server; reuse its stream-event parsing shape if the desktop later ports `codex_responses`. |
| `tomllib` config.toml parse/write (migration) | Rust `toml`/`toml_edit` crate (or TS `@iarna/toml` if render-only) | kimi-code reads MCP configs (`packages/agent-core/src/mcp/config-loader.ts`) but does not write Codex TOML; **from scratch**. |
| MCP client config / `hermes-tools` callback server | Node stdio MCP server on `@modelcontextprotocol/sdk` (`McpServer` + `StdioServerTransport`) | kimi-code depends on `@modelcontextprotocol/sdk ^1.29.0` (packages/agent-core/package.json) and implements MCP **clients** (`packages/agent-core/src/mcp/client-stdio.ts`); no MCP *server* in kimi-code (grep `StdioServerTransport` hits only `packages/acp-adapter`, which converts configs, not a serving implementation) → build thin shim from scratch using the SDK's server primitives. |
| `httpx` Codex model catalog fetch (`codex_models.py`) | TS `fetch` in `models.ts` (headers built by Rust from auth.json metadata) | kimi-code model catalog exists (`packages/agent-core/src/services/modelCatalog/`) but not the Codex backend catalog → **from scratch** for the endpoint, reuse catalog store shape. |
| `subprocess` binary check (`check_codex_binary`) | Rust `probe_commands` in `src/environment.rs` + `src/coding_agents.rs` (already probes `codex --version`) | Existing — reuse. |
| Python `tools.approval` prompt flow | Existing Desktop approval UI + `src/commands/yolo.rs` approval bypass | Existing — reuse. |

**Conclusion: no TS equivalent found for the app-server protocol, session, projector,
event bridge, config.toml migration, or the MCP callback server — all built from scratch,
with the Rust child-process and kimi-code MCP-SDK/client + cli-delegation parsing as the
only reusable precedents.**

## 6. Integration with existing Hermes-CN-Desktop frontend

- **Reuse**:
  - `web/src/lib/cli-delegation.ts` — classification + JSONL normalization helpers for
    Codex events (extend `parseCodexJsonlLine` where the app-server JSON-RPC shape maps).
  - `src/coding_agents.rs` + `src/commands/coding_agents.rs` (`coding_agents_check`) —
    codex binary/version/auth detection for the toggle gate and settings page.
  - `src/commands/terminal.rs` spawn patterns (hidden console, pty) for the sidecar.
  - `web/src/routes/coding-agents.tsx` + `settings-coding-agents.tsx` — add a
    "Codex App-Server Runtime" card: current runtime state, binary/version, enable/disable,
    migration summary, `codex login` hint.
  - `web/src/lib/builtin-commands.ts` — register `/codex-runtime` as a built-in composer
    command (add `"codex-runtime"` to `BuiltinCommandName` + aliases) so typing it in the
    composer works like `/compress`.
  - `web/src/lib/transport.ts` / `gateway-client.ts` — only during Phase 1 (see §7);
    `web/src/hooks/`, Jotai stores for state.
  - `packages/protocol/src/hermes-api.ts` — add Zod schemas for `CodexRuntimeStatus`,
    `CodexTurnResult`, `CodexToolEvent`, `CodexMigrationReport`; `channels.ts` gets the
    codex tool-progress event names (`tool.started`/`tool.completed` variants) that the
    event bridge emits.
- **Replace**: any Python-only `/codex-runtime` handling; the desktop never had it
  (grep for `codex-runtime|openai_runtime` in `web/src`, `packages/protocol`, `src/`
  → 0 hits), so this is a net-new surface, not a replacement.

## 7. Removing the WebSocket dependency (migration path)

The feature is today 100% behind the managed Python runtime: the desktop sends the user
message over WS `/api/ws` (or REST) and Python's agent loop runs
`run_codex_app_server_turn`. Phased removal:

1. **Phase 1 — keep backend, add Rust sidecar (instrumentation)**: leave Python as the
   runtime owner; wire the Rust `codex_app_server_check`/status into the new settings
   card; protocol schemas land in `packages/protocol`. **Freeze the API surface** now:
   turn envelope (`final_response`, `messages`, `api_calls`, `completed`, `partial`,
   `interrupted`, `error`, `agent_persisted`, `codex_thread_id`, `codex_turn_id`, usage
   keys), tool-progress event names, `/codex-runtime` argument grammar and status message
   lines (parity with `test_codex_runtime_switch.py`).
2. **Phase 2 — TS in-process modules behind the same interface**: implement
   `web/src/lib/codex-runtime/*` (client, session, projector, event-bridge, usage,
   toggle, migration, models, hermes-tools MCP) and the Rust sidecar; run them
   side-by-side against the same `codex` binary for parity fixtures (projector output,
   usage dict, toggle messages, migration TOML). The chat route still goes through Python,
   but the modules are ready to own it.
3. **Phase 3 — agent-loop handoff**: once the desktop hosts the agent loop in-process
   (see `plans/agent-loop-llm-adapters.md`), `runtime-dispatcher.ts` routes
   `codex_app_server` turns natively; `hermes-tools` MCP calls resolve to the TS tool
   registry; delete the WS/REST path for this feature and stop sending
   `model.openai_runtime` config to Python.

## 8. Migration phases & task breakdown

1. **Rust sidecar** — `src/codex_app_server.rs` (JSON-RPC framing, reader thread, pending
   map, approval request queue, interrupt, close), `src/commands/codex_app_server.rs`;
   unit tests with a fake app-server script (replay fixture JSON-RPC lines); TOML
   managed-block renderer + golden files.
2. **Protocol schemas** — `packages/protocol`: Codex runtime/turn/tool-event/usage/
   migration-report Zod schemas; channel event names.
3. **TS core modules** — `types.ts`, `client.ts`, `session.ts`, `projector.ts`,
   `event-bridge.ts`, `usage.ts`; parity fixtures from `test_codex_event_projector.py`,
   `test_codex_app_server_event_bridge.py`, `test_codex_app_server_runtime.py`.
4. **Toggle + settings UI** — `toggle.ts` (port of `codex_runtime_switch`), `/codex-runtime`
   built-in command, settings card; migration runner (`migration.ts` + Rust TOML write)
   with re-apply-runs-migration semantics.
5. **Model discovery** — `models.ts` (API fetch + cache + defaults + forward-compat);
   parity from `test_codex_models.py`.
6. **hermes-tools MCP callback** — Node stdio MCP server; `tools/list` curated set; wire
   `tools/call` into TS tool registry (depends on web_search/browser/vision/image/skills/
   tts features landing in TS — see `plans/*`); until then, keep the Python
   `hermes_tools_mcp_server` as the sidecar target or stub with clear errors.
7. **Agent-loop integration + WS removal** — `runtime-dispatcher.ts`, session lifecycle
   (spawn on first turn, retire on `should_retire`), background review fork downgrade to
   `codex_responses`; delete Python path behind a feature flag, then remove.

## 9. Risks & open questions

- **No TS equivalent found (verified)**: app-server protocol, session, projector, event
  bridge, config.toml migration, MCP callback server are all from-scratch ports; only
  kimi-code's MCP *client* SDK + cli-delegation parsing + Rust child-process precedents
  exist. Protocol drift (codex 0.125 → 0.130+) must be tracked in one place
  (`MIN_CODEX_VERSION` parity + fixture set).
- **Windows specifics**: hidden console spawn parity; `codex` installed via npm must be
  resolvable (reuse `path_resolver` refresh); `CODEX_HOME` isolation; HOME passthrough
  must NOT be rewritten (Python explicitly keeps real HOME — port that contract).
- **OAuth/token privacy**: Rust reads `~/.codex/auth.json` metadata only; webview must
  never receive token material (same boundary as `src/coding_agents.rs`).
- **Approval UX**: server-initiated `exec`/`applyPatch` requests need the desktop
  approval prompt with `fileChange` preview; `autoApprove` when approval bypass active
  (`src/commands/yolo.rs` parity).
- **Agent-loop tools unavailable** (`delegate_task`, `memory`, `session_search`, `todo`)
  — must stay excluded from the MCP callback; user-facing trade-off table parity.
- **Compaction/usage accounting** parity: cache-write tokens are 0; `compacted` boundary
  without row rewrite; `should_retire` wedge handling.
- **Multiplexed threads**: `notificationBelongsToTurn` scoping (parent + hosted
  subagents on one connection) must be ported to avoid cross-turn mutation.
- **Open questions**: does the desktop host the review fork in-process (downgrade to
  `codex_responses`) or delegate it back? Which `hermes-tools` TS tool implementations
  land first (callback server is blocked on those)? Should `codex login` be launched
  from the app or only hinted?

## 10. Test strategy

- **Vitest unit** (parity vs Python tests):
  - `toggle` — port `tests/hermes_cli/test_codex_runtime_switch.py` cases: parse args
    (on/off/codex/default/ENABLE…), current/set runtime, enable runs migration,
    re-apply runs migration, disable does not migrate, migration failure non-fatal,
    binary-check gate.
  - `models` — port `tests/hermes_cli/test_codex_models.py`: keep
    `supported_in_api:false` models, hide `visibility:hidden`, forward-compat synthesis,
    resolution order API → config default → cache → curated.
  - `projector` / `event-bridge` — fixture-driven parity vs
    `test_codex_event_projector.py` + `test_codex_app_server_event_bridge.py`
    (deterministic call ids, tool started/completed payloads, delta suppression after
    tool calls).
  - `usage` — port token mapping/accounting cases from
    `tests/agent/test_codex_app_server_persist.py` / runtime tests (missing usage →
    api_call_count 1, compaction boundary events).
  - `session` — thread/turn scoping, `_coerce_turn_input_text` (image marker), OAuth
    failure classification, `should_retire` propagation.
- **Rust integration**: JSON-RPC client vs a fake `codex` fixture binary (ndjson replay);
  TOML managed-block renderer golden files; `check_codex_binary` version parsing.
- **Playwright E2E**: settings card toggles `/codex-runtime on/off` and shows status;
  composer `/codex-runtime` command accepted; live tool cards for a fake turn stream.
- **Parity harness** (optional): run the same JSON-RPC fixture through Python and TS
  projectors and diff the projected messages.

## 11. Reference links

- Python: `D:/hermes-agent-cn/agent/codex_runtime.py`,
  `agent/transports/codex_app_server.py`, `agent/transports/codex_app_server_session.py`,
  `agent/transports/codex_event_projector.py`, `agent/transports/hermes_tools_mcp_server.py`,
  `hermes_cli/codex_runtime_switch.py`, `hermes_cli/codex_runtime_plugin_migration.py`,
  `hermes_cli/codex_models.py`, `hermes_cli/runtime_provider.py` (~line 419),
  `website/docs/user-guide/features/codex-app-server-runtime.md`.
- Tests: `tests/cron/test_codex_execution_paths.py`, `tests/hermes_cli/test_codex_runtime_switch.py`,
  `tests/hermes_cli/test_codex_models.py`, `tests/cli/test_cli_codex_context_reference.py`,
  `tests/agent/transports/test_codex_app_server_runtime.py`,
  `tests/agent/transports/test_codex_app_server_session.py`,
  `tests/agent/transports/test_codex_event_projector.py`,
  `tests/agent/test_codex_app_server_event_bridge.py`, `tests/run_agent/test_codex_app_server_*`.
- kimi-code (searched, no app-server equivalent): `packages/agent-core/src/mcp/client-stdio.ts`,
  `packages/agent-core-v2/src/kosong/provider/bases/openai/openai-responses.ts`,
  `packages/agent-core/package.json` (`@modelcontextprotocol/sdk ^1.29.0`),
  `packages/acp-adapter/src/server.ts` + `src/mcp.ts`.
- Desktop: `web/src/lib/cli-delegation.ts`, `web/src/routes/coding-agents.tsx`,
  `web/src/routes/settings-coding-agents.tsx`, `web/src/lib/builtin-commands.ts`,
  `src/coding_agents.rs`, `src/commands/coding_agents.rs`, `src/commands/terminal.rs`,
  `src/environment.rs` (`probe_commands`), `packages/protocol/src/hermes-api.ts`,
  `packages/protocol/src/channels.ts`, `web/src/lib/transport.ts`,
  `web/src/lib/gateway-client.ts`.
- Upstream: https://github.com/openai/codex — `codex-rs/app-server/README.md`.
