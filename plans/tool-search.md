# Tool Search — Python → TypeScript Rewrite Plan

## 1. Summary

Tool Search is Hermes' **opt-in progressive-disclosure layer** for large MCP/plugin
tool surfaces. When enabled, MCP and non-core plugin tools are removed from the
model-visible `tools[]` array and replaced by three **bridge tools** —
`tool_search(query, limit?)`, `tool_describe(name)`, `tool_call(name, arguments)` —
so full parameter schemas only enter the context on demand. Core Hermes tools
(`terminal`, `read_file`, `write_file`, `patch`, `search_files`, `todo`, `memory`,
`browser_*`, `web_search`, `execute_code`, `delegate_task`, …) are **never** deferred.

This plan ports `D:/hermes-agent-cn/tools/tool_search.py` (1,078 lines) plus its
wiring in `model_tools.py` / `agent/tool_executor.py` to an in-process TypeScript
module under `web/src/lib/tools/tool-search/`, so the desktop webview can assemble
the model-facing tool array and dispatch the bridge **without** the Python backend
or the `/api/ws` link. The port keeps the Python user contract byte-for-byte
(three bridge tools, BM25 retrieval, tiered catalog listing, session-scoped
catalog, probe validation) and borrows the proven TS progressive-disclosure
machinery from `D:/kimi-code` (the `deferred` marker and message-level
`tools` declarations in `packages/kosong`) as an optional provider-native carrier.

## 2. Current Python implementation

