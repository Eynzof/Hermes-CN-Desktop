# Plugins — Python → TypeScript Rewrite Plan

## 1. Summary

The Python backend has a large, multi-category plugin system: **general plugins**
(tools, lifecycle hooks, slash commands, CLI commands, platforms, skills, middleware,
approval transports, event bus), **provider plugins** (memory providers, context
engines, model providers), plus a set of **bundled plugins** shipped in-tree
(disk-cleanup, security-guidance, observability/langfuse, observability/nemo_relay,
teams_pipeline, spotify, google_meet, image_gen backends, hermes-achievements,
kanban/dashboard). This plan moves that surface into the TypeScript desktop app as an
in-process `packages/plugin-core` runtime, so the React/Tauri app no longer needs the
managed Python runtime for plugin management, hook dispatch, or bundled-plugin behavior.

Key design decisions:

1. **Declarative-first, sandboxed-code-second plugin model.** Python plugins are
   arbitrary `__init__.py` code; running arbitrary third-party JS in the Tauri webview
   is unsafe. The TS runtime splits plugin surfaces into (a) *declarative* surfaces
   (manifest-declared tools/hooks/commands/MCP/platform configs that need no code) and
   (b) *trusted in-repo* bundled plugins compiled as TS modules. Third-party JS plugin
   code, when supported, runs in a Web Worker with a restricted `PluginContext` bridge —
   deferred to a later phase (see Risks).
2. **Manifest v2 parity.** Keep the Python `plugin.yaml` manifest shape (v1 + v2 fields)
   and the portable `plugin.json` agent-plugin format; parse with `js-yaml` (kimi-code
   already uses `js-yaml` + `zod` in `packages/agent-core`).
3. **Provider categories reuse existing desktop routes.** Memory/context-engine/model
   provider selection is already surfaced by `web/src/routes/memory.tsx`,
   `external-memory.tsx`, `models.tsx`; `plugin-core` supplies the registry behind them.
4. **Event bus is implemented from scratch.** kimi-code has no plugin event bus; the
   Python namespace-gated emit/subscribe bus (single worker, bounded queue, depth cap)
   is ported as an async queue in TS.
5. **Bundled plugins are ported as TS modules**; google_meet/teams_pipeline/spotify are
   flagged as heavy native/OAuth adapters whose Python-side process management moves to
   the Rust side or is deferred (their plans already exist separately for meet/spotify).

## 2. Current Python implementation

Source of truth: `D:/hermes-agent-cn`.

- **General plugin runtime** — `hermes_cli/plugins.py` (~9,500 lines):
  - `PluginManager` — 4-source discovery (`<repo>/plugins/` bundled, `~/.hermes/plugins/`
    user, `./.hermes/plugins/` project (env-gated), `hermes_agent.plugins` pip entry
    points); later sources override on name collision; category scan depth 2
    (`<root>/<category>/<name>/plugin.yaml`, key `image_gen/openai`); opt-in via
    `plugins.enabled` allow-list + `plugins.disabled` deny-list; background discovery
    (`start_background_plugin_discovery`); per-home manager cache
    (`get_plugin_manager()` keyed by resolved HERMES_HOME).
  - `PluginManifest` (dataclass) — v1 fields (name/version/description/author/
    requires_env/provides_tools/provides_hooks/kind/source/path/key) + v2 fields
    (manifest_version, api_version, requires_plugins, python_dependencies, config_schema,
    license, homepage, tags, emits/listens, capabilities, portable, skill_namespace).
  - `PluginContext` — `register_tool`, `register_hook` (≈30 `VALID_HOOKS`:
    pre/post_tool_call, pre/post_llm_call, transform_*, on_stream_*, on_session_*,
    pre_verify, pre_gateway_dispatch, pre_command, kanban_task_*, etc.),
    `register_command` (slash), `register_cli_command`, `register_platform`,
    `register_image_gen_provider`, `register_video_gen_provider`, `register_web_search_provider`,
    `register_browser_provider`, `register_tts_provider`, `register_transcription_provider`,
    `register_context_engine`, `register_context_reference`, `register_approval_transport`,
    `register_middleware`, `register_skill`, `register_system_prompt_section`,
    `register_auxiliary_task`, `register_redaction_patterns`, `register_secret_source`,
    `call_mcp`, `inject_message`, `emit`/`subscribe` (event bus), `llm` facade, `state`,
    `data_dir`, `has_plugin`, `on_unload`.
  - Event bus — namespace-forced emit (`<plugin_key>:<event>`, `hermes:` reserved),
    single daemon worker, `_EVENT_PENDING_CAP=64`, `_EVENT_EMIT_DEPTH_CAP=8`, deep-copied
    payloads, generation-based reset, owner-tagged subscriptions.
  - Registration lifecycle — `PluginRegistration` handles + `registration_lifecycle.py`
    `ReplacementCoordinator` (generation leases, restore-on-dispose for replaceable
    slots such as memory/context-engine providers).
  - `hermes_cli/plugin_capabilities.py` — capability declaration + per-plugin consent
    (`plugins.entries.<id>.granted_capabilities`).
  - `hermes_cli/agent_plugins.py` — portable agent plugins (`plugin.json` manifests).
