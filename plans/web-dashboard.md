# Web Dashboard — Python → TypeScript Rewrite Plan

## 1. Summary

The Python "web dashboard" (`hermes dashboard`) is a FastAPI + React SPA admin
surface for a machine-level Hermes install: 15 page families (Status, Chat,
Config, API Keys, Sessions, Logs, Analytics, Cron, Profiles, Skills, MCP,
Webhooks, Pairing, Channels, System), an auth gate (password / Nous OAuth /
self-hosted OIDC / bearer token), a full REST API, and a theme + plugin
extension system.

In the desktop monorepo **the React frontend already IS the dashboard
replacement**: `web/src/routes/*` covers Status (`/health`), Chat (panel +
console), Config (`/config`, `/env`), Sessions (`/history`, `/tasks/:id`),
Logs, Analytics, Cron, Profiles, Skills, MCP, and parts of System. Today those
routes talk to the Python dashboard over HTTP (`transport.ts` → Rust
`api_request` proxy) and WebSocket (`ws_proxy.rs` → `/api/ws`).

This plan designs the **in-process REST/router layer** that replaces
`hermes_cli/web_server.py`: a TS route registry (`packages/dashboard`) backed
by Rust Tauri commands for OS-level work, serving the **frozen `/api/*`
contract** directly from the desktop so the Python backend and the WS/PTY link
can be deleted. Pages that are missing in the desktop (Webhooks, Pairing,
Channels full page, Plugins, System ops, YAML themes) are designed as gaps to
fill.

## 2. Current Python implementation

Source (all under `D:/hermes-agent-cn`):

- `hermes_cli/web_server.py` (~19.5k lines) — the whole FastAPI app: ~200
  routes, middlewares (CORS, DNS-rebinding/Host guard, auth gate, plugin
  disabled-policy), static SPA mount, background action runner
  (`/api/actions/{name}/status`), and WebSockets
  `/api/ws` (JSON-RPC chat), `/api/pty` (embedded TUI), `/api/console`,
  `/api/pub`, `/api/events`, `/api/audio/speak-stream`.
- `hermes_cli/web_routers/` — extracted `APIRouter` modules:
  `cron.py`, `git.py`, `mcp.py`, `profiles.py` (+`sessions_router`),
  `sessions.py` (list/search/manage), `skills.py` (+`hub_router`), `tools.py`.
- `hermes_cli/dashboard_auth/` — provider framework:
  `base.py` (`DashboardAuthProvider` ABC, `Session`, `TokenPrincipal`,
  `LoginStart`), `routes.py` (`/login`, `/auth/login`, `/auth/callback`,
  `/auth/password-login`, `/auth/logout`, `/auth/native/*`,
  `/api/auth/providers|me|ws-ticket`), `middleware.py`, `cookies.py`
  (`hermes_session_at` / `_pkce` / `_rt`), `token_auth.py`,
  `ws_tickets.py`, `native_flow.py`, `registry.py`, `audit.py`,
  `prefix.py`, `public_paths.py`, `login_page.py`.
- `hermes_cli/dashboard_procs.py` — process scan/kill/respawn hygiene;
  `hermes_cli/dashboard_register.py` — `hermes dashboard register` CLI.
- `web/` — React 19 + Vite + Tailwind v4 SPA; `web/src/pages/`:
  `AnalyticsPage`, `ChannelsPage`, `ChatPage`, `ConfigPage`, `CronPage`,
  `DocsPage`, `EnvPage`, `FilesPage`, `LogsPage`, `McpPage`, `ModelsPage`,
  `PairingPage`, `PluginsPage`, `ProfileBuilderPage`, `ProfilesPage`,
  `SessionsPage`, `SkillsPage`, `SystemPage`, `WebhooksPage`;
  `web/src/themes/` (YAML themes, `presets.ts`, `context.tsx`, `fonts.ts`),
  `web/src/plugins/` (manifest + JS bundle + `PluginPage`, `slots.ts`,
  `registry.ts`); `ChatPage` uses `@xterm/xterm` + WebGL/Unicode11 addons
  over `/api/pty`.
- Bundled auth providers live in `plugins/dashboard_auth/`: `nous` (OAuth),
  `basic` (username/password, stdlib scrypt, HMAC sessions), `self_hosted`
  (OIDC PKCE + JWKS ID-token verify), `drain` (bearer token).

