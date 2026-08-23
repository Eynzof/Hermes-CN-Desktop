# Subscription Proxy — Python → TypeScript Rewrite Plan

> Feature: local OpenAI-compatible proxy (`hermes proxy start`) exposing Nous Portal / xAI
> OAuth subscriptions as raw inference for external apps.
> Design-only plan. No implementation.

## 1. Summary

The Python `hermes proxy` command runs a small loopback HTTP server (`127.0.0.1:8645/v1`)
that accepts any OpenAI-compatible request from external apps (OpenViking, Karakeep,
Open WebUI, …), attaches a freshly-resolved OAuth bearer for Nous Portal or xAI Grok,
forwards the request body verbatim to the upstream, and streams the response back
unchanged (SSE preserved). It is deliberately a credential-attaching passthrough — no
agent loop, no body rewriting, no request logging.

In the desktop end-state (no Python backend, no Dashboard `/api/ws` link), the same
server must run **in-process in the Tauri Rust process**, because a Tauri webview cannot
bind a TCP listener and external apps need a real listening socket. The design ports:

1. the **HTTP forwarder** to Rust (hyper 1 + hyper-util + tokio, already in
   `Cargo.toml`, with proven loopback-server precedent in `src/commands/browser_companion.rs`);
2. the **`UpstreamAdapter` contract** (Python `hermes_cli/proxy/adapters/base.py`) to a Rust
   trait, with `nous` and `xai` adapters that read the **same `$HERMES_HOME/auth.json`**
   credential store the Python runtime writes — so existing `hermes portal` /
   `hermes auth add xai-oauth` logins keep working without re-auth;
3. the **credential pool rotation** (Python `agent/credential_pool.py`) for xAI 401/429
   rotation and Nous JWT refresh/quarantine to Rust (kimi-code's `OAuthManager` is the
   closest TS design reference: lazy refresh, threshold, in-flight coalescing,
   cross-process file locking).

kimi-code has **no direct equivalent** of a credential-injecting OpenAI-compatible proxy
endpoint: its `packages/kap-server` is a Fastify agent API server, not a raw inference
passthrough. The desktop therefore must build the forwarder in Rust, using kap-server's
server-construction patterns (loopback default, host check, instance/port coordination)
as the design template. The main "no TS equivalent" risks are (a) no TS/Tauri-webview
HTTP server at all, and (b) no existing Rust/TS OAuth implementation for Nous/xAI — the
refresh/quarantine/pool logic must be ported from Python.

## 2. Current Python implementation

Source of truth: `D:/hermes-agent-cn`.

- **Server** — `hermes_cli/proxy/server.py` (310 lines):
  - aiohttp `web.Application`; routes `GET /health` and `* /v1/{tail:.*}`.
  - Per request: `rel_path = /v1/<tail>`; reject if not in `adapter.allowed_paths` (404
    `path_not_allowed` with the allowed list); resolve credential via
    `adapter.get_credential()` (401 `upstream_auth_failed` on failure); strip
    hop-by-hop + `authorization` headers (`_HOP_BY_HOP_HEADERS`); add
    `Authorization: Bearer <minted>`; forward body verbatim via aiohttp; stream
    response back chunk-by-chunk (`StreamResponse`, SSE preserved).
  - On upstream **401/429** calls `adapter.get_retry_credential(failed, status)` and
    re-sends once if a retry credential is returned.
  - Error mapping: `aiohttp.ClientError` → 502 `upstream_unreachable`,
    `asyncio.TimeoutError` → 504 `upstream_timeout`, setup failure → 500.
  - `MAX_REQUEST_BYTES = 10_000_000`; `DEFAULT_PORT = 8645`, `DEFAULT_HOST = 127.0.0.1`.
  - Port coordination via `hermes_cli/port_lock.py` (`try_claim_port`, lock file
    `$HERMES_HOME/.port-locks/<port>.lock`, PID + start-time stale detection).
- **CLI** — `hermes_cli/proxy/cli.py`: `hermes proxy start [--provider nous|xai]
  [--host] [--port]`, `hermes proxy status`, `hermes proxy providers`.
- **Adapter contract** — `hermes_cli/proxy/adapters/base.py`: `UpstreamCredential`
  (bearer, base_url, token_type, expires_at) and `UpstreamAdapter` ABC
  (`name`, `display_name`, `allowed_paths`, `is_authenticated`, `get_credential`,
  `get_retry_credential`, `describe`).
