# Provider Routing — Python → TypeScript Rewrite Plan

## 1. Summary

Provider routing gives users fine-grained control over **which sub-providers behind an
aggregator** (OpenRouter / Nous Portal) serve their requests: sort by `price` /
`throughput` / `latency`, whitelist (`only`), blacklist (`ignore`), explicit priority
(`order`), and `require_parameters` (only route to sub-providers that support every
request parameter). In Python the feature is almost entirely **config → request-payload
shaping**: `provider_routing` in `config.yaml` is loaded into `AIAgent` constructor
kwargs, validated, and emitted as `extra_body.provider` on OpenAI-wire chat-completion
requests. There is no routing engine on the Hermes side — OpenRouter/Nous do the actual
sub-provider selection.

For the TS rewrite we port: (1) the config schema + validation (pure, unit-testable),
(2) the preference-builder that produces the `provider` object, (3) the transport merge
into `extra_body`, and (4) a Desktop settings UI to edit the block. The companion Python
pieces `agent/model_metadata.py` (OpenRouter model metadata / context-length resolution)
and `hermes_cli/model_catalog.py` (remote curated model manifest for `openrouter`/`nous`)
are **not** part of the wire payload; they feed aggregator model picking and already have
Desktop analogues (`web/src/lib/provider-catalog.ts` remote manifest fetch), so they are
only referenced for parity where the UI needs aggregator model context.

## 2. Current Python implementation

### 2.1 Config loading (source of truth: `~/.hermes/config.yaml`)

```yaml
provider_routing:
  sort: "price"             # "price" | "throughput" | "latency"
  only: ["anthropic"]       # whitelist (lowercase OpenRouter slugs)
  ignore: ["together"]      # blacklist
  order: ["anthropic", "google"]  # priority, unlisted = fallback
  require_parameters: false # bool
  data_collection: null     # "allow" | "deny" | null
```

- `D:/hermes-agent-cn/cli.py:4606-4612` — CLI loads the block and stores
  `self._provider_sort`, `self._providers_only`, `self._providers_ignore`,
  `self._providers_order`, `self._provider_require_params`, `self._provider_data_collection`.
- `D:/hermes-agent-cn/gateway/run.py:8807` (`_load_provider_routing`) and
  `D:/hermes-agent-cn/tui_gateway/server.py:4236` — same block for gateway/TUI runs.
- These values are passed to `AIAgent` as constructor kwargs.

### 2.2 Agent construction — `D:/hermes-agent-cn/agent/agent_init.py`

- Constructor parameters (lines 539-544): `providers_allowed`, `providers_ignored`,
  `providers_order`, `provider_sort`, `provider_require_parameters`,
  `provider_data_collection`.
- Stored on the agent (lines 929-934) as `agent.providers_allowed`, etc. — plain
  attributes, no validation at this layer.

### 2.3 Preference building — `D:/hermes-agent-cn/agent/chat_completion_helpers.py`

- `_validated_openrouter_provider_sort(raw_sort)` (lines 167-181): lowercases/trims,
  accepts only `{"throughput","latency","price"}`, logs + returns `None` for anything
  else. (Python tests: `tests/agent/test_chat_completion_helpers_provider_sort.py`.)
- `_provider_preferences_for_agent(agent)` (lines 184-200): builds
  `{only?, ignore?, order?, sort?, require_parameters?, data_collection?}` — keys are
  omitted when unset, `require_parameters` emitted only when truthy.
- Used at line 1555 when assembling chat-completion kwargs; passed to the transport as
  `provider_preferences` (line 1620).

### 2.4 Wire emission — `D:/hermes-agent-cn/agent/transports/chat_completions.py`

- Legacy path (lines 520-522): when `is_openrouter` and prefs non-empty →
  `extra_body["provider"] = provider_prefs`.
- Profile path (lines 686-695): `profile.build_extra_body(provider_preferences=...)`;
  `providers/base.py:141` defines the `build_extra_body` hook; OpenRouter/Nous profiles
  merge the `provider` object into `extra_body` (same JSON shape).
- Auxiliary tasks (compression/title) are configured independently via
  `auxiliary.<task>.extra_body` — routing prefs do **not** propagate there (documented in
  `website/docs/user-guide/configuration.md`), and `_merge_nous_portal_messages_extra_body`
  (chat_completion_helpers.py:203-225) keeps Anthropic-wire Nous sessions tagging without
  routing prefs.

