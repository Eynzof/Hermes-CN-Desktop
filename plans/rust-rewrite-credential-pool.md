# Plan: Rewrite credential-pool (selected pieces) from TypeScript to Rust (`src/`)

- Status: Draft
- Source: `packages/credential-pool/src/...`
- Target Rust: `src/credentials/...`
- Author: analysis subagent
- Date: 2026-08-24

## 1. Executive summary

`packages/credential-pool` (measured 9 TS files incl. `test/`, ~22 KB total;
~5 KB non-test source) is a standalone credential pool with rotation
strategies. It is **pure logic with no IO and no consumers today**: grep of
`packages/` and `web/` shows nothing imports `@hermes/credential-pool`
outside the package itself (only `package.json` and its own `src/` + `test/`
reference it). That single fact shapes the honest recommendation: this is a
**low-urgency rewrite** whose value is foundation work (single source of
truth, testability, and a security boundary for future consumers), not an
immediate hot-path or security fix.

Recommended Rust scope (priority order):

1. **Rotation strategies + pool core (`src/strategies.ts` ~0.9 KB,
   `src/pool.ts` ~2.6 KB)** — pure, deterministic selection/rotation logic
   (`fill_first`, `round_robin`, `least_used`, `random`; exhaustion + TTL
   bookkeeping). Port to `src/credentials/` as the authoritative
   implementation with TS keeping a mirror for browser-only dev. The real
   value is parity + single-source-of-truth and making the logic available to
   Rust-side commands (e.g. future `credential_pool_*` IPC) without a TS round
   trip.
2. **Secret storage / vault (`PooledCredential.access_token` etc. currently
   live as plain strings in webview memory)** — security-sensitive, and the
   strongest *future* Rust value: a Rust-owned credential vault in
   `AppStateInner` keeps secrets out of the webview JS heap (XSS/blast-radius
   reduction) and, optionally, at-rest protection (OS keychain / encrypted
   file). This is where a genuine security win exists — but it is **only
   justified once there are real consumers** (no callers today), so the plan
   stages it as P2 behind the pure-logic port and explicitly gated on consumer
   adoption.
3. **Constants / types (`constants.ts`, `types.ts`)** — trivial data; mirror
   as Rust consts/serde structs as part of P1, not standalone work.

Explicitly out of scope: the lease API (`acquireLease`/`releaseLease` are
documented no-op stubs — if the pool moves to Rust they become real
Mutex-based leases, a small bonus, not a separate rewrite); any platform
credential-gate integration (that lives in `agent-tools/src/gates.ts` and is
TS).

Cross-cutting note: the `@hermes/credential-pool` package is currently
**disconnected** — no consumer wires it into the agent loop, messaging
platforms, or the web app. The plan therefore recommends treating the Rust
`src/credentials/` module as shared infrastructure for *future* Rust
commands (`egress_proxy`, `subscription_proxy`, `api_proxy` already deal with
bearer credentials — see `UpstreamCredential` in
`src/subscription_proxy/mod.rs:33-38`) and as the canonical home the TS
package should ultimately call through IPC.

## 2. Why rewrite (value/motivation, quantified where possible; be honest)

- **Rotation logic (real but tiny; parity > performance).**
  - `strategies.ts` (22 lines) + `pool.ts` (76 lines) are pure, deterministic
    functions over `PooledCredential[]`: availability filtering, four
    strategies, request-count bookkeeping, exhaustion with TTL constants
    (401 → 5 min, 429/billing/rate-limit → 1 h, sole credential → 60 s),
    `nextAvailableAt`. There is no hot path today — the package has no
    consumers — so CPU value is ~zero. The value is:
    - **Single source of truth**: Rust unit tests can lock the semantics
      against the TS tests (the vitest suite already contains “plan parity”
      comments, e.g. `pool.test.ts:33`, `constants.test.ts:14`), and future
      Rust commands that need to pick/rotate a credential (`egress_proxy`,
      `subscription_proxy`, `api_proxy` bearer injection) get the logic
      natively without a TS round trip.
    - **Concurrency correctness**: the TS pool is single-threaded JS; a Rust
      `Mutex<CredentialPool>` in `AppStateInner` gives the same guarantees
      with an explicit lock and makes the no-op lease API implementable for
      real.
  - Honest caveat: porting 98 lines of logic is trivial; the *maintenance
    surface* is the parity tests, not the code.
