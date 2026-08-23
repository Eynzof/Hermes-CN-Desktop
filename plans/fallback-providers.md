# Fallback Providers — Python → TypeScript Rewrite Plan

## 1. Summary

Port Hermes' three-layer provider resilience (credential pools → primary model
fallback → auxiliary task fallback) from the Python backend into the TS agent
runtime. The primary deliverable is a **`FallbackManager`** that (a) runs
cross-provider failover for the main model on classified errors (429/5xx after
retries, 401/403/404 immediate, malformed responses), restoring the primary at
the start of every turn; and (b) resolves each auxiliary task (vision, web
extract, compression, skills hub, MCP, approval, title generation, goal judge /
triage specifier) through the same fallback ladder: task `fallback_chain` →
top-level `fallback_providers` → built-in discovery chain → main-agent safety
net. The `hermes fallback` CLI manager (list/add/remove/clear) is replaced by a
React settings surface that reuses the existing model picker and gateway
`config.set` for persistence. kimi-code provides TS evidence for error
classification, retry/backoff, and provider/auth plumbing, but has **no
cross-provider failover** — the chain machinery itself must be built from
scratch.

## 2. Current Python implementation

### 2.1 Config & CLI manager
- `D:/hermes-agent-cn/hermes_cli/fallback_config.py` — single source of
  truth for reading the chain:
  - `get_fallback_chain(config)` merges `fallback_providers` (list, primary)
    with legacy `fallback_model` (dict), dedupes by (provider, model, base_url)
    identity, always returns fresh copies.
  - `resolve_entry_api_key(entry)` — inline `api_key` wins, else `key_env` /
    `api_key_env` resolved through `agent.secret_scope.get_secret` (not raw
    `os.getenv`) so multiplexed-gateway profile scopes are honored.
- `D:/hermes-agent-cn/hermes_cli/fallback_cmd.py` — `hermes fallback`
  dispatcher with `list/ls`, `add`, `remove/rm`, `clear`:
  - `add` reuses the `hermes model` picker (`select_provider_and_model`),
    snapshots/restores `config["model"]` and auth `active_provider` so the
    primary is never clobbered, appends `{provider, model, base_url?,
    api_mode?}` and **drops the legacy key on write**.
  - Dedup via `agent/backend_identity.py` (`BackendIdentity.same_deployment`;
    same provider+model on a different explicit base_url is a *different*
    backend and is allowed).
- Config shape (docs `website/docs/user-guide/features/fallback-providers.md`):
  ```yaml
  fallback_providers:
    - provider: openrouter
      model: anthropic/claude-sonnet-4
      # base_url / key_env / api_mode optional
  auxiliary:
    vision: { provider: "auto", model: "", base_url: "", fallback_chain: [...] }
  ```

### 2.2 Primary-model failover runtime
- `D:/hermes-agent-cn/run_agent.py` — `AIAgent` (line 472) takes
  `fallback_model` (line 565, forwarded line 669); buffered retry/fallback
  status (`_emit_pending_fallback_notice` line 1274), `_has_pending_fallback`
  (line 6952), `_try_activate_fallback` forwarder (line 6946),
  `_restore_primary_runtime` forwarder (line 6966).
- `D:/hermes-agent-cn/agent/agent_init.py` (1596–1628) — seeds
  `_fallback_chain` (list|dict|empty), `_fallback_index=0`,
  `_fallback_activated`, legacy `_fallback_model`; prints chain banner.