### 2.5 Companion metadata/catalog (not wire payload, but part of the feature surface)

- `D:/hermes-agent-cn/agent/model_metadata.py` — provider-prefix table
  (`_PROVIDER_PREFIXES`, `_strip_provider_prefix`), `is_local_endpoint`,
  `fetch_model_metadata`, OpenRouter model-metadata disk cache
  (`cache/openrouter_model_metadata.json`, TTL 1h). Used for context-length preflight on
  aggregator models.
- `D:/hermes-agent-cn/hermes_cli/model_catalog.py` — remote manifest
  (`https://desktop.hermesagent.org.cn/api/model-catalog.json`, schema v1, per-provider
  `openrouter`/`nous` blocks), disk cache `cache/model_catalog.json`, stale-while-revalidate,
  `get_curated_openrouter_models`, `get_curated_nous_models`, `get_default_model_from_cache`.
  Feeds the `/model` picker and default-model resolution on aggregator routes.

### 2.6 Docs

- `D:/hermes-agent-cn/website/docs/user-guide/features/provider-routing.md` — full
  option reference and "applies only to OpenRouter/Nous Portal" gating rule; also
  `website/docs/integrations/providers.md` (~line 1499) and the zh-Hans mirror under
  `website/i18n/zh-Hans/...`.

## 3. Target TypeScript design

Runs in-process; no Python backend. New modules under `web/src/lib/` and
`web/src/components/`:

### 3.1 `web/src/lib/provider-routing.ts` (pure, no React/IO)

```ts
export type OpenRouterProviderSort = "price" | "throughput" | "latency";

export interface ProviderRoutingConfig {
  sort?: OpenRouterProviderSort;
  only?: string[];              // whitelist slugs
  ignore?: string[];            // blacklist slugs
  order?: string[];             // priority order
  require_parameters?: boolean;
  data_collection?: "allow" | "deny";
}

export function validateOpenRouterProviderSort(raw: unknown): OpenRouterProviderSort | null;
export function parseProviderRoutingConfig(raw: unknown): ProviderRoutingConfig; // throws/omits invalid
export function providerPreferencesForAgent(cfg: ProviderRoutingConfig): Record<string, unknown>;
// → {only?, ignore?, order?, sort?, require_parameters?, data_collection?} — omitted when unset
export function applyProviderRoutingExtraBody(
  apiKwargs: Record<string, unknown>,
  prefs: Record<string, unknown> | null,
  isAggregator: boolean, // openrouter / nous base_url detection
): void; // apiKwargs.extra_body.provider = prefs when aggregator && prefs non-empty
```

Mirrors Python exactly: sort validated against the same 3-value set; `only`/`ignore`/
`order` normalized to trimmed, de-duplicated, lowercased non-empty slugs; `require_parameters`
only emitted when true; `data_collection` only `"allow"`/`"deny"` (null/absent → omitted).

### 3.2 `web/src/lib/provider-routing-config.ts` (config store access)

- `readProviderRouting(config: Record<string, unknown>): ProviderRoutingConfig` — reads
  `config.provider_routing`.
- `buildProviderRoutingUpdate(config, next: ProviderRoutingConfig)` — returns a nested
  patch via the existing `web/src/lib/config-update.ts` helpers
  (`buildNestedConfigUpdate`, `mergeConfigUpdate`), preserving untouched keys (e.g. clear
  `only` = set `provider_routing.only` to `[]`, matching Core semantics of "empty list = unset").
- `isAggregatorProvider(provider: ProviderPreset | undefined, baseUrl: string): boolean` —
  detects OpenRouter (`openrouter.ai`) / Nous (`nousresearch.com`) by host, mirroring
  `_is_openrouter_url` / `_is_nous` in the Core; used to gate the UI and the wire merge.

### 3.3 UI — `web/src/routes/settings-models-section.tsx` + new
`web/src/components/models/provider-routing-panel.tsx`

- Panel shown only when the active provider is an aggregator (OpenRouter preset exists in
  the builtin catalog at `web/src/lib/provider-catalog.ts:895`; Nous can be added as a
  custom provider — gate by host, not by preset id).
- Controls: sort select (price/throughput/latency/「未设置」), `only`/`ignore`/`order`
  chip editors (free-text lowercase slugs; no sub-provider catalog required — Core treats
  them as opaque strings), `require_parameters` switch, `data_collection` select
  (allow/deny/未设置).
