# Chinese Model Provider Metadata — Python → TypeScript Rewrite Plan

## 1. Summary

Port the CN model-provider metadata layer from the Python backend
(`D:/hermes-agent-cn`) into the TypeScript frontend so the Dashboard model
page (1) recognizes ARK, 千帆/Qianfan, 混元/Hunyuan, SiliconFlow, ModelScope,
AI302, CompShare and LongCat env-var credentials offline, and (2) resolves
provider/model capability + context metadata from an **offline-first
models.dev snapshot** instead of the Python runtime's `requests` fetch.

Today the desktop already has a substantial CN provider UI: a hand-curated
`web/src/lib/provider-catalog.ts` (presets with base URLs, models, api-key
labels), `use-provider-catalog.ts` (built-in + remote merge), and the env-var
panel inside `settings-models-section.tsx` which renders **only what the
backend `/api/env` returns** (Core `OPTIONAL_ENV_VARS`, fork patches P-006 /
P-010). The Python side additionally has the models.dev offline snapshot
(P-028) that powers context/capability lookups (`agent/models_dev.py`,
`agent/model_metadata.py`).

This plan designs the TS twin: a **models.dev snapshot JSON asset + fetch
fallback with China-mirror URL override**, a **TS metadata catalog module**
(provider ↔ models.dev ID mapping, env-var recognition registry), and the
migration path to delete the `/api/env` + models.dev REST dependency once the
WebSocket/runtime link is removed. This is a design-only plan; no implementation.

## 2. Current Python implementation

Source of truth lives in `D:/hermes-agent-cn`:

- **`hermes_cli/config_defaults.py`** — pure-data leaf. `OPTIONAL_ENV_VARS`
  dict (lines 3310+) carries per-env-var metadata `{description, prompt, url,
  password, category, advanced, tools}`. CN entries are registered by fork
  patches **P-006** (ARK, COMPSHARE, QIANFAN, HUNYUAN, SILICONFLOW, MODELSCOPE,
  AI302 — lines 4495-4560) and **P-010** (`LONGCAT_API_KEY` — lines 4561-4571).
  Every CN entry is `category: "provider"`, most `advanced: True`,
  `password: True`, with a Chinese `description` and an official docs `url`
  (volcengine.com, compshare.cn, baidu.com, cloud.tencent.com,
  docs.siliconflow.cn, modelscope.cn, 302.ai, longcat.chat).
- **`hermes_cli/web_server.py`** exposes `GET /api/env` returning this dict as
  `EnvVarInfo` records; the dashboard env panel renders them.
- **`agent/models_dev.py`** — models.dev registry integration (P-028):
  - `MODELS_DEV_URL = os.getenv("HERMES_MODELS_DEV_URL", "https://models.dev/api.json")`
    + `HERMES_MODELS_DEV_TIMEOUT` (lines 59-60) — the **China mirror override**.
  - Cache hierarchy `fetch_models_dev()` (lines 492-613): fresh in-mem → stale
    in-mem + background refresh → disk cache (`~/.hermes/models_dev_cache.json`)
    → **bundled snapshot** (`agent/models_dev_snapshot.json`, 3.2 MB, shipped
    via `importlib.resources`/PyInstaller `_MEIPASS`, lines 297-382) → network.
    `allow_network=False` never touches the network (used by model save/switch).
  - `PROVIDER_TO_MODELS_DEV` mapping (lines 191-237): Hermes provider names →
    models.dev IDs (e.g. `alibaba`, `deepseek`, `zai`, `kimi-for-coding`,
    `stepfun`, `xiaomi`, `openrouter`, `ollama-cloud`).
  - Dataclasses `ModelInfo` (context_window, max_output, cost per M tokens,
    capabilities, modalities) and `ProviderInfo` (name, `env` tuple, `api`
    base URL, `doc` URL, model_count) with raw-JSON parsers
    `_parse_model_info` / `_parse_provider_info`.
  - Queries: `get_provider_info`, `get_model_info`, `list_provider_models`,
    `list_agentic_models` (filters `tool_call=True` + `_NOISE_PATTERNS`),
    `get_model_capabilities` (reasoning/vision/PDF/audio/tools/context).
  - Refresh tooling: `scripts/refresh_models_dev_snapshot.py` re-fetches the
    bundled snapshot, honours `HERMES_MODELS_DEV_URL`, writes minified
    key-sorted JSON.
