# External Memory Providers — Python → TypeScript Rewrite Plan

## 1. Summary

Hermes ships **8 external memory provider plugins** (Honcho, OpenViking, Mem0,
Hindsight, Holographic, RetainDB, ByteRover, Supermemory) that give the agent
persistent, cross-session knowledge beyond the built-in MEMORY.md / USER.md.
Only **one** external provider is active at a time (`memory.provider` in
`config.yaml`); the built-in memory always stays active alongside it. Selection
and configuration are driven by `hermes memory setup|status` (curses CLI) and,
in the Desktop, by a generic provider panel that renders each plugin's
*declared* config schema (`plugins/memory/config_schema.py`) over REST
(`/api/memory/providers/{name}/config|status|setup`), plus Honcho-only OAuth
connect (`/api/memory/providers/{name}/oauth/start|status`).

This plan ports the whole surface to TypeScript: a provider registry, a
`MemoryProviderAdapter` interface mirroring the Python ABC, 8 in-process
adapters, a one-active `MemoryProviderManager`, a declarative config-schema
renderer, a headless setup wizard, and a localhost OAuth service. The Desktop
today already shows OpenViking + Hindsight; the target is a registry-driven
panel for all 8. **kimi-code has no memory-provider feature to copy** (verified:
zero matches for memory-provider / honcho / mem0 / hindsight / retaindb /
byterover / supermemory / openviking outside a false-positive sha512 hash in
`pnpm-lock.yaml`) — its reusable value is the OAuth/PKCE machinery
(`packages/oauth`, `packages/agent-core/src/mcp/oauth/*`). Most providers now
ship official TS SDKs (web-verified), which lowers the port cost significantly;
OpenViking and Holographic must be implemented from scratch.

## 2. Current Python implementation

Source of truth: `D:/hermes-agent-cn`.

- **`agent/memory_provider.py`** (368 lines) — `MemoryProvider` ABC: lifecycle
  `is_available` / `initialize` / `system_prompt_block` / `prefetch` /
  `queue_prefetch` / `sync_turn` / `get_tool_schemas` / `handle_tool_call` /
  `shutdown`; optional hooks `on_turn_start`, `on_session_end`,
  `on_session_switch`, `on_pre_compress`, `on_memory_write`, `on_delegation`,
  `get_runtime_status`, `save_config`, `backup_paths`; plus `TRIVIAL_PROMPT_RE`
  / `is_trivial_prompt()` used to skip recall on greetings.
- **`agent/memory_manager.py`** — `MemoryManager` enforces **one external
  provider** (prevents tool-schema bloat/conflicts), registers provider tool
  schemas, routes tool calls, merges `prefetch_all` (external recall runs on a
  thread with 8 s timeout), serializes background `sync_all` /
  `queue_prefetch_all`, fans out session hooks, mirrors committed built-in
  memory writes via `notify_memory_tool_write()`, wraps recall in
  `<memory-context>` fences (`sanitize_context`, `build_memory_context_block`).
- **`plugins/memory/__init__.py`** (506 lines) — plugin discovery: bundled
  `plugins/memory/<name>/` + user-installed `$HERMES_HOME/plugins/<name>/`
  (bundled wins), `plugin.yaml` manifests, `discover_memory_providers()` →
  `(name, description, available)`, `load_memory_provider(name)` via
  `register(ctx)` collector or `MemoryProvider` subclass,
  `discover_plugin_cli_commands()` which registers the **active** provider's
  `cli.py` only.
- **`plugins/memory/config_schema.py`** (144 lines) — declarative provider
  config surface: `ProviderField` (kind text/select/secret/bool/number/json,
  `env_key`, `aliases`, `env_fallbacks`, `inline`, `group`, `when`, `scope`),
  `ProviderConfigSchema` with `storage` ∈ {`flat_json`, `honcho_host_block`},
  `get_provider_config_schema(name)` loaded by path (never imports the agent
  runtime). Honcho (`honcho/config_schema.py`, 324 lines) and Hindsight
  (`hindsight/config_schema.py`, 76 lines) declare schemas; the other six
  providers still expose the legacy dict `get_config_schema()`.
