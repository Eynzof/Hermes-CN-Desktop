# Spotify — Python → TypeScript Rewrite Plan

> Feature slug: `spotify` · 7 tools via Spotify Web API + PKCE OAuth · Free vs Premium matrix
> Design-only plan. No implementation code.

## 1. Summary

Hermes' Spotify plugin gives the agent 7 tools — `spotify_playback`, `spotify_devices`,
`spotify_queue`, `spotify_search`, `spotify_playlists`, `spotify_albums`,
`spotify_library` — backed by the official Spotify Web API (`api.spotify.com/v1`) with
PKCE OAuth (`accounts.spotify.com`). It is a **user-registered-app** flow: Spotify does
not allow third parties to ship a public OAuth client, so every user creates their own
developer app and supplies a Client ID; PKCE needs no client secret.

This plan moves the feature into the Hermes-CN-Desktop TypeScript monorepo so it can run
in-process (no Python backend / no WebSocket dependency for these tools):

1. A thin `fetch`-based `SpotifyClient` (mirrors `plugins/spotify/client.py` exactly:
   Bearer auth, one 401→refresh retry, friendly error mapping, URI/id normalization).
2. A 7-tool registry module under `web/src/tools/spotify/` (the desktop currently has no
   in-process tool registry — this feature introduces the pattern).
3. PKCE OAuth implemented from scratch with WebCrypto (S256 challenge) plus a **Rust
   Tauri command** that runs the one-shot localhost callback listener (a webview cannot
   bind a TCP port; kimi-code's Node `callback-server.ts` pattern is re-implemented in
   Rust — `src/commands/browser_companion.rs` already proves a tokio `TcpListener`
   precedent).
4. Tokens persist in the same `~/.hermes/auth.json` → `providers.spotify` blob so the
   CLI and the desktop share one login (auth.json atomic writes go through Rust).

**Verified: `D:/kimi-code` contains zero "spotify" matches** (grep over the whole
repo). No TS Spotify client exists there to copy; the design is from scratch, with the
OAuth/PKCE + tool-registry plumbing cited from kimi-code's MCP OAuth service and
`packages/agent-core/src/tools/`.

## 2. Current Python implementation

Source of truth: `D:/hermes-agent-cn`

| File | Role |
|------|------|
| `plugins/spotify/plugin.yaml` | Manifest; `kind: backend`; `provides_tools` = the 7 tool names |
| `plugins/spotify/client.py` (435 lines) | `SpotifyClient`: `request()` with `_headers()` Bearer, 401→`_resolve_runtime(force_refresh=True)` retry once, `_raise_api_error` + `_friendly_spotify_error_message` (401 reauth / 403 Premium-or-no-device / 404 no device / 429 rate-limit), 204→empty payload dict, `normalize_spotify_id/uri/uris`, `compact_json` |
| `plugins/spotify/tools.py` (454 lines) | Per-tool handlers (`_handle_spotify_playback/devices/queue/search/playlists/albums/library`), coercion helpers (`_coerce_limit`, `_coerce_bool`, `_as_list`), JSON Schemas `SPOTIFY_*_SCHEMA` (name/description/parameters), results via `tools.registry.tool_result/tool_error` |
| `hermes_cli/auth.py` (~lines 165–186, 2810–3300) | `DEFAULT_SPOTIFY_ACCOUNTS_BASE_URL=https://accounts.spotify.com`, `DEFAULT_SPOTIFY_API_BASE_URL=https://api.spotify.com/v1`, `DEFAULT_SPOTIFY_REDIRECT_URI=http://127.0.0.1:43827/spotify/callback`, `DEFAULT_SPOTIFY_SCOPE` (10 scopes: user-modify/read-playback-state, user-read-currently-playing, user-read-recently-played, playlist-read-private/collaborative, playlist-modify-public/private, user-library-read/modify), `_spotify_code_verifier` (base64url 64B), `_spotify_code_challenge` (SHA-256 S256), `_spotify_build_authorize_url`, `_make_spotify_callback_handler` + `_spotify_wait_for_callback` (loopback 43827), `_spotify_exchange_code_for_tokens`, `_refresh_spotify_oauth_state`, `resolve_spotify_runtime_credentials(force_refresh, refresh_if_expiring, skew 120s)` |
| `website/docs/user-guide/features/spotify.md` (279 lines) | Setup wizard, tool reference, **Free vs Premium matrix**, cron usage, troubleshooting (403 no-device / Premium, 204 empty, 429, INVALID_CLIENT redirect) |
| `tests/hermes_cli/test_spotify_auth.py` (168 lines) | Refresh without changing active provider; `resolve_spotify_runtime_credentials` **quarantine** on terminal refresh failure (`last_auth_error` marker, dead tokens cleared, non-credential metadata preserved) |
| `tests/tools/test_spotify_client.py` (120 lines) | 401 retry once (`Bearer token-1` → `token-2`); URL→URI normalization; 204 empty explanatory payload; `spotify_refresh_invalid_grant` → `SpotifyAuthRequiredError` |