- **`agent/model_metadata.py`** — context-length resolution: `_URL_TO_PROVIDER`
  host map (lines 687-729), `DEFAULT_CONTEXT_LENGTHS` thin family fallbacks
  (lines 429-589, e.g. `hy3-preview`/`hy3` Hunyuan 256K), models.dev as primary
  source, `MINIMUM_CONTEXT_LENGTH = 64_000`.
- **`hermes_cli/web_models.py`** — Pydantic schemas for the dashboard surface:
  `EnvVarInfo`, `EnvVarsResponse`, `ConfigUpdate`, `ModelAssignment`,
  `ProviderModelsListResult` (parity target for `packages/protocol`).
- **`hermes_cli/model_setup_flows.py`** — CLI picker flows; merge order is
  models.dev `list_agentic_models(provider_id)` → curated `_PROVIDER_MODELS`
  → live `/models` probe (lines 2880-2993).

Python tests that define parity:
- `tests/agent/test_models_dev.py` — P-028 offline snapshot, non-blocking
  `allow_network=False`, disk-before-snapshot fallback, snapshot file valid.
- `tests/agent/test_models_dev_meta_mapping.py`, `tests/hermes_cli/test_models_dev_preferred_merge.py`.
- `tests/agent/test_custom_providers_vision.py` — capability overrides for
  image routing (vision metadata consumers).
- `tests/hermes_cli/test_model_metadata.py`, `test_custom_provider_context_length.py`.

## 3. Target TypeScript design

New module tree under `web/src/lib/models-dev/` (pure TS, no React):

```
web/src/lib/models-dev/
  types.ts            # Catalog / CatalogProviderEntry / CatalogModelEntry /
                      # ModelsDevProviderInfo / ModelsDevModelInfo (mirrors
                      # kimi-code kosong/src/catalog.ts types)
  snapshot.json       # offline models.dev snapshot (CN-first pruned + full
                      # provider entry for mapped IDs; generated by
                      # scripts/refresh-models-dev-snapshot.mjs)
  catalog.ts          # fetchModelsDev() + offline fallback + cache hierarchy
                      # (mirrors Core fetch_models_dev + kimi-code catalog-fetch.ts)
  providers.ts        # HERMES_TO_MODELS_DEV + MODELS_DEV_TO_HERMES maps
                      # (parity: agent/models_dev.py PROVIDER_TO_MODELS_DEV)
  query.ts            # pure functions: getProviderInfo, getModelInfo,
                      # listAgenticModels, getModelCapabilities, lookupContext
  env-vars.ts         # CN_ENV_VAR_METADATA registry (parity: OPTIONAL_ENV_VARS
                      # P-006/P-010) + envKeyToProvider() recognition helper
  mirror.ts           # resolveModelsDevUrl() — China mirror env override
```

Key interfaces (signatures only):

