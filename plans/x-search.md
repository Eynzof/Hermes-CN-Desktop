# X (Twitter) Search — Python → TypeScript Rewrite Plan

## 1. Summary

`x_search` lets the agent search X (Twitter) posts, profiles, and threads through
xAI's **built-in `x_search` tool on the Responses API** (`https://api.x.ai/v1/responses`).
It is **read-only public X discovery**: Grok runs the search server-side and returns a
synthesized `answer` plus citations to originating posts. It complements the `xurl`
skill (authenticated X API writes/reads) — the tool schema deliberately keeps `xurl`
and `web_search` out of its description (see `test_x_search_schema_is_read_only_without_cross_tool_names`).

Authentication is **either** SuperGrok / X Premium+ OAuth (device-code flow against
`accounts.x.ai`, provider id `xai-oauth`, auto-refresh, preferred when both exist) **or**
`XAI_API_KEY` (paid xAI API key). The same bearer is shared by every direct-to-xAI
surface (TTS / image / video / transcription / search).

This plan ports the feature into the TypeScript desktop monorepo so it can run
**in-process** in the Tauri webview without the Python backend / WS link: a thin
`x_search` tool module + an OpenAI-compatible Responses API client + an in-process
device-code OAuth flow + a credentials resolver (OAuth-first, API-key fallback),
reusing kimi-code's OpenAI Responses client patterns and generic OAuth device-flow
package. **No TS equivalent for the `x_search` built-in tool exists in kimi-code** —
the Responses client is borrowed, the tool definition itself is designed from scratch
(see §5).

## 2. Current Python implementation

Source of truth: `D:/hermes-agent-cn`.

- **Tool module** — `tools/x_search_tool.py` (540 lines):
  - `x_search_tool(query, allowed_x_handles, excluded_x_handles, from_date, to_date,
    enable_image_understanding, enable_video_understanding) -> str` (JSON string).
  - `check_x_search_requirements() -> bool` — runs `resolve_xai_http_credentials()`;
    `True` means a non-empty bearer is fetchable (OAuth auto-refresh included). This is
    the tool's `check_fn` gate: no credentials → tool hidden from the model schema.
  - `X_SEARCH_SCHEMA` — tool schema (name/description/parameters; required `query`;
    `allowed_x_handles`/`excluded_x_handles` arrays max 10; `from_date`/`to_date`
    `YYYY-MM-DD` strings; image/video understanding booleans).
  - `registry.register(name="x_search", toolset="x_search", schema=..., handler=...,
    check_fn=..., requires_env=["XAI_API_KEY"], emoji="🐦", max_result_size_chars=100_000)`
    (registry contract in `tools/registry.py`).
  - Config from `~/.hermes/config.yaml` section `x_search:` via `hermes_cli.config.load_config`:
    `model` (default `grok-4.5`), `reasoning_effort` (`low|medium|high|xhigh`, validated
    client-side), `timeout_seconds` (default 180, min 30), `retries` (default 2).
  - HTTP: `requests.post(f"{base_url}/responses", headers={Authorization: Bearer <key>,
    Content-Type: application/json, User-Agent: Hermes-Agent/{version}}, json=payload,
    timeout=...)` with retry loop — 5xx retry and `ReadTimeout`/`ConnectionError` retry,
    backoff `min(5.0, 1.5*(attempt+1))`; 4xx fails fast.
  - Payload: `{model, input:[{role:"user", content:query}], tools:[{type:"x_search",
    allowed_x_handles?, excluded_x_handles?, from_date?, to_date?,
    enable_image_understanding?, enable_video_understanding?}], store:false}` plus
    optional `reasoning:{effort}`.
  - Client-side validation before HTTP (fail fast, no billable call):
    `_normalize_handles` (strip leading `@`, max 10, `allowed`+`excluded` mutually
    exclusive), `_parse_iso_date` / `_validate_date_range` (strict `YYYY-MM-DD`,
    `from <= to`, `from` not after today UTC; `to` in the future is allowed).
  - Result JSON: `success, provider:"xai", credential_source ("xai-oauth"|"xai"),
    tool:"x_search", model, query, answer, citations, inline_citations (url_citation
    annotations from `output[].content[].annotations`, each `{url,title,start_index,
    end_index}`), degraded, degraded_reason`. `degraded=true` when any narrowing filter
    is active AND both citation channels are empty (unsourced answer); errors surface
    structured `{success:false, provider, tool, error, error_type}`.