**Test-location caveat:** `features_report.md` cites `tests/plugins/test_spotify*.py`,
but those files do **not** exist; the real parity tests are the two files above
(`tests/hermes_cli/`, `tests/tools/`). Parity work must target those paths.

**Data flow today:** `hermes auth spotify` (CLI wizard; localhost listener on 43827;
tokens → `~/.hermes/auth.json` `providers.spotify`) → plugin registers 7 tool schemas →
agent emits a tool call over the WS JSON-RPC gateway → Python `tools.registry` dispatches
→ `SpotifyClient` → Spotify Web API; 401 triggers refresh and one retry. The Desktop
today only renders these tool calls (`web/src/stores/chat.ts` maps `payload.tool_id` →
`toolCallId`); it never executes them locally.

## 3. Target TypeScript design

In-process module layout (runs entirely in the Tauri webview + Rust IPC):

```
packages/protocol/src/spotify.ts        # Zod: provider status, token state, tool I/O (new)
web/src/tools/spotify/types.ts          # TS types for API responses (Device, PlaybackState,
                                        #   Queue, Playlist, Album, SearchResults, LibraryItem)
web/src/tools/spotify/client.ts         # SpotifyClient — fetch-based, mirrors client.py
web/src/tools/spotify/normalize.ts      # normalizeSpotifyId / normalizeSpotifyUri / normalizeSpotifyUris
web/src/tools/spotify/errors.ts         # SpotifyError, SpotifyAuthRequiredError, SpotifyApiError
web/src/tools/spotify/auth.ts           # PKCE: verifier/challenge (WebCrypto), authorize URL,
                                        #   token exchange, refresh, single-flight + quarantine
web/src/tools/spotify/tools.ts          # 7 tool definitions (name/description/zod params/execute)
web/src/tools/spotify/registry.ts       # ToolRegistry (new pattern, see §5) + dispatch
web/src/tools/spotify/index.ts          # registerSpotifyTools(registry)
web/src/hooks/use-spotify.ts            # React Query hooks: status, login, disconnect, tools
web/src/routes/settings-spotify-section.tsx  # Settings UI (reuses OAuth modal primitives)
src/commands/spotify_oauth.rs           # Rust: localhost callback listener + auth.json store (new)
src/commands/mod.rs                     # register spotify_oauth commands
```

Interfaces (pseudocode — no implementation):

```ts
interface SpotifyTool { name: string; description: string; parameters: ZodType; execute(args: unknown): Promise<SpotifyToolResult>; }
interface SpotifyToolRegistry { register(t: SpotifyTool): void; get(name: string): SpotifyTool; list(): SpotifyTool[]; execute(name: string, args: unknown): Promise<SpotifyToolResult>; }
interface SpotifyTokenState { client_id: string; redirect_uri: string; api_base_url: string; accounts_base_url: string; scope: string; granted_scope?: string; access_token: string; refresh_token: string; token_type: "Bearer"; expires_at: string; expires_in: number; obtained_at: string; auth_type: "oauth_pkce"; last_auth_error?: {...}; }
interface SpotifyClient { request(method, path, { params, jsonBody, allowRetryOn401, emptyResponse }): Promise<unknown>; getDevices(); transferPlayback(...); getPlaybackState(); ... /* one method per client.py method */ }
```

Data flow (end-state): React settings tab → `useSpotify()` → Rust `spotify_oauth`
commands (callback listener + auth.json read/write) → `SpotifyClient` (webview `fetch`
straight to `api.spotify.com`) → 7 tools registered in the in-process `ToolRegistry` →
future in-process agent runtime (same `execute(name, args)` contract the WS gateway uses
today). No Python, no WS, no REST proxy involved.