Docs: `website/docs/user-guide/features/web-dashboard.md` (1116 lines —
pages, REST API table, auth/gate semantics, CORS, desktop remote-backend
integration) and `extending-the-dashboard.md` (927 lines — theme YAML schema,
layout variants, plugin manifest/SDK/slots, backend plugin routes).

Tests (parity targets): `tests/hermes_cli/test_web_server*.py` (23 files:
boot handshake, console WS, cron/profiles, files/fs/upload, git, host-header,
oauth-write, pty import/reconnect, session search, skill editor, speak
stream, …), `tests/hermes_cli/test_dashboard*.py` (26 files incl.
`test_dashboard_auth_*.py` ×10, `test_dashboard_token_auth.py`,
`test_dashboard_unified_launch.py`, `test_dashboard_admin_endpoints.py`,
`test_dashboard_register.py`, `test_dashboard_web_dist_validation.py`),
plus `tests/dashboard/test_ws_client_host.py`,
`tests/test_cmd_dashboard_reexec.py`,
`tests/test_dashboard_sidecar_close_on_disconnect.py`.

Data flow today: browser → `http://127.0.0.1:9119/api/*` → FastAPI → reads
`config.yaml`, `.env`, `sessions.db` (SQLite + FTS5), `logs/*.jsonl`, cron /
webhook / pairing stores; `/api/pty` spawns `hermes --tui` behind a PTY. On a
non-loopback bind the auth gate fails closed unless a provider is registered.

## 3. Target TypeScript design

End state: no Python process, no WS link. The React app hosts the agent
runtime in-process; the dashboard is a **route registry + command layer**.

Module layout (new unless marked existing):

```
packages/dashboard/                 # NEW TS package (or web/src/lib/dashboard)
  router.ts                         # createDashboardRouter(): Map<path, Handler>
  routes/status.ts config.ts env.ts sessions.ts logs.ts analytics.ts
         cron.ts profiles.ts skills.ts mcp.ts messaging.ts pairing.ts
         webhooks.ts system.ts ops.ts memory.ts gateway.ts themes.ts plugins.ts
  auth/provider.ts                  # DashboardAuthProvider TS interface
  auth/basic.ts auth/oauth.ts auth/oidc.ts auth/token.ts auth/session-store.ts
  themes/yaml-theme-adapter.ts      # Python theme YAML -> ThemeConfig
  plugins/registry.ts               # manifest + slots + backend route table
web/src/lib/dashboard-client.ts     # NEW: local fetch shim, same shape as fetchJSON
web/src/lib/transport.ts            # EXISTING — gains local-first routing
packages/protocol/                  # EXISTING — grows full frozen schema set
src/commands/api_proxy.rs           # EXISTING — becomes "remote fallback only"
src/commands/dashboard_*.rs         # NEW: config/env/fs/sysinfo/gateway/etc.
src/commands/terminal.rs            # EXISTING — PTY stays (Chat/console)
src/commands/ws_proxy.rs            # EXISTING — retained for legacy remote mode
```

Request lifecycle after migration: React hook → `fetchJSON("/api/config",
…, ConfigSchema)` → `transport.ts` resolves the path against the local
registry first (when `runtime.connectionMode === "managed"` and the handler
is registered) → the TS handler calls Rust commands (`invoke`) for
file/process/SQLite work and returns the same JSON shape the Python route
produced. Paths not yet ported fall back to the existing Tauri `api_request`
proxy to a Python dashboard (remote/legacy mode only).

Auth design: mirror `DashboardAuthProvider` 1:1 —

```ts
interface DashboardAuthProvider {
  name: string; displayName: string;
  supportsPassword?: boolean; supportsToken?: boolean;
  startLogin(opts): Promise<LoginStart>;
  completeLogin(opts): Promise<Session>;
  verifySession(accessToken): Promise<Session>;
  refreshSession(refreshToken): Promise<Session>;
  completePasswordLogin(u, p): Promise<Session>;
  verifyToken(token): Promise<TokenPrincipal>;
}
```

In-process there is no HTTP cookie jar; the session store lives in Rust
`AppState` (`session_token`, `oauth_session` already exist in
`src/state.rs` / `connection.rs`) and `transport.ts` injects
`Authorization: Bearer` + `X-Hermes-Session-Token` (already implemented).
`/api/auth/ws-ticket` is replaced by direct IPC once `/api/ws` is gone.

