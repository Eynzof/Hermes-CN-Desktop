# Plan: Rewrite gateway-core from TypeScript to Rust (`src/`)

- Status: Draft
- Source: `packages/gateway-core/src/...` (7 files, ~616 source lines + 6 vitest files, 70 test cases)
- Target Rust: `src/gateway/` (+ `src/commands/gateway_core.rs`)
- Author: analysis subagent
- Date: 2026-08-24

## 1. Executive summary

`packages/gateway-core` is the parity layer mirroring the Python `gateway/`
package: an adapter contract, an in-memory event bus, a session key builder +
LRU/TTL session store, an at-least-once delivery ledger, a slash-command
registry, and a `GatewayService` orchestrator. Today it is **test-complete but
not yet wired into the web runtime**: the in-process web gateway
(`web/src/lib/gateway-inprocess.ts`) implements the JSON-RPC `GatewayTransport`
directly against `local-agent.ts`, and the only real consumer of
`gateway-core` is `packages/messaging-platforms` (29 adapters), which imports
**types only** (`PlatformAdapter`, `InboundMessageEvent`, `OutboundContent`,
`SendMeta`, `SendResult`, `PlatformStatus`).

A rewrite is therefore **not a wholesale port**. The honest recommendation:

- **Move to Rust (high value):** the session store / key builder / multiplexer
  routing (`session.ts`) and the delivery ledger (`delivery.ts`). The delivery
  ledger's own docblock already states "the Rust-side SQLite durability layer
  is stubbed but the schema and lifecycle hooks are present" — `src/state_db.rs`
  already owns the `sessions` table and SQLite+FTS infrastructure that a
  durable ledger needs.
- **Defer / keep in TS:** the event bus (42-line `Set<Listener>` — only worth
  native `tokio::sync::broadcast` if a Rust gateway service actually owns
  connections, which is not true today), the slash registry (8 static
  handlers whose real bodies must call back into the agent runtime — TS), the
  adapter contract (a Rust serde mirror is needed for IPC, but the canonical
  TS types must stay for the 29 TS adapters), and `GatewayService`
  orchestration (no production consumer yet).
- **Shared Rust home:** new `src/gateway/` module (session/delivery/event in
  the single `hermes_agent_cn` crate), with narrow Tauri commands, mirroring
  the established pattern of `src/state_db.rs` + `src/commands/state_db.rs`
  and `src/subscription_proxy/`.

The browser-only dev mode (`python run.py`) runs **no Rust at all**, so every
phase must keep the pure-TS path working or be explicitly gated on
`runtime.isLocalOnly()` / Tauri presence. This plan proposes a
**dual-path**: Rust-native session/delivery behind IPC in the Tauri shell;
unchanged TS implementation for browser-only dev.

## 2. Why rewrite (value/motivation, quantified where possible; be honest)

Strong candidates:

1. **Delivery ledger durability (delivery.ts, 103 lines).** The TS ledger is
   in-memory only (`private rows = new Map<...>`); a crash loses pending
   outbound messages. Rust already ships `rusqlite` (bundled) and
   `src/state_db.rs` establishes the schema/conventions (WAL, busy_timeout,
   `sessions` table, `state_meta`). Moving `begin/ack/fail/redeliverOnBoot/
   dedupeMedia/listForSession` onto SQLite gives real at-least-once semantics
   at the only layer that can safely own the DB (the Rust process). This is
   the strongest *functional* argument, not just a performance one.
2. **Session store hot path (session.ts, 179 lines).** Every inbound message
   calls `buildSessionKey` (string concat), `sessionIdFromKey` (31×multiply
   rolling hash), `ensure` (O(n) `getByKey` scan), LRU eviction, and 60s TTL
   sweep. At 29-platform messaging scale with per-message routing, this is the
   hottest path in the package; a Rust `HashMap<sessionKey, sessionId>` index
   plus `BinaryHeap`/LRU is deterministic, allocation-light, and testable.
   `sessionIdFromKey` is byte-identical parity with Python and must be
   replicated exactly (or moved to Rust and diffed against a golden vector).
3. **Security-relevant state moves to the privileged process.** Once session
   keys / delivery rows / dedupe state live in Rust, they can be correlated
   with `src/state_db.rs` (persistent `sessions` table) and the existing
   `api_request`/`ws_proxy` auth flows without round-tripping secrets through
   the webview.

Honest caveats (things a rewrite does NOT buy):

