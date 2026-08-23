# Browser Automation — Python → TypeScript Rewrite Plan

## 1. Summary

Browser automation is the largest single tool family in Hermes-CN-Core (~47 test files, 10
`browser_*` tools + `browser_cdp` + `browser_dialog` + `browser_exec`). It drives **multiple
backends** behind one agent-facing surface: Browserbase cloud, Browser Use cloud, Browser Use
CLI 3.0, Firecrawl cloud, Camofox local (anti-detection), Lightpanda local engine, local
Chromium-family via CDP (`/browser connect`), and the default local `agent-browser` CLI.
Pages are exposed to the model as **accessibility-tree snapshots** with `@e1`-style element
refs; a persistent **CDP supervisor** per task adds dialog detection, frame trees, and console
history; sessions can be recorded (WebM), run headed, use stealth, expose VNC live view, and be
persistent across restarts.

Target TS design: a **Node.js sidecar** (new `packages/browser-agent`, run under Rust) that
owns Playwright/CDP/WS I/O and cloud REST, because the Tauri webview cannot host Node APIs or
open arbitrary `wss://` CDP sockets (CSP + no Node runtime). The React app talks to the sidecar
only through Tauri IPC; Rust owns process lifecycle, CDP port probing, and event streaming —
the same split already used by `src/commands/terminal.rs` and `ws_proxy.rs`.

**Key finding (evidence): kimi-code has NO browser-automation equivalent.** Its web tools are
host-injected interfaces (`packages/agent-core/src/tools/builtin/web/web-search.ts`,
`fetch-url.ts`) with no Playwright/Puppeteer/CDP dependency anywhere in its package.json or
node_modules; the only "browser" hits are OAuth window-opening (`src/mcp/oauth/service.ts`).
Browser automation therefore must be **designed from scratch**, with `playwright-core` as the
CDP engine and kimi-code's provider-interface pattern as the architectural template.

## 2. Current Python implementation

Source of truth: `D:/hermes-agent-cn`.

- **Tool surface** — `tools/browser_tool.py` registers 10 tools (`toolset="browser"`):
  `browser_navigate` (line 3058), `browser_snapshot` (3284), `browser_click` (3384),
  `browser_type` (3424), `browser_scroll` (3482), `browser_back` (3531), `browser_press` (3582),
  `browser_console` (3634), `browser_get_images` (4209), `browser_vision` (4270); plus
  `browser_cdp` in `tools/browser_cdp_tool.py`, `browser_dialog` in
  `tools/browser_dialog_tool.py`, and `browser_exec` in `tools/browser_use_cli.py`.
- **Backend dispatch** — `tools/browser_tool.py` resolves the active backend: CDP override
  (`BROWSER_CDP_URL` env / `browser.cdp_url` config) → cloud provider (via
  `agent/browser_registry.py` + `agent/browser_provider.py` ABC, providers in
  `plugins/browser/{browserbase,browser_use,firecrawl}/provider.py`) → Camofox REST
  (`tools/browser_camofox.py`) → Browser Use CLI mode (`tools/browser_use_cli.py`) → local
  `agent-browser` CLI subprocess. Registry precedence is documented in
  `agent/browser_registry.py` (`_LEGACY_PREFERENCE = browser-use → browserbase`, Firecrawl
  explicit-only, `local` short-circuit).
- **Local engine** — `agent-browser` (Node npm CLI, Chromium/Playwright underneath) driven as a
  subprocess with credential-scrubbed env (`_build_browser_env` + `_BROWSER_PASSTHROUGH_KEYS`),
  Playwright browser cache under `$HERMES_HOME/cache/ms-playwright`, Lightpanda engine via
  `browser.engine`/`AGENT_BROWSER_ENGINE` with automatic Chrome fallback
  (`tests/tools/test_browser_lightpanda.py`), headed mode (`browser.headed`,
  `AGENT_BROWSER_HEADED`) and WebM recording (`browser.record_sessions`,
  `~/.hermes/browser_recordings/`, 72h cleanup).