- **`hermes_cli/memory_setup.py`** (581 lines) — `hermes memory setup|status`:
  curses picker, `_install_dependencies()` (reads `plugin.yaml`
  `pip_dependencies`, calls `tools.lazy_deps.install_specs`; Hindsight
  `local_embedded` installs `hindsight-all`), generic schema walk, `post_setup`
  hook delegation (Honcho/Mem0/OpenViking/Supermemory/Hindsight), `.env` writer
  (`_write_env_vars`, chmod 0600, CR/LF-safe values), `cmd_status`.
- **`hermes_cli/memory_oauth.py`** (83 lines) — REST OAuth by convention:
  `plugins.memory.<provider>.oauth_flow` exposes `start_loopback_flow_background`
  + `get_flow_status()` (Honcho only today); profile-scoped via `_scope_to_profile`.
- **`hermes_cli/web_server.py`** — REST surface consumed by Desktop:
  - `GET /api/memory` (14024) — `active`, `providers`, `builtin_files`
  - `PUT /api/memory/provider` (line 14051) — activate (runs
    `_require_memory_provider_ready` first)
  - `GET /api/memory/providers/{name}/config?surface=declared` (line 6846) —
    declared schema or legacy provider payload (`_memory_provider_payload`)
  - `PUT /api/memory/providers/{name}/config` (line 6950) — save values,
    optional `activate`; dispatches on `ProviderConfigSchema.storage`
    (`_write_provider_honcho` / `_write_provider_flat`)
  - `GET /api/memory/providers/{name}/status` (line 6870) — calls
    `provider.get_runtime_status()`; falls back to a common
    `configured/reachable/healthy/endpoint/console_url/version/checked_at/
    error/details` snapshot
  - `POST /api/memory/providers/{name}/setup` (line 6928) — persist values +
    run `_install_memory_provider_setup` (pip + external deps)
  - `POST /api/memory/reset` (line 14069) — built-in files only
- **Provider plugins** (`plugins/memory/<name>/`):

| Provider | Plugin file(s) | Python deps | Storage / mode | Tools |
|---|---|---|---|---|
| Honcho | `honcho/` (`__init__.py` 75KB, `client.py`, `session.py`, `cli.py`, `oauth.py`, `oauth_flow.py`) | `honcho-ai` (`from honcho import Honcho`) | honcho.json host blocks (cloud/self-hosted), dialectic 2-layer context | 5: profile/search/context/reasoning/conclude |
| OpenViking | `openviking/__init__.py` (217KB) | `httpx` | self-hosted server; `OPENVIKING_*` env / ovcli.conf reuse | 6: search/read/browse/remember/forget/add_resource |
| Mem0 | `mem0/` (`__init__.py`, `_backend.py`, `_oss_providers.py`, `_setup.py`) | `mem0ai>=2.0.10,<3` | platform REST / self-hosted REST (`X-API-Key`, `/memories`, `/search`) / OSS in-process | 4: search/add/update/delete |
| Hindsight | `hindsight/__init__.py` (115KB), `config_schema.py` | `hindsight-client>=0.6.1` or `hindsight-all` (local) | cloud API or local embedded PostgreSQL | 3: retain/recall/reflect |
| Holographic | `holographic/` (`__init__.py`, `store.py`, `retrieval.py`, `holographic.py`) | none (SQLite; numpy optional) | local `memory_store.db` (FTS5 + HRR) | 2: fact_store, fact_feedback |
| RetainDB | `retaindb/__init__.py` (35KB) | `requests` | cloud REST, `RETAINDB_API_KEY` | 10: profile/search/context/remember/forget + 5 file tools |
| ByteRover | `byterover/__init__.py` | `brv` CLI (external dep) | local tree `$HERMES_HOME/byterover/` via `brv query/curate/status` | 3: query/curate/status |
| Supermemory | `supermemory/__init__.py` (46KB) | `supermemory` (optional; urllib REST) | supermemory.json; cloud/self-hosted; `/v4/search`, `/v4/profile`, `/v4/conversations` | 4: store/search/forget/profile |

- **Docs**: `website/docs/user-guide/features/memory-providers.md` (682 lines,
  full comparison + per-provider config tables), `.../features/honcho.md`
  (architecture: two-layer injection, dialectic depth, gateway identity
  mapping, observation).
- **Tests (parity source)**: `tests/plugins/memory/` (20 files: mem0, hindsight,
  holographic, byterover, retaindb, supermemory, openviking, config schema,
  lazy install), `tests/honcho_plugin/` (13 files incl. oauth/oauth_flow/cli/
  client/session/pin_peer_name/network_isolation), `tests/openviking_plugin/`,
  top-level `tests/test_honcho_client_{concurrency,config}.py`,
  `test_honcho_session_context.py`, `test_honcho_startup_fail_open.py`.