- **Event bus (42 lines).** A `Set<Listener>` + try/catch publish loop is not
  a bottleneck at current volumes. Native value only appears when Rust owns
  the gateway socket/adapters end-to-end (see phase C).
- **Slash registry (102 lines).** It is a static table + alias resolution +
  admin tier check. The *handlers* return canned strings today and will
  eventually need agent-core services (approve/deny, turn control). Rust
  cannot host those handlers until the agent runtime is reachable from Rust —
  keep in TS.
- **GatewayService (117 lines).** Only exercised by its own test suite; the
  web runtime uses `gateway-inprocess.ts` instead. Porting it to Rust today
  would create an unowned native twin.
- **Performance is not the primary win.** The package is small (~616 source
  lines). Do not expect order-of-magnitude latency gains at current
  in-process call volumes; the win is durability, determinism, and
  placement next to existing Rust state.

## 3. Scope

### In-scope

- `src/gateway/session.rs` — port of `buildSessionKey`,
  `sessionIdFromKey`, `SessionStore` (get/getByKey/ensure/touch/
  evictIdleSessions/LRU) and `SessionMultiplexer.route/markBusy`
  (run/queue/steer/interrupt/drop_auth/slash decisions) to Rust with serde
  types mirroring the zod schemas.
- `src/gateway/delivery.rs` — port of `DeliveryLedger` with a SQLite-backed
  store (`delivery_rows` table) reusing `src/state_db.rs` connection
  conventions; in-memory mode for tests remains an option.
- `src/gateway/event.rs` — only if phase A/B land and a native
  `tokio::sync::broadcast` bus is needed by the Rust service; otherwise
  deferred.
- `src/commands/gateway_core.rs` — narrow `#[tauri::command]` wrappers
  (`gateway_session_route`, `gateway_session_ensure`, `gateway_delivery_*`,
  etc.) registered in `main.rs` `generate_handler!`.
- TS↔Rust parity tests (vitest vs Rust unit/integration tests).
- `src/gateway/mod.rs` + `pub mod gateway;` in `src/lib.rs`.

### Out-of-scope (keep TS)

- `packages/gateway-core/src/adapter.ts` — canonical TS types for the 29
  `messaging-platforms` adapters stay; Rust mirrors are *projections* for the
  IPC boundary, not the source of truth.
- `packages/gateway-core/src/slash.ts` — registry + dispatcher stays TS;
  handlers need the agent runtime.
- `packages/gateway-core/src/gateway-service.ts` — orchestrator stays TS
  until the Rust gateway service owns a real transport.
- `packages/messaging-platforms/*` adapter implementations — out of scope;
  they are network integrations best served by TS HTTP/WS clients today.
  (Revisit when/if Rust owns the gateway process; see §5 end-state note.)
- Moving `web/src/lib/gateway-inprocess.ts` / `local-agent.ts` into Rust —
  that is the agent-runtime gateway, not this package.
- Any new external crate (single-crate rule from AGENTS.md).

## 4. Current contract

Exports (`src/index.ts`): `adapter.js`, `event-bus.js`, `session.js`,
`delivery.js`, `slash.js`, `gateway-service.js`.

Key invariants (verified by reading the code):

- Session key layout is **byte-identical to Python**:
  `agent:<profile>:<platform>:<chatType>:<chatId>[:<userId>]`
  (`buildSessionKey`, default profile `main`).
- `sessionIdFromKey` is a deterministic 31-multiplier rolling hash formatted
  as `sess_` + 12 hex digits (`(h >>> 0).toString(16).padStart(12,"0")`) —
  stable ID parity with Python gateway/session.py.
- `SessionStore`: max 128 entries; evicts oldest ~10% by `lastActiveAt`;
  idle TTL 3600_000 ms (1h); `getByKey` is O(n) scan over values.
- `SessionMultiplexer.route`: slash detection (text starts with `/`),
  `drop_auth` for non-admin, busy-mode → `interrupt`/`steer`/`queue` (default
  `queue`).
- `DeliveryLedger`: rowId `dl_<ts36>_<rand36>`; states
  pending/sending/delivered/failed; max 3 attempts; freshness 24h;
  `redeliverOnBoot` prepends `♻️ Recovered reply\n` to stale pending payloads;
  `dedupeMedia` blocks repeats of the same mediaPath per session when not
  explicit.
- `GatewayEvent` union: inbound/outbound/typing/session.start/session.end/
  error.