- Save path reuses the existing debounced `saveConfig` mutation pattern
  (`settings-models-section.tsx:1109-1129`).

### 3.4 In-process request builder (post-migration)

`packages/protocol` request-builder or the future TS agent loop calls
`applyProviderRoutingExtraBody` before sending chat-completion payloads — replacing the
Python transport's `extra_body["provider"]` merge with a pure TS call.

## 4. Data models & persistence

- **Schema**: add zod schema to `D:/Hermes-CN-Desktop/packages/protocol/src/hermes-api.ts`
  (next to `ConfigResponse` / `ConfigUpdateRequest`, lines 434-442):

```ts
export const ProviderRoutingConfigSchema = z.object({
  sort: z.enum(["price", "throughput", "latency"]).optional(),
  only: z.array(z.string()).optional(),
  ignore: z.array(z.string()).optional(),
  order: z.array(z.string()).optional(),
  require_parameters: z.boolean().optional(),
  data_collection: z.enum(["allow", "deny"]).nullable().optional(),
});
```

- **Persistence**: no new DB. During migration the block lives inside the existing
  `config.yaml` record, read/written through the backend `/api/config` (protocol
  `ConfigResponse` = `z.record(z.unknown())`, `ConfigUpdateRequest {config}`). The
  Desktop already owns other config mutations this way (`config-update.ts`). For the
  in-process end-state, the same JSON config record is stored by the Tauri Rust side
  (config file) or `packages/minidb`-style store; the zod schema is shared, so no schema
  migration is needed — unknown keys are ignored by Core's loader (same as Python).
- **Normalization contract** (parity with Python): empty/whitespace slugs dropped;
  duplicates removed; `sort` invalid value → warn + treat as unset; `require_parameters`
  false → omit key rather than send `false`.

## 5. Third-party library strategy

This is a **no-new-dependency** feature. Every Python dependency has a direct TS analogue
already present in the Desktop repo:

| Python dependency / module | TS equivalent | Evidence |
|---|---|---|
| `orjson` (JSON parse/dump) | native `JSON.parse`/`JSON.stringify` | used across `web/src/lib/*` |
| `requests` / `urllib` (catalog fetch) | `fetch` via `web/src/lib/transport.ts` `fetchExternalJSON` | `web/src/lib/provider-catalog.ts:1655` fetches the remote catalog the same way |
| `yaml` (config.yaml) | not needed — Desktop writes/reads config through backend `/api/config` JSON (`ConfigUpdateRequest`); in-process phase keeps a JSON config record | `packages/protocol/src/hermes-api.ts:434-442` |
| OpenRouter/Nous routing **engine** | **none exists — implement from scratch** as the pure module in §3.1 | see below |

**kimi-code evidence (and the gap):**

- `D:/kimi-code/packages/agent-core/src/services/modelCatalog/modelCatalog.ts` +
  `modelCatalogService.ts` — `IModelCatalogService` (listModels/listProviders/getProvider/
  setDefaultModel/refreshProviderModels), `toProtocolModel`/`toProtocolProvider`,
  `ProviderNotFoundError`/`ModelNotFoundError`. This proves the **catalog-service +
  protocol-type + DI** pattern (`createDecorator`/`registerSingleton`) we reuse for a
  `ProviderRoutingService`, and the config-RPC pattern (`core.rpc.getKimiConfig` /
  `setKimiConfig`) mirrors our `/api/config` read/write.
- `D:/kimi-code/apps/kimi-code/src/tui/commands/provider.ts` — `/provider` command,
  `ProviderManagerComponent`, `TabbedModelSelectorComponent`, catalog import
  (`applyCatalogProvider`, `catalogProviderModels`, `resolveCatalogImport`). Proves the
  **provider picker / manager UI** pattern we copy for the Desktop settings panel.
- `D:/kimi-code/packages/agent-core/src/agent/config/types.ts` — `AgentConfigData`
  holds `provider?: ProviderConfig` + `modelAlias`; model selection is config-level, not
  request-level sub-provider routing.
- **Searched `packages/agent-core/src` for `provider sort|order|routing|only|ignore`,
  `require_parameters`, `data_collection`: no hits.** kimi-code does not implement
  OpenRouter-style sub-provider routing (it talks to direct providers). So there is **no
  TS reference implementation for the routing constraints themselves** — the pure module
  is written from scratch, but its surface is small and fully pinned by the Python
  helpers + OpenRouter's documented `provider` request field.