- **CDP attach** — `hermes_cli/browser_connect.py`: discovers/launches Chrome/Brave/Chromium/
  Edge with `--remote-debugging-port=9222` + dedicated `--user-data-dir=$HERMES_HOME/chrome-debug`,
  dual-stack IPv4/IPv6 probing, port conflict fallback.
- **CDP supervisor** — `tools/browser_supervisor.py`: one `CDPSupervisor` per task holds a
  persistent CDP WebSocket, subscribes Page/Runtime/Target events, injects an XHR dialog bridge
  for Browserbase (`_DIALOG_BRIDGE_SCRIPT`), exposes thread-safe `SupervisorSnapshot`
  (`pending_dialogs`, `recent_dialogs`, `frame_tree`, `console_errors`), policies
  `must_respond|auto_dismiss|auto_accept`.
- **Cloud providers** — `create_session(task_id)` → `{session_name, bb_session_id, cdp_url,
  expires_at, features}`; Browserbase REST `POST /v1/sessions` with 402 fallback for
  keepAlive/proxies; Firecrawl cloud browser with `FIRECRAWL_BROWSER_TTL`.
- **SSRF / hardening** — `tools/url_safety.py` (`is_safe_url`, `is_always_blocked_url`,
  `normalize_url_for_request`), `evaluate_url_safety` in `browser_tool.py`, private-page guards
  in `browser_cdp_tool.py` (`_browser_cdp_private_guard`, `_CDP_PRIVATE_PAGE_ALLOWED_METHODS`),
  secret redaction (`agent/redact.py` `redact_cdp_url`), hybrid routing
  (`browser.auto_local_for_private_urls` → local sidecar for LAN/loopback URLs).
- **Camofox** — REST API (`CAMOFOX_URL`), `/health` → `vncPort`, tab adoption,
  `managed_persistence` (stable profile-scoped `userId`), loopback URL rewrite for Docker,
  VNC URL surfaced in navigation results.
- **Browser Use CLI 3.0** — `browser_exec(code, session, timeout_s)`: pipes Python to the
  `browser-use` CLI (installed via `uv tool install browser-use`), workspace dir per task,
  screenshot path sniffing for native-vision attachment; gated to terminal-enabled sessions.
- **Docs/tests** — `website/docs/user-guide/features/browser.md`,
  `website/docs/developer-guide/browser-supervisor.md`; tests
  `tests/tools/test_browser_*.py` (37 files found under `tests/tools/`, ~47 per features_report
  incl. CLI/docker/integration), `tests/cli/test_cli_browser_connect.py`,
  `tests/docker/test_stage2_browser_discovery.py`, `tests/integration/test_web_tools.py`.

## 3. Target TypeScript design

Runs in-process (TS agent loop) + a Node sidecar for browser I/O. The webview never holds CDP
sockets or cloud WS connections; Rust is the transport boundary.

```
webview (React, Tauri IPC)
  └─ web/src/lib/browser/*        tool logic, routing, SSRF, snapshots, UI state
       └─ invoke("browser_*") ──► Rust src/commands/browser.rs
            ├─ spawn/supervise sidecar (node packages/browser-agent)
            ├─ probe CDP ports / launch local Chromium (port of browser_connect.py)
            └─ stream events (browser-events) to webview (terminal.rs pattern)
                 └─► packages/browser-agent (Node sidecar)
                      ├─ playwright-core CDP engine (local / connectUrl / lightpanda)
                      ├─ cloud REST clients (Browserbase / Browser Use / Firecrawl)
                      ├─ Camofox REST client + VNC URL
                      ├─ CDP supervisor (dialog bridge, frame tree, console ring)
                      └─ recorder (WebM) / headed / stealth / persistent profiles
```

Proposed module layout (new workspace package `packages/browser`, mirrored by
`web/src/lib/browser/*` for pure-TS logic):

- `packages/browser/src/provider.ts` — `BrowserProvider` interface: `name`, `displayName`,
  `isAvailable()`, `createSession(taskId)`, `closeSession(sessionId)`, `emergencyCleanup()`
  (mirror of `agent/browser_provider.py`; kimi-code host-injected-provider pattern from
  `web-search.ts`).