## 3. Target TypeScript design

New module set `web/src/lib/external-memory/` (in-process, no Python):

- `types.ts` — `MemoryProviderAdapter` interface mirroring the Python ABC:
  `name`, `isAvailable()`, `initialize(opts)` (sessionId, hermesHome, platform,
  agentIdentity...), `systemPromptBlock()`, `prefetch(query, opts?)`,
  `queuePrefetch(query, opts?)`, `syncTurn(user, assistant, opts?)`,
  `onSessionEnd(messages)`, `onSessionSwitch(next, prev, reset)`,
  `onPreCompress(messages)`, `onMemoryWrite(action, target, content, metadata?)`,
  `getToolSchemas()` (OpenAI function-calling shape), `handleToolCall(name, args)`,
  `getRuntimeStatus()`, `saveConfig(values, hermesHome)`, `shutdown()` — every
  method that blocks in Python becomes async in TS.
- `registry.ts` — provider catalog (name, label, description, icon, manifest
  equivalent of `plugin.yaml`, `dependenciesInstalled` probe). Static array of
  the 8 bundled providers replaces filesystem discovery; user-installed
  providers become a later extension (plugin manifest JSON + dynamic import).
- `config-schema.ts` — `ProviderField` / `ProviderConfigSchema` types and the
  two storage backends (`flatJson`, `honchoHostBlock`); pure-data parser with
  the same `when`/`aliases`/`envFallbacks`/`inline`/`group` semantics as
  `plugins/memory/config_schema.py` so the generic panel renders unchanged.
- `manager.ts` — `MemoryProviderManager`: loads the active provider from
  `memory.provider`, enforces **one active**, merges `prefetch` results into
  `<memory-context>` fences, serializes background sync, fans out session hooks,
  mirrors built-in memory writes (consumes the same event the
  `built-in-bounded-memory` plan emits), exposes `getRuntimeStatus` for the UI.
- `adapters/{honcho,openviking,mem0,hindsight,holographic,retaindb,byterover,
  supermemory}.ts` — one adapter per provider; each owns its config file format,
  client, tools, prefetch/sync policy (ported from the Python plugin).
- `clients/` — thin HTTP/process clients: `honcho.ts`, `mem0.ts`,
  `hindsight.ts`, `supermemory.ts`, `retaindb.ts` (fetch, versioned per
  provider), `openviking.ts` (fetch + SSRF guard ported from
  `test_openviking_endpoint_always_blocked.py`), `byterover.ts` (spawns `brv`
  via a Tauri child-process command), `holographic.ts` (Rust SQLite IPC).
- `oauth/` — `memory-oauth-service.ts` (loopback listener + device-code poll +
  token store per credential), modeled on kimi-code
  `packages/agent-core/src/mcp/oauth/{service,provider,callback-server}.ts`;
  `flows/honcho.ts` implements the convention
  `start_loopback_flow_background` / `get_flow_status`.
- `setup.ts` — declarative setup wizard (picker + field walk + `.env` write +
  dependency install), the headless replacement for the curses CLI; exposed to
  the UI as a step-by-step modal.
- `runtime-status.ts` — health-probe model matching
  `MemoryProviderRuntimeStatusResponse` (configured/reachable/healthy/endpoint/
  consoleUrl/version/checkedAt/error/details).

Data flow (in-process turn): agent loop → `MemoryProviderManager.prefetchAll`
→ adapter `prefetch` (bounded timeout) → fenced `<memory-context>` injected by
the agent prompt assembler → model → `syncTurn` → background adapter write →
`onSessionEnd`/`onPreCompress`/`onMemoryWrite` hooks fan out to the active
adapter.

## 4. Data models & persistence

Keep **byte-compatible on-disk formats** with Python so a profile can switch
between the managed runtime and the in-process runtime without data loss:

- `config.yaml` — `memory.provider` (active) + `memory.<provider>` blocks
  (non-secret settings). Reuse the existing `hermes_cli.config` writer via Rust
  (`src/env_file.rs` / `src/state.rs`) or a new Rust `memory_config` command.
