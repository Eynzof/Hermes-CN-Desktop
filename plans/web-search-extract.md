# Web Search & Extract — Python → TypeScript Rewrite Plan

## 1. Summary

`web_search` + `web_extract` are two agent-callable tools that let the model search the web and
fetch page content. Python supports **8 backends** behind one surface — Firecrawl (default),
SearXNG, Brave (free tier), DuckDuckGo (ddgs), Tavily, Exa, Parallel, xAI Grok — with a
**per-capability split** (`web.search_backend` vs `web.extract_backend` falling back to
`web.backend`), deterministic **long-page truncation** (head+tail window + `[TRUNCATED]` footer)
and **saved full text** under `$HERMES_HOME/cache/web/` so the agent can `read_file` the omitted
middle.

Target TS design: a new pure-TS workspace package `packages/web-tools` holding the provider
interface, registry, per-vendor backends, SSRF/secret checks, and truncate-and-store pipeline,
invoked in-process by the future TS agent loop. All backends are plain HTTPS REST/JSON (no CDP,
no WS), so unlike browser-automation no Node sidecar is mandatory; HTTP is routed through a small
Rust IPC command that reuses the SSRF validation already in `src/commands/api_proxy.rs`.
**Key finding: kimi-code has no multi-provider web search or web extract equivalent** — its
`WebSearchTool` is a single-vendor (Moonshot) host-injected interface, and its SSRF-safe
`LocalFetchURLProvider` is the closest reusable blueprint (Readability extraction + DNS-pinned
undici fetch). The multi-provider registry and truncate-and-store pipeline must be designed from
scratch.

## 2. Current Python implementation

Source of truth: `D:/hermes-agent-cn`.

- **Tool surface & registry** — `tools/web_tools.py`:
  - `web_search_tool(query, limit=5)` (L618–739): dispatches through `agent/web_search_registry`;
    returns `{"success": true, "data": {"web": [{title,url,description,position}]}}` JSON.
  - `web_extract_tool(urls, format=None, char_limit=None)` (L742–1036, async): secret-in-URL
    block (`agent/redact._PREFIX_RE`), URL normalize (`tools/url_safety.normalize_url_for_request`),
    sensitive-query-param block, SSRF pre-filter (`async_is_safe_url`), per-URL provider dispatch,
    then truncate-and-store; returns `{"results": [{url,title,content,error,blocked_by_policy?}]}`.
  - Registry registration (L1172–1240): `WEB_SEARCH_SCHEMA` (query, limit 1–100 default 5) and
    `WEB_EXTRACT_SCHEMA` (urls max 5, char_limit ≥2000); `check_fn=check_web_api_key`,
    `max_result_size_chars=100_000`, `emoji 🔍/📄`, toolset `web`.
- **Backend selection** — `_get_backend`/`_get_search_backend`/`_get_extract_backend` (L223–352):
  config `web.search_backend` / `web.extract_backend` → `web.backend` → auto-detect from env
  (`TAVILY_API_KEY` → `EXA_API_KEY` → `PARALLEL_API_KEY` → `FIRECRAWL_API_KEY`/`_API_URL`/
  tool-gateway → `SEARXNG_URL` → `BRAVE_SEARCH_API_KEY` → `ddgs` importable). **xAI is
  intentionally NOT auto-detected** — opt-in only. Default fallback `"firecrawl"`.
- **Provider ABC + registry** — `agent/web_search_provider.py` (`WebSearchProvider` ABC:
  `name`, `display_name`, `is_available()`, `supports_search()`, `supports_extract()`, `search()`,
  `extract()` — may be `async def`, `get_setup_schema()`, `get_provider_env()` helper) and
  `agent/web_search_registry.py` (registration, `get_active_search_provider()` /
  `get_active_extract_provider()`, legacy preference
  `firecrawl → parallel → tavily → exa → searxng → brave-free → ddgs`, disabled-plugin diagnostics).