Chat design: the embedded TUI no longer needs `/api/pty`. Desktop already has
`EmbeddedTerminal` (`web/src/components/console/embedded-terminal.tsx`) bound
to `terminal_start/write/resize/close` Rust commands — a native PTY. Session
resume comes from the SQLite session store instead of `hermes --tui --resume`.

## 4. Data models & persistence

| Python store | Format | TS/Rust replacement | Notes |
|---|---|---|---|
| `config.yaml` + `DEFAULT_CONFIG` schema | YAML | Rust `serde_yaml` (already in `Cargo.toml`) or TS `js-yaml`; Zod schema in `packages/protocol` | `/api/config`, `/api/config/schema` renders widgets from the Zod schema |
| `.env` keys (redacted) | KEY=VALUE | Rust env file module (new `dashboard_env.rs`) | `/api/env`, `/api/env/reveal` |
| `sessions.db` + FTS5 search | SQLite | `rusqlite` bundled (already in `Cargo.toml`), FTS5 virtual table | `/api/sessions*`, `/api/sessions/search` snippets |
| `logs/{agent,errors,gateway}.jsonl` | JSONL | Rust read + tail (log_export.rs exists) | `/api/logs` |
| cron jobs | YAML | TS `cron-job.ts` helper already exists; persistence via Rust file module | `/api/cron/*` |
| webhook subscriptions | JSON | new TS/Rust store | `/api/webhooks*` |
| pairing store | JSON | new store | `/api/pairing*` |
| themes | YAML in `~/.hermes/dashboard-themes/` | adapter → desktop `ThemeConfig` (`ui-store.ts`) | Python's color-mix cascade ≠ desktop themes; map palette/tokens |
| plugin manifests + bundles | JSON + JS | `@hermes/plugin-sdk` (external; see risks) + `plugins/registry.ts` | `/api/dashboard/plugins*`, `/api/plugins/{name}/*` |
| auth sessions | HMAC cookie | Rust in-memory session store + optional persisted `dashboard.basic_auth.secret` | sessions survive restart when a stable secret is set |

Schema migrations: the desktop owns the SQLite DB after the switch; migrate
Python-created DBs with a `PRAGMA user_version`-based migration module (same
approach the desktop already takes for its own stores).

## 5. Third-party library strategy

| Python dependency | TS/Rust equivalent | Evidence |
|---|---|---|
| FastAPI + Uvicorn | In-process TS route table; if a loopback HTTP server is ever needed (remote attach), use Hono or Fastify | `D:/kimi-code/apps/vis/server` uses Hono + `@hono/node-server`; `packages/kap-server` uses Fastify 5 + `@fastify/swagger` (OpenAPI) + Zod envelopes |
| PyYAML | `serde_yaml` 0.9 (Rust) / `js-yaml` ^4.1.1 (TS) | `D:/Hermes-CN-Desktop/Cargo.toml`; `D:/kimi-code/packages/agent-core/package.json` |
| sqlite3 + FTS5 | `rusqlite` 0.32 bundled (Rust, FTS5 built-in) | `D:/Hermes-CN-Desktop/Cargo.toml`; kimi-code `packages/minidb` is the TS-side embedded-store precedent |
| ptyprocess / pywinpty | Rust native PTY via `terminal.rs` commands; node-pty precedent | `src/commands/terminal.rs` (`terminal_start/write/resize/close`) exists; `D:/kimi-code/apps/kimi-code/src/native` uses node-pty |
| xterm.js (+WebGL, Unicode11) | `@xterm/xterm` 6 + addons | Python `web/package.json` and desktop `web/package.json` both use `@xterm/xterm`+`addon-fit`+`addon-web-links`; **gap**: desktop lacks `@xterm/addon-webgl` and `@xterm/addon-unicode11` |
| httpx / requests | Rust `reqwest` 0.12 (already dep); TS `fetch` | `Cargo.toml`; kap-server performs external calls from TS |
| stdlib scrypt / HMAC | `node:crypto` scrypt/HMAC (built-in) or `bcryptjs` | `packages/kap-server/package.json` has `bcryptjs ^2.4.3` |
| OAuth (PKCE) | kimi-code `packages/oauth` (`oauth-manager.ts`, `token-state.ts`); desktop already has `oauth_session.rs` + `use-oauth-providers.ts` | `D:/kimi-code/packages/oauth/src`; `D:/Hermes-CN-Desktop/src/commands/connection.rs` |
| OIDC JWT verify (JWKS) | `jose` npm package — **no equivalent found in kimi-code** (see risks) | grep of kimi-code package.json found no jose/node-jose |
| psutil (system stats) | Rust `sysinfo` crate (new dep) or reuse `environment.rs`/`debug_bundle.rs` | **no kimi-code equivalent** (vis server has no system stats) |
| Chart lib (observablehq/plot in Python web) | `recharts` ^3.8.1 | desktop `web/package.json` |
| React Router | react-router 7 (desktop) vs 8 (Python web) | both repos' `package.json` |
| react-query | `@tanstack/react-query` ^5.100.5 | desktop `web/package.json`; vis-web uses same |
| Dashboard themes/plugins | Desktop ThemeConfig + `@hermes/plugin-sdk`; kap-server `routes/plugins.ts` + TUI `plugins-selector.ts` are partial precedents | `web/src/lib/ui-store.ts`, `theme-defaults.ts`; **plugin-sdk is NOT in this repo's `packages/`** (only `protocol`, `shared-ui`) — must be added |

