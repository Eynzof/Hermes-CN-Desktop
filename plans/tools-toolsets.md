# Tools & Toolsets — Python → TypeScript Rewrite Plan

## 1. Summary

Port the Hermes built-in **tool registry + toolset system** from the Python runtime
(`D:/hermes-agent-cn`) into the TypeScript desktop monorepo so the agent runs
fully in-process with no WebSocket link to the managed Python runtime. The feature
surface is:

- **~83 built-in tools grouped into toolsets** (registry-derived; never hardcode the count).
- **Per-platform enable/disable** persisted like Core's `platform_toolsets` config
  (platforms today: `cli`, `telegram`, `discord`, `cron`, `api-server`, …; the desktop
  standalone primarily exercises `cli` + the GUI-session toolsets `desktop_ui`/`project`).
- **`hermes tools` curses UI** → a React management route (Capabilities → Tools) plus
  non-interactive `tools list|enable|disable` CLI parity.
- **`/tools` and `/toolsets` in-session slash commands** in the desktop composer.
- **Custom toolsets** (`custom_toolsets` in config) and the **`all` / `*` wildcard**.
- **Capability-gated** tools (browser/computer_use/Home Assistant/x_search: enabled only
  when their check_fn-equivalent passes) and **workflow-gated** tools (the `kanban`
  toolset: deliberately opt-in, NOT enabled by `all`/`*`).

Design decision: keep `config.yaml` (or a strict local mirror) as the single source of
truth for tool configuration so existing user configs keep working during migration;
the in-process TS `ToolRegistry` + `ToolsetResolver` replace `tools/registry.py` +
`toolsets.py` behind the same interface the agent loop consumes.

## 2. Current Python implementation

Source of truth is the CN Core runtime. Data flow today:
`config.yaml platform_toolsets.<platform>` → `_get_platform_tools()` → `resolve_toolset()`
→ `registry.get_definitions()` (check_fn-filtered) → OpenAI-format schema list → model.
Dispatch goes through `handle_function_call()` → `registry.dispatch()`.

Key files (all under `D:/hermes-agent-cn`):

- **`tools/registry.py`** — `ToolRegistry`, `ToolEntry` (name, toolset, schema, handler,
  check_fn, requires_env, is_async, description, emoji, max_result_size_chars,
  dynamic_schema_overrides); `registry.register()` self-registration; lazy tool index
  (AST scan of `tools/*.py` → `tool name → module`, disk-cached in
  `~/.hermes/cache/tool_index.json`); `check_fn` TTL cache (30 s, with a 60 s
  last-good grace window for flaky probes); `registry.get_definitions(tools, quiet)`
  returns only schemas whose check_fn passes.
- **`model_tools.py`** — `get_tool_definitions(enabled_toolsets, disabled_toolsets,
  quiet_mode, skip_tool_search_assembly)` with an 8-entry LRU memo keyed on
  (profile scope, enabled/disabled frozensets, registry generation, config mtime
  fingerprint, kanban/env flags, shell type); `_compute_tool_definitions()` resolves
  enabled toolsets (incl. `all`/`*`), subtracts disabled toolsets (with
  `bundle_non_core_tools()` for `hermes-*`/posture bundles so core tools survive),
  then rebuilds dynamic schemas (execute_code sandbox list, discord intents);
  `handle_function_call()`; legacy `_LEGACY_TOOLSET_MAP`; `TOOL_TO_TOOLSET_MAP`,
  `TOOLSET_REQUIREMENTS`.
- **`toolsets.py`** — `TOOLSETS` dict (~30 core/composite/platform toolsets + `hermes-*`
  platform bundles, `coding` posture toolset, `desktop_ui`, `project`, `kanban`);
  `get_toolset()` (merges registry-registered tools), `resolve_toolset()` (recursive
  `includes`, cycle-safe, special `all`/`*` handling that unions every toolset),
  `resolve_multiple_toolsets()`, `validate_toolset()`, `create_custom_toolset()`,
  `get_all_toolsets()`, `bundle_non_core_tools()`, `get_toolset_info()`.