```ts
// types.ts — parity with agent/models_dev.py ModelInfo/ProviderInfo
export interface ModelsDevModelInfo {
  id: string; name: string; family: string; providerId: string;
  reasoning: boolean; toolCall: boolean; supportsVision: boolean; // attachment|modalities
  structuredOutput: boolean; openWeights: boolean;
  contextWindow: number; maxOutput: number;
  costInput: number; costOutput: number; costCacheRead?: number; costCacheWrite?: number;
  status: string; knowledgeCutoff: string;
}
export interface ModelsDevProviderInfo {
  id: string; name: string; env: string[]; api: string; doc: string; modelCount: number;
}

// catalog.ts — offline-first registry (P-028 parity)
export interface FetchModelsDevOptions { allowNetwork?: boolean; forceRefresh?: boolean; }
export function fetchModelsDev(opts?: FetchModelsDevOptions): Promise<ModelsDevRegistry>;
export function prewarmModelsDev(): void; // singleflight, fire-and-forget

// query.ts — pure lookups, non-blocking by default
export function getProviderInfo(providerId: string, opts?): ModelsDevProviderInfo | undefined;
export function getModelInfo(providerId: string, modelId: string, opts?): ModelsDevModelInfo | undefined;
export function listAgenticModels(providerId: string): string[];
export function getModelCapabilities(providerId: string, modelId: string): ModelCapabilities | undefined;
export function lookupContextWindow(providerId: string, modelId: string): number | undefined;

// env-vars.ts — Dashboard env-var panel recognition (P-006/P-010 parity)
export interface EnvVarMeta {
  key: string; description: string; prompt: string; url: string | null;
  password: boolean; category: "provider" | "tool" | "messaging" | "setting" | "service";
  advanced: boolean; tools: string[];
}
export const CN_ENV_VAR_METADATA: Record<string, EnvVarMeta> = {
  ARK_API_KEY:         { description: "火山方舟（豆包系列）API key", url: "https://www.volcengine.com/docs/82379", password: true, category: "provider", advanced: true },
  COMPSHARE_API_KEY:   { description: "优云智算（Compshare）API key", url: "https://www.compshare.cn/", password: true, category: "provider", advanced: true },
  QIANFAN_API_KEY:     { description: "百度智能云千帆 API key（文心一言 / ERNIE 系列）", url: "https://cloud.baidu.com/doc/WENXINWORKSHOP/index.html", password: true, category: "provider", advanced: true },
  HUNYUAN_API_KEY:     { description: "腾讯混元 API key", url: "https://cloud.tencent.com/document/product/1729", password: true, category: "provider", advanced: true },
  SILICONFLOW_API_KEY: { description: "硅基流动（SiliconFlow）API key", url: "https://docs.siliconflow.cn/", password: true, category: "provider", advanced: true },
  MODELSCOPE_API_KEY:  { description: "魔搭 ModelScope 推理服务 API key", url: "https://modelscope.cn/docs/model-service/API-Inference/intro", password: true, category: "provider", advanced: true },
  AI302_API_KEY:       { description: "302.AI 聚合 API key", url: "https://302.ai/", password: true, category: "provider", advanced: true },
  LONGCAT_API_KEY:     { description: "美团 LongCat API key", url: "https://longcat.chat/platform/docs", password: true, category: "provider", advanced: true },
  ARK_BASE_URL:        { description: "火山方舟 base URL override (default: https://ark.cn-beijing.volces.com/api/v3)", password: false, category: "provider", advanced: true },
};
export function envKeyToProvider(envKey: string): string | undefined; // e.g. "ARK_API_KEY" -> "volcengine-ark" preset id / "ark" models.dev id
```

Data flow (in-process, no Python):

1. App start: `prewarmModelsDev()` starts a singleflight fetch of
   `resolveModelsDevUrl()` (mirror override wins). UI renders immediately from
   `snapshot.json` (served through Vite static asset or `?raw` import).
2. `settings-models-section.tsx` env panel: instead of requiring `GET /api/env`
   to know a key exists, it merges `CN_ENV_VAR_METADATA` + existing
   `env-translations.ts` labels with the env state read from the local bridge;
   unknown keys returned by an old runtime still render (graceful degradation).
3. Model cards/picker: capability tags come from `getModelCapabilities`
   (snapshot) and are only overridden by live `provider.models` RPC / user
   custom providers — same precedence as today's `goose-composer-model-picker`
   (`ModelOptionsResult.capabilities` first, desktop catalog second).