- `packages/browser/src/registry.ts` — registration + `_resolve(configured)` with the same
  precedence rules as `agent/browser_registry.py` (explicit config wins, legacy preference
  walk, `local` short-circuit).
- `packages/browser/src/backends/{browserbase,browser-use,firecrawl,camofox,lightpanda,cdp,agent-browser}.ts`.
- `packages/browser/src/supervisor.ts` — CDP supervisor; `packages/browser/src/dialog.ts`;
  `packages/browser/src/recorder.ts`; `packages/browser/src/ssrf.ts` (port of
  `tools/url_safety.py` + browser guards); `packages/browser/src/session-manager.ts`
  (per-task sessions, inactivity reaper, atexit cleanup).
- `packages/browser-agent/` (Node sidecar, `.mjs`): exposes JSON-RPC over stdio (spawned by
  Rust with `--remote-debugging-port`-style env) or a loopback TCP/WS port; owns all
  playwright/CDP/WS/REST I/O.
- `web/src/lib/browser/{tools,provider,commands}.ts` — in-process tool implementations that
  mirror the Python tool signatures exactly (see §7 frozen surface).
- `src/commands/browser.rs` — Rust Tauri commands: `browser_sidecar_start/stop`,
  `browser_cdp_probe`, `browser_launch_chrome_debug`, `browser_event_subscribe`; port
  `hermes_cli/browser_connect.py` discovery/launch logic (dual-stack probe, `chrome-debug`
  data dir, free-port fallback).

Tool data flow: tool call → dispatcher resolves backend (registry/Camofox/CDP-override/CLI
mode) → session lookup/create → backend op (sidecar CDP/REST or direct HTTP) → normalized
result → SSRF/snapshot post-processing → tool result JSON. `browser_snapshot` merges
supervisor state (`pending_dialogs`, `frame_tree`) exactly like the Python `to_dict()` shape;
snapshots >15,000 chars are truncated/summarized and the full copy stored under
`cache/web/` for `read_file` paging (same constants as
`SNAPSHOT_SUMMARIZE_THRESHOLD` / `MAX_STORED_SNAPSHOT_CHARS`).

## 4. Data models & persistence

- **Tool schemas** — Zod in `packages/protocol/src/browser-api.ts` (pattern:
  `packages/protocol/src/hermes-api.ts`), one input/result type per tool; result JSON must
  match Python's `tool_result`/`tool_error` shapes (success/error + backend-specific fields)
  so the model sees no difference.
- **Session record** — `{ taskId, backend, sessionName, bbSessionId, cdpUrl, expiresAt,
  features, externalCallId, lastActiveAt }` (Python contract in `agent/browser_provider.py`);
  in-memory map + optional SQLite/JSON snapshot for restart rehydration (Camofox tab adoption,
  Browserbase keepAlive).
- **Supervisor snapshot** — `PendingDialog`, `DialogRecord`, `FrameInfo`, `ConsoleEvent`,
  `SupervisorSnapshot` dataclasses → TS interfaces; caps `FRAME_TREE_MAX_ENTRIES=30`,
  `CONSOLE_HISTORY_MAX=50`, `RECENT_DIALOGS_MAX=20` preserved.
- **Config** — `browser.*` keys (`cloud_provider`, `backend`, `cdp_url`, `command_timeout`,
  `headed`, `record_sessions`, `inactivity_timeout`, `engine`, `camofox.*`,
  `auto_local_for_private_urls`, `allow_private_urls`, `restrict_evaluate`,
  `dialog_policy`/`dialog_timeout_s`) read from the same config file the desktop already
  manages; env vars (`BROWSERBASE_API_KEY`, `BROWSER_USE_API_KEY`, `FIRECRAWL_API_KEY`,
  `CAMOFOX_URL`, `AGENT_BROWSER_*`, `BROWSER_CDP_URL`) live in the desktop secret store.