- **Core module** — `D:/hermes-agent-cn/tools/tool_search.py`:
  - `ToolSearchConfig.from_raw()` — accepts legacy bool (`true` ⇒ `enabled:auto`,
    `false` ⇒ `off`) and dict shapes; clamps `threshold_pct` (0–100),
    `search_default_limit` (1..max), `max_search_limit` (1–50),
    `listing_max_tokens` (200–60000). Defaults: `enabled:auto`, `threshold_pct:5`,
    `search_default_limit:5`, `max_search_limit:20`, `listing:auto`,
    `listing_max_tokens:4000` (mirrored in
    `D:/hermes-agent-cn/hermes_cli/config_defaults.py` lines 2453–2499).
  - Classification: `_core_tool_names()` reads `toolsets._HERMES_CORE_TOOLS`
    (lazy import); `is_deferrable_tool_name(name)` ⇒ MCP toolset prefix (`mcp-*`)
    OR not in core list; bridge names are reserved. `classify_tools()` splits a
    tool-defs list into `(visible, deferrable)`; **unclassifiable tools stay
    visible** (OpenClaw #84141 regression guard — never silently drop).
  - Gate + tokens: `estimate_tokens_from_schemas()` uses the chars/4 rule
    (`CHARS_PER_TOKEN = 4.0`); `should_activate()` — `off` never activates,
    otherwise any deferrable tool activates (tiered disclosure, July 2026 plan;
    the threshold now bounds the *listing* only); `listing_token_budget()` =
    `min(listing_max_tokens, threshold_pct% of context)` (10K fallback).
  - Catalog + retrieval: `CatalogEntry` (name, description, schema, source,
    source_name, pre-tokenized `_tokens`); `_tokenize` (`[A-Za-z0-9]+` lower);
    `_entry_search_text` = name-with-separators + description + top-level param
    names (**schema bodies excluded**); inlined BM25 (`k1=1.5`, `b=0.75`);
    `search_catalog()` falls back to literal name-substring (0.1 weight) when
    BM25 yields no positive hits (zero-IDF protection, e.g. query "github" when
    every tool is `github_*`).
  - Listing: `_short_desc()` (first sentence ≤60 chars + `…`),
    `_listing_group_label()` (strips `mcp-`), `build_catalog_listing_with_form()`
    — deterministic per-server degradation `full → names → mixed/groups → none`,
    byte-stable so the request prefix stays cacheable.
  - Bridge schemas: `bridge_tool_schemas(deferred_count, listing, listing_form)`
    — three OpenAI function-calling tools; the listing (or per-server summary) is
    embedded in the `tool_search` description with form-specific wording.
  - Assembly: `assemble_tool_defs(tool_defs, *, context_length, config)` →
    `AssemblyResult {tool_defs, activated, deferred_count, deferred_tokens,
    threshold_tokens, tier, listing_form}`; idempotent (strips pre-existing
    bridge tools); tier 1 = full/names/mixed listing, tier 2 = groups/none.
  - Dispatch: `dispatch_tool_search()` → JSON `{query, total_available, matches:
    [{name, source, source_name, description[:400]}], available_sources, hint}`
    (empty-hit response keeps connected sources discoverable);
    `dispatch_tool_describe()` → `{name, description, parameters}`;
    `resolve_underlying_call()` → `(name, args, err)` (rejects bridge-name
    recursion and non-deferrable names; parses string `arguments`);
    `scoped_deferrable_names(tool_defs)` — session-scope gate;
    `validate_deferred_call_args()` — probe-validation (port of
    nearai/ironclaw#5149): a blind `tool_call` missing schema-`required` keys
    returns the parameter schema instead of dispatching into an opaque failure.
- **Orchestration wiring** — `D:/hermes-agent-cn/model_tools.py`:
  - `get_tool_definitions(..., skip_tool_search_assembly=False)` runs
    `assemble_tool_defs()` as the **last step** before returning (lines
    1069–1104, after schema sanitization), using `_resolve_active_context_length()`.
  - `handle_function_call()` (lines 1912–2098): bridge branch keyed on
    `is_bridge_tool(function_name)`; re-fetches the pre-assembly catalog with
    `skip_tool_search_assembly=True` (so the bridge doesn't search only itself),
    **scoped to the session's `enabled_toolsets`/`disabled_toolsets`**;
    `tool_call` is unwrapped and **recursed with the underlying name** so all
    pre/post hooks, guardrails, approval flows and result truncation fire against
    the real tool.
- **Executor unwrap** — `D:/hermes-agent-cn/agent/tool_executor.py`
  (`_tool_search_scoped_names(agent)` cache) so the display layer and trajectory
  recorder show the underlying tool, not `tool_call`.
- **Never-defer list** — `D:/hermes-agent-cn/toolsets.py` `_HERMES_CORE_TOOLS`
  (lines 31–92). Note it deliberately excludes desktop GUI affordances
  (`desktop_ui`/`project` toolsets) — the TS port must add those.
- **Docs** — `D:/hermes-agent-cn/website/docs/user-guide/features/tool-search.md`
  (tiered disclosure table, config table, trade-offs: one extra cold round trip,
  no system-prompt cache benefit for deferred schemas, model-quality dependence,
  toolset edits invalidate cache).
- **Tests to mirror** — `D:/hermes-agent-cn/tests/tools/test_tool_search.py`
  (618 lines; class list in §10).

Data flow today: `run_agent`/`cli` → `model_tools.get_tool_definitions()` (bridge
assembly) → LLM sees 3 bridge tools → model calls `tool_search`/`tool_describe`
inline or `tool_call` unwrapped → `handle_function_call()` → next turn. The
desktop reaches this over Dashboard REST/WS today (`use-mcp.ts` lists servers,
`gateway-client.ts` carries turns).

## 3. Target TypeScript design

New in-process module family `web/src/lib/tools/tool-search/` (no Python):

- `config.ts` — `ToolSearchConfig` (immutable class) + `fromRaw(raw)` port with
  identical clamping + legacy-bool shapes; `loadConfig()` reads the profile
  config store (keys `tools.tool_search.*`, already translated in
  `web/src/lib/config-translations.ts` lines 346–349).
- `types.ts` — `CatalogEntry`, `AssemblyResult`, `ToolDef` (OpenAI function shape),
  bridge result types (`ToolSearchResponse`, `ToolDescribeResponse`).
- `classify.ts` — `CORE_TOOL_NAMES: Set<string>` port of `_HERMES_CORE_TOOLS`
  **plus** the desktop-only never-defer names (`desktop_ui`, `project`,
  `read_terminal`, `open_preview`, … — the GUI toolsets the desktop gateway
  enables per `tui_gateway/server.py::_load_enabled_toolsets`);
  `isDeferrableToolName(name)`; `classifyTools(toolDefs)` — unknown names stay
  visible (OpenClaw guard).
- `retrieval.ts` — `tokenize`, `entrySearchText`, `estimateTokensFromSchemas`
  (chars/4), inlined `bm25Score` (k1=1.5, b=0.75), `searchCatalog` with
  name-substring fallback. **No third-party dep** (see §5).
- `catalog.ts` — `buildCatalog`, `shortDesc` (first sentence ≤60 chars),
  `buildCatalogListingWithForm` (deterministic per-server degradation,
  byte-stable sort).
- `bridge.ts` — `bridgeToolSchemas(deferredCount, listing, listingForm)` —
  byte-faithful port of the three bridge schemas + embedded-listing wording.
- `assemble.ts` — `assembleToolDefs(toolDefs, {contextLength, config})` →
  `AssemblyResult`; idempotent; tier 1/2 assignment.
- `dispatch.ts` — `dispatchToolSearch`, `dispatchToolDescribe`,
  `resolveUnderlyingCall`, `scopedDeferrableNames`, `validateDeferredCallArgs`,
  `isBridgeTool`.
- `hooks/use-tool-search.ts` — React surface: config read/write, derived
  `deferredCount`/`tier` for the settings UI.

The module is **pure** — given a registry snapshot (`ToolDef[]` + enabled/
disabled toolsets) it rebuilds the catalog from scratch on every assembly
(stateless across turns, the OpenClaw #84141 lesson). The tool registry it reads
is the in-process `ToolRegistry` from the `tool-categories.md` plan
(`web/src/lib/tools/registry.ts`).

In-process data flow (end state): session turn loop → `assembleToolDefs(registry
snapshot, config)` → LLM gets 3 bridge tools → model calls `tool_search` /
`tool_describe` (pure catalog reads) or `tool_call` (unwrapped →
`registry.dispatch(underlyingName, args)` with scope gate) → result JSON → next
turn. `tool_call` recursion is replaced by a direct dispatch to the underlying
handler so hooks fire on the real name.

**Provider-native carrier (adopted from kimi-code, Phase 6):** when the active
model's capability catalog declares `dynamically_loaded_tools`, schemas loaded
via `tool_describe` may be attached as a `role:'system'` message with a `tools`
field (`messages[].tools`), and the corresponding entries carry the `deferred`
marker so `generate()` strips them from the top-level `tools[]` — keeping the
top-level array byte-stable for prompt caching. Providers without that capability
keep the Python behavior (schema returned as a JSON tool result).

## 4. Data models & persistence

- **No persisted catalog state.** The deferred catalog is rebuilt from the
  current tool-defs list every assembly — no session-keyed `Map` (OpenClaw
  #84141 regression class). The only durable state is the **config**.
- **Config** — `tools.tool_search.*` lives in the profile config (YAML managed by
  Rust `src/commands/config_migration.rs` + settings store). Existing desktop
  translation keys: `config-translations.ts:346-349` (`enabled`,
  `max_search_limit`, `search_default_limit`, `threshold_pct`); add
  `listing`, `listing_max_tokens` keys. No schema migration — additive keys.
- **Loaded-schema state (Phase 6 only)** — when using message-level `tools`
  declarations, the loaded set rides inside the session transcript
  (`role:'system'` messages with `origin: {kind:'injection',
  variant:'dynamic_tool_schema'}`), exactly like
  `packages/agent-core/src/agent/context/dynamic-tools.ts`. It is re-derived by
  scanning history (`collectLoadedDynamicToolNames`), never stored separately —
  undo/compaction/resume self-heal. The session transcript is already persisted
  by the desktop session archive (`src/session_archive.rs`,
  `web/src/lib/session-archive` tooling); no new table.
- **Scope data** — bridge dispatch reads the session's `enabledToolsets` /
  `disabledToolsets` from session state (Jotai `stores/chat.ts` /
  `stores/subagents.ts`) and passes them into `assemble`/`dispatch`, mirroring
  `model_tools.handle_function_call(..., enabled_toolsets=...)`.

## 5. Third-party library strategy

The Python feature uses **only stdlib** (`orjson`, `re`, `math`, `dataclasses`),
so there is no third-party Python dependency to map. Still, cite equivalents:

| Python | TS equivalent | kimi-code evidence |
| --- | --- | --- |
| `orjson` (fast JSON) | `JSON.stringify`/`JSON.parse`; schemas already serialized via `packages/protocol` Zod | `packages/kosong` serializes wire bodies with plain `JSON.stringify` |
| `re` (`[A-Za-z0-9]+`, sentence split) | built-in `RegExp` | `dynamic-tools.ts` uses regex `/<tools_added>/` folding |
| `math` (ceil, log) | `Math.ceil` / `Math.log` | — |
| `dataclasses` | TS classes / plain interfaces + Zod (`packages/protocol`) | kimi uses `zod` for `SelectToolsInputSchema` (`select-tools.ts:30`) |
| BM25 retrieval | **implement from scratch** (~40 lines) — no npm dep; optionally `wink-bm25-text-search` but keep zero-dep for byte parity | kimi's `select_tools` loads **by exact name** from `<tools_added>` announcements — **no search/BM25 equivalent exists** |
| Registry lookup (`tools.registry.get_entry`, toolset prefix) | in-process `ToolRegistry` from `tool-categories.md` plan (`web/src/lib/tools/registry.ts`) | `ToolManager` in `packages/agent-core/src/agent/tool/index.ts` |

**kimi-code progressive-disclosure evidence to reuse (structure, not code):**
- `Tool.deferred?: true` marker — `packages/kosong/src/tool.ts` (client-internal,
  never reaches the wire).
- Single strip point at `generate()` — `packages/kosong/src/generate.ts` lines
  111–117 (`wireTools = tools.some(t=>t.deferred) ? tools.filter(t=>!t.deferred)
  : tools`; identical array passthrough when nothing deferred).
- Capability bit `dynamically_loaded_tools` — `packages/kosong/src/capability.ts`
  (defaults `false` on `UNKNOWN_CAPABILITY`).
- Single decision gate — `packages/agent-core/src/agent/index.ts` lines 268–286
  (`toolSelectEnabled = capability.dynamically_loaded_tools === true &&
  capability.tool_use && experimentalFlags.enabled('tool-select')`).
- Executable-table split — `packages/agent-core/src/agent/tool/index.ts` lines
  975–1025 (`loopTools` keeps core + `select_tools` top-level, loaded dynamic
  tools as `deferred` extras; denylist still wins over the gate).
- Protocol context helpers — `packages/agent-core/src/agent/context/
  dynamic-tools.ts` (`DYNAMIC_TOOL_SCHEMA_VARIANT`, `LOADABLE_TOOLS_TRIGGER`,
  `foldAnnouncedToolNames`, `stripDynamicToolContext`).
- Turn-boundary announcements — `packages/agent-core/src/agent/injection/
  tools-diff.ts` (`<tools_added>/<tools_removed>` diffs; history IS the ledger).

**Deliberate divergence from kimi-code:** kimi's design replaces schemas with a
single exact-name `select_tools` + announcements; the Python feature (and this
port) keeps the **search/describe/call bridge** as the user contract because the
docs, tests and live-benchmark wording in `features/tool-search.md` depend on it.
The kimi machinery is only adopted as the wire carrier for loaded schemas where
the provider supports it.

## 6. Integration with existing Hermes-CN-Desktop frontend

- **New hooks/lib**: `web/src/lib/tools/tool-search/*` (pure) +
  `web/src/hooks/use-tool-search.ts` (TanStack Query config + derived tier).
- **Reuse `use-mcp.ts`** (`web/src/hooks/use-mcp.ts`) — it already provides
  dynamic tool discovery via `/api/mcp/*` (server list, test-connection lists
  tools via `McpToolInfo`); the in-process registry's MCP toolsets are seeded
  from the same data during migration. `use-mcp-servers.ts` remains the
  health-panel source.
- **Settings UI**: `web/src/routes/settings.tsx` tools section gains a
  "Tool Search" panel (enabled/auto/off, threshold %, search limits, listing
  mode). Keys already translated; add `listing`/`listing_max_tokens` to
  `config-translations.ts`. Writes go through the existing config-update path
  (`web/src/hooks/use-config.ts` / `REST /api/config` today, in-process store
  later).
- **Protocol types** (`packages/protocol/src/hermes-api.ts`): add
  `ToolSearchConfigSchema`, `ToolSearchResponse`, `ToolDescribeResponse`,
  `DeferredToolDef` (OpenAI `{type:'function', function:{...}}` with optional
  `deferred` marker), and reuse `ToolsetInfo` (line 727) / `McpToolInfo` (line
  780) for listings.
- **Activity feed unwrap**: the chat UI shows the underlying tool name, not
  `tool_call` — reuse the existing tool-result rendering path and route
  `resolveUnderlyingCall` output into it (mirrors Python's
  `agent/tool_executor.py` unwrap). Gateway events flow through
  `web/src/lib/gateway-client.ts` until Phase 7.
- **Rust**: no new Tauri commands. Existing `src/commands/` config/session
  commands keep working; the tool-search logic is pure TS.

## 7. Removing the WebSocket dependency (migration path)

Today the bridge lives in Python behind `get_tool_definitions()` +
`handle_function_call()` reached via Dashboard REST/WS. Migration in phases:

1. **Freeze the API surface** (before any code):
   - Bridge tool names + schemas: `tool_search(query, limit?)`,
     `tool_describe(name)`, `tool_call(name, arguments)` — never renamed.
   - JSON shapes: search `{query, total_available, matches[], available_sources?,
     hint?}`; describe `{name, description, parameters}`; probe error
     `{error, parameters, hint}`; `tool_call` unwrap semantics.
   - Config keys `tools.tool_search.{enabled,threshold_pct,search_default_limit,
     max_search_limit,listing,listing_max_tokens}`.
2. **Keep backend today**: build the TS module as a pure library; unit/parity
   tests run without Python; settings UI can preview `deferred_count`/`tier`
   from a local assembly of the registry snapshot.
3. **In-process module behind the same interface**: once the agent-loop
   rewrite (sibling plans: `agent-loop-llm-adapters.md`, `tool-categories.md`)
   owns tool assembly + dispatch, swap the WS-backed assembly for
   `assembleToolDefs()` and the WS tool-call path for `dispatch.ts`.
4. **Delete WS/REST path**: remove `/api/tools`-equivalent calls and the bridge
   branch of gateway turn handling; keep `/api/mcp/*` only for server CRUD until
   MCP is in-process.

## 8. Migration phases & task breakdown

- **M0 — Parity harness**: port the 11 Python test classes to vitest (§10);
  golden fixtures (catalog JSON → expected search/describe/assembly output).
- **M1 — Config + classification**: `config.ts`, `classify.ts`,
  `CORE_TOOL_NAMES` (incl. desktop-only toolsets), token estimator.
- **M2 — Catalog + retrieval + listing**: `retrieval.ts`, `catalog.ts`
  (BM25, substring fallback, per-server degradation, byte-stable rendering).
- **M3 — Bridge schemas + assembly**: `bridge.ts`, `assemble.ts` (idempotent,
  tier assignment).
- **M4 — Dispatch**: `dispatch.ts` (search/describe/call + scope gate +
  probe validation + unwrap).
- **M5 — Desktop integration**: protocol schemas, `use-tool-search.ts`,
  settings panel, activity-feed unwrap.
- **M6 — Provider-native carrier (kimi-style, optional)**: `deferred` marker +
  message-level `tools` declarations for capability-supporting models.
- **M7 — Cutover**: freeze + delete WS/REST path (§7 step 4).

## 9. Risks & open questions

- **No TS BM25 equivalent**: kimi-code's progressive disclosure is exact-name
  (`select_tools`), not search — BM25 + substring fallback must be written from
  scratch. Mitigation: zero-dep, inlined, ported directly from Python with
  golden-fixture parity; small catalog (typically <500 entries) makes perf a
  non-issue.
- **Embedded-listing wording is behavioral, not just cosmetic**: live
  benchmarks in the docs show the listing (and its per-form framing) is what
  prevents models from claiming capabilities are unavailable. The TS port must
  reproduce `bridgeToolSchemas` descriptions byte-faithfully (target: golden
  snapshot tests on the tool_search description text).
- **Provider capability uncertainty**: the desktop does not yet own LLM calls;
  whether the target providers expose `messages[].tools` /
  `dynamically_loaded_tools` (kosong capability catalog) is unverified until the
  in-process LLM adapters land. Until then, keep the Python-compatible
  "schema-in-result" behavior as the safe default.
- **Never-defer set differs per surface**: `_HERMES_CORE_TOOLS` deliberately
  excludes desktop GUI tools (`desktop_ui`, `project`, `read_terminal`,
  `open_preview`). The TS `CORE_TOOL_NAMES` must be the union, or the desktop
  would defer its own UI affordances.
- **Scope leakage**: the session-scope gate (`enabled_toolsets`) is a security
  invariant (test `TestRegression_ToolsetScoping`); the in-process registry must
  thread scope into both assembly and dispatch, or a subagent could call
  out-of-scope tools via `tool_call`.
- **Stale Python comment**: `model_tools.py:1072` still says "default 10% of
  context" while `config_defaults.py`/docs say 5% — follow the config defaults.
- **Open question**: should Phase 6 (message-level tools) also adopt kimi's
  `<tools_added>/<tools_removed>` announcements for the loaded set, or keep the
  Python `tool_describe`-returns-schema contract? Recommend: keep search bridge
  as primary; add announcements only for providers that support dynamic loading,
  scoped by the same gate.

## 10. Test strategy

vitest unit tests (mirror `tests/tools/test_tool_search.py` class-for-class):

- `TestConfigParsing` — defaults, legacy bool shapes, clamping.
- `TestClassification` — core tools never defer (sample list + desktop-only
  names), bridge names never defer, unknown tool not deferrable, classify keeps
  unknown in visible (OpenClaw #84141 guard).
- `TestThresholdGate` — `off` never activates; token estimate proportional to
  schema size.
- `TestRetrieval` — BM25 relevance (`searchCatalog(catalog, "create a github
  issue")` ⇒ `github_create_issue` first), `limit` respected, substring fallback
  for zero-IDF queries.
- `TestAssembly` — pure-core passthrough (no bridge), idempotent when bridge
  already present, tier/listing_form assignment.
- `TestBridgeDispatch` — query required; empty search returns
  `total_available` + `available_sources` + `hint`; `resolveUnderlyingCall`
  rejects recursion and non-deferrable names.
- `TestHandleFunctionCallIntegration` — dispatch through the in-process
  `handleToolCall`; exactly one terminal `post_tool_call` hook with correct ids.
- `TestRegression_OpenClawCron84141` — core survives alongside many MCP tools;
  unwrap rejects core-tool attempts.
- `TestRegression_ToolsetScoping` — catalog scoped to session toolsets;
  `scopedDeferrableNames` excludes core.
- `TestCatalogListing` — default cap bounds bridge overhead (<4500 estimated
  tokens for 500 tools), `shortDesc` first-sentence + clip, `listing:"off"`
  keeps legacy description.
- `TestDeferredCallSchemaProbe` — missing required args returns schema; unknown
  tool never blocks; valid call dispatches.

Parity: run identical fixture catalogs through Python and TS, diff JSON outputs
(golden files). Playwright E2E (`e2e/`, local fake model): settings panel toggles
`tools.tool_search`; a chat turn exercises search → describe → call and asserts
the activity feed shows the underlying tool, not `tool_call`; a server with many
tools reports tier/deferred count in settings.

## 11. Reference links

- Python: `D:/hermes-agent-cn/tools/tool_search.py`,
  `D:/hermes-agent-cn/model_tools.py` (assembly 1069–1104, bridge dispatch
  1912–2098), `D:/hermes-agent-cn/agent/tool_executor.py`
  (`_tool_search_scoped_names`), `D:/hermes-agent-cn/toolsets.py`
  (`_HERMES_CORE_TOOLS`), `D:/hermes-agent-cn/hermes_cli/config_defaults.py`
  (2453–2499).
- Docs: `D:/hermes-agent-cn/website/docs/user-guide/features/tool-search.md`.
- Tests: `D:/hermes-agent-cn/tests/tools/test_tool_search.py`.
- kimi-code: `packages/kosong/src/tool.ts`, `generate.ts`, `capability.ts`,
  `message.ts`; `packages/agent-core/src/agent/index.ts` (toolSelectEnabled),
  `agent/tool/index.ts` (loopTools), `tools/builtin/select-tools.ts`,
  `agent/context/dynamic-tools.ts`, `agent/injection/tools-diff.ts`,
  `flags/registry.ts`; tests `packages/kosong/test/select-tools.test.ts`,
  `packages/agent-core/test/agent/tool-select.e2e.test.ts`.
- Desktop: `web/src/hooks/use-mcp.ts`, `web/src/lib/config-translations.ts`
  (346–349), `packages/protocol/src/hermes-api.ts` (ToolsetInfo 727, McpToolInfo
  780), `web/src/routes/settings.tsx`, `web/src/lib/gateway-client.ts`,
  `web/src/lib/transport.ts`.
- Sibling plans: `plans/tool-categories.md` (in-process registry/dispatch),
  `plans/agent-loop-llm-adapters.md` (provider adapters + capability gate).
