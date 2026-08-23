# ACP / IDE Integration — Python → TypeScript Rewrite Plan

## 1. Summary

Port Hermes Agent CN's ACP (Agent Client Protocol) server from the Python runtime
(`D:/hermes-agent-cn/acp_adapter/`) into the TypeScript desktop monorepo so that
ACP-compatible editors and collaboration hosts — VS Code (ACP Client extension), Zed,
JetBrains, and Buzz (buzz-acp relay / Buzz Desktop preset) — can drive a Hermes agent
over stdio without the WebSocket link to the managed Python Dashboard.

ACP over stdio is inherently a subprocess protocol: an editor spawns a long-lived agent
process and exchanges newline-delimited JSON-RPC on stdin/stdout. The desktop end-state
is therefore **not** "run inside the Tauri webview", but "the Tauri shell spawns a
TypeScript sidecar (`packages/acp-server` + the TS agent engine) instead of the Python
`hermes acp` process". The Rust side stays responsible for OS-level process spawning,
pty, and path resolution; all agent logic moves into TS packages shared with the web app.
This removes the Python runtime from the IDE integration surface and, once the TS agent
engine is complete, lets the same engine serve both the Dashboard UI and ACP clients.

Key design decisions:

- Adopt the official npm `@agentclientprotocol/sdk` (same SDK family kimi-code uses) and
  mirror kimi-code's `packages/acp-server` module layout (`server.ts`, `session.ts`,
  `approval.ts`, `auth-methods.ts`, `slash.ts`, `start.ts`, `interaction-bridge.ts`).
- Run ACP as a **separate sidecar process** spawned by the Tauri app (`src/process/acp.rs`),
  reusing the existing `src/process/*` subprocess machinery; the webview only manages
  lifecycle/status via new Tauri commands, never touches the stdio pipe directly.
- Keep the Python-defined feature surface verbatim: curated `hermes-acp` toolset, approval
  options `allow_once` / `allow_session` / `allow_always` / `deny` (+ `deny_always`),
  editor-bound working directory, WSL path translation, edit-approval diff previews, and
  `_meta.hermes.sessionProvenance`.
- Persistence moves from `~/.hermes/state.db` (Python SessionDB) to the desktop's Rust
  SQLite (`src/session_archive.rs` pattern) or the kimi-code `@moonshot-ai/minidb`-style
  embedded store, keyed by the same `acp_sessions` fields so `session/load|resume|list`
  survive process restarts.

## 2. Current Python implementation

Source of truth: `D:/hermes-agent-cn`. All paths below are repo-relative.

- `acp_adapter/entry.py` — CLI entry shared by `hermes acp` / `hermes-acp` /
  `python -m acp_adapter`. Loads `~/.hermes/.env`, configures logging to **stderr**
  (stdout reserved for JSON-RPC), starts background MCP discovery
  (`HERMES_ACP_SKIP_CONFIGURED_MCP=1` skips global MCP), then
  `asyncio.run(acp.run_agent(HermesACPAgent(), use_unstable_protocol=True))`.
  Flags: `--version`, `--check`, `--setup` (interactive model/provider setup +
  optional browser-tools install), `--setup-browser [--yes]`.
- `acp_adapter/server.py` — `HermesACPAgent(acp.Agent)` (the protocol router from the
  `acp` package). Implements: `initialize` (agent capabilities, auth methods, protocol
  version), `authenticate`, session lifecycle (`new_session`, `load_session`,
  `resume_session`, `fork_session`, `list_sessions`, `cancel`), `prompt` (multimodal
  content → OpenAI content parts, slash-command interception, active-turn redirect /
  queue, streaming callbacks), model catalog (`_build_model_state`, per-provider cap 200,
  custom providers `custom:<name>`), session modes (Default / Accept Edits / Don't Ask →
  edit approval policy), usage updates, per-session MCP registration, `_available_commands`
  (help/model/tools/context/reset/compress/steer/queue/version), and `_meta.hermes`
  provenance.