- **Persistence paths** (mirror Core): recordings `~/.hermes/browser_recordings/` (72h sweep),
  Playwright browsers `~/.hermes/cache/ms-playwright/`, Chrome debug profile
  `~/.hermes/chrome-debug/`, Camofox profile key dir `~/.hermes/browser_auth/camofox/`,
  snapshot overflow `~/.hermes/cache/web/`, screenshots `~/.hermes/cache/screenshots/`
  (24h cleanup), browser-use workspace `~/.hermes/cache/browser-use/workspace/<task>`.

## 5. Third-party library strategy

Most important section. Python dependency → TS equivalent, with kimi-code evidence:

| Python dep (Core) | TS equivalent | Evidence / status |
|---|---|---|
| `agent-browser` npm CLI (Node + Playwright) | `playwright` + `playwright-core` (npm) | **No kimi-code evidence** — kimi-code has no Playwright/Puppeteer dep. Ecosystem: `playwright` is the standard npm browser automation lib. `agent-browser` itself is npm-installable (`npm install -g agent-browser` per Core docs), so it can run inside the sidecar Node process unchanged. |
| `websockets` (CDP) | `playwright-core` CDPSession + `ws` npm for raw passthrough | Playwright's `browser.newBrowserCDPSession()` covers the supervisor; raw `browser_cdp` passthrough needs `ws` (or `chrome-remote-interface`, unverified). No kimi-code evidence. |
| `requests` (cloud REST) | `undici` (fetch) | kimi-code `packages/agent-core/package.json` depends on `undici ^7.27.1`. |
| `orjson` | native `JSON.parse/stringify` | built-in. |
| `pybase64` | `Buffer.toString("base64")` | built-in. |
| `agent.auxiliary_client.call_llm` (snapshot summarize / vision) | in-process LLM call via the desktop's existing model client | kimi-code has `image-compress.ts` (`packages/agent-core/src/tools/support/image-compress.ts`, jimp + wasm WebP decoder) for screenshot resize/encode before vision — reuse for `browser_vision` (Python `_resize_image_for_vision` parity). |
| Browserbase REST | `@browserbasehq/sdk` (npm) or hand-rolled fetch | Ecosystem only, **not in kimi-code** — verify package availability. Fallback: direct REST (`POST /v1/sessions`, `connectUrl`) with undici. |
| Browser Use cloud REST | hand-rolled fetch (API key auth) | **No TS SDK found in kimi-code**; implement thin REST client. |
| Firecrawl cloud | `@mendable/firecrawl-js` (npm) or REST | Ecosystem only, **not in kimi-code**; fallback plain fetch. |
| Camofox REST server | hand-rolled fetch client + `@novnc/novnc` (or open VNC URL externally) | Camofox server is Node — unchanged; TS client is a small REST wrapper (mirror `tools/browser_camofox.py`). VNC: noVNC npm or `open::that` URL via Rust. |
| Browser Use CLI 3.0 (Python CLI) | spawn external `browser-use` CLI via Rust/Node child process | **No TS equivalent** — the CLI is Python. Keep as an optional external tool (same posture as the desktop terminal spawning a shell); gate `browser_exec` on terminal availability exactly like Core. Alternative (unverified): reimplement minimal harness on Playwright — out of scope. |
| Lightpanda engine | `playwright-core` connecting to Lightpanda CDP endpoint | Lightpanda exposes CDP; same driver as local Chrome. No kimi-code evidence. |
| stealth (Browserbase) | Browserbase API feature flags (`proxies`, `advancedStealth`, `keepAlive`) | No TS equivalent needed — provider API. Local stealth: `puppeteer-extra-plugin-stealth` (npm, ecosystem, unverified in kimi-code) or Camofox. |
| WebM session recording | Playwright `recordVideo` (local) + Browserbase session recording API (cloud) | Ecosystem; Python uses agent-browser `record` command — sidecar can call the same. 72h sweep in Rust/TS timer. |
| xterm (UI console) | already in desktop: `@xterm/xterm ^6.0.0` | Existing dependency (web/package.json). |
| Zod tool schemas | `zod` | kimi-code uses zod in `web-search.ts` (`WebSearchInputSchema`). |
| kimi-code provider pattern | `BrowserProvider` interface injected into tools | Direct evidence: `WebSearchTool(provider)` / `FetchURLTool(fetcher)` in kimi-code `builtin/web/`. |