- `.env` (per profile) — secrets (`HONCHO_API_KEY`, `MEM0_API_KEY`,
  `HINDSIGHT_API_KEY`, `RETAINDB_API_KEY`, `SUPERMEMORY_API_KEY`,
  `OPENVIKING_*`, `BRV_API_KEY`). Keep the 0600 chmod + CR/LF-safe line writer
  parity (`memory_setup._write_env_vars`). Long-term option: OS keychain via a
  new Rust command, keeping `.env` as the migration-era source of truth.
- Provider-native files (unchanged schemas):
  - `honcho.json` — root fields + `hosts.<profile>` blocks, `sessions`
    overrides (Honcho SDK native format; `STORAGE_HONCHO_HOST_BLOCK`)
  - `mem0.json` (mode/host/user_id/agent_id/rerank); `hindsight/config.json` (mode/bank_id/recall_budget/..., `config_schema`)
  - `supermemory.json` — base_url/container_tag/auto_recall/... 
  - `$HERMES_HOME/byterover/` — brv context tree (git-style, profile-scoped)
  - `memory_store.db` — Holographic SQLite; **preserve the Python schema**
    (tables/columns/FTS5 virtual table from `holographic/store.py`, HRR vector
    columns) so existing DBs open unchanged. Implement in Rust
    (`rusqlite` + FTS5) behind a Tauri IPC command; no schema migrations
    needed at port time.
- Secrets never round-trip through the web layer: only an `is_set` flag is
  surfaced (already the Desktop contract in `MemoryProviderConfigField`).

## 5. Third-party library strategy

kimi-code evidence: no provider SDKs or memory-provider code exist in the repo
(grep over `D:/kimi-code` for `memory provider`, `honcho`, `mem0`,
`hindsight`, `retaindb`, `byterover`, `supermemory`, `openviking` → only a
false-positive base64 hash in `pnpm-lock.yaml`). What kimi-code **does** give
us is OAuth: `packages/oauth/src/oauth.ts` (device-code HTTP wrappers,
`requestDeviceAuthorization`/`pollDeviceToken`/`refreshAccessToken`),
`packages/oauth/src/identity.ts` (device-id + header factories),
`packages/agent-core/src/mcp/oauth/provider.ts` (PKCE verifier/state,
per-credential JSON token store, `OAuthTokenTransaction`),
`packages/agent-core/src/mcp/oauth/service.ts` (single-flight refresh,
proactive refresh sweep, one-flow-per-credential serialization),
`.../oauth/callback-server.ts` (localhost callback listener).

| Python dep | TS equivalent | kimi-code evidence | Notes |
|---|---|---|---|
| `honcho-ai` SDK | **`@honcho-ai/sdk`** (official npm, web-verified) | none | Must map Python API surface (`Honcho`, peer/session/context/dialectic) to TS SDK; plugin's own `client.py`/`session.py` wrapper becomes `clients/honcho.ts` so tests stay isolated from SDK |
| `mem0ai` (platform + OSS) | **`mem0ai` npm** (`MemoryClient` + `mem0ai/oss`), web-verified | none | Self-hosted dashboard REST (`X-API-Key`, `/memories`, `/search`) is stable — implement `clients/mem0.ts` REST for platform/selfhosted parity; use `mem0ai/oss` only if OSS mode in scope |
| `httpx` (openviking) | fetch (builtin) | none (no OpenViking SDK found) | Implement `clients/openviking.ts` from scratch; keep endpoint SSRF guard + ovcli.conf env fallbacks |
| `hindsight-client` / `hindsight-all` | **`@vectorize-io/hindsight-client`** (official npm, web-verified) | none | Cloud mode maps 1:1 (retain/recall/reflect). `local_embedded` (embedded PostgreSQL daemon) has **no TS equivalent** — ship cloud + `local_external` modes, mark embedded out of scope or spawn a managed `uvx hindsight-embed` child process |
| `requests` (retaindb) | **`@retaindb/sdk`** (official npm, web-verified) or plain fetch | none | Python plugin is plain REST (`_Client` in `retaindb/__init__.py`); prefer REST parity, SDK optional |
| `supermemory` | **`supermemory` npm** (official, web-verified) | none | TS SDK supports `baseURL` for self-hosted; keep `/v4/conversations` ingest + context fencing ported from plugin |
| `brv` CLI (external dep) | spawn `brv` via Tauri child-process command | none (kimi-code has child-process helpers in `apps/kimi-code/src/native`) | **Best-fit case**: `brv` is a Node CLI (`npm i -g byterover-cli`) — TS spawns it natively, replacing `subprocess.run`; note Windows needs WSL2 |
| SQLite + numpy (holographic) | Rust `rusqlite` (FTS5) + pure-TS HRR algebra | none | `store.py`/`retrieval.py` port to Rust SQLite + a small `hrr.ts` math module (numpy → typed arrays); no npm dep needed |
| OAuth (honcho loopback/device) | kimi-code `packages/oauth` device flow + `agent-core/src/mcp/oauth/*` PKCE orchestrator | **direct reference** | Reuse callback-server + token-transaction patterns; Desktop already has the UI (see §6) |