- **`hermes_cli/tools_config.py`** — the `hermes tools` TUI: `PLATFORMS`,
  `CONFIGURABLE_TOOLSETS` (display labels with emoji), `TOOL_CATEGORIES` (provider-aware
  config: tts/stt/web/image_gen/video_gen…), `_get_platform_tools(config, platform)`
  (reverse-maps composites → configurable keys, applies `_DEFAULT_OFF_TOOLSETS`,
  `_TOOLSET_PLATFORM_RESTRICTIONS`, auto-enables `x_search`/`homeassistant` on
  credentials, recovers non-configurable toolsets, handles plugin toolsets via
  `known_plugin_toolsets`, `context_engine` default, MCP server names + `no_mcp`
  sentinel, final `agent.disabled_toolsets` override), `_save_platform_tools()`
  (persists `platform_toolsets.<platform>` + `known_*` maps + reconciles
  `agent.disabled_toolsets`), `tools_command()` (curses radiolist/checklist menu loop,
  per-platform + global + reconfigure + MCP), `_prompt_toolset_checklist()` with live
  token estimation via `tiktoken` (cl100k_base), `tools_disable_enable_command()`
  (`list|enable|disable`, MCP `server:tool` notation).
- **`hermes_cli/subcommands/tools.py`** — `hermes tools [--summary] [list|enable|disable
  <name…> [--platform X]] [post-setup <key>]` CLI parser.
- **`tui_gateway/server.py::_load_enabled_toolsets()`** — per-session toolset selection
  for GUI/desktop sessions: coding posture (`agent/coding_context.py`), `HERMES_TUI_TOOLSETS`
  env, and `_gui_surface_toolsets()` which folds `desktop_ui` + `project` in for
  desktop-sourced sessions — the per-platform gating the desktop must reproduce.
- **`hermes_cli/web_routers/tools.py`** — Dashboard REST surface the desktop calls today:
  `GET /api/tools/toolsets`, `PUT /api/tools/toolsets/{name}`, `GET …/config`,
  `GET …/models`, `PUT …/model`, `PUT …/provider`, `PUT …/env`, `POST …/post-setup`,
  plus terminal-backend and computer-use endpoints.
- **`hermes_cli/commands.py`** — `/tools` slash command (TUI), wired to
  `tools_disable_enable_command`.
- **`toolset_distributions.py`** — data-generation batch distributions (probabilistic
  toolset sampling). Out of scope for the desktop standalone; kept as a reference only.

## 3. Target TypeScript design

New in-process module `packages/agent-tools` (consumed by `web/src` and later the
in-process agent loop). No Python backend, no WS.

```
packages/agent-tools/src/
├── registry.ts          # ToolRegistry + ToolEntry + register() + lazy module loading
├── toolsets.ts          # TOOLSETS catalog, resolveToolset, resolveMultipleToolsets,
│                        #   validateToolset, custom toolsets, all/* wildcard
├── platform-config.ts   # getPlatformTools / savePlatformTools (config.yaml parity)
├── gates.ts             # checkFn-equivalent async capability probes + workflow gates
├── catalog.ts           # the ~83 built-in tool definitions (zod schema + handler ref)
├── dispatch.ts          # handleToolCall(name, args, ctx) → native handler / Rust IPC
└── token-estimate.ts    # per-tool token estimation for the checklist status line
```

Core interfaces (pseudocode — design only):

```ts
interface ToolEntry {
  name: string; toolset: string; schema: Record<string, unknown>;
  handler: (args: unknown, ctx: ToolContext) => Promise<ToolResult>;
  checkFn?: () => boolean | Promise<boolean>;      // capability gate
  requiresEnv?: string[]; isAsync?: boolean; description?: string; emoji?: string;
  dynamicSchemaOverrides?: () => Record<string, unknown>;
}
class ToolRegistry {
  register(entry: ToolEntry): void;
  getDefinitions(toolNames: Set<string>): ToolDefinition[];  // checkFn-filtered
  dispatch(name: string, args: unknown, ctx: ToolContext): Promise<ToolResult>;
  getToolToToolsetMap(): Map<string, string>;
  // generation counter invalidates getToolDefinitions memo (parity w/ Python)
}
interface ToolsetDef { description: string; tools: string[]; includes: string[];
                        posture?: boolean; module?: string; }
function resolveToolset(name: string, opts?: { includeRegistry?: boolean }): string[];
function resolveMultipleToolsets(names: string[]): string[];
function validateToolset(name: string): boolean;
function getToolDefinitions(enabledToolsets?: string[], disabledToolsets?: string[],
                            opts?: { quiet?: boolean }): ToolDefinition[];
```