## 4. Data models & persistence

- **Auth/token state** — persist the exact `providers.spotify` blob shape the Python
  side writes today, so CLI↔Desktop stay interchangeable: `client_id`, `redirect_uri`,
  `api_base_url`, `accounts_base_url`, `scope`, `granted_scope`, `access_token`,
  `refresh_token`, `token_type`, `expires_at`, `expires_in`, `obtained_at`,
  `auth_type: "oauth_pkce"`, optional `last_auth_error`. File: `~/.hermes/auth.json`
  (JSON, top-level `providers.spotify` key). Written atomically by a new Rust command
  (tmp-file + rename, same idea as kimi-code `packages/agent-core/src/mcp/oauth/store.ts`
  `JsonFileStore`); Python's `_auth_store_lock` is the concurrency contract to respect
  during migration.
- **Refresh/expiry rules** — refresh when `now >= expires_at - 120s` (mirror
  `SPOTIFY_ACCESS_TOKEN_REFRESH_SKEW_SECONDS`); single-flight refresh (one in-flight
  promise shared by concurrent callers — pattern from kimi-code
  `packages/agent-core/src/mcp/oauth/service.ts` and `oauth-token-transaction.ts`);
  on terminal refresh failure (invalid_grant / relogin required) **quarantine**: clear
  `access_token/refresh_token/expires_*`, write `last_auth_error`, raise
  `SpotifyAuthRequiredError` so the UI shows "re-login" (parity with
  `test_spotify_auth.py`).
- **No tool-level persistence.** Playback/search/playlist/library calls are stateless;
  pagination cursors (`limit`/`offset`, `after`/`before`) are request args only. No
  SQLite/IndexedDB/schema migrations needed for this feature.
- **Settings** (client id / redirect uri overrides) — reuse the existing config/env
  mechanism (`HERMES_SPOTIFY_CLIENT_ID`, `HERMES_SPOTIFY_REDIRECT_URI`); in desktop,
  store via Rust env/config command so the running Python backend (during migration) and
  CLI both see it.

## 5. Third-party library strategy

**Verified: no TS equivalent for the Spotify client or tools exists anywhere in
`D:/kimi-code`** (0 grep matches for `spotify`). PKCE/OAuth plumbing and tool
registry patterns exist and are cited below. Everything Spotify-specific is implemented
from scratch.

| Python dependency (feature use) | TS equivalent | Evidence / design |
|---|---|---|
| `httpx` (REST calls, 30s timeout) | Webview `fetch` (built-in) | No dep. `fetch` + `AbortSignal.timeout(30000)`. If Rust-side calls are ever needed, `reqwest` (already in Tauri workspace). |
| `orjson` (JSON encode/decode) | `JSON.stringify` / `JSON.parse` (built-in) | No dep. |
| `urllib.parse.urlparse` (normalize ids/URLs) | `new URL()` (built-in) | `normalizeSpotifyId` handles `spotify:type:id`, `open.spotify.com/...` paths; parity with `test_normalize_spotify_uri_accepts_urls`. |
| PKCE OAuth (`hashlib`/`base64`/`os.urandom`, localhost callback via stdlib `http.server`) | **From scratch** with WebCrypto + Rust listener | kimi-code evidence: `packages/agent-core/src/mcp/oauth/provider.ts` keeps PKCE `codeVerifier()`/`state()` and delegates the S256 challenge to `@modelcontextprotocol/sdk/client/auth.js`; `callback-server.ts` is a one-shot localhost `/callback` listener returning `{ code, state }`. Desktop has no Node runtime, so the listener becomes a **Rust Tauri command** (tokio `TcpListener` precedent: `src/commands/browser_companion.rs:31,144`). WebCrypto `crypto.subtle.digest("SHA-256", ...)` + `crypto.getRandomValues` replaces Python's `hashlib.sha256`/`base64.urlsafe_b64encode`. |
| Token refresh serialization / single-flight | Pattern from kimi-code | `packages/agent-core/src/mcp/oauth/service.ts` (`refresh()` single-flight, proactive timer `REFRESH_AHEAD_MS=120_000`) and `packages/oauth/src/oauth-token-transaction.ts` (authorization_code/refresh_token grants, invalid_grant handling). Implement a small `refreshTokenSingleFlight` helper in `auth.ts`. |
| JSON Schema tool defs (`SPOTIFY_*_SCHEMA`) | `zod` (already used in `packages/protocol`) | Tool `parameters` become Zod schemas; the registry validates args before `execute`. |
| `spotify-web-api-node` / `@spotify/web-api-ts-sdk` (npm alternatives) | **Not used — thin shim from scratch** | These SDKs exist in the npm ecosystem but their error/204/empty semantics don't match Python; a ~200-line fetch client keeps behavior parity and zero extra runtime deps. |
| Spotify tool registry | **New TS module** (`web/src/tools/spotify/registry.ts`) | Desktop has **no in-process tool registry today** (grep: no `ToolRegistry`/`registerTool`). kimi-code's `packages/agent-core/src/tools/` (`store.ts`, `args-validator.ts`, `builtin/`) is the structural reference for how tools are declared/validated/registered; this feature seeds the desktop-wide registry pattern with 7 tools. |