Explicit "implement from scratch": CDP supervisor, dialog bridge injection, SSRF/URL-safety
module (port `tools/url_safety.py` semantics), provider registry, hybrid routing oracle, and
`browser_cdp` raw passthrough — none exist in kimi-code.

## 6. Integration with existing Hermes-CN-Desktop frontend

- **Reuse `src/commands/terminal.rs` + `web/src/components/console/embedded-terminal.tsx`** for
  `/browser connect`-style interactive UX and for displaying `browser_exec` output; the
  terminal pty is also the natural "terminal toolset" gate for `browser_exec` parity.
- **Reuse `src/commands/ws_proxy.rs` / `api_proxy.rs` patterns** for sidecar event streaming
  and cloud REST (or let the sidecar do REST directly — sidecar is preferred so the webview
  never needs `connect-src` for arbitrary hosts).
- **New UI**: `web/src/routes/browser.tsx` (snapshot explorer with `@ref` highlighting, headed
  browser live view, VNC noVNC iframe, recording list), `web/src/hooks/use-browser.ts`, Jotai
  atoms for active sessions (`web/src/stores/`), CSS modules + `packages/shared-ui` tokens.
- **Existing `browser-companion.ts` + `src/commands/browser_companion.rs`** are the inverse
  feature (open external browser → dashboard). Keep separate; the sidecar design complements it.
- **`packages/protocol`**: add `browser-api.ts` Zod schemas; extend `channels.ts` with
  `browser-events` channel if needed.
- **CSP**: `tauri.conf.json` `connect-src` already allows `ws://127.0.0.1:*` /
  `wss://127.0.0.1:*` (fine for sidecar loopback); `frame-src` currently only allows `self` +
  loopback http — extend for noVNC iframe if VNC is embedded, otherwise open VNC URL in system
  browser via Rust (`open::that`, precedent in `browser_companion.rs`).
- **Settings**: add Browser Automation panel (backend picker, credential inputs, Camofox
  persistence toggle) alongside existing `routes/settings-*` sections; reuses
  `lib/config-update.ts` / `use-config.ts` and env-var handling.

## 7. Removing the WebSocket dependency (migration path)

Today the browser tools execute in the Python managed runtime and reach the desktop over
Dashboard `/api/ws` JSON-RPC tool calls + REST. Freeze this surface, then replace in place:

1. **Freeze the tool API surface** (contract parity, unchanged across migration):
   - `browser_navigate(url)`, `browser_snapshot(full?)`, `browser_click(ref)`,
     `browser_type(ref, text)`, `browser_scroll(direction)`, `browser_back()`,
     `browser_press(key)`, `browser_console(clear?, expression?)`,
     `browser_get_images()`, `browser_vision(question, annotate?)`;
   - `browser_cdp(method, params?, target_id?, frame_id?)`,
     `browser_dialog(action, prompt_text?, dialog_id?)`, `browser_exec(code, session?, timeout_s?)`.
   - Result JSON: `{success, error?, ...backend fields}` matching `tool_result`/`tool_error`.
2. **Phase A — sidecar behind the same interface**: register the TS tools in the agent loop
   under the same names/schemas; add `browser.backend: "builtin-ts"` toggle; route only
   browser calls to TS, everything else stays on WS.
3. **Phase B — default in-process**: flip the default; the WS/REST browser path becomes a
   fallback config flag while parity tests pass.
4. **Phase C — delete the WS browser path**: browser tools never touch `/api/ws`; cloud REST
   goes sidecar → provider API directly; sessions/recordings/snapshots persist locally; the
   Python backend no longer needs `tools/browser*` loaded for desktop sessions.

## 8. Migration phases & task breakdown

