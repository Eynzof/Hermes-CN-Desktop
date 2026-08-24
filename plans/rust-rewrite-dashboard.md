# Plan: Rewrite dashboard from TypeScript to Rust (`src/`)

- Status: Draft
- Source: `packages/dashboard/src/...` (12 files, ~655 source lines + 13 vitest files, 138 test cases)
- Target Rust: `src/dashboard/` (+ `src/commands/dashboard_auth.rs`)
- Author: analysis subagent
- Date: 2026-08-24

## 1. Executive summary

`packages/dashboard` is the local-first dashboard layer: a pure request router
(`router.ts`, no HTTP deps), an auth stack (`auth/provider.ts`,
`auth/crypto.ts`, `auth/session-store.ts`, `auth/basic.ts`, `auth/token.ts`,
`auth/oidc.ts`), and two route families (`routes/auth.ts`, `routes/status.ts`).
Its real consumer is `web/src/lib/dashboard-handlers.ts`, which imports
`BasicAuthProvider`, `TokenAuthProvider`, `createInMemorySessionStore`,
`createAuthRoutes`, `DashboardRouter` and registers them against the web's own
separate route registry (`web/src/lib/dashboard-router.ts`).

The honest recommendation:

- **Move to Rust (high value):** the security-sensitive session/token core —
  `auth/session-store.ts` + `auth/crypto.ts` (HMAC-SHA256 signing, random
  secret generation, access-token `id.signature` format, revocation, expiry)
  and the static `TokenAuthProvider` (constant-time opaque-token validation).
  The TS comment in `session-store.ts` already says the real secret "should be
  persisted in the Rust AppState". Rust already owns the packaged-mode token
  lifecycle (`src/commands/api_proxy.rs`, `src/commands/gateway.rs`,
  `src/process/dashboard.rs`).
- **Partially move / design for it:** the router — the package router is a
  pure table with exact+prefix matching; a Rust rewrite is only valuable as
  part of the **pure-Rust local HTTP service end-state** (the
  `src/api_server/mod.rs` / `src/subscription_proxy/mod.rs` loopback hyper
  pattern), not as a standalone port. Status routes (`routes/status.ts`) are
  trivially portable and already have Rust siblings
  (`dashboard_local_status`, `dashboard_local_env`).
- **Keep in TS:** the Basic and OIDC providers (password hashing and
  ID-token/JWKS verification are injected/`jose`-based today; TS is the right
  home until Rust gains bcrypt/argon2 + JWKS), and all the *actual* REST
  handlers that live in `web/src/lib/dashboard-handlers.ts` +
  `dashboard-local.ts` (those are not in this package and are explicitly
  out-of-scope for this package plan).
- **End-state (packaged mode):** a pure-Rust local HTTP/gateway service
  (hyper loopback on 127.0.0.1, auth + status + proxy) is the right
  destination — the webview already talks to Rust via IPC proxy
  (`api_request`) in packaged mode, so Rust owning auth/REST is a natural
  continuation. **But** browser-only dev (`python run.py`) runs the same TS
  runtime with no Rust at all, so the TS path must keep working or be
  explicitly gated. This plan proposes dual-path: Rust auth behind Tauri IPC
  in the desktop shell; unchanged TS for `run.py`.

Shared home with the gateway-core plan
(`plans/rust-rewrite-gateway-core.md`): `src/dashboard/` mirrors
`src/gateway/`, both reuse `src/state_db.rs` conventions, and both use the
same `RuntimeBackend` shim rule (Tauri presence selects Rust; browser-only
selects TS).

## 2. Why rewrite (value/motivation, quantified where possible; be honest)

Strong candidates:

1. **Session/token handling is security-sensitive (session-store.ts 71
   lines + crypto.ts 47 lines).** Access tokens are HMAC-SHA256 signed
   (`id.signature`), with revocation and expiry checks. TS implements HMAC
   via Web Crypto (`crypto.subtle`) — correct, but the secret currently lives
   in webview memory and is regenerated when omitted, so tokens are not
   deterministic across restarts. Rust already stores `session_token` /
   gateway secrets in `AppState` and injects auth headers server-side
   (`api_request`, `ws_proxy`, `refresh_gateway_url`). Moving the signing
   secret and session store to Rust:
   - keeps the secret out of the webview (smaller attack surface),
   - makes verification deterministic across restarts,
   - centralizes all token handling in the process that already owns
     `HERMES_DASHBOARD_SESSION_TOKEN` lifecycle,
   - gives constant-time comparison (`subtle::ConstantTimeEq`) instead of
     JS string compare.
   This is the strongest argument — security placement, not performance.