## 6. Integration with existing Hermes-CN-Desktop frontend

- **Reuse**:
  - `web/src/lib/config-update.ts` (`buildNestedConfigUpdate`, `mergeConfigUpdate`) —
    build `provider_routing` patches.
  - `web/src/routes/settings-models-section.tsx` — add the panel; reuse `saveConfig`
    mutation + debounce pattern (lines 1109-1129) and `ConfigResponse` read.
  - `web/src/lib/provider-catalog.ts` — `ProviderPreset` (esp. the `openrouter` preset at
    line 895), `isCustom` flag, `chatEndpointPreviewUrl`/`detectCustomApiModeFromUrl` for
    aggregator host detection; NOT `provider_order` (that is Desktop UI card order under
    `desktop.models.provider_order`, unrelated to OpenRouter `order` — keep them
    separate and name the new keys `provider_routing.*`).
  - `packages/protocol/src/hermes-api.ts` — add `ProviderRoutingConfigSchema`; the
    backend config endpoint is unchanged.
  - Hooks: `useProviderCatalog`, `useProviderModels`, `useModelOptions` give the panel
    aggregator model context (e.g. show `openrouter/auto`).
- **Replace**: nothing today — Desktop has no `provider_routing` UI (grep of
  `web/src` finds no `provider_routing` references).
- **Rust side**: none needed at first; config read/write stays on the HTTP/WS gateway
  path. When the runtime moves in-process, the config file read/write moves behind an
  existing Tauri command (e.g. a `config_get`/`config_set` command in `src/commands/*`).

## 7. Removing the WebSocket dependency (migration path)

1. **Today (keep backend call)**: Desktop edits `provider_routing` via `/api/config`
   `ConfigUpdateRequest`; the managed Python runtime (cli.py / gateway `_load_provider_routing`)
   already applies it to requests. UI parity can be shipped with zero Core changes.
2. **Freeze the API surface**: `ConfigResponse` / `ConfigUpdateRequest` (zod) and the
   `provider_routing` key shape become the frozen contract between the frontend and any
   runtime. Also freeze the RPC surface the panel reads: `provider.models`,
   `model.options` (`use-provider-models.ts`, `use-model-options.ts`).
3. **In-process module behind the same interface**: `ProviderRoutingConfigSchema` +
   `provider-routing.ts` pure functions + a `ProviderRoutingStore` (Jotai atom fed by
   config read) implement the same contract locally; `applyProviderRoutingExtraBody`
   plugs into the TS request builder.
4. **Delete WS/REST path**: once the in-process agent loop owns request construction,
   remove `/api/config` and `provider.models`/`model.options` calls for this feature and
   drop the managed-runtime dependency.

## 8. Migration phases & task breakdown

- **Phase 0 — Protocol & pure logic** (`provider-routing.md` design only → code tasks):
  - Add `ProviderRoutingConfigSchema` to `packages/protocol`.
  - Implement `web/src/lib/provider-routing.ts` + `provider-routing-config.ts`.
  - Vitest unit tests (see §10).
- **Phase 1 — UI on existing backend**:
  - `provider-routing-panel.tsx` + wiring in `settings-models-section.tsx`, gated on
    aggregator host detection; save via `saveConfig`/`buildProviderRoutingUpdate`.
  - E2E: config block appears in `/api/config` after save; Core applies it (integration
    check against the managed runtime).
- **Phase 2 — In-process runtime**:
  - Wire `applyProviderRoutingExtraBody` into the TS chat-completion request builder;
    parity tests against Python `_provider_preferences_for_agent` outputs.
- **Phase 3 — Decommission**:
  - Remove WS/REST config surface for this feature; delete managed-runtime calls.

## 9. Risks & open questions

- **No kimi-code equivalent for routing constraints** (only the catalog/picker plumbing):
  the `provider` payload semantics must be ported from Python/OpenRouter docs directly —
  mitigated by the small pure-function surface and parity tests.
- **Sub-provider slug discovery**: Desktop has no authoritative OpenRouter sub-provider
  slug list (Core passes `only`/`ignore`/`order` through opaquely). Decide: free-text
  chips (default, matches Core) vs. fetching OpenRouter's `/api/v1/providers` at some
  point. Chip validation must not reject unknown future slugs.