- **Secret storage (strong security rationale, but speculative until
  consumed).**
  - Today `PooledCredential.access_token` / `refresh_token` are plain `string`
    fields in a TS in-memory object; any webview JS (including XSS / a
    compromised tool handler) can read them, and any code that serializes a
    pool entry (logging, JSON.stringify in `resultToToolResult`-style paths)
    can leak them.
  - A Rust vault keeps tokens in the Rust process, exposes only
    IDs/cursors/status over IPC, and can optionally persist at rest with OS
    keychain (Windows DPAPI / macOS Keychain via the `keyring` crate) or an
    encrypted file using existing deps (sha2/base64 — note: real at-rest
    encryption would need a proper AEAD crate, so keyring is the pragmatic
    option).
  - Honest caveat: **there are zero consumers today**, so the vault is
    infrastructure without a user-visible payoff until `agent-core`,
    messaging adapters, or the egress/subscription proxies actually store
    credentials through it. The plan gates P2 on that adoption and starts
    with an in-memory vault (no new crate) so the security boundary exists
    even before keyring is added.
- **Constants/types:** no value standalone; mirror as Rust consts for parity
  (TTL_401=300_000, TTL_429=3_600_000, TTL_DEFAULT=3_600_000, TTL_SOLE=60_000,
  PRUNE_DEAD_MS=86_400_000, DEFAULT_MAX_CONCURRENT=1, four strategy names).
- **Everything else:** no value — no consumers, no hot path, no security
  boundary that pure TS logic can improve on its own.

## 3. Scope (in-scope / out-of-scope)

### In-scope (Rust rewrite / mirror)
| TS module | Rust target | What moves |
|---|---|---|
| `src/strategies.ts` | `src/credentials/strategies.rs` | `select_credential(entries, strategy, cursor)` — availability filter + fill_first/round_robin/least_used/random |
| `src/pool.ts` | `src/credentials/pool.rs` | `CredentialPool` — `select` (cursor + request_count), `mark_exhausted_and_rotate`, `entries`, `has_available`, `next_available_at`, `compute_ttl`, lease stubs → real `Mutex`-backed leases |
| `src/constants.ts` | `src/credentials/constants.rs` | TTL / prune / concurrency consts |
| `src/types.ts` | `src/credentials/types.rs` | serde mirrors of `PooledCredential`, `AuthType`, `RotationStrategy`, `ErrorContext`, `FailureReason` |
| `src/credentials/vault.rs` (NEW) | AppState-held secret store | Rust-owned storage of `access_token`/`refresh_token`; P2, gated on consumers |

### Out-of-scope (stay TS; reasons)
- `src/index.ts` — trivial re-export; keep as the TS facade.
- `src/types.ts` runtime behavior — TS types stay for the TS mirror; only
  serde mirrors are added in Rust.
- `test/pool.test.ts` + `src/*.test.ts` — vitest suites stay as the TS
  baseline and become parity fixtures.
- Credential gates (`agent-tools/src/gates.ts` `credentialGates`) — TS
  env-gating used by tool registration; unrelated to pool logic.
- Platform credential provisioning / OAuth flows — messaging-platforms
  adapters own those; out of scope.
- New external crate for at-rest encryption — **avoided unless strongly
  justified**: P2 starts with in-memory vault + (optionally) `keyring` crate
  only when OS-keychain persistence is required by a real consumer; an AEAD
  encryption crate would need a separate justification per AGENTS.md.

## 4. Current contract (TS exports, types, consumers, invariants)

### Entry point
- `packages/credential-pool/src/index.ts` re-exports `types`, `constants`,
  `strategies`, and `CredentialPool` from `pool.ts`.
- `package.json`: `@hermes/credential-pool`, `main/types = ./src/index.ts`,
  no runtime dependencies (only `@types/node`, `typescript`, `vitest` as
  devDeps).

### Exports and consumers (verified)
| Export | Consumers |
|---|---|
| `selectCredential(entries, strategy, roundRobinCursor?)` | own `strategies.test.ts` only |
| `CredentialPool` (select / markExhaustedAndRotate / acquireLease / releaseLease / entriesList / hasAvailable / nextAvailableAt) | own `pool.test.ts` + `test/pool.test.ts` only |
| `TTL_401`, `TTL_429`, `TTL_DEFAULT`, `TTL_SOLE`, `PRUNE_DEAD_MS`, `DEFAULT_MAX_CONCURRENT`, `STRATEGIES` | own `constants.test.ts` only |
| `PooledCredential`, `AuthType`, `RotationStrategy`, `ErrorContext`, `FailureReason` | own files + tests only |
| `@hermes/credential-pool` package | **no consumer** in `packages/` or `web/` (grep-verified) |

