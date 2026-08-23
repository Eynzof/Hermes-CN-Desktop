# Nous Tool Gateway — Python → TypeScript Rewrite Plan

> Feature slug: `nous-tool-gateway`
> Scope: design-only plan (no implementation). One Nous Portal subscription routes
> web search (Firecrawl), image generation (9 FAL models), TTS (OpenAI audio), and
> cloud browser (Browser Use) through Nous-hosted vendor gateways; per-tool
> `use_gateway` flags; `hermes portal info/tools` status surfaces.

## 1. Summary

Nous Tool Gateway lets a single paid Nous Portal subscription (or a live free
tool pool) replace per-vendor API keys for four tool families: web search/extract
(Firecrawl), image generation (9 FAL models under one endpoint), text-to-speech
(OpenAI TTS), and cloud browser automation (Browser Use). Every managed call is a
REST request to a pinned Nous-owned origin — `https://{vendor}-gateway.nousresearch.com/api/{vendor}`
— authenticated with the Nous OAuth bearer (`Authorization: Bearer <token>`),
with large media uploaded through a presign → PUT → `nous-upload:<token>` protocol.

Routing is per-tool: `config.yaml` sections (`web`, `image_gen`, `tts`, `browser`)
carry a `use_gateway: true/false` flag. `true` forces the gateway and suppresses
direct keys; `false`/absent prefers direct keys and only falls back to the gateway
when none exist. `hermes portal info` / `hermes portal tools` (and the Dashboard
`GET /api/portal`) show Portal auth + per-tool routing.

The rewrite moves Portal OAuth (device-code), token refresh, entitlement
resolution, per-tool routing, and the gateway REST/upload client into the
TypeScript webview (with Rust only for token persistence and CORS-free external
HTTP in packaged mode), so the feature runs in-process without the Python backend
and without the WebSocket link.

## 2. Current Python implementation

All paths under `D:/hermes-agent-cn` (repo root = Core):

### 2.1 Token & gateway plumbing

- `tools/managed_tool_gateway.py` (452 lines) — the generic managed-tool gateway
  helpers:
  - `ManagedToolGatewayConfig(vendor, gateway_origin, nous_user_token, managed_mode)`.
  - `auth_json_path()` → `$HERMES_HOME/auth.json`; `_read_nous_provider_state()`
    reads `providers.nous` (`access_token`, `refresh_token`, `expires_at`).
  - `peek_nous_access_token()` — cheap, no refresh (availability scans);
    `read_nous_access_token()` — refresh-aware via `hermes_cli.auth.resolve_nous_access_token`,
    skew `_NOUS_ACCESS_TOKEN_REFRESH_SKEW_SECONDS = 120`; env override
    `TOOL_GATEWAY_USER_TOKEN` (secret-scope aware).
  - `build_vendor_gateway_url(vendor)` — `https://{vendor}-gateway.{domain}`,
    default domain `nousresearch.com`; env knobs `TOOL_GATEWAY_DOMAIN`,
    `TOOL_GATEWAY_SCHEME`, per-vendor `{VENDOR}_GATEWAY_URL`.
  - `resolve_managed_tool_gateway(vendor)` → config or `None` (fails when
    `managed_nous_tools_enabled()` is False or no token).
  - `managed_vendor_endpoints(vendor)` → `{origin, base_url: /api/{vendor}, upload_path: /api/uploads/{vendor}}`.
    Address resolution deliberately does NOT consult entitlement.
  - `managed_gateway_auth_headers(url)` — live bearer per request, origin-gated by
    `is_managed_nous_gateway_url` (bearer never leaves the pinned gateway origin);
    returns `{}` (not an exception) when no token.
  - `build_managed_media_uploader(...)` — presign POST (`{contentType, contentLength}`)
    → direct PUT to presigned URL (SSRF-safe client for the PUT) → returns
    `nous-upload:<token>`; refusal messages surface gateway `error.message`.
- `tools/tool_backend_helpers.py` — `managed_nous_tools_enabled()` (entitlement:
  paid access OR live free tool pool, fails closed), `prefers_gateway(section)`
  reads `<section>.use_gateway` from `config.yaml`, `resolve_openai_audio_api_key()`
  (VOICE_TOOLS_OPENAI_KEY → OPENAI_API_KEY → credential pool), `fal_key_is_configured()`.