Resolution/selection pipeline (mirrors Core exactly):

1. `getPlatformTools(config, platform)` → enabled toolset keys (composite
   reverse-mapping, default-off list, platform restrictions, credential auto-enable,
   non-configurable recovery, MCP allowlist, `agent.disabled_toolsets`).
2. `resolveToolset` on each key (incl. `all`/`*`) → tool name set; subtract disabled.
3. `registry.getDefinitions(names)` — capability gates (`checkFn`) run per toolset
   with a 30 s TTL cache; only passing tools are returned.
4. Workflow gate: `kanban` toolset is only resolved when explicitly listed or when a
   kanban-worker context flag is set — `all`/`*` skips it (parity with Core).

The in-process agent loop (future `packages/agent-core` equivalent in this repo) calls
`getToolDefinitions(enabledToolsets, disabledToolsets)` exactly like
`model_tools.get_tool_definitions`, with the same memoization (keyed on enabled/
disabled sets + registry generation + config fingerprint).

UI design:

- **`web/src/routes/tools.tsx`** — Capabilities → 工具 page. Tabs:
  - **Toolsets** — grouped checklist (reuses `CONFIGURABLE_TOOLSETS` labels), per
    platform selector (cli / cron / api-server / messaging when present), live token
    estimate status line, `all` wildcard toggle, custom-toolset editor.
  - **Tools** — read-only catalog grouped by toolset (~83 rows: name, description,
    requires-env, capability/workflow gate badge), search + enabled/disabled filter.
  - **Custom** — create/edit `custom_toolsets` bundles (name + tool picker + includes).
- **`web/src/lib/tools-commands.ts`** — `/tools list|enable|disable <name>` and
  `/toolsets list|enable|disable|create` slash commands registered in the composer
  palette (`builtin-commands.ts`), dispatching to `platform-config.ts` then
  invalidating the tools query cache.
- **TUI fallback** — the Hermes Console route (`/console`) keeps the ability to run
  `hermes tools` against the managed runtime during migration; after cutover it runs
  the in-process `tools list|enable|disable` CLI handler.

## 4. Data models & persistence

Source of truth: `~/.hermes/config.yaml` (managed by Rust `serde_yaml`, already a
desktop dependency), preserved byte-compatible with Core so existing users keep their
tool configuration. During migration the Rust side owns read/write; after cutover the
TS `platform-config.ts` talks to a small Rust command (`tools_config_read/write`) until
the config layer is fully in-process.

```yaml
# config.yaml keys to honor (parity with Core)
platform_toolsets:
  cli: [hermes-cli, spotify]
  cron: [hermes-cli]
  discord: [hermes-discord]
known_plugin_toolsets: { cli: [spotify] }
known_builtin_toolsets: { cli: [web, browser, …] }
agent:
  disabled_toolsets: [video, video_gen]     # global override, applied last
custom_toolsets:
  data-science: [file, terminal, code_execution, web, vision]
mcp_servers: …                              # dynamic mcp-<server> toolsets
```

Zod schemas (extend `packages/protocol/src/hermes-api.ts`; `ToolsetInfo` already
exists at line 727):

```ts
export const PlatformToolsetsConfig = z.object({
  platform: z.string(),                       // cli | cron | api-server | …
  enabled: z.array(z.string()),               // toolset keys (composite or leaf)
});
export const CustomToolset = z.object({
  name: z.string(),
  tools: z.array(z.string()).default([]),
  includes: z.array(z.string()).default([]),
  description: z.string().default(""),
});
export const ToolCatalogEntry = z.object({   // in-process only; mirrors ToolsetInfo
  name: z.string(), toolset: z.string(), description: z.string(),
  requiresEnv: z.array(z.string()).default([]),
  gate: z.enum(["none", "capability", "workflow"]).default("none"),
  enabled: z.boolean(),
});
```

Persistence strategy: no SQLite/IndexedDB for tool config — YAML file is authoritative;
an in-memory `ToolConfigStore` (Jotai atom + TanStack Query) is the runtime mirror and is
invalidated by the registry generation counter. `custom_toolsets` is read from the same
YAML and injected into the resolver as an overlay (Core mutates `TOOLSETS` in memory via
`create_custom_toolset`; we persist instead).

## 5. Third-party library strategy