2. **Router + status routes are trivially portable and needed for the HTTP
   end-state (router.ts 108 lines + routes/status.ts 32 lines).** The
   exact+prefix matching table maps 1:1 to a Rust route table. Rust already
   runs two loopback hyper servers (`src/api_server/mod.rs` on 8642,
   `src/subscription_proxy/mod.rs` on 8645); a dashboard auth/status service
   would be the third instance of the same pattern, or better, a shared
   `src/dashboard/` router used by `api_server`/`dashboard_local`/new
   endpoints. Only pursue the Rust router as part of that service, not as an
   isolated port.
3. **TokenAuthProvider (51 lines) is a pure constant-time opaque-token check**
   — a natural Rust function; it is the provider the desktop actually uses
   for the managed-runtime token gate.

Honest caveats:

- **BasicAuthProvider (64 lines) and OidcAuthProvider (95 lines) are thin
  shells over injected crypto.** `verifyPassword`/`hashPassword` and
  `verifyIdToken` are injected precisely so the package stays dependency-free
  for browser import safety. Porting the shells to Rust gains nothing until
  Rust owns password hashing (bcrypt/argon2) and JWKS verification — plan as
  follow-ups, not phase A.
- **The package is small (~655 source lines) and most of the real REST
  surface is outside it** (`web/src/lib/dashboard-handlers.ts` is ~615 lines
  alone, plus `dashboard-local.ts`). A package-only rewrite does not make the
  dashboard pure-Rust; the bigger web-side surface must be addressed
  separately (out-of-scope here but noted).
- **Performance is not the win.** In-process route dispatch and HMAC over
  Web Crypto are already fast at local volumes. The wins are security
  placement, restart-stable sessions, and a coherent end-state.

## 3. Scope

### In-scope

- `src/dashboard/session.rs` — port of `createInMemorySessionStore` +
  `auth/crypto.ts` primitives (HMAC-SHA256 sign/verify, random hex, SHA-256
  digest) with a `DashboardSessionStore`-shaped Rust API; secret from
  `AppState` (persisted/configurable), constant-time token verification,
  revocation set, expiry.
- `src/dashboard/token.rs` — `TokenAuthProvider` port (opaque bearer check,
  `extract_principal` default = `sub: "service"` when token starts with
  secret).
- `src/dashboard/router.rs` — route table (exact + prefix) with
  serde-camelCase `DashboardRequestContext`/handler trait; **only as the
  basis for the local HTTP service end-state** (phase B), not a standalone
  port.
- `src/dashboard/routes.rs` — status/health/version handlers
  (port of `routes/status.ts`) and auth route handlers (port of
  `routes/auth.ts`) behind the router; reuses `dashboard_local_status`
  fields already in `src/commands/dashboard_local.rs`.
- `src/commands/dashboard_auth.rs` — narrow `#[tauri::command]` wrappers
  (`dashboard_session_create`, `dashboard_session_verify`,
  `dashboard_session_revoke`, `dashboard_token_verify`, …) registered in
  `main.rs` `generate_handler!`.
- `src/dashboard/mod.rs` + `pub mod dashboard;` in `src/lib.rs`.
- TS↔Rust parity tests (golden vectors for token format, revocation, expiry,
  route resolution).

### Out-of-scope (keep TS)

- `packages/dashboard/src/auth/basic.ts` and `auth/oidc.ts` provider shells —
  keep TS; Rust hooks can be added later (argon2/bcrypt, JWKS).
- `packages/dashboard/src/auth/provider.ts` interfaces — TS contracts stay;
  Rust mirrors are IPC projections.