## 6. Integration with existing Hermes-CN-Desktop frontend

- **OAuth UI reuse** — `web/src/routes/settings-oauth-section.tsx` already has a
  login modal supporting `pkce` (browser + paste code), `device_code` (poll), and
  `loopback` (browser callback + poll) flows, backed by
  `web/src/hooks/use-oauth-providers.ts`. Spotify's desktop flow is effectively
  `loopback` (Rust callback listener + poll) — reuse the modal component and add a
  Spotify card, either by extending the `/api/providers/oauth` catalog (backend) or,
  for end-state in-process, by a new `settings-spotify-section.tsx` that reuses the same
  modal primitives against `useSpotify()`. During migration, the 
  `cli-delegation.ts` path can run `hermes auth spotify` as a fallback.
- **Protocol schemas** — `packages/protocol/src/hermes-api.ts` already defines
  `OAuthProvider`/`OAuthProviderStatus`/`OAuthStartResponse` (pkce/device_code/loopback
  discriminated union)/`OAuthSubmitResponse`/`OAuthPollResponse`/`OAuthDisconnectResponse`
  (lines 1014–1092). Add `spotify.ts` with token-state and tool-IO schemas; keep the
  provider-status shape aligned so existing badge/expiry helpers (`badgeStatus`,
  `formatExpiry`) work unchanged.
- **Connection/auth events** — `web/src/lib/connection-auth-events.ts`
  (`CONNECTION_AUTH_RESTORED_EVENT`) is the hook the app uses to refetch auth state after
  a connection is restored; Spotify login/disconnect should dispatch the same event so
  tools/cron UI refresh consistently.
- **Transport** — `web/src/lib/transport.ts` (fetchJSON/postJSON/deleteJSON with
  `Bearer` session token + `X-Hermes-Profile`) stays the path for *backend* REST calls
  during migration; in-process Spotify calls bypass it and go straight to the Spotify API
  with the OAuth Bearer. No change needed to `src/commands/api_proxy.rs`/`oauth_session`
  (those are for LLM-provider gateways, not Spotify).
- **Rust commands** — new `src/commands/spotify_oauth.rs` (start listener → return
  `redirect_uri`/`auth_url`; wait for `{code,state}`; exchange+refresh; read/write
  auth.json) registered in `src/commands/mod.rs`, following the existing 60-command
  pattern and the `browser_companion.rs` tokio listener precedent.

## 7. Removing the WebSocket dependency (migration path)

Freeze this API surface during migration (do not change semantics mid-flight):

1. **Tool contract** — names (`spotify_playback`, ...), `action` enums, argument names
   (`device_id`, `market`, `uris`, `context_uri`, `position_ms`, `state`, `volume_percent`,
   `limit`, `offset`, `kind`, `playlist_id`, `album_id`, ...), result envelope
   (`tool_result`/`tool_error` → `{ success, ... }` shape).
2. **Error semantics** — 401→refresh→retry-once; 403 "Premium required"/"no active
   device"; 404 "no active device"; 429 with Retry-After; 204→explanatory empty payload
   (`is_playing:false` / `has_active_device:false`).
3. **Auth.json schema** — `providers.spotify` blob shape + `last_auth_error` quarantine.