- **Plugin packs** — `hermes_cli/plugin_packs.py`: `hermes-pack.yaml` (exact 40-char SHA
  pins, config seeds under `plugins.entries.<id>`, no secrets/capability pre-consent,
  export/review/install fan-out).
- **Plugin LLM access** — `agent/plugin_llm.py`: `ctx.llm.complete` /
  `complete_structured` (+ async), trust gate `plugins.entries.<id>.llm.*`
  (allow_provider/model/agent_id/profile/task override, allowlists), task-ownership
  checks, fail-closed defaults.
- **Provider categories** (separate discovery systems):
  - `plugins/memory/__init__.py` — exclusive, single active provider, `memory.provider`
    config; bundled-then-user scan; `discover_memory_providers()` /
    `load_memory_provider()`; `plugins/plugin_utils.py` thread-safe lazy singletons.
  - `plugins/context_engine/__init__.py` — exclusive, single active engine,
    `context.engine` config (default `compressor`).
  - `providers/__init__.py` + `plugins/model-providers/` (34 bundled profiles:
    anthropic, gemini, kimi, deepseek, openrouter, copilot, custom, bedrock, vertex, …) —
    lazy discovery, `register_provider(ProviderProfile)` last-writer-wins, user dir
    override at `$HERMES_HOME/plugins/model-providers/`.
- **Bundled plugins** under `plugins/` (docs: `website/docs/user-guide/features/built-in-plugins.md`):
  disk-cleanup (hooks+slash, state `$HERMES_HOME/disk-cleanup/`), security-guidance
  (25 pattern rules, warn/block modes), observability/langfuse (hooks→Langfuse SDK),
  observability/nemo_relay (hooks→NeMo relay), teams_pipeline (Graph meeting pipeline),
  spotify (7 tools, PKCE OAuth), google_meet (Playwright browser + STT/TTS),
  image_gen/{openai,openai-codex,xai,fal,krea,deepinfra,openrouter}, hermes-achievements
  (dashboard tab + `/api/plugins/hermes-achievements/*` REST), kanban/dashboard
  (dashboard tab + plugin_api).
- **Tests** — `tests/plugins/` (111 py files; e.g. test_disk_cleanup_plugin.py,
  test_security_guidance_plugin.py, test_langfuse_plugin.py, test_nemo_relay_plugin.py,
  test_teams_pipeline_plugin.py, test_google_meet_plugin.py, test_achievements_plugin.py,
  test_kanban_*.py, memory/ model_providers/ web/ image_gen/ …),
  `tests/plugins/model_providers/` (11 profiles), `tests/hermes_cli/test_plugins*.py`,
  `tests/hermes_cli/test_plugin_manifest_v2.py`, `tests/hermes_cli/test_plugin_event_bus.py`.

