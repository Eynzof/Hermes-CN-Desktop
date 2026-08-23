# Model Switching — Python → TypeScript Rewrite Plan

## 1. Summary

Port the Python `/model` model-switching pipeline into the Hermes-CN-Desktop in-process
TypeScript runtime so the feature stops depending on the WebSocket link to the managed
Python gateway. The feature covers: per-session model switches, `--global` (persist to
config), `--once` (single-turn), `--provider <name>` backend switches, user-defined
custom aliases (`model_aliases:` full form and `model.aliases:` short form), and
**persistent overrides that survive gateway restarts** (session override stored in the
session store, rehydrated on first use; credentials are re-resolved at load time and
never written to disk — docs: `website/docs/user-guide/messaging/index.md#persistent-model-overrides`).

The single source of truth to port is `D:/hermes-agent-cn/hermes_cli/model_switch.py`
(≈91 KB): flag parsing, persist-behavior resolution, alias resolution, the
`switch_model()` provider/credential/normalize/validate pipeline, and
`resolve_effective_model()` (session override > channel > global). The runtime swap
(`AIAgent.switch_model`) lives in `D:/hermes-agent-cn/run_agent.py` →
`agent/agent_runtime_helpers.py`. The TS design mirrors kimi-code's
`modelCatalogService` + `ConfigState.modelAlias` + the `/model` picker's
persist-vs-session-only split, extended with the Python scope semantics
(`--once` / `--session` / `--global` / config default).

## 2. Current Python implementation

### 2.1 Core pipeline — `D:/hermes-agent-cn/hermes_cli/model_switch.py`

Shared by CLI (`cli.py`), gateway (`gateway/run.py`), and TUI gateway
(`tui_gateway/server.py`); the module docstring defines the chain:
`parse flags -> alias resolution -> provider resolution -> credential resolution ->
normalize model name -> metadata lookup -> build result`.

Key symbols (all verified by reading the file):

- **Flag parsing**: `parse_model_flags_detailed(raw)` → `ModelFlagParseResult`
  (`model_input`, `explicit_provider`, `is_global`, `force_refresh`, `is_session`,
  `is_once`). Hand-rolled tokenizer (model IDs may contain `:`/`/`) + Unicode-dash
  normalization (`–provider`/`–session`/`—global` from Telegram/iOS auto-convert).
  `parse_model_switch_args(raw)` is the ONE parser for every surface and adds
  conflict validation: `--once --global` → `MODEL_SWITCH_ERR_ONCE_WITH_GLOBAL`;
  `--once` without model or `--provider` → `MODEL_SWITCH_ERR_ONCE_REQUIRES_TARGET`;
  it also derives `scope` (`once|session|global|default`).
- **Persist behavior**: `resolve_persist_behavior(is_global, is_session, is_once,
  explicit_provider)` — resolution order: `--once`→False; `--session`→False;
  `--global`→True; `--provider` without scope flag→False (exploratory);
  otherwise config `model.persist_switch_by_default` (default False). This is why a
  plain `/model <name>` is session-only today.
- **Aliases**: built-in `MODEL_ALIASES` (`sonnet`→anthropic/claude-sonnet, `kimi`,
  `qwen`, `glm`, …) resolving to `(vendor, family)`; `_load_direct_aliases()` reads
  config `model_aliases:` (full form: `model` + `provider` + optional `base_url`) and
  `model.aliases:` (short form `provider/model`). `resolve_alias(raw, provider)`
  checks direct aliases first, then family-prefix matches against the live
  models.dev catalog, sorted by `_model_sort_key` (version parsing, YYYYMMDD date
  stamps, suffix ranking `pro/max/plus/turbo/sol`); **multiple matches raise
  `AmbiguousAliasError`** instead of silently picking. `_resolve_alias_fallback`
  tries the user's authenticated providers, then `openrouter`/`nous`.
- **Effective model**: `resolve_effective_model(session_overrides, channel_config,
  global_config)` — the single owner of the precedence rule
  **session override > channel/session-persisted config > global default**
  (fixes the api_server divergence, commit 7dd00bb47d).