## 4. Data models & persistence

- **No SQLite/IndexedDB.** The registry is a read-only JSON asset plus an
  in-memory cache, mirroring Core's disk-cache → snapshot hierarchy.
- **`snapshot.json`** is the offline floor (P-028 parity). Ship as a static
  asset in `web/public/models-dev-snapshot.json` (or Vite `?raw` import) —
  NOT inlined in the JS bundle: Core's full snapshot is 3.2 MB; see §9 risk.
  A build-time `scripts/refresh-models-dev-snapshot.mjs` regenerates it from
  `resolveModelsDevUrl()` (mirror-aware), key-sorted + minified like Core's.
- **In-memory cache** lives in `catalog.ts` module state:
  `{ registry, fetchedAt, retryAfter, refreshInFlight }` with TTL 1 h and a
  5 min failure backoff (parity `_MODELS_DEV_CACHE_TTL`/`_MODELS_DEV_RETRY_DELAY`).
- **Optional disk cache** (future, post-WS-removal): write the fetched registry
  to Tauri app-data dir (`~/.hermes/models_dev_cache.json`) via a small Rust
  command; keeps cold-start offline even when snapshot is stale. Keep optional
  in phase 3 so Phase 1/2 ship without new Rust surface.
- **Env-var state** is not persisted by this feature; it stays owned by the
  profile `.env` writer (today `PUT /api/env`, later a Tauri command). The
  metadata registry is read-only UI metadata.
- **Schema** lives in `packages/protocol` as Zod:
  `ModelsDevCatalog`, `ModelsDevProviderInfo`, `ModelsDevModelInfo`,
  `EnvVarMeta` (extends existing `EnvVarInfo` in `hermes-api.ts` lines 651-667).

## 5. Third-party library strategy

| Python dependency | TS equivalent | kimi-code evidence |
|---|---|---|
| `requests` (models.dev fetch, `agent/models_dev.py`) | global `fetch` wrapped in `fetchExternalJSON` (`web/src/lib/transport.ts:212`) | `packages/node-sdk/src/catalog.ts` `fetchCatalog()` uses `fetch` + `AbortSignal` (lines 41-57); `apps/kimi-code/src/utils/catalog-fetch.ts` `fetchCatalogOrBuiltIn()` |
| `orjson` (parse/emit snapshot) | `JSON.parse` / `JSON.stringify`; Zod validation via `@hermes/protocol` | `loadBuiltInCatalog()` does `JSON.parse(text)` (`packages/node-sdk/src/catalog.ts:109-116`) |
| `importlib.resources`/PyInstaller `_MEIPASS` (snapshot discovery, `_bundled_snapshot_candidates`) | Vite static asset + `fetch` (public dir) or `?raw` import; no in-code path probing needed | `apps/kimi-code/src/built-in-catalog.ts` injects `__KIMI_CODE_BUILT_IN_CATALOG__` via tsdown define — same "snapshot injected at build" pattern |
| `yaml`/`toml` (none — `config_defaults.py` is pure dict) | none; the registry is a plain TS module / JSON | kosong config reads TOML via `@iarna/toml` (`packages/agent-core/src/config/toml.ts`), but this feature has no config-file parsing |
| `threading` background refresh (`_start_background_refresh_models_dev`) | singleflight promise + `AbortController`; no worker thread | `modelCatalogService.ts` `_refreshChain` serializes refreshes (lines 39, 114-123); `use-provider-catalog.ts` already does async refresh + fallback |
| Pydantic schemas (`hermes_cli/web_models.py`) | Zod in `packages/protocol/src/hermes-api.ts` | protocol package already Zod-encodes `EnvVarInfo`/`ProviderModelsListResult` |
| models.dev JSON schema parsing (`_parse_model_info`/`_parse_provider_info`) | **Implement from scratch** — but kimi-code already did it: `packages/kosong/src/catalog.ts` defines `Catalog`, `CatalogProviderEntry`, `CatalogModelEntry`, `CatalogModel` and `catalogProviderModels()`/`catalogModelToCapability()` (lines 9-436); copy the shape and the filtering rules (`status deprecated/alpha` drop, embedding marker) | kosong `catalog.ts` + node-sdk `catalog.ts` |