- `D:/hermes-agent-cn/agent/chat_completion_helpers.py` —
  `try_activate_fallback(agent, reason)` (line 1988), the core failover:
  - reason ∈ {rate_limit, billing, upstream_rate_limit} arms exponential
    backoff 60s → 4h cap (`_rate_limited_until`); chain exhaustion arms a
    short cooldown to prevent the cross-turn replay storm (#24996).
  - skip logic: `_unavailable_fallback_keys` session cache,
    `_fallback_entry_unavailable_without_network` (nous token presence),
    `backend_identity.should_skip_candidate` (same backend as current).
  - client build via `resolve_provider_client` + `resolve_entry_api_key`,
    api_mode detection (`chat_completions` / `codex_responses` /
    `anthropic_messages` / `bedrock_converse`), in-place swap of
    `model/provider/base_url/api_mode/client/api_key`, clears `_transport_cache`
    and `_config_context_length`.
  - credential-pool rebind: clears the primary pool when provider differs
    (#33163/#33088) and attaches the fallback provider's pool.
- `D:/hermes-agent-cn/agent/agent_runtime_helpers.py` —
  `restore_primary_runtime(agent)` (line 1461): turn-scoped restore; skips
  while `_rate_limited_until` is in the future; reset-aware gate via credential
  pool `next_available_at` (Claude Pro/Max 5h windows); `switch_model`
  (line ~2864) resets index and prunes chain entries that target old/new
  provider.
- `D:/hermes-agent-cn/agent/error_classifier.py` — `FailoverReason` enum
  (auth, auth_permanent, billing, rate_limit, upstream_rate_limit, overloaded,
  server_error, timeout, ssl_cert_verification, context_overflow,
  payload_too_large, image_too_large, model_not_found,
  provider_policy_blocked, content_policy_blocked, format_error, … unknown)
  and `classify_api_error` with big regex/pattern lists (billing, quota,
  auth, transport, context-overflow, …) returning `ClassifiedError` hints
  (`retryable`, `should_rotate_credential`, `should_fallback`).

### 2.3 Auxiliary-task fallback
- `D:/hermes-agent-cn/agent/auxiliary_client.py` (~10.5k lines) — central
  router + fallback ladder:
  - `call_llm` (9000) / `async_call_llm` (9859) → `_call_llm_impl` (9071):
    resolves task config via `_resolve_task_provider_model` /
    `_get_auxiliary_task_config` (7955), then for `task == "vision"` uses
    `resolve_vision_provider_client` (7053) with its own fallback, else
    `_get_cached_client` → auto chain.
  - `_resolve_auto_route` (5691): main provider+model first (fast-model opt-in
    for title_generation; MoA preset unwrap), then local/custom, then
    built-in discovery.
  - Capacity/error fallback ladder: `_try_payment_fallback` (5191, 402 /
    daily-quota 429 / connection), `_try_configured_fallback_chain` (5410,
    per-task `fallback_chain`; `failed_model` scope semantics — model-scoped
    failures skip only the exact model, provider-wide failures skip the whole
    provider), `_try_main_agent_model_fallback` (5242), `_try_main_fallback_chain`
    (5589, top-level chain via `get_fallback_chain`), then warn + re-raise.
  - `_call_fallback_candidate_sync/async` (4963/5088): stale-credential
    recovery (401 → next layer), per-entry `timeout` override, context-window
    screening (`_candidate_context_window`, #52392), unhealthy-provider cache
    (`_mark_provider_unhealthy`, `_is_provider_unhealthy`).
  - `resolve_provider_client` (6032) — the single provider→client router used
    by both main fallback and aux paths.
- Docs chain orders: text `OpenRouter → Nous Portal → Custom → Codex OAuth →
  API-key providers → give up`; vision `Main (if vision) → OpenRouter → Nous →
  Codex → Anthropic → Custom → give up`; free_only cost guard.

### 2.4 Tests (parity sources)
- `tests/hermes_cli/test_fallback_cmd.py` (chain read/write, add rejects same
  as primary, primary restore, remove/clear, argparse wiring),
  `tests/hermes_cli/test_fallback_config.py` (api-key resolution incl. secret
  scope).
- `tests/run_agent/test_fallback_credential_isolation.py`,
  `tests/run_agent/test_fallback_reasoning_override.py`,
  `tests/run_agent/test_24996_fallback_exhaustion_cooldown.py`,
  `tests/run_agent/test_reset_aware_primary_restore.py`,
  `tests/run_agent/test_auth_provider_failover.py`,
  `tests/run_agent/test_32646_fallback_429_after_timeout.py`,
  `tests/gateway/test_fallback_chain_reload.py`, plus the ~25 tests referencing
  `_fallback_chain`/`_fallback_index` in `tests/run_agent/test_run_agent.py`.
- `tests/test_empty_model_fallback.py` — gateway fills empty model from
  provider catalog (related empty-model recovery, not chain failover).

## 3. Target TypeScript design

### 3.1 Module layout (all under `web/src/fallback/`)
```
web/src/fallback/
  types.ts            FallbackEntry, FallbackChainConfig, AuxiliaryTaskId,
                      FailoverReason (mirror), ClassifiedError, FallbackStatusEvent
  error-classifier.ts classifyApiError(error) -> ClassifiedError   (port of error_classifier.py)
  chain.ts            getFallbackChain(cfg) / normalizeEntry / sameDeployment  (pure, no I/O)
  config.ts           loadFallbackChain() / saveFallbackChain() via gateway config RPC;
                      resolveEntryApiKey(entry, secretResolver)
  manager.ts          FallbackManager — primary-model failover state machine
  auxiliary.ts        AuxiliaryFallbackRouter — per-task ladder
  backoff.ts          exponential backoff + Retry-After (port loop/retry.ts semantics)
```
- Pure functions (`chain.ts`, `error-classifier.ts`, `backoff.ts`) stay
  framework-free so vitest parity tests run without a React renderer.

### 3.2 `FallbackManager` (primary failover) — key state & methods
```ts
interface FallbackManagerState {
  chain: FallbackEntry[];          // from getFallbackChain(config)
  index: number;                   // _fallback_index
  activated: boolean;              // _fallback_activated
  rateLimitedUntil: number;        // monotonic ms; backoff 60s→4h
  unavailableKeys: Set<string>;    // _unavailable_fallback_keys
  pendingNotice: FallbackStatusEvent | null;
}
class FallbackManager {
  attach(adapter: LLMChatAdapter): void;   // see agent-loop-llm-adapters plan
  restorePrimaryRuntime(now: number): boolean;  // turn start
  tryActivateFallback(reason: FailoverReason, current: RuntimeIdentity): boolean;
  onChainChanged(chain: FallbackEntry[]): void; // gateway /model switch prune
  emitStatus(cb: (e: FallbackStatusEvent) => void): void; // buffered one-shot notice
}
```
- Flow per turn: `restorePrimaryRuntime` → (cooldown/reset-aware gate) →
  primary call → error → `classifyApiError` → same-provider retries
  (credential rotation first — see credential-pools plan) →
  `tryActivateFallback` → swap runtime via `resolveProviderClient` TS
  equivalent → continue turn (at most one activation per turn) → next turn
  restores primary.
- Identity/dedup: port `BackendIdentity` to `web/src/fallback/identity.ts`
  (provider + model + normalized base_url; explicit base_url ⇒ distinct
  backend) — shared with the fallback picker UI.

### 3.3 `AuxiliaryFallbackRouter` — ladder
```ts
async function callAuxiliary(opts: {
  task: AuxiliaryTaskId; provider?: string; model?: string; baseUrl?: string;
  messages; timeout?: number; ...
}, rt: Runtime): Promise<Response> {
  const cfg = getAuxiliaryTaskConfig(task);            // auxiliary.<task>
  // 1. explicit/auto primary (vision uses vision router)
  // 2. on capacity error (402 / quota-429 / connection):
  //    task.fallback_chain → main fallback chain → main agent model → warn+raise
  // transient 429 (Retry-After) does NOT leave the explicit provider
}
```
- Config keys honored per task: `provider`, `model`, `base_url`, `api_key`,
  `timeout`, `fallback_chain[]` (each entry may add its own `timeout`),
  `free_only` / `openrouter_model` cost guard for OpenRouter rungs.

### 3.4 In-process operation
With the Python backend removed, the LLM transport is the TS adapter's fetch
(`openai`/`@moonshot-ai/kosong` style client or direct `transport.ts` fetch).
`FallbackManager` receives normalized errors from the adapter's error class
(`APIStatusError`-compatible), never from Python. Config is read/written
through the gateway `config.get`/`config.set` RPC (which today proxies to the
Python config.yaml; later becomes the local config store).

## 4. Data models & persistence

- **Config (source of truth, YAML via gateway config RPC)**:
  - `fallback_providers: FallbackProviderEntry[]` (top-level list), legacy
    `fallback_model` read-only + migrated on write (drop legacy key).
  - `auxiliary.<task>.fallback_chain: FallbackProviderEntry[]` per task;
    `auxiliary.<task>.provider/model/base_url/api_key/timeout/free_only`.
- **Protocol schema** (`packages/protocol/src/hermes-api.ts`): add
  `FallbackProviderEntry` (provider, model, base_url?, api_mode?, key_env?,
  api_key?, timeout?), `FallbackChainResult` (ok, entries, legacy_migrated?),
  and reuse `ConfigSetResult` for writes. RPC surface frozen during migration:
  `config.get`, `config.set`, `model.options`, `provider.models` (used by the
  picker).
- **Runtime state (in-memory only, on `FallbackManager`)**: `index`,
  `activated`, `rateLimitedUntil`, `unavailableKeys`, `pendingNotice`,
  unhealthy-provider TTL cache — mirrors Python agent attrs; no DB migration.
- **No new SQLite/IndexedDB tables**; the session DB only records the billing
  route after a `/model` switch (existing `session_log` behavior), and should
  record `fallback_activated` route for the dashboard Model card parity.

## 5. Third-party library strategy

| Python dependency / logic | TS equivalent | Evidence |
|---|---|---|
| `openai` SDK client + error types | `@moonshot-ai/kosong` (`APIStatusError`, `APIProviderQuotaExhaustedError`, `APIConnectionError`, `APITimeoutError`) or `openai` npm; adapter must normalize to a `ClassifiedError` | kimi-code `packages/agent-core/src/errors/serialize.ts` imports these from `@moonshot-ai/kosong`; `loop/retry.ts` uses `APIStatusError` |
| Retry with exponential backoff + `Retry-After` | Reuse kimi-code `loop/retry.ts` (`retryBackoffDelays`: 0.5s→32s cap, 25% jitter, server `retry-after` override) | `D:/kimi-code/packages/agent-core/src/loop/retry.ts` |
| `error_classifier.py` (FailoverReason, pattern lists) | Implement from scratch `error-classifier.ts`; port `_BILLING_PATTERNS`/`_RATE_LIMIT_PATTERNS`/quota phrases verbatim | kimi-code `errors/codes.ts` + `errors/serialize.ts` provide code→title/retryable registry but **no `should_fallback` hint**; extend the pattern |
| `agent/backend_identity.py` same-deployment identity | Implement from scratch `identity.ts` (provider+model+normalized base_url; explicit base_url ⇒ distinct backend) | No equivalent in kimi-code (single provider) |
| `resolve_provider_client` (central router, api_mode detection) | Consume the `resolveProviderClient` TS adapter from `plans/agent-loop-llm-adapters.md`; add `api_mode` detection switch (`chat_completions`/`codex_responses`/`anthropic_messages`/`bedrock_converse`) | kimi-code `session/provider-manager.ts` builds providers per type (`anthropic`, `openai`, `openai_responses`, `kimi`, `google-genai`, `vertexai`) |
| `agent/secret_scope.get_secret` (profile-scoped env) | `SecretResolver` interface implemented by the credential store / Rust `get_runtime_config`; never raw `process.env` when multiplexing | kimi-code `services/auth/managedAuth.ts` + `@moonshot-ai/kimi-code-oauth` token providers |
| Config YAML read/write | `js-yaml` + gateway `config.get`/`config.set` (existing `ConfigSetResult`) | Desktop already reads config via gateway; `packages/protocol/src/hermes-api.ts` |
| `hermes fallback` interactive picker | React UI reusing `use-model-options.ts` + `use-provider-models.ts`; no curses | Desktop `settings-models-section.tsx` already implements a provider picker |
| Credential pools rotation | **Defer to `plans/credential-pools.md` (#58)**; `FallbackManager` only rebinds/clears the pool on provider switch | kimi-code `session/subagent-batch.ts` rate-limit phase is capacity, not pool rotation |

**No TS equivalent found (risks):**
1. **Automatic cross-provider failover does not exist in kimi-code.** kimi-code
   retries the *same* provider (`loop/retry.ts`, 10 attempts), classifies
   errors, and pauses/requeues on rate limits (`turn/index.ts`
   `GOAL_RATE_LIMIT_PAUSE_REASON`, `session/subagent-batch.ts`), but never
   swaps to a different provider mid-turn and never restores a primary per
   turn. The whole chain machinery (`FallbackManager`, `restorePrimaryRuntime`,
   backoff-until-reset gate) is a from-scratch TS module.
2. **Auxiliary-task provider resolution ladder** (8+ task slots, per-task
   `fallback_chain`, built-in discovery chains, capacity-vs-transient 429
   distinction) has no TS counterpart in kimi-code — implement
   `auxiliary.ts` from scratch.
3. **Provider "health" TTL cache and context-window screening** of fallback
   candidates rely on the Python model catalog (`agent/models_dev.py`,
   `agent/model_metadata.py`) and `_mark_provider_unhealthy`; the TS side must
   reuse the desktop's offline models snapshot (existing `provider-catalog.ts`)
   and port the screening threshold logic.
4. **Secret scope semantics** in multiplexed profiles (test
   `test_fallback_config.py`) require the Rust credential store to expose
   profile-scoped resolution; raw `process.env` would regress that behavior.

## 6. Integration with existing Hermes-CN-Desktop frontend

- **Settings UI** — extend `web/src/routes/settings-models-section.tsx`
  (2,706 lines; `AUXILIARY_TASKS` already lists vision, compression,
  web_extract, title_generation, approval, mcp, skills_hub, triage_specifier,
  kanban_decomposer, profile_describer, curator):
  - New "主模型回退" card in the `main` tab: ordered chain editor with
    add (opens provider picker via `useProviderModels` / `useModelOptions`),
    reorder, remove, clear; persist with `config.set` writing top-level
    `fallback_providers`; show legacy `fallback_model` migration notice.
  - Each auxiliary task form gains a `fallback_chain` editor (list of
    provider/model with optional base_url/key_env/timeout) — the Python
    `hermes fallback add` picker flow is reproduced by the existing
    `selectProviderAndModel`-style flow in the models section.
- **Hooks to reuse**: `use-provider-models.ts` (provider model listing for
  chain entries), `use-model-options.ts` (global provider/model options),
  `use-gateway.ts` (`config.get`/`config.set` RPCs).
- **Protocol**: extend `packages/protocol/src/hermes-api.ts` (new
  `FallbackProviderEntry` / `FallbackChainResult` schemas + zod tests next to
  `ProviderModelsListResult` at line 1433).
- **Rust**: no new Tauri command strictly required — config round-trips via
  gateway; if profile-scoped secrets are needed for `key_env` entries, add a
  read-only secret-resolution command beside `get_runtime_config`.
- **Status surfacing**: gateway status events already carry retry/fallback
  notices (`run_agent.py` buffered `_emit_pending_fallback_notice`); the TS
  `FallbackManager` should emit the same event shape so the composer status
  bar shows "已切换到回退模型 …" without Python.

## 7. Removing the WebSocket dependency (migration path)

- **Phase 0 (today)**: fallback runs in Python; desktop edits config via
  gateway `config.set`, observes fallback notices over WS status events. Freeze
  RPC surface now: `config.get`/`config.set` for `fallback_providers` and
  `auxiliary.<task>.fallback_chain`, `model.options`, `provider.models`,
  status event `retry/fallback` payload.
- **Phase 1**: TS `FallbackManager` + `AuxiliaryFallbackRouter` implemented
  behind the same interface used by the in-process LLM adapter
  (`agent-loop-llm-adapters.md`); run side-by-side with Python for parity tests
  (unit-level, not dual-execution).
- **Phase 2**: agent loop runs in-process; `FallbackManager` owns failover;
  Python path becomes a remote-profile fallback only (WS remains for legacy
  remote backends).
- **Phase 3**: delete WS/REST fallback path; config persistence moves to the
  local store (SQLite/JSON) with the same `config.get`/`config.set` shape;
  remove `hermes fallback` CLI dependency from the desktop surface.

## 8. Migration phases & task breakdown

1. **Protocol + config plumbing**: `FallbackProviderEntry`/`FallbackChainResult`
   zod schemas; `chain.ts` (`getFallbackChain` merge/dedup/legacy migration) +
   `config.ts` (load/save via gateway RPC); unit tests mirroring
   `test_fallback_config.py` / `test_fallback_cmd.py`.
2. **Error classifier**: `error-classifier.ts` porting `FailoverReason` +
   pattern lists; vitest parity table (HTTP 429/402/401/403/404/5xx, quota
   phrases, connection/timeout) vs `agent/error_classifier.py` behavior.
3. **FallbackManager (primary)**: state machine + `backoff.ts` (60s→4h,
   chain-exhaustion cooldown, reset-aware restore gate) + identity/dedup +
   pool rebind hook (interface only, impl deferred to credential-pools);
   tests: activation once per turn, restore at turn start, skip semantics,
   exhausted-chain cooldown (parity with #24996 / #32646 tests).
4. **AuxiliaryFallbackRouter**: per-task ladder, capacity-vs-transient
   classification, per-entry timeout, context-window screening, unhealthy
   cache; tests mirroring aux fallback tests (free_only guard, model-scoped
   skip, main-agent safety net).
5. **Settings UI**: primary chain editor + per-task `fallback_chain` editors in
   `settings-models-section.tsx`; provider picker reuse; legacy migration
   notice; Playwright E2E (add/remove/reorder, assert config written).
6. **Parity + WS removal**: run vitest parity suite, then Phase 3 cleanup
   (delete WS fallback path / CLI dependency), update
   `website/docs/user-guide/features/fallback-providers.md` port note.

## 9. Risks & open questions

- **No TS failover precedent** (kimi-code retries same provider only) — the
  turn-scoped restore + backoff-until-reset semantics are the riskiest novel
  logic; mitigate with the ~25 Python `_fallback_chain` tests as parity specs.
- **api_mode detection on fallback targets** (anthropic_messages /
  codex_responses / bedrock_converse / chat_completions) must be re-derived per
  candidate; Python does this inline in `try_activate_fallback` (lines
  2130–2173) — keep one `detectApiMode` shared with the LLM adapter plan.
- **Credential-pool interplay** (cross-provider contamination #33163/#33088,
  reset-aware restore) is owned by `plans/credential-pools.md` (#58); this plan
  only defines the rebind/clear hook.
- **Per-model `reasoning_config` re-resolution** on fallback
  (`test_fallback_reasoning_override.py`) and `_config_context_length` clearing
  must be ported or fallback swaps will inherit stale per-model overrides.
- **Open questions**: should desktop expose built-in discovery-chain editing
  (docs describe it as internal)? Should `hermes fallback add`'s auth
  snapshot/restore behavior be reproduced in the UI (currently the UI only
  writes config, never mutates `active_provider`)? Do subagent delegation and
  cron inheritance apply to the desktop standalone agent loop (out of scope for
  this plan — record in delegation plan)?

## 10. Test strategy

- **Vitest unit (pure)**: `chain.test.ts` (merge/dedup/legacy migration/copies),
  `error-classifier.test.ts` (pattern parity table), `backoff.test.ts`
  (ramp/cap/jitter/Retry-After), `identity.test.ts` (same-deployment rules).
- **Vitest integration (FallbackManager)**: fake LLM adapter returns
  429→429→success on fallback; assert swap, one-activation-per-turn,
  restore-on-next-turn, cooldown skips restore, exhausted chain arms cooldown,
  `pendingNotice` emitted once (parity with `test_24996_*`,
  `test_reset_aware_primary_restore.py`, `test_32646_*`).
- **Vitest integration (auxiliary)**: per-task ladder order, capacity vs
  transient 429, per-entry timeout, context screening, main-agent safety net
  (parity with `_try_configured_fallback_chain`/`_try_main_fallback_chain`
  tests).
- **Playwright E2E**: settings page — add fallback via picker (reuses
  `useProviderModels`), reorder/remove/clear, verify `config.yaml`
  `fallback_providers` written and legacy key dropped; auxiliary tab saves a
  `fallback_chain`.
- **Rust**: if secret-resolution command added, `#[cfg(test)]` + wiremock for
  `key_env` resolution; no real network.
- **Parity gate**: run the Python test files listed in §2.4 and keep the TS
  suite's assertions aligned (same fixtures: single-entry chain, same-as-primary
  rejection, credential isolation, reasoning override).

## 11. Reference links

- Python: `D:/hermes-agent-cn/hermes_cli/fallback_config.py`,
  `hermes_cli/fallback_cmd.py`, `run_agent.py`, `agent/agent_init.py`,
  `agent/chat_completion_helpers.py`, `agent/agent_runtime_helpers.py`,
  `agent/auxiliary_client.py`, `agent/error_classifier.py`,
  `agent/backend_identity.py`, `agent/secret_scope.py`, `cli.py`,
  `gateway/run.py`, `cron/scheduler.py`, `tui_gateway/server.py`.
- Docs: `D:/hermes-agent-cn/website/docs/user-guide/features/fallback-providers.md`.
- Tests: `D:/hermes-agent-cn/tests/hermes_cli/test_fallback_{cmd,config}.py`,
  `tests/run_agent/test_fallback_{credential_isolation,reasoning_override}.py`,
  `tests/run_agent/test_24996_fallback_exhaustion_cooldown.py`,
  `tests/run_agent/test_reset_aware_primary_restore.py`,
  `tests/run_agent/test_auth_provider_failover.py`,
  `tests/run_agent/test_32646_fallback_429_after_timeout.py`,
  `tests/gateway/test_fallback_chain_reload.py`, `tests/test_empty_model_fallback.py`.
- TS reference: `D:/kimi-code/packages/agent-core/src/loop/retry.ts`,
  `src/errors/{codes,serialize,classes}.ts`, `src/agent/turn/index.ts`,
  `src/session/{provider-manager.ts,subagent-batch.ts}`,
  `src/services/modelCatalog/{modelCatalog,modelCatalogService}.ts`,
  `src/services/auth/managedAuth.ts`.
- Desktop: `web/src/routes/settings-models-section.tsx`, `web/src/routes/settings.tsx`,
  `web/src/hooks/use-provider-models.ts`, `web/src/hooks/use-model-options.ts`,
  `web/src/hooks/use-gateway.ts`, `packages/protocol/src/hermes-api.ts`,
  `plans/agent-loop-llm-adapters.md`, `plans/provider-routing.md`.
