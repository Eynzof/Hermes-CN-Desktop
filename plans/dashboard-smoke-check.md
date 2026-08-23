# Dashboard Smoke Check — Python → TypeScript Rewrite Plan

## 1. Summary

Replace the Python CLI's `hermes dashboard --no-open` mode (spawn → print
`HERMES_DASHBOARD_READY port=<n>` → serve) with a **TS/Rust smoke-check suite**
that verifies the Dashboard API from inside the Hermes-CN-Desktop monorepo,
for the in-process (no-Python-backend) runtime end-state. Today the desktop
Rust side already probes the spawned Python dashboard (`probe_dashboard`,
`probe_spawned_dashboard_ready`, WS handshake, `/openapi.json`); this plan
formalizes that ad-hoc probing into a first-class `dashboard-smoke` module
that (a) runs the same health probes against the in-process server, (b)
verifies the fork-specific Dashboard API surface (`/api/status` components
rollup, `/openapi.json`, `/api/ws` handshake, authenticated `/api/sessions`,
`/api/upload` presence, `X-Hermes-Profile`), and (c) emits a typed
`DashboardSmokeResult` consumed by bootstrap (`runtime-status: ready`), the
Health route, and a standalone `pnpm smoke:dashboard` gate for CI.

API surface to freeze during migration: `GET /api/status` (public fields +
`components` rollup + loopback-only host metadata), `GET /openapi.json`,
`GET /api/sessions?limit=1` (authenticated self-test), the `/api/ws` gateway
handshake, the fork P-002 `/api/upload` path presence, `X-Hermes-Session-Token`
/ `X-Hermes-Profile` headers, and the ready sentinels
`HERMES_DASHBOARD_READY` / `HERMES_BACKEND_READY` (superseded by a TS
server-registry record).

Key decision: health *probing* stays mostly in Rust (existing `reqwest` +
`tokio-tungstenite` code already does TCP/HTTP/WS probes), while the *smoke
orchestration, endpoint verification, and reporting* live in TS
(`web/src/lib/dashboard-smoke/`), so the UI and CI share one typed report.
kimi-code's `kap-server` (Fastify `startServer` + instance registry heartbeat +
`native/smoke.ts` env-gated smoke) is the TS reference; it has **no
`/api/status`-equivalent components/health endpoint**, so the rollup/self-test
portion is built from scratch (section 5).

## 2. Current Python implementation

- CLI surface: `D:/hermes-agent-cn/hermes_cli/subcommands/dashboard.py`
  - `dashboard` parser adds `--no-open` (line 107), `--port` (default 9119),
    `--host` (default 127.0.0.1), `--skip-build`, `--isolated`, `--stop`,
    `--status`, hidden `--tui` compat shim (line 120), `--open-profile`.
  - `serve` is the headless twin: `set_defaults(func=cmd_dashboard,
    no_open=True, headless_backend=True)` (line 170) — the desktop spawns
    `serve`/`dashboard`, never the browser.
- Handler: `D:/hermes-agent-cn/hermes_cli/main.py:cmd_dashboard()` (line
  10442): `--status`/`--stop` short-circuit; env sanitization (strip inherited
  packaged `HERMES_WEB_DIST`, unset `HERMES_SERVE_HEADLESS`); named-profile
  re-exec guard (lines 10524-10603) keyed on `HERMES_DESKTOP`,
  `HERMES_DESKTOP_MANAGED`, `HERMES_HOME` inside `profiles/<name>`, `--isolated`,
  `--open-profile`; fastapi/uvicorn availability check; skill seeding; terminal
  env bridge; SPA build or `--skip-build`; finally
  `start_server(..., open_browser=not args.no_open, headless=_headless_backend)`.