- **M0 Sidecar skeleton**: create `packages/browser-agent` (Node, JSON-RPC over stdio),
  `src/commands/browser.rs` spawn/supervise/kill, IPC bridge, vitest smoke.
- **M1 Local CDP core**: `playwright-core` launch, `browser_navigate/snapshot/click/type/
  scroll/back/press/console/get_images`, snapshot truncation + `cache/web` overflow, ref
  selectors, SSRF module (`ssrf.ts` port of `url_safety.py` + `evaluate_url_safety`).
- **M2 CDP attach + supervisor**: port `browser_connect.py` (discovery, launch, dual-stack,
  `chrome-debug` dir), `browser_cdp` passthrough (`ws`), `browser_dialog` + supervisor
  (dialog bridge XHR script, frame tree, console ring, policies).
- **M3 Cloud backends**: `BrowserProvider` interface + registry; Browserbase, Browser Use,
  Firecrawl REST clients (`create_session` → `cdp_url`, 402 fallbacks), hybrid routing
  (`auto_local_for_private_urls`), cloud CDP through the sidecar supervisor.
- **M4 Camofox + Lightpanda**: Camofox REST client, `/health` VNC discovery, tab adoption,
  managed persistence (`browser_auth/camofox`), loopback rewrite; Lightpanda engine + Chrome
  fallback; Camofox-vs-CDP-override precedence.
- **M5 Browser Use CLI mode**: `browser_exec` spawn of the external CLI, workspace dirs,
  screenshot sniffing + native-vision attach, terminal gating, `backend: off` opt-out.
- **M6 UX features**: WebM recording (local Playwright video + Browserbase API), headed mode
  (keep-alive between turns, inactivity reaper), stealth flags, VNC live view, persistent
  sessions, `routes/browser.tsx` UI + settings panel.
- **M7 Migration + parity**: default in-process routing, delete WS browser path, run full
  parity suite, update `EXPECTED_BACKEND_VERSION`-style docs and `features_report.md`.

## 9. Risks & open questions

- **No kimi-code browser equivalent** (highest risk): every backend is designed from scratch;
  only the provider-interface pattern and `image-compress.ts`/`undici`/zod evidence transfer.
  Playwright-core sidecar is a proven approach but must be bundled and version-pinned.
- **Tauri webview constraints**: webview cannot host Node/CDP or arbitrary `wss://`; the
  sidecar boundary is mandatory. CSP must be extended only for noVNC/frame-src if embedded.
- **Browser Use CLI is Python**: spawning it keeps a Python dependency alive for `browser_exec`
  only; conflicts with the "no Python runtime" goal. Open question: is `browser_exec` in scope
  for desktop standalone, or should the desktop force `browser.backend: off` + built-in tools?
- **Cloud CDP through sidecar**: Browserbase `connectUrl` is `wss://` to a remote host — the
  sidecar (not webview) must hold it; supervisor dialog bridge must be ported exactly
  (Browserbase auto-dismisses native dialogs; only the XHR bridge works there).
- **SSRF parity**: `tools/url_safety.py` includes DNS-resolution and proxy-aware logic
  (`ssrf_safe_http_transport`); the TS port must match `is_safe_url`/`is_always_blocked_url`/
  `evaluate_url_safety` behavior or the SSRF/exfil hardening tests will fail parity.
- **Vision**: `browser_vision` needs the desktop's model client + image compression; kimi-code
  `image-compress.ts` covers resize/encode, but the "native vision fast path" screenshot
  attach (`_resize_image_for_vision`) has no direct TS twin — implement a thin equivalent.
- **Managed Nous gateway**: Browser Use cloud via the Nous gateway needs the gateway token
  path (`use_gateway`) — desktop in-process must resolve it or drop the gateway variant.
- **Recording in cloud mode** relies on provider recording APIs; local WebM via Playwright
  video differs in format/timing — parity tests must tolerate both.
- **Unverified ecosystem claims**: `@browserbasehq/sdk`, `@mendable/firecrawl-js`,
  `puppeteer-extra-plugin-stealth`, noVNC npm — none were found in kimi-code (no node_modules
  present); confirm versions/licensing before committing.