| Python dependency | TS equivalent | Evidence / risk |
|---|---|---|
| `tools/registry.py` self-registration + lazy index | Implement from scratch: `ToolRegistry` + dynamic `import()` of tool modules (no AST needed — TS has static imports) | kimi-code `packages/agent-core/src/agent/tool/index.ts` `ToolManager` (maps + `setActiveTools`) is the closest analogue, but its registration is explicit class instances, not AST discovery |
| `toolsets.py` resolver | Implement from scratch: `resolveToolset` (DFS includes, cycle-safe, `all`/`*`) | No TS equivalent in kimi-code (kimi-code uses flat `setActiveTools` allowlist, no nested toolset composition) |
| `curses` (`curses_ui.py` radiolist/checklist) | No direct TS equivalent. Desktop: React route with checkbox groups + status footer. Optional terminal fallback: `@clack/prompts` | kimi-code ships its own TUI (`packages/pi-tui`) — we reuse the existing React UI instead of porting curses; mark as no-equivalent risk |
| `tiktoken` (cl100k_base token estimate) | `@tiktoken/tiktoken` (official wasm port) OR approximate `chars/4` fallback | **No TS equivalent found in kimi-code** (grep of kimi-code package.json for tiktoken: none). Risk: exact parity of the token-count status line |
| `PyYAML` config | Rust `serde_yaml` (already in `Cargo.toml`) or `yaml` npm | Desktop already depends on `serde_yaml 0.9`; keep config.yaml authoritative in Rust during migration |
| `orjson` | native `JSON.stringify` / `structuredClone` | trivial |
| picomatch (MCP `mcp__*` glob gating) | `picomatch` npm | kimi-code `agent/tool/index.ts` imports `picomatch@^4.0.4` for `mcpAccessPatterns`/`mcpDenyPatterns` |
| Tool-arg JSON Schema validation | `ajv` + `ajv-formats` (draft-07/2019/2020) | kimi-code `packages/agent-core/src/tools/args-validator.ts` |
| Tool schema authoring | `zod` + `toInputJsonSchema` | kimi-code `packages/agent-core/src/tools/builtin/*` (zod `^4.3.6`); desktop already uses zod in `packages/protocol` |
| `check_fn` availability probes | async probes with 30 s TTL cache (no lib) | Port each Python probe (docker daemon, CDP reachable, creds present, cua-driver on PATH) as `checkFn`; flaky-probe grace window parity |
| `portable-pty` terminal execution | Rust `src/commands/terminal.rs` (already exists) | Desktop Rust has native pty; reuse as `terminal`/`process` tool backend via Tauri IPC |
| `toolset_distributions.py` | Out of scope (batch data-gen only) | No desktop consumer; skip |

## 6. Integration with existing Hermes-CN-Desktop frontend

Reuse (do not duplicate):

- **`web/src/lib/transport.ts`** (`fetchJSON`) + `web/src/hooks/use-skills.ts` pattern →
  new `web/src/hooks/use-tools.ts` (`useToolsets`, `useToggleToolset`,
  `useToolsetConfig`, `useCustomToolsets`) with identical TanStack Query key +
  invalidation shape.
- **`web/src/routes/skills.tsx`** as the page blueprint (TopBar + PageTabs + split
  list/detail + profile scope banner). A new `web/src/routes/tools.tsx` mirrors it.
- **`web/src/components/app-shell/capability-sidebar.tsx`** — add `{ label: "工具",
  path: "/tools", icon: Wrench }` to `CONFIG_ITEMS`; wire tab switching in
  `app-sidebar.tsx`.
- **`packages/protocol/src/hermes-api.ts`** — `ToolsetInfo` (line 727) already models
  `GET /api/tools/toolsets`; extend with `PlatformToolsetsConfig`, `CustomToolset`,
  `ToolCatalogEntry`.
- **`web/src/lib/builtin-commands.ts`** — register `/tools` and `/toolsets` in the
  composer palette.
- **`web/src/routes/console.tsx`** — Hermes Console for the TUI fallback path
  (`hermes tools`) while the managed runtime is still present.
- **Rust `src/commands/`** — `terminal.rs` (pty for `terminal`/`process` tools),
  `api_proxy.rs` (REST proxy for the toolset endpoints during migration),
  `config_migration.rs` (YAML migrations), and a new small `tools_config.rs` command
  exposing `read_platform_toolsets` / `write_platform_toolsets` to the frontend.