## 6. Integration with existing Hermes-CN-Desktop frontend

- `web/src/hooks/use-memory.ts` — today `VISIBLE_MEMORY_PROVIDERS =
  ["openviking","hindsight"]` and every call goes to REST
  (`/api/memory`, `/api/memory/providers/{name}/config|status|setup`,
  `/api/memory/provider`). Replace with a `useExternalMemoryProvider` hook
  backed by `MemoryProviderManager` in-process (keep the same query/mutation
  shape so the panel components barely change).
- `web/src/routes/external-memory.tsx` + `app.tsx` — extend
  `ExternalMemoryRouteProps.page` from a 2-union to the registry of 8 (or a
  dynamic `/:provider` route); add routes for honcho/mem0/holographic/retaindb/
  byterover/supermemory alongside the existing `/openviking`, `/hindsight`,
  `/memconfig`.
- `web/src/components/memory/*` — `memory-backends-panel.tsx` (switcher +
  status cards; make it registry-driven), `memory-provider-config.tsx`
  (declared-schema renderer; add `secret`/`json`/`number` field kinds the
  Python schema already defines but the current `kind` enum lacks),
  `memory-provider-status.tsx`, `memory-backend-utils.ts` (extend
  `MEMORY_BACKEND_META` + `ADVANCED_FIELDS` to 8 providers), new
  `memory-setup-wizard.tsx` modal.
- `web/src/components/app-shell/external-memory-sidebar.tsx` — extend
  `EXTERNAL_MEMORY_ITEMS` with the new provider entries.
- OAuth: reuse `web/src/hooks/use-oauth-providers.ts` +
  `web/src/routes/settings-oauth-section.tsx` (device_code/pkce/loopback UI
  already built for model providers) against the memory endpoints
  `/api/memory/providers/{name}/oauth/start|status`; `web/src/lib/
  connection-auth-events.ts` already broadcasts `hermes:connection-auth-restored`
  for reconnect-after-auth flows.
- `packages/protocol/src/hermes-api.ts` — extend
  `MemoryProviderRuntimeStatusResponse.details` discriminated union beyond
  `openviking`/`hindsight` (add honcho/mem0/holographic/retaindb/byterover/
  supermemory kinds) and widen `MemoryProviderConfigField.kind` to
  `"number"|"json"|"secret"` as declared by Core.
- Rust (`src/commands/`): new commands — `memory_provider_config` /
  `memory_provider_status` / `memory_provider_setup` (config.yaml + provider
  files + `.env`), `run_brv` (child process), `sqlite_holographic`; may proxy
  to existing REST (`api_request`) first, then flip in-process.

## 7. Removing the WebSocket dependency (migration path)

Freeze this REST surface as the migration contract (already implemented and
used by the Desktop today):

- `GET /api/memory` — active provider + provider list + builtin file sizes
- `PUT /api/memory/provider` — activate (with readiness gate)
- `GET/PUT /api/memory/providers/{name}/config[?surface=declared]`
- `GET /api/memory/providers/{name}/status`, `POST .../setup`,
  `POST/GET .../oauth/start|status`

Phases:
1. **Keep backend call today** — no change; the Desktop already talks REST.
2. **Same interface, two implementations** — introduce
   `MemoryProviderBridge` with `RESTMemoryProviderBridge` (current behavior)
   and `InProcessMemoryProviderBridge` (manager + adapters); `use-memory.ts`
   and the OAuth hook select the implementation behind one interface. Provider
   config/status/setup responses must be byte-identical to today's Zod
   schemas.
3. **Flip per provider** — land adapters one at a time; the manager reads the
   same `config.yaml`/`.env`/provider files so switching the active provider
   between runtimes is lossless.