- `hermes_cli/auth.py` — `PROVIDER_REGISTRY["nous"]` = `oauth_device_code`
  (client_id `hermes-cli`, scope `NOUS_INFERENCE_INVOKE_SCOPE`); `resolve_nous_access_token()`
  (refresh with 120s skew), `get_nous_auth_status_local()` (refresh-free snapshot),
  `_decode_jwt_claims` (local JWT claims decode for UX gating only).

### 2.2 Account / entitlement

- `hermes_cli/nous_account.py` — `NousPortalAccountInfo` (logged_in, source,
  subscription, `paid_service_access`, `tool_access.coverage`, `tool_gateway_entitled`
  = paid OR pool, `tool_gateway_entitled_for(category)`); `get_nous_portal_account_info()`
  fast path decodes JWT claims (`paid_access`, `subscription_tier`, `org_id`,
  `product_id`, `nous_client`), fresh path calls `GET {portal}/api/oauth/account`;
  `format_nous_portal_entitlement_message`; billing/topup URL builders.

### 2.3 Routing / status surface

- `hermes_cli/nous_subscription.py` — `NousSubscriptionFeatures` /
  `NousFeatureState` (key, label, available, active, `managed_by_nous`,
  `direct_override`, `current_provider`, …). `get_nous_subscription_features(config)`
  resolves each of web/image_gen/video_gen/tts/stt/browser/modal with exact
  precedence: `use_gateway: true` zeroes the direct-credential probes before
  computing `managed_*_available = entitled ∧ token present ∧ gateway ready ∧
  coverage`. `apply_nous_managed_defaults()` flips defaults for subscribers.
- `hermes_cli/portal_cli.py` — `hermes portal [login|info|open|tools|status]`;
  `info` prints auth + routing rows; `tools` prints the static catalog
  (web→Firecrawl, image_gen→FAL, tts→OpenAI TTS, browser→Browser Use, modal→Modal).
- `hermes_cli/tools_config.py` — `hermes tools` interactive picker: per-tool
  "Nous Subscription" provider rows (`requires_nous_auth`, `managed_nous_feature`,
  `override_env_vars`); picking one sets the underlying backend + `use_gateway: true`.
- `hermes_cli/web_server.py` — `GET /api/portal` (line 4306) returns the portal
  status JSON: `{logged_in, portal_url, inference_url, provider, subscription_url,
  features: [{label, state}]}`; OAuth device-code endpoints
  `GET /api/providers/oauth` (10954), `POST .../{provider}/start` (12006),
  `POST .../{provider}/submit` (12044), `GET .../{provider}/poll/{session_id}` (12062),
  `DELETE .../sessions/{session_id}` (12092).

### 2.4 Tool consumers (gateway call sites)

- `plugins/web/firecrawl/provider.py` — direct config vs managed
  (`prefers_gateway("web")` → `resolve_managed_tool_gateway("firecrawl")`;
  client built with `api_url=gateway_origin`, `api_key=nous token`).
- `tools/image_generation_tool.py` — `FAL_MODELS` catalog (line 97; 9 models:
  `fal-ai/flux-2/klein/9b` default, `flux-2-pro`, `z-image/turbo`, `nano-banana-pro`,
  `gpt-image-1.5`, `gpt-image-2`, `ideogram/v3`, `recraft/v4/pro/text-to-image`,
  `qwen-image`); `DEFAULT_MODEL = "fal-ai/flux-2/klein/9b"` (line 664).
  `plugins/image_gen/fal/__init__.py` routes via `resolve_managed_tool_gateway("fal-queue")`.
- `tools/tts_tool.py` — `_resolve_openai_audio_client_config()` (line ~3870):
  direct key unless `prefers_gateway("tts")`, then `resolve_managed_tool_gateway("openai-audio")`
  with base URL `{origin}/v1`; whitelist `MANAGED_OPENAI_TTS_MODELS` (gateway
  rejects unsupported speech models with HTTP 400).
- `plugins/browser/browser_use/provider.py` — same pattern with
  `resolve_managed_tool_gateway("browser-use")`.