- **`web/src/lib/config-translations.ts`** — existing `toolsets` / `agent.disabled_toolsets`
  translations for the raw-config editor stay valid.

## 7. Removing the WebSocket dependency (migration path)

Frozen API surface during migration (do not rename): `GET/PUT /api/tools/toolsets…`
(REST) and gateway events `tool.generating|tool.start|tool.complete` + `/tools` slash
command semantics.

1. **Phase A (backend-backed UI)**: desktop renders the Tools page from
   `GET /api/tools/toolsets` and toggles via `PUT`; no schema changes. This proves the
   UI contract.
2. **Phase B (in-process catalog behind same interface)**: implement
   `packages/agent-tools` and hydrate it from the REST response once per session;
   `use-tools.ts` reads the in-process store, falls back to REST. Tool dispatch still
   goes over WS (`tool.*` events) but schemas come from the TS catalog.
3. **Phase C (local config authority)**: Rust `tools_config.rs` reads/writes
   `config.yaml`; the TS store applies `getPlatformTools`/`savePlatformTools` locally;
   REST toolset endpoints stop being called.
4. **Phase D (delete WS path)**: the in-process agent loop calls
   `getToolDefinitions()` directly and `dispatch.ts` routes handlers natively (TS
   handlers for pure-logic tools; Tauri IPC for terminal/process/browser/desktop_ui).
   Remove `/api/ws` tool exchange and the REST proxy branches.

Freeze list: `platform_toolsets`, `known_plugin_toolsets`, `known_builtin_toolsets`,
`agent.disabled_toolsets`, `custom_toolsets`, `no_mcp` sentinel, MCP `server:tool`
notation, `all`/`*` semantics, kanban exclusion under `all`.

## 8. Migration phases & task breakdown

1. **P1 — Protocol + read-only page (~1 wk)**: extend `hermes-api.ts`; add
   `use-tools.ts` hooks; `routes/tools.tsx` Toolsets tab read-only; sidebar entry;
   vitest for zod schemas.
2. **P2 — In-process registry + resolver (~2 wk)**: `registry.ts`, `toolsets.ts`
   (static `TOOLSETS` mirror), `catalog.ts` for the ~83 schemas (start with the
   `web`/`file`/`terminal`/`skills`/`todo`/`memory` core), `getToolDefinitions` with
   memo; port `test_toolsets.py` cases to vitest.
3. **P3 — Per-platform config write path (~1.5 wk)**: `platform-config.ts`
   (`getPlatformTools`/`savePlatformTools`), Rust `tools_config.rs` YAML round-trip,
   enable/disable toggles in the UI, `agent.disabled_toolsets` override.
4. **P4 — Custom toolsets + wildcard (~1 wk)**: `custom_toolsets` editor, `all`/`*`
   resolution incl. kanban exclusion, `/tools` `/toolsets` slash commands.
5. **P5 — Capability/workflow gates (~2 wk)**: `gates.ts` with 30 s TTL probes for
   browser/CDP/Home Assistant/x_search/computer_use/code_execution; kanban workflow
   gate; `desktop_ui` + `project` toolset gating for GUI-session sources (parity with
   `tui_gateway/server.py::_load_enabled_toolsets` + `_gui_surface_toolsets`).
6. **P6 — Cutover (~2 wk)**: in-process agent loop consumes `getToolDefinitions`;
   `dispatch.ts` native handlers + Rust IPC; delete WS/REST tool path; remove the
   `hermes tools` TUI dependency from the app.

## 9. Risks & open questions

- **~83-tool handler port is large**: browser automation, video gen, Feishu/kanban etc.
  are Python-heavy. Mitigate by toolset-priority order (P2 core first) and by keeping
  Rust IPC for OS-level tools; pure-API tools (web_search, image_gen) can call HTTP
  directly from TS.
- **check_fn parity**: Python probes (docker daemon, CDP reachable, credential stores)
  must be re-probed from TS with the same 30 s TTL + 60 s last-good grace window, or
  tools silently disappear mid-session exactly as the Python flake-suppression prevents.
- **tiktoken parity**: no TS equivalent in kimi-code; official `@tiktoken/tiktoken`
  wasm should match cl100k_base byte-for-byte, but verify the status-line numbers.
- **curses UI**: no direct TS equivalent — acceptable because the desktop uses React;
  the `hermes tools` TUI remains available in the Console during migration.