- `acp_adapter/session.py` — `SessionManager` + `SessionState`: in-memory map + persisted
  rows in the shared SessionDB (`~/.hermes/state.db`, `source="acp"`), transparent restore
  on `load/resume`, `fork_session` deep-copy, `list_sessions` merge + sort, cwd translation
  for WSL (`translate_cwd_for_wsl_backend`, `windows_path_to_wsl`) and task-scoped cwd
  overrides (`tools.terminal_tool.register_task_env_overrides`) so file/terminal tools run
  in the editor workspace.
- `acp_adapter/permissions.py` — approval bridge: `request_permission` →
  `PermissionOption` list (`allow_once`, `allow_session`, `allow_always`, `deny`,
  `deny_always`) → maps the client outcome to Hermes approval strings
  `once/session/always/deny`; 60 s timeout auto-denies; unique `perm-check-N` tool-call ids.
- `acp_adapter/edit_approval.py` — pre-execution edit approval bound via ContextVar:
  builds diff proposals for `write_file` / `patch` (replace + V4A), auto-approval policies
  `ask` / `workspace_session` / `session` (sensitive paths `.git`, `.ssh`, `.env*`,
  keys always ask), diff content via `acp.tool_diff_content`.
- `acp_adapter/events.py` — AIAgent callback factories → ACP `session_update`
  notifications: agent message text, thinking text, `ToolCallStart`/`ToolCallComplete`
  (FIFO per-tool-name id queues), todo → `plan` updates.
- `acp_adapter/tools.py` — `TOOL_KIND_MAP` (read/edit/search/execute/fetch/think/other),
  human titles per tool, structured result formatting (read/search/todo), failure
  detection, truncation, image data URLs.
- `acp_adapter/auth.py` — `detect_provider()` (incl. Azure Entra callable api_key),
  `build_auth_methods()`: agent-managed provider method + terminal setup method
  (`hermes-setup`, args `["--setup"]`).
- `acp_adapter/provenance.py` — compression-chain provenance (`acpSessionId`,
  `currentHermesSessionId`, `rootHermesSessionId`, `compressionDepth`, ...) under
  `_meta.hermes.sessionProvenance`.
- `hermes_cli/subcommands/acp.py` — `hermes acp` parser wiring (`--version`, `--check`,
  `--setup`, `--setup-browser`, `--yes`).
- `hermes_cli/stdio.py` — Windows UTF-8 stdio (`SetConsoleCP/SetConsoleOutputCP` 65001,
  `PYTHONUTF8`, `PYTHONIOENCODING`, EDITOR default, PATH prefill) so the stdio channel
  survives Windows consoles and inherited child processes.
- Launchers: `hermes_cli/update_cmd.py::_ensure_acp_launcher` (adds `hermes-acp` to
  `~/.local/bin`), `scripts/install.sh` writes `hermes` + `hermes-acp` launchers.
- Dependency: `pyproject.toml` `[acp]` extra = `agent-client-protocol==0.9.0`;
  `hermes-acp = "acp_adapter.entry:main"` console script.

Data flow: editor spawns `hermes acp` → `acp.run_agent` reads NDJSON JSON-RPC from stdin →
`HermesACPAgent` handlers → `SessionManager` → sync `AIAgent` runs in a `ThreadPoolExecutor`
worker → callbacks (`events.py`) marshal updates back onto the asyncio loop via
`asyncio.run_coroutine_threadsafe` → `conn.session_update()` notifications on stdout.

Tests (parity surface): `tests/acp/` (16 files + conftest; key: `test_server.py`,
`test_session.py`, `test_auth.py`, `test_permissions.py`, `test_edit_approval.py`,
`test_mcp_e2e.py`, plus `test_approval_isolation.py`, `test_entry.py`, `test_events.py`,
`test_ping_suppression.py`, `test_named_provider_catalogs.py`, `test_session_db_private_access.py`,
`test_session_provenance.py`, `test_tools.py`), `tests/acp_adapter/` (5: commands, images,
logging redaction, mcp discovery, detect_provider_entra),
`tests/hermes_cli/test_ensure_acp_launcher.py`, `tests/test_install_sh_acp_launcher.py`.