## 6. Integration with existing Hermes-CN-Desktop frontend

Page mapping (Python page → desktop route → existing hook/lib → status):

| Python page | Desktop route | Existing reuse | Status |
|---|---|---|---|
| Status | `/health` | `useStatus` → `GET /api/status`, `HealthGrid` | exists |
| Chat (embedded TUI) | `/` panel chat + `/console` | `EmbeddedTerminal`, `terminal.rs`, `gateway-client.ts` (JSON-RPC) | exists (React chat, not PTY-TUI; PTY exists for console) |
| Config | `/config`, `/env`, `/common`, `/connection` | `use-config.ts`, `use-env.ts`, `advanced.tsx`, `settings-*` | exists |
| API Keys | `/env` | `use-env.ts`, `EnvPage` | exists |
| Sessions | `/history`, `/tasks/:id` | `use-sessions.ts`, `use-session-*.ts`, `hermes-api.ts` | exists |
| Logs | `/logs` | `use-logs.ts`, `log-classify.ts` | exists |
| Analytics | `/analytics` | `use-analytics.ts`, recharts | exists |
| Cron | `/cron` | `use-cron.ts`, `cron-job.ts` | exists |
| Profiles | `/profiles`, `/profiles/new` | `use-profiles.ts`, `profile-builder.tsx` | exists |
| Skills | `/skills` | `use-skills.ts` (+ hub search) | exists |
| MCP | `/mcp` | `use-mcp.ts`, `use-mcp-servers.ts`, `mcp-api.ts` | exists |
| Webhooks | — | none (`/api/webhooks*` unused) | **gap** |
| Pairing | — (only `im-onboarding.tsx` platform flows) | `use-im-onboarding.ts` | **gap** (generic approve/revoke page) |
| Channels | `/im/*` partial | `use-im-onboarding.ts`, `MessagingPlatformsResponse` in `hermes-api.ts` | **partial gap** (full Channels page missing) |
| System | `/debug`, `/memory`, `/backup`, `/config-migration`, `/coding-agents` | `use-memory.ts`, `use-gateway.ts`, `debug.tsx` | **partial gap** (host stats, curator, credential pool, ops, hooks) |
| Themes/Plugins | `/theme` (advanced), `/common` | `ui-store.ts`, `theme-defaults.ts` | **gap** (YAML theme import + plugin registry) |

Transport/routing reuse: `transport.ts` (`fetchJSON`, `shouldUseNativeIpc`,
auth/profile headers) is the single seam to flip local-first; `tauri-bridge.ts`
provides `window.hermesDesktop` invoke surface; `ws_proxy.rs` +
`gateway-relay-socket.ts` carry chat WS during migration; `api_proxy.rs`
already has a local-intercept pattern (`/__hermes_session_log/`,
`/__hermes_cron_runs/`, archive, runtime-update) — extend that mechanism to
serve `/api/*` from the in-process registry instead of proxying.

## 7. Removing the WebSocket dependency (migration path)