### Invariants (locked by vitest, must hold in Rust parity)
1. `selectCredential` never returns `exhausted`/`dead` entries; returns `null`
   when no entry is available.
2. `fill_first` and `least_used` pick min `request_count`, first on ties.
3. `round_robin` indexes `cursor % available.len()` over the **filtered**
   (available-only) list.
4. `random` uses uniform selection over available entries.
5. Unknown strategy falls back to first available (TS behavior; Rust should
   match unless intentionally changed).
6. `CredentialPool.select()` increments the picked entry's `request_count`
   and advances the cursor.
7. `markExhaustedAndRotate` marks the target (or first available when id
   omitted) as `exhausted`, records `last_status_at`/`last_error_code`/
   `last_error_reason`, sets `last_error_reset_at = now + TTL_SOLE` only for
   the sole-credential case, and returns the next selected entry (may be
   `null`).
8. `hasAvailable` reflects non-exhausted/non-dead entries; `nextAvailableAt`
   is the min `last_error_reset_at` among entries that have one, else `null`.
9. Constants ordering: `TTL_SOLE (60 s) < TTL_401 (5 min) < TTL_429 (1 h) =
   TTL_DEFAULT`.
10. The pool is single-threaded in TS; Rust adds an explicit
    `Mutex`/`RwLock` boundary — observable only via reduced race risk.

## 5. Rust design (module layout, public API, serde types, state handling)

### Module layout (single crate; add module to `src/lib.rs`)
```
src/
├── lib.rs                     # add: pub mod credentials;
└── credentials/
    ├── mod.rs                 # pub use strategies::*; pub use pool::*; pub use types::*;
    ├── types.rs               # serde mirrors (camelCase to match TS field names)
    ├── constants.rs           # TTL / prune / strategy consts
    ├── strategies.rs          # select_credential (pure, sync)
    ├── pool.rs                # CredentialPool (Mutex-backed, pure selection core)
    └── vault.rs               # (P2) secret store; AppState-held; optional keyring
```
`src/commands/` gains thin `#[tauri::command]` wrappers only when a consumer
appears (P1 can ship module + unit tests without IPC; P2 adds commands).

### Public Rust API
```rust
// src/credentials/types.rs
#[derive(Debug, Clone, Serialize, Deserialize)] #[serde(rename_all = "camelCase")]
pub struct PooledCredential {
    pub provider: String, pub id: String, pub label: String,
    pub auth_type: AuthType, pub priority: i64, pub source: String,
    pub access_token: String, pub refresh_token: Option<String>,
    pub last_status: Option<LastStatus>, pub last_status_at: Option<i64>,
    pub last_error_code: Option<i64>, pub last_error_reason: Option<FailureReason>,
    pub last_error_message: Option<String>, pub last_error_reset_at: Option<i64>,
    pub base_url: Option<String>, pub expires_at: Option<String>,
    pub expires_at_ms: Option<i64>, pub last_refresh: Option<String>,
    pub inference_base_url: Option<String>, pub agent_key: Option<String>,
    pub request_count: u64, pub extra: serde_json::Map<String, serde_json::Value>,
}
#[derive(...)] #[serde(rename_all = "snake_case")] pub enum AuthType { ApiKey, Oauth }
#[derive(...)] #[serde(rename_all = "snake_case")] pub enum RotationStrategy { FillFirst, RoundRobin, LeastUsed, Random }
#[derive(...)] #[serde(rename_all = "snake_case")] pub enum LastStatus { Ok, Exhausted, Dead }
```
```rust
// src/credentials/strategies.rs
pub fn select_credential(entries: &[PooledCredential], strategy: RotationStrategy,
                         round_robin_cursor: usize) -> Option<&PooledCredential>;
```
```rust
// src/credentials/pool.rs
pub struct CredentialPool { provider: String, entries: Vec<PooledCredential>,
                            strategy: RotationStrategy, cursor: u64 }
impl CredentialPool {
    pub fn select(&mut self) -> Option<&PooledCredential>;      // increments request_count, advances cursor
    pub fn mark_exhausted_and_rotate(&mut self, status_code: Option<i64>,
                                     reason: Option<FailureReason>,
                                     credential_id: Option<&str>) -> Option<&PooledCredential>;
    pub fn acquire_lease(&mut self) -> Option<String>;          // P1: same as select; P2: real lease map
    pub fn release_lease(&mut self, credential_id: &str);
    pub fn entries(&self) -> &[PooledCredential];
    pub fn has_available(&self) -> bool;
    pub fn next_available_at(&self) -> Option<i64>;
    fn compute_ttl(&self, status_code: Option<i64>, reason: Option<FailureReason>) -> i64;
}
```