### 2.5 Data flow (today)

```
hermes tools / portal ──► tools_config.py ──► config.yaml (.use_gateway)
Nous OAuth (device code) ──► $HERMES_HOME/auth.json (providers.nous)
Tool call ──► prefers_gateway(section)? ──► resolve_managed_tool_gateway(vendor)
          ──► {vendor}-gateway.nousresearch.com/api/{vendor}  (Bearer)
Media    ──► presign POST /api/uploads/{vendor} → PUT storage → nous-upload:<token>
Portal status ──► nous_account + nous_subscription ──► hermes portal info | GET /api/portal
Desktop UI  ──► /api/providers/oauth/* (device-code login) + /api/portal (status)
```

## 3. Target TypeScript design

New module tree under `web/src/lib/tool-gateway/` (in-process, no Python):

```
web/src/lib/tool-gateway/
  types.ts            # ToolGatewayConfig, NousPortalStatus, ToolFeatureState,
                      #   ToolGatewayCatalog, MediaUploadResult, NousToken
  origins.ts          # buildVendorGatewayUrl, managedVendorEndpoints,
                      #   isManagedNousGatewayUrl (origin gating)
  token.ts            # peekNousAccessToken / readNousAccessToken (120s skew,
                      #   TOOL_GATEWAY_USER_TOKEN override), refresh via OAuth
  gateway-client.ts   # REST client + presign→PUT upload (fetch)
  entitlement.ts      # getNousPortalAccountInfo (JWT claims fast path +
                      #   fresh {portal}/api/oauth/account), entitled/entitledFor
  features.ts         # getNousSubscriptionFeatures(config) routing resolution
  portal-status.ts    # GET /api/portal consumer (Phase 1) → local compute (Phase 2)
web/src/hooks/
  use-tool-gateway.ts # TanStack Query hooks: portal status, catalog, per-tool toggle
  use-nous-portal.ts  # OAuth device-code login orchestration (token lifecycle)
web/src/routes/
  settings-tool-gateway-section.tsx   # portal info card + per-tool use_gateway toggles
packages/protocol/src/tool-gateway.ts # Zod schemas (new)
src/commands/tool_gateway.rs          # token/config persistence + external proxy (Rust)
```

Interfaces (signatures only — no implementation code):

```ts
interface ToolGatewayService {
  getPortalStatus(): Promise<PortalStatus>;            // logged_in, provider, features[]
  listTools(): ToolGatewayCatalogEntry[];              // static catalog (web/image/tts/browser)
  getFeatureState(key: ToolKey): Promise<ToolFeatureState>;
  setUseGateway(key: ToolKey, enabled: boolean): Promise<void>;
  readAccessToken(opts: { refresh?: boolean }): Promise<string | null>;
}

interface GatewayClient {
  call(vendor: string, path: string, init: RequestInit): Promise<Response>;
  upload(vendor: string, data: Blob, mime: string): Promise<string>; // nous-upload:<token>
}
```

Data flow (in-process): UI toggle → `features.ts` writes `use_gateway` to local
config store → tool execution picks `GatewayClient` (managed) vs direct vendor SDK
(BYOK) → `gateway-client.ts` reads live token per request → pinned vendor origin.
`origins.ts` is the single trust gate: the bearer is attached only when
`isManagedNousGatewayUrl(url)` is true, mirroring `managed_gateway_auth_headers`.

## 4. Data models & persistence

- **Per-tool flags** (config): mirror `config.yaml` sections
  `web.use_gateway`, `image_gen.use_gateway`, `tts.use_gateway`,
  `browser.use_gateway` (booleans). Persist in the desktop local config (Rust
  `AppState` JSON next to managed-runtime home; or `packages/minidb`-style SQLite
  if adopted). Migration: keep reading the Core-written `config.yaml` during
  Phase 1 (read-only), switch to local store in Phase 2 with a one-way sync.
- **Token store** (`auth.json providers.nous` equivalent): `{access_token,
  refresh_token, expires_at, scope, client_id, portal_base_url, inference_base_url}`.
  Stored via Rust command (`tool_gateway.rs`) — JSON file or SQLite in the
  Hermes home; Phase 1 can read the Core `auth.json` read-only.