## 3. Target TypeScript design

New workspace packages in `D:/Hermes-CN-Desktop` (mirror kimi-code layout):

```
packages/acp-server/
  src/
    start.ts          # runAcpServer(): ndJsonStream over Node stdin/stdout; redirect console→stderr
    server.ts         # AcpServer: initialize/authenticate + session lifecycle + prompt routing
    session.ts        # AcpSession: one agent per ACP sessionId; event subscription → session updates
    approval.ts       # pure mappers: ApprovalRequest ⇄ PermissionOption[]/ToolCallUpdate/outcome
    edit-approval.ts  # write_file/patch diff proposals, auto-approval policies, sensitive paths
    auth-methods.ts   # provider method + terminal method (id 'hermes-setup', args ['--setup'])
    slash.ts          # slash detection: builtin commands + skill commands
    events.ts         # agent event stream → ACP session_update notifications (message/thinking/tool/plan)
    tools.ts          # hermes-acp curated toolset allowlist, ToolKind map, titles, result formatting
    mcp.ts            # per-session mcpServers registration + global discovery opt-out
    session-db.ts     # persistence adapter (Rust SQLite via IPC, or minidb)
    types.ts          # ACP wire types re-exported from @agentclientprotocol/sdk + AcpSessionState
    index.ts
```

Rust side: new `src/process/acp.rs` (sidecar supervisor modeled on `src/process/dashboard.rs`):
- Resolves the sidecar entry (`node packages/acp-server/dist/index.js` in dev; a bundled
  Node binary + static bundle in release), spawns with `Stdio::piped()`, env
  `HERMES_HOME`, `HERMES_ACP_SKIP_CONFIGURED_MCP` passthrough, and the editor cwd.
- Because an ACP client (the editor) owns the stdio pipe, the Tauri shell only spawns the
  process and monitors it; it does **not** open the pipe. The webview talks to Rust via
  new commands (`acp_start`, `acp_stop`, `acp_status`, `acp_list_sessions`) for lifecycle
  UX (e.g. a Settings toggle "Enable IDE integration").
- Transition phase: the sidecar's TS agent engine can call the managed Python runtime over
  a **private** JSON-RPC/stdio bridge (not the Dashboard WS) until the TS agent engine is
  complete; final phase runs the engine fully in-process inside the sidecar.

In-process agent engine: `packages/acp-server` depends on a TS `HermesAgent` interface
(port of `AIAgent`): `prompt(content)`, `redirect(text)`, `cancel()`, `events`
(`assistant.delta`, `thinking.delta`, `tool.call.started/delta/progress/result`,
`turn.ended`, `compaction.*`), `model`, `provider`, `sessionId`. This mirrors kimi-code's
`AgentHandle`/`Klient` facade (`packages/acp-server/src/session.ts` subscribes to
`agent.events.on('assistant.delta' | 'thinking.delta' | 'tool.call.started' | ...)`).

Curated toolset: `packages/acp-server/src/tools.ts` exports `ACP_TOOLSET` = the exact
`hermes-acp` allowlist (read_file, write_file, patch, search_files, terminal, process,
execute_code, todo, memory, session_search, delegate_task, skill_view, skills_list,
skill_manage, web_search, web_extract, browser_*, vision_analyze, image_generate,
text_to_speech; **excludes** messaging delivery and cronjob management per docs). The TS
agent engine's tool registry filters by this set before `_available_commands` / tool calls.

Editor-bound working directory: `session/new|load|resume|fork(cwd)` →
`SessionState.cwd` → per-session task env override (`registerTaskEnvOverrides(taskId, {cwd})`)
so file/terminal tools run in the editor workspace, exactly like `acp_adapter/session.py`
`_register_task_cwd`. Port `windowsPathToWsl` / `translateCwdForWslBackend` into a shared
`packages/protocol` util used by both the sidecar and the web app.