### State handling
- **P1**: `CredentialPool` instances are created per-provider by Rust
  callers; no `AppState` changes required. If IPC commands are added, keep a
  `Mutex<HashMap<String, CredentialPool>>` in `AppStateInner` (same pattern
  as `mcp_stdio_children` / `api_server` / `subscription_proxy` handles in
  `src/state.rs:226-279`).
- **P2 vault**: add `credential_vault: Option<Arc<CredentialVault>>` to
  `AppStateInner`; vault holds `Mutex<HashMap<String, VaultEntry>>` where the
  secret-bearing fields stay Rust-side; IPC exposes `id`/`status`/`cursor`
  but never `access_token` except via a narrowly-scoped `get_secret` command
  used by Rust-side consumers (egress/subscription proxies) directly.
- **New crates:** P1 needs none (uses existing `serde`/`serde_json`).
  P2 keyring/DPAPI: if OS-keychain persistence is required by a consumer,
  propose `keyring = "3"` (or Windows-native DPAPI via existing
  `windows-sys`) — **explicitly justified at that time** per AGENTS.md (no
  new external crate unless strongly justified).

## 6. IPC / boundary (Tauri commands; browser-only-dev fallback strategy)

### Tauri commands (only when consumers exist)
- P1 (optional, for parity tooling): `credential_pool_select(pool_id, ...)`,
  `credential_pool_mark_exhausted(pool_id, ...)` — thin wrappers around
  `credentials::pool::CredentialPool` held in `AppState`. Register in
  `main.rs` `generate_handler!`.
- P2 (vault): `credential_vault_put(id, access_token, ...)`,
  `credential_vault_get(id)` (used only by trusted Rust consumers),
  `credential_vault_delete(id)` — narrow surface; tokens never flow through
  generic JSON tool-result serialization.
- Do **not** add commands speculatively; the package has no consumers, so IPC
  should be added together with the first real caller.

### Browser-only-dev fallback
- `packages/credential-pool/src/*` remains the TS mirror and the runtime
  authority in `python run.py` (no Rust). Parity is enforced by shared golden
  fixtures + vitest parity tests (Section 8), so both implementations stay
  correct even though only one is live per mode.
- The TS mirror must keep the same invariants; if Rust becomes authoritative
  in desktop mode later, TS becomes a shim calling the new commands (exact
  pattern used by `@hermes/browser` → `web/src/lib/browser/tools.ts`).

## 7. Implementation phases (ordered, each shippable + testable)

### Phase 1 — Pure-logic port (`src/credentials/`) (S–M)
1. `types.rs` + `constants.rs` — serde mirrors + consts (parity with
   `constants.test.ts`).
2. `strategies.rs` — port `selectCredential` exactly.
3. `pool.rs` — port `CredentialPool` core (select / mark_exhausted_and_rotate
   / has_available / next_available_at / compute_ttl / leases as no-ops first,
   then Mutex-backed).
4. Unit tests mirroring `strategies.test.ts` + `pool.test.ts` + `test/pool.test.ts`.
5. (Optional) parity command pair for TS golden tests.
   Shippable: `cargo test` + vitest parity green; no behavior change anywhere
   (no consumers yet).

### Phase 2 — Rust-owned secret vault (gated on consumers) (L)
1. Add `vault.rs`: in-memory `Mutex<HashMap<String, VaultEntry>>`; secrets
   never returned by generic listing commands.
2. Wire into `AppStateInner`; add narrow put/get/delete commands.
3. Adopt a consumer (e.g. `subscription_proxy` `UpstreamCredential`
   retrieval, `egress_proxy`, or messaging adapter) so the vault is actually
   used; add integration tests with `wiremock` verifying a proxy/command
   consumes vault credentials without exposing tokens to the renderer.
4. Optional at-rest hardening: OS keychain via `keyring` crate (justified new
   dependency) or Windows DPAPI via existing `windows-sys`; SQLite-backed
   non-secret metadata (id/status/request_count) via existing `rusqlite`
   (pattern: `state_db.rs`).
   Shippable: vault + first consumer + integration tests; secrets no longer
   live in webview JS memory for that consumer.