Freeze first — the `/api/*` surface (from `web-dashboard.md` + `web_server.py`
route scan): `/api/status`, `/api/health`, `/api/version`,
`/api/config(/defaults|/schema)`, `/api/env`, `/api/sessions(/search|/stats|
/{id}(/messages|/export)|/prune|/bulk-delete|/empty)`, `/api/logs`,
`/api/analytics/(usage|models)`, `/api/cron/*`, `/api/skills*`,
`/api/tools/toolsets`, `/api/mcp/*`, `/api/messaging/platforms*`,
`/api/pairing*`, `/api/webhooks*`, `/api/credentials/pool`,
`/api/memory*`, `/api/gateway/*`, `/api/ops/*`, `/api/system/stats`,
`/api/curator*`, `/api/portal`, `/api/hermes/update*`, `/api/dashboard/*`
(themes/plugins), `/api/plugins/{name}/*`, `/api/auth/*`, `/api/actions/{name}/status`,
and WS `/api/ws`, `/api/pty`, `/api/console`, `/api/events`, `/api/pub`,
`/api/audio/speak-stream`.

Phases:
1. **Freeze** — export FastAPI `/openapi.json` → Zod schemas in
   `packages/protocol` (extend `hermes-api.ts`, `mcp-api.ts`, `channels.ts`).
2. **Local-first reads** — `transport.ts` serves read endpoints in-process
   (status/health/version, config read, env list, session list/search,
   logs, analytics) with Rust backends; parity-tested against Python.
3. **Local writes** — config PUT, env PUT/DELETE/reveal, session rename/
   delete/prune/export, cron CRUD, skills toggle/hub, mcp CRUD/test, profiles,
   gateway lifecycle, memory, credential pool, ops background actions.
4. **Auth in-process** — `auth/provider.ts` with basic + OAuth + OIDC +
   token providers; session store in `AppState`; keep `connection.rs` remote
   login for legacy remote mode.
5. **Chat without WS/PTY link** — panel chat over in-process JSON-RPC
   (Rust `gateway.rs`/agent runtime) + native PTY terminal for console/TUI;
   delete `ws_proxy.rs` Python target and `/api/pty` usage.
6. **Delete Python path** — stop spawning the managed Python dashboard for
   standalone mode; `api_proxy.rs` proxies only to explicitly attached remote
   dashboards (Settings → Gateway → Remote gateway stays a supported legacy
   mode until the TS runtime replaces the backend everywhere).

## 8. Migration phases & task breakdown

| Phase | Tasks | Exit criteria |
|---|---|---|
| 0 (now) | Snapshot OpenAPI; add Zod schemas; add `packages/dashboard` skeleton | `packages/protocol` type-checks; schema tests green |
| 1 | `transport.ts` local-first router; Rust `dashboard_status.rs`, `dashboard_config.rs`, `dashboard_env.rs`; port Status/Config/Env reads | `useStatus/useConfig/useEnv` pass with Python stopped (read-only) |
| 2 | Port sessions/logs/analytics/cron/skills/mcp/profiles/gateway/memory/ops writes | parity suite (below) green against Python tests |
| 3 | Auth providers TS + session store; WS-ticket seam removed | auth tests (password login, OIDC flow, token auth) green |
| 4 | Chat: in-process JSON-RPC + native PTY; drop `/api/pty`/`/api/ws` for managed mode | chat E2E passes without Python |
| 5 | Gap pages: Channels, Pairing, Webhooks, Plugins, System ops, YAML theme import | all 15 page families reachable in desktop |
| 6 | Delete Python `web_server.py` path for standalone; keep remote legacy | standalone launch has no Python backend |

## 9. Risks & open questions

- **No full admin-dashboard TS equivalent in kimi-code.** `apps/vis` is a
  read-only session analysis dashboard (Hono + bearer token, sessions/wire/
  cron/logs routes); `kap-server` is server/protocol infra, not a dashboard
  UI. The desktop's own routes are the real precedent — the plan leans on
  them, not on kimi-code.
- **OIDC/JWT verification**: no `jose`/`node-jose` in kimi-code package.json;
  must adopt `jose` from the npm ecosystem and write the JWKS discovery +
  ID-token verify module from scratch (mirror `plugins/dashboard_auth/self_hosted`).
