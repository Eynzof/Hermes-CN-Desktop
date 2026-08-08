---
name: project-structure
description: Use when orienting within the Hermes Agent CN Desktop codebase, locating source files, understanding the Tauri+React architecture, finding Rust commands or frontend modules, or navigating the monorepo. Triggers: project structure, 项目结构, where is, 在哪里, codebase overview, 代码概览, repository layout, how is this repo organized, 仓库结构, workspace layout.
---

# Hermes Agent CN Desktop — Project Structure

## Overview

**Hermes Agent CN Desktop** is a standalone desktop application built with **Tauri v2 + React**, replacing the original Electron shell. It pairs with the [Hermes-CN-Core](https://github.com/Eynzof/Hermes-CN-Core) backend runtime (the CN community runtime, originally named `hermes-agent-cn`).

- **Version**: 0.6.3
- **Bundle identifier**: `cn.org.hermesagent.desktop` (DO NOT CHANGE — used for upgrade path)
- **Rust crate name**: `hermes_agent_cn` (lib), `hermes-agent-cn-desktop` (package)
- **Package manager**: pnpm 9.15.0 (monorepo)

The desktop-managed runtime defaults to port **9120**, avoiding port 9119 used by the user's global Hermes Agent.

---

## Top-Level Directory Layout

```
Hermes-CN-Desktop/
├── src/                          Rust Tauri backend (~24,000 lines)
├── web/                          React frontend (Vite + TanStack Query + Jotai)
├── packages/
│   ├── protocol/                 Shared Zod schemas, IPC types, session log parsing
│   └── shared-ui/                Design tokens, shared React components, hooks
├── e2e/                          Playwright E2E (real web → real Core backend → fake model)
├── tests/                        Rust integration tests (crate: hermes_agent_cn)
├── scripts/                      Build & dev automation scripts (.mjs)
├── static/                       Stage targets for bundled builds
│   ├── bundled-runtime/          Managed runtime binaries
│   ├── bundled-skills/           Bundled skill packs
│   ├── bundled-plugins/          Bundled plugins
│   └── dashboard/                Dashboard web dist
├── docs/                         Project documentation & PRD specs
├── icons/                        App icons (Windows/macOS/Linux)
├── installer/                    NSIS installer customization
├── legal/                        EULA & license files
├── gen/schemas/                  Generated JSON schemas
├── capabilities/                 Tauri capability definitions
├── .github/workflows/            CI/CD pipelines
├── Cargo.toml                    Rust dependencies & build config
├── tauri.conf.json               Tauri window/bundle/CSP configuration
├── pnpm-workspace.yaml           pnpm monorepo (web + packages/* + e2e)
└── package.json                  Workspace root scripts
```

---

## Rust Backend (`src/`)

The Rust crate `hermes_agent_cn` is the Tauri backend. All source lives under `src/`.

### Entry Points & Core Modules

| File | Purpose |
|------|---------|
| `main.rs` | Entry point: resolves `HERMES_HOME`, starts dashboard, registers **60 commands** (`generate_handler!`), system tray |
| `lib.rs` | Library root: declares **18 public modules** |
| `state.rs` | `AppState` (`Mutex<AppStateInner>`) — shared state injected into every Tauri command |
| `error.rs` | `AppError` unified domain error type (thiserror + Serialize) |
| `tray.rs` | System tray menu |

### Bootstrap & Environment

| File | Purpose |
|------|---------|
| `bootstrap.rs` | Startup sequence: probe/spawn dashboard, connect backend, fetch token |
| `environment.rs` | Environment resolution and validation |
| `connection.rs` | Connection backend + mode (local/remote), remote-mode WS connection |
| `path_resolver.rs` | PATH/PATHEXT resolution for child processes |
| `env_file.rs` | Parse `$HERMES_HOME/.env` for per-spawn child env injection |

### Runtime & Process Management

| File | Purpose |
|------|---------|
| `supervisor.rs` | Child process supervision |
| `prevent_sleep.rs` | Keep-awake during long-running tasks |
| `cron_runs.rs` | Scheduled task orchestration |
| `update_stage.rs` | Update staging logic |
| `process/` | Subprocess management |
| `process/dashboard.rs` | Dashboard subprocess: probe/spawn/port fallback |
| `process/gateway.rs` | Gateway subprocess + conflict detection |
| `process/runtime.rs` | Managed runtime install/signature verification |
| `process/instance.rs` | Single-instance guard per runtime root |
| `process/port_lock.rs` | Port lock management |

### Session & Logging

| File | Purpose |
|------|---------|
| `session_archive.rs` | Session archiving |
| `session_log.rs` | Session log reading |
| `oauth_session.rs` | OAuth session handling |

### Other Core Modules

| File | Purpose |
|------|---------|
| `coding_agents.rs` | Coding agent management |
| `desktop_control.rs` | Desktop-level controls |
| `ui_store.rs` | UI state persistence |
| `util.rs` | Shared utilities |

### Commands (`src/commands/`) — 60 Tauri IPC Commands

| Module | Purpose |
|--------|---------|
| `api_proxy.rs` | HTTP proxy: `api_request`, `external_request`, `upload_file` |
| `ws_proxy.rs` | /api/ws WebSocket relay (fallback when webview native WS blocked) |
| `gateway.rs` | Runtime config + gateway URL refresh |
| `runtime_manager.rs` | Managed runtime download/update/rollback |
| `desktop_update.rs` | Desktop self-update |
| `profiles.rs` | Profile switching (incl. fault recovery) |
| `config_migration.rs` | Configuration migration |
| `im_onboarding.rs` | Feishu/DingTalk/WeCom/WeChat onboarding |
| `connection.rs` | Connection management commands |
| `connection_auth.rs` | OAuth-based connection authentication |
| `backup.rs` | Backup operations |
| `memory.rs` | Memory management |
| `skills.rs` | Skill management (hidden from mod.rs) |
| `terminal.rs` | Embedded terminal (portable-pty) |
| `log_export.rs` | Log export |
| `debug_bundle.rs` | Debug bundle generation |
| `notify.rs` | Desktop notifications |
| `preview.rs` | File preview with native filesystem watch |
| `environment.rs` | Environment variables |
| `file_dialogs.rs` | Native file dialogs |
| `restart.rs` | App restart |
| `ui_store.rs` | UI state persistence commands |
| `yolo.rs` | YOLO mode |
| `devtools.rs` | WebView devtools toggle |
| `coding_agents.rs` | Coding agent management commands |
| `git.rs` | Git operations |

---

## React Frontend (`web/`)

Built with **Vite + React 19 + TanStack Query + Jotai**. CSS Modules (no Tailwind).

### Key Files & Directories

```
web/src/
├── main.tsx                    App entry
├── App.tsx                     Root component
├── lib/                        Core library (~156 files, most with co-located tests)
│   ├── tauri-bridge.ts         Tauri invoke wrapper + hermesDesktop shim
│   ├── runtime.ts              Platform detection (web / electron / tauri)
│   ├── transport.ts            HTTP routing (native IPC vs fetch) + auth header injection
│   ├── gateway-client.ts       Gateway WS client (JSON-RPC over /api/ws, backoff/reconnect)
│   ├── gateway-socket-path.ts  Native WS vs Rust relay socket path selection
│   └── ...                     ~150 other lib modules (models, skills, sessions, etc.)
├── hooks/                      React hooks (~42 files)
│   ├── use-gateway.ts          Gateway WebSocket connection hook
│   ├── use-config.ts           Configuration hook
│   ├── use-sessions.ts         Sessions management
│   ├── use-skills.ts           Skills management
│   └── ...                     Many more domain hooks
├── stores/                     Jotai atoms (~13 files)
│   ├── chat.ts                 Chat state
│   ├── panel.ts                Panel state
│   ├── ui.ts                   UI state
│   └── ...
├── routes/                     Page components (~39 files)
│   ├── guide.tsx               Onboarding guide
│   ├── health.tsx              Health dashboard
│   ├── settings.tsx            Settings page
│   ├── chat.tsx                Chat interface
│   └── ...                     Many more page routes
├── components/                 UI components
│   ├── app-shell/              App shell layout
│   ├── chat/                   Chat components (incl. preview-rail)
│   ├── composer/               Message composer (incl. workspace-picker)
│   ├── console/                Console/terminal
│   ├── settings/               Settings panels
│   ├── sidebar/                Sidebar navigation
│   ├── top-bar/                Top navigation bar
│   ├── command-palette/        Command palette (⌘K)
│   ├── mcp/                    MCP server management
│   ├── profiles/               Profile management
│   ├── projects/               Project/workspace management
│   ├── session-actions/        Session actions
│   ├── panel/                  Panel components
│   ├── brand/                  Branding components
│   └── ui/                     Generic UI primitives
├── styles/                     Global styles
├── types/                      TypeScript type definitions
└── assets/                     Static assets (incl. provider-icons)
```

### State Management Strategy

| Layer | Technology |
|-------|-----------|
| Server state (REST API data) | TanStack Query |
| Local / real-time stream state | Jotai atoms |
| Rust-side state | `AppState` (`Mutex<AppStateInner>`) via `tauri::State` |

### Key Architecture Patterns

- **Transport**: All HTTP requests go through `transport.ts` (auth header injection, native IPC vs fetch routing). NEVER hand-write fetch elsewhere.
- **Gateway**: JSON-RPC over WebSocket at `/api/ws`. Use `use-gateway.ts` hook, never call `gateway-client.ts` raw socket directly.
- **Tauri Bridge**: `tauri-bridge.ts` mounts Tauri invoke wrappers onto `window.hermesDesktop` at startup. Existing code checking `window.hermesDesktop?.someMethod` works unchanged.
- **CSS**: CSS Modules only — no Tailwind, no styled-components. Design tokens in `packages/shared-ui/src/tokens/`.

---

## Packages (`packages/`)

### `@hermes/protocol`
Shared type definitions and validation:
- Zod schemas for the Hermes API (`hermes-api.ts`)
- IPC types
- Session log parsing (`session-log.ts`)
- MCP API schemas
- Channel types

### `@hermes/shared-ui`
Shared UI primitives:
- Design tokens (`tokens/`): colors, typography, spacing, motion, z-index, component tokens, semantic tokens, primitives
- Components: alert, badge, button, card, copy-button, empty-state, field, input
- Composites: dialog, popover
- Hooks
- Utilities

---

## Testing

### Unit Tests (Vitest)
- **~93 test files** across the monorepo
- `web/src/lib/` — most modules have co-located `.test.ts` files
- `packages/protocol/` — Zod schema tests
- Run: `pnpm test:unit` (serial per workspace)

### Rust Integration Tests (`tests/`)
- Crate name: `hermes_agent_cn`
- Mock-based: `wiremock` for HTTP, `tempfile::TempDir` for FS
- Tests: `api_proxy.rs`, `connection_config.rs`, `connection_ws_e2e.rs`, `dashboard_probe.rs`, `dashboard_spawn_retry.rs`, `dashboard_token.rs`, `runtime_manifest.rs`
- Run: `cargo test --all-features`

### E2E Tests (`e2e/`)
- Playwright (real web → real Core backend → local fake model)
- Specs: chat-loop, guide-layout, image-paste, models-cli-custom-provider, skills-provenance
- Fake model server: `e2e/fake-model/server.py`
- Harness: config, global-warmup, protocol-smoke, start-backend, wait
- Run: `pnpm test:e2e`

---

## Scripts (`scripts/`)

| Script | Purpose |
|--------|---------|
| `tauri-dev-managed.mjs` | Install backend into dev-runtime, launch Tauri dev |
| `tauri-dev-external.mjs` | Tauri dev with external backend |
| `install-local-runtime.mjs` | Copy Hermes-CN-Core into dev-runtime |
| `install-release-dmg.mjs` | Download & install release DMG |
| `stage-bundled-runtime.mjs` | Stage runtime for bundled build |
| `stage-dashboard-web-dist.mjs` | Stage dashboard web dist |
| `stage-bundled-skills.mjs` | Stage bundled skills |
| `stage-bundled-plugins.mjs` | Stage bundled plugins |
| `sync-desktop-version.mjs` | Sync version across packages |
| `generate-license-rtf.mjs` | Generate license RTF |
| `migrate-runtime-trees.mjs` | Migrate polluted runtime trees |
| `package-portable-windows.mjs` | Create Windows portable package |
| `package-portable-macos.mjs` | Create macOS portable package |
| `only-pnpm.mjs` | Enforce pnpm as package manager |
| `cdp-eval.mjs` | Chrome DevTools Protocol evaluation |

---

## Configuration Files

| File | Purpose |
|------|---------|
| `Cargo.toml` | Rust dependencies (tauri 2, tokio, reqwest, rusqlite, etc.) |
| `tauri.conf.json` | Tauri window config, CSP, bundle targets (NSIS/DMG/deb/AppImage) |
| `package.json` | Root workspace scripts (version sync, build, test) |
| `pnpm-workspace.yaml` | Workspace members: web, packages/*, e2e |
| `web/vite.config.ts` | Vite config (dev server on port 9545, strictPort) |

---

## CI/CD (`.github/workflows/`)

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| `rust-test.yml` | PR / push to main | `cargo fmt --check`, `cargo clippy -D warnings`, `cargo test` |
| `web-test.yml` | PR / push to main | TypeScript typecheck + vitest unit tests |
| `web-e2e.yml` | PR / push to main | Playwright E2E (checkout Hermes-CN-Core + fake model) |
| `release-desktop.yml` | Tag push | Release build & publish |

---

## Documentation (`docs/`)

| File | Content |
|------|---------|
| `desktop-prd/` | Product Requirements Document (6 docs: feature inventory, PRD, IA, specs, backend contract, parity gap) |
| `gateway-connection-overhaul.md` | Gateway connection architecture |
| `managed-runtime.md` | Managed runtime design |
| `hot-update.md` | Hot update design（统一自更新 + UI 热更 + 开发热更 + 使用/验证） |
| `macos-signing-and-notarization.md` | macOS code signing |
| `portable-mode.md` | Portable mode |
| `yolo-mode.md` | YOLO mode |
| `custom-model-context-window.md` | Custom model context window |

---

## Port Conventions

| Port | Purpose |
|------|---------|
| **9120** | Hermes Dashboard (desktop managed runtime) |
| **9119** | User global Hermes Agent (AVOID — managed runtime only) |
| **9545** | Vite dev server (strictPort) |

---

## Dev vs Production Mode

| Aspect | Dev | Production |
|--------|-----|------------|
| WebView loads | `http://localhost:9545` (Vite) | Bundled `web/dist/` |
| REST API | Vite proxy → dashboard (same-origin) | Rust IPC proxy (`api_request` command) |
| Gateway events | WebSocket → Vite proxy `/api/ws` | Official `/api/ws`, fallback to Rust WS relay (`ws_proxy.rs`) |
| Session token | Vite `/__hermes_token` endpoint | Rust `get_runtime_config` command |
| `apiBaseUrl` | Not set (relative path) | Set to dashboard URL |

---

## Rust Testing Conventions

- **Unit tests**: `#[cfg(test)] mod tests { ... }` inline in source files; can access private functions
- **Integration tests**: In `tests/` directory, only use `pub` API via `hermes_agent_cn` crate
- **Env-dependent tests**: Must use `#[serial_test::serial]`
- **Filesystem tests**: Use `tempfile::TempDir`; never write to `/tmp`, cwd, or fixed paths
- **HTTP tests**: Use `wiremock::MockServer`; never real network
- **Assertions**: Prefer `pretty_assertions::assert_eq`
- **Pre-commit**: `cargo test --all-features`

---

## Key Dependencies

### Rust
- **Tauri v2** with `tray-icon` and `devtools` features
- **tokio** (full), **reqwest** (rustls-tls), **tokio-tungstenite**
- **tauri-plugin-dialog**, **tauri-plugin-notification**, **tauri-plugin-clipboard-manager**
- **rusqlite** (bundled), **zip**, **sha2**, **ed25519-dalek**
- **thiserror**, **serde/serde_json**, **portable-pty**, **notify**
- Platform: **windows-sys** + **winreg** (Windows), **objc2** (macOS)

### Frontend
- **React 19**, **react-router 7**, **TanStack Query 5**, **Jotai 2**
- **@tauri-apps/api**, **@tauri-apps/plugin-clipboard-manager**
- **streamdown** (Markdown renderer with CJK/math/mermaid extensions)
- **Radix UI** (dialog, dropdown-menu, popover)
- **xterm** (terminal), **cmdk** (command palette), **recharts**, **lucide-react**

---

## Architecture Rules (DO NOT Violate)

- ❌ Don't hand-write `fetch` outside `web/src/lib/transport.ts` — auth header injection lives there
- ❌ Don't call `gateway-client.ts` raw socket directly — use `hooks/use-gateway.ts`
- ❌ Don't put business logic in `web/src/routes/` — extract to `hooks/` or `lib/`
- ❌ Don't hardcode colors in components — use CSS variables from `packages/shared-ui/src/tokens/`
- ❌ Don't change the bundle identifier `cn.org.hermesagent.desktop`
- ❌ Don't use port 9119 (reserved for user's global Hermes Agent)

---

## Commit Convention

- Conventional Commits: `feat` / `fix` / `style` / `docs` / `refactor` / `chore`
- English subject line, imperative mood ("add ...", "fix ...", "rework ...")
- Description can mix Chinese/English; explain "why" not "what"