- **Core switch**: `switch_model(raw_input, current_provider, current_model,
  current_base_url, current_api_key, is_global, explicit_provider, user_providers,
  custom_providers)` → `ModelSwitchResult`. Path A (`--provider`): resolve provider
  via `resolve_provider_full`, guard silent aggregator hops, auto-detect local model,
  resolve alias on the target. Path B (no provider): MoA preset match → alias on
  current provider → fallback across authenticated providers → aggregator
  `vendor:model`→`vendor/model` conversion → aggregator catalog search →
  **configured-provider exact-match routing** (`_configured_provider_matches`,
  #45006) → `detect_provider_for_model` last resort. Common tail: resolve
  credentials (`resolve_runtime_provider` / user-provider config), `api_mode`
  resolution (`host_mandated_api_mode` overrides stale mode), normalize
  (`normalize_model_for_provider`), validate (`_declared_model_for_provider`).
  `ModelSwitchResult` carries `success, new_model, target_provider, provider_changed,
  api_key, base_url, api_mode, error_message, warning_message, provider_label,
  resolved_via_alias, capabilities, model_info, is_global`.
- **Context display**: `resolve_display_context_length` (+`_async` offload) uses
  `agent/model_metadata.py::get_model_context_length` (provider-aware: Codex OAuth
  272K, Copilot, Nous, custom-provider `context_length` overrides) with
  `route_identity.should_clear_context_pin`.
- **Display helpers**: `format_model_for_display` (strips opaque Palantir Foundry
  prefixes), `is_nous_hermes_non_agentic` + `_HERMES_MODEL_WARNING`.

### 2.2 Runtime swap — `D:/hermes-agent-cn/run_agent.py` + `agent/agent_runtime_helpers.py`

`AIAgent.switch_model(new_model, new_provider, api_key, base_url, api_mode)` is a
forwarder (run_agent.py ≈line 1004) to `agent.agent_runtime_helpers.switch_model`
(≈line 2438): in-place client rebuild (OpenAI chat / Anthropic messages), caching-flag
invalidation, header re-application (`_apply_client_headers_for_base_url`), and
**rollback to the pre-swap state if the client rebuild raises** (#33175). Agent init
(60+ params, provider auto-detection, credential resolution) lives in
`agent/agent_init.py`.

### 2.3 Gateway persistence

`gateway/run.py` `/model` handlers persist session overrides to the session store;
`/model --global` writes `config.yaml`; `/new` clears the override; credentials are
re-resolved at load and never written to disk (docs `messaging/index.md` lines 229-231).

### 2.4 Docs

- `website/docs/reference/slash-commands.md` line 78: `/model` flags (`--global`,
  `--session`, `--once`, `--refresh`, `--provider`), `provider:model`, `custom:model`,
  `custom:name:model`, aliases, `model.persist_switch_by_default`.
- Lines 177-217: custom alias formats (full YAML + short config-set form), alias
  shadowing, prefix command resolution.
- `website/docs/user-guide/messaging/index.md` lines 229-231, 315: persistent
  overrides + resolution priority.

### 2.5 Tests (parity source)

- `tests/hermes_cli/test_model_switch_*.py` (12 files): `parsing`,
  `once_flags`, `persist_default`, `variant_tags`, `configured_provider_routing`,
  `context_display`, `context_offload`, `copilot_api_mode`, `openai_api_mode`,
  `opencode_anthropic`, `custom_providers`, `filter_unresolved`.
- `tests/hermes_cli/test_apply_model_switch_result_context.py`: picker confirmation
  must use provider-aware `resolve_display_context_length`; global switch clears a
  stale `model.context_length` pin.
- `tests/test_model_picker_scroll.py`: curses picker scroll-offset invariants.
- `tests/run_agent/test_switch_model_*.py` (7): rollback, re-applies headers,
  context, fallback-prune, pool reload, reasoning override, stale base_url.

## 3. Target TypeScript design

### 3.1 Module layout (new `web/src/lib/model-switch/`)

Pure port of the Python pipeline, with no Python backend in the loop:

```
web/src/lib/model-switch/
  types.ts           // ModelSwitchRequest, ModelSwitchResult, ModelScope, DirectAlias,
                     //   ModelIdentity, ModelSwitchErrorCode
  parser.ts          // parseModelFlagsDetailed(), parseModelSwitchArgs() + conflict errors
  persist.ts         // resolvePersistBehavior(request, configStore)
  version-sort.ts    // modelSortKey() — version/datestamp/suffix ranking
  aliases.ts         // BUILTIN_MODEL_ALIASES, loadDirectAliases(config),
                     //   resolveAlias(), AmbiguousAliasError, fallback resolver
  resolver.ts        // switchModel(request, ctx) → ModelSwitchResult (Paths A/B,
                     //   credential resolution, api_mode, normalize, validate)
  effective.ts       // resolveEffectiveModel(sessionOverride, channelOverride, global)
  context-length.ts  // resolveDisplayContextLength(model, provider, ...) provider-aware
  runtime.ts         // applyModelSwitchToRuntime(runtime, result) — client rebuild +
                     //   rollback (port of agent_runtime_helpers.switch_model)
  store.ts           // ModelOverrideStore — session/channel/global override CRUD
  services.ts        // in-process ports: ModelCatalogService, ProviderModelsService,
                     //   ModelOptionsService (same shapes as today's RPC results)
```

### 3.2 Core flow (in-process)

1. UI (composer picker or `/model` command) produces a raw string + `sessionId`.
2. `parser.ts` → `ModelSwitchRequest { target, explicitProvider, scope, errors }`.
3. `persist.ts` → effective persist decision.
4. `resolver.ts` → `ModelSwitchResult` using `ModelCatalogService` (local
   `BUILTIN_PROVIDER_CATALOG` + live catalog fetch), `ProviderRegistry`
   (config `providers`/`custom_providers`), `CredentialResolver` (keychain/Rust IPC).
5. `runtime.ts` applies the result to the live agent runtime (rebuild client,
   invalidate caches, rollback on failure).
6. `store.ts` persists according to scope: `global` → config store
   (`model.default/provider/base_url/aliases`); `session` → session override store;
   `once` → no persistence, only a turn-scoped flag the turn loop consumes.
7. `context-length.ts` computes the display context (provider-aware, parity with
   `test_apply_model_switch_result_context.py`).

### 3.3 `--once` in the turn loop

Python intentionally parses `--once` centrally but lets each frontend apply its own
"restore hook" (docstring in `parse_model_flags_detailed`). In TS, the turn loop
(`web/src/lib/` agent runtime) reads a `oneTurnModelOverride` from
`ModelOverrideStore`; after the next turn completes (success or error) it clears it
and the runtime re-applies the session/global effective model.

## 4. Data models & persistence

### 4.1 Records

```ts
interface ModelSelection { model: string; provider?: string; providerName?: string;
  baseUrl?: string; apiMode?: string; contextWindow?: number; }
interface ModelSwitchResult { success: boolean; newModel: string; targetProvider: string;
  providerChanged: boolean; apiKey: string; baseUrl: string; apiMode: string;
  errorMessage: string; warningMessage: string; providerLabel: string;
  resolvedViaAlias: string; capabilities?: ModelCapabilities; modelInfo?: ModelInfo;
  isGlobal: boolean; scope: ModelScope; }
interface SessionModelOverride { sessionId: string; model: string; provider?: string;
  baseUrl?: string; apiMode?: string; ts: number; } // survives restart; no secrets
interface ChannelOverride { channelKey: string; model?: string; ... }
```

Aligns with existing `ComposerModelSelection`
(`web/src/components/chat/composer-types.ts`) and protocol `ModelInfo`/`ModelOptionsResult`
(`packages/protocol/src/hermes-api.ts` lines 604-612, 1411-1416).

### 4.2 Persistence strategy

- **Global config** (model.default/provider/base_url, `model_aliases`,
  `model.aliases`, `model.persist_switch_by_default`, `providers`,
  `custom_providers`): keep the existing config store (today read/written via
  REST/Rust config commands — `hooks/use-config.ts`, `saveConfig`). In-process:
  Tauri Rust `src/commands/*` config commands or a JSON/IndexedDB config store.
- **Per-session override**: new `session_model_overrides` table — Rust SQLite (native)
  or IndexedDB (web shell). Rehydrated on session resume; credentials re-resolved at
  load (never persist `apiKey`); `/new`/`/reset` deletes the row.
- **Channel overrides**: existing `channel_overrides` config section, read by
  `effective.ts`.
- **Last-used / UI**: reuse `web/src/lib/last-used-model.ts` (ui-store, per backend
  scope) and `model-options-cache.ts` (5-min TTL, per scope+session).
- **Migration**: add the override table with a schema version bump; backfill from
  `model.default` when absent.

## 5. Third-party library strategy

| Python dependency | TS equivalent | Evidence (kimi-code) |
|---|---|---|
| models.dev catalog (`agent/models_dev.py`, `list_provider_models`) | `ModelCatalogItem`/`ProviderCatalogItem` + `IModelCatalogService`; Desktop local `BUILTIN_PROVIDER_CATALOG` (`web/src/lib/provider-catalog.ts`, used by `model-context.ts`); live refresh via `fetchCatalogOrBuiltIn` | `packages/agent-core/src/services/modelCatalog/modelCatalog.ts`, `modelCatalogService.ts`; `apps/kimi-code/src/utils/catalog-fetch.ts` |
| YAML config (PyYAML; `model_aliases`, `custom_providers`, `providers`) | kimi-code uses TOML (`config.toml`) via `@moonshot-ai/kosong` + zod `schema.ts`; Desktop already reads config through Rust/REST — keep that bridge, or add `js-yaml` only if the Rust side returns YAML strings | `packages/agent-core/src/config/schema.ts` (z.object), `config/model.ts` |
| OpenAI SDK + Anthropic client rebuild (`run_agent.py` / `agent_runtime_helpers.switch_model`) | `@moonshot-ai/kosong` `createProvider`/`ChatProvider` abstraction; runtime swap + rollback ported to `runtime.ts` | `packages/agent-core/src/agent/config/index.ts` (ConfigState), `packages/kosong` providers |
| Credential/OAuth resolution (`hermes_cli/providers.py`, `resolve_runtime_provider`) | `ProviderCredentialState {hasApiKey, hasOAuthToken}` + managed auth facade; Desktop `useOAuthProviders` | `modelCatalog.ts` lines 74-96; `modelCatalogService.ts` `_hasCachedToken`; `packages/agent-core/src/services/auth/managedAuth.ts` |
| `requests`/probes for `/v1/models` (per-provider probe ladder) | `fetch` through Tauri HTTP (native) or RPC; kimi-code `refreshProviderModels` serialized via `_refreshChain` | `modelCatalogService.ts` `refreshProviderModels()`; Desktop `provider.probe`/`provider.models` RPC today |
| `_model_sort_key` version heuristics | **No kimi-code equivalent** — implement from scratch in `version-sort.ts` (pure function, port tests) | none |
| Regex helpers (Unicode-dash normalization, `_NOUS_HERMES_NON_AGENTIC_RE`, opaque-ID prefixes) | Native `RegExp` | none needed |
| `asyncio.to_thread` offload for blocking probes | TS is single-threaded async; run catalog fetch + probe ladder in a Web Worker / Rust task | kimi-code core-process RPC pattern |
| Interactive picker scroll (`_curses_prompt_choice`) | React list virtualization; port scroll invariant logic from `test_model_picker_scroll.py` into the picker component | `apps/kimi-code/src/components/dialogs/tabbed-model-selector.tsx` |

### 5.1 No-TS-equivalent gaps (call out explicitly)

- The deep **provider-aware context-length probe ladder**
  (`get_model_context_length`: Anthropic `/v1/models`, Copilot, Nous, Codex, GMI,
  Ollama, models.dev, OpenRouter) has no kimi-code equivalent; design a
  `ContextLengthResolver` with a local capability table first, live probes second.
- `--once` scope and `model.persist_switch_by_default` config default do not exist
  in kimi-code (its picker only distinguishes persist vs session-only).
- Durable **session-level model override** across restarts does not exist in
  kimi-code (only global `defaultModel` + in-memory `ConfigState.modelAlias`).

## 6. Integration with existing Hermes-CN-Desktop frontend

- **Reuse**: `useGateway().getModelOptions(sessionId)` (`hooks/use-gateway.ts`
  ≈line 548, RPC `model.options` + `slug_filter`), `dispatchCommand` (≈line 603,
  RPC `command.dispatch` — today's `/model` path), `probeProvider`,
  `listProviderModels`; `use-model-options.ts` React Query wrapper;
  `use-provider-models.ts`; `model-options-cache.ts`; `model-search-aliases.ts`
  `expandSearchQuery` (CN aliases); `cn-provider-slugs.ts`
  `CN_BACKEND_PROVIDER_SLUGS`; `model-context.ts` `resolveModelContextWindow`;
  `last-used-model.ts`; `/models` route (`routes/models.tsx` →
  `routes/settings-models-section.tsx`); protocol schemas in `packages/protocol`.
- **Add**: `hooks/use-model-switch.ts` exposing `switchModel(request, sessionId)`
  and `useSessionEffectiveModel()`; a scope control in the composer model picker
  (`goose-composer-model-picker.tsx` / `goose-composer.tsx`): buttons
  "本次会话" (session), "设为默认" (global), "仅下一条" (once), mirroring
  kimi-code's `TabbedModelSelectorComponent` `onSelect` vs `onSessionOnlySelect`.
- **Replace**: `dispatchCommand(sessionId, "model", ...)` with the in-process
  resolver behind the same `CommandDispatchResult`-shaped response during migration
  (Section 7), so UI changes are minimal.

## 7. Removing the WebSocket dependency (migration path)

Freeze these API surfaces (shapes live in `packages/protocol/src/hermes-api.ts`):
`ModelOptionsResult`, `ModelInfo`, `ProviderProbeResult`, `ProviderModelsListResult`,
`CommandDispatchResult`.

- **Phase A (today)**: WS/REST backend — `model.options`, `provider.models`,
  `provider.probe`, `command.dispatch`(model), `/api/model/info`,
  `/api/model/moa`. The Desktop calls these via `gateway-client.ts`.
- **Phase B**: implement `ModelOptionsService`, `ProviderModelsService`,
  `ModelSwitchService` in-process behind the same interfaces; the picker and
  `/model` command call the in-process service first, falling back to the WS path
  only for still-managed features (OAuth token refresh, credential resolution).
- **Phase C**: delete the WS/REST model RPCs; the turn loop, picker, and settings
  page all consume the in-process services; secrets stay in Rust keychain via Tauri IPC.
- Rollout guard: keep a `useRemoteModelOptions` flag (runtime badge) to A/B against
  the Python backend during beta (see `desktop-dual-repo-test` skill).

## 8. Migration phases & task breakdown

1. **Pure logic port (no I/O)**: `parser.ts`, `persist.ts`, `version-sort.ts`,
   `aliases.ts` + vitest parity tests for `test_model_switch_parsing.py`,
   `once_flags`, `persist_default`, `variant_tags`.
2. **Catalog + options service**: `ModelCatalogService` over
   `BUILTIN_PROVIDER_CATALOG` + live models.dev fetch; wire `getModelOptions`
   shape; parity with `custom_providers`/`filter_unresolved` tests.
3. **Resolver pipeline**: `resolver.ts` (Paths A/B, configured-provider routing,
   aggregator handling, api_mode, normalize, validate); parity with
   `configured_provider_routing`, `copilot_api_mode`, `openai_api_mode`,
   `opencode_anthropic`.
4. **Runtime swap**: `runtime.ts` client rebuild + rollback; parity with the 7
   `tests/run_agent/test_switch_model_*.py`.
5. **Persistence**: `store.ts` (session override table + restart rehydration,
   channel overrides, global config write, `/new` clearing).
6. **UI**: scope control in picker, alias editor on `/models`, context-length
   display parity, last-used integration.
7. **WS removal**: switch callers to in-process services; delete model RPC paths;
   A/B via runtime badge.

## 9. Risks & open questions

- **Config-shape parity**: YAML `custom_providers[].models` may be dict, list of
  strings, or list of dicts with per-model `context_length`; `_save_discovered_models_to_config`
  preserves curated metadata. The TS config writer must not clobber these shapes.
- **Credential safety**: session overrides must persist model/provider/base_url
  **without** API keys; re-resolve at load (keychain/Rust). Python explicitly
  documents this invariant — carry it into `store.ts`.
- **Aggregator behavior**: `opencode-zen`/`opencode-go` are uncapped in the picker
  (`_UNCAPPED_PICKER_PROVIDERS`) and have flat namespaces; `vendor:model` colon
  forms and `:free/:extended/:fast` variant tags must round-trip unchanged.
- **Ambiguous aliases**: Python raises `AmbiguousAliasError` rather than silently
  picking; the TS UI needs a disambiguation list UX.
- **`--once` semantics**: depends on the turn loop restore hook; must be defined
  for streaming/interrupt paths and for `panel-composer` vs `goose-composer`.
- **Context-length ladder cost**: the probe ladder can be slow (blocking requests
  in Python); in TS run it off the UI thread and cache aggressively.
- **No TS equivalent** risks are itemized in 5.1; the biggest is the provider-aware
  context probe ladder and durable session overrides.
- **Open questions**: where the in-process config store lives (Rust SQLite vs
  IndexedDB vs JSON) once WS is gone; whether `model.aliases` short-form
  `provider/model` should also be editable from the Desktop UI; whether
  `--refresh` should force-evict `model-options-cache.ts`.

## 10. Test strategy

- **Vitest unit (pure logic)**: port every `test_model_switch_*.py` case 1:1 —
  parser/conflicts, persist-behavior table, version-sort, alias resolution
  (builtin + config aliases + shadowing), variant tags, configured-provider
  routing, api-mode recompute, context-length selection (incl.
  `test_apply_model_switch_result_context.py` global-pin-clear).
- **Vitest unit (runtime)**: port `tests/run_agent/test_switch_model_*.py`
  rollback/re-header/context invariants against a fake `ModelRuntime`.
- **Vitest unit (picker)**: port `test_model_picker_scroll.py` scroll invariants
  and `filterOptions` tests (`model-combobox.test.tsx` precedent).
- **Integration**: `ModelOverrideStore` round-trip + restart rehydration with an
  in-memory/IndexedDB adapter; `--once` clears after one turn.
- **Playwright E2E**: open composer picker → session-only switch → assert status;
  `/model sonnet --global` persists to config store; restart app → session override
  rehydrates; `--once` reverts after one turn.
- **Parity matrix**: table mapping each Python test file → TS test file + pass
  criteria; run against the Python backend (route A) and the in-process runtime
  (route B) using the `desktop-dual-repo-test` smoke skill.

## 11. Reference links

- Python: `D:/hermes-agent-cn/hermes_cli/model_switch.py`,
  `D:/hermes-agent-cn/run_agent.py` (AIAgent.switch_model ≈line 1004),
  `D:/hermes-agent-cn/agent/agent_runtime_helpers.py` (≈line 2438),
  `D:/hermes-agent-cn/agent/agent_init.py`,
  `D:/hermes-agent-cn/hermes_cli/providers.py`,
  `D:/hermes-agent-cn/hermes_cli/model_normalize.py`,
  `D:/hermes-agent-cn/agent/model_metadata.py`,
  `D:/hermes-agent-cn/agent/models_dev.py`, `D:/hermes-agent-cn/gateway/run.py`.
- Docs: `D:/hermes-agent-cn/website/docs/reference/slash-commands.md` (lines 78,
  177-217), `D:/hermes-agent-cn/website/docs/user-guide/messaging/index.md`
  (lines 229-231, 315).
- Tests: `D:/hermes-agent-cn/tests/hermes_cli/test_model_switch_*.py` (12),
  `tests/hermes_cli/test_apply_model_switch_result_context.py`,
  `D:/hermes-agent-cn/tests/test_model_picker_scroll.py`,
  `D:/hermes-agent-cn/tests/run_agent/test_switch_model_*.py` (7).
- TS reference: `D:/kimi-code/packages/agent-core/src/services/modelCatalog/`
  (`modelCatalog.ts`, `modelCatalogService.ts`),
  `D:/kimi-code/packages/agent-core/src/config/model.ts`,
  `D:/kimi-code/packages/agent-core/src/agent/config/index.ts` + `types.ts`,
  `D:/kimi-code/apps/kimi-code/src/tui/commands/config.ts` (showModelPicker /
  performModelSwitch / persistModelSelection),
  `D:/kimi-code/apps/kimi-code/src/tui/commands/provider.ts`,
  `D:/kimi-code/packages/kosong` (providers).
- Desktop: `D:/Hermes-CN-Desktop/web/src/lib/model-context.ts`,
  `model-options-cache.ts`, `model-search-aliases.ts`, `last-used-model.ts`,
  `cn-provider-slugs.ts`, `hooks/use-model-options.ts`, `hooks/use-provider-models.ts`,
  `hooks/use-gateway.ts`, `routes/models.tsx`,
  `routes/settings-models-section.tsx`, `packages/protocol/src/hermes-api.ts`.