4. **Delete WS/REST path** — once every provider + setup + OAuth is in-process,
   remove `/api/memory*` calls; keep REST as an optional remote-profile mode
   (`HERMES_REMOTE_BACKEND_URL`), not the default.

During migration, the **frozen API surface is the test oracle**: both bridges
must satisfy the same vitest contracts (see §10).

## 8. Migration phases & task breakdown

- **P0 — Foundations**: `types.ts`, `config-schema.ts` parser + unit parity vs
  `test_config_schema.py` / `test_honcho_config_schema.py`; `registry.ts`;
  `MemoryProviderManager` skeleton with one-active enforcement; extend protocol
  Zod types (§6).
- **P1 — REST bridge**: `RESTMemoryProviderBridge` wrapping today's endpoints;
  refactor `use-memory.ts` to consume the bridge; no behavior change.
- **P2 — Local-first adapters** (no external daemons): `holographic.ts`
  (Rust SQLite + FTS5 + HRR), `byterover.ts` (spawn `brv`), `supermemory.ts`
  (npm SDK, self-host friendly), `retaindb.ts` (REST).
- **P3 — Cloud adapters**: `honcho.ts` (`@honcho-ai/sdk` + host-block config +
  dialectic/context cadence), `mem0.ts` (platform/selfhosted REST), 
  `hindsight.ts` (`@vectorize-io/hindsight-client`, cloud + local_external),
  `openviking.ts` (fetch + SSRF guard + ovcli.conf fallback).
- **P4 — Setup wizard & dependency install**: `setup.ts` + `memory-setup-wizard
  .tsx`; port `_install_dependencies` semantics to npm/uvx/brv checks;
  per-provider `post_setup` equivalents.
- **P5 — OAuth**: `memory-oauth-service.ts` (loopback + device) reusing
  kimi-code patterns; Honcho flow; UI reuse of `settings-oauth-section.tsx`;
  wire `connection-auth-events.ts` for re-auth restore.
- **P6 — Runtime status/UI + cutover**: per-provider `getRuntimeStatus` +
  `details` Zod kinds; registry-driven panel/sidebar/routes; flip bridge to
  in-process, delete WS/REST path (keep remote-profile fallback); update docs.
- **P8 — Full parity suite**: run the §10 test matrix against both bridges and
  the Python runtime (opt-in `HERMES_REAL_BACKEND_URL` style E2E).

## 9. Risks & open questions

- **"No TS equivalent found" — verified gaps:**
  - **kimi-code has no memory-provider code at all**; OpenViking and
    Holographic have no SDK anywhere we verified — implement from scratch.
  - **Hindsight `local_embedded`** (embedded PostgreSQL daemon via
    `hindsight-all`) has no TS equivalent; cloud + local_external only, or a
    managed `uvx hindsight-embed` child process (new surface).
  - **OpenViking**: no official TS SDK found (REST only); server itself is
    external (AGPL-3.0) — desktop ships the client, never the server.
  - **ByteRover on Windows**: `brv` officially requires WSL2 on Windows
    (native cmd/PowerShell unsupported) — same limitation as Python today;
    must surface a clear "requires WSL2" setup hint.
- **TS SDK surface drift**: official TS SDKs are newer than pinned Python
  versions; plugin custom wrappers (`honcho/client.py`, `mem0/_backend.py`)
  define the parity contract — keep clients behind our interfaces, pin versions.
- **Mem0 OSS mode**: `mem0ai/oss` (TS) may not cover the exact Python OSS
  provider matrix (qdrant/pgvector/ollama) — decide whether OSS mode ships in
  v1 or is flagged "desktop unsupported, use platform/selfhosted".
- **OAuth on desktop**: loopback callback listeners + opening the external
  browser from the Tauri webview; the webview may block `http://127.0.0.1`
  callbacks — prefer device-code when loopback is unavailable (Honcho already
  auto-selects device on headless boxes; mirror that logic).
- **Secrets**: `.env` is the migration source of truth; OS keychain is a
  follow-up. Profile scoping must honor `HERMES_HOME` per profile exactly like
  `memory_oauth._scope_to_profile`.
- **HRR/numpy port**: HRR circular-convolution algebra needs numerical parity
  tests against `holographic/retrieval.py` (float tolerance, not exact match).
- **`hermes memory off` / `memory.provider: ""`**: keep the empty-provider path
  (built-in only) first-class in the manager and UI.
- **`plugin.yaml`-style install surface**: user-installed providers are
  out-of-scope for v1 (static registry of 8); design the manifest schema now so
  dynamic loading can be added later.