- **Portal status / features** (ephemeral, TanStack Query cache): new Zod schemas
  in `packages/protocol/src/tool-gateway.ts`:
  `PortalStatusResponse` (`{logged_in, portal_url, inference_url, provider,
  subscription_url, features: [{key,label,state}]}`),
  `ToolFeatureState` (`{key,label,available,active,managedByNous,directOverride,
  currentProvider}`), `ToolGatewayConfig`. These freeze the Phase-1 REST contract
  (same shape as `GET /api/portal` today).
- **No new schema migration** beyond the local config store; version the store
  with the existing config-version mechanism (`config_version` in
  `packages/protocol/src/hermes-api.ts` StatusResponse).

## 5. Third-party library strategy

This is the most important section. **Verified: `D:/kimi-code` has NO Nous
Tool Gateway equivalent** — a case-insensitive search for
`firecrawl|nousresearch|nous-upload|use_gateway|browser-use` across the repo
returns 0 matches. `packages/oauth/src/managed-tools.ts` is Moonshot-internal
(`{kimiCodeBaseUrl}/tools` chat_title dispatch) and unrelated. Design from scratch
for the gateway; reuse kimi-code patterns for OAuth.

| Python dep / feature | TS strategy | Evidence |
|---|---|---|
| Nous OAuth device-code flow (`hermes_cli/auth.py`, `oauth_device_code`, client_id `hermes-cli`, 120s refresh skew) | Implement with fetch; kimi-code provides the browser-safe device-code primitives to copy: `requestDeviceAuthorization`, `pollDeviceToken`, `refreshAccessToken` | `D:/kimi-code/packages/oauth/src/device.ts` (lines 17–28), `packages/oauth/src/oauth.ts` (export lines 119/168/226); `oauth-manager.ts`, `token-state.ts`, `storage.ts` for token persistence patterns |
| Token refresh (OAuth refresh token, `resolve_nous_access_token`) | TS `refreshAccessToken` + timer skew (120s); store `expires_at` | kimi-code `packages/oauth/src/oauth.ts` `RefreshOptions`/`refreshAccessToken` |
| JWT claims decode for entitlement fast path (`hermes_cli/auth._decode_jwt_claims`, local unverified decode for UX only) | Base64url header/payload decode in TS (small util) or `jose` npm; **not verified** in kimi-code node_modules — pin choice during implementation | Core `hermes_cli/nous_account.py` lines 600–644; server API remains authoritative |
| HTTP client (`httpx` in managed_tool_gateway.py) | Native `fetch` (browser/webview); packaged-mode external calls via existing Rust `external_request`/`api_request` in `api_proxy.rs` (CORS-free) | Desktop `src/commands/api_proxy.rs` (EXTERNAL_HTTP_CLIENT, `external_request`); kimi-code uses `fetch` throughout `packages/oauth` |
| JSON (`orjson`) | `JSON.parse/stringify` (Zod-validated) | — |
| config.yaml read/write (`hermes_cli/config.py`, `tools_config.py`) | Phase 1: reuse existing backend REST; Phase 2: local config store + `yaml` npm parser or keep JSON; kimi-code config-schema patterns | `D:/kimi-code/packages/agent-core/src/config/schema.ts` (config schema patterns) |
| Firecrawl SDK (direct mode) | Direct mode keeps using the same Firecrawl REST (firecrawl.dev) via fetch; managed mode replaces `api_key`/`api_url` exactly like `plugins/web/firecrawl/provider.py` | Core `plugins/web/firecrawl/provider.py` lines 230–254 |
| FAL image/video SDK | Managed mode: REST to `{origin}/api/fal-queue` with `FAL_MODELS` catalog copied as a TS constant; model list is code-pinned | Core `tools/image_generation_tool.py` lines 97–127, 664; docs table in `website/docs/user-guide/features/tool-gateway.md` |
| OpenAI TTS (`openai` package) | Managed: `{origin}/v1/audio/speech` with `MANAGED_OPENAI_TTS_MODELS` whitelist; direct: keep `openai` npm client | Core `tools/tts_tool.py` lines 3870–3911 |
| Browser Use CLI | Managed: `{origin}/api/browser-use`; cloud-browser primitives (`browser_navigate/click/type/vision`) already exist as tool calls in the desktop agent | Core `plugins/browser/browser_use/provider.py` |
| Media upload (presign → PUT) | `fetch` POST presign (`{contentType, contentLength}`) → PUT to returned `uploadUrl` with exact headers → `nous-upload:<token>`; PUT through the same Rust external proxy in packaged mode | Core `tools/managed_tool_gateway.py` lines 366–451; parity test `tests/tools/test_managed_media_gateways.py` |