Phased path:

- **Phase 1 (today):** tools stay Python-side; desktop settings UI added using CLI
  delegation (`hermes auth spotify`) + existing WS tool-call rendering. Nothing breaks.
- **Phase 2:** implement in-process `SpotifyClient` + 7 tools + `ToolRegistry` behind the
  same frozen contract; wire a "local execution" switch for spotify tools while WS still
  exists for everything else.
- **Phase 3:** move auth in-process (WebCrypto PKCE + Rust listener), switch settings UI
  to `useSpotify()`, persist to shared auth.json.
- **Phase 4:** when the in-process agent runtime lands (desktop-wide roadmap), route
  spotify tool calls through `ToolRegistry.execute`; delete the WS/REST path for these
  7 tools; remove Python plugin from the desktop-managed runtime (keep it in Core for CLI
  users).

## 8. Migration phases & task breakdown

| # | Task | Deliverable |
|---|------|-------------|
| P0 | Grep-verify no TS Spotify equivalent (done); freeze contract (§7) | This plan |
| P1 | Add `packages/protocol/src/spotify.ts` (Zod schemas for token state + tool I/O) | Protocol types |
| P2 | `web/src/tools/spotify/` — `errors.ts`, `normalize.ts`, `client.ts` (fetch, 401 retry, friendly errors, 204 empty) | Client parity (unit tests) |
| P3 | `web/src/tools/spotify/tools.ts` + `registry.ts` — 7 tools with zod params + coercion (`limit` clamp 1–50, bool coercion, `_as_list`) | Tool registry |
| P4 | `web/src/tools/spotify/auth.ts` — PKCE verifier/challenge (WebCrypto S256), authorize URL, token exchange, single-flight refresh, quarantine | Auth core |
| P5 | `src/commands/spotify_oauth.rs` — localhost callback listener, auth.json atomic read/write, exchange/refresh; register in `mod.rs` | Rust commands |
| P6 | `web/src/hooks/use-spotify.ts` + `settings-spotify-section.tsx` (reuse OAuth modal; dispatch `CONNECTION_AUTH_RESTORED_EVENT`) | Settings UI |
| P7 | Parity test suite (vitest + Rust unit + Playwright E2E) | Tests |
| P8 | Flip local execution; remove WS/REST path for spotify tools | Migration complete |

## 9. Risks & open questions

- **No TS equivalent found (verified):** zero `spotify` matches in `D:/kimi-code` —
  the Spotify client/tools are fully from-scratch. npm SDKs (`spotify-web-api-node`,
  `@spotify/web-api-ts-sdk`) exist but are intentionally not adopted (semantic parity).
- **No in-process tool registry in Desktop yet:** this plan seeds `ToolRegistry`, which
  depends on the desktop-wide "agent runtime in TS" roadmap; until then the 7 tools are
  callable only from tests and the settings UI, not from chat.
- **Webview cannot bind TCP:** the OAuth callback listener must be Rust (Tauri command).
  kimi-code's `callback-server.ts` is Node-only evidence; `browser_companion.rs` proves
  the tokio listener pattern but the exact command surface is new.
- **Auth.json concurrency:** while the Python backend is still running, two writers
  (`_auth_store_lock` vs Rust atomic write) could race. Mitigation: keep phase-1 auth on
  the Python side, single-writer per phase, then document a lock/merge rule.
- **Spotify app registration:** every user must register their own app; desktop onboarding
  must show the dashboard URL + redirect-URI requirement
  (`http://127.0.0.1:43827/spotify/callback` or a configurable override). PKCE means no
  secret, but redirect URI must match the user's allow-list (`INVALID_CLIENT` risk).
- **Free vs Premium:** Free accounts work for read-only tools; playback-mutating calls
  fail 403 with "Premium required" / "no active device". The TS client must keep the
  friendly error mapping so the agent/UI explain, not crash.
- **Refresh token lifecycle:** tokens persist across restarts but refresh tokens expire
  (~6 months) or are revoked; quarantine pattern must land with P4, or users get silent
  401 loops.
- **Test-path discrepancy:** `features_report.md` says `tests/plugins/test_spotify*.py`;
  real tests are `tests/hermes_cli/test_spotify_auth.py` + `tests/tools/test_spotify_client.py`
  — parity harness should reference the real paths and flag the doc mismatch.