**No-TS-equivalent risks**: (a) Core's `requests`+`orjson` snapshot is 3.2 MB —
kimi-code's tsdown define inlines a pruned catalog at build; a full 3.2 MB
inline constant would bloat the web bundle, so this plan ships it as a static
asset (see §9). (b) Core reads env vars from the managed Python process;
without the runtime, the webview must read process env through the Tauri bridge
(`window.hermesDesktop.*`), which kimi-code does via its own `IEnvironmentService`
(`packages/agent-core/src/services/environment/`) — a small Rust command is the
TS-side equivalent.

## 6. Integration with existing Hermes-CN-Desktop frontend

Reuse, don't replace:

- **`web/src/lib/provider-catalog.ts`** (`ProviderPreset`, `ProviderCatalogModel`,
  `BUILTIN_PROVIDER_CATALOG`, `mergeProviderCatalog`, `fetchRemoteProviderCatalog`,
  `sortProvidersForCnEdition`, `providerApiKeyLabels`, `getProviderCredentialPreview`) —
  stays the UX-level catalog (presets, referral promotions, base URLs, api-mode).
  The new models-dev modules feed **capability/context metadata** into it (an
  enrich step: `enrichProviderPresetWithModelsDev(preset)`), never its wire config.
- **`web/src/hooks/use-provider-catalog.ts`** — already the built-in+remote merge
  pattern; the models.dev prewarm hook `useModelsDevCatalog()` follows the same
  shape (built-in snapshot floor → remote refresh → fallback).
- **`web/src/routes/settings-models-section.tsx`** — the env-var panel
  (`useEnvVars()` at line 599, `providerEnvEntries` grouping at 838-843,
  `translateEnvVar` at 56). Phase 1 keeps `useEnvVars()`; Phase 3 swaps it for a
  local env-state hook and merges `CN_ENV_VAR_METADATA` so ARK/QIANFAN/HUNYUAN/
  SILICONFLOW/MODELSCOPE/AI302/COMPSHARE/LONGCAT keys render with Chinese
  labels + docs links even when `/api/env` is gone. `env-translations.ts`
  `PROVIDER_PREFIX_TRANSLATIONS` already covers `AI302/ARK/COMPSHARE/HUNYUAN/
  LONGCAT/MODELSCOPE/QIANFAN/SILICONFLOW` — reuse it, don't duplicate labels.
- **`web/src/hooks/use-provider-models.ts`** — live `/models` refresh stays
  backend/RPC-backed; models.dev snapshot only fills the static model list when
  `supportsModelListing === false` (already the `mergedModelOptions` behavior,
  settings-models-section.tsx lines 856-878).
- **`web/src/lib/cn-provider-slugs.ts`** — unchanged; `CN_BACKEND_PROVIDER_SLUGS`
  is the gateway slug_filter. models.dev IDs map through `HERMES_TO_MODELS_DEV`.
- **`web/src/components/chat/goose-composer-model-picker.ts`** — capability tags
  currently prefer `ModelOptionsResult.capabilities` (Core models.dev metadata,
  see `goose-composer-model-picker.test.ts:70-110`). Phase 3 replaces that
  source with `getModelCapabilities()` from the snapshot.
- **`packages/protocol/src/hermes-api.ts`** — add Zod schemas for
  `ModelsDevCatalog`/`ModelsDevModelInfo`/`ModelsDevProviderInfo` next to
  `EnvVarInfo` (line 651) and `ProviderModelsListResult` (line 1433).