Where kimi-code lacks an equivalent (all gateway-specific surface), the plan
explicitly builds a thin TS module from scratch, pinned to the same constants the
Python client pins (`TOOL_GATEWAY_DOMAIN=nousresearch.com`, vendor paths
`/api/{vendor}`, `/api/uploads/{vendor}`).

## 6. Integration with existing Hermes-CN-Desktop frontend

- **Reuse (no change):**
  - `web/src/hooks/use-oauth-providers.ts` + `web/src/routes/settings-oauth-section.tsx`
    — the generic OAuth section already renders `nous` (device_code) login via
    `/api/providers/oauth/*`; the gateway section reuses the same modal for Portal
    sign-in (Phase 1). `OAuthProvider`, `OAuthStartResponse` etc. already in
    `packages/protocol/src/hermes-api.ts` (lines 1030–1089).
  - `web/src/lib/transport.ts` — auth-header-injected fetch wrapper (all REST).
  - `src/commands/api_proxy.rs` — `api_request` (dashboard proxy) and
    `external_request` (external HTTPS, CORS-free) for packaged mode.
  - `web/src/routes/settings.tsx` — section shell; `settings-models-section.tsx`
    already uses `useOAuthProviders` for provider selection.
- **New:**
  - `settings-tool-gateway-section.tsx` inside Settings — a "Nous Tool Gateway"
    card equivalent to `hermes portal info`: Portal auth state, subscription
    links, and a per-tool table (Web / Image gen / TTS / Browser) with
    "Nous Subscription" vs current provider routing state, plus a
    `use_gateway` toggle per tool (equivalent of `hermes tools` picker rows).
  - `use-tool-gateway.ts` / `use-nous-portal.ts` hooks (TanStack Query, staleTime
    like `use-oauth-providers` 60s; invalidate on toggle).
- **Conflation warning:** the existing Settings "Gateway" debug card
  (`settings.tsx` lines 1467–1520) is the WS **gateway process** (JSON-RPC over
  `/api/ws`), NOT the Nous Tool Gateway. Keep the new UI separate and name it
  "Nous Tool Gateway" / "Nous Portal".

## 7. Removing the WebSocket dependency (migration path)

The feature itself does not use `/api/ws` — it uses REST (`/api/portal`,
`/api/providers/oauth/*`) and direct HTTPS to the vendor gateways. The migration
is about removing the *backend-computed* status/routing and the Python OAuth
session:

1. **Phase 1 (keep backend):** Desktop consumes the frozen REST surface:
   `GET /api/portal` (portal status + features) and `/api/providers/oauth/*`
   (device-code login). Freeze this JSON contract (already matches the new
   `packages/protocol/src/tool-gateway.ts` Zod schemas).
2. **Phase 2 (in-process module behind same interface):** `ToolGatewayService`
   computes the same status locally from the local config store + token store +
   entitlement (JWT claims + `{portal}/api/oauth/account`). `use-tool-gateway.ts`
   swaps its data source from REST to the local service behind the identical
   interface; gateway tool calls switch from backend-routed to
   `gateway-client.ts` (dev: Vite proxy or direct fetch with CORS; packaged:
   Rust `external_request`).
3. **Phase 3 (delete):** drop the `/api/portal` + OAuth REST calls for this
   feature; remove Python-side OAuth session dependency. The WS link removal is
   covered by the broader desktop effort — this plan only guarantees the
   Tool Gateway surface never requires the Python process.

## 8. Migration phases & task breakdown