- `web/src/lib/dashboard-handlers.ts`, `dashboard-router.ts`,
  `dashboard-local.ts` — the bulk of the local REST surface lives here; it is
  outside this package and must be its own (later) plan. This plan only
  ensures the package's auth/status pieces can be served by Rust.
- `src/api_server/mod.rs` refactor — reuse its pattern, do not rewrite it in
  this plan (out of scope unless it becomes the shared dashboard HTTP host;
  see §5 note).
- Any new external crate (single-crate rule from AGENTS.md).

## 4. Current contract

Exports (`src/index.ts`): `router.js`, `auth/index.js` (`provider`,
`crypto`, `session-store`, `basic`, `token`, `oidc`), `routes/index.js`
(`auth`, `status`). Package.json also exposes `./auth` and `./routes`
subpaths.

Key invariants (verified by reading the code):

- `DashboardRequestContext { path, method, body, headers }`; handler returns
  JSON-serializable value or a `{ok:false,status:404,...}` shape from
  `router.handle`.
- Router matching: exact map key `"METHOD path"`, prefix matching only when
  path equals or starts with `entryPath + "/"`; `register/registerPrefix/
  unregister/clear/routes`.
- `createInMemorySessionStore`: secret = `options.secret ?? randomHex(32)`;
  session id = `input.id ?? input.sub ?? randomHex(16)`; accessToken =
  `` `${id}.${await sign(id)}` ``; sign = HMAC-SHA256 hex of session id under
  secret; verify splits on first `.`, checks revocation, compares signature,
  checks `expiresAt`; principal scopes default `["dashboard"]`.
- `TokenAuthProvider`: default `extractPrincipal` returns
  `{sub:"service"}` iff `token.startsWith(secret)`.
- `BasicAuthProvider`: `completePasswordLogin` looks up `users[username]`
  hash, calls injected `verifyPassword`, then creates a session with
  `sub: basic:<username>`.
- `OidcAuthProvider`: builds `/authorize` URL with response_type=id_token,
  scope `openid email profile`, deterministic `oidc-state`/`oidc-nonce`
  (tests), `completeLogin` calls injected `verifyIdToken`, session id/sub
  `oidc:<claims.sub>`.
- Auth routes: `/api/auth/providers`, `/api/auth/me`,
  `POST /api/auth/password-login`, `POST /api/auth/token-login`,
  `POST /api/auth/logout`, `POST /api/auth/refresh`.
- Status routes: `/api/status` (`{ok, platform:"desktop", version,
  connection_mode}`), `/api/health` (`{ok:true}`), `/api/version`
  (`{version, platform:"desktop"}`).

Consumers:

- `web/src/lib/dashboard-handlers.ts` (line 21): imports `BasicAuthProvider,
  TokenAuthProvider, createInMemorySessionStore, createAuthRoutes,
  DashboardRouter` and wires them into the web's registry
  (`dashboard-router.ts`) — the two routers are *separate* implementations;
  the web registry adds `stripQuery` and a `localOnly` fallback registry not
  present in the package router.
- `docs/typescript-runtime.md`: `web` consumes `dashboard`; package is
  "consumed by the web app".
- No other workspace consumes `@hermes/dashboard` (verified by grep).

Rust already in place (established patterns to reuse):

- `src/commands/dashboard_local.rs` — `dashboard_local_status`,
  `dashboard_local_env` (status/env local-first commands; `/api/status`-like
  payload).
- `src/commands/dashboard_api.rs` — local-first REST summary commands
  (mcp-servers, active profile, memory provider, oauth providers) parsing
  `config.yaml` via `serde_yaml`.
- `src/commands/api_proxy.rs` — `api_request`/`external_request` with SSRF
  guards, auth-header injection, 401 refresh-once retry; owns the
  packaged-mode HTTP boundary.
- `src/commands/gateway.rs` — `get_runtime_config` / `refresh_gateway_url`
  (token lifecycle already Rust-side).
- `src/api_server/mod.rs` + `src/subscription_proxy/mod.rs` — loopback hyper
  server pattern (127.0.0.1, preferred port + port-0 fallback, `Notify`
  cancel, handle in `AppState`).
- `src/state_db.rs` — SQLite+FTS5 with WAL conventions (candidate for
  persisted dashboard sessions).