- **Rust (`src/commands/*`)** — new read-only commands only in Phase 3:
  `models_dev_cache_path`/`env_var_get`/`env_var_list` for local env read +
  optional disk cache. Reuses `src/error.rs` conventions.
- **`web/src/lib/transport.ts` `fetchExternalJSON`** — reuse for network
  models.dev fetches (Tauri `externalRequest` when available, browser `fetch`
  fallback with 15 s timeout).

## 7. Removing the WebSocket dependency (migration path)

Today `GET /api/env` (REST, not WS) and `provider.models` RPC (WS) both come
from the runtime. Freeze these API surfaces during migration:

- **Freeze `/api/env` response shape** = `EnvVarsResponse` (`Record<key,
  EnvVarInfo>`) with the exact `OPTIONAL_ENV_VARS` fields; already encoded in
  `packages/protocol`. Phase 1-2 keep calling it; the TS metadata registry is
  the offline twin so the UI renders identically without it.
- **Freeze `provider.models` RPC result** = `ProviderModelsListResult`
  (`ok/models/model_count/status_code/error/error_kind`).
- **Freeze `ModelOptionsResult.capabilities`** shape (per-model
  `supports_tools/supports_vision/.../context_window/max_output_tokens/
  model_family`) — the `goose-composer-model-picker` contract.

Phases:
1. **Shadow twin (backend still authoritative)**: add `web/src/lib/models-dev/`
   snapshot + queries; unit-test them against fixtures extracted from
   `agent/models_dev_snapshot.json`. No UI change.
2. **UI adopts offline metadata**: `settings-models-section.tsx` enriches
   preset cards + env panel with `CN_ENV_VAR_METADATA` and snapshot capabilities
   while still calling `/api/env`/`provider.models` when connected (runtime
   values win; snapshot fills gaps). This is the WS-link-friendly state.
3. **Delete the dependency**: replace `useEnvVars()` with local env state read
   via Tauri command; `goose-composer-model-picker` uses snapshot capabilities;
   `provider.models` RPC replaced by in-process `/models` probe (the
   `use-provider-models.ts` interface stays, backed by Tauri HTTP or fetch).
4. **Cleanup**: remove the now-dead REST/WS paths in Core usage from the
   desktop (keep Core endpoints for older shells, per P-009 deprecation policy).

## 8. Migration phases & task breakdown

1. **Phase 0 — Tooling**: `scripts/refresh-models-dev-snapshot.mjs` (mirror-aware,
   `HERMES_MODELS_DEV_URL`/`VITE_HERMES_MODELS_DEV_URL`); commit
   `web/src/lib/models-dev/snapshot.json` (pruned: all `PROVIDER_TO_MODELS_DEV`
   targets + env-recognized providers). Generate fixture JSON for tests.
2. **Phase 1 — Core TS modules**: `types.ts`, `catalog.ts` (cache hierarchy +
   singleflight + backoff), `providers.ts` (ID maps), `query.ts`
   (`getProviderInfo/getModelInfo/listAgenticModels/getModelCapabilities/
   lookupContextWindow`), `mirror.ts`. Vitest coverage vs Python fixture
   behaviors (offline-first, stale-cache fallback, force-refresh).
3. **Phase 2 — Env-var recognition**: `env-vars.ts` registry (P-006/P-010
   parity); `translateEnvVar` extension to prefer `CN_ENV_VAR_METADATA`
   descriptions; settings-models-section renders recognized keys with
   password masking + docs URLs regardless of `/api/env` availability.
4. **Phase 3 — Local env + picker integration**: Rust commands for env
   read/list + optional disk cache; swap `useEnvVars()`; swap
   `goose-composer-model-picker` capability source; keep `use-provider-models`
   interface unchanged (now Tauri-backed).
5. **Phase 4 — Cleanup & docs**: remove dead transport calls; update
   `FORK_NOTES`-style plan note; E2E.

## 9. Risks & open questions