- Slash defaults: new, reset, status, whoami, stop, help, approve
  (adminOnly), deny (adminOnly); aliases supported; canonical-name resolution
  before handler call.

Consumers:

- `packages/messaging-platforms/src/*/adapter.ts` (29 files) — type-only
  imports of the adapter contract (`import type { PlatformAdapter,
  InboundMessageEvent, OutboundContent, SendMeta, SendResult, PlatformStatus }
  from "@hermes/gateway-core"`).
- No consumer of `GatewayService`/`EventBus`/`SessionStore`/
  `DeliveryLedger`/`SlashDispatcher` outside the package's own tests (verified
  by grep across `web/src`, `packages/agent-core`, `packages/dashboard`).
- `docs/typescript-runtime.md` documents dependency direction
  `gateway-core` ← `messaging-platforms`; `web` does not list `gateway-core`
  as a consumer.

Rust already in place (established patterns to reuse):

- `src/state_db.rs` (SQLite+FTS5; WAL; `sessions` table) + `src/commands/
  state_db.rs` (query/exec/fts commands).
- `src/commands/messaging.rs` — `get_messaging_platforms`,
  `get_messaging_status`, `set_messaging_platform_config`,
  `start_messaging_platform`, `stop_messaging_platform` (messaging control
  plane already lives in Rust; the platform adapters themselves are TS).
- `src/api_server/mod.rs` — hyper loopback server pattern (127.0.0.1,
  preferred port + port-0 fallback, `Notify` cancel, `ApiServerHandle` in
  `AppState`).
- `src/subscription_proxy/mod.rs` — same loopback pattern with an
  `UpstreamAdapter` trait.
- `src/commands/api_proxy.rs` — `api_request`/`external_request` with SSRF
  guards, auth-header injection, 401 refresh-once retry.
- `src/commands/ws_proxy.rs` — WebSocket relay to official `/api/ws`.

## 5. Rust design

Module layout (single crate `hermes_agent_cn`):

```
src/gateway/mod.rs          // pub mod session; pub mod delivery; (pub mod event;)
src/gateway/session.rs      // session keys, store, multiplexer routing
src/gateway/delivery.rs     // SQLite-backed at-least-once ledger
src/gateway/event.rs        // (deferred) broadcast bus
src/commands/gateway_core.rs// #[tauri::command] wrappers
tests/gateway_session.rs    // repo-root integration tests
tests/gateway_delivery.rs
```

Public API sketch (serde `camelCase` to match TS wire shapes):

```rust
// session.rs
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SessionSource {
    pub platform: String,
    pub chat_id: String,
    pub chat_type: String,   // "dm"|"group"|"channel"|"thread" (validated)
    pub user_id: String,
    pub thread_id: Option<String>,
    pub scope_id: Option<String>,
    pub profile: Option<String>,
}

pub struct GatewaySession { /* session_id, session_key, source fields, created_at, last_active_at, restart_interrupted */ }

pub fn build_session_key(source: &SessionSource, profile: &str) -> String; // byte parity
pub fn session_id_from_key(key: &str) -> String;                          // sess_ + 12 hex, parity golden tests

pub struct SessionStore { /* HashMap<session_id, GatewaySession>, HashMap<session_key, session_id>, LRU order, TTL */ }
impl SessionStore {
    pub fn get(&self, session_id: &str) -> Option<&GatewaySession>;
    pub fn get_by_key(&self, key: &str) -> Option<&GatewaySession>;
    pub fn ensure(&mut self, source: &SessionSource) -> GatewaySession;
    pub fn touch(&mut self, session_id: &str);
    pub fn evict_idle_sessions(&mut self, now_ms: i64) -> usize;
}

pub enum RouteAction { Run, Queue, Steer, Interrupt, DropAuth{reason:String}, Slash{command:String,args:String} }
pub struct SessionMultiplexer { /* busy_sessions: HashSet<String>, opts */ }
impl SessionMultiplexer {
    pub fn route(&mut self, event: &InboundMessageEvent, store: &mut SessionStore) -> RouteDecision;
    pub fn mark_busy(&mut self, session_id: &str, busy: bool);
}

// delivery.rs
pub struct DeliveryRow { /* row_id, session_id, platform, chat_id, payload, state, attempts, created_at, dedupe_key */ }
pub struct SqliteDeliveryStore { /* rusqlite::Connection in Arc<Mutex<>> or per-call connect like state_db.rs */ }
impl SqliteDeliveryStore {
    pub fn begin(&mut self, ...) -> Result<DeliveryRow>;
    pub fn ack(&mut self, row_id: &str) -> Result<()>;
    pub fn fail(&mut self, row_id: &str, error: Option<&str>) -> Result<()>;
    pub fn redeliver_on_boot(&mut self) -> Result<Vec<DeliveryRow>>; // ♻️ Recovered reply prefix parity
    pub fn dedupe_media(&self, session_id: &str, path: &str, explicit: bool) -> Result<bool>;
    pub fn list_for_session(&self, session_id: &str) -> Result<Vec<DeliveryRow>>;
}
```