## 10. Test strategy

- **Vitest unit (TS)**, mirroring the Python browser cluster:
  - `registry/dispatcher` — port `test_browser_hybrid_routing.py`, `test_browser_cloud_fallback.py`.
  - `ssrf.ts` — port `test_browser_snapshot_ssrf.py`, `test_browser_get_images_ssrf.py`,
    `test_browser_eval_ssrf.py`, `test_browser_console_ssrf.py`, `test_browser_secret_exfil.py`,
    `test_browser_hardening.py` (private-page guard + CDP allow-list).
  - `engine/headed` — port `test_browser_lightpanda.py`, `test_browser_headed_mode.py`,
    `test_browser_chromium_autoinstall.py`, `test_browser_chromium_check.py`.
  - `camofox` — port `test_browser_camofox*.py` (auth, ensure_tab, persistence,
    private_page_guard, timeout, state).
  - `supervisor/dialog` — port `test_browser_supervisor.py`, `test_browser_supervisor_healthcheck.py`,
    `test_browser_cdp_tool.py`, `test_browser_use_cli.py` (session expiry).
  - `session lifecycle` — port `test_browser_cleanup.py`, `test_browser_orphan_reaper.py`,
    `test_browser_command_timeout_race.py`, `test_browser_open_timeout.py`.
- **Integration** — mock cloud REST with `msw`/wiremock-style server (port
  `test_managed_browserbase_and_modal.py` non-Windows parts), real Playwright against local
  static pages (parity with `tests/integration/test_web_tools.py` browser section), CDP
  supervisor against a Playwright-launched Chromium, `/browser connect` discovery against a
  fake CDP endpoint (port `tests/cli/test_cli_browser_connect.py`), sidecar JSON-RPC contract
  tests.
- **Rust tests** — `tests/` crate: sidecar spawn/exit/reap, CDP port probing (wiremock-free,
  real loopback socket), event streaming to webview.
- **Playwright E2E** (`e2e/`): snapshot viewer UI, headed live view, recordings list,
  settings panel — against real Core backend only until M7, then against the in-process TS
  stack.
- **Parity harness**: table-driven compare of TS tool result JSON vs recorded Python outputs
  for each tool × backend mode.

## 11. Reference links

- Core docs: `D:/hermes-agent-cn/website/docs/user-guide/features/browser.md`,
  `D:/hermes-agent-cn/website/docs/developer-guide/browser-supervisor.md`,
  `D:/hermes-agent-cn/website/docs/developer-guide/browser-provider-plugin.md`.
- Core impl: `D:/hermes-agent-cn/tools/browser_tool.py`,
  `tools/browser_camofox.py`, `tools/browser_cdp_tool.py`, `tools/browser_supervisor.py`,
  `tools/browser_use_cli.py`, `tools/browser_dialog_tool.py`, `tools/url_safety.py`,
  `agent/browser_provider.py`, `agent/browser_registry.py`, `hermes_cli/browser_connect.py`,
  `plugins/browser/{browserbase,browser_use,firecrawl}/provider.py`.
- Core tests: `tests/tools/test_browser_*.py` (37 found), `tests/cli/test_cli_browser_connect.py`,
  `tests/docker/test_stage2_browser_discovery.py`, `tests/integration/test_web_tools.py`.
- kimi-code: `packages/agent-core/src/tools/builtin/web/{web-search,fetch-url}.ts`,
  `packages/agent-core/src/tools/support/image-compress.ts`,
  `packages/agent-core/package.json` (`undici`, `@jsquash/webp`), `src/mcp/oauth/service.ts`
  (only "browser" hits — no automation equivalent).
- Desktop: `web/src/lib/browser-companion.ts`, `web/src/routes/console.tsx`,
  `web/src/components/console/embedded-terminal.tsx`, `src/commands/terminal.rs`,
  `src/commands/browser_companion.rs`, `src/commands/ws_proxy.rs`, `src/commands/preview.rs`,
  `packages/protocol/src/hermes-api.ts`, `tauri.conf.json` (CSP).