- Server + readiness: `D:/hermes-agent-cn/hermes_cli/web_server.py`
  - `start_server` (~line 19237): uses `uvicorn.Server` directly; after
    `server.startup()` the socket is bound, `_read_bound_port` reads the real
    port, `_write_dashboard_ready_file` writes the ready file, then prints
    `HERMES_DASHBOARD_READY port=<n>` (or `HERMES_BACKEND_READY` for headless)
    with `flush=True` (lines 19327-19332) — this stdout line is what the
    desktop/e2e harness treats as "ready". Browser open is skipped by
    `--no-open`. Windows runs on uvicorn's SelectorEventLoop factory
    (lines 19387-19428). Parent-death watchdog + orphan reaping
    (lines 19301-19322), 2s loop-heartbeat stall detector (lines 19363-19381).
  - `GET /api/status` (line 3717): in `PUBLIC_API_PATHS` (no auth). Public
    body: `version`, `release_date`, `config_version`, `latest_config_version`,
    `gateway_running/state/platforms/exit_reason/updated_at/busy/drainable`,
    `active_sessions`, `active_agents`, `auth_required/providers/flows`,
    `nous_session_valid`, `profiles`, `gateway_mode`. `components` rollup
    (lines 3950-3986): `gateway`, `dashboard` (`DASHBOARD_HEALTH.snapshot()`),
    `storage` (read-only 1s-bounded `_probe_state_db`), `platforms`, and
    `overall` = `ok` iff every component is `ok`. Loopback-only (auth off)
    fields: `hermes_home`, `config_path`, `env_path`, `gateway_pid`,
    `gateway_health_url` (lines 4038-4044).
  - `DashboardHealth` (lines 869-919): rolling 300s window of unhandled
    exceptions / 5xx recorded by `_dashboard_health_middleware` (lines
    922-938), plus `selftest_status: unknown|ok|failing` fed by
    `_dashboard_selftest_loop` (lines 974-987) which every 60s makes an
    in-process authenticated `GET /api/sessions?limit=1` via `httpx.ASGITransport`
    (skipped while the OAuth gate is active). Catches "liveness looks fine but
    every authenticated request 500s".
- Tests (parity source): `D:/hermes-agent-cn/tests/test_cmd_dashboard_reexec.py`
  — asserts the re-exec suppression matrix for Desktop-managed launches:
  `HERMES_DESKTOP`, `HERMES_DESKTOP_MANAGED`, `HERMES_HOME` in `profiles/`,
  `--isolated`, `--open-profile`, default/custom profile. These are the
  spawn-guard semantics the TS/Rust side must preserve (section 8, task 6).
- Docs: `D:/hermes-agent-cn/README.md` — the fork "面向桌面端的 Dashboard
  后端" contract (attachments, workspace, MCP summaries, profile read/write,
  SSE+POST gateway transport) is the endpoint surface the smoke check must pin.

## 3. Target TypeScript design

Module layout:

```
web/src/lib/dashboard-smoke/
  index.ts            runDashboardSmoke(origin, opts): Promise<DashboardSmokeResult>
  health-probes.ts    portProbe / statusProbe / openapiProbe / wsHandshakeProbe
  endpoint-checks.ts  fork API verification (sessions, upload presence, profile header)
  selftest.ts         in-process authenticated route check (DASHBOARD_HEALTH analog)
  report.ts           DashboardSmokeResult zod schema + overall rollup
packages/runtime/
  server-registry.ts  TS instance registry (kimi-code instanceRegistry analog):
                      register/unregister/heartbeat, replaces ready-file + desktop-owner.json
src/commands/smoke.rs (Rust) — Tauri command run_dashboard_smoke → reuses existing
                      probe_* from src/process/dashboard.rs for out-of-process/loopback use
```

Data flow (in-process runtime, no Python backend):

1. Bootstrap (`src/bootstrap.rs` → `acquire_managed_dashboard` replacement)
   starts the embedded server through a TS runtime host (kap-server-style
   `startServer({ host: '127.0.0.1', port })` → `RunningServer { host, port,
   close }`).
2. `server-registry.ts` registers `{ pid, host, port, startedAt,
   serverVersion }` and starts a 15s heartbeat — this replaces
   `HERMES_DASHBOARD_READY port=<n>` and `desktop-owner.json` as the readiness
   handshake (kimi-code `instanceRegistry.ts` evidence).
3. `runDashboardSmoke(origin)` runs, in order:
   - `portProbe` — TCP connect (Rust `probe_dashboard_port` parity; in TS
     `net.connect` with 900ms timeout).
   - `statusProbe` — `GET /api/status` must return 2xx or 401; parse with the
     existing `StatusResponse` zod schema; assert `components.overall` field
     shape and loopback-only fields when `auth_required === false`.
   - `openapiProbe` — `GET /openapi.json` 2xx (cold-start fallback parity with
     `probe_spawned_dashboard_ready`).
   - `wsHandshakeProbe` — connect `/api/ws?token=...` and drop immediately
     (parity with Rust `dashboard_supports_ws`, 4s bound).
   - `endpoint-checks` — fork surface: `/api/upload` present in openapi paths
     (P-002 drift guard from `e2e/README.md`), authenticated
     `GET /api/sessions?limit=1` with `X-Hermes-Session-Token` returns 200,
     `X-Hermes-Profile` header accepted on a non-default profile.
   - `selftest.ts` — in-process analog of `_dashboard_selftest_loop`: every
     60s, one authenticated request through the server's own handler (Fastify
     `app.inject`, or a loopback `fetch` to the bound socket) and fold the
     result into the `components.dashboard` snapshot.