State handling notes:

- **Concurrency.** `AppState` is `Mutex<AppStateInner>`; session store and
  delivery store should be owned by the Rust side (`gateway: GatewayState` in
  `AppStateInner`) and accessed from commands via `tauri::State`, matching
  `subscription_proxy`/`state_db` conventions. Prefer `parking_lot`-style
  short locks or `tokio::sync::Mutex` for async command bodies; keep
  synchronous pure functions lock-free where possible.
- **SQLite.** Reuse the `connect(hermes_home)` pattern from `src/state_db.rs`
  (WAL, busy_timeout, `db_path` under `$HERMES_HOME`). Add a
  `delivery_rows` table with indexes on `(session_id)`, `(state, created_at)`
  and a `dedupe_key` unique-ish query. Keep the TS in-memory ledger as the
  browser-only fallback; Rust SQLite is the packaged-mode store.
- **Parity hashing.** `session_id_from_key` must be frozen with golden
  vectors (see §8) so TS and Rust cannot drift.

## 6. IPC / boundary

Two viable shapes; this plan recommends **commands-first (a)** with (b) as the
long-term end-state:

- **(a) Narrow Tauri commands (recommended for phases A/B).**
  `src/commands/gateway_core.rs` exposes e.g.
  `gateway_session_route(event: InboundMessageEventInput) -> RouteDecision`,
  `gateway_session_ensure(source) -> GatewaySession`,
  `gateway_delivery_begin(...)`, `gateway_delivery_ack(...)`,
  `gateway_delivery_redeliver_on_boot()`. Wire them into
  `main.rs` `generate_handler!`. TS keeps the same function signatures via a
  thin `packages/gateway-core` shim that selects:
  - Tauri/desktop mode → `invoke("gateway_*")`
  - browser-only dev (`runtime.isLocalOnly()` / no Tauri) → the existing
    pure-TS implementation (unchanged).
  This preserves the CRITICAL constraint that `python run.py` works with zero
  Rust. The shim can live in `web/src/lib/` (like `tauri-bridge.ts`) or in
  `packages/gateway-core` behind a `transport` interface; prefer
  `web/src/lib` so the headless package stays pure for vitest.