## 3. Target TypeScript design

New package **`packages/plugin-core`** (mirrors kimi-code's `packages/agent-core/src/plugin`),
plus a React UI route **`web/src/routes/plugins.tsx`**. It runs fully in-process in the
Tauri webview; no WS/REST calls to the Python runtime for plugin operations.

Module layout (all signatures are design sketches, not implementation):

```
packages/plugin-core/src/
  types.ts            // PluginManifest, PluginRecord, PluginSummary, diagnostics (mirror kimi-code types.ts)
  manifest.ts         // parse plugin.yaml (js-yaml) + plugin.json (portable) into PluginManifest
  store.ts            // read/write installed.json (kimi-code store.ts shape, version:1)
  source.ts           // resolveInstallSource: local-path | zip-url | github (kimi-code source.ts)
  archive.ts          // downloadZip + extractZip via yauzl, path-traversal guard (kimi-code archive.ts)
  github-resolver.ts  // codeload tarball resolution (kimi-code github-resolver.ts)
  manager.ts          // PluginManager: load/install/setEnabled/setMcpServerEnabled/remove/reload/list/info
  context.ts          // PluginContext: registerTool/registerHook/registerCommand/... (declarative registry writes)
  hooks.ts            // HookRegistry: VALID_HOOKS set + invokeHook(name, payload) -> results
  event-bus.ts        // emit/subscribe with <plugin>:<event> namespace gate, async queue, depth/pending caps
  lifecycle.ts        // PluginRegistration handles + ReplacementCoordinator (TS ports)
  packs.ts            // hermes-pack.yaml parse/validate/export/install fan-out
  marketplace.ts      // community plugin index + marketplace catalog (kimi-code plugin-marketplace util)
  llm.ts              // ctx.llm facade with trust policy (port of agent/plugin_llm.py gates)
  capabilities.ts     // capability registry + consent store
  memory/context-engine/model-provider registries (see §5)
  bundled/            // TS implementations of the 10 bundled plugins
```

Data flow (in-process):

1. On app start, `PluginManager.load()` reads `installed.json` + `config.yaml`
   (`plugins.enabled/disabled/entries`), then `materialize()` each record — parse
   manifest at `record.root`, compute diagnostics, mark `state: ok|error`.
2. Bundled plugins are statically imported TS modules (not copied into user dirs);
   user-installed plugins are folders under the desktop data dir
   (`<appData>/hermes/plugins/<id>/`) with `plugin.yaml` + optional JS entry
   (`index.ts` compiled by Vite only when the user grants trust; see Risks).
3. `PluginManager` exposes read models to React via a Jotai atom
   (`pluginsAtom`) and mutation methods (`install`, `enable`, `disable`, `remove`,
   `reload`) that persist then refresh the atom.
4. Agent loop calls `invokeHook(name, payload)` directly (same module); registered
   tools go through the existing tool registry; slash/CLI commands register into the
   existing command registry (desktop `web/src/lib/builtin-commands.ts`).
5. Provider registries: memory/context-engine/model-provider select one-or-many active
   entries; the active choice is persisted in `config.yaml` and consumed by the agent
   loop and by the existing `memory.tsx` / `models.tsx` routes.

## 4. Data models & persistence

- **`installed.json`** (`<appData>/hermes/plugins/installed.json`, version 1): records
  `{id, root, source: local-path|zip-url|github, enabled, installedAt, updatedAt,
  originalSource, capabilities, github}` — identical shape to kimi-code `store.ts`.
- **Manifest** — `PluginManifest` TS type mirroring Python dataclass: v1 fields +
  v2 optional fields (`manifestVersion`, `apiVersion`, `requiresPlugins`,
  `pythonDependencies` → ignored with diagnostic, `configSchema`, `license`, `homepage`,
  `tags`, `emits`, `listens`, `capabilities`, `portable`, `skillNamespace`).
- **Config** — reuse the desktop's existing YAML config handling (`web/src/lib/`): keep
  `plugins.enabled`, `plugins.disabled`, `plugins.entries.<id>.*`
  (settings/config schema, capability consent, llm trust policy).
- **Plugin state** — per-plugin data dir `<appData>/hermes/plugins-state/<id>/` with
  quota (Python caps at 10 MiB via `PluginState`); bundled plugin state lives under the
  same tree (`disk-cleanup/`, `hermes-achievements/`).
- **Provider selections** — `memory.provider`, `context.engine`, `model.provider` +
  `model.model` keys in config; provider profiles are read-only code (no persistence).
- **Heavy state (SQLite via Rust)** — achievements unlock state (`state.json` +
  `scan_snapshot.json` today; migrate to SQLite only if the desktop DB already exists),
  kanban board DB (reuse existing `web/src/routes/kanban.tsx` + Rust SQLite), disk-cleanup
  `tracked.json` (JSON, atomic write + `.bak`).
- **Schema migrations** — `installed.json` version 1 with additive-only record fields;
  `config.yaml` migrations already handled by desktop `config-migration.tsx`; no DB
  migration needed for v1 plugin records.

## 5. Third-party library strategy

| Python dependency | TS equivalent | Evidence / notes |
|---|---|---|
| PyYAML (`plugin.yaml`, packs) | `js-yaml` | kimi-code `packages/agent-core/package.json` uses `js-yaml`; parse then validate with `zod` (kimi-code uses `zod` everywhere) |
| importlib / `sys.modules` dynamic loading | no direct equivalent | kimi-code loads plugins **declaratively** (manifest JSON) and only runs external code as MCP stdio subprocesses or markdown commands. TS design: trusted bundled plugins are static imports; third-party JS deferred to a sandboxed Web Worker (from-scratch, see Risks) |
| threading / locks (`plugin_utils.py`, `ReplacementCoordinator`) | from scratch (async mutex / single-thread leases) | TS is single-threaded; port `ReplacementCoordinator` generations as lease objects; no npm lib needed |
| Zip install (`plugins install <url/github>`) | `yauzl` + built-in `fetch` | kimi-code `packages/agent-core/src/plugin/archive.ts` uses `yauzl` with path-traversal guard |
| GitHub ref resolution | from scratch (codeload URL building) | kimi-code `source.ts` + `github-resolver.ts`; no extra lib |
| Community plugin index / marketplace | from scratch (fetch + parse `marketplace.json`) | kimi-code `apps/kimi-code/src/utils/plugin-marketplace.ts` + `kap-server/src/routes/plugins.ts` |
| Plugin packs | from scratch (YAML + SHA validation) | no kimi-code equivalent; port `hermes_cli/plugin_packs.py` rules (exact 40-char SHA, secret-key reject, reserved keys) |
| Langfuse SDK (`langfuse`) | official `langfuse` npm SDK | **no kimi-code evidence** — langfuse ships an official TS SDK; hooks post events via OTLP/HTTP; fallback: plain fetch to Langfuse API |
| OpenAI / OpenAI-compatible image & LLM backends | `openai` npm | kimi-code evidence: `packages/agent-core-v2/package.json`, `packages/kosong/package.json` |
| FAL image backend | `@fal-ai/client` npm | no kimi-code evidence; official SDK exists (or plain REST) |
| Spotify (`spotipy`) | `spotify-web-api-node` or direct REST | **no kimi-code evidence**; OAuth via kimi-code `packages/oauth` (PKCE/device code) pattern |
| Playwright (google_meet browser) | `playwright` npm | no kimi-code evidence; heavy — defer to native side / browser-automation plan (`plans/browser-automation.md`), mark out-of-scope for v1 |
| Microsoft Graph (teams_pipeline) | `@microsoft/microsoft-graph-client` npm | **no kimi-code evidence**; official SDK exists; graph auth via MSAL/OAuth |
| Observability (nemo_relay, OTLP) | from scratch (fetch/OTLP JSON) | kimi-code `packages/telemetry` (OTLP/metrics) is evidence that OTLP is feasible in TS |
| security-guidance 25 regex rules | from scratch (port pattern table to TS RegExp) | pure data port; no lib |
| `orjson`/`pybase64` (plugin_llm, event payloads) | built-in `JSON.stringify/parse`, `Buffer`/`btoa` | no lib needed |
| `httpx` (pack fetch) | built-in `fetch` | kimi-code uses `fetch` everywhere |

Where no TS equivalent exists the plan is to implement a thin TS module from scratch
with the interfaces sketched in §3; none of these require native addons.

## 6. Integration with existing Hermes-CN-Desktop frontend

- **New route `web/src/routes/plugins.tsx`** — list/install/enable/disable/remove
  plugins, per-plugin diagnostics, capability consent, pack install/export. No existing
  plugin UI exists today (grep of `web/src` for `plugin` finds only unrelated
  voice-config/cli-delegation/config-migration files; `static/bundled-plugins/` contains
  only `.gitkeep`).
- **Reuse existing routes/UI**: `web/src/routes/memory.tsx` + `external-memory.tsx`
  (memory provider selection), `web/src/routes/models.tsx` (model provider selection),
  `web/src/routes/kanban.tsx` (kanban bundled plugin tab), `web/src/routes/cron.tsx`
  (disk-cleanup cron-output interplay). A future Settings tab can mount the plugin list
  (`settings.tsx` has no plugin section today).
- **Reuse libs**: `web/src/lib/transport.ts` (HTTP routing + auth headers, profile
  header), `web/src/lib/gateway-client.ts` (WS JSON-RPC — used only during migration
  phase for parity, then removed), `web/src/lib/tauri-bridge.ts` + Rust IPC for file
  dialogs/child processes (`src/commands/file_dialogs.rs`, `src/commands/terminal.rs`).
- **Rust side**: `src/process/runtime.rs` already computes `current_bundled_plugins_dir()`
  and sets `HERMES_BUNDLED_PLUGINS` for the managed Python runtime
  (see `src/process/dashboard.rs` lines ~1072-1076). After migration this env injection
  is deleted; the static bundle dir becomes the source of the TS bundled plugin catalog.
- **Protocol**: add `PluginSummary`/`PluginMarketplaceEntry` Zod schemas to
  `packages/protocol` (mirror kimi-code `kap-server/src/protocol/rest-plugin.ts`) so
  route/UI and IPC share types.

## 7. Removing the WebSocket dependency (migration path)

Phase A (today): plugin list/enable/disable/install is served by the Python dashboard
REST (`/api/plugins*`) over the WS/REST link; the UI route calls `transport.ts`.

Phase B (freeze the API surface): define the in-process `PluginManager` interface
(`list/info/install/enable/disable/remove/reload/marketplace/packs`) as the single
contract. `web/src/lib/transport.ts`-based calls are swapped one-by-one to direct
`packages/plugin-core` calls behind a thin `pluginsApi` facade so the UI never notices.

Phase C (delete WS path): once the agent loop, hook dispatch, and tool registration all
run in-process, remove `/api/plugins*` calls, the WS event relay for plugin events, and
the Rust `HERMES_BUNDLED_PLUGINS` env injection. The frozen API surface becomes the
`packages/plugin-core` public API — the parity test suite is the guard for deletion.

## 8. Migration phases & task breakdown

1. **P1 — plugin-core skeleton + manifest/store** (2-3 tasks):
   `types.ts`, `manifest.ts` (yaml+json, diagnostics), `store.ts`, `source.ts`,
   `archive.ts`, `github-resolver.ts`; port `test_plugin_manifest_v2.py` cases.
2. **P2 — manager + lifecycle + event bus**: `manager.ts`, `context.ts`, `hooks.ts`,
   `event-bus.ts`, `lifecycle.ts` (ReplacementCoordinator); port
   `test_plugin_event_bus.py`, `tests/hermes_cli/test_plugins*.py` discovery/override
   cases.
3. **P3 — provider registries**: memory registry (single-select), context-engine
   registry (single-select), model-provider catalog (34 profiles ported as TS data
   modules; keep `models.tsx`/`memory.tsx` behavior); port
   `tests/plugins/model_providers/` (11 profiles) as data tests.
4. **P4 — bundled plugins (TS)**: disk-cleanup, security-guidance, langfuse,
   nemo_relay, image_gen backends, hermes-achievements, kanban tab wiring; port their
   `tests/plugins/test_*.py` behavior; mark spotify/teams_pipeline/google_meet as
   separate follow-ups (OAuth/native/process management).
5. **P5 — UI + packs + marketplace**: `web/src/routes/plugins.tsx`, `packs.ts`
   (install/export), `marketplace.ts` catalog; wire into Settings; Playwright E2E for
   enable/disable + slash command visibility.
6. **P6 — WS teardown**: flip `pluginsApi` to in-process only, delete Python REST calls
   and `HERMES_BUNDLED_PLUGINS` env, update `packages/protocol` schemas, remove parity
   shims.

## 9. Risks & open questions

- **Arbitrary plugin code execution in the webview** is the biggest risk: Python
  plugins are arbitrary code; the TS equivalent must be declarative + trusted-static or
  a sandboxed Web Worker with a restricted `PluginContext` (no fs/DOM). Open question:
  do we support third-party JS plugins at all in v1, or only bundled + declarative?
- **Hook parity**: ~30 `VALID_HOOKS` fire at precise points across the agent loop;
  missing a fire-site silently changes plugin behavior. Parity tests must assert
  hook-name sets and payload shapes.
- **`plugins.enabled` opt-in semantics + grandfathering**: bundled plugins must stay
  disabled-by-default on desktop; migration must not auto-enable anything.
- **No TS equivalent found (must be built from scratch or official SDK, no kimi-code
  evidence)**: plugin event bus (kimi-code has none), plugin packs, capability consent
  flow, Langfuse/Spotify/Playwright/Microsoft-Graph SDK choices, FAL client, and the
  community plugin index/marketplace (kimi-code has a marketplace, but it is JSON-only
  and Hermes' index resolution differs).
- **google_meet** (Playwright + STT/TTS duplex) and **teams_pipeline** (Graph meeting
  pipeline + runtime store) are large process-heavy plugins; recommend out-of-scope for
  the desktop standalone rewrite (defer to `plans/browser-automation.md`,
  `plans/google-meet.md`, `plans/teams-platform.md` / native Rust side).
- **Python-specific discovery heuristics** (auto-coercing `kind=memory-provider` by
  scanning `__init__.py` text) have no TS meaning; replace with explicit `kind:` in the
  manifest and a migration diagnostic.
- **pip entry-point plugins** (`hermes_agent.plugins`) cannot exist in TS; desktop
  substitutes the marketplace/zip-install path. Document as a dropped surface.
- **Multi-profile state**: Python keys the manager by resolved HERMES_HOME; TS must key
  the manager + Jotai atom by active profile (`activeProfileAtom` in
  `web/src/stores/ui.ts`) and reload on profile switch.

## 10. Test strategy

- **Vitest unit (plugin-core)**: manifest parse (port `test_plugin_manifest_v2.py`
  cases: v1/v2 fields, diagnostics, unknown kind fallback), installed.json round-trip,
  source resolution (local/zip/github), zip traversal guard, pack validation (exact SHA,
  secret-key rejection — port `test_plugin_packs` behaviors), event bus namespace gate +
  depth/pending caps (port `test_plugin_event_bus.py`), lifecycle restore via
  ReplacementCoordinator, LLM trust-gate allowlists (port `agent/plugin_llm.py` tests).
- **Vitest unit (bundled plugins)**: disk-cleanup tracking/deletion thresholds (port
  `test_disk_cleanup_plugin.py`), security-guidance 25 rules warn/block (port
  `test_security_guidance_plugin.py`), langfuse/nemo payload shapes (port
  `test_langfuse_plugin.py`, `test_nemo_relay_plugin.py`), achievements scan/unlock
  logic (port `test_achievements_plugin.py`), kanban API (port `test_kanban_*.py`).
- **Vitest data tests**: 11 model-provider profiles render valid TS profile records
  matching `ProviderProfile` (provider slug, aliases, env keys, model list).
- **Integration**: `PluginManager.reload()` added/removed/errors parity vs Python
  `list_plugins`; hook invocation order + payload isolation; slash command registration
  into `builtin-commands.ts`.
- **Playwright E2E**: `plugins.tsx` install-from-catalog flow, enable/disable toggles
  reflect in slash command palette and tool list, pack export/import, capability
  consent dialog, bundled plugin status badges.
- **Parity harness**: run the Python test files listed in §2 as the behavioral oracle
  during P2-P4; freeze the `pluginsApi` interface (Phase B) and gate WS teardown (Phase C)
  on the parity suite.

## 11. Reference links

- Python: `D:/hermes-agent-cn/hermes_cli/plugins.py`, `hermes_cli/plugin_packs.py`,
  `hermes_cli/plugin_capabilities.py`, `hermes_cli/plugin_index.py`,
  `hermes_cli/agent_plugins.py`, `agent/plugin_llm.py`, `registration_lifecycle.py`,
  `plugins/plugin_utils.py`, `plugins/memory/__init__.py`,
  `plugins/context_engine/__init__.py`, `providers/__init__.py`,
  `plugins/model-providers/*`, `plugins/disk-cleanup/`, `plugins/security-guidance/`,
  `plugins/observability/{langfuse,nemo_relay}/`, `plugins/teams_pipeline/`,
  `plugins/spotify/`, `plugins/google_meet/`, `plugins/image_gen/*`,
  `plugins/hermes-achievements/`, `plugins/kanban/dashboard/`
- Docs: `D:/hermes-agent-cn/website/docs/user-guide/features/plugins.md`,
  `website/docs/user-guide/features/built-in-plugins.md`
- Tests: `D:/hermes-agent-cn/tests/plugins/`,
  `tests/plugins/model_providers/`, `tests/hermes_cli/test_plugins*.py`,
  `tests/hermes_cli/test_plugin_manifest_v2.py`,
  `tests/hermes_cli/test_plugin_event_bus.py`
- kimi-code TS: `D:/kimi-code/packages/agent-core/src/plugin/`
  (`manifest.ts`, `manager.ts`, `types.ts`, `store.ts`, `archive.ts`, `source.ts`,
  `github-resolver.ts`, `commands.ts`),
  `packages/kap-server/src/routes/plugins.ts`,
  `packages/kap-server/src/protocol/rest-plugin.ts`,
  `apps/kimi-code/src/utils/plugin-marketplace.ts`,
  `apps/kimi-code/src/tui/commands/plugins.ts`,
  `apps/kimi-code/src/tui/components/dialogs/plugins-selector.ts`
- Desktop: `D:/Hermes-CN-Desktop/web/src/lib/transport.ts`,
  `web/src/lib/gateway-client.ts`, `web/src/lib/tauri-bridge.ts`,
  `web/src/routes/{settings,memory,external-memory,models,kanban}.tsx`,
  `web/src/stores/ui.ts` (`activeProfileAtom`), `web/src/lib/builtin-commands.ts`,
  `static/bundled-plugins/`, `src/process/runtime.rs`, `src/process/dashboard.rs`,
  `packages/protocol`