Approvals: `approval.ts` maps a Hermes approval request to ACP `PermissionOption[]` with
the **same ids as Python** (`allow_once`, `allow_session`, `allow_always`, `deny`,
`deny_always`) and maps the client outcome to the TS approval engine
(`once | session | always | deny | timeout`); `edit-approval.ts` renders
`tool_diff_content` previews and enforces `ask/workspace_session/session` auto-approval
with the same sensitive-path list.

## 4. Data models & persistence

Types (Zod schemas in `packages/protocol/src/acp.ts`; ACP wire types come from
`@agentclientprotocol/sdk`):

- `AcpSessionState { sessionId, cwd, model, mode, history[], queuedPrompts[],
  cancelEvent, isRunning, currentPromptText, interruptedPromptText, sessionAllowlist[],
  runtimeLock }` — mirrors Python `SessionState`.
- `AcpSessionRow { id, cwd, model, title, preview, messageCount, lastActive,
  startedAt, historyJson, parentSessionId, endReason }` — mirrors SessionDB rows
  (`source="acp"`); `parentSessionId`/`endReason` feed provenance.
- `EditProposal { toolName, path, oldText?, newText, arguments }`.
- `ApprovalDecision { decision: 'once'|'session'|'always'|'deny'|'timeout'|'cancelled',
  selectedLabel?, scope? }` — matches Python `_OPTION_ID_TO_HERMES` + timeout semantics.

Persistence strategy: ACP sessions must survive sidecar restarts (editor reconnects via
`session/resume`). Options, in order:
1. **Rust SQLite** — Desktop already owns SQLite-adjacent persistence (`src/session_archive.rs`,
   `src/session_log.rs`); add `acp_sessions` table + `acp_approvals` table, exposed to the
   sidecar through a private IPC/JSON-RPC channel (or the sidecar writes directly if it
   embeds the same storage crate via a small Rust CLI).
2. **`@moonshot-ai/minidb`** (kimi-code embedded DB) if we want a pure-TS store and accept
   a new dependency; validate before choosing.
3. JSON files under the desktop data dir (acceptable interim; loses index/search parity).

Permanent `allow_always` entries: reuse the desktop-side approval allowlist (port of
`tools.approval`), keyed by command pattern; `allow_session` lives only in the in-memory
`sessionAllowlist` and clears when the session ends — identical semantics to the Python
adapter (docs table: allow_once/session/always/deny + persistence column).

Migration: existing `~/.hermes/state.db` ACP rows (created by Python builds) should be
imported once into the desktop store during the transition phase, or `session/resume`
should fall back to "create new session" (as Python does when the id is unknown) — no
hard dependency on migration for correctness.

## 5. Third-party library strategy

Most important section — every Python dependency → TS equivalent, with kimi-code evidence.