- **Credential helpers** — `tools/xai_http.py` (329 lines):
  - `resolve_xai_http_credentials(*, force_refresh=False, api_key_hint=None)` —
    OAuth first (`agent/credential_pool.load_pool("xai-oauth")` → `select()` /
    `try_refresh_matching()`; returns `provider:"xai-oauth"`, bearer, base_url validated
    by `hermes_cli.auth._xai_validate_inference_base_url` with
    `HERMES_XAI_BASE_URL`/`XAI_BASE_URL` override), then API key
    (`tools/tool_backend_helpers.resolve_provider_secret("XAI_API_KEY","xai",...)` which
    reads `~/.hermes/.env` via `hermes_cli.config.get_env_value`; returns
    `provider:"xai"`, base `https://api.x.ai/v1`).
  - `has_xai_credentials()` — cheap probe: `XAI_API_KEY` env/secret, then
    `~/.hermes/auth.json` `providers.xai-oauth.tokens.access_token`, then
    `credential_pool.xai-oauth` entries (multi-account).
  - `hermes_xai_user_agent()`, `hermes_xai_default_headers()` — Hermes User-Agent.
- **OAuth flow** — `hermes_cli/auth.py`:
  - Constants: `DEFAULT_XAI_OAUTH_BASE_URL = "https://api.x.ai/v1"`,
    `XAI_OAUTH_ISSUER = "https://auth.x.ai"`,
    `XAI_OAUTH_DISCOVERY_URL = <issuer>/.well-known/openid-configuration`,
    `XAI_OAUTH_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828"`,
    `XAI_OAUTH_SCOPE = "openid profile email offline_access grok-cli:access api:access"`,
    `XAI_OAUTH_DEVICE_CODE_URL = <issuer>/oauth2/device/code`,
    `XAI_ACCESS_TOKEN_REFRESH_SKEW_SECONDS = 3600` (refresh up to 1h early; tokens ~6h).
  - `_xai_oauth_device_code_login()` (~8044): discovery → device code request → print
    verification URL + user code → open browser if possible → poll token endpoint →
    return tokens+discovery; stored under `~/.hermes/auth.json` `providers.xai-oauth`.
  - `resolve_xai_oauth_runtime_credentials()` (~5014): auto-refresh when within skew;
    terminal errors (HTTP 4xx / `invalid_grant`) clear tokens and write
    `last_auth_error{relogin_required:true}` quarantine (mirrored by
    `agent/credential_pool.py`).
- **Docs** — `website/docs/user-guide/features/x-search.md` (parameters, config,
  degraded semantics, `x_search` vs `xurl` table) and
  `website/docs/guides/xai-grok-oauth.md` (device flow, 403 tier-gating warning).
- **Tests** (parity source) — `tests/tools/test_x_search_tool.py` (314 lines):
  HTTP request shape (URL/headers/payload/model/store/tool_def), handle filter conflict,
  schema read-only wording (no `xurl`/`web_search` names), inline `url_citation`
  extraction, structured 4xx error with `code:`, OAuth-only → `credential_source` +
  `Authorization` header, no-credentials → friendly error, non-degraded broad answer.
  Note: date-validation helpers exist (`_no_post_allowed`, `_parse_iso_date`) but no
  `test_x_search_*date*` function is present in the file — a Python test gap the TS
  parity suite should close.

## 3. Target TypeScript design

Runs entirely in the renderer (React app inside the Tauri webview), in-process with
the future TS agent runtime; Rust is used only for storage/IPC and (initially) for
HTTP if CORS blocks direct renderer fetch (see §9).

Module layout (new files under the existing web app; no Python dependency):

```
web/src/lib/x-search/
  types.ts            — XSearchArgs, XSearchResult, XSearchToolDef, credential types
  validation.ts       — normalizeHandles, validateDateRange (mirrors Python)
  credentials.ts      — resolveXaiCredentials(): OAuth-first → XAI_API_KEY fallback
  responses-client.ts — postXSearch(args, {bearer, baseUrl}): fetch → result (retry/backoff)
  result.ts           — extractAnswer/extractInlineCitations/degraded detection
  tool.ts             — xSearchTool: { name, description, parameters, execute }
web/src/stores/x-search.ts        — credentials status atom, tool availability selector
web/src/hooks/use-x-search.ts     — React bindings (status, login, call)
web/src/routes/settings-x-search-section.tsx — credential/status UI (extends OAuth section)
```