| Phase | Tasks | Exit criteria |
|---|---|---|
| P0 Parity mapping | Enumerate Python tests → vitest cases (see §10); pin constants (vendor URLs, refresh skew 120s, upload timeouts) | Test matrix doc; constants in `origins.ts`/`token.ts` |
| P1 Token + origins + client | `token.ts`, `origins.ts`, `gateway-client.ts`, presign upload; Rust `tool_gateway.rs` token/config persistence + external proxy | Vitest parity: bearer rotation, origin gating, `{}` when no token, upload shape |
| P2 Entitlement + features | `entitlement.ts` (JWT claims + fresh account), `features.ts` (use_gateway precedence, managed_*_available) | Parity vs `test_nous_subscription.py` / `test_managed_tool_gateway.py` |
| P3 UI | `settings-tool-gateway-section.tsx`, `use-tool-gateway.ts`, protocol Zod schemas; wire to `/api/portal` (Phase 1) | Playwright: portal card + toggles update routing |
| P4 Tool integration | Firecrawl web search, FAL image (9 models), OpenAI TTS (whitelist), Browser Use cloud | E2E with fake gateway (wiremock-style) |
| P5 In-process switch + delete | Swap hooks to local service; drop `/api/portal` + OAuth REST paths | `pnpm typecheck`, `pnpm test:unit`, cargo check green with backend off |

## 9. Risks & open questions

- **No TS equivalent found (verified):** kimi-code has no Nous Tool Gateway /
  Portal-subscription code (0 matches for firecrawl/nousresearch/nous-upload/
  use_gateway/browser-use). Every gateway-specific piece is designed from scratch;
  the OAuth device-code primitives are the only kimi-code borrow.
- **Nous-owned contract drift:** the gateway REST shape (`/api/{vendor}`, upload
  presign body `{contentType, contentLength}`, refusal `error.message`, JWT claim
  names `paid_access`/`tool_access.coverage`) is fixed by the Python client and
  Nous server; any server-side change must be mirrored in TS. Keep a single
  constants file.
- **CORS / packaged networking:** vendor gateways are external HTTPS origins.
  Packaged mode must route through Rust `external_request` (webview fetch may be
  blocked); dev mode needs Vite proxy or CORS handling. Verify with a real
  gateway before P4.
- **Token security:** `auth.json` is plaintext today; the TS/Rust store must match
  current behavior (and avoid exposing the bearer beyond the origin gate).
  Refresh skew (120s) and "read fresh per request" must be preserved to avoid a
  dead bearer in long sessions.
- **Entitlement edge cases:** free tool pool coverage is per-category (video
  excluded); `use_gateway: true` must suppress direct-credential probes exactly
  like `get_nous_subscription_features` (lines 456–476) or the routing table lies.
- **Model/TTS whitelist maintenance:** 9 FAL model IDs and
  `MANAGED_OPENAI_TTS_MODELS` are code-pinned in two places today; the TS copy
  needs a documented sync (gateway rejects unknown models with 400).
- **Test-file naming discrepancy:** the prompt's paths
  `tests/hermes_cli/test_tool_gateway*.py` and `tests/tools/test_tool_gateway*.py`
  do not exist in Core; actual parity sources are `tests/tools/test_managed_tool_gateway.py`,
  `tests/tools/test_managed_media_gateways.py`, `tests/hermes_cli/test_nous_subscription.py`,
  `tests/tools/test_tool_backend_helpers.py`, `tests/tools/test_tts_openai_config.py`.
- **Open questions:** JWT decode library choice (jose vs hand-rolled base64url —
  not verified in kimi-code); whether to reuse `packages/minidb` for the local
  config store; whether `hermes portal open` (browser open of
  manage-subscription) needs a Rust `openExternalUrl` command (likely reuse of
  existing `web/src/lib/external-links.ts`).

## 10. Test strategy

- **Unit (vitest, mocked fetch):** port parity from
  - `tests/tools/test_managed_tool_gateway.py` — vendor origin derivation,
    vendor-specific override, no-token/not-entitled → None, pinned endpoints
    (default `https://tool-gateway.nousresearch.com`), entitlement NOT consulted
    on address resolution, bearer headers (rotation, off-origin refusal,
    empty without token), presign→PUT exact type/length, `nous-upload:` result,
    no uploader for non-managed URL.
  - `tests/tools/test_managed_media_gateways.py` — upload timeouts/refusals.
  - `tests/hermes_cli/test_nous_subscription.py` + `tests/tools/test_tool_backend_helpers.py`
    — `use_gateway` precedence, managed_*_available, feature state labels,
    `prefers_gateway`.
  - `tests/hermes_cli/test_auth_nous_provider.py` — refresh skew behavior.