| Python (Hermes-CN-Core) | TS equivalent | Evidence in `D:/kimi-code` |
|---|---|---|
| `agent-client-protocol==0.9.0` (`acp.Agent`, `acp.run_agent`, `acp.schema`, `ndJsonStream` framing) | npm `@agentclientprotocol/sdk` (acp-adapter pins `^0.23.0`; acp-server pins `^1.3.0` — pick one, likely 1.x, and keep `use_unstable_protocol`-equivalent unstable methods behind the SDK's flag) | `packages/acp-adapter/package.json` (dep `@agentclientprotocol/sdk ^0.23.0`), `packages/acp-server/package.json` (`^1.3.0`), `packages/acp-server/src/start.ts` (`ndJsonStream(Writable.toWeb(output), Readable.toWeb(input))`), `packages/acp-adapter/src/server.ts` (same pattern) |
| `asyncio` + `ThreadPoolExecutor` (sync AIAgent in worker threads, `run_coroutine_threadsafe`) | Node event-emitter + async handlers; kimi-code's `AcpSession` subscribes to `agent.events` and settles the prompt on `turn.ended` | `packages/acp-server/src/session.ts` (event subscription list, `TurnDriver`, `dispatchTurnEvent`) |
| `AIAgent` (Hermes agent loop, tools, memory, skills, context compressor) | **No TS equivalent in Desktop yet**; kimi-code has `@moonshot-ai/agent-core` / `agent-core-v2` + `@moonshot-ai/klient` facade as the closest pattern — design a thin `HermesAgent` interface and port the engine incrementally | `packages/acp-server/src/server.ts` (drives `klient.global.sessions`, `klient.session(id).agent('main')`), `packages/acp-server/src/start.ts` (`bootstrap()`, `createKlient({ scope: core })`) |
| `tools.approval` (dangerous-command allowlist) | TS approval engine from scratch: `requestPermission()` bridge + session/permanent allowlists; kimi-code's `AgentPermissionGate` + `interaction` kernel is the design template | `packages/acp-server/src/approval.ts` (pure option/outcome mappers), `packages/acp-server/src/interaction-bridge.ts` (subscribes `interactions.changed`, calls `conn.requestPermission`) |
| `tools.terminal_tool` + pty (Windows UTF-8, cwd overrides) | Rust pty via `src/commands/terminal.rs` (already exists) or Node `node-pty`; ACP `clientCapabilities.terminal` reverse-RPC like kimi-code's `acp-terminal` | `packages/acp-server/src/acp-terminal/acpTerminalRunner.ts`, `apps/kimi-code/src/native` (node-pty) |
| MCP discovery / per-session MCP (`mcp-<server>` toolsets) | TS MCP client from scratch or reuse kimi-code's `src/mcp.ts` design; Desktop already models MCP in `packages/protocol/src/mcp-api.ts` | `packages/acp-adapter/src/mcp.ts`, `packages/acp-adapter/test/mcp-forward.test.ts` |
| `orjson` (fast JSON) | native `JSON.parse/stringify` (+ `zod` v4 for validation in `packages/protocol`) | `packages/protocol/package.json` (dep `zod ^4.3.6`) |
| `pybase64` | `Buffer.from(...).toString('base64')` / `atob` | n/a — trivial shim |
| SessionDB (`~/.hermes/state.db` SQLite) | Desktop Rust SQLite or `@moonshot-ai/minidb`; kimi-code persists via `FileStorageService` + `ISessionIndexMirror` | `packages/acp-server/src/start.ts` (bootstrap persistence), `packages/minidb` package |
| Windows stdio (`hermes_cli/stdio.py`: `SetConsoleCP`, `PYTHONUTF8`) | **No TS equivalent needed** — Node writes UTF-8 to stdio natively; only ensure Rust spawns children without inheriting console code-page quirks | kimi-code `start.ts` only redirects `console.*` to stderr (no code-page code) |
| `agent-browser` + Playwright Chromium browser tools | Browser tooling in TS (Playwright npm) — port later; browser tools are optional ACP extras | kimi-code uses its own browser tooling; no direct ACP-specific equivalent to copy |
| Launcher (`_ensure_acp_launcher`, install.sh `hermes-acp`) | Desktop ships the sidecar inside the app bundle; no shell launcher needed (Rust resolves the binary path via `src/process/runtime.rs` `runtime_binary_names` / node bin helpers) | n/a — desktop packaging replaces this |

"No TS equivalent found" risks: (a) Hermes `AIAgent` (agent loop + tools + memory + skills +
context compressor) — kimi-code has its own engine but it is Kimi-specific, so Hermes'
engine must be ported or bridged; (b) `tools.fuzzy_match` (fuzzy `patch` matching) and the
`ContextCompressor` chain used for provenance/compaction; (c) `tools.approval` permanent
allowlist storage semantics — must be re-implemented, not just surfaced; (d) Python
`agent-client-protocol`'s `use_unstable_protocol=True` behavior (fork/close/delete) — verify
the TS SDK's unstable surface matches.

## 6. Integration with existing Hermes-CN-Desktop frontend

Reuse / extend:

- `packages/protocol/` — add `src/acp.ts` (Zod schemas: `AcpSessionState`, `AcpSessionRow`,
  `EditProposal`, `ApprovalDecision`, ACP session-info DTOs) following the existing
  `hermes-api.ts` pattern; add cwd/WSL path utils shared with the sidecar.
- `src/process/` — new `acp.rs` sidecar supervisor modeled on `dashboard.rs` (spawn/probe/
  graceful shutdown/timeouts); reuse `runtime.rs` for managed-runtime binary resolution and
  `src/commands/runtime_manager.rs` for install/update gating.
- `src/commands/` — new `acp.rs` Tauri commands (`acp_start(profile)`, `acp_stop`,
  `acp_status`, `acp_sessions`) registered in `main.rs` `generate_handler!`; reuse the
  existing command conventions (AppError, `tauri::State`).
- `src/commands/terminal.rs` — existing pty commands become the backend for the ACP
  `terminal`/`process` tools when the agent runs in-process; the sidecar can call the same
  Rust pty via a private IPC channel.
- `web/src/lib/tauri-bridge.ts` — add `acp_*` wrappers so the existing `window.hermesDesktop`
  shim pattern extends to ACP lifecycle.
- `web/src/lib/transport.ts` / `gateway-client.ts` — **not** used for ACP stdio traffic;
  they remain for Dashboard UI. The webview only sees ACP lifecycle/status through Rust IPC.
- UI: a Settings/IDE page (new route under `web/src/routes/`) to enable the sidecar and show
  agent registration snippets for VS Code / Zed / JetBrains / Buzz (command `hermes acp` →
  desktop-provided command or bundled sidecar path), plus an approval-log view using the
  existing Jotai stores pattern.

Note: today the Desktop has **zero** ACP code (verified by grep across `src/`, `web/src/`,
`packages/`); this plan introduces the first ACP surface.

## 7. Removing the WebSocket dependency (migration path)

ACP is a stdio surface, so "removing the WS link" here means: the IDE integration must not
depend on the Dashboard `/api/ws` WebSocket or the REST API.

Phased migration (same-interface strategy as the README):

1. **Phase 0 (today)**: editor spawns the Python `hermes acp` subprocess directly
   (unchanged; documented in `website/docs/user-guide/features/acp.md`).
2. **Phase 1 (sidecar shell)**: Rust spawns a TS `packages/acp-server` sidecar; the sidecar
   implements the full ACP wire surface but drives the managed Python runtime through a
   **private** stdio/JSON-RPC bridge (new, frozen internal interface `HermesAgentBridge`:
   `prompt/redirect/cancel/events/model/mode/cwd`). No Dashboard WS/REST involved; Python
   stays only as the agent engine behind the bridge. The webview can render ACP status
   through new Tauri commands, not the gateway.
3. **Phase 2 (in-process engine)**: replace the bridge adapter with the TS agent engine
   port (tools, memory, skills, approvals, compaction) behind the same `HermesAgent`
   interface. ACP server code does not change — the interface is the freeze boundary.
4. **Phase 3 (delete WS path)**: once the TS engine is feature-parity, the Dashboard UI can
   also run against the same TS engine; delete the managed-Python dashboard WS/REST usage
   for IDE features. Keep `/api/ws` only for legacy hosts until migration completes.

Frozen API surface during migration: ACP method names/schemas from
`@agentclientprotocol/sdk`; permission option ids (`allow_once/allow_session/allow_always/deny`);
session persistence fields (`AcpSessionRow`); `_meta.hermes.sessionProvenance` shape;
`hermes-acp` toolset allowlist.

## 8. Migration phases & task breakdown

| Phase | Tasks |
|---|---|
| 0. Baseline (no code change) | Record editor configs (VS Code `acp.agents`, Zed `agent_servers`, JetBrains plugin, Buzz preset) as parity fixtures; capture Python JSON-RPC traces for the parity harness. |
| 1. Sidecar skeleton | Add `packages/acp-server` with `start.ts` (ndJsonStream + console→stderr); add `src/process/acp.rs` (spawn/stop/status); add `acp_*` Tauri commands + `tauri-bridge.ts` wrappers; wire Settings toggle. Port `initialize`, `authenticate`, `auth-methods.ts` (provider + `hermes-setup` terminal method). |
| 2. Sessions + cwd | Port `SessionManager`/`AcpSessionState`; persistence adapter (Rust SQLite table `acp_sessions`); `session/new|load|resume|fork|list|cancel`; WSL cwd translation; task env overrides. |
| 3. Prompt + events | Port `events.ts` (message/thinking/tool start/complete/plan), `tools.ts` (ToolKind map, titles, result formatting), slash commands, active-turn redirect/queue; first E2E against the bridge. |
| 4. Approvals | Port `approval.ts` + `edit-approval.ts` (diff previews, auto-approval policies, sensitive paths, session/permanent allowlists, timeout/deny semantics). |
| 5. MCP + model catalog | Per-session `mcpServers` registration; `_build_model_state` port (provider inventory, `custom:<name>`); usage updates; provenance `_meta.hermes`. |
| 6. Engine bridge → TS engine | Implement `HermesAgentBridge` to Python; then port agent engine modules (tools/terminal/skills/memory/compaction) behind the same interface; browser tools last. |
| 7. Cutover | Delete bridge path; make ACP the primary IDE surface; parity + regression suite green; docs update. |

## 9. Risks & open questions

- **No TS equivalent of Hermes `AIAgent`** — the biggest risk; kimi-code's `agent-core-v2`
  proves the architecture but is not Hermes' tools/memory/skills. Requires a large port or a
  long-lived bridge to the Python engine (which still needs Python installed, weakening the
  "no runtime" goal for IDE features until Phase 6 completes).
- **SDK version divergence**: `@agentclientprotocol/sdk` 0.23 (acp-adapter) vs 1.3
  (acp-server) — unstable methods (`fork`, `close`, `delete`, `use_unstable_protocol`
  equivalent) and terminal-auth `_meta['terminal-auth']` legacy shape (Zed, current
  JetBrains plugin) must be verified against the pinned version.
- **Buzz headless auto-approval**: Buzz's bridge answers `request_permission` itself with
  `allow_once`; the docs warn this is unattended execution. The TS server must preserve
  `Owner only` semantics and not weaken the guard when porting approvals.
- **Windows/WSL path translation and UTF-8 stdio**: Node sidecar avoids Python's code-page
  problem, but WSL-launched editors sending Windows drive paths still need the `/mnt/<d>`
  translation (port `translate_cwd_for_wsl_backend`), and Rust must spawn with an isolated
  `HERMES_HOME` like the dashboard path.
- **Persistence migration**: existing Python `~/.hermes/state.db` ACP sessions vs the new
  desktop store; decide import-once vs fresh-session fallback.
- **Editor-specific quirks**: Zed renders `session/load` replay synchronously within the
  request (Python comments cite a regression); the TS `loadSession` must await
  `replayHistory()` before responding (kimi-code `acp-server/src/server.ts` does this).
- **`hermes-acp` toolset strictness**: `platform_toolsets.acp` in Python does not narrow the
  toolset (docs) — the TS port should keep the curated allowlist authoritative, not the
  approvals config.

## 10. Test strategy

- **Unit (vitest)**, per module:
  - `approval.test.ts` — option-id mapping, allow_once/session/always/deny/deny_always,
    timeout → deny, unknown option → deny (parity: `tests/acp/test_permissions.py`).
  - `edit-approval.test.ts` — diff content kind=edit, deny does not mutate, workspace/tmp
    auto-approval, sensitive path always asks (parity: `tests/acp/test_edit_approval.py`).
  - `session.test.ts` — create/load/resume/fork/list/restore-from-db, WSL cwd translation
    (parity: `tests/acp/test_session.py`, incl. `TestWslCwdTranslation`).
  - `auth-methods.test.ts` — provider detection incl. Entra callable key, terminal method
    build (parity: `tests/acp/test_auth.py`, `tests/acp_adapter/test_detect_provider_entra.py`).
  - `server.test.ts` — initialize caps/auth gate, session ops, slash commands, available
    commands, MCP registration/sanitization (parity: `tests/acp/test_server.py`,
    `tests/acp/test_mcp_e2e.py`).
  - `tools.test.ts` — ToolKind map, title builders, failure detection, redaction of secrets
    in stderr logs (parity: `tests/acp/test_tools.py`,
    `tests/acp_adapter/test_acp_logging_redaction.py`).
- **Integration (vitest)**: in-memory `AcpServer` over `ndJsonStream` with a fake editor
  client (kimi-code has this pattern in `packages/acp-server/test/_helpers/acpClient.ts`);
  full JSON-RPC turn script run against **both** the Python server and the TS server and
  compared (parity harness; fixtures from Phase 0 traces).
- **Rust tests**: `src/process/acp.rs` unit tests (spawn/stop/status, env isolation,
  HERMES_HOME) + `tests/` integration using `wiremock`-style fakes; follow the repo rules
  (`#[serial_test::serial]` for env-dependent tests, `tempfile::TempDir`).
- **E2E (Playwright)**: webview Settings toggles sidecar on/off; `acp_status` reflects
  process state; a scripted ACP client drives one full session through the real sidecar +
  fake model (pattern from `e2e/` with Core fake model).
- **Launcher parity**: `tests/hermes_cli/test_ensure_acp_launcher.py` /
  `tests/test_install_sh_acp_launcher.py` map to Rust/node tests asserting the bundled
  sidecar resolves and starts (no symlink-into-venv equivalent; assert bundled-path
  resolution instead).

## 11. Reference links

- Python: `D:/hermes-agent-cn/acp_adapter/{entry,server,session,auth,permissions,edit_approval,events,tools,provenance}.py`,
  `D:/hermes-agent-cn/hermes_cli/subcommands/acp.py`, `D:/hermes-agent-cn/hermes_cli/stdio.py`,
  `D:/hermes-agent-cn/hermes_cli/update_cmd.py` (`_ensure_acp_launcher`),
  `D:/hermes-agent-cn/scripts/install.sh`, `D:/hermes-agent-cn/pyproject.toml` (`[acp]` extra),
  `D:/hermes-agent-cn/website/docs/user-guide/features/acp.md`.
- Tests: `D:/hermes-agent-cn/tests/acp/`, `D:/hermes-agent-cn/tests/acp_adapter/`,
  `D:/hermes-agent-cn/tests/hermes_cli/test_ensure_acp_launcher.py`,
  `D:/hermes-agent-cn/tests/test_install_sh_acp_launcher.py`.
- TS reference: `D:/kimi-code/packages/acp-server/` (`server.ts`, `session.ts`,
  `approval.ts`, `auth-methods.ts`, `slash.ts`, `start.ts`, `interaction-bridge.ts`,
  `acp-terminal/`, `test/_helpers/acpClient.ts`), `D:/kimi-code/packages/acp-adapter/`,
  `D:/kimi-code/packages/protocol/` (`envelope.ts`, `events.ts`, `session.ts`),
  `D:/kimi-code/packages/minidb/`.
- Desktop: `D:/Hermes-CN-Desktop/src/process/{dashboard,gateway,runtime,instance}.rs`,
  `D:/Hermes-CN-Desktop/src/commands/{terminal,gateway,runtime_manager}.rs`,
  `D:/Hermes-CN-Desktop/src/session_archive.rs`, `D:/Hermes-CN-Desktop/web/src/lib/{tauri-bridge,transport,gateway-client,cli-delegation}.ts`,
  `D:/Hermes-CN-Desktop/packages/protocol/src/{hermes-api,index}.ts`.