Key signatures (design only):
```ts
interface XSearchArgs {
  query: string;
  allowed_x_handles?: string[];    // max 10, @ stripped
  excluded_x_handles?: string[];   // max 10, mutually exclusive with allowed
  from_date?: string;              // YYYY-MM-DD, not after today UTC
  to_date?: string;                // YYYY-MM-DD, may be future
  enable_image_understanding?: boolean;
  enable_video_understanding?: boolean;
}
interface XSearchResult {
  success: boolean; provider: "xai"; credential_source: "xai-oauth" | "xai";
  tool: "x_search"; model: string; query: string;
  answer: string; citations: Array<{url: string; title?: string}>;
  inline_citations: Array<{url: string; title?: string; start_index?: number; end_index?: number}>;
  degraded: boolean; degraded_reason: string | null;
  error?: string; error_type?: string;
}
interface XSearchTool {
  name: "x_search";
  description: string;             // mirror X_SEARCH_SCHEMA["description"]
  parameters: ZodType<XSearchArgs>;
  execute(args: XSearchArgs, ctx: ToolExecutionContext): Promise<XSearchResult>;
  isAvailable(ctx: ToolExecutionContext): boolean;  // check_fn equivalent
}
```

Data flow (in-process):
1. `isAvailable()` → `resolveXaiCredentials()`; no bearer → tool hidden from catalog.
2. `execute()` → validate args (handles + dates, fail fast) → resolve bearer again
   (OAuth auto-refresh) → `responses-client.postXSearch(...)` → parse/extract → return
   `XSearchResult`.
3. Credential events: after OAuth login/refresh, dispatch `CONNECTION_AUTH_RESTORED_EVENT`
   (`web/src/lib/connection-auth-events.ts`) so the tool catalog recomputes `isAvailable`.

## 4. Data models & persistence

- **Tool results**: no dedicated persistence — `XSearchResult` flows into the session
  message log exactly like today (see `SessionMessage.tool_calls` in
  `packages/protocol/src/hermes-api.ts`). `degraded`/`degraded_reason` are surfaced in
  the tool output block so the UI can show "unsourced" warnings.
- **Credentials** (replaces Python `~/.hermes/auth.json` + `.env`):
  - OAuth store, one singleton `xai-oauth` entry (MVP; multi-account `credential_pool`
    is out of scope): `access_token`, `refresh_token`, `token_type`, `scope`,
    `expires_at` (epoch seconds), `last_refresh`, `discovery.token_endpoint`, `base_url`,
    plus `last_auth_error{code, message, relogin_required}` quarantine state.
  - API key store: `XAI_API_KEY` secret + optional `XAI_BASE_URL` override.
  - Storage: Tauri secure store / Rust command (recommended, keeps secrets out of
    localStorage); fallback IndexedDB for pure-web dev. Mirror the
    `OAuthProviderStatus` zod schema in `packages/protocol/src/hermes-api.ts` so the
    existing Settings UI can render status (logged_in/source/expires_at/error).
- **Config** (`x_search.*`): `model` (default `grok-4.5`), `reasoning_effort`,
  `timeout_seconds` (180), `retries` (2) — stored in desktop settings store, not a
  `config.yaml`.
- **Protocol**: add `XSearchResult` + `XSearchArgs` zod schemas to
  `packages/protocol/src/hermes-api.ts` if tool I/O crosses IPC boundaries (or keep
  them in `web/src/lib/x-search/types.ts` if fully in-renderer). No SQLite/IndexedDB
  schema migration is required for the feature itself.

## 5. Third-party library strategy