- **Config compatibility**: existing user `config.yaml` with `platform_toolsets`,
  `known_*` maps, `no_mcp`, MCP server names must round-trip losslessly; schemaVersion /
  config_migration paths must not regress.
- **Plugin/MCP dynamic toolsets** (`mcp-<server>`, plugin `spotify`/`video_gen`): the
  resolver must keep a runtime-registry view (`includeRegistry` flag parity, issue
  #49622) so registry-added tools don't drop whole toolsets during reverse-mapping.
- **kanban `all` semantics**: workflow-gated tools must stay off under `all`/`*` (Core
  docs are explicit); TS resolver must special-case this.
- **Open question**: should messaging platforms (telegram/discord/…) be modeled at all
  in the standalone desktop, or should `platform_toolsets` be collapsed to `cli` +
  `cron` + `api-server`? Recommend modeling them in the data model for config parity but
  hiding them from the UI.

## 10. Test strategy

- **Vitest unit** (parity ports from Core):
  - `test_toolsets.py` → `toolsets.test.ts`: get/resolve leaf+composite+cycle,
    `all`/`*` union (kanban excluded), validate, custom toolset, registry-merged vs
    static view, `bundle_non_core_tools` for `hermes-*`/posture bundles.
  - `test_model_tools.py` → `get-tool-definitions.test.ts`: enabled/disabled
    subtraction, dynamic schema rebuilds (execute_code), memoization.
  - `test_get_tool_definitions_cache_isolation.py` / `_process_cache.py` →
    memo-key + LRU eviction tests (quiet/non-quiet replay parity).
  - `test_api_server_toolset.py` → platform-composite membership tests.
  - `gates.test.ts`: checkFn TTL, flaky-probe grace window, credential auto-enable
    (x_search/homeassistant).
- **Rust tests**: `tools_config.rs` YAML round-trip for `platform_toolsets` +
  `known_*` + `custom_toolsets` with `tempfile::TempDir`; migration of legacy keys.
- **Playwright E2E**: Tools page loads ≥1 toolset; toggle persists to config.yaml;
  new session's `/tools list` reflects the toggle; `/toolsets create` adds a custom
  toolset and it appears in the catalog.
- **Parity harness (CI)**: run Core `get_tool_definitions()` vs TS
  `getToolDefinitions()` on the same fixture config and assert identical tool-name
  sets (check_fn gated tools compared with gates disabled).

## 11. Reference links

- Core: `D:/hermes-agent-cn/tools/registry.py`, `model_tools.py`,
  `toolsets.py`, `toolset_distributions.py`, `hermes_cli/tools_config.py`,
  `hermes_cli/subcommands/tools.py`, `hermes_cli/web_routers/tools.py`,
  `tui_gateway/server.py` (`_load_enabled_toolsets`, `_gui_surface_toolsets`),
  `hermes_cli/commands.py` (`/tools`).
- Docs: `website/docs/user-guide/features/tools.md`,
  `website/docs/reference/tools-reference.md`,
  `website/docs/reference/toolsets-reference.md`.
- Tests: `tests/test_toolsets.py`, `tests/test_model_tools.py`,
  `tests/test_toolset_distributions.py`,
  `tests/test_get_tool_definitions_cache_isolation.py`,
  `tests/test_get_tool_definitions_process_cache.py`,
  `tests/gateway/test_api_server_toolset.py`, `tests/tools/` (476 files, sampled).
- kimi-code TS: `packages/agent-core/src/agent/tool/index.ts` (ToolManager,
  `setActiveTools`, picomatch gating), `agent/index.ts:453` (profile.tools),
  `packages/agent-core/src/tools/builtin/` (+ `select-tools.ts`),
  `packages/agent-core/src/tools/args-validator.ts`, `tools/store.ts`,
  `services/tool/toolService.ts`, `tools/policies/`.
- Desktop: `packages/protocol/src/hermes-api.ts` (`ToolsetInfo`),
  `web/src/routes/skills.tsx`, `web/src/hooks/use-skills.ts`,
  `web/src/components/app-shell/capability-sidebar.tsx`,
  `web/src/lib/builtin-commands.ts`, `web/src/lib/transport.ts`,
  `web/src/routes/console.tsx`, `web/src/lib/config-translations.ts`,
  `src/commands/terminal.rs`, `src/commands/api_proxy.rs`,
  `src/commands/config_migration.rs`, `Cargo.toml` (serde_yaml).