- `sha2` is already in `Cargo.toml`; `hmac` crate would need to be added
  (or use `ed25519-dalek`-adjacent primitives — but HMAC-SHA256 is the
  compatibility requirement with the TS token format).

## 5. Rust design

Module layout (single crate `hermes_agent_cn`):

```
src/dashboard/mod.rs       // pub mod session; pub mod token; pub mod router; pub mod routes;
src/dashboard/session.rs   // HMAC session store (sign/verify/revoke/expiry)
src/dashboard/token.rs     // TokenAuthProvider port (opaque bearer check)
src/dashboard/router.rs    // exact+prefix route table + handler trait (end-state service basis)
src/dashboard/routes.rs    // status/health/version + auth route handlers
src/commands/dashboard_auth.rs // #[tauri::command] wrappers
tests/dashboard_auth.rs    // repo-root integration tests
tests/dashboard_router.rs
```

Public API sketch (serde `camelCase`):

```rust
// session.rs
pub struct Session {
    pub id: String,
    pub display_name: Option<String>,
    pub email: Option<String>,
    pub access_token: String,   // "<id>.<hmac_hex>"
    pub refresh_token: Option<String>,
    pub expires_at: Option<i64>, // epoch ms
}

pub struct TokenPrincipal { pub sub: String, pub scopes: Vec<String> }

pub struct InMemorySessionStore { /* secret: SecretBytes, sessions: HashMap, revoked: HashSet */ }
impl InMemorySessionStore {
    pub fn new(secret: Option<&str>) -> Self; // random 32-byte hex when None
    pub fn create_session(&mut self, input: CreateSessionInput) -> Result<Session>;
    pub fn get_session(&self, session_id: &str) -> Option<&Session>;
    pub fn verify_access_token(&self, token: &str, now_ms: i64) -> Option<TokenPrincipal>; // constant-time HMAC
    pub fn revoke_session(&mut self, session_id: &str);
    pub fn sign(&self, session_id: &str) -> String; // hex HMAC-SHA256
}

pub fn hmac_sha256_hex(message: &str, secret: &[u8]) -> String; // parity with TS crypto.ts
pub fn random_hex(bytes: usize) -> String;                      // getrandom

// token.rs
pub fn verify_opaque_token(token: &str, secret: &str) -> Option<TokenPrincipal>;
// default: token.starts_with(secret) → { sub: "service" }

// router.rs (end-state basis)
pub struct RequestContext { pub path: String, pub method: String, pub body: serde_json::Value, pub headers: HashMap<String,String> }
pub trait Handler: Send + Sync { fn handle(&self, ctx: RequestContext) -> Result<serde_json::Value, HandlerError>; }
pub struct DashboardRouter { /* exact: HashMap<(Method,String), Box<dyn Handler>>, prefix: Vec<...> */ }
impl DashboardRouter {
    pub fn register(...); pub fn register_prefix(...); pub fn resolve(...); pub fn handle(...);
}

// routes.rs
pub fn register_status_routes(router: &mut DashboardRouter, opts: StatusOpts); // /api/status /api/health /api/version
pub fn register_auth_routes(router: &mut DashboardRouter, store: &InMemorySessionStore, providers: &[ProviderRef]); // parity with routes/auth.ts
```

State handling notes:

- Secret storage: `AppStateInner` already holds `session_token`; add a
  `dashboard_session_secret: Option<String>` populated from env/config at
  startup (e.g. `HERMES_DESKTOP_SESSION_SECRET` or a value in
  `$HERMES_HOME`), else random-per-process. All commands access it via
  `tauri::State`.
- Persistence: v1 keep sessions in-memory in Rust (parity with TS); the
  `src/state_db.rs` `sessions` table is for *agent* sessions, not auth
  sessions — do not mix them. If durable auth sessions become needed, add a
  `dashboard_auth_sessions` table under the same conventions (future phase).
- HMAC: add `hmac = "0.12"` (matches `sha2 = "0.10"` line; both are
  RustCrypto) — do not hand-roll; use `subtle::ConstantTimeEq` for the
  signature comparison and token comparison.
