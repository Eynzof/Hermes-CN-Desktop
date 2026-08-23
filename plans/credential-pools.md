# Credential Pools — Python → TypeScript Rewrite Plan

> Feature slug: `credential-pools` · Design-only plan (NO implementation).

## 1. Summary

Credential pools let the user register **multiple API keys / OAuth tokens per
provider** and let the runtime auto-rotate through them on rate limits (429),
billing/quota errors (402) and expired/invalid auth (401), with per-credential
cooldowns. Python (`Hermes-CN-Core`) has a complete implementation:
`agent/credential_pool.py` (3,178 lines) drives selection/rotation/leases,
`agent/credential_sources.py` unifies auto-discovery + sticky removal,
`agent/credential_persistence.py` defines the "borrowed secret" disk-boundary
rule, and `hermes_cli/auth.py` + `auth_commands.py` + `credential_lifecycle.py`
provide the `hermes auth` CLI, interactive wizard, and multi-store consistency.

This plan ports that feature into the TypeScript desktop monorepo as an
**in-process credential-pool service** (`packages/credential-pool/`) that runs
inside the Tauri webview, with Rust IPC used only for OS-level secure storage
(keyring) and browser opening. The end-state removes the WS/REST dependency on
the managed Python runtime; during migration the module first wraps the
existing dashboard REST endpoints (`/api/credentials/pool`,
`/api/providers/oauth`, `/api/env`) behind the same interface.

Key design decisions:
- **Single `CredentialPool` class mirrors `agent/credential_pool.py`** — one
  provider pool with `select()` / `mark_exhausted_and_rotate()` /
  `acquire_lease()` / `release_lease()`, four strategies, TTL cooldowns
  (401→5min, 429/402/other→1h, sole-credential→60s), and the DEAD terminal
  state for permanently-revoked OAuth tokens.
- **Auto-discovery sources become registered seeders** (`env:*`,
  `claude_code`, `hermes_pkce`, `device_code`, `qwen-cli`, `gh_cli`,
  `config:*`, `manual`) with a RemovalStep registry — ported from
  `agent/credential_sources.py` so `hermes auth remove` stays sticky.
- **Borrowed-secret disk policy is ported as-is**: raw values from env /
  Claude Code / external CLIs are reference-only at the persistence boundary;
  only fingerprints + metadata are stored, exactly like
  `sanitize_borrowed_credential_payload`.
- **OAuth flows reuse kimi-code's proven TypeScript stack**: device-code
  (RFC 8628) + token refresh via `packages/oauth` (OAuthManager, proper-lockfile
  cross-process lock, token tombstones, file storage).
- **Secure storage is the biggest gap**: kimi-code only ships 0600 JSON files;
  the Desktop plan adds a Rust `keyring` crate behind a Tauri command with
  file fallback, since no shipped keyring plugin exists in this repo today
  (see §9).

## 2. Current Python implementation

Source of truth: `D:/hermes-agent-cn`.

| File | Role |
|------|------|
| `agent/credential_pool.py` | `PooledCredential` dataclass (L185), `CredentialPool` (L633), `select()` (L1769), `mark_exhausted_and_rotate()` (L2031), `acquire_lease()`/`release_lease()` (L2201/L2249), `load_pool()` (L3115), seeders `_seed_from_env` / `_seed_from_singletons` / `_seed_custom_pool`, `get_pool_strategy()` (L521) |
| `agent/credential_persistence.py` | `is_borrowed_credential_source`, `sanitize_borrowed_credential_payload`, secret-key denylist + SHA-256 fingerprint |
| `agent/credential_sources.py` | `RemovalStep` registry (env/claude_code/hermes_pkce/device_code/qwen-cli/gh_cli/config/manual) for sticky `auth remove` |
| `hermes_cli/auth.py` | `ProviderConfig` + `PROVIDER_REGISTRY` (L234/L250), `read_credential_pool`/`write_credential_pool` (L1575/L1689), `suppress/unsuppress/is_source_suppressed` (L1756–1797), OAuth/device-code/PKCE helpers, per-provider resolvers |
| `hermes_cli/auth_commands.py` | `auth_add_command` (L164), `auth_list_command` (L437), `auth_remove_command` (L464), `auth_reset_command` (L502), interactive wizard `_interactive_auth` (L547), `_interactive_strategy` (L736) |
| `hermes_cli/credential_lifecycle.py` | `save_provider_env_credential` / `remove_provider_env_credential` / `purge_env_credential_references` — keeps `.env`, `credential_pool`, and `config.yaml` mirrors consistent |
| `agent/agent_runtime_helpers.py` | `recover_with_credential_pool` (L918) — error-driven rotation entry: 429 retry-once-then-rotate, 402 rotate immediately, 401 refresh-then-rotate, honors `FailoverReason` classifier |
| `hermes_cli/runtime_provider.py` | `load_pool()` + `pool.select()` during provider resolution (L2091) |
| `hermes_cli/web_server.py` | REST surface: `GET/POST /api/credentials/pool`, `DELETE /api/credentials/pool/{provider}/{index}` (L13878–13979) with redacted `_pool_entry_summary` |
| `website/docs/user-guide/features/credential-pools.md` | User-facing semantics (strategies table, error table, storage JSON example) |