- **Registry** — `hermes_cli/proxy/adapters/__init__.py`: `ADAPTERS = {nous, xai}`.
- **Nous adapter** — `hermes_cli/proxy/adapters/nous_portal.py`: reads
  `$HERMES_HOME/auth.json` `providers.nous`; calls `resolve_nous_runtime_credentials()`
  (refresh/quarantine helpers from `hermes_cli/auth.py`); honors
  `NOUS_INFERENCE_BASE_URL` env override; allowed paths `/chat/completions`,
  `/completions`, `/embeddings`, `/models`; 401 → force-refresh retry.
- **xAI adapter** — `hermes_cli/proxy/adapters/xai.py`: loads `credential_pool["xai-oauth"]`
  via `agent/credential_pool.py`; `select()` on request; on 401 → `try_refresh_current()`
  then rotate; on 429 → `mark_exhausted_and_rotate()` (1-hour cooldown); allowed paths
  include `/responses` (codex_responses mode).
- **Related (NOT the same feature)** — `agent/proxy_sources/iron_proxy.py` is the
  **egress firewall** (`hermes egress`, TLS-intercepting Go binary). It is cited in the
  feature report as related "proxy" infra; its subprocess/pidfile/port patterns inform the
  desktop's process management, but the subscription proxy itself does not depend on it.
- **Docs** — `website/docs/user-guide/features/subscription-proxy.md`: quick start,
  provider list, allowed paths, OpenViking/Karakeep config, LAN exposure warning, rate
  limits, architecture (4-step passthrough), future providers.
- **Tests** — `tests/hermes_cli/test_proxy.py`: registry, Nous concurrent-refresh
  serialization, xAI 429 pool rotation, server strips client auth header, streaming SSE
  via a fake upstream. `tests/test_iron_proxy*.py` cover the separate egress feature.
  ⚠ `tests/gateway/test_subscription_proxy*.py` is **cited by `features_report.md` but
  does not exist** in the current Core checkout — parity coverage lives in
  `tests/hermes_cli/test_proxy.py`.

## 3. Target TypeScript design

Architecture decision: **the proxy server runs in the Rust Tauri process**, not in the
webview and not in a Node sidecar. kimi-code's kap-server runs in a Node process; the
desktop's equivalent "in-process host" is the Rust process. The webview only gets UI
(settings panel + status) and drives the server via Tauri IPC commands.

Module layout (new code):

```
src/proxy/mod.rs                  # registry, lifecycle handle, PortClaim
src/proxy/server.rs               # hyper loopback server: /health, /v1/{tail:.*}, streaming forward
src/proxy/adapter.rs              # trait UpstreamAdapter + struct UpstreamCredential (Rust)
src/proxy/adapters/nous.rs        # NousPortalAdapter (reads auth.json, refresh, quarantine)
src/proxy/adapters/xai.rs         # XAIGrokAdapter (credential pool select/rotate)
src/proxy/credential_pool.rs      # port of agent/credential_pool.py (rotation, cooldowns)
src/commands/subscription_proxy.rs# Tauri commands: start/stop/status/providers/config
web/src/lib/subscription-proxy.ts # invoke wrappers + status polling
web/src/routes/settings/proxy.tsx # settings panel (provider select, start/stop, URL + status)
web/src/stores/subscription-proxy.ts # Jotai status store
```

Core trait (signature sketch, not implementation):

```rust
struct UpstreamCredential { bearer: String, base_url: String, token_type: String, expires_at: Option<String> }

#[async_trait]
trait UpstreamAdapter: Send + Sync {
    fn name(&self) -> &'static str;            // "nous" | "xai"
    fn display_name(&self) -> &'static str;
    fn allowed_paths(&self) -> HashSet<String>;
    fn is_authenticated(&self) -> bool;        // cheap, no network
    async fn get_credential(&self) -> Result<UpstreamCredential, ProxyError>;
    async fn get_retry_credential(&self, failed: &UpstreamCredential, status: u16)
        -> Option<UpstreamCredential>;         // 401 force-refresh / 429 pool rotate
}
```

Data flow per request:

1. External app → `POST http://127.0.0.1:8645/v1/chat/completions` (any bearer).
2. Rust `server.rs` validates `Host` (parity with `browser_companion.rs::valid_host`),
   reads body (cap 10 MB, parity `MAX_REQUEST_BYTES`), checks `rel_path ∈ allowed_paths`.