4. `report.ts` rolls checks into `DashboardSmokeResult { ok, overall,
   checks[], components, at }`; bootstrap maps `overall === 'ok'` to the
   existing `runtime-status: ready` event; a failing result becomes
   `runtime-status: error` with a retry policy mirroring
   `SPAWN_ATTEMPT_LIMIT` (3 attempts).

Rust side stays responsible for OS-level probing of *attached* backends
(`probe_attached_dashboard`, remote/local connect paths in `bootstrap.rs`),
while TS owns the in-process smoke orchestration; both emit the same
`DashboardSmokeResult` shape so the UI/CI do not care which path produced it.

## 4. Data models & persistence

- `DashboardSmokeResult` (new zod schema in `packages/protocol/src/hermes-api.ts`
  or `dashboard-smoke/report.ts`): `{ ok: boolean, overall: 'ok'|'degraded'|'failing',
  at: ISO string, checks: Array<{ id, label, ok, status?, latencyMs?, detail? }>,
  components: { gateway?, dashboard?, storage?, platforms? } }` — mirrors the
  public-safe `components` payload of `/api/status` (counts/enums only, no
  secrets), matching the Python `DASHBOARD_HEALTH.snapshot()` contract.
- Server instance registry: `packages/runtime/server-registry.ts` writes
  `<dataDir>/server/instances/<serverId>.json` with
  `{ server_id, pid, host, port, started_at, heartbeat_at, server_version }`
  (kimi-code `instanceRegistry.ts` disk shape, camelCase in memory). This
  **replaces** `desktop-owner.json` (schema_version 1, run_id, desktop_pid,
  dashboard_pid, api_base_url, hermes_home, runtime_root, gateway_runtime_dir,
  started_at_ms, runtime_version, claimed_ports) — a migration maps
  `dashboard_pid`/`api_base_url`/`hermes_home` into the registry record.
- Persistence strategy: JSON files only (no SQLite migration). HERMES_HOME /
  config stays on the existing config.yaml path; the smoke report is
  ephemeral (in-memory, refreshed on demand + every 15s by `useStatus`).
- `StatusResponse` zod schema already exists (`packages/protocol/src/hermes-api.ts`
  lines 32-60) and is reused verbatim by the smoke `statusProbe` — no schema
  churn, and the loopback-only optional fields (`gateway_pid`,
  `gateway_health_url`) are already handled for gated binds.

## 5. Third-party library strategy

| Python dependency | Role | TS equivalent | kimi-code evidence |
|---|---|---|---|
| fastapi / uvicorn | HTTP/WS server the smoke checks | `fastify` + `@fastify/ws` in-process server (`packages/kap-server/src/start.ts`: Fastify app, WS v1 upgrade handling, host/origin/auth hooks, `RunningServer { host, port, close }`) | `packages/kap-server/src/start.ts` lines 311-341, 491-541 |
| httpx `ASGITransport` selftest | In-process authenticated self-check | Fastify `app.inject()` (in-process route invoke, no socket) — **no TS equivalent in kimi-code**; implement from scratch | — (kimi-code has no selftest loop; closest is `configService.ready` wait in start.ts lines 411-418) |
| uvicorn ready line + ready file | Readiness handshake | `server-registry.ts` instance file + heartbeat | `packages/kap-server/src/instanceRegistry.ts` (register/release/heartbeat 15s, dead-pid sweep); `cli/sub/web/run.ts` `onReady` hook prints "server ready" |
| `DashboardHealth` counters/selftest | Health rollup in `/api/status` | `report.ts` + `selftest.ts` (from scratch) | — (kimi-code has no `/health`/components endpoint; `shared.ts` docstring says it "owns health/readiness probes" but they are delegated to startServer + registry) |
| — (Rust probes: reqwest, tokio-tungstenite) | TCP/HTTP/WS probes | keep in Rust; TS mirror uses `net.connect`, `fetch` (Node 22 native/undici), `ws` (or native WebSocket) for the web-facing layer | `apps/kimi-code/src/native/smoke.ts` (env-gated smoke, ready handshake with `AbortSignal.timeout(15_000)`) |
| webbrowser (skipped by `--no-open`) | Open browser | removed — `--no-open` semantics become the default in-process behavior; `onReady` fires instead | `cli/sub/web/run.ts` `--no-open` option (line 156) + `onReady` hook (lines 172-196) |