- **(b) Pure-Rust local gateway service (end-state, not this plan's phase A).**
  Following `src/api_server/mod.rs` + `src/subscription_proxy/mod.rs`, a
  loopback hyper service on 127.0.0.1 could own the gateway event loop /
  session / delivery. This is only justified when messaging adapters (or the
  JSON-RPC gateway) run in Rust; until then a local socket adds a hop with no
  consumer. Keep (a) so the seam is ready.

Browser-only fallback rule (both plans): **any route/command moved to Rust
must keep a TS twin that is selected only when no Tauri runtime is present;
never break `run.py`.**

## 7. Implementation phases

Ordered, each shippable + testable:

1. **P0 — Parity harness.** Create golden vectors for `buildSessionKey` /
   `sessionIdFromKey` (include Python parity cases from `session.test.ts`).
   Add a vitest "golden snapshot" that TS still produces the same values.
   *Exit: golden JSON committed, no behavior change.*
2. **P1 — `src/gateway/session.rs`.** Port key builder, store, multiplexer
   routing with `#[cfg(test)]` unit tests mirroring `session.test.ts`
   (8 tests) + integration tests in `tests/gateway_session.rs`. Add
   `gateway_session_*` commands. Ship with TS shim (no TS behavior change;
   shim defaults to TS until a feature flag/`hermesDesktop` presence enables
   Rust).
3. **P2 — `src/gateway/delivery.rs` + SQLite store.** Port ledger with
   `delivery_rows` table; unit tests mirroring `delivery.test.ts` (19 tests);
   integration tests with `tempfile::TempDir` (AGENTS.md: never `/tmp`/cwd);
   commands `gateway_delivery_*`. Keep TS ledger for browser-only.
4. **P3 — Wire into `GatewayService` (TS) behind a switch.** When running in
   Tauri, `gateway-service.ts` uses the Rust-backed session/delivery through
   the shim; browser-only keeps the in-memory path. `gateway-service.test.ts`
   still passes unmodified (they run headless, so they exercise the TS path —
   add a Rust-backed vitest that mocks the shim's invoke boundary).
5. **P4 (optional/deferred) — `src/gateway/event.rs`** broadcast bus, only if
   a Rust transport owner appears (see §5 end-state). Not shippable without a
   consumer; otherwise document as future work.

## 8. Testing strategy

- **Rust unit tests**: inline `#[cfg(test)] mod tests` per AGENTS.md; cover
  key parity (golden vectors), LRU eviction, TTL sweep, busy-mode routing,
  slash detection, admin drop, delivery ack/fail/redeliver/dedupe.
- **Rust integration tests**: repo-root `tests/gateway_session.rs`,
  `tests/gateway_delivery.rs` using only `pub` API via crate name
  `hermes_agent_cn`; SQLite tests use `tempfile::TempDir`; no real network;
  no `/tmp` or cwd writes. Env-dependent tests marked `#[serial_test::serial]`.
- **TS↔Rust parity**: shared golden JSON (keys, session IDs, route decisions,
  row states after each ledger op). Vitest runs the TS implementation and
  asserts identical outputs; Rust unit/integration tests assert the same
  golden file. This is the load-bearing parity gate — especially for
  `sessionIdFromKey` and `redeliverOnBoot`'s `♻️ Recovered reply` prefix.
- **Shim boundary test**: vitest with a fake `invoke`/`hermesDesktop` that
  returns canned Rust results, proving the TS shim routes correctly and the
  browser-only fallback is selected when Tauri is absent.
- **Existing suites must stay green**: `pnpm test:unit` (all workspaces),
  `pnpm typecheck`, `cargo test --all-features`, `cargo fmt --check`,
  `cargo clippy -D warnings` (CI gates per AGENTS.md).

## 9. Risks & mitigations

- **Parity drift in session IDs.** The 31-multiplier hash and key layout must
  match Python exactly. Mitigate with frozen golden vectors + CI-diff both
  sides.
- **SQLite in the webview-internal flow.** State DB is owned by Rust; a
  concurrent TS in-memory ledger in browser mode can diverge in tests.
  Mitigate by making the store an explicit injectable backend and never
  running both for the same logical service.
- **O(n) semantics change.** `getByKey` is O(n) in TS; Rust adds an index.
  That is a *fix*, but it can change eviction order (Map insertion order vs
  explicit LRU). Pin exact eviction semantics with tests before release.
- **No production consumer yet.** Porting an unowned service wastes effort.
  Mitigate by gating phases on a real consumer (messaging adapters wiring
  through `GatewayService`, or a Rust gateway socket owner). P0–P2 are cheap
  and safe; P4 must not start without a consumer.
- **Browser-only regression.** Any command shim must fall back to TS when
  `hermesDesktop`/Tauri is absent; add a vitest that runs the full
  `gateway-service.test.ts` under the browser-only selection.
- **Crate size / build time.** New module is small; keep it in the existing
  crate per AGENTS.md. No new external crate.

## 10. Effort estimate (S/M/L per phase)

- P0 Parity harness: **S** (half-day to 1 day; golden vectors + vitest).
- P1 `src/gateway/session.rs` + commands + shim: **M** (2–4 days; careful
  parity + eviction semantics + IPC tests).
- P2 `src/gateway/delivery.rs` + SQLite: **M** (2–4 days; SQLite schema,
  migration of state_db conventions, TempDir integration tests).
- P3 GatewayService switch + boundary tests: **M** (1–3 days).
- P4 event.rs broadcast bus: **L if attempted now** (no consumer — do not
  start without one; otherwise S to sketch).

Total: **S–M for the honest, consumer-gated subset (P0–P3 ≈ 6–12 dev-days)**.

Cross-references: the dashboard plan (`plans/rust-rewrite-dashboard.md`)
proposes a sibling `src/dashboard/` home and the same dual-path IPC strategy;
the two should share `src/state_db.rs` conventions, the parity-golden test
pattern, and a common `RuntimeBackend` shim selection rule for
browser-only dev.