3. `adapter.get_credential().await` (tokio Mutex serializes refresh; refresh only when
   near expiry — kimi-code `OAuthManager.ensureFresh` threshold pattern).
4. Strip hop-by-hop + client `authorization`; set `Authorization: Bearer <real>`.
5. `reqwest` (stream feature already enabled) forwards method/body/query/headers to
   `<base_url><rel_path>?<query>`; `allow_redirects(false)`.
6. Stream upstream response chunks back with hyper `Response<Full<Bytes>>`-style
   chunked writes; `text/event-stream` SSE passes through untouched.
7. On upstream 401/429 → `get_retry_credential` → one re-send with rotated credential.
8. `GET /health` returns `{status:"ok", upstream, authenticated}` (no upstream call).

Lifecycle: `start` binds `127.0.0.1:8645` (fallback → ephemeral port, as
`browser_companion.rs` does), claims the port lock, spawns the accept loop on
`tauri::async_runtime::spawn`, stores a `ProxyHandle { port, cancel }` in `AppState`;
`stop` aborts the task and releases the lock; `status` reports adapter auth state +
listening port. Runs independently of the Dashboard process — no WS link involved.

## 4. Data models & persistence

- **No new database.** Reuse the Python auth store schema at `$HERMES_HOME/auth.json`
  (`AppState.hermes_home` already resolves this on desktop; see `src/state.rs`):
  - `providers.nous`: `{ agent_key?, access_token?, refresh_token?, expires_at?, base_url? }`
    (NousPortalAdapter reads `agent_key`/refresh pair; quarantine writes back
    `quarantine_error/reason`).
  - `credential_pool["xai-oauth"]`: array of `{ id, label, auth_type, priority, source,
    access_token, refresh_token, base_url, runtime_api_key?, expires_at? }`.
- **Read-only by default in v1**: Rust adapters read the store; refresh/quarantine
  writes are done with the same cross-process file lock discipline as
  `hermes_cli/port_lock.py` (fs2 advisory lock on `auth.json` or a sibling `.lock`),
  mirroring Python's `_auth_store_lock` and kimi-code's `proper-lockfile` coordination.
- **Optional user config** `$HERMES_HOME/proxy/proxy.json`
  `{ provider?: "nous"|"xai", host?: string, port?: number }` — parity with CLI flags;
  if absent, defaults `nous` / `127.0.0.1` / `8645`.
- **No SQLite / IndexedDB** needed; the feature is stateless passthrough. Only the
  in-memory `ProxyHandle` and credential pool cache are process state.

## 5. Third-party library strategy