| Python dep | TS equivalent | kimi-code evidence | Notes |
|---|---|---|---|
| `requests` (POST `/responses`) | `fetch` + `AbortSignal.timeout` (thin client) | `packages/kosong/src/providers/openai-responses.ts` wraps the official `openai` npm SDK (`import OpenAI from 'openai'`), building `new OpenAI({apiKey, baseURL})` and calling `client.responses.create({model, input, tools, store:false, ...})`; `packages/oauth/src/oauth.ts` uses raw `fetch` with `AbortSignal.any([AbortSignal.timeout(...)])` | Option A: reuse `openai` SDK (matches kimi-code); **risk**: its typed `Tool` requires `name/description/parameters/strict`, but xAI's built-in tool is `{type:"x_search", allowed_x_handles?...}` → needs `as unknown as Tool` casts. **Recommend Option B**: thin raw-fetch client that sends the exact Python payload — simpler, no type fights, easy parity tests. |
| `orjson` | `JSON.stringify` / `JSON.parse` | built-in everywhere in kimi-code | n/a |
| `datetime` date validation | plain `Date.UTC` + regex `^\d{4}-\d{2}-\d{2}$` | `packages/oauth/src/oauth.ts` uses epoch math only; no date lib needed | n/a |
| retry/backoff (`time.sleep`) | `setTimeout` loop, `min(5000, 1500*(attempt+1))` | `packages/oauth/src/oauth.ts` retry set `{429,500,502,503,504}`; `packages/kosong` converts OpenAI errors | small helper, from scratch |
| `httpx` device-code OAuth (`hermes_cli/auth.py`) | `packages/oauth` device flow | `packages/oauth/src/oauth.ts` (`requestDeviceAuthorization`, `pollDeviceToken`, `refreshAccessToken` — pure fetch, form-encoded), `packages/oauth/src/oauth-manager.ts` (`OAuthManager` drives poll/refresh/store), `packages/oauth/src/storage.ts` (`FileTokenStorage`), `packages/oauth/src/device.ts` browser-safe entry | Package is Kimi-specific (`KIMI_CODE_FLOW_CONFIG`, `createKimiDeviceHeaders`); the generic flow config type is reusable — add an `XAI_FLOW_CONFIG` (issuer `https://auth.x.ai`, device/code URL, client id `b1a00492-…`, scope from `auth.py`). Token storage: use `FileTokenStorage` on the Tauri side or a Rust secret-store command. |
| `hermes_cli.config.load_config` | desktop settings store (no kimi-code equivalent — CLI uses fs config) | n/a | `x_search.*` settings UI lives in the existing settings routes |
| `XAI_API_KEY` secret resolution (`~/.hermes/.env`) | desktop secret store / settings credentials UI | n/a | new small module |
| xAI Responses API *with built-in `x_search` tool* | **no TS equivalent — implement from scratch** | `packages/kosong/test/catalog.test.ts` only proves xAI is treated as OpenAI-compatible (`resolveCatalogImport({id:'xai', npm:'@ai-sdk/xai'}, 'https://api.x.ai/v1')` → `wire:'openai', guessed:true`); `packages/kosong/src/providers/openai-responses.ts` handles `reasoning_effort`/`offEffort` for grok but has no `x_search` tool concept | See §9 risk |

## 6. Integration with existing Hermes-CN-Desktop frontend

- **OAuth UI (reuse shape, rewire backend)**:
  `web/src/hooks/use-oauth-providers.ts` (providers/start/submit/poll/disconnect via
  `/api/providers/oauth/...` REST) + `web/src/routes/settings-oauth-section.tsx`
  (`OAuthProvidersSection`, device-code rendering `user_code`/`verification_url`,
  poll UI, disconnect confirm) + `web/src/routes/settings-models-section.tsx`
  (line ~1934 embeds `<OAuthProvidersSection />`). For the standalone build, keep the
  hook/component API but back the hooks with the in-process TS device flow (or Tauri
  commands) instead of the Python REST endpoints; `packages/protocol` already models
  `OAuthStartResponseDeviceCode` (`flow:"device_code"`, `user_code`, `verification_url`,
  `expires_in`, `poll_interval`) — reuse verbatim.
- **Credential status display**: `OAuthProviderStatus` zod schema (hermes-api.ts
  ~1016) renders connected/expired/error badges; add `xai-oauth` + `xai` entries to the
  provider list the same way the backend does today.
- **Tool catalog / availability**: the in-process tool registry needs a
  `check_fn`-equivalent (`isAvailable`) recomputed on `CONNECTION_AUTH_RESTORED_EVENT`
  (`web/src/lib/connection-auth-events.ts`) after OAuth login/refresh.