Data flow (today): request → `runtime_provider.resolve_runtime_provider()` →
`load_pool(provider)` → `pool.select()` (strategy + refresh pending entries) →
client request → on 429/402/401 `run_agent.py` → `recover_with_credential_pool`
→ `pool.mark_exhausted_and_rotate(status_code, error_context, api_key_hint,
credential_id, failure_reason)` → rotate to next entry or fallback provider.
Pool state persists to `~/.hermes/auth.json` → `credential_pool.<provider>[]`
(borrowed secrets sanitized) and strategies to `config.yaml` →
`credential_pool_strategies`. Removal dispatches through the
`agent/credential_sources.py` RemovalStep registry so re-seeding cannot
resurrect removed entries (`suppressed_sources`).

## 3. Target TypeScript design

New package **`packages/credential-pool/`** (framework-free, vitest-able),
consumed by `web/src` and reused by the Rust shell via IPC.

```
packages/credential-pool/src/
  types.ts            # PooledCredential, PoolStatus, RotationStrategy, Source, ErrorTaxonomy
  constants.ts        # TTLs (401=300s, 429=3600s, default=3600s, sole=60s), DEAD prune=24h,
                      # strategy names, custom: prefix, DEFAULT_MAX_CONCURRENT=1
  pool.ts             # CredentialPool class (in-process, async-locked)
  strategies.ts       # fill_first / round_robin / least_used / random
  persistence.ts      # sanitizeBorrowedPayload, isBorrowedSource, fingerprint (WebCrypto SHA-256)
  sources.ts          # SeederRegistry + RemovalStep (env/claude_code/hermes_pkce/device_code/
                      # qwen-cli/gh_cli/config:/manual), suppressed-sources store
  oauth-manager.ts    # port of kimi-code OAuthManager (device flow + refresh + lock)
  storage.ts          # TokenStorage interface: KeyringStorage | FileStorage
  service.ts          # CredentialPoolService facade (loadPool, select, rotate, leases,
                      # list/add/remove/reset, strategies) — the frozen migration interface
  errors.ts           # classifyHttpError -> billing | rate_limit | auth | upstream_rate_limit
```

Core class shape (mirrors Python, async-first because storage/OAuth are async):

```ts
class CredentialPool {
  constructor(provider: string, entries: PooledCredential[], strategy: RotationStrategy)
  async select(): Promise<PooledCredential | null>            // refresh pending, pick by strategy
  async markExhaustedAndRotate(opts: {
    statusCode?: number; errorContext?: ErrorContext;
    apiKeyHint?: string; credentialId?: string; failureReason?: FailureReason;
  }): Promise<PooledCredential | null>
  async acquireLease(credentialId?: string): Promise<string | null>
  async releaseLease(credentialId: string): Promise<void>
  async tryRefreshCurrent(): Promise<PooledCredential | null>
  async resetStatuses(): Promise<number>
  async removeIndex(index: number): Promise<PooledCredential | null>
  async addEntry(entry: PooledCredential): Promise<void>
  entries(): PooledCredential[]; hasAvailable(): boolean; nextAvailableAt(): number | null
}
```