- Router handlers: keep pure (no I/O) exactly like TS so they are
  unit-testable; route handlers that need OS work (file reads) call the
  existing Rust commands internally (same layering as
  `dashboard-handlers.ts`).

## 6. IPC / boundary

Two shapes, same recommendation order as the gateway plan:

- **(a) Narrow Tauri commands (recommended phase A).**
  `src/commands/dashboard_auth.rs` exposes
  `dashboard_session_create(input) -> Session`,
  `dashboard_session_verify(token) -> Option<TokenPrincipal>`,
  `dashboard_session_revoke(session_id)`,
  `dashboard_token_verify(token) -> Option<TokenPrincipal>`.
  TS shim (`web/src/lib/` next to `tauri-bridge.ts`) selects Rust when
  `hermesDesktop`/Tauri is present and the TS implementation when
  `runtime.isLocalOnly()` (browser-only dev). `dashboard-handlers.ts`
  currently constructs the TS store directly; it would instead call the shim
  factory, keeping the same `DashboardSessionStore`-shaped API.
- **(b) Pure-Rust local HTTP/gateway service (end-state).** In packaged mode
  the webview already talks to Rust via IPC proxy (`api_request`) — and the
  webview cannot be trusted to hold secrets. The right end-state is a Rust
  loopback hyper service on 127.0.0.1 (like `src/api_server/` +
  `src/subscription_proxy/`) that owns: auth session verify, token gate,
  `/api/status|health|version`, and the existing `api_request` proxy
  intercepts. The webview keeps `transport.ts` (native IPC vs fetch), and
  `run.py` keeps the TS runtime entirely. This is a **later phase** because
  it requires migrating `web/src/lib/dashboard-handlers.ts` route families
  and the `dashboard-local.ts` OS-backed handlers (out of scope here) — the
  package-level auth/status routes are the first candidates to serve from
  Rust.

Browser-only fallback rule (both plans): **any route/command moved to Rust
must keep a TS twin selected only when no Tauri runtime is present; never
break `run.py`.**

## 7. Implementation phases

Ordered, each shippable + testable:

1. **P0 — Parity harness.** Golden vectors for `hmac` hex, token format
   (`id.signature`), `randomHex` shape, revoke/expiry decisions, and router
   resolution (exact/prefix/query-strip behavior as defined by
   `dashboard-router.ts` — note the package router does *not* strip query;
   the web router does; pin both). Vitest snapshots the TS outputs.
2. **P1 — `src/dashboard/session.rs` + `token.rs` + commands.** Port
   `crypto.ts` + `session-store.ts` + `TokenAuthProvider` with
   `#[cfg(test)]` unit tests mirroring `auth/crypto.test.ts` (21),
   `auth/session-store.test.ts` (19), `auth/token.test.ts` (10),
   `__tests__/session-store.test.ts` (4). Add `dashboard_auth` commands and
   TS shim. No behavior change; shim defaults to TS until Tauri presence.
3. **P2 — `src/dashboard/router.rs` + `routes.rs`.** Port router +
   status/auth routes as pure Rust; unit tests mirroring
   `router.test.ts` (14), `routes/status.test.ts` (6), `routes/auth.test.ts`
   (16), `__tests__/router.test.ts` (5), `__tests__/auth-routes.test.ts`
   (6). Wire `/api/status|health|version` and auth routes to serve through
   the existing `api_request` intercept machinery (add intercepts in
   `api_proxy.rs` that call `src/dashboard/` handlers before proxying), or
   through a new `dashboard_http_serve` command if the service route is
   chosen. TS remains authoritative for browser-only.
4. **P3 — Web shim adoption.** Point `dashboard-handlers.ts` at the shim
   factory for session store + auth routes; keep `BasicAuthProvider`/
   `OidcAuthProvider` TS-side but have them call the Rust-backed
   `DashboardSessionStore` (they only need `createSession`/`verify`/
   `revoke`). Add vitest for the shim boundary with a fake `invoke`.