- **Desktop plugin SDK absent in-repo**: `@hermes/plugin-sdk` is documented
  in Core docs but this repo's `packages/` only has `protocol` and
  `shared-ui`; the plugin registry + backend `/api/plugins/{name}/*` routing
  needs an in-repo package added.
- **Theme model mismatch**: Python YAML themes use 3-layer palette +
  `color-mix()` cascade; desktop `ThemeConfig` (light-modern/dark/dracula/
  catppuccin) is a different model — need an adapter and possibly a palette
  cascade port, not a 1:1 copy.
- **FTS5 search parity**: highlight snippets and FTS ranking must be
  replicated in `rusqlite`; verify against `test_web_server_session_search.py`.
- **PTY on native Windows**: Python requires WSL for the embedded TUI; the
  Rust PTY path must preserve that banner/fallback behavior
  (`test_dashboard_tui_backcompat.py`, `test_web_server_pty_import.py`).
- **Profile-scoped endpoints**: `?profile=` query semantics on config/env/
  skills/mcp/model/pty must be preserved in the local router.
- Open questions: keep a loopback HTTP server for remote attach (Hono sidecar
  vs Rust `tiny_http`)? Who owns the sessions DB after migration (Rust
  `rusqlite` vs TS `minidb`)? When does the agent runtime move into TS
  (blocks Phase 5 chat)?

## 10. Test strategy

- **Vitest unit (TS)**: `transport.ts` local-first routing; Zod schema
  round-trips; auth providers (basic password, token verify, OIDC claim
  mapping); theme YAML adapter; plugin registry slots.
- **Rust unit/integration**: route handlers (config/env/sessions/logs),
  session store, WS-ticket removal, `terminal.rs` PTY lifecycle
  (mirror `test_web_server_pty_*.py`).
- **Parity vs Python**: port behavior-level assertions from
  `test_web_server*.py` (23) + `test_dashboard*.py` (26) into vitest/Rust
  suites — especially `test_dashboard_auth_*` (10), `test_dashboard_token_auth.py`,
  `test_dashboard_unified_launch.py`, `test_dashboard_admin_endpoints.py`,
  `tests/dashboard/test_ws_client_host.py`, `test_cmd_dashboard_reexec.py`,
  `test_dashboard_sidecar_close_on_disconnect.py` (process hygiene / close-on-
  disconnect semantics move to Rust).
- **Playwright E2E**: each of the 15 page families; auth gate login flow;
  theme switch; plugin tab; chat/console with Python **stopped** (the true
  end-state proof).

## 11. Reference links

- Python: `D:/hermes-agent-cn/hermes_cli/web_server.py`,
  `hermes_cli/web_routers/`, `hermes_cli/dashboard_auth/`,
  `hermes_cli/dashboard_procs.py`, `hermes_cli/dashboard_register.py`,
  `web/` (pages/themes/plugins), `plugins/dashboard_auth/`.
- Docs: `D:/hermes-agent-cn/website/docs/user-guide/features/web-dashboard.md`,
  `.../features/extending-the-dashboard.md`.
- Tests: `D:/hermes-agent-cn/tests/hermes_cli/test_web_server*.py`,
  `test_dashboard*.py`, `tests/dashboard/test_ws_client_host.py`,
  `tests/test_cmd_dashboard_reexec.py`,
  `tests/test_dashboard_sidecar_close_on_disconnect.py`.
- Desktop: `web/src/App.tsx`, `web/src/routes/*`, `web/src/lib/transport.ts`,
  `web/src/lib/gateway-client.ts`, `web/src/lib/tauri-bridge.ts`,
  `web/src/hooks/*`, `web/src/components/console/embedded-terminal.tsx`,
  `src/commands/{api_proxy,ws_proxy,terminal,connection,runtime_manager}.rs`,
  `src/process/dashboard.rs`, `packages/protocol/src/{hermes-api,mcp-api,session-log,channels}.ts`,
  `web/package.json`, `Cargo.toml`.
- kimi-code: `apps/vis/server/src/app.ts`, `apps/vis/web/src/App.tsx`,
  `packages/kap-server/src/routes/{auth,terminals,sessions,plugins}.ts`,
  `packages/kap-server/package.json`, `packages/oauth/src/`,
  `packages/agent-core/package.json` (js-yaml), `apps/kimi-code/src/tui/`.