**"No TS equivalent found" risks (explicit):**
1. `httpx.ASGITransport`-style in-process self-test — kimi-code has no analog;
   plan uses Fastify `app.inject` (needs a small adapter if the TS runtime is
   not Fastify-based, e.g. hyper-in-Rust → loopback fetch instead).
2. `/api/status` components health rollup — kimi-code exposes `/api/v1/meta`
   but no per-component health/self-test counters; `report.ts`/`selftest.ts`
   are new design, parity against Python `DashboardHealth` behavior only.
3. `/api/upload` presence check is fork-specific (P-002); kimi-code has no
   such endpoint — the check stays Rust `has_openapi_path` / TS openapi scan.

## 6. Integration with existing Hermes-CN-Desktop frontend

- Reuse `web/src/routes/health.tsx` + `HealthGrid` + `useStatus` to render the
  smoke result: `useStatus` already refetches `/api/status` every 15s with
  `StatusResponse` zod parsing; `HealthRoute`'s `formatHealthSubtitle` can
  surface `components.dashboard.selftest` / `recent_unhandled_errors` when a
  smoke run is attached.
- New hook `web/src/hooks/use-dashboard-smoke.ts` modeled on
  `use-environment-check.ts` (react-query + `raceAbort`, `staleTime: 10_000`,
  `refetchInterval: 60_000`, gated by `hasEnvironmentBridge()`-style check) —
  but running `runDashboardSmoke` through the Rust Tauri command
  `run_dashboard_smoke` or directly against `__HERMES_RUNTIME__.apiBaseUrl`.
- Rust: keep `src/process/dashboard.rs` probes and constants
  (`DASHBOARD_READY_TIMEOUT` 120s, `PROBE_TIMEOUT` 900ms,
  `ATTACHED_DASHBOARD_TIMEOUT` 5s, `SPAWN_ATTEMPT_LIMIT` 3); add
  `src/commands/smoke.rs` exposing the suite as a Tauri command so the TS
  report and Rust spawn loop share the same check list. `bootstrap.rs`
  `finalize_bootstrap` continues to emit `runtime-status: ready` — now keyed
  off `DashboardSmokeResult.overall`.
- `scripts/tauri-dev-managed.mjs`: keep the managed-runtime env injection
  (`HERMES_DESKTOP_RUNTIME_ROOT`, `HERMES_DESKTOP_ALLOW_EXTERNAL_AGENT=0`,
  `HERMES_DASHBOARD_TUI=1`); add `pnpm smoke:dashboard` script that runs the
  TS smoke module against a spawned dev dashboard (or the in-process server)
  as a pre-flight gate.
- `e2e/`: reuse `e2e/harness/start-backend.mjs` (`waitForLine` for the READY
  sentinel, `waitForHttp` for `/`) and `wait.mjs` helpers; the new smoke suite
  replaces the READY-line-only wait with a full `runDashboardSmoke` pass
  before handing off to Playwright.

## 7. Removing the WebSocket dependency (migration path)

Phased, keeping the same interface at each step:

- Phase 0 (today): desktop spawns Python `hermes dashboard --no-open`/`serve`;
  Rust probes `/api/status` → `/openapi.json` → TCP port, then WS handshake
  (`dashboard_supports_ws`). WS is load-bearing (gateway JSON-RPC).
- Phase 1 (parity gate): implement `dashboard-smoke` TS module; run it against
  the *Python* dashboard in CI (`pnpm smoke:dashboard` against the e2e
  harness) — every check must agree with the existing Rust probe before it
  may gate in-process startup. This also pins the fork API surface in
  `endpoint-checks.ts`.
- Phase 2 (in-process): embed the runtime host (kap-server-style); start
  server in-process; `server-registry.ts` replaces the READY sentinel;
  bootstrap runs `runDashboardSmoke(origin)` instead of
  `probe_spawned_dashboard_ready`; WS handshake check stays until the gateway
  loop is ported in-process.
