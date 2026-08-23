# Tool Categories — Python → TypeScript Rewrite Plan

## 1. Summary

The Python runtime exposes ~100 built-in tools through a central registry
(`D:/hermes-agent-cn/tools/registry.py`) and an orchestration layer
(`D:/hermes-agent-cn/model_tools.py`), grouped into **toolsets** defined in
`D:/hermes-agent-cn/toolsets.py`. The user-facing grouping is documented as
eight high-level **categories**: web; terminal & files; browser; media; agent
orchestration (todo / clarify / execute_code / delegate_task); memory & recall;
automation (cronjob); integrations (ha_*, MCP).

This plan is the **catalog/gateway layer** for those tool families: it ports the
category model, the registry + dispatch gateway, toolset resolution, availability
gates, and result-post-processing (error bounding + untrusted-content wrapping) to
TypeScript. It deliberately does **not** deep-dive individual tool implementations
— each family has a sibling plan (terminal-backends, subagent-delegation,
code-execution, mcp, home-assistant, cron-scheduled-tasks) that owns its handlers.
The end state: the React web app hosts the tool registry in-process, no WS/REST
call is needed to enumerate or dispatch tools, and the desktop UI can render a
per-category tool catalog (enable/disable, availability badges, "what a category
can do" docs) directly from the in-process catalog.

## 2. Current Python implementation

- **Registry** — `D:/hermes-agent-cn/tools/registry.py`:
  - `ToolRegistry.register(name, toolset, schema, handler, check_fn, emoji, …)`;
    `registry.dispatch(name, args)`; `registry.get_definitions(enabled_toolsets)`
    returning OpenAI function-calling schemas; `tool_error()` with a 2048-char
    error cap (`_MAX_TOOL_ERROR_CHARS`) and dispatch-boundary bounding of
    non-conformant JSON error results; `discover_builtin_tools()` + a **lazy
    static tool index** (`build_tool_index`, cached on disk as
    `~/.hermes/cache/tool_index.json`, keyed by xxhash fingerprint) that maps
    `tool name → module` and `toolset → modules` without importing modules.
- **Orchestration** — `D:/hermes-agent-cn/model_tools.py`:
  - Public API: `get_tool_definitions(enabled_toolsets, disabled_toolsets,
    quiet_mode)`, `handle_function_call(function_name, args, task_id, user_task)`,
    `get_all_tool_names()`, `get_toolset_for_tool()`, `get_available_toolsets()`,
    `check_toolset_requirements()`, `check_tool_availability()`.
  - **Argument alias repair**: `TOOL_FIELD_ALIASES` (general/file/shell/web/task/
    todo/input/search/memory/cronjob/skill) + `TOOL_SPECIFIC_ALIASES` for
    `delegate_task`/`cronjob`/`process` — LLM synonyms (`cmd`→`command`,
    `filepath`→`path`, `items`→`todos`, …) are normalized before dispatch, with an
    optional `set_arg_repair_callback` for TUI/ACP observability.
  - Async bridging: persistent per-thread event loops (`_get_tool_loop`,
    `_get_worker_loop`, `_run_async`) so cached async clients (httpx/OpenAI) are
    not bound to dead loops; used by every async handler.
- **Category/toolset model** — `D:/hermes-agent-cn/toolsets.py`:
  - `TOOLSETS` dict: `web`, `search`, `x_search`, `vision`, `video`, `terminal`,
    `file`, `browser`, `image_gen`, `tts`, `skills`, `todo`, `memory`,
    `session_search`, `clarify`, `code_execution`, `delegation`, `cronjob`,
    `homeassistant`, `messaging`, `discord`, `discord_admin`, `debugging`,
    `safe`, `desktop_ui`, `project`, `kanban`, …; each toolset can `includes`
    other toolsets (composition) and is resolved by `resolve_toolset()` /
    `validate_toolset()`. `_HERMES_CORE_TOOLS` is the shared platform list.
- **Family implementation files** (each self-registers via
  `registry.register(...)`): `tools/todo_tool.py` (TodoStore, per-session
  in-memory, re-injection after compaction), `tools/clarify_tool.py` (schema +
  platform callback), `tools/code_execution_tool.py` (sandboxed PTC, UDS/file RPC,
  disabled under frozen runtime), `tools/delegate_tool.py` (child AIAgents,
  blocked-tool set, spawn pause, active-subagent registry, steer/interrupt),
  `tools/cronjob_tools.py` (single action-oriented tool over `cron/jobs.py` +
  prompt-threat scanners), `tools/homeassistant_tool.py` (ha_list_entities /
  ha_get_state / ha_list_services / ha_call_service via aiohttp, gated on
  `HASS_TOKEN`), `tools/mcp_tool.py` (stdio/StreamableHTTP/SSE client, dynamic
  `mcp-<server>` toolsets, sampling, reconnect).
- **Result post-processing** — `D:/hermes-agent-cn/agent/tool_dispatch_helpers.py`:
  - `_is_untrusted_tool` (web_extract/web_search/browser_*/mcp_*), `_maybe_wrap_untrusted`
    (wraps long untrusted text in `<untrusted_tool_result source="…">…</…>`,
    neutralizes embedded closing tags), `make_tool_result_message`.
- **Docs** — `D:/hermes-agent-cn/website/docs/user-guide/features/tools.md` gives the
  canonical category table (Web / X Search / Terminal & Files / Browser / Media /
  Agent orchestration / Memory & recall / Automation / Integrations) and the
  `hermes tools` enable/disable UX.
- **Tests to mirror** — `tests/tools/test_registry.py` (register/dispatch,
  get_definitions OpenAI shape, unknown-tool error, error bounding, MCP parallel
  registration), `tests/agent/test_tool_dispatch_helpers.py` (untrusted
  classification + wrapper + embedded-tag breakout), `tests/tools/test_todo_tool.py`
  (TodoStore write/merge/archive/bounds/format_for_injection),
  `tests/tools/test_terminal_tool.py` / `test_file_tools.py` (schema + sudo + file
  ops; referenced for family parity by sibling plans).

Data flow today: `run_agent.py`/`cli.py` → `model_tools.get_tool_definitions()`
(schemas injected into the LLM prompt) → LLM emits `handle_function_call()` →
registry dispatch → handler (sync or async via `_run_async`) → result string →
`make_tool_result_message()` → next LLM turn. The desktop currently reaches this
via Dashboard REST/WS (`/api/ws` + HTTP routes used by `use-mcp.ts`, `use-cron.ts`).

## 3. Target TypeScript design

New module family under `web/src/lib/tools/` (in-process, no Python):

- `types.ts` — shared contracts:
  - `ToolCategoryId = 'web' | 'terminal-files' | 'browser' | 'media' | 'orchestration' | 'memory-recall' | 'automation' | 'integrations'`.
  - `ToolCategory { id; labelZh; labelEn; icon; description; toolsets: string[]; availability?: AvailabilityGate }`.
  - `ToolsetDefinition { name; description; tools: string[]; includes?: string[] }` (mirror `TOOLSETS`).
  - `ToolDefinition` — OpenAI function-calling shape `{ type:'function', function:{ name, description, parameters } }`.
  - `ToolHandler = (args: Record<string, unknown>, ctx: ToolContext) => string | Promise<string>`.
  - `ToolRegistration { name; toolset; schema; handler; checkFn?; emoji?; category: ToolCategoryId; untrusted?: boolean; family: string }`.
  - `ToolResult { error?: string; … }` + `toolError()` helper with the 2048-char bound.
- `categories.ts` — the **catalog**: static `TOOL_CATEGORIES: ToolCategory[]` built
  from the docs table and `toolsets.py`; exports `getCategoryForTool(name)`,
  `getCategoriesForToolsets(toolsets)`, `resolveCategoryToolsets(category)`.
- `toolsets.ts` — port of `TOOLSETS` + `resolveToolset`/`validateToolset`/
  `getToolsetForTool`; a small `enabledToolsFor(profile)` helper folds
  enable/disable + includes.
- `registry.ts` — `ToolRegistry` class mirroring `tools/registry.py`:
  `register()`, `dispatch()`, `getDefinitions(enabledToolsets)`, `getEntry()`,
  `getAllToolNames()`, generation counter for lazy UIs; static registration via
  family modules imported through a `families/index.ts` barrel.
- `dispatch.ts` — gateway:
  - `normalizeArgs(name, args)` — port of `TOOL_FIELD_ALIASES` +
    `TOOL_SPECIFIC_ALIASES` (hand-written table, same keys).
  - `handleToolCall(name, args, ctx)` — alias repair → availability gate
    (`checkFn`) → registry dispatch → `wrapUntrusted(name, result)` →
    `boundToolError(result)` → `ToolResult`.
  - `wrapUntrusted()` port of `_maybe_wrap_untrusted` incl. embedded
    `</untrusted_tool_result>` neutralization.
- `availability.ts` — `AvailabilityGate` interface + gates: `hasSecret('HASS_TOKEN')`
  (HA), `codeExecutionSandboxAvailable()` (false in frozen/bundled runtime),
  `xSearchConfigured()` (xAI creds), `mcpServersConnected()`.
- `use-tools.ts` (React hook) — exposes `useToolCatalog()`, `useToolsByCategory()`,
  `useSetToolsetEnabled()` backed by a Jotai store; feeds the catalog UI.
- `ToolCatalogPanel` route/component — per-category cards, availability badges,
  toolset toggles (writes profile config via existing `config` REST → later
  Tauri-side JSON), and docs text from the category model. Reuses
  `SectionShell` (see `web/src/routes/console.tsx`).

Each family is registered by its sibling plan in `families/<family>.ts`; this plan
only defines the contract (`defineToolFamily({ category, toolsets, register })`)
and the aggregation point, so families can land independently. Pseudocode:

```ts
interface ToolFamily {
  category: ToolCategoryId;
  toolsets: string[];
  register: (reg: ToolRegistry) => void;
}
export function defineToolFamily(f: ToolFamily): ToolFamily { return f; }
// families/index.ts: export const FAMILIES = [webFamily, terminalFilesFamily, ...]
```

Runtime: the catalog + registry are plain TS modules loaded at app startup
(Vite `import.meta.glob('./families/*.ts')` replaces Python's AST scan); dispatch
runs in the webview's JS event loop — async handlers use real `await`, no
`asyncio.run` bridging needed. Child-process tools (terminal, execute_code, MCP
stdio) go through Tauri Rust commands (`src/commands/*`) via `tauri-bridge.ts`; the
registry treats them as async handlers that invoke IPC.

## 4. Data models & persistence

- **In-memory (per session)**: `ToolRegistry` entries; `TodoStore` (from
  `todo_tool.py`, owned by the session object — sibling orchestration plan);
  enabled/disabled toolset snapshot.
- **Profile config (persistent)**: enabled/disabled toolsets + per-tool
  availability flags, today stored in `~/.hermes/config.yaml` via `/api/config`…
  In-process end state: Tauri app-data JSON (`src/state.rs` already centralizes
  state; add a `tools` section `{ enabledToolsets: string[], disabledTools: string[] }`).
  Schema versioned; migration only adds fields (no rewrite of Python config).
- **Optional tool-index cache**: mirror `tool_index.json` (name → module) is not
  needed for a static TS bundle; if lazy family loading is ever added, cache the
  `import.meta.glob` result in memory only.
- **Category enablement UI state**: Jotai atoms (`web/src/stores/`) mirroring
  `use-cron.ts`/`use-mcp.ts` pattern (queryKey includes active profile), so the
  catalog panel invalidates on profile switch.
- **No new DB**: tool category metadata is compile-time constants; no SQLite rows
  required. Cron/MCP persistence is owned by their sibling plans.

## 5. Third-party library strategy

| Python dependency (feature) | TS equivalent | Evidence / notes |
|---|---|---|
| `orjson` / `json` (all tools) | native `JSON.parse`/`stringify` | No lib needed; kimi-code serializes with built-ins throughout `packages/agent-core/src/tools/`. |
| `xxhash` (registry lazy index fingerprint) | not needed — static module graph | kimi-code has no lazy AST index; TS imports tool modules statically (`packages/agent-core/src/tools/builtin/index.ts` barrel). If we add lazy chunks later, use `hash-wasm`'s xxhash64 (unverified in kimi-code). |
| `rapidfuzz` (todo fuzzy warnings) | not needed for catalog; if ported: `fastest-levenshtein` | kimi-code `todo-list.ts` does **no** fuzzy matching — simpler TS todo model; parity risk noted in §9. |
| `aiohttp` / `httpx` (HA, web, media APIs) | native `fetch` | kimi-code `tools/providers/moonshot-web-search.ts` uses `fetchImpl`; Tauri webview has fetch. |
| `mcp` SDK (integrations) | `@modelcontextprotocol/sdk` `^1.29.0` + own wrappers | kimi-code `packages/agent-core/package.json` (also `agent-core-v2`); its `src/mcp/{client-stdio,client-http,client-sse,connection-manager}.ts` wraps the SDK. Sibling mcp plan deep-dives. |
| `croniter` (cronjob) | self-contained parser — port `cron-expr.ts` from kimi-code | kimi-code `src/tools/cron/cron-expr.ts` computes next-fire in local time with no external cron lib; scheduler in `src/tools/cron/scheduler.ts`. Sibling cron plan owns this. |
| `regex` threat scanners (cronjob prompt) | JS `RegExp` (same patterns) | No kimi-code equivalent — Hermes-specific; port `_CRON_THREAT_PATTERNS`/`_CRON_EXFIL_COMMAND_PATTERNS` + invisible-unicode helpers verbatim. |
| `pybase64`/image decode (media) | browser `createImageBitmap`/`OffscreenCanvas`, `@sindresorhus/slugify` n/a | kimi-code `src/tools/support/{image-compress,webp-decode,image-limits}.ts`; sibling media plan. |
| `playwright` (browser) | `playwright` npm (via Rust-side? keep in Tauri) | kimi-code has **no** builtin browser tools — risk, see §9. Sibling browser plan. |
| `node-pty`/subprocess (terminal) | Tauri Rust `src/commands/*` pty + `@tauri-apps/api/shell` | `web/src/routes/console.tsx` already renders `EmbeddedTerminal`; sibling terminal-backends plan. |
| prompt/tool schema validation | `zod` + `ajv`/`ajv-formats` | kimi-code uses zod for tool input schemas and AJV at runtime (`toInputJsonSchema` in `src/tools/support/input-schema.ts`; `ajv` in agent-core deps). |
| glob/grep (files) | `picomatch` + ripgrep via Rust | kimi-code `src/tools/support/{path-glob-match,run-rg}.ts`; `picomatch` is an agent-core dep. |
| `pyyaml` config | `yaml` npm (or Tauri JSON) | Reused by existing desktop config path; keep current approach until config migrates to JSON. |

Explicit **no TS equivalent found** items to hand-port (see §9): (a)
`model_tools.py` argument-alias tables — hand-transcribed static maps; (b)
`<untrusted_tool_result>` wrapper + threat-scanning helpers — Hermes-only
architectural defense, no kimi-code analogue; (c) lazy AST tool-index — replaced
by static imports; (d) HA tools and `x_search` — no kimi-code equivalent at all.

## 6. Integration with existing Hermes-CN-Desktop frontend

- **Reuse transport shims today**: `web/src/lib/transport.ts` (HTTP routing +
  auth), `web/src/lib/gateway-client.ts` (WS JSON-RPC), `web/src/lib/tauri-bridge.ts`
  (Rust IPC). During migration the catalog can hydrate from the existing
  `/api/tools`-style surface; in-process registry replaces it later behind the
  same interface.
- **console.tsx** (`web/src/routes/console.tsx`) — the terminal family's UI
  already exists (`EmbeddedTerminal` + quick commands); the catalog panel should
  live near it and share `SectionShell`. `terminalOpenExternal` IPC is reused.
- **use-mcp.ts** (`web/src/hooks/use-mcp.ts`) — integration-family management
  today goes through `/api/mcp/*` REST + `reload.mcp` WS RPC; the catalog shows
  `mcp-<server>` toolsets as dynamic rows in the integrations category, wired to
  these hooks until the in-process MCP client (sibling plan) takes over.
- **use-cron.ts** (`web/src/hooks/use-cron.ts`) — automation category's
  jobs/runs UI; catalog panel links to it and reuses its query keys.
- **cli-delegation.ts** (`web/src/lib/cli-delegation.ts`) — already ported
  delegation classification (Claude Code / Codex) for terminal commands; the
  orchestration family reuses its `CliDelegationSpec` model when surfacing
  delegation events; the sibling delegation plan supersedes the Python
  `delegate_task` with an in-process subagent runtime.
- **Stores**: follow the Jotai + TanStack Query pattern of `use-mcp.ts`/
  `use-cron.ts` (profile-aware query keys) for `use-tools.ts`.

## 7. Removing the WebSocket dependency (migration path)

Frozen API surface during migration (same signatures as Python):

```ts
getToolDefinitions(enabledToolsets: string[], disabledTools: string[]): ToolDefinition[]
handleToolCall(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<string>
getAvailableCategories(): ToolCategory[]
setToolsetEnabled(toolset: string, enabled: boolean): void
```

- **Phase A (keep backend)**: Desktop UI renders categories from a new
  `catalog` module hydrated by existing REST (enabled toolsets + availability
  from `/api/tools`-style responses); all dispatch still crosses WS.
- **Phase B (in-process behind interface)**: `ToolRegistry` + `dispatch.ts`
  become the single `ToolGateway` used by the agent loop inside the webview;
  family handlers that need OS power call Tauri IPC; the same `handleToolCall`
  signature is served by both the TS gateway and (for compatibility) the WS
  fallback. UI switches to `use-tools.ts`; `/api/mcp/*` + `/api/cron/*` move to
  sibling plans' in-process clients.
- **Phase C (delete WS/REST tool surface)**: remove `reload.mcp`, tool-list and
  tool-dispatch WS/RPC handling; delete `getGatewayClient().request` call sites
  for tools; keep WS only for gateway status until the whole backend link is
  removed per the README goal.

## 8. Migration phases & task breakdown

1. **Catalog model** — `types.ts` + `categories.ts` + `toolsets.ts` with the
   eight categories and the toolset table from `toolsets.py`; unit tests for
   `getCategoryForTool`/`resolveCategoryToolsets`.
2. **Registry + gateway** — `registry.ts` + `dispatch.ts` (register/dispatch/
   getDefinitions, alias tables, `toolError` bounds, untrusted wrapper);
   parity tests vs `test_registry.py` + `test_tool_dispatch_helpers.py`.
3. **Availability gates** — `availability.ts` (HASS_TOKEN, x_search,
   code_execution sandbox, MCP connected); `checkToolsetRequirements()` parity.
4. **Family stubs + aggregation** — `families/index.ts` with `defineToolFamily`;
   each sibling plan fills `families/web.ts`, `terminal-files.ts`, `browser.ts`,
   `media.ts`, `orchestration.ts`, `memory-recall.ts`, `automation.ts`,
   `integrations.ts` (todo/clarify/execute_code/delegate_task/cron/HA/MCP).
5. **Catalog UI** — `use-tools.ts` + `ToolCatalogPanel` route reusing
   `SectionShell`; toggles persist via profile config (Phase A: existing config
   REST; Phase B: Tauri JSON in `src/state.rs`).
6. **WS migration** — Phase A → B → C per §7; delete WS tool surface last.
7. **Docs parity** — port `website/docs/user-guide/features/tools.md` category
   table into the desktop help/catalog copy.

## 9. Risks & open questions

- **No TS equivalent found**: (a) Python's `<untrusted_tool_result>` wrapper +
  threat-scanning result post-processing has no kimi-code analogue — must hand-port
  exactly (tests pin the embedded-tag breakout behavior); (b) `model_tools.py`
  alias tables are large hand-maintained maps — transcription drift risk, mitigated
  by a parity table test; (c) HA (`ha_*`) and `x_search` have no kimi-code
  equivalent — HA is simple fetch (low risk), `x_search` depends on xAI
  credentials/API shape (medium risk); (d) browser family has no kimi-code builtin
  — depends on Playwright/Rust choice in the sibling browser plan (high risk);
  (e) memory & session_search have no kimi-code session-search equivalent —
  may need SQLite FTS via Rust (medium).
- **Lazy index semantics**: Python's lazy AST tool-index + `tool_index.json` cache
  is replaced by static TS imports; startup cost moves from Python's ~700 ms to
  Vite bundling — acceptable, but `opaque_modules` (dynamic names, MCP) must be
  handled by the registry's dynamic registration path (as kimi-code's
  `registerMcpServer` does).
- **Category taxonomy drift**: docs table vs `toolsets.py` vs `TOOL_TO_TOOLSET_MAP`
  can disagree; the catalog must be generated from one source (proposal:
  `categories.ts` owns the mapping, with a parity test against a committed JSON
  snapshot of the Python toolset map).
- **TodoStore parity**: Python has fuzzy duplicate warnings, terminal-status
  clamping, verify-code-on-complete; kimi-code `todo-list.ts` is simpler — decide
  with the orchestration sibling whether to port the full Python semantics or
  adopt the simpler TS model (behavioral difference for the model).
- **Windows/frozen runtime**: `execute_code` is unavailable under the frozen
  desktop runtime (Python `SANDBOX_AVAILABLE=False`); the catalog availability
  gate must reproduce this so the UI shows "unavailable in desktop standalone".
- **Config ownership**: enabling/disabling toolsets currently edits
  `config.yaml`; switching to Tauri JSON must stay backward-compatible or the
  migration writes through the same config file until the backend is gone.

## 10. Test strategy

- **Vitest unit** (mirror Python parity):
  - `registry.test.ts` — register/dispatch roundtrip, unknown-tool JSON error,
    `getDefinitions` OpenAI shape, error-cap bounds (2048 chars) incl. direct
    non-conformant JSON handlers (parity: `test_registry.py`).
  - `dispatch.test.ts` — alias normalization per family (cmd→command,
    items→todos, filepath→path, delegate_task goal remap, cronjob action remap);
    untrusted classification + `<untrusted_tool_result>` wrapping + embedded
    closing-tag breakout + short-text pass-through (parity:
    `test_tool_dispatch_helpers.py`).
  - `categories.test.ts` — every tool in `_HERMES_CORE_TOOLS` maps to exactly one
    category; category→toolset resolution matches `toolsets.py` snapshot JSON.
  - `toolsets.test.ts` — `resolveToolset` composition/includes, validate failures.
  - Family-level parity lives in sibling plans (todo: `test_todo_tool.py`; file:
    `test_file_tools.py`; terminal: `test_terminal_tool.py`).
- **Integration**: catalog panel renders eight categories with correct
  availability badges for a mocked profile; toggling a toolset updates the Jotai
  store and calls the config persistence stub.
- **Playwright E2E**: open catalog route → expand "Agent orchestration" →
  shows todo/clarify/execute_code/delegate_task with toolset state; enable
  `homeassistant` shows the HASS_TOKEN gate badge.
- **No Python runtime**: after Phase C, all catalog/dispatch tests run without WS;
  a smoke test asserts zero `getGatewayClient().request` calls for tool paths.

## 11. Reference links

- Python: `D:/hermes-agent-cn/model_tools.py`, `tools/registry.py`,
  `toolsets.py`, `tools/todo_tool.py`, `tools/clarify_tool.py`,
  `tools/code_execution_tool.py`, `tools/delegate_tool.py`,
  `tools/cronjob_tools.py`, `tools/homeassistant_tool.py`, `tools/mcp_tool.py`,
  `agent/tool_dispatch_helpers.py`.
- Docs: `D:/hermes-agent-cn/website/docs/user-guide/features/tools.md`.
- Tests: `D:/hermes-agent-cn/tests/tools/test_registry.py`,
  `tests/tools/test_terminal_tool.py`, `tests/tools/test_file_tools.py`,
  `tests/tools/test_todo_tool.py`, `tests/agent/test_tool_dispatch_helpers.py`.
- TS reference: `D:/kimi-code/packages/agent-core/src/tools/builtin/`
  (`web/`, `shell/`, `file/`, `state/todo-list.ts`, `goal/`, `planning/`,
  `collaboration/ask-user.ts`, `collaboration/agent.ts`, `select-tools.ts`),
  `src/tools/providers/moonshot-web-search.ts`, `src/tools/store.ts`,
  `src/tools/cron/cron-expr.ts`, `src/agent/tool/{index.ts,types.ts}`
  (`ToolManager`), `src/loop/types.ts` (`ExecutableTool`/`ToolExecution`),
  `src/mcp/{client-stdio,client-http,client-sse,connection-manager}.ts`,
  `package.json` (`@modelcontextprotocol/sdk`, `ajv`, `picomatch`, `zod`).
- Desktop: `D:/Hermes-CN-Desktop/web/src/routes/console.tsx`,
  `web/src/hooks/use-mcp.ts`, `web/src/hooks/use-cron.ts`,
  `web/src/lib/cli-delegation.ts`, `web/src/lib/transport.ts`,
  `web/src/lib/gateway-client.ts`, `web/src/lib/tauri-bridge.ts`.