### Phase 3 — Wire TS package to Rust (only after a consumer needs it) (M)
- Replace/augment `CredentialPool` calls in TS with IPC to the Rust pool
  (browser-only dev keeps the TS mirror). Add vitest parity tests for the IPC
  path, env-gated like other Rust-dependent tests.
   Shippable: desktop and browser-only dev both pass; parity tests green.

## 8. Testing strategy (Rust unit/integration with wiremock/tempfile; TS↔Rust parity; vitest parity tests)

- **Rust unit tests** (`#[cfg(test)] mod tests` in each new file):
  - `strategies.rs`: port every `strategies.test.ts` case (null on empty,
    fill_first/least_used min-count + tie, round_robin modulo over filtered
    list incl. cursor 3 → `d` case, random determinism via seeded RNG,
    excluded exhausted/dead, unknown-strategy fallback, no mutation).
  - `pool.rs`: port every `pool.test.ts` + `test/pool.test.ts` case
    (request_count increment, cursor advance, mark+rotate TTL bookkeeping,
    sole-credential `TTL_SOLE` reset, `nextAvailableAt` min, dead→exhausted
    flip).
  - `constants.rs`: port `constants.test.ts` (exact ms values, ordering,
    strategy list).
- **Rust integration tests** (`tests/` at repo root, `hermes_agent_cn`
  crate):
  - Vault + consumer: `wiremock::MockServer` for the consumer's upstream;
    `tempfile::TempDir` for any at-rest metadata DB; assert tokens flow
    Rust→consumer without crossing the renderer (no secret in command
    result JSON).
  - Concurrency: `#[serial_test::serial]` test with N threads calling
    `select()` on a shared `Mutex<CredentialPool>` asserting
    `request_count` totals are exact (validates the lock boundary).
  - No writes to `/tmp` or cwd; never hit real network.
- **TS↔Rust parity (golden vectors):**
  - Shared fixtures (`tests/fixtures/credential_cases.json`) with entry
    arrays + expected picks for each strategy; read by vitest and Rust tests.
  - Vitest parity tests in `packages/credential-pool/src/*.parity.test.ts`
    calling the Rust command pair (skipped when no Rust) and comparing
    against the TS implementation.
- **Required commands before done:** `pnpm typecheck`, `pnpm test:unit`
  (credential-pool workspace), `cargo fmt --check`, `cargo clippy -D warnings`,
  `cargo test --all-features` (per AGENTS.md).

## 9. Risks & mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| No consumers today ⇒ rewrite may be unused infrastructure | Wasted effort / bit-rot | Gate P1 as small pure-logic port (cheap, keeps parity), gate P2 vault explicitly on a consumer; document adoption path (subscription_proxy / egress_proxy / messaging) |
| TS/Rust semantics drift (ties, cursor-over-filtered-list, TTL selection) | Incorrect rotation in one mode | Golden fixtures + full vitest parity suite; keep TS mirror until IPC path is live |
| Time source differences (`Date.now()` in TS vs `SystemTime` in Rust) | `last_status_at` / `nextAvailableAt` drift | Use epoch-millis in both; inject a clock in Rust (`now_ms() -> i64` seam) for deterministic tests (pattern already in `state_db.rs:67-73`) |
| Random strategy determinism | Parity test flakiness | Use a seedable RNG in Rust (`rand`/`getrandom` existing dep) and stub `Math.random` in TS tests; parity tests assert set membership not exact pick for random |
| Moving secrets into Rust vault is a behavior change with no security review | New attack surface (vault commands, keychain prompts) | Narrow command surface, no secret in generic results, keyring added only with justification; unit + wiremock integration tests; document threat model in PR |
| Adding `keyring`/AEAD crate increases supply-chain + platform surface | New dependency risk | Keep P2 in-memory first; keyring only when a consumer needs persistence; prefer existing `windows-sys` DPAPI on Windows if no cross-platform keyring needed |
| Leases were documented no-ops; making them real could surprise TS tests | Behavior change | Keep lease semantics no-op-compatible until a consumer defines lease semantics; mark the upgrade as an explicit follow-up |

## 10. Effort estimate (S/M/L per phase)

| Phase | Effort |
|---|---|
| P1 Pure-logic port (`src/credentials/` types/constants/strategies/pool + parity tests) | S–M |
| P2 Rust-owned secret vault (`src/credentials/vault.rs` + AppState + first consumer) | L |
| P3 Wire TS package to Rust IPC (only after consumer exists) | M |