- Phase 3 (delete WS/REST path): once agent loop + gateway live in TS, remove
  `/api/ws` handshake from the smoke suite and the WS relay
  (`web/src/lib/gateway-client.ts`); smoke then covers REST + in-process
  health only.

API surface frozen during migration (do not change without bumping the smoke
`endpoint-checks` list): `GET /api/status` (public + components + loopback
fields), `GET /openapi.json`, `GET /api/sessions?limit=1` (auth'd),
`/api/ws` handshake, `/api/upload` presence, `X-Hermes-Session-Token` /
`X-Hermes-Profile`, READY sentinels, and `desktop-owner.json` → registry
mapping.

## 8. Migration phases & task breakdown

| # | Phase | Task | Verify |
|---|---|---|---|
| 1 | P1 | Extract Rust probe list into a shared check enum (`tcp`, `status`, `openapi`, `ws`, `sessions-auth`, `upload-path`, `profile-header`) | existing `probe_*` tests keep passing |
| 2 | P1 | `packages/protocol`: add `DashboardSmokeResult` zod schema; keep `StatusResponse` untouched | vitest schema test |
| 3 | P1 | `web/src/lib/dashboard-smoke/health-probes.ts` + `endpoint-checks.ts` + `report.ts` (pure fetch/ws, injectable deps) | vitest with mocked fetch/ws; run against Python dashboard via e2e harness |
| 4 | P1 | `pnpm smoke:dashboard` script wiring `start-backend.mjs` + TS smoke runner | CI green, matches Rust probe results |
| 5 | P1 | `selftest.ts` in-process loop (Fastify `app.inject` or loopback fetch) | unit test: wedged-route simulation flips `selftest: failing` |
| 6 | P1 | Port re-exec/spawn-guard parity (from `test_cmd_dashboard_reexec.py`) into TS/Rust: `HERMES_DESKTOP` / `HERMES_DESKTOP_MANAGED` / `HERMES_HOME`-in-profiles / `--isolated` / `--open-profile` semantics preserved in the managed spawn path | parity test matrix (mirror of the Python tests) |
| 7 | P2 | `packages/runtime/server-registry.ts`; replace `_write_dashboard_ready_file` + `HERMES_DASHBOARD_READY` parse in `bootstrap.rs` | integration: bootstrap ready without READY line |
| 8 | P2 | `src/commands/smoke.rs` Tauri command; `finalize_bootstrap` gates on `DashboardSmokeResult.overall`; retry ×3 | Tauri dev smoke + `runtime-status` events |
| 9 | P2 | `use-dashboard-smoke.ts` hook + `health.tsx` shows last smoke report | Playwright health route |
| 10 | P3 | Drop `/api/ws` handshake check + WS relay once gateway is in-process | e2e chat-loop.spec still green via REST/SSE |
| 11 | P3 | Delete Python `--no-open` spawn path from desktop bootstrap (runtime still ships CLI for standalone use) | packaged app boots headless |

## 9. Risks & open questions

- **No TS equivalent (listed in §5):** in-process authenticated self-test
  (`ASGITransport`), components health rollup, fork `/api/upload` check — all
  from scratch; parity must be judged against Python `DashboardHealth`, not
  kimi-code.
- **WS in TS:** handshake probe needs `ws`/native WebSocket availability in
  the Node/Playwright env; kimi-code uses `@fastify/ws` server-side only.
- **Timing semantics:** Python `DASHBOARD_READY_TIMEOUT` 120s exists for cold
  onefile subprocess unpack; an in-process server should be ready in seconds,
  but `PROBE_TIMEOUT` 900ms vs first-request warmup (model registry, skill
  seed, FTS rebuild) still needs the `/openapi.json` fallback — keep it.
- **Auth-gated binds:** `/api/status` is public, but the selftest route is
  skipped when OAuth is active (`app.state.auth_required`); the TS selftest
  must carry the same guard, and `statusProbe` must accept 401 as "healthy"
  (Rust already does).
- **Re-exec guard parity:** `test_cmd_dashboard_reexec.py` covers CLI-only
  re-exec behavior; in-process mode has no re-exec, but the guard semantics
  (`HERMES_DESKTOP_MANAGED=1` suppresses re-exec) must not regress the managed
  spawn path in Rust — verify with the mirrored matrix (task 6).
- **Windows event loop:** uvicorn needed a SelectorEventLoop fix
  (web_server.py 19387-19428); the in-process Rust/TS server must prove its
  loopback socket accepts connections on Windows in the packaged app — the
  smoke `portProbe` + `statusProbe` run is the canary.
- **`desktop-owner.json` migration:** existing users have a marker written by
  older builds; the registry must adopt or ignore stale markers
  (`MarkerOwnerState::StaleDesktopOwner` logic) rather than fail boot.
- **Open question:** should `pnpm smoke:dashboard` also run against the
  packaged runtime (preflight) or only dev/CI? Suggest both, with the packaged
  run gated by an env var (`HERMES_DESKTOP_SMOKE=1`, kimi-code
  `KIMI_CODE_NATIVE_ASSET_SMOKE` analog).

## 10. Test strategy

- **Vitest unit (TS):** `report.ts` rollup (ok/degraded/failing from check
  list), `health-probes.ts` against mocked fetch/net/ws (401 = ok for status,
  timeout = fail, openapi fallback ordering), `selftest.ts` route failure
  flips `components.dashboard.selftest` to `failing`, `server-registry.ts`
  heartbeat/release/dead-pid sweep.
- **Rust unit:** existing `probe_*` tests; new test that `smoke.rs` check
  enum maps 1:1 to TS `endpoint-checks` ids (a drift guard — new Python
  endpoint must update both lists).
- **Parity tests:** mirror `tests/test_cmd_dashboard_reexec.py` matrix in TS
  (`bootstrap/spawn-guard.test.ts`) so `HERMES_DESKTOP_MANAGED` / profiles-dir
  suppression never regresses; parity harness asserts TS smoke result == Rust
  probe result for the same live Python dashboard (e2e harness).
- **Playwright E2E:** `health` route renders `DashboardSmokeResult`
  (overall + components) after a real `runDashboardSmoke`; existing
  `chat-loop.spec.ts` / `image-paste.spec.ts` continue to exercise the frozen
  API surface.
- **Protocol smoke parity:** reuse `e2e/harness/protocol-smoke.mjs`
  (session.create → prompt.submit → message.delta/complete → image.attach)
  as the WS-path gate until Phase 3 removes the WS check.
- **CI gates:** `pnpm smoke:dashboard` on every PR (Python dashboard in e2e
  harness, Phase 1); packaged-app smoke on release preflight.

## 11. Reference links

- `D:/hermes-agent-cn/hermes_cli/subcommands/dashboard.py` (`--no-open`,
  `serve` headless defaults)
- `D:/hermes-agent-cn/hermes_cli/main.py` `cmd_dashboard` (lines 10442-10873)
- `D:/hermes-agent-cn/hermes_cli/web_server.py` (`start_server` 19237-19428,
  `/api/status` 3717-4044, `DashboardHealth` 869-987)
- `D:/hermes-agent-cn/tests/test_cmd_dashboard_reexec.py`
- `D:/hermes-agent-cn/README.md` (fork Dashboard API contract)
- `D:/Hermes-CN-Desktop/src/bootstrap.rs`, `src/process/dashboard.rs`
  (probes 473-650, ownership marker, port claim)
- `D:/Hermes-CN-Desktop/web/src/routes/health.tsx`,
  `web/src/hooks/use-status.ts`, `web/src/hooks/use-environment-check.ts`,
  `web/src/lib/transport.ts`, `web/src/lib/runtime.ts`
- `D:/Hermes-CN-Desktop/packages/protocol/src/hermes-api.ts`
  (`StatusResponse` lines 32-60)
- `D:/Hermes-CN-Desktop/scripts/tauri-dev-managed.mjs`
- `D:/Hermes-CN-Desktop/e2e/` (`README.md`, `harness/start-backend.mjs`,
  `harness/wait.mjs`, `harness/protocol-smoke.mjs`)
- `D:/kimi-code/apps/kimi-code/src/cli/sub/web/shared.ts` (probe/port/token
  helpers), `cli/sub/web/run.ts` (`--no-open`, `onReady`, ready banner)
- `D:/kimi-code/packages/kap-server/src/start.ts` (`startServer`,
  `RunningServer`, WS upgrade, auth hooks)
- `D:/kimi-code/packages/kap-server/src/instanceRegistry.ts` (register /
  heartbeat / release)
- `D:/kimi-code/apps/kimi-code/src/native/smoke.ts` (env-gated smoke
  pattern: `KIMI_CODE_NATIVE_ASSET_SMOKE=1`, ready handshake, exit 0/1)