- **Open questions:** (a) keep `market` optional/derived from user profile or always send
  `market=from_token`? Python currently passes `None`; (b) should the desktop settings
  show a "Spotify" card inside the existing OAuth section or a separate Tools/Integrations
  tab? (c) exact poll interval for the loopback flow in the modal.

## 10. Test strategy

- **Vitest unit (web/src/tools/spotify/*.test.ts)** — parity with
  `tests/tools/test_spotify_client.py`:
  - 401 → refresh → exactly one retry with new Bearer (mock `fetch`).
  - `normalizeSpotifyUri("https://open.spotify.com/track/...", "track")` → `spotify:track:...`;
    `spotify:type:id` passthrough; URL/URI/id mismatch errors.
  - 204 empty payload → `{ status_code: 204, empty: true, message: ... }` for
    `get_currently_playing` / `get_playback_state`.
  - `spotify_refresh_invalid_grant` → `SpotifyAuthRequiredError`; terminal refresh failure
    → quarantine writes `last_auth_error` and clears dead tokens (parity with
    `tests/hermes_cli/test_spotify_auth.py`).
  - Arg coercion: `limit` clamp 1–50, bool coercion ("true"/1/yes), `_as_list`, action
    enum validation, required-arg errors (`position_ms`, `device_id`, `name`, `query`, `kind`).
  - Zod schemas accept the same payloads the Python tool docs claim; schema names/enums
    match `SPOTIFY_*_SCHEMA`.
- **Rust unit (src/commands/spotify_oauth.rs tests)** — callback listener: returns
  `{ code, state }`, 404 on non-`/callback` path, rejects on `error`/missing code,
  timeout/abort/close paths (mirror `callback-server.ts` behavior); auth.json atomic
  write/read round-trip.
- **WebCrypto PKCE unit** — verifier length/format (base64url, ≤128 chars),
  S256 challenge deterministic vs known vector, state nonce uniqueness.
- **Playwright E2E** — settings: connect Spotify (mock listener + mocked
  `api.spotify.com`), badge status connected/expired/error, disconnect, dispatch of
  `CONNECTION_AUTH_RESTORED_EVENT`; a fake chat tool call executes one tool in-process.
- **Parity harness (optional, CI)** — run the Python tests' assertions against the TS
  module with a shared fixture for error payloads, to prove behavior parity.

## 11. Reference links

- Python source: `D:/hermes-agent-cn/plugins/spotify/{plugin.yaml,client.py,tools.py}`
- Python auth: `D:/hermes-agent-cn/hermes_cli/auth.py` (lines 165–186, 2810–3300)
- Python tests: `D:/hermes-agent-cn/tests/hermes_cli/test_spotify_auth.py`,
  `D:/hermes-agent-cn/tests/tools/test_spotify_client.py`
  (note: `tests/plugins/test_spotify*.py` does not exist despite `features_report.md`)
- Docs: `D:/hermes-agent-cn/website/docs/user-guide/features/spotify.md`
- Feature inventory: `D:/hermes-agent-cn/features_report.md` (line 84)
- kimi-code OAuth/PKCE: `D:/kimi-code/packages/agent-core/src/mcp/oauth/{service.ts,provider.ts,callback-server.ts,store.ts}`,
  `D:/kimi-code/packages/oauth/src/{oauth.ts,oauth-token-transaction.ts,oauth-manager.ts}`,
  `@modelcontextprotocol/sdk/client/auth.js` (S256 PKCE inside SDK)
- kimi-code tool registry reference: `D:/kimi-code/packages/agent-core/src/tools/`
- Desktop integration: `D:/Hermes-CN-Desktop/web/src/hooks/use-oauth-providers.ts`,
  `web/src/routes/settings-oauth-section.tsx`,
  `web/src/lib/connection-auth-events.ts`, `web/src/lib/transport.ts`,
  `packages/protocol/src/hermes-api.ts` (OAuth section, lines 1014–1092),
  `src/commands/api_proxy.rs`, `src/commands/browser_companion.rs`,
  `web/src/stores/chat.ts` (tool-call rendering), `web/src/lib/cli-delegation.ts`
- Spotify API: https://developer.spotify.com/documentation/web-api,
  https://developer.spotify.com/documentation/web-api/concepts/scopes