- **Aggregator gating drift**: Core applies routing only on OpenRouter/Nous routes; the
  UI must hide/disable the panel for direct providers and must match host-detection
  (OpenRouter base URL may be customized by users). Nous has no builtin Desktop preset
  today — custom-provider users must still get the panel (host-based detection covers it).
- **`data_collection` is in the Python/Docs surface** but was not in the requested
  feature list; plan keeps it for parity. Confirm product wants it exposed in the UI or
  only accepted in config.
- **`auxiliary.*` divergence**: aux-task `extra_body.provider` is intentionally
  independent of main-agent routing (Core docs). The TS design must not silently
  propagate main-agent prefs to aux tasks.
- **Empty-array semantics**: Core treats `only: []`/`ignore: []` as unset; the UI and
  zod normalization must agree so clearing a list removes the key rather than sending
  `"only": []`.

## 10. Test strategy

- **Vitest unit (new)**:
  - `web/src/lib/provider-routing.test.ts` — sort validation
    (`validateOpenRouterProviderSort` accepts `price`/` latency `/`THROUGHPUT`, rejects
    `intelligence`/`""`/null — parity with
    `tests/agent/test_chat_completion_helpers_provider_sort.py`); preference builder
    omits unset keys; `applyProviderRoutingExtraBody` sets `extra_body.provider` only for
    aggregators and non-empty prefs; normalization of slugs (trim/lower/dedupe).
  - `web/src/lib/provider-routing-config.test.ts` — `buildProviderRoutingUpdate` merges
    without clobbering other keys; clearing a list yields `provider_routing.only = []`.
- **Parity tests vs Python behavior** (mirror real Core tests; note the exact
  `test_provider_routing*.py`/`test_routing*.py` names from `features_report.md` do **not**
  exist verbatim — the actual coverage lives in):
  - `tests/agent/test_chat_completion_helpers_provider_sort.py`
  - `tests/agent/transports/test_chat_completions.py` (line ~178: prefs → `extra_body.provider`)
  - `tests/run_agent/test_run_agent.py` (line ~1315: `providers_allowed` → `only`)
  - `tests/run_agent/test_provider_parity.py` (line ~863: no `provider` key when unconfigured)
  - `tests/hermes_cli/test_model_switch_configured_provider_routing.py` (typed `/model`
    routing to configured provider — Desktop model-switch parity)
  - `tests/agent/test_custom_provider_extra_body.py`, `test_custom_provider_extra_body_matching.py`
  - `tests/run_agent/test_background_review_cache_parity.py` (prefs forwarded to
    background-review tasks)
- **Integration**: save via the config panel → assert the JSON block; a fake aggregator
  transport asserts `extra_body.provider` shape.
- **Playwright E2E**: panel visibility (hidden for direct provider, shown for OpenRouter),
  edit + reload persistence, chips add/remove.

## 11. Reference links

- Core docs: `D:/hermes-agent-cn/website/docs/user-guide/features/provider-routing.md`,
  `website/docs/integrations/providers.md`, `website/docs/reference/environment-variables.md`
- Core impl: `agent/agent_init.py` (539-544, 929-934),
  `agent/chat_completion_helpers.py` (167-200, 1555, 1620),
  `agent/transports/chat_completions.py` (520-522, 686-695),
  `agent/model_metadata.py`, `hermes_cli/model_catalog.py`,
  `cli.py` (4606-4612), `gateway/run.py` (8807), `tui_gateway/server.py` (4236),
  `providers/base.py` (141)
- Core tests: `tests/agent/test_chat_completion_helpers_provider_sort.py`,
  `tests/agent/transports/test_chat_completions.py`, `tests/run_agent/test_run_agent.py`,
  `tests/run_agent/test_provider_parity.py`,
  `tests/hermes_cli/test_model_switch_configured_provider_routing.py`
- kimi-code TS reference: `packages/agent-core/src/services/modelCatalog/modelCatalog.ts`,
  `modelCatalogService.ts`, `apps/kimi-code/src/tui/commands/provider.ts`,
  `packages/agent-core/src/agent/config/types.ts`
- Desktop: `web/src/lib/provider-catalog.ts`, `web/src/lib/config-update.ts`,
  `web/src/hooks/use-provider-catalog.ts`, `use-provider-models.ts`, `use-model-options.ts`,
  `web/src/routes/models.tsx`, `web/src/routes/settings-models-section.tsx`,
  `packages/protocol/src/hermes-api.ts`