- **Rust IPC**: `src/commands/api_proxy.rs` already implements `external_request`
  (https-only, SSRF guards: private-IP block, DNS check) and `api_request` (dashboard
  proxy). If renderer→`api.x.ai` fetch is CORS-blocked, route `x_search` POSTs through a
  new thin `xai_request` Tauri command reusing `external_request`'s reqwest client and
  guards (longer timeout: Python uses 180s).
- **Transport freeze**: `web/src/lib/transport.ts` / `web/src/lib/gateway-client.ts`
  (WS JSON-RPC) is how the desktop calls tools today; the in-process `x_search` must
  present the identical tool name + args + result contract so the swap is transparent.

## 7. Removing the WebSocket dependency (migration path)

1. **Today (Python + WS)**: `x_search` executes in the managed Python runtime; the
   desktop triggers it via the gateway WS tool-call; OAuth status via `/api/providers/oauth`.
2. **Freeze the API surface** (migration contract — do not change during port):
   - Tool identity: name `x_search`, toolset `x_search`, schema exactly as
     `X_SEARCH_SCHEMA` (same descriptions, `required:["query"]`).
   - Wire args: camelCase field names as in Python (`allowed_x_handles`, …).
   - Result JSON: `success/provider/credential_source/tool/model/query/answer/
     citations/inline_citations/degraded/degraded_reason` + error shape
     `{success:false, error, error_type}` — byte-compatible with Python output.
   - Availability semantics: tool hidden when no credentials resolve.
3. **Phase B (in-process behind same interface)**: `web/src/lib/x-search/tool.ts`
   implements the frozen contract; a strategy switch selects in-process vs Python
   backend; both return the same `XSearchResult`.
4. **Phase C (delete WS/REST path)**: remove the Python tool-call route for
   `x_search` and the `/api/providers/oauth` xai-oauth flow once OAuth lives in TS;
   keep the REST OAuth endpoints only while other features still depend on Python.

## 8. Migration phases & task breakdown

| Phase | Tasks | Exit criteria |
|---|---|---|
| 0 — Parity spec | Write contract tests from `tests/tools/test_x_search_tool.py`; add missing date-validation cases | TS test list maps 1:1 to Python tests |
| 1 — Client | `responses-client.ts` + `result.ts` (extract citations, degraded) + retry/backoff + `validation.ts` | Mocked-fetch unit tests pass (URL, headers, payload, citations, degraded, 4xx/5xx/timeout) |
| 2 — Credentials | `credentials.ts`: `XAI_API_KEY` resolver (settings store) + OAuth-first order + `XAI_BASE_URL` override | Order tests: oauth-only / key-only / both→oauth / none→unavailable |
| 3 — OAuth flow | `XAI_FLOW_CONFIG` for `packages/oauth`; in-process device flow + auto-refresh + quarantine; storage via Tauri secret store | Login → poll → approve → token stored; refresh on skew; terminal error quarantines |
| 4 — Tool + UI | `tool.ts` registration + `isAvailable`; `settings-x-search-section.tsx` + status atoms; wire `CONNECTION_AUTH_RESTORED_EVENT` | Tool visible after login/key set; hidden when none; Settings shows connected state |
| 5 — Switchover | Strategy switch: desktop uses in-process `x_search`; keep Python path for one release | Same results over WS vs in-process (parity harness) |
| 6 — Cleanup | Delete Python `x_search` tool-call path + xai-oauth REST endpoints; update docs (`x-search.md` mirror in desktop docs) | No WS/REST usage for `x_search`; Playwright E2E passes |

## 9. Risks & open questions

- **No TS equivalent for the `x_search` built-in tool** (highest risk): kimi-code only
  proves xAI is OpenAI-compatible (catalog test) and has a generic Responses client;
  nothing sends `tools:[{type:"x_search", …}]`. The request shape must be copied from
  `tools/x_search_tool.py` and pinned by parity tests. The `openai` SDK's typed `Tool`
  cannot represent this tool without casts → prefer raw fetch.
- **CORS**: does `https://api.x.ai/v1/responses` accept browser-origin fetch from the
  Tauri webview? If not, route through a Rust `xai_request` command (reuse
  `external_request` SSRF guards; raise timeout from 15s/30s to ≥180s).