| Python dependency | TS/Rust equivalent | Evidence |
|---|---|---|
| aiohttp server (`web.Application`, `StreamResponse`) | **Rust hyper 1 + hyper-util + tokio** (already in `Cargo.toml`); no TS-webview equivalent — Tauri webview cannot bind TCP | `Cargo.toml: hyper = {version="1", features=["http1","server"]}`, `hyper-util`, `tokio`; loopback server precedent `src/commands/browser_companion.rs` (hyper `service_fn`, `TokioIo`, `http1::Builder`). kimi-code uses Fastify in a Node process (`packages/kap-server/package.json` dep `fastify ^5.1.0`) — proves server infra exists in TS/Node but is unusable inside a Tauri webview |
| aiohttp client (forwarding, streaming) | **reqwest 0.12** with `stream` feature (already in `Cargo.toml`) | `Cargo.toml: reqwest ... features=["cookies","json","multipart","rustls-tls","stream"]`; used by `browser_companion.rs` (`PROXY_HTTP_CLIENT`, `redirect::Policy::none()`) and `api_proxy.rs` |
| `threading.Lock` in adapters | `tokio::sync::Mutex` (async sections) / `std::sync::Mutex` (short) | already a dep (`tokio features=["full"]`) |
| `hermes_cli/port_lock.py` (advisory lock file, PID+start-time stale check) | **fs2 0.4** (already dep) advisory file locks; bind-fallback to ephemeral port as in `browser_companion.rs` | `Cargo.toml: fs2 = "0.4"`; `browser_companion.rs::start_companion_server` binds 9546 then falls back to port 0 |
| `agent/credential_pool.py` (xAI pool select/rotate/cooldown) | **Port from scratch to `src/proxy/credential_pool.rs`**; no npm equivalent | kimi-code `packages/oauth/src/oauth-manager.ts` is the closest conceptual analog: lazy `ensureFresh`, `defaultRefreshThreshold(expiresIn)` (≥300s or 50%), in-flight refresh coalescer, cross-process lock via `proper-lockfile` — all patterns to mirror in Rust |
| `hermes_cli.auth.resolve_nous_runtime_credentials` (Nous JWT refresh + quarantine) | **Port to Rust** in `adapters/nous.rs` using reqwest; endpoints/flags copied from `hermes_cli/auth.py` | kimi-code `packages/oauth/src/oauth.ts` (device-code + refresh) shows the HTTP refresh shape; Nous-specific refresh semantics have no kimi-code equivalent — must copy Python behavior exactly |
| `agent/credential_pool` refresh (`refresh_xai_oauth_pure`) | Rust reqwest call; pool cooldown constants (`EXHAUSTED_TTL_429_SECONDS`) ported | no TS equivalent found; `packages/oauth` refresh flow is the design template |
| OpenAI-compatible **client SDK** (not needed by the proxy itself, but external-app parity) | Not needed in the forwarder — it forwards bytes; if a TS smoke client is wanted, kimi-code already ships `openai` npm (`packages/kosong/src/providers/openai-legacy.ts` imports `OpenAI from 'openai'`) | `openai-legacy.ts:15` |
| `aiohttp` SSE streaming | Rust `reqwest::Response.bytes_stream()` → hyper chunked writes (no buffering) | `reqwest` `stream` feature; no kimi-code equivalent (kap-server doesn't raw-stream SSE passthrough; it uses Fastify replies) — implement in Rust with care |

**No TS-equivalent risks (explicit):**
1. **No TS HTTP server inside Tauri.** kap-server's Fastify is Node-only; a webview has
   no listen socket. The server must be Rust. This is the central "no TS equivalent" gap.
2. **No TS/Rust OAuth for Nous Portal / xAI Grok.** kimi-code's `OAuthManager` is Kimi's
   own device-code flow; Nous inference-JWT minting, quarantine-on-terminal-refresh, and
   xAI credential-pool rotation must be ported verbatim from Python — any drift changes
   auth behavior.
3. **SSE raw passthrough** has no kimi-code precedent; streaming correctness
   (chunk boundaries, `[DONE]` marker, no `content-length` rewrite) is Rust-side work.

## 6. Integration with existing Hermes-CN-Desktop frontend

- **Rust to reuse:**
  - `src/commands/browser_companion.rs` — loopback hyper server skeleton: `TcpListener`
    bind + fallback, `valid_host`, loopback origin check, bearer-token gate,
    `tauri::async_runtime::spawn` accept loop, `AppState` handle storage. Reuse the
    patterns; do not fork the port/token scheme (proxy uses port 8645 and no auth, per
    docs parity).
  - `src/commands/api_proxy.rs` — reqwest client construction, header filtering
    (`should_forward_request_header`), SSRF/IP guards (`is_blocked_external_ip`) if the
    upstream base URL ever becomes user-controlled; timeout constants pattern.
  - `src/state.rs` — `AppState.hermes_home`/`hermes_home_base` for `auth.json` path;
    add `proxy: Option<ProxyHandle>` beside `browser_companion`.
  - `src/process/dashboard.rs` — port claiming (`try_claim_dashboard_ports`,
    ownership marker) as the model for claiming 8645 with the Python CLI's lock file;
    `DEFAULT_DESKTOP_DASHBOARD_PORT = 9120` must not collide with proxy 8645 (it doesn't).
  - `src/commands/ws_proxy.rs` / `src/commands/mod.rs` — where to register the new
    Tauri commands in `generate_handler!`.
- **Web to add/reuse:**
  - `web/src/lib/tauri-bridge.ts` — invoke wrapper for the new commands.
  - New `web/src/lib/subscription-proxy.ts` (typed commands + `getHealth` polling) and
    `web/src/stores/subscription-proxy.ts` (Jotai status atom).
  - New settings panel route (reuse existing settings layout, `packages/shared-ui`).
  - `web/src/lib/transport.ts` is **not** involved — external apps hit the proxy
    directly over TCP; the web UI only controls it via IPC.
- **`tauri.conf.json` CSP**: `connect-src` already includes `http://127.0.0.1:*`, so the
  web UI *could* poll `http://127.0.0.1:8645/health` directly; prefer routing health via
  a Tauri command to keep the server bound to loopback-only semantics and avoid any CSP
  drift.

## 7. Removing the WebSocket dependency (migration path)

The subscription proxy is a **separate loopback endpoint** — it never used the Dashboard
`/api/ws` JSON-RPC channel. "Removing the WS dependency" here means: the proxy must keep
working when the Python runtime/Dashboard is gone, and the desktop UI must replace the
`hermes proxy start` terminal workflow.

Freeze this API surface during migration (parity with Python, testable):

- `UpstreamAdapter` trait / `UpstreamCredential` fields (bearer, base_url, token_type,
  expires_at).
- Allowed-path sets: nous = `/chat/completions`, `/completions`, `/embeddings`,
  `/models`; xai = those + `/responses`.
- Wire shapes: `GET /health` → `{status, upstream, authenticated}`; errors →
  `{error:{message,type,code}}` with codes `path_not_allowed`, `upstream_auth_failed`,
  `upstream_unreachable`, `upstream_timeout`; default port 8645; 10 MB body cap.
- `auth.json` schema (read-only contract) — do not change the Python store format.

Phases:

1. **Phase 1 (runtime still present):** Rust server + `FakeAdapter`-style adapters that
   resolve credentials by delegating to the managed runtime through a small frozen IPC
   surface (e.g. reuse existing dashboard REST or a `hermes auth`-style subprocess).
   Proxy works while Dashboard runs; UI panel added.
2. **Phase 2 (runtime optional):** port Nous refresh + xAI pool to Rust reading
   `auth.json` directly; proxy no longer needs the Dashboard. Delete the delegation path.
3. **Phase 3 (runtime removed):** proxy UI is the only entry point; the Python
   `hermes proxy` CLI is not invoked by the desktop; WS/REST path for this feature is
   deleted from the managed runtime bundle.
4. Cross-cutting: honor `$HERMES_HOME/.port-locks/8645.lock` so a Python `hermes proxy`
   and the desktop proxy never double-bind; surface a clear "already in use" error.

## 8. Migration phases & task breakdown

- **Phase 0 — Parity test inventory (design):** enumerate Python behaviors from
  `tests/hermes_cli/test_proxy.py` into a Rust parity test list (below, §10). No code.
- **Phase 1 — Rust forwarder (≈ weeks):**
  - `src/proxy/adapter.rs` trait + `ProxyError` mapping (502/504/401/404).
  - `src/proxy/server.rs`: loopback bind, host check, `/health`, `/v1/{tail:.*}`
    catch-all, path allowlist, hop-by-hop header strip, reqwest forward, chunked
    streaming, 401/429 one-retry.
  - Port lock via fs2 with `$HERMES_HOME/.port-locks/8645.lock` (Python-format
    compatibility).
  - Rust tests with `wiremock` fake upstream; register commands in `commands/mod.rs`.
- **Phase 2 — Adapters + frontend:**
  - `adapters/nous.rs` (auth.json read, refresh, quarantine, env override);
    `adapters/xai.rs` + `credential_pool.rs` (select/rotate, 429 cooldown).
  - Tauri commands `subscription_proxy_start/stop/status/providers/config`;
    `web/src/lib/subscription-proxy.ts` + settings route + Jotai store.
- **Phase 3 — Runtime independence:** cut delegation; direct auth.json reads; verify
  proxy works with Dashboard stopped; update managed-runtime bundle to drop proxy CLI if
  no longer used elsewhere.
- **Phase 4 — E2E:** manual OAuth login → real Nous/xAI request through the proxy;
  Playwright smoke (start/stop/status); docs update mirroring
  `features/subscription-proxy.md` for the desktop UI.

## 9. Risks & open questions

1. **No TS equivalent for the TCP server** — the webview cannot host it; Rust owns it.
   Confirmed by absence of any listen-socket API in the Tauri webview and by kimi-code's
   server living in Node (`kap-server`), which the desktop does not run.
2. **OAuth subscription reuse in Tauri** — desktop Rust has only `oauth_session.rs`
   (gated-remote cookie session for the Dashboard), no Nous/xAI OAuth client. Porting
   `resolve_nous_runtime_credentials` + `CredentialPool` is the riskiest part: refresh
   endpoint details, quarantine semantics, pool cooldown constants, and the shared
   `auth.json` write-lock discipline must match Python exactly or credentials can be
   corrupted/rotated wrongly.
3. **Concurrent access to `auth.json`** — Python (`_auth_store_lock`, refresh helpers)
   and Rust adapters may both write during a refresh; need fs2 advisory locking parity
   (kimi-code uses `proper-lockfile` for the same reason). Open question: should Rust
   take the Python lock file or a sibling lock, and how to avoid deadlock with the
   Python runtime's own in-process mutex.
4. **Port collision with the Python CLI proxy** (both default 8645) — must honor the
   same `.port-locks/8645.lock` format, including stale-lock breaking (PID + start time).
5. **LAN exposure** — parity requires `--host 0.0.0.0` to be allowed but loudly warned
   (docs §Exposing on LAN); Rust must keep loopback default and mirror the warning.
6. **Test-evidence mismatch** — `tests/gateway/test_subscription_proxy*.py` cited by
   `features_report.md` does not exist; parity should target `tests/hermes_cli/test_proxy.py`.
7. Open: keep `hermes proxy` CLI in the managed runtime during Phase 1–2 (yes, for
   terminal users) or move it desktop-only? Recommend keep until Phase 3.

## 10. Test strategy

Parity tests vs Python (`tests/hermes_cli/test_proxy.py`) — each maps 1:1:

| Python behavior | Rust test |
|---|---|
| client `Authorization` must not reach upstream (`test_server_strips_client_auth_header`) | wiremock fake upstream asserts header swap |
| path allowlist 404 with allowed list | request `/v1/images/generations` → 404 `path_not_allowed` |
| Nous adapter: concurrent `get_credential` serialized (`test_nous_adapter_concurrent_refresh_serialized`) | tokio Mutex test with in-flight counter |
| xAI: 429 rotates pool entry without refresh (`test_xai_adapter_retry_rotates_pool_entry_on_429`) | fake pool + assert next bearer, no refresh call |
| xAI: not authenticated when pool empty | unit test |
| SSE streaming preserved | fake upstream emits `data:` chunks + `[DONE]`; assert byte-equal passthrough |
| upstream unreachable → 502; timeout → 504 | wiremock down / delayed response |
| 401 retry with rotated credential | fake upstream 401 on first bearer, 200 on second |
| `/health` shape + `authenticated` flag | unit + integration |

- **Rust unit:** adapter registry, auth.json parsing (nous + xai fixtures), header
  filter, credential pool rotation/cooldown, port lock claim/stale-break.
- **Rust integration:** spawn server on ephemeral port + wiremock upstream
  (`dev-dependencies` already has `wiremock`), covering the table above.
- **Vitest:** `web/src/lib/subscription-proxy.ts` invoke wrapper mocks, status store
  transitions (stopped → starting → running → error), settings panel rendering.
- **Playwright E2E:** open settings → start proxy → poll status badge → stop; optionally
  point a fake OpenAI client at the printed URL.
- **Manual/parity gate:** real `hermes portal` OAuth → real Nous chat completion through
  the Rust proxy; xAI pool rotation with two accounts.

## 11. Reference links

- Python: `D:/hermes-agent-cn/hermes_cli/proxy/server.py`, `cli.py`,
  `adapters/{base,__init__,nous_portal,xai}.py`, `port_lock.py`,
  `agent/proxy_sources/iron_proxy.py` (related egress feature),
  `website/docs/user-guide/features/subscription-proxy.md`,
  `tests/hermes_cli/test_proxy.py`, `features_report.md` (line 101).
- kimi-code: `packages/kap-server/package.json`, `src/start.ts` (Fastify startServer,
  host check, auth hook, instance registry), `src/routes/oauth.ts`,
  `packages/oauth/src/{oauth-manager,token-state,storage,oauth}.ts`,
  `apps/kimi-code/src/cli/sub/web/{run,shared}.ts`,
  `packages/kosong/src/providers/openai-legacy.ts`.
- Desktop: `Cargo.toml` (hyper, hyper-util, tokio, reqwest stream, fs2, wiremock),
  `src/commands/browser_companion.rs`, `src/commands/api_proxy.rs`,
  `src/commands/ws_proxy.rs`, `src/state.rs`, `src/process/dashboard.rs`,
  `tauri.conf.json`, `web/src/lib/{transport,tauri-bridge,gateway-client}.ts`.
