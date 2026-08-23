# Home Assistant (Messaging) Platform Adapter — Python → TypeScript Rewrite Plan

> Port decision recorded up front: **Home Assistant is a gateway-side messaging platform adapter
> and is marked "out of scope for desktop standalone"** (per `plans/README.md`). The desktop keeps
> talking to the Core managed runtime gateway over REST (`/api/messaging/platforms`) and WS
> (`/api/ws`) and does **not** host the HA WebSocket event stream in-process in v1. This file still
> designs the in-process TS port (Sections 3–10) so the decision is recorded and a future standalone
> build can pick it up. It follows the same pattern as `plans/slack-platform.md` and complements —
> does not duplicate — the sibling toolset plan `plans/home-assistant.md` (feature #54, the `ha_*`
> LLM tools), which explicitly defers this messaging-platform feature to `plans/_INDEX.md` #93.

## 1. Summary

Hermes-CN-Core ships a Home Assistant **messaging platform adapter**
(`plugins/platforms/homeassistant/adapter.py`, 604 lines). It does two things:

1. **Conversation (inbound)** — opens a persistent WebSocket to the user's HA instance
   (`ws(s)://<hass_url>/api/websocket`), authenticates with `HASS_TOKEN`, subscribes to
   `state_changed` events, applies domain/entity filters plus per-entity cooldowns, formats each
   change into a human-readable `MessageEvent`, and forwards it to the agent.
2. **Notify (outbound)** — replies are delivered as HA **persistent notifications** via the REST
   API (`POST /api/services/persistent_notification/create`, title "Hermes Agent", message capped at
   4096 chars). A standalone sender (`_standalone_send`) delivers out-of-process cron messages via
   `notify.notify` (`deliver=homeassistant`).

Key design decisions:

1. **Keep the adapter in the Python gateway for v1** — the desktop has no HA UI today (only a
   generic `status.gateway_platforms` echo), and HA's event push needs a persistent outbound WS
   client plus LAN-http REST access that the standalone webview should not own yet. This plan
   records the port decision and sketches the "if ported" TS design.
2. **`home-assistant-js-websocket` is the recommended TS base if a port ever happens** — it is the
   official npm library and the ecosystem standard for the HA WS auth handshake +
   `subscribe_events` protocol. It is **not present anywhere in `D:/kimi-code`** (verified,
   Section 5), so it would be a new dependency with no in-repo precedent.