- **xAI OAuth 403 tier gating** (documented in `guides/xai-grok-oauth.md`, issue
  #26847): OAuth login can succeed yet inference returns 403 for some SuperGrok tiers —
  desktop must surface the "set XAI_API_KEY" fallback, matching Python behavior.
- **No in-process tool registry yet**: `x_search` is the first tool port — its `Tool`
  interface becomes the template; coordinate with the broader agent-runtime rewrite.
- **Secret storage**: where OAuth tokens / API key live in the standalone desktop
  (Tauri secure store vs IndexedDB) is unverified; Python's `auth.json` file semantics
  (quarantine, multi-account pool) are simplified to a singleton for MVP.
- **Python test gap**: date-validation helpers exist but no date tests in
  `test_x_search_tool.py`; TS suite should define the canonical date behavior.
- **Open**: should `check_fn` cache invalidation happen on a timer (token expiry) in
  addition to the auth-restored event?

## 10. Test strategy

- **Vitest unit** (mirror `tests/tools/test_x_search_tool.py` 1:1):
  - Request shape: URL `https://api.x.ai/v1/responses`, headers (Bearer, User-Agent),
    payload (model `grok-4.5`, `store:false`, tool_def with filters, no `reasoning` by
    default, `reasoning.effort` when configured).
  - Handle filters: `@` stripping, max 10, allowed+excluded conflict → error, no HTTP call.
  - Date validation: malformed / inverted / future `from_date` → error, no HTTP call
    (**new cases not in Python file**); `to_date` in future allowed.
  - Inline `url_citation` extraction from `output[].content[].annotations`.
  - Structured errors: 4xx with `code:` message, 5xx retry-then-fail, ReadTimeout retry.
  - Credential resolution order: oauth-only / key-only / both→oauth / none→unavailable.
  - Degraded: filters+citations empty → `degraded:true`; no filters → `false`.
  - Schema description read-only wording (no `xurl`/`web_search` names).
- **OAuth tests**: device-auth request/poll/refresh HTTP wrappers (mock fetch), token
  storage roundtrip, skew refresh, terminal-refresh quarantine.
- **Integration**: run against a local mock xAI Responses server (same payload fixtures
  as Python tests) to assert end-to-end result shape.
- **Playwright E2E**: Settings → connect `xai-oauth` (device code modal), poll to
  approved, tool availability flips; disconnect hides the tool.
- **Parity harness**: run the same fixture set through Python tool (if runtime present)
  and TS tool, diff JSON results.

## 11. Reference links

- Python tool: `D:/hermes-agent-cn/tools/x_search_tool.py`
- Python credentials: `D:/hermes-agent-cn/tools/xai_http.py`
- Python OAuth: `D:/hermes-agent-cn/hermes_cli/auth.py` (constants ~120–161,
  `resolve_xai_oauth_runtime_credentials` ~5014, `_xai_oauth_device_code_login` ~8044);
  `D:/hermes-agent-cn/hermes_cli/auth_commands.py` (`_OAUTH_CAPABLE_PROVIDERS` ~37,
  `xai-oauth` handler ~348)
- Python docs: `D:/hermes-agent-cn/website/docs/user-guide/features/x-search.md`,
  `D:/hermes-agent-cn/website/docs/guides/xai-grok-oauth.md`
- Python tests: `D:/hermes-agent-cn/tests/tools/test_x_search_tool.py`
- TS reference (kimi-code): `packages/kosong/src/providers/openai-responses.ts`,
  `packages/kosong/test/catalog.test.ts` (xai = OpenAI-compatible),
  `packages/oauth/src/oauth.ts`, `packages/oauth/src/oauth-manager.ts`,
  `packages/oauth/src/storage.ts`, `packages/oauth/src/device.ts`, `packages/oauth/src/types.ts`
- Desktop integration: `web/src/hooks/use-oauth-providers.ts`,
  `web/src/routes/settings-oauth-section.tsx`,
  `web/src/routes/settings-models-section.tsx` (~1934 `<OAuthProvidersSection />`),
  `web/src/lib/connection-auth-events.ts`,
  `packages/protocol/src/hermes-api.ts` (OAuth schemas ~1014–1092),
  `src/commands/api_proxy.rs` (`external_request` / SSRF guards)
- Plan conventions: `D:/Hermes-CN-Desktop/plans/README.md`