- **Component/unit:** `settings-tool-gateway-section` renders portal info and
  toggles; hooks invalidate queries.
- **Integration:** MSW (or Vite dev proxy) simulating `GET /api/portal` and a fake
  vendor gateway (`{vendor}-gateway.test`), asserting bearer injection and origin
  gating; Rust `tool_gateway.rs` tests with `tempfile::TempDir` +
  `wiremock::MockServer` (per AGENTS.md conventions).
- **E2E (Playwright):** real web → fake gateway: enable `web.use_gateway` →
  run a web search / image gen / TTS / browser action → assert request hits the
  pinned gateway with the Nous bearer and `nous-upload:` refs resolve.

## 11. Reference links

- Python source: `D:/hermes-agent-cn/tools/managed_tool_gateway.py`,
  `D:/hermes-agent-cn/tools/tool_backend_helpers.py`,
  `D:/hermes-agent-cn/hermes_cli/auth.py`,
  `D:/hermes-agent-cn/hermes_cli/nous_account.py`,
  `D:/hermes-agent-cn/hermes_cli/nous_subscription.py`,
  `D:/hermes-agent-cn/hermes_cli/portal_cli.py`,
  `D:/hermes-agent-cn/hermes_cli/tools_config.py`,
  `D:/hermes-agent-cn/hermes_cli/web_server.py` (lines 4306, 10954–12092),
  `D:/hermes-agent-cn/plugins/web/firecrawl/provider.py`,
  `D:/hermes-agent-cn/plugins/image_gen/fal/__init__.py`,
  `D:/hermes-agent-cn/plugins/browser/browser_use/provider.py`,
  `D:/hermes-agent-cn/tools/tts_tool.py`,
  `D:/hermes-agent-cn/tools/image_generation_tool.py`.
- Docs: `D:/hermes-agent-cn/website/docs/user-guide/features/tool-gateway.md`
  (incl. zh-Hans copy), `website/docs/user-guide/features/image-generation.md`,
  `website/docs/integrations/nous-portal.md`.
- Tests: `D:/hermes-agent-cn/tests/tools/test_managed_tool_gateway.py`,
  `D:/hermes-agent-cn/tests/tools/test_managed_media_gateways.py`,
  `D:/hermes-agent-cn/tests/hermes_cli/test_nous_subscription.py`,
  `D:/hermes-agent-cn/tests/tools/test_tool_backend_helpers.py`,
  `D:/hermes-agent-cn/tests/tools/test_tts_openai_config.py`,
  `D:/hermes-agent-cn/tests/hermes_cli/test_auth_nous_provider.py`.
- kimi-code (TS reference): `D:/kimi-code/packages/oauth/src/device.ts`,
  `D:/kimi-code/packages/oauth/src/oauth.ts`,
  `D:/kimi-code/packages/oauth/src/oauth-manager.ts`,
  `D:/kimi-code/packages/oauth/src/token-state.ts`,
  `D:/kimi-code/packages/oauth/src/storage.ts`,
  `D:/kimi-code/packages/oauth/src/managed-tools.ts` (NOT an equivalent),
  `D:/kimi-code/packages/agent-core/src/config/schema.ts`.
- Desktop integration: `D:/Hermes-CN-Desktop/web/src/hooks/use-oauth-providers.ts`,
  `D:/Hermes-CN-Desktop/web/src/routes/settings-oauth-section.tsx`,
  `D:/Hermes-CN-Desktop/web/src/routes/settings-models-section.tsx`,
  `D:/Hermes-CN-Desktop/web/src/routes/settings.tsx`,
  `D:/Hermes-CN-Desktop/web/src/lib/transport.ts`,
  `D:/Hermes-CN-Desktop/src/commands/api_proxy.rs`,
  `D:/Hermes-CN-Desktop/packages/protocol/src/hermes-api.ts` (lines 1030–1089).