Concurrency model: the webview is single-threaded, so Python's `threading.RLock`
becomes an **async mutex (in-process promise queue)** plus a **cross-process
lock** (via kimi-code's `proper-lockfile` — see §5) around storage writes,
because multiple dashboard/gateway processes can still touch the same
`auth.json` during migration. Lease counters and the round-robin cursor are
in-memory exactly like Python; `request_count` persists per entry.

The **wizard + CLI** become a settings UI: `CredentialPoolsSection` inside
`web/src/routes/settings.tsx` reusing the OAuth modal pattern from
`settings-oauth-section.tsx`. Pure terminal `hermes auth` is marked
out-of-scope for desktop standalone (per plans/README) — the desktop ships a
webview, not a TUI; the same service powers both, so behavior parity is kept
via the shared `CredentialPoolService` interface.

## 4. Data models & persistence

`PooledCredential` (JSON shape identical to Python `to_dict()`):

```ts
interface PooledCredential {
  provider: string; id: string; label: string; auth_type: "api_key" | "oauth";
  priority: number; source: string;               // "env:OPENROUTER_API_KEY", "manual", ...
  access_token: string; refresh_token?: string;
  last_status?: "ok" | "exhausted" | "dead"; last_status_at?: number;
  last_error_code?: number; last_error_reason?: string;
  last_error_message?: string; last_error_reset_at?: number;
  base_url?: string; expires_at?: string; expires_at_ms?: number; last_refresh?: string;
  inference_base_url?: string; agent_key?: string;
  request_count: number; extra: Record<string, unknown>; // scope, token_type, secret_fingerprint, failure_reason...
}
```

Persistence plan (end-state, no Python):
- **Store file**: `${hermesHome}/auth.json` kept as the canonical store during
  migration (same wire format as Python so dual-run is safe); ownership moves
  to the TS service in the final phase. Schema `version: 1`, keys:
  `credential_pool`, `suppressed_sources`, `providers` (OAuth singleton state).
- **Borrowed-secret boundary**: port `credential_persistence.py` verbatim —
  manual + owned OAuth sources (`hermes_pkce`, `device_code`, `oauth` for
  owned providers) keep raw tokens; everything else stores only
  `secret_source`, `secret_fingerprint: sha256:<16>`, status/counters.
- **Secret values** (manual API keys, refresh tokens): move into OS keyring via
  Rust IPC (§5), storing only an opaque `keyring_ref` in JSON. This is a
  *new* hardening over Python's plaintext `auth.json`; the JSON keeps
  compatibility fields so old Python can still read a file-only fallback.
- **Strategies**: `credential_pool_strategies` in `config.yaml` (read/write via
  existing `use-config` during migration; in-process `yaml` lib at end-state).
- **Lease/request counters**: persisted on each `select()`/rotation like Python
  (`request_count` increments; round-robin reorders priorities and persists).
- **Migration**: existing `auth.json` is read as-is (no re-encryption on first
  launch); new writes apply the keyring split gradually. No schema bump needed
  — new optional fields only (`secret_storage: "keyring" | "file"`).

## 5. Third-party library strategy

| Python dependency | TS equivalent | Evidence |
|---|---|---|
| `threading.RLock` pool lock | In-process async mutex (promise-chain queue), from scratch | kimi-code `packages/oauth/src/oauth-manager.ts` serialises refreshes with an in-memory coalescer; `oauth-token-transaction.ts` implements a `TransactionLock` promise queue |
| Cross-process file lock (`_auth_store_lock`, flock-style) | `proper-lockfile` ^4.1.2 | kimi-code `packages/oauth/package.json`; `oauth-manager.ts` `acquireRefreshLock()` uses it, skips on win32 and re-reads storage as fail-safe — same tradeoff we accept on Windows |
| OAuth device flow (RFC 8628) + PKCE + token refresh | `@moonshot-ai/kimi-code-oauth` / port of `packages/oauth/src` (OAuthManager, oauth.ts, token-state.ts) | kimi-code `packages/agent-core/src/services/oauth/oauthService.ts`, `apps/kimi-code/src/cli/sub/login-flow.ts` |
| Token tombstone ("revoked" state) | `packages/oauth/src/token-state.ts` `classifyToken` / `revokedTombstone` | Direct equivalent of Python STATUS_DEAD for `token_invalidated`/`token_revoked` |
| File token storage w/ 0600 + atomic rename | `packages/oauth/src/storage.ts` `FileTokenStorage` | Direct port (Windows best-effort perms) |
| `hashlib.sha256` fingerprint | Web Crypto `crypto.subtle.digest("SHA-256")` | from scratch (browser built-in) |
| `uuid.uuid4().hex[:6]` | `crypto.randomUUID().slice(0,6)` | from scratch |
| `PyYAML` (config strategies) | `yaml` npm (end-state) / existing `use-config` REST (migration) | Desktop already uses `useConfig`/`useSaveConfig` hooks in `settings.tsx` |
| `requests`/`urllib` HTTP + `fetch` | native `fetch` via `web/src/lib/transport.ts` | existing |
| Python `keyring` / Bitwarden / Vault refs | **No TS equivalent in kimi-code** — kimi-code stores plain 0600 JSON. Desktop: Rust `keyring` crate exposed as Tauri command; fallback `FileTokenStorage` | `D:/Hermes-CN-Desktop/Cargo.toml` has no keyring plugin today; `src/connection.rs` reserves `"encoding": "keyring"` but ships `"plain"` (L232–239) |
| Error classifier (`agent/error_classifier.py` FailoverReason) | `errors.ts` `classifyHttpError(status, body) -> billing/rate_limit/auth/upstream_rate_limit` | from scratch; semantics documented in `website/docs/user-guide/features/credential-pools.md` error table |

**No-TS-equivalent risks (explicit)**:
1. **Secure credential storage in Tauri** — kimi-code has NO keyring; it uses
   plain 0600 files. This repo has no keyring plugin in `Cargo.toml` (only
   dialog/notification/clipboard-manager). Options: add the Rust `keyring`
   crate behind a new Tauri command (`credential_store_set/get/delete`), or a
   community `tauri-plugin-keyring`/`tauri-plugin-stronghold`. Recommendation:
   `keyring` crate first (OS keychain), keep `FileTokenStorage` fallback for
   headless/test/dev; `connection.rs` already anticipated the `"keyring"`
   encoding tag, so the schema is forward-compatible.
2. **Cross-process lock semantics** — Python flock + `concurrent-log-handler`
   differ from `proper-lockfile`; on Windows both effectively degrade to
   in-memory + storage re-read (kimi-code skips locking on win32). The
   quarantine/cooldown merge (`_merge_disk_cooldown_state` in `auth.py` L1632)
   must be ported to prevent last-writer-wins resurrecting an exhausted key.
3. **No TUI**: the `hermes auth` interactive wizard has no terminal in the
   desktop app; it is replaced by the settings UI (behavior parity via the
   shared service, not byte-parity of the prompt flow).

## 6. Integration with existing Hermes-CN-Desktop frontend

Existing surfaces to reuse/extend (verified by reading):
- **`web/src/routes/settings-oauth-section.tsx`** — device-code/PKCE/loopback
  login modal (`OAuthLoginModal`), status badges, disconnect flow; becomes the
  base for the new multi-credential OAuth entry ("Add credential → OAuth").
- **`web/src/hooks/use-oauth-providers.ts`** — `useOAuthProviders`,
  `useStartOAuthLogin`, `useSubmitOAuthCode`, `usePollOAuthSession`,
  `useDisconnectOAuth`; extend with pool mutations
  (`useCredentialPoolList/Add/Remove/Reset/SetStrategy`).
- **`web/src/hooks/use-env.ts`** — `/api/env` GET/PUT/DELETE/reveal; the env
  seeders read the same `EnvVarsResponse` (keys with `provider`/`channel_managed`
  metadata, protocol `hermes-api.ts` L649+).
- **`web/src/routes/settings.tsx`** (SettingsSection pattern) +
  `settings-models-section.tsx` (L1934 mounts `OAuthProvidersSection`) — add
  `CredentialPoolsSection` beside OAuth; per-provider pool rows show
  `#N label source status request_count token_preview` like `hermes auth list`.
- **`packages/protocol/src/hermes-api.ts`** — add Zod schemas:
  `CredentialPoolEntry` (mirror `_pool_entry_summary`), `CredentialPoolListResponse`
  (`{ providers: [{ provider, entries }] }`), add/remove/reset/strategy request
  bodies, validating `/api/credentials/pool` responses.
- **`web/src/lib/transport.ts`** — all REST goes through `fetchJSON`/`postJSON`/
  `deleteJSON` (auth header injection stays here; no raw fetch).
- **Rust `src/commands/`** — `connection_auth.rs` is for **remote-gateway**
  login (webview cookie flow), NOT provider credentials; keep separate. Add
  new `src/commands/credential_pool.rs` exposing:
  `credential_store_set(key, value)`, `credential_store_get(key)`,
  `credential_store_delete(key)` (keyring-backed), plus
  `open_browser(url)` reuse from existing external-links.
- **Rust `src/connection.rs`** — the reserved `"encoding": "keyring"` tag is
  the natural schema hook for persisted keyring refs.

## 7. Removing the WebSocket dependency (migration path)

Interface to freeze: `CredentialPoolService` (`loadPool(provider)`, `select`,
`markExhaustedAndRotate`, leases, list/add/remove/reset, strategy get/set,
suppression). All consumers (model picker, runtime request path, settings UI)
talk to this interface only.

1. **Phase A (today)**: `CredentialPoolService` calls the dashboard REST —
   `GET/POST/DELETE /api/credentials/pool` (web_server.py L13878+),
   `/api/providers/oauth/*`, `/api/env` — through `transport.ts`. The OAuth
   flow stays server-driven (Python holds PKCE/device state). No UI change.
2. **Phase B (hybrid)**: OAuth moves client-side (port kimi-code OAuthManager);
   the service performs refresh/rotation in-process but still persists via
   `/api/credentials/pool` writes to keep Python processes in sync
   (cross-process merge via proper-lockfile + `_merge_disk_cooldown_state`).
3. **Phase C (end-state)**: the service owns `auth.json` (via Rust fs + keyring
   IPC); runtime requests select credentials in-process; REST/WS calls for
   credentials are deleted. The frozen `CredentialPoolService` interface is
   the only thing consumers see — the WS link to Python dies with the rest of
   the runtime migration.

## 8. Migration phases & task breakdown

- **P1 — Port core pool model (no UI)** (`packages/credential-pool/src`):
  types/constants, `strategies.ts`, `pool.ts` (select/rotate/leases/TTL/DEAD),
  unit tests vs Python parity vectors.
- **P2 — Persistence + sources**: `persistence.ts` (borrowed-secret sanitizer +
  WebCrypto fingerprint), `sources.ts` seeders + RemovalStep registry,
  `suppressed_sources` handling; migrate `credential_lifecycle.py` semantics
  (`.env` ↔ pool ↔ config mirror consistency) into service + Rust env IPC.
- **P3 — OAuth in TS**: port kimi-code `OAuthManager`/`storage`/`token-state`;
  adapt `oauthService.ts` flow-state machine for desktop; keep REST writes in
  Phase A→B.
- **P4 — Rust secure storage**: `src/commands/credential_pool.rs` + `keyring`
  crate; `credential_store_*` IPC; file fallback; `connection.rs` `"keyring"`
  encoding wiring.
- **P5 — Protocol + UI**: Zod schemas; `use-credential-pool.ts` hooks;
  `CredentialPoolsSection` in settings (list/add/remove/reset/strategy/status
  badges), multi-account OAuth add flow reusing `OAuthLoginModal`.
- **P6 — Error-driven rotation wiring**: `errors.ts` classifier; wire
  `markExhaustedAndRotate` into the runtime request path (replacing
  `recover_with_credential_pool` calls) with 429 retry-once semantics.
- **P7 — Decommission**: remove WS/REST credential calls, delete Python-side
  contract tests only after parity suite green; update docs.

## 9. Risks & open questions

- **Secure credential storage in Tauri (keyring plugin vs Rust)** — the #1
  gap. kimi-code has no keyring (plain 0600 files); this repo has no keyring
  plugin. Open question: use the Rust `keyring` crate directly
  (recommended — same crate class the Python `keyring` lib wraps, minimal
  deps), or adopt `tauri-plugin-stronghold` (encrypted local vault, heavier,
  better for offline-only). Needs decision before P4.
- **Cross-process quarantine merge** — porting `_merge_disk_cooldown_state`
  exactly is required; a naive last-writer-wins resurrects exhausted keys
  (the Python bug family #43747/#79156 exists to prove it).
- **Windows file-permission semantics** — 0600 is best-effort on Windows;
  keyring becomes the real protection; document that dev mode may still be
  plaintext.
- **CLI/TUI parity** — `hermes auth` wizard has no desktop equivalent; we
  accept UI-substitution. Flag in release notes.
- **Prompt-cache rotation cost** — same caveat as Python docs: rotating keys
  mid-session resets provider prompt cache; no mitigation in TS either.
- **Multiple processes during migration** — a Python dashboard and the TS
  service may both mutate `auth.json`; mitigation is the file lock + disk
  merge ported from §7 Phase B.
- **Open question**: should the desktop ship `hermes auth` CLI-equivalent
  commands (e.g. `hermes-desktop auth list`) for power users, or keep
  settings-UI-only? (Lean: settings-UI-only for standalone.)

## 10. Test strategy

Parity tests mirroring Python (vitest + Playwright):
- `pool.test.ts` — selection per strategy; `least_used` increments
  `request_count` (parity: `test_credential_pool.py::test_least_used_strategy_selects_lowest_count`).
- `rotation.test.ts` — 429 retry-once-then-rotate; 402 immediate rotate; 401
  refresh-then-rotate; sole-credential 60s TTL (parity:
  `test_credential_pool_sole_cooldown.py`, `test_credential_pool_key_rotation.py`).
- `dead.test.ts` — `token_invalidated`/`token_revoked` → DEAD never re-enters;
  manual DEAD pruned after 24h (parity: `test_credential_pool.py` L266/L331/L503).
- `lease.test.ts` — lease acquire/release, max-concurrent cap, refresh-reselect
  (parity: `test_credential_pool_lease_refresh_reselect.py`,
  `test_credential_pool_quarantine_locking.py`).
- `persistence.test.ts` — borrowed sources strip secrets, fingerprint stored,
  owned OAuth persists tokens (parity: `test_credential_pool.py` L582/L744/L834–907,
  `test_credential_pool_oauth_writethrough.py`).
- `sources.test.ts` — env seed/remove/suppress, claude_code/hermes_pkce/
  device_code/qwen/gh_cli/config removal steps, copilot multi-source suppression
  (parity: `tests/hermes_cli/test_auth_commands.py` L679–811,
  `test_credential_pool_routing.py`, `test_credential_pool_provider_boundary.py`).
- `lifecycle.test.ts` — env save/delete reconciles pool + config mirrors
  (parity: `tests/hermes_cli/test_credential_lifecycle.py`,
  `test_auth_store_windows_encoding.py`, `test_auth_toctou_file_modes.py`).
- `oauth-manager.test.ts` — device flow, refresh threshold, tombstone, lock
  races (kimi-code already has equivalents under `packages/oauth`).
- `storage.test.ts` — keyring adapter mocked; file fallback atomic write/0600.
- **E2E (Playwright)** — settings: add key → appears in pool list; add OAuth →
  device-code modal → poll → connected; rotate on simulated 429 via fake
  model (existing e2e fake-model harness); remove env-seeded key stays gone
  after reload (sticky suppression).
- **Rust tests** — `credential_pool.rs` keyring IPC with a mock store;
  `connection.rs` `"keyring"` encoding round-trip.

## 11. Reference links

- Python: `D:/hermes-agent-cn/agent/credential_pool.py`,
  `agent/credential_persistence.py`, `agent/credential_sources.py`,
  `hermes_cli/auth.py`, `hermes_cli/auth_commands.py`,
  `hermes_cli/credential_lifecycle.py`,
  `hermes_cli/agent_runtime_helpers.py::recover_with_credential_pool`,
  `hermes_cli/runtime_provider.py`, `hermes_cli/web_server.py` (L13878+).
- Docs: `D:/hermes-agent-cn/website/docs/user-guide/features/credential-pools.md`.
- Tests: `D:/hermes-agent-cn/tests/agent/test_credential_pool*.py`,
  `tests/hermes_cli/test_auth_*.py`, `test_credential_lifecycle.py`,
  `tests/gateway/test_adapter_startup_secret_scope.py`.
- TS reference: `D:/kimi-code/packages/oauth/src/oauth-manager.ts`,
  `oauth-token-transaction.ts`, `storage.ts`, `token-state.ts`, `types.ts`;
  `packages/agent-core/src/services/oauth/oauthService.ts`,
  `packages/agent-core/src/services/auth/managedAuth.ts`;
  `apps/kimi-code/src/cli/sub/login-flow.ts`.
- Desktop: `D:/Hermes-CN-Desktop/web/src/routes/settings-oauth-section.tsx`,
  `settings-models-section.tsx`, `web/src/hooks/use-oauth-providers.ts`,
  `use-env.ts`, `web/src/lib/transport.ts`,
  `packages/protocol/src/hermes-api.ts`,
  `src/commands/connection_auth.rs`, `src/connection.rs`, `Cargo.toml`.