- **Bundle size**: full 3.2 MB snapshot inlined = bad. Mitigation: static asset
  fetched at runtime + pruned CN-first slice inline (`models-dev-snapshot.cn.json`
  covering only the 8 CN providers + mapped built-ins) for instant offline UI.
  Open: acceptable size for the pruned slice (~100-300 KB?).
- **Snapshot freshness vs curated catalog divergence**: Core's snapshot is
  refreshed at runtime release time (P-028); the desktop snapshot must be
  regenerated on the same cadence or it will drift from Core's
  `models_dev_snapshot.json`. Add a CI freshness check comparing key counts.
- **Env-var read without Python**: webview cannot read arbitrary process env.
  The Tauri bridge command must be narrow (allow-list of `*_API_KEY`-shaped
  keys) and never leak values to logs; until Phase 3, `/api/env` remains the
  source of `is_set` truth.
- **Zh label duplication**: `env-translations.ts` + new `env-vars.ts` both carry
  Chinese text. Design decision: `env-vars.ts` stores the Core-verbatim Chinese
  `description` (parity), `env-translations.ts` keeps UI overrides — risk of
  drift; tests should pin one source for CN keys.
- **API-mode divergence**: models.dev `api` URLs (kosong `catalogBaseUrl`
  strips `/v1` for anthropic wires) differ from the desktop `ProviderPreset`
  base URLs. Snapshot enrichment must never overwrite preset `baseUrl`.
- **No TS equivalent found** (full list): `orjson` (not needed — JSON.parse),
  `importlib.resources` (replaced by Vite asset), `threading` background
  refresh (replaced by promise singleflight), Core's process-env access
  (requires new small Rust command), and a **full-size bundled snapshot**
  (kimi-code prunes at build; we ship as asset — no direct equivalent exists).
- Open question: should the snapshot follow Core's disk-cache JSON format
  byte-for-byte so the desktop can reuse `~/.hermes/models_dev_cache.json`?
  (Recommended yes for Phase 3 disk cache.)

## 10. Test strategy

- **Vitest unit (parity with Python)**:
  - `web/src/lib/models-dev/query.test.ts` — `getProviderInfo`/`getModelInfo`
    exact + case-insensitive matches, context=0 filtering (parity
    `tests/agent/test_models_dev.py:139-162`).
  - `catalog.test.ts` — offline-first: `allowNetwork:false` never calls fetch;
    stale cache before snapshot; snapshot before network failure; force-refresh
    bypasses backoff (parity `test_models_dev.py:327-466`, P-028).
  - `env-vars.test.ts` — every CN key in `CN_ENV_VAR_METADATA` has
    `category:"provider"`, non-empty `description`, https `url` or null,
    and `envKeyToProvider` round-trips against `provider-catalog.ts` presets
    (volcengine-ark/baidu-qianfan/tencent-hunyuan/siliconflow/modelscope/
    compshare/longcat; AI302 maps to an aggregator preset or models.dev id).
  - `providers.test.ts` — `HERMES_TO_MODELS_DEV` covers every
    `CN_BACKEND_PROVIDER_SLUGS` entry (parity `test_models_dev_meta_mapping.py`).
  - Vision capability parity: snapshot `modalities.input` wins over
    `attachment` flag (parity `agent/models_dev.py` lines 813-827 and
    `tests/agent/test_models_dev.py:536-558`).
- **Integration**: settings-models-section render test with a mocked local env
  state (no `/api/env`) verifying ARK/QIANFAN/HUNYUAN/SILICONFLOW/MODELSCOPE/
  AI302/COMPSHARE/LONGCAT rows render with labels + docs links; mirrored from
  `web/src/lib/env-translations.test.ts` patterns.
- **Playwright E2E**: model page loads with network blocked (offline snapshot
  serves cards + env panel); remote catalog refresh failure falls back to
  built-in (already covered pattern in `use-provider-catalog`).