5. **P4 (end-state, larger) — pure-Rust local dashboard service.** Fold
   `src/api_server/` + `src/subscription_proxy/` + `src/dashboard/` into one
   loopback hyper service (or extend `api_server`) that owns auth/status/
   proxy; migrate `web/src/lib/dashboard-handlers.ts` route families and
   `dashboard-local.ts` OS-backed handlers route-by-route. Explicitly gated
   to Tauri mode; `run.py` untouched. This is the "pure-Rust local
   HTTP/gateway service" end-state the task asks about — yes, it is the right
   end-state for packaged mode, but only after P1–P3 prove the auth core in
   Rust. Keep `api_request` IPC as the transport seam until then.

## 8. Testing strategy

- **Rust unit tests**: inline `#[cfg(test)]` per AGENTS.md; cover HMAC hex
  parity, token format, constant-time verify, revocation, expiry, router
  exact/prefix/404, status/version payloads, auth route bodies
  (providers/me/password-login/token-login/logout/refresh).
- **Rust integration tests**: repo-root `tests/dashboard_auth.rs`,
  `tests/dashboard_router.rs` using only `pub` API via crate
  `hermes_agent_cn`; `tempfile::TempDir` for any file-touching case; no real
  network; `#[serial_test::serial]` for env-dependent cases.
- **TS↔Rust parity**: shared golden JSON for token bytes, session decisions,
  router resolutions; vitest asserts TS outputs, Rust tests assert the same
  goldens. Token format and HMAC output are the load-bearing invariants.
- **Shim boundary test**: vitest with a fake `invoke` returning canned Rust
  results + a no-Tauri environment asserting the TS fallback is selected.
- **Existing suites stay green**: `pnpm test:unit`, `pnpm typecheck`,
  `cargo test --all-features`, `cargo fmt --check`, `cargo clippy -D
  warnings` (CI gates per AGENTS.md).

## 9. Risks & mitigations

- **Secret handling.** Moving the secret into Rust must not regress
  `session-store.ts`'s "stable across restarts" contract: define where the
  secret lives (env/config/AppState), document that omitting it yields a
  random per-process secret exactly like TS, and never log it.
- **Token format drift.** `id.signature` HMAC-SHA256 hex must match Web
  Crypto output byte-for-byte. Mitigate with golden vectors + CI diff; use
  `hmac` crate, not a hand-rolled implementation.
- **Web-side duplication.** `packages/dashboard/src/router.ts` and
  `web/src/lib/dashboard-router.ts` are different implementations; a Rust
  router must not accidentally mix their semantics (query-strip, localOnly).
  Pin behavior in P0 goldens for *both*.
- **Basic/OIDC provider layering.** If P3 makes providers call a Rust-backed
  session store, keep the injected-verify pattern intact so TS tests and
  browser-only mode still run headless without Rust.
- **Scope creep into `web/src/lib`.** The full local REST surface is large;
  resist folding it into this package plan. Track it as P4 (separate
  follow-up plan) so this plan stays shippable.
- **Crate size / build time.** New modules are small; stay in the single
  crate per AGENTS.md. Only new dependency: `hmac` (+ `subtle`), both
  already in the RustCrypto ecosystem.

## 10. Effort estimate (S/M/L per phase)

- P0 Parity harness: **S** (half-day to 1 day).
- P1 session.rs + token.rs + commands + shim: **M** (2–4 days; security
  review + parity tests).
- P2 router.rs + routes.rs (+ `api_proxy` intercepts): **M** (2–4 days).
- P3 Web shim adoption (handlers → shim): **M** (1–3 days).
- P4 Pure-Rust local dashboard service: **L** (2–4 weeks; covers
  `web/src/lib/dashboard-handlers.ts` + `dashboard-local.ts` migration,
  transport seam, packaged-mode QA) — do not start until P1–P3 land and a
  product owner confirms the end-state.

Total: **M for the security core (P0–P3 ≈ 6–12 dev-days); L for the full
pure-Rust HTTP service end-state.**

Cross-references: the gateway-core plan
(`plans/rust-rewrite-gateway-core.md`) proposes `src/gateway/` with the same
dual-path shim rule, parity-golden testing, and `src/state_db.rs` reuse. The
two service layers should share a common `RuntimeBackend` selection (Tauri →
Rust, browser-only → TS) and, at the end-state, one loopback HTTP host so
auth (dashboard) and gateway (delivery/session) state live in the same Rust
process.