- **Bundled provider plugins** — `plugins/web/{firecrawl,searxng,brave_free,ddgs,tavily,exa,parallel,xai}/provider.py`
  (each registers via `plugins/web/<vendor>/__init__.py`):
  - `firecrawl` (search+extract, default; direct SDK or Nous tool-gateway; async extract with 60s
    timeout, per-URL policy gate + redirect SSRF re-check via `tools/website_policy.check_website_access`
    + `tools/url_safety.is_safe_url`; format markdown/html).
  - `searxng` (search-only; GET `{SEARXNG_URL}/search?format=json`, sort by `score`).
  - `brave_free` (search-only; GET `https://api.search.brave.com/res/v1/web/search`,
    `X-Subscription-Token`, count cap 20).
  - `ddgs` (search-only; `ddgs` package; disposable **child-process** worker with 30s hard cap —
    Python-specific GIL isolation, issue #68096).
  - `tavily` (search+extract; POST `/search`, `/extract`; normalizers
    `_normalize_tavily_search_results` / `_normalize_tavily_documents`).
  - `exa` (search+extract; `exa_py` SDK, sync).
  - `parallel` (search+extract; sync `Parallel.beta.search` + async `AsyncParallel.beta.extract`).
  - `xai` (search-only; Grok server-side `web_search` on `/v1/responses`, model `grok-build-0.1`,
    JSON-prompt + annotation/citation fallback parse; 401 OAuth refresh retry via
    `tools/xai_http.py`).
- **Truncate-and-store** — `tools/web_tools.py` L417–576: `DEFAULT_EXTRACT_CHAR_LIMIT=15000`
  (clamped 2000–500_000 via `web.extract_char_limit`), `MAX_STORED_TEXT_CHARS=2_000_000`,
  `convert_base64_images_to_links` (base64 → `[IMAGE: alt]`/`[IMAGE]` placeholders),
  `_store_full_text` (writes `cache/web/<slug>-<xxh64 10 chars>.md`, capped at 2MB with marker),
  `_truncate_with_footer` (75% head / 25% tail snapped to newline, footer with stored path +
  concrete `read_file offset=<line>` hint).
- **Docs** — `website/docs/user-guide/features/web-search.md` (backend matrix, per-capability
  config, long-page table, xAI trust-model caveat).
- **SSRF / hardening deps** — `tools/url_safety.py` (`is_safe_url`/`async_is_safe_url`,
  `normalize_url_for_request`, `sensitive_query_param_name`), `tools/website_policy.py`
  (`check_website_access`), `tools/managed_tool_gateway.py` (Nous Firecrawl gateway),
  `tools/xai_http.py` (xAI OAuth/env credentials).
- **Tests** — `tests/tools/test_web_providers.py`,
  `test_web_providers_{brave_free,ddgs,searxng,xai}.py`, `test_web_tools_tavily.py`,
  `test_web_tools_config.py`, `test_web_tools_dict_urls.py`, `test_web_tools_truncate.py`,
  `test_web_extract_robustness.py`, `tests/plugins/web/test_web_search_provider_plugins.py`.

## 3. Target TypeScript design

Runs in-process with the TS agent loop (no Python backend, no WS). Pure HTTP providers need no
Node sidecar; a thin Rust IPC shim provides SSRF-safe outbound HTTP (dev mode can use direct
fetch behind the Vite proxy for localhost SearXNG).

```
webview (React + in-process TS agent loop)
  └─ packages/web-tools/            pure TS, no framework deps
       ├─ provider.ts               WebSearchProvider interface (mirrors agent/web_search_provider.py)
       ├─ registry.ts               per-capability resolution (mirrors agent/web_search_registry.py)
       ├─ backends/                 firecrawl.ts, searxng.ts, brave-free.ts, ddgs.ts,
       │                            tavily.ts, exa.ts, parallel.ts, xai.ts
       ├─ truncate.ts               convertBase64ImagesToLinks + truncateWithFooter + storeFullText
       ├─ ssrf.ts                   port of tools/url_safety.py + secret-URL block
       ├─ policy.ts                 port of tools/website_policy.check_website_access (blocklist rules)
       └─ http.ts                   WebHttp adapter: dev fetch vs Rust IPC (web_provider_request)
            └─► invoke("web_provider_request") ──► src/commands/web_tools.rs (new)
                 reuse validate_external_url from src/commands/api_proxy.rs
                 ├─ vendor REST (Firecrawl/Tavily/Exa/Parallel/Brave/xAI; longer timeouts)
                 ├─ SearXNG self-hosted (http://localhost allowed, like external_request)
                 └─ optional local extract fallback (fetch HTML → Readability in TS)
  web/src/lib/web-tools/tools.ts   in-process tool registration (same schemas as Python registry)
  web/src/routes/settings-web-search.tsx   provider config UI (new; see §6)
```

Key interfaces (signatures, not implementation):

```ts
interface WebSearchResult { title: string; url: string; description: string; position: number }
interface WebSearchResponse { success: boolean; data?: { web: WebSearchResult[] }; error?: string }
interface WebExtractResult { url: string; title: string; content: string; error?: string; blocked_by_policy?: { host: string; rule: string; source: string } }
interface WebSearchProvider {
  name: string; displayName: string;
  isAvailable(): boolean;               // cheap, no network (env/config probe)
  supportsSearch(): boolean; supportsExtract(): boolean;
  search(query: string, limit?: number): Promise<WebSearchResponse>;
  extract?(urls: string[], opts?: { format?: 'markdown' | 'html' }): Promise<WebExtractResult[]>;
  getSetupSchema?(): ProviderSetupSchema; // {name,badge,tag,envVars}
}
```

- `registry.resolve('search'|'extract')`: read `web.search_backend`/`web.extract_backend` →
  `web.backend` → auto-detect cascade (same env order as Python, xAI excluded) → legacy
  preference walk filtered by `isAvailable()`. Explicit config wins even when unavailable so the
  error message is precise ("X_API_KEY is not set") rather than a silent backend switch.
- Async dispatch: Python inspects `inspect.iscoroutinefunction`; TS uses `Promise`-based
  `extract()` uniformly, with `http.ts` applying per-vendor timeouts (`AbortSignal.timeout`):
  SearXNG/Brave 15s, Tavily 60s, Firecrawl scrape 60s, xAI 90s (config `web.xai.timeout`).
- Tool registration mirrors the Python registry surface: `web_search(query, limit=5)` →
  search JSON string; `web_extract(urls[≤5], char_limit?)` → extract JSON string;
  `maxResultSizeChars = 100_000`; availability gate = any provider `isAvailable()`.
- ddgs: no child process needed (TS event loop has no GIL); use fetch + HTML parse with
  `AbortSignal.timeout(30_000)`; treat DDG HTML markup churn as a parsing risk (§9).

## 4. Data models & persistence

- **Provider config** (`web` section, preserved key-for-key from Core `config.yaml`):
  `backend`, `search_backend`, `extract_backend`, `extract_char_limit` (2000–500_000,
  default 15000), `use_gateway`, `xai: {model, allowed_domains(≤5), excluded_domains(≤5),
  timeout}`. Add Zod schemas in `packages/protocol/src/hermes-api.ts` (`WebConfig`,
  `WebProviderInfo` list) — reused by settings UI and the registry.
- **Storage today**: config lives in Core `config.yaml` (read via `/api/config`); env vars
  (`FIRECRAWL_API_KEY`, `SEARXNG_URL`, …) live in `~/.hermes/.env` or process env. Target state:
  Desktop-managed config (Rust/`AppState` or `packages/minidb`-style store) with a one-time
  migration that reads the existing `web:` section + env vars so users' current provider choice
  survives the WS removal. Freeze the config key names; do not rename `brave-free`/`ddgs` slugs.
- **Full-text cache**: files under `$HERMES_HOME/cache/web/<slug>-<digest>.md` (slug = sanitized
  host ≤60 chars, digest = 10-hex hash of URL; use `xxhash-wasm` to match Python `xxh64` scheme).
  Write path in the webview requires Rust IPC (new `web_store_full_text` command or reuse an
  existing fs command) so the in-process `read_file` tool can page through the stored copy.
  Hard cap 2_000_000 chars with the `[... stored copy truncated at …]` marker. Best-effort TTL
  cleanup is an open question (Python does none).
- **No message/session schema changes**: tool results are plain strings inside the transcript;
  the truncation footer text is part of the tool result contract (parity-tested, §10).

## 5. Third-party library strategy

| Python dep / capability | TS equivalent | Evidence in kimi-code |
|---|---|---|
| `httpx` (all providers) | global `fetch` / `undici`; `AbortSignal` timeouts | `undici ^7.27.1` in `packages/agent-core/package.json`; `MoonshotWebSearchProvider` injects `fetchImpl` (`packages/agent-core/src/tools/providers/moonshot-web-search.ts`) |
| Provider-interface pattern | host-injected `WebSearchProvider` / `UrlFetcher` interfaces | `packages/agent-core/src/tools/builtin/web/web-search.ts` (`WebSearchResult {title,url,snippet,date?,siteName?}`) and `fetch-url.ts` (`UrlFetchResult {content, kind: passthrough\|extracted}`) |
| Single-vendor REST search | `MoonshotWebSearchProvider` (Bearer token / apiKey / baseUrl / fetchImpl) | `packages/agent-core/src/tools/providers/moonshot-web-search.ts`; v2 duplicate at `packages/agent-core-v2/src/app/auth/webSearch/providers/moonshot-web-search.ts` — this is the **only** search provider kimi-code has (Moonshot/Kimi, no multi-vendor strategy) |
| `firecrawl` SDK | thin REST client from scratch (POST `/v1/scrape`, GET `/v1/search`; v2 endpoints to confirm) — or official `@mendable/firecrawl-js` | **NOT present** in kimi-code package.json/node_modules; vendor SDK known on npm but unverified in-repo → prefer thin REST for size |
| `exa_py` SDK | thin REST from scratch (`POST https://api.exa.ai/search`, `POST /contents`) — or `exa-js` | **NOT present** in kimi-code; unverified in-repo |
| `parallel` SDK | thin REST from scratch (`beta.search`, `beta.extract`; exact paths to confirm against SDK docs during implementation) | **NOT present** in kimi-code |
| `ddgs` package | **from scratch**: fetch `https://html.duckduckgo.com/html/?q=…` + parse with `linkedom` | `linkedom ^0.18.12` used by `LocalFetchURLProvider` (`packages/agent-core-v2/src/app/web/providers/local-fetch-url.ts`) — no ddgs npm equivalent |
| xAI Grok Responses API | **from scratch**: `POST {base}/responses` with `tools:[{type:'web_search'}]`, parse `output[*].content[*].text` JSON / annotations / citations | no xAI web-search in kimi-code; only `MoonshotWebSearchProvider` as a structural template |
| SSRF-safe local fetch + readability extraction | port `LocalFetchURLProvider` (undici + `node:dns` lookup pinning + `BlockList` private ranges + redirect revalidation + `@mozilla/readability` extraction + 10MB cap) | `packages/agent-core-v2/src/app/web/providers/local-fetch-url.ts`; deps `@mozilla/readability ^0.6.0`, `linkedom ^0.18.12`, `undici ^7.27.1` in `packages/agent-core-v2/package.json` |
| `orjson` | `JSON.stringify` / `JSON.parse` | — |
| `xxhash` (stored-file digest) | `xxhash-wasm` (match `xxh64` 10-hex prefix) — or accept non-identical digest (same dir/slug scheme) | **NOT present** in kimi-code; unverified in-repo |
| HTML parsing (ddgs / policy) | `linkedom` (already proven) or `cheerio` (not in kimi-code) | `linkedom` evidence above |

Notes: the `kap-server/src/lib/local-fetch-url.ts` path given in the task brief does **not exist**
in this checkout; the SSRF-safe fetch lives at
`packages/agent-core/src/tools/providers/local-fetch-url.ts` (v1) and
`packages/agent-core-v2/src/app/web/providers/local-fetch-url.ts` (v2, canonical). Use the v2 file.

## 6. Integration with existing Hermes-CN-Desktop frontend

- **Rust HTTP / SSRF**: reuse `src/commands/api_proxy.rs` `external_request` +
  `validate_external_url` (https-only except localhost http, DNS lookup + private-IP blocklist,
  no redirect following). New `src/commands/web_tools.rs` (or extend api_proxy) with a
  `web_provider_request` command: per-vendor timeout (up to 90s vs the current 15s
  `EXTERNAL_TIMEOUT`), larger response cap (multi-MB markdown), optional redirect-follow with
  per-hop revalidation (mirroring `download_external_image_impl`'s loop), and content-type passthrough.
- **HTTP routing**: `web/src/lib/transport.ts` is dashboard-only (auth-header injection) — do not
  reuse it for vendor APIs; add `web/src/lib/web-tools/http.ts` adapter: dev → direct `fetch`
  (Vite proxy for localhost SearXNG), prod → `invoke("web_provider_request")` via
  `web/src/lib/tauri-bridge.ts` (`window.hermesDesktop`).
- **Config UI**: `web/src/routes/settings.tsx` currently has only a generic `ConfigSection`
  (full config editor via `web/src/hooks/use-config.ts` → `/api/config`, `useSaveConfig`).
  Add a dedicated `settings-web-search.tsx` section: backend dropdown (8 providers), per-capability
  overrides, `extract_char_limit`, env-var inputs (mirroring `get_setup_schema` envVars), xAI
  domain filters; wire through `useConfig`/`useSaveConfig` and `config-translations.ts` labels.
  Zod types in `packages/protocol/src/hermes-api.ts` (§4).
- **Agent loop / tool surface**: while the WS path exists, `web_search`/`web_extract` are called
  by Python via `gateway-client.ts`; the in-process TS tools replace that after the agent-loop
  port (plan `agent-loop-llm-adapters`). Keep `packages/protocol` schemas for the tool args/result
  JSON so the UI/renderer (message rendering of search results) is unaffected.

## 7. Removing the WebSocket dependency (migration path)

Freeze these API surfaces during migration (parity contract):

- `web_search` args `{query, limit}` → result string
  `{"success":bool,"data":{"web":[{"title","url","description","position"}]}}` or
  `{"success":false,"error"}`.
- `web_extract` args `{urls[≤5], char_limit?}` → result string
  `{"results":[{"url","title","content","error","blocked_by_policy"?}]}`; truncation footer text
  and stored-file layout are part of the contract.

Phases:
1. **Keep backend call today**: Desktop continues calling Python `web_search`/`web_extract` over
   the WS gateway; no change. Record golden fixtures from Python tests (§10) as the parity corpus.
2. **In-process module behind same interface**: implement `packages/web-tools` + tool registration
   in the TS agent loop behind the frozen contract; run both paths under a config flag
   (`web.tools.ts_impl`) with a fixture-driven parity harness comparing Python vs TS JSON output
   for identical inputs (search normalization, error envelopes, footer text, cache file).
3. **Default on TS**: flip the flag; the Desktop UI no longer sends `web_search`/`web_extract`
   tool calls to the backend; Python-side registry entries remain for CLI/gateway users but are
   unused by Desktop.
4. **Delete WS/REST tool path** (only when the whole agent loop is in-process per
   `agent-loop-llm-adapters`): remove the WS tool-call plumbing for these two tools and the
   `web_search`/`web_extract` dashboard routes if any; keep `external_request`-style Rust IPC for
   vendor HTTP. This phase is gated on the broader loop port, not independently shippable.

## 8. Migration phases & task breakdown

| Phase | Tasks |
|---|---|
| P0 — Foundation | `packages/web-tools` scaffold + `provider.ts`/`registry.ts`; `ssrf.ts` (port url_safety + secret-URL block + sensitive query params); `policy.ts`; `http.ts` + Rust `web_provider_request` command (timeout/body/redirect policy); `web_store_full_text` IPC |
| P1 — Search backends | firecrawl.ts; searxng.ts; brave-free.ts; ddgs.ts (fetch+linkedom, 30s abort); tavily.ts; exa.ts; parallel.ts; xai.ts (JSON-prompt parse + annotation/citation fallback); provider availability probes; registry precedence tests |
| P2 — Extract + truncate | tavily/exa/parallel/firecrawl extract paths; `truncate.ts` (`convertBase64ImagesToLinks`, `truncateWithFooter` 75/25 + footer, 2MB store cap, char-limit clamp); local-fetch extract fallback (port LocalFetchURLProvider) |
| P3 — Tool integration | in-process tool registration (schemas, availability gate, `max_result_size_chars`); parity harness vs Python fixtures; config flag `web.tools.ts_impl` |
| P4 — Desktop UI | `settings-web-search.tsx` + protocol Zod types; env-var/config read from Core until migration; config store migration (§4) |
| P5 — Cutover | default-on TS; WS removal gated on agent-loop port (§7) |

Estimated ~14–18 focused tasks; P1/P2 can be parallelized per-vendor.

## 9. Risks & open questions

- **No multi-provider TS equivalent**: kimi-code's web search is single-vendor Moonshot and has
  no web-extract tool at all; every provider adapter (except the local-fetch blueprint) is
  designed from scratch. Registry + per-capability split have no TS precedent to copy.
- **CORS/CSP in Tauri webview**: vendor REST from the webview needs the Rust IPC proxy; the
  existing `external_request` 15s timeout is too short for Firecrawl (60s) and xAI (90s), and its
  no-redirect policy conflicts with SearXNG/DDG — `web_provider_request` must add timeouts,
  response caps, and revalidated redirects.
- **ddgs brittleness**: DuckDuckGo HTML is not a stable API; the `ddgs` package's HTML scraping
  has no npm equivalent. Expect periodic parser breakage; keep the parser isolated + fixture-tested.
- **xAI OAuth**: Python uses `tools/xai_http.py` + `auth.json` OAuth; Desktop has no xAI OAuth
  store. Initial TS scope = `XAI_API_KEY` only; OAuth needs a bearer-token provider (kimi-code
  `BearerTokenProvider` pattern + existing `settings-oauth-section.tsx`/`settings-oauth-section`
  infra) — open question.
- **Nous Tool Gateway** (`tools/managed_tool_gateway.py`): Python-only managed Firecrawl gateway.
  Decide whether Desktop needs it (likely out of scope initially; direct `FIRECRAWL_API_KEY` only).
- **website_policy**: `tools/website_policy.py` rule engine + file format need a port; rule-file
  location in the Desktop-managed world is undefined — open question.
- **Parallel endpoints**: exact REST paths/params depend on the official SDK; verify against
  SDK docs during implementation (Python wraps the SDK, so raw endpoints aren't in-repo).
- **WS removal dependency**: web tools alone cannot delete the WS link; phase P5 depends on the
  agent-loop port plan.
- **Stored-file path parity**: matching Python `xxh64` filenames requires `xxhash-wasm`; if the
  digest differs, old cache files from the Python era won't be found by TS — acceptable, but
  document it.

## 10. Test strategy

Vitest unit (mocked fetch via `vi.stubGlobal`/undici MockAgent — no real network, mirroring
Python's mock-patch style), Rust tests with `wiremock` for `web_provider_request`, and Playwright
E2E for the settings UI.

| Python parity source | TS test to mirror |
|---|---|
| `tests/plugins/web/test_web_search_provider_plugins.py` | all 8 providers register, capability flags, registry resolution precedence (explicit config wins, legacy walk filtered by availability, unknown name falls back) |
| `tests/tools/test_web_providers.py` + `test_web_providers_{brave_free,searxng,ddgs,xai}.py` | per-provider response normalization, error envelopes, limit clamping, score sorting (SearXNG), ddgs 30s timeout + rate-limit errors, xai JSON/annotation/citation parsing |
| `tests/tools/test_web_tools_tavily.py` | Tavily `_normalize_tavily_search_results` / `_normalize_tavily_documents` (incl. `failed_results`/`failed_urls`) |
| `tests/tools/test_web_tools_truncate.py` | base64 → `[IMAGE: alt]`/`[IMAGE]`; ≤limit returns whole; head+tail 75/25 line-boundary snap; footer contains stored path + concrete `read_file offset`; `extract_char_limit` clamp/fallback; end-to-end truncation with fake provider |
| `tests/tools/test_web_extract_robustness.py` | 2MB store cap + `stored copy truncated` marker; small page has no footer |
| `tests/tools/test_web_tools_config.py` / `test_web_tools_dict_urls.py` | config-aware env, URL dict/href extraction, invalid URL entries |
| New (no Python direct equivalent) | SSRF unit tests (port of `api_proxy.rs` tests + LocalFetchURLProvider tests at `packages/agent-core-v2/test/app/web/providers/local-fetch-url.test.ts`); fixture-driven parity harness Python-vs-TS JSON equality; Playwright E2E: save `web.search_backend`/`extract_backend` in settings and verify `/api/config` payload |

## 11. Reference links

- Core: `D:/hermes-agent-cn/tools/web_tools.py`, `agent/web_search_provider.py`,
  `agent/web_search_registry.py`, `plugins/web/{firecrawl,searxng,brave_free,ddgs,tavily,exa,parallel,xai}/provider.py`,
  `plugins/web/ddgs/_search_worker.py`, `tools/url_safety.py`, `tools/website_policy.py`,
  `tools/managed_tool_gateway.py`, `tools/xai_http.py`,
  `website/docs/user-guide/features/web-search.md`,
  `tests/tools/test_web_providers*.py`, `tests/tools/test_web_tools_{tavily,truncate,config,dict_urls}.py`,
  `tests/tools/test_web_extract_robustness.py`, `tests/plugins/web/test_web_search_provider_plugins.py`.
- kimi-code: `packages/agent-core/src/tools/builtin/web/{web-search,fetch-url}.ts`,
  `packages/agent-core/src/tools/providers/{moonshot-web-search,moonshot-fetch-url,local-fetch-url}.ts`,
  `packages/agent-core-v2/src/app/web/{webService.ts,providers/local-fetch-url.ts}`,
  `packages/agent-core-v2/src/app/auth/webSearch/**`, `packages/agent-core/package.json`
  (deps: `@mozilla/readability`, `linkedom`, `undici`).
- Desktop: `src/commands/api_proxy.rs` (`external_request`, `validate_external_url`,
  `download_external_image_impl`), `web/src/lib/{transport,tauri-bridge,gateway-client}.ts`,
  `web/src/hooks/use-config.ts`, `web/src/routes/settings.tsx` (`ConfigSection`),
  `packages/protocol/src/hermes-api.ts`, `web/src/lib/truncate-middle.ts` (existing TS truncation
  util for reuse patterns).