3. **Sibling plan boundary**: `plans/home-assistant.md` (#54) covers the four REST `ha_*` tools and
   already reuses `persistent_notification.create` as the notification pattern; this plan covers the
   **gateway adapter** (event streaming + outbound notify) and the standalone cron sender only.
4. **WS-removal implication is one-directional**: deleting the desktop↔Python `/api/ws` link does
   **not** remove HA's need for its own WS connection to the user's HA server — porting HA
   in-process would actually **add** an outbound WS requirement (Section 7).

## 2. Current Python implementation

Source of truth: `D:/hermes-agent-cn`

| Path | Role (verified by reading) |
|---|---|
| `plugins/platforms/homeassistant/adapter.py` (604 lines) | `HomeAssistantAdapter(BasePlatformAdapter)` — WS connect/auth/subscribe, reconnect backoff `[5,10,30,60]` s, heartbeat 30 s, event filter pipeline, domain-specific formatting, REST `send()`, `_standalone_send` |
| `plugins/platforms/homeassistant/plugin.yaml` | `name: homeassistant-platform`; `requires_env: HASS_TOKEN` (password); `optional_env: HASS_URL`; emoji 🏠 |
| `plugins/platforms/homeassistant/__init__.py` | `from .adapter import register` |
| `gateway/config.py` (line 334, 2152–2161) | `Platform.HOMEASSISTANT = "homeassistant"`; env seeding: `HASS_TOKEN` → `platform.token`, `HASS_URL` → `platform.extra["url"]`, enabled when token set |
| `hermes_cli/web_server.py` (8630, 8824, 8875–8883, 9073) | `/api/messaging/platforms` catalog entry `homeassistant` (`env_vars`/`required_env = HASS_URL, HASS_TOKEN` — note REST catalog lists `HASS_URL` as required though `plugin.yaml` marks it optional); platform order; `HASS_*` env-var descriptions (HASS_TOKEN `password: true`); `_platform_env_prefixes("homeassistant") = ("HASS_",)` |
| `gateway/platforms/base.py` | `BasePlatformAdapter`, `MessageEvent`, `MessageType`, `SendResult` shared contract |

Data flow (inbound):

1. `connect()` → `_ws_connect()`: derive `ws://`/`wss://` from `_hass_url`, receive
   `auth_required`, send `{"type":"auth","access_token":...}`, await `auth_ok`, then
   `subscribe_events` for `state_changed` and verify the `success` ack.
2. `_listen_loop()` reads WS frames; on error/cancel reconnects with `_BACKOFF_STEPS =
   [5, 10, 30, 60]` s and resets on success.
3. `_handle_ha_event()` pipeline (closed by default): drop empty `entity_id` → drop
   `ignore_entities` → require `watch_domains` / `watch_entities` match **or** `watch_all` (no
   filters + no `watch_all` ⇒ drop + startup warning) → per-entity cooldown
   (`cooldown_seconds`, default 30) → `_format_state_change()` → build `MessageEvent` →
   `handle_message()`.
4. `_format_state_change()` is a pure function with domain branches: `climate` (HVAC + temps),
   `sensor` (unit suffix), `binary_sensor` (triggered/cleared), `light|switch|fan` (turned on/off),
   `alarm_control_panel`, generic fallback; returns `None` when old==new.

Data flow (outbound):

- `send(chat_id, content, ...)` → REST `POST {hass_url}/api/services/persistent_notification/create`
  with `Authorization: Bearer <token>`, JSON `{"title": "Hermes Agent", "message": content[:4096]}`;
  `<300` ⇒ `SendResult(success=True, message_id=uuid4().hex[:12])`, else error; 10 s timeout.
- `_standalone_send(pconfig, chat_id, message, ...)` → REST `POST .../api/services/notify/notify`
  with `{"message": ..., "target": chat_id}`; accepts `thread_id`/`media_files`/`force_document`
  for signature parity but ignores them; used by cron `deliver=homeassistant`
  (`tools/send_message_tool._send_via_adapter`).
- `register()` exposes: `adapter_factory`, `check_fn=check_ha_requirements` (aiohttp present),
  `validate_config` (token non-empty), `is_connected` (`HASS_TOKEN` set), `required_env=["HASS_TOKEN"]`,
  `standalone_sender_fn=_standalone_send`, `max_message_length=4096`, `emoji="🏠"`,
  `allow_update_command=True`.

Docs: `website/docs/user-guide/messaging/homeassistant.md` (269 lines) — setup, the two-way split
(gateway platform vs `ha_*` tools), event filtering table, formatting table, security/blocked
domains, troubleshooting (401, `.local` reachability).

## 3. Target TypeScript design

**Port decision (recorded):** keep the adapter in the Python gateway for v1; the desktop only
needs an optional config/status surface (Section 6). The in-process design below is the
"if ported" target.

Proposed module layout (suggested `packages/ha-platform/` or `web/src/platforms/homeassistant/`,
implementing the `PlatformAdapter` interface from `plans/messaging-gateway-core.md` §3):

```
packages/ha-platform/src/
  adapter.ts          # HomeAssistantAdapter — lifecycle, event pump, PlatformAdapter impl
  ws-transport.ts     # HassWsClient — auth handshake, subscribe_events, heartbeat, reconnect backoff
  rest-client.ts      # HassRestClient — persistent_notification.create / notify.notify (send + standalone)
  events.ts           # state_changed → MessageEvent normalization (source/message_id shapes)
  filters.ts          # watch/ignore domains+entities, watch_all, per-entity cooldown
  format.ts           # formatStateChange() — pure port of _format_state_change
  config.ts           # HASS_URL/HASS_TOKEN + platform extra: watch_*, cooldown_seconds
  standalone-send.ts  # cron deliver=homeassistant sender (notify.notify)
  index.ts
```

Key interfaces (pseudocode, not implementation):

```ts
interface HassPlatformConfig {
  url: string;                       // default http://homeassistant.local:8123, trailing "/" stripped
  token: string;
  watchDomains: string[]; watchEntities: string[]; ignoreEntities: string[];
  watchAll: boolean; cooldownSeconds: number;      // default 30
}

interface HassWsClient {
  connect(): Promise<boolean>;        // auth_required → auth → auth_ok → subscribe_events ack
  onEvent(cb: (event: StateChangedEvent) => void): void;
  heartbeatIntervalMs?: number;       // Python 30 s heartbeat
  disconnect(): Promise<void>;
}

interface HomeAssistantAdapter extends PlatformAdapter {
  connect(opts?: { isReconnect?: boolean }): Promise<boolean>;
  disconnect(): Promise<void>;
  send(chatId: string, content: string, opts?: { replyTo?: string; metadata?: unknown }): Promise<SendResult>;
  sendTyping(chatId: string): Promise<void>;        // no-op (HA has no typing indicator)
  getChatInfo(chatId: string): Promise<{ name: string; type: "channel"; url: string }>;
}

// pure parity functions
function formatStateChange(entityId: string, oldState: State, newState: State): string | null;
function shouldForward(filters: HaFilters, entityId: string, cooldown: CooldownMap, now: number): boolean;
```

Data flow (in-process, if ever ported): `HassWsClient.connect()` → filter/cooldown →
`formatStateChange()` → `MessageEvent{ source: { platform:"homeassistant", chat_id:"ha_events",
chat_name:"Home Assistant Events", chat_type:"channel", user_id:"homeassistant" }, message_id:
"ha_<entity_id>_<unix>", text }` → gateway session pipeline → agent turn →
`adapter.send()` → `HassRestClient` → `persistent_notification.create`. Cron path reuses
`standalone-send.ts` with `notify.notify`.

## 4. Data models & persistence

- **No durable message store needed.** HA is the source of truth for device state; the gateway
  session ledger (per `plans/messaging-gateway-core.md` §4) owns conversation persistence. Nothing
  HA-specific is written to disk.
- **In-memory state** (mirrors the Python adapter, all bounded):
  - `_last_event_time: Map<entityId, epochSec>` — cooldown table (default TTL 30 s per entity);
  - filter sets `watch_domains` / `watch_entities` / `ignore_entities` / `watch_all`;
  - WS connection state (`session`, `ws`, `listenTask`, `msgId` counter), reset on reconnect.
- **Credentials**: `HASS_TOKEN` (password) + `HASS_URL` persist in the managed runtime env/secret
  store today (`.env` via `/api/env`); if in-process later, move to Tauri app-data/keychain behind
  the same env-snapshot interface used by `plans/tool-categories.md` (`hasSecret("HASS_TOKEN")`
  gate). No DB migration needed.
- **Platform config extras** (`watch_domains`, `watch_entities`, `ignore_entities`, `watch_all`,
  `cooldown_seconds`) come from the Core REST config in v1; in-process they become a
  `HassPlatformConfig` JSON (Zod-validated) mirroring `PlatformConfig.extra`.

## 5. Third-party library strategy

**Verified: no Home Assistant equivalent exists in `D:/kimi-code`.** A repo-wide,
case-insensitive grep for `home assistant|homeassistant|HASS_TOKEN|home-assistant-js-websocket`
over `D:/kimi-code` returned **zero matches** (source, `package.json` files, and
`node_modules`). `node_modules` contains no `home-assistant*` package (checked `node_modules`,
`node_modules/.pnpm`). The generic WS client `ws@8.20.0` **is** present (used by
`packages/kap-server` and `packages/klient`) — evidence only for generic WS plumbing, not for the
HA protocol.

| Python dependency (feature) | TS equivalent | Evidence / notes |
|---|---|---|
| `aiohttp` WS (`_ws_connect`, `ws_connect(heartbeat=30)`, `receive_json`) | **`home-assistant-js-websocket` (recommend)** — official npm lib: `createConnection`/`auth` handshake helpers, `subscribeEvents`, `callService`; or hand-rolled `ws@8.20.0` if we must stay dependency-free | **Not in kimi-code** (verified); npm official: https://github.com/home-assistant/home-assistant-js-websocket. Covers `auth_required`/`auth`/`auth_ok` and `subscribe_events` ack protocol our adapter hand-rolls. |
| `aiohttp` REST (`send`, `_standalone_send`) | native `fetch` (webview) or Rust `reqwest` behind Tauri IPC | kimi-code `packages/agent-core/src/tools/providers/local-fetch-url.ts` uses `globalThis.fetch`; Desktop Rust already uses `reqwest` (`src/commands/api_proxy.rs`). Recommend Rust `ha_request` path from `plans/home-assistant.md` §6 for LAN-http/CORS/SSRF (see R3). |
| WS reconnect backoff `[5,10,30,60]` + heartbeat | custom state machine; borrow kimi-code kap-server WS transport pattern | evidence: `packages/kap-server/src/transport/ws/v1/sessionEventBroadcaster.ts`, `packages/klient` (uses `ws@8.20.0`); no off-the-shelf HA-specific retry lib. |
| `orjson` (WS frame + REST JSON) | `JSON.parse` / `JSON.stringify` | n/a — kimi-code uses built-ins throughout. |
| `uuid` (message_id / SendResult) | `crypto.randomUUID()` | webview global; kimi-code uses `crypto.randomUUID` in agent-core. |
| `agent.secret_scope.get_secret` + `os.getenv` (creds) | env snapshot + `hasSecret()` gate | `plans/tool-categories.md` §3 `availability.ts`; v1 reads `/api/env` via `use-env.ts`, later the in-process env store. |
| `asyncio` tasks/loops | native `async/await` | n/a — in-process runtime is async-native. |

Explicit **no TS equivalent found** items to hand-port: (a) HA WS protocol client — recommend new
dependency `home-assistant-js-websocket`; if policy forbids new deps, hand-roll on `ws@8.20.0`
(auth handshake + subscribe_events + heartbeat, ~150 lines); (b) `_format_state_change` domain
branches — verbatim pure-function port; (c) filter/cooldown pipeline — verbatim port; (d)
`_standalone_send` `notify.notify` sender — thin REST POST.

## 6. Integration with existing Hermes-CN-Desktop frontend

- **Existing to reuse (v1, recommended path)**:
  - `web/src/routes/settings.tsx` (line ~1478) — the Settings DebugCard already renders
    `status.gateway_platforms` generically (`homeassistant` appears automatically once the runtime
    reports it); no HA-specific change required for status visibility.
  - `web/src/lib/im-onboarding-diagnostics.ts` (450 lines) — `ImDiagnosticBundle` builder is the
    template for an optional `ha-diagnostics.ts`: required key `HASS_TOKEN`, policy/optional keys
    `HASS_URL` + watch-filter extras, gateway platform state, test result, issue list.
  - `web/src/hooks/use-im-onboarding.ts` — `useMessagingPlatform` (GET `/api/messaging/platforms`
    → find by id) and `useTestMessagingPlatform` (POST `/api/messaging/platforms/{id}/test`) are
    generic; **but** their `platform` param is typed `ImPlatform = "feishu" | "weixin"`
    (`packages/protocol/src/channels.ts` line 491), so reusing them for `homeassistant` requires a
    type widening (`ImPlatform | string` or a new `MessagingPlatformId`) first.
  - `web/src/lib/transport.ts` — all REST calls must go through it; never raw fetch in a new HA
    settings panel.
- **Do NOT extend `web/src/routes/im-onboarding.tsx` / `src/commands/im_onboarding.rs`**: those are
  feishu/weixin/dingtalk **QR-code** onboarding flows; HA is token+URL based (no QR), so HA would
  get a separate `/settings/platforms/homeassistant` panel if ever added (env editor + enable
  toggle + test button via REST), mirroring `plans/slack-platform.md` §6.
- **Protocol**: `StatusResponse.gateway_platforms` is a generic `Record<string, ...>` so
  `homeassistant` flows through today; `ImPlatform` union does **not** include it — adding an HA
  settings panel means widening that union or using `string`.
- **Port decision + WS-removal implications** (recorded, required by the README):
  - Messaging adapters are **gateway-side**; enabling HA = `PUT /api/messaging/platforms/homeassistant
    {enabled:true, env_vars}` + reading status — no change to `EXPECTED_BACKEND_VERSION`, no new
    port, no WS change in v1.
  - Removing the Python/WS link (repo end-state) is about the **agent session transport**
    (`/api/ws`), **not** the HA transport. HA's outbound WS to the user's HA instance is a separate
    connection: a standalone desktop would need to **add** a persistent outbound WS (Rust
    `ws_transport` command or `@tauri-apps/plugin-websocket`) rather than remove one.
  - If in-process ever happens: `HASS_TOKEN`/`HASS_URL` move from `.env` to OS keychain; watch
    filters move from `config.yaml` extras to a Tauri settings JSON; LAN-http REST must route via
    the origin-locked Rust `ha_request` command designed in `plans/home-assistant.md` §6 (do not
    relax `external_request`).

## 7. Removing the WebSocket dependency (migration path)

API surface to freeze during any migration (must keep working whether HA lives in the Python
gateway or in-process):

1. `GET /api/messaging/platforms` + `PUT /api/messaging/platforms/homeassistant` + `POST
   /api/messaging/platforms/homeassistant/test` (Core `hermes_cli/web_server.py` catalog 8630;
   PUT/test endpoints shared with all platforms).
2. `StatusResponse.gateway_platforms["homeassistant"]` shape (`state`, `error_message`, `enabled`,
   `configured`, `env_vars`) in `packages/protocol/src/hermes-api.ts`.
3. Env/config contract: `HASS_TOKEN` (required), `HASS_URL` (default `http://homeassistant.local:8123`),
   `plugin.yaml` extras `watch_domains`/`watch_entities`/`ignore_entities`/`watch_all`/
   `cooldown_seconds`.
4. Message surface: inbound `MessageEvent` source shape (`chat_id="ha_events"`, platform id
   `homeassistant`) and outbound `persistent_notification.create` payload `{title:"Hermes Agent",
   message≤4096}`; standalone `notify.notify` `{message, target}` payload.

Phases:

- **Phase A (v1, recommended): Python gateway owns HA; Desktop adds UI only (optional).** Add
  `settings/platforms/homeassistant` panel reusing (widened) `useMessagingPlatform` /
  `useTestMessagingPlatform` + `ha-diagnostics.ts`; write env via existing REST PUT. Zero WS changes.
- **Phase B (optional): in-process `PlatformAdapter` behind the same interface.** Implement
  `packages/ha-platform/` from Section 3 (WS via `home-assistant-js-websocket` or `ws`, REST via
  `ha_request` IPC), register with the gateway-core `PlatformAdapter` registry, bridge inbound
  events into the existing agent-loop pipeline. Delete path: keep Python adapter as fallback; flip
  per-profile flag.
- **Phase C (only if desktop fully standalone): delete the Python WS/REST path** for HA config
  (keep `/api/ws` for agent sessions as long as the Python agent exists). The frozen surface above
  is what the TS implementation must satisfy so the swap is invisible to the UI. Note this phase
  **adds** a new HA→HA-server WS connection in the webview/Rust layer — it does not eliminate one.

## 8. Migration phases & task breakdown

| Phase | Tasks | Est. |
|---|---|---|
| A1 | (Optional v1) `settings/platforms/homeassistant` route: env editor for `HASS_TOKEN`/`HASS_URL` (Chinese labels via `env-translations.ts`), enable toggle → PUT, test button → POST test; widen `ImPlatform`/hook types | S |
| A2 | (Optional v1) `web/src/lib/ha-diagnostics.ts` modeled on `im-onboarding-diagnostics.ts`; show `gateway_platforms.homeassistant` state/error; link to Core `messaging/homeassistant.md` | S |
| B1 | Port `format.ts` + `filters.ts` (pure, parity-tested); port `config.ts` extras parse | S |
| B2 | `ws-transport.ts` (auth/subscribe/heartbeat/backoff) + `rest-client.ts` (`persistent_notification.create`, `notify.notify`) against a TS fake HA server | M |
| B3 | `adapter.ts` + `events.ts` wiring into gateway-core `PlatformAdapter` registry; inbound event → session → outbound send loop | M |
| B4 | `standalone-send.ts` for cron `deliver=homeassistant` (notify.notify) | S |
| C | Cutover/cleanup — only if fully standalone: flip flag, remove Python adapter/config, docs | — |

(S=small ≤3d, M=medium ≤1w, L=large >1w. A1–A2 are the only v1-justifiable work; B* is the
recorded port backlog.)

## 9. Risks & open questions

- **R1 (HIGH) — no TS equivalent in kimi-code.** Zero matches for HA anywhere in the reference
  monorepo; `home-assistant-js-websocket` is absent from `node_modules` and all `package.json`
  files. Any port needs a **new dependency** (recommended) or a hand-rolled WS client on
  `ws@8.20.0` (the only WS lib verified in kimi-code). No in-repo precedent exists for the HA WS
  protocol quirks (auth handshake, subscribe ack ordering, heartbeat semantics).
- **R2 (HIGH) — event-streaming parity.** The Python pipeline is subtle: closed-by-default filters
  (no config ⇒ all events dropped with a startup warning), `ignore_entities` precedence, cooldown
  window, reconnect backoff `[5,10,30,60]` with backoff reset only on success, and `_format_state_change`
  domain branches (climate/sensor/binary_sensor/light/switch/fan/alarm/generic, old==new ⇒ `None`).
  Each needs a named parity test (Section 10).
- **R3 (MEDIUM-HIGH) — LAN-http REST from a standalone webview.** The default
  `http://homeassistant.local:8123` is http + LAN + `.local`; the generic `external_request`
  SSRF policy rejects private targets. Reuse the origin-locked Rust `ha_request` command designed
  in `plans/home-assistant.md` §6 rather than raw webview `fetch` (CORS/PNA risks).
- **R4 (MEDIUM) — `.local` DNS resolution** on Windows (Rust `reqwest`/tokio may not resolve mDNS);
  docs should recommend IP or resolvable hostname; same as `plans/home-assistant.md` R3.
- **R5 (MEDIUM) — token exposure.** `HASS_TOKEN` crosses env UI + IPC; keep it out of logs (Rust
  `AppError` must not echo headers/body); reuse existing redaction patterns.
- **R6 (LOW) — notify parity.** Adapter `send()` uses `persistent_notification.create`
  (`{title, message}`) while the standalone cron sender uses `notify.notify` (`{message, target}`);
  the TS port must keep both REST payloads byte-compatible with the Python tests.
- **Open questions:** (a) does desktop v1 need any HA surface at all, or is generic status echo
  enough? (b) if in-process, `home-assistant-js-websocket` version pin / license review vs
  hand-rolled `ws` shim; (c) should watch filters be configurable from the desktop settings panel
  or stay Python `config.yaml`-only? (d) does `allow_update_command=True` (`/update` from HA
  chat) have a desktop equivalent?

## 10. Test strategy

Parity tests (vitest) mirroring the Python suites (all unit tests offline; WS/REST mocked or fake):

- `format.test.ts` ↔ `tests/gateway/test_homeassistant.py` `TestFormatStateChange`: climate
  (HVAC + current/target temps), sensor (unit suffix), binary_sensor (triggered/cleared),
  light/switch/fan (turned on/off), alarm_control_panel, generic fallback, old==new ⇒ `null`.
- `filters.test.ts` ↔ `TestEventFilteringPipeline` + `TestCooldown`: `ignore_entities` drop,
  unwatched-domain drop, watched-domain forward, `watch_all`, cooldown expiry (same
  time-manipulation trick as the Python test).
- `config.test.ts` ↔ `TestAdapterInit` / `TestConfigIntegration`: URL/token from config+env,
  watch/ignore/cooldown parsing, env→platform seeding (`HASS_TOKEN`/`HASS_URL` →
  `token`/`extra.url`), `validate_ha_config` false without token.
- `rest-client.test.ts` ↔ `TestSendViaRestApi`: `persistent_notification.create` URL, JSON
  `{title:"Hermes Agent", message}`, 4096 cap, `Authorization: Bearer <token>`, `<300` success with
  12-hex id, error body, timeout; standalone `notify.notify` `{message, target}`.
- `ws-transport.test.ts` ↔ `TestWsUrlConstruction` + `_ws_connect`/`_listen_loop` semantics:
  http→ws / https→wss URL construction, auth handshake ordering, subscribe ack failure, reconnect
  backoff schedule, heartbeat.
- **Integration (fake HA server)**: port `tests/fakes/fake_ha_server.py` (REST routes + WS route
  used by adapter tests) to a TS fake (node:http + `ws`), driving connect→auth→subscribe→event→
  filter→format→`send()` end-to-end against the in-process adapter.
- **Playwright E2E (only if A1/A2 land)**: settings panel shows `HASS_TOKEN`/`HASS_URL` with
  Chinese labels; enable toggle → mocked `PUT`; test button → mocked `POST /test`; gateway status
  card shows `homeassistant` state.
- **Parity harness**: map each `test_homeassistant.py` test class to its TS test file; CI asserts
  the mapping stays complete (same convention as `plans/messaging-gateway-core.md` §10).

## 11. Reference links

- Core source: `D:/hermes-agent-cn/plugins/platforms/homeassistant/{adapter.py,__init__.py,plugin.yaml}`,
  `gateway/config.py` (334, 2152–2161), `gateway/platforms/base.py`,
  `hermes_cli/web_server.py` (8630, 8824, 8875–8883, 9073), `tools/send_message_tool.py`
- Core docs: `D:/hermes-agent-cn/website/docs/user-guide/messaging/homeassistant.md`
- Core tests/fakes: `tests/gateway/test_homeassistant.py`, `tests/fakes/fake_ha_server.py`
- Feature inventory: `D:/hermes-agent-cn/features_report.md` (lines 86, 139)
- Sibling plans: `plans/_INDEX.md` (#54 `home-assistant`, #93 `homeassistant-messaging-platform`),
  `plans/home-assistant.md` (toolset — avoid duplication), `plans/slack-platform.md`,
  `plans/messaging-gateway-core.md`, `plans/tool-categories.md`
- Desktop: `web/src/routes/settings.tsx` (~1478), `web/src/routes/im-onboarding.tsx`,
  `web/src/lib/im-onboarding-diagnostics.ts`, `web/src/hooks/use-im-onboarding.ts`,
  `packages/protocol/src/channels.ts` (491), `packages/protocol/src/hermes-api.ts`,
  `src/commands/api_proxy.rs`
- kimi-code evidence: repo-wide grep (zero HA matches); `ws@8.20.0` in
  `packages/kap-server/package.json`, `packages/klient/package.json`; kap-server WS transport
  (`packages/kap-server/src/transport/ws/v1/sessionEventBroadcaster.ts`)
- Recommended new dep (if ported): https://github.com/home-assistant/home-assistant-js-websocket
  (official npm `home-assistant-js-websocket`); HA docs: https://www.home-assistant.io/docs/authentication/