- **Parity fixtures**: slice `D:/hermes-agent-cn/agent/models_dev_snapshot.json`
  into small JSON fixtures checked into the test dir; assert identical parse
  results between a Python reference script (optional) and `query.ts`.

## 11. Reference links

- `D:/hermes-agent-cn/hermes_cli/config_defaults.py` — `OPTIONAL_ENV_VARS` (P-006/P-010 CN entries, lines 4495-4571)
- `D:/hermes-agent-cn/agent/models_dev.py` — P-028 offline snapshot, `HERMES_MODELS_DEV_URL`, `PROVIDER_TO_MODELS_DEV`, `ModelInfo`/`ProviderInfo`
- `D:/hermes-agent-cn/agent/models_dev_snapshot.json` (3.2 MB bundled snapshot)
- `D:/hermes-agent-cn/agent/model_metadata.py` — `_URL_TO_PROVIDER`, `DEFAULT_CONTEXT_LENGTHS`
- `D:/hermes-agent-cn/hermes_cli/web_models.py` — `EnvVarInfo`/`EnvVarsResponse`/`ProviderModelsListResult` Pydantic parity
- `D:/hermes-agent-cn/scripts/refresh_models_dev_snapshot.py` — snapshot refresh tooling
- `D:/hermes-agent-cn/FORK_NOTES.zh-CN.md` — P-006 (CN env vars), P-010 (LONGCAT_API_KEY), P-028 (models.dev offline-first)
- `D:/hermes-agent-cn/README.md` — "中文模型服务商元数据" mission statement
- `D:/kimi-code/packages/kosong/src/catalog.ts` — TS models.dev `Catalog` types + normalization (`catalogProviderModels`, `catalogModelToCapability`, `resolveCatalogImport`)
- `D:/kimi-code/packages/node-sdk/src/catalog.ts` — `DEFAULT_CATALOG_URL`, `fetchCatalog`, `loadBuiltInCatalog`, `applyCatalogProvider`
- `D:/kimi-code/apps/kimi-code/src/utils/catalog-fetch.ts` — `fetchCatalogOrBuiltIn` fallback pattern
- `D:/kimi-code/apps/kimi-code/src/built-in-catalog.ts` — tsdown-injected built-in snapshot
- `D:/kimi-code/packages/agent-core/src/services/modelCatalog/modelCatalog.ts` + `modelCatalogService.ts` — catalog service interface + refresh chain
- `D:/Hermes-CN-Desktop/web/src/lib/provider-catalog.ts` — `ProviderPreset`/`BUILTIN_PROVIDER_CATALOG`/`mergeProviderCatalog`/`fetchRemoteProviderCatalog`
- `D:/Hermes-CN-Desktop/web/src/hooks/use-provider-catalog.ts` — built-in + remote merge hook
- `D:/Hermes-CN-Desktop/web/src/hooks/use-provider-models.ts` — `provider.models` RPC consumer
- `D:/Hermes-CN-Desktop/web/src/hooks/use-env.ts` — `GET/PUT/DELETE /api/env` + reveal
- `D:/Hermes-CN-Desktop/web/src/lib/env-translations.ts` — zh env-var labels (CN provider prefixes already present)
- `D:/Hermes-CN-Desktop/web/src/routes/settings-models-section.tsx` — env panel + provider catalog integration
- `D:/Hermes-CN-Desktop/web/src/lib/cn-provider-slugs.ts` — `CN_BACKEND_PROVIDER_SLUGS`
- `D:/Hermes-CN-Desktop/web/src/lib/transport.ts` — `fetchExternalJSON` (lines 212+)
- `D:/Hermes-CN-Desktop/packages/protocol/src/hermes-api.ts` — `EnvVarInfo` (651), `EnvVarsResponse` (669), `ProviderModelsListResult` (1433)
- `D:/Hermes-CN-Desktop/web/src/components/chat/goose-composer-model-picker.ts` (+ `.test.ts`) — Core models.dev capabilities consumer