## 10. Test strategy

vitest unit + integration (mirror the Python files 1:1), Playwright E2E, Rust
tests:

- **Config schema parity**: `tests/plugins/memory/test_config_schema.py`,
  `test_honcho_config_schema.py` → `config-schema.ts` parser tests (kinds,
  aliases, env_fallbacks, when, inline/group, honcho host-block storage).
- **Honcho** (11-file suite + 4 top-level): `test_client.py`,
  `test_honcho_client_config.py`, `test_honcho_client_concurrency.py` →
  `clients/honcho.ts` (mock fetch); `test_startup_fail_open.py` /
  `test_session_context.py` → fail-open prefetch + session mapping;
  `test_oauth.py` / `test_oauth_flow.py` → `oauth/flows/honcho.ts` loopback +
  device code (mock HTTP server); `test_network_isolation.py` → SSRF/loopback
  guard.
- **Mem0**: `test_mem0_backend.py` (platform/selfhosted REST, X-API-Key),
  `test_mem0_providers.py`, `test_mem0_setup.py`, `test_mem0_v3.py`.
- **Hindsight**: `test_hindsight_provider.py`, `test_hindsight_env_perms.py`
  (.env perms/redaction), config-schema walk.
- **Holographic**: `test_holographic_store.py`, `test_holographic_retrieval.py`
  (FTS5 + HRR), `test_holographic_auto_extract.py`, 
  `test_holographic_shutdown_closes_db.py` (Rust: `tempfile::TempDir`, no
  network; serde parity for rows).
- **OpenViking**: `test_openviking_provider.py`, `test_openviking_shutdown.py`,
  `test_openviking_endpoint_always_blocked.py` (endpoint must never be
  reachable → SSRF regression test in `clients/openviking.ts`).
- **RetainDB / Supermemory / ByteRover**: `test_retaindb_provider.py`,
  `test_supermemory_provider.py`, `test_byterover_provider.py` (mock REST /
  mock `brv` child process), `test_memory_lazy_install.py` →
  `setup.ts` dependency-availability probe.
- **UI/E2E (Playwright)**: config panel for all 8 providers, setup wizard,
  activate/switching (one-active), OAuth device + loopback flows,
  `memory-backends-panel.test.tsx` parity, sidebar/route coverage.
- **Parity matrix**: each behavior test runs against `RESTMemoryProviderBridge`
  (with the real backend via opt-in env) and `InProcessMemoryProviderBridge`;
  assert identical responses against the frozen Zod schemas.

## 11. Reference links

- `D:/hermes-agent-cn/agent/memory_provider.py`, `agent/memory_manager.py`
- `D:/hermes-agent-cn/plugins/memory/__init__.py`, `plugins/memory/config_schema.py`
- `D:/hermes-agent-cn/plugins/memory/{honcho,openviking,mem0,hindsight,holographic,retaindb,byterover,supermemory}/`
- `D:/hermes-agent-cn/hermes_cli/memory_setup.py`, `hermes_cli/memory_oauth.py`,
  `hermes_cli/web_server.py` (memory routes at lines 6846/6870/6928/6950/14024/14051/14069)
- `D:/hermes-agent-cn/website/docs/user-guide/features/memory-providers.md`,
  `.../features/honcho.md`
- `D:/hermes-agent-cn/tests/plugins/memory/`, `tests/honcho_plugin/`,
  `tests/openviking_plugin/`, `tests/test_honcho_*.py`
- `D:/kimi-code/packages/oauth/src/{oauth.ts,device.ts,identity.ts}`,
  `packages/agent-core/src/mcp/oauth/{service.ts,provider.ts,callback-server.ts}`
- `D:/Hermes-CN-Desktop/web/src/{routes/external-memory.tsx,hooks/use-memory.ts,hooks/use-oauth-providers.ts,lib/connection-auth-events.ts}`,
  `web/src/components/memory/*`, `web/src/components/app-shell/external-memory-sidebar.tsx`,
  `packages/protocol/src/hermes-api.ts`, `src/commands/memory.rs`
- TS SDKs (web-verified, absent from kimi-code): `@honcho-ai/sdk`, `mem0ai`
  (+`mem0ai/oss`), `@vectorize-io/hindsight-client`, `supermemory`,
  `@retaindb/sdk`, `byterover-cli` (brv)
