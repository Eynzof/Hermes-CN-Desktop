# MSGraph Webhook Messaging Platform Adapter — Python → TypeScript Rewrite Plan

> Feature: Microsoft Graph webhook (change notifications) bot — inbound adapter that
> receives Microsoft Graph change notifications (`/msgraph/webhook`) and surfaces them
> into the Hermes gateway as `MessageEvent`s.
> Port decision recorded per `plans/README.md` conventions: **messaging-platform
> adapters are gateway-side; the inbound webhook listener is OUT OF SCOPE for the
> desktop standalone webview runtime** — justification in §2/§3. The one desktop-relevant
> implication is the **inbound listener location**: a Tauri app cannot bind sockets from
> the webview TS runtime, so any future desktop-native listener must be a **Rust sidecar**
> (hyper server), not `web/src`. WS-removal implications are recorded in §7.

## 1. Summary

`msgraph_webhook` is an **inbound-only** HTTP listener in the Hermes-CN-Core gateway:
Microsoft Graph POSTs change notifications (meeting transcript produced, chat message
landed, calendar event updated) to a public HTTPS URL, the adapter validates the request
(source-IP allowlist + `clientState` shared secret), dedupes by notification id, builds a
`MessageEvent`, and hands it to a notification scheduler — today the Teams meeting
pipeline (`plugins/teams_pipeline`). It is **not a chat bot**: `send()` is a logging no-op;
outbound replies (summary posts to Teams) are delivered by the pipeline's
`TeamsSummaryWriter`, which is out of scope for this plan (see `plans/teams-platform.md`).

This plan records the port decision:

1. **Do not re-implement the inbound webhook listener in the desktop TypeScript
   runtime.** Graph calls a public HTTPS endpoint; that requires an always-on,
   internet-reachable, TLS-terminated service — the opposite of a desktop-local agent.
   The Python gateway remains the supported way to run it (headless/server), exactly
   like the Teams bot decision in `plans/teams-platform.md`.
2. **Desktop surfaces in scope are read-only status** through the existing
   `StatusResponse.gateway_platforms` / `/api/messaging/platforms` REST surface —
   no new UI strictly required.
3. **If a desktop-native listener is ever needed** (when the Python gateway is removed),
   the inbound webhook must live in a **Rust sidecar** (`src/` hyper server, precedent:
   `src/commands/browser_companion.rs`), forwarding parsed events into the webview via
   Tauri IPC/events — never binding a socket from `web/src`.
4. **WS-removal implication**: this adapter never used `/api/ws` (it is inbound HTTP
   only), so removing the WebSocket link does not touch it; the desktop status path is
   already plain HTTP REST.

## 2. Current Python implementation

Source of truth: `D:/hermes-agent-cn`.

### 2.1 Adapter — `gateway/platforms/msgraph_webhook.py` (453 lines, read in full)

- `MSGraphWebhookAdapter(BasePlatformAdapter)` — config read from
  `platforms.msgraph_webhook.extra` (or `MSGRAPH_WEBHOOK_*` env merged in
  `gateway/config.py`):

  | Config key | Default | Behavior |
  |---|---|---|
  | `host` | unset (`None`) | Dual-stack all-interfaces bind (IPv4+IPv6); **config-only, no env var**. Non-loopback bind refuses to start without `allowed_source_cidrs` (`_source_allowlist_required_but_missing`, fail-closed). |
  | `port` | `8646` | Bind port (env `MSGRAPH_WEBHOOK_PORT`). |
  | `webhook_path` | `/msgraph/webhook` | Path Graph POSTs to. |
  | `health_path` | `/health` | Readiness endpoint with accepted/duplicate counters. |
  | `client_state` | — | Required shared secret; adapter refuses to start if unset; compared with `hmac.compare_digest` on UTF-8 bytes. |
  | `accepted_resources` | `[]` (accept all) | Resource path/pattern allowlist; trailing `*` prefix match; leading `/` tolerated. |
  | `max_seen_receipts` | `5000` | Dedupe cache size; `deque` evicts oldest. |
  | `max_body_bytes` | `1_048_576` | Content-Length and raw-body size cap → `413`. |
  | `allowed_source_cidrs` | `[]` | `ipaddress.ip_network(strict=False)` parse; invalid entries warned+ignored; peer checked before body parse. |

- `connect()`: builds aiohttp `web.Application` (`client_max_size`),
  registers `GET health`, `GET webhook_path` (validation handshake), `POST
  webhook_path` (notifications), starts `web.TCPSite(runner, host, port)`.
- `disconnect()`: runner cleanup.
- `send()/get_chat_info()`: no-op/log — inbound-only adapter.
- `_handle_validation`: echoes `validationToken` verbatim as `text/plain` within the
  GET; bare GET → `400`.
- `_handle_notification` per-item pipeline: source-IP check → size caps → JSON parse
  (`json.loads`, must be dict with `value` list) → `_resource_accepted`
  (normalize + prefix `*`) → `_verify_client_state` (`hmac.compare_digest(provided.encode(),
  expected.encode())`; non-ASCII input rejected 403 without raising) → receipt key
  (`id:{id}`, fallback `sha1:` of sorted-keys orjson bytes) → dedupe set+deque →
  `_build_message_event` (`chat_id = "msgraph:{subscriptionId}"`, `chat_type="webhook"`,
  `internal=True`) → `_schedule_notification` (scheduler callback, or
  `handle_message` in background task).
- Status codes: `202` accepted/deduped (empty body — counters never leak to wire),
  `200` validation echo, `403` clientState fail / source IP, `400` malformed, `413` too big.
- `_render_prompt`: `extra.prompt` template (`{notification.resource}` etc. via
  `agent.re_compat.re` `_render_template`, dict/list values JSON, truncated 2000 chars)
  else indented sorted JSON truncated 4000 chars.
- Runtime deps: `aiohttp` (web), `orjson`, stdlib `hmac`/`hashlib.sha1`/`ipaddress`/`json`;
  internal `gateway.config`, `gateway.platforms.base`.

### 2.2 Gateway wiring

- `gateway/config.py` — `Platform.MSGRAPH_WEBHOOK = "msgraph_webhook"` (line 340),
  platform list (line 432), validation lambda (line 895), webhook-family special-case
  (line 1681), env overrides `MSGRAPH_WEBHOOK_ENABLED/PORT/CLIENT_STATE/ACCEPTED_RESOURCES/ALLOWED_SOURCE_CIDRS`
  (lines 2262–2288; `host` deliberately config-only).
- `gateway/run.py` — adapter factory `MSGraphWebhookAdapter(config)` + requirement
  check `check_msgraph_webhook_requirements()` (lines 14456–14464); listed in the
  non-session platform set (line 357); Teams pipeline binding at
  `_wire_teams_pipeline_runtime` (lines 6403–6430) → `plugins.teams_pipeline.runtime.bind_gateway_runtime`
  which calls `adapter.set_notification_scheduler(...)`.
- Consumer: `plugins/teams_pipeline/runtime.py` (scheduler), `subscriptions.py`
  (Graph subscription lifecycle — outbound, NOT part of this adapter).

### 2.3 Docs & tests (parity source)

- Docs: `D:/hermes-agent-cn/website/docs/user-guide/messaging/msgraph-webhook.md`
  (142 lines) — quick start, config table, env vars, security hardening (clientState,
  source-IP allowlist, HTTPS termination at reverse proxy, response-hygiene status
  table), troubleshooting.
- Tests: `D:/hermes-agent-cn/tests/gateway/test_msgraph_webhook.py` (264 lines) —
  config accepts platform; loopback connect without allowlist; validation token echo;
  missing clientState → 403; valid notification → 202 + scheduler captured event
  (`message_id == "id:notif-1"`, `source.platform == MSGRAPH_WEBHOOK`); oversized →
  413; non-ASCII clientState → 403 without raising; leading-slash resource pattern →
  202; public bind without allowlist → 403; loopback accepts local; disallowed source IP
  → 403.

## 3. Target TypeScript design

### 3.1 Port decision (recorded)

**Inbound MSGraph webhook listener: OUT OF SCOPE for desktop standalone.**

- Graph is push-based: it POSTs to your public HTTPS `.../msgraph/webhook` endpoint.
  That requires an always-on, internet-reachable, TLS-terminated service (devtunnel /
  reverse proxy / real domain) plus a registered Azure app — the opposite of a
  desktop-local, in-process agent (same reasoning as Teams bot in
  `plans/teams-platform.md` §3.1).
- The Python `msgraph_webhook` + `teams_pipeline` pair stays the supported way to
  receive Graph change notifications (headless gateway / server).
- Desktop today may surface **read-only status** of this platform via the attached
  gateway's REST status (`/api/status` → `gateway_platforms["msgraph_webhook"]` and
  `/api/messaging/platforms` → `MessagingPlatformInfo`), never over the WS link.

### 3.2 If a future in-process/server TS port is required (design sketch only)

Module layout (either `web/src/platforms/msgraph-webhook/` for a server-adjacent web
host, or a new `packages/msgraph-webhook/`):

```
web/src/platforms/msgraph-webhook/
  adapter.ts     // MsgraphWebhookAdapter: connect/disconnect/setNotificationScheduler
  server.ts      // HTTP routes: GET /health, GET {webhookPath}?validationToken, POST {webhookPath}
  security.ts    // timing-safe clientState compare + source-CIDR allowlist
  dedupe.ts      // receipt set + bounded deque eviction
  render.ts      // prompt template renderer ( {a.b} resolver ) + JSON fallback
```

Key interfaces (signatures only — no implementation):

```ts
interface MsgraphWebhookConfig {
  host?: string;                 // undefined → dual-stack all-interfaces
  port: number;                  // default 8646
  webhookPath: string;           // default "/msgraph/webhook"
  healthPath: string;            // default "/health"
  clientState: string;           // required; refuse to start if empty
  acceptedResources: string[];   // [] = accept all; trailing "*" prefix match
  maxSeenReceipts: number;       // default 5000
  maxBodyBytes: number;          // default 1_048_576
  allowedSourceCidrs: string[];  // required for non-loopback binds (fail-closed)
}
interface GraphChangeNotification {
  id?: string; subscriptionId?: string; changeType?: string;
  resource?: string; clientState?: string; resourceData?: Record<string, unknown>;
  [k: string]: unknown;
}
type NotificationScheduler = (notification: GraphChangeNotification, event: MessageEvent) => Promise<void> | void;

class MsgraphWebhookAdapter {
  constructor(config: MsgraphWebhookConfig);
  setNotificationScheduler(scheduler: NotificationScheduler | null): void;
  connect(): Promise<boolean>;
  disconnect(): Promise<void>;
  // handlers (testable without a server):
  handleValidation(query: { validationToken?: string }, peerIp: string): HttpResult;
  handleNotification(body: unknown, peerIp: string, contentLength?: number): Promise<HttpResult>;
}
```

### 3.3 Desktop-native listener must be a Rust sidecar (not webview TS)

A Tauri webview cannot bind a listening socket from `web/src`. The end-state README
keeps Rust for OS-level capabilities. If the desktop ever needs to ingest Graph
notifications **without** the Python gateway, the listener belongs in Rust:

```
src/graph_webhook.rs      // hyper 1 server (http1) on configured host:port
src/commands/graph_webhook.rs  // Tauri commands: start/stop/status, receive events → webview
```

- Precedent: `src/commands/browser_companion.rs` already runs an inbound hyper http1
  server on loopback (`TcpListener::bind` + `serve_connection`, lines 25–203);
  `Cargo.toml` already ships `hyper = { version = "1", features = ["http1", "server"] }`,
  `hyper-util` (tokio), `tokio` (full), `reqwest`, `sha2`.
- Rust validates/parses (source-CIDR via `ipnet`/hand-rolled, clientState via
  `subtle::ConstantTimeEq`, receipts in `HashSet`+`VecDeque`), emits parsed
  `GraphChangeNotification` to the webview through Tauri events
  (`app.emit("msgraph:notification", ...)`), and the in-process TS gateway core
  (`packages/gateway-core`, see `plans/messaging-gateway-core.md`) consumes it.
- This is the **WS-removal** end-state: no Python gateway, no `/api/ws`, no WS relay —
  the webhook is a local Rust socket + Tauri event, which is exactly why the adapter
  must be considered "Rust sidecar", not `web/src`.

## 4. Data models & persistence

- **Zod schemas** in `packages/protocol/src/` (mirroring the Python dict shapes so
  parity tests share one contract): `GraphChangeNotification` (passthrough for unknown
  Graph fields), `GraphNotificationBatch { value: GraphChangeNotification[] }`,
  `MsgraphWebhookConfig`, `MsgraphWebhookHealth { status, platform, webhook_path,
  accepted, duplicates }`. These become the wire contract for the future
  Rust-sidecar → webview bridge and the parity surface for tests.
- **Dedupe receipts**: Python keeps them **in-memory only** (set + deque, max 5000,
  restart clears). Keep in-memory in TS for parity; **open question** whether a
  durable store (kimi-code `packages/minidb`, or SQLite via Rust) should persist
  receipts so a restarted sidecar does not double-process a retried Graph delivery.
- **Secrets**: `MSGRAPH_WEBHOOK_CLIENT_STATE` stays in `.env`/OS keychain via the
  existing profile secret-scope pattern; Desktop protocol already redacts values
  (`ImRedactedValue` in `packages/protocol/src/channels.ts:497`).
- **No session state**: this platform is inbound-only; messages flow into gateway
  session routing (`SessionSource`/`build_session_key`) exactly like other adapters
  (see `plans/messaging-gateway-core.md`).

## 5. Third-party library strategy

**Most important section.** For every Python dependency the adapter relies on, the TS
equivalent, with kimi-code evidence:

| Python dependency (Core) | TS equivalent | kimi-code evidence |
|---|---|---|
| `aiohttp` web server (`web.Application`, `TCPSite`) | **Fastify 5** for an in-process server TS host (`fastify ^5.1.0` + `@fastify/multipart` in `packages/kap-server/package.json:28-35`); **or Node `node:http`**; for desktop standalone: **Rust hyper 1 sidecar** (`hyper 1` `http1,server` + `hyper-util` in `Cargo.toml:52-53`; inbound loopback server precedent `src/commands/browser_companion.rs`) | Fastify: `packages/kap-server/package.json`; Rust hyper: `D:/Hermes-CN-Desktop/Cargo.toml`, `src/commands/browser_companion.rs` |
| `hmac.compare_digest` (timing-safe clientState compare) | `crypto.timingSafeEqual` from `node:crypto` (Rust: `subtle::ConstantTimeEq`) — must guard length and compare UTF-8 bytes, matching Python's `.encode()` behavior | `packages/kap-server/src/services/auth/tokenStore.ts:1` imports `timingSafeEqual`, used at line 66 |
| `ipaddress.ip_network` + `ip_address in network` (source-CIDR allowlist) | **`ipaddr.js`** (npm) — tiny, widely used; not imported by kimi-code source, but **present in the pnpm store** (`node_modules/.pnpm/ipaddr.js@1.9.1/`, `ipaddr.js@2.4.0/`) as transitive deps, proving ecosystem availability; Rust: `ipnet` crate or hand-rolled prefix match | pnpm store glob evidence only; no source usage — flag as "no in-repo usage, ecosystem lib recommended" |
| `orjson` (sorted-keys JSON + prompt render) | Plain `JSON.stringify` with a key-sorting replacer — no lib needed | — |
| `asyncio` background tasks (`asyncio.create_task` + done-callback set) | Node event loop: `queueMicrotask`/`setImmediate`/an in-process job queue in the gateway core | `packages/gateway-core` design in `plans/messaging-gateway-core.md` |
| `agent.re_compat.re` template (`{a.b}` resolver) | Hand-rolled `~10`-line resolver over `payload` object (no lib needed) | — |
| `@microsoft/microsoft-graph-client` (NOT used by this adapter — only by `plugins/teams_pipeline/subscriptions.py` for outbound subscription lifecycle) | **Not present in kimi-code**; if a future port includes subscription lifecycle, **recommend the official `@microsoft/microsoft-graph-client`** npm package (typed REST client, batch support) | **Verified absent**: no source imports (grep for `msgraph|microsoft-graph|graph-client` across kimi-code matched only `pnpm-lock.yaml`), no `node_modules/.pnpm/@microsoft*` packages |
| `@azure/identity` (token auth for outbound Graph; NOT used by this adapter) | **Not used at runtime anywhere in kimi-code.** `@azure/identity@4.13.1` exists only as a **transitive dep of `@vscode/vsce@3.9.2`** (a VS Code extension packaging dev tool in `apps/vscode/package.json:281`) — pnpm-lock.yaml lines 1139–1141/9905–9909, store dir `node_modules/.pnpm/@azure+identity@4.13.1/`. **Do NOT pull it for an inbound-only adapter.** If outbound Graph token flows are ever ported, prefer kimi-code's own `packages/oauth` patterns (PKCE/device-code) plus `@azure/identity`'s `ClientSecretCredential`/`DefaultAzureCredential` as the official route | `apps/vscode/package.json:281`; `pnpm-lock.yaml`; `node_modules/.pnpm/@azure+identity@4.13.1/node_modules/@azure/identity/package.json` |

**"No TS equivalent found" risks (explicit):**

1. **`@microsoft/microsoft-graph-client` is not in kimi-code** — verified by grep
   (only `pnpm-lock.yaml` matched, for `@azure/identity` only) and by globbing
   `node_modules/.pnpm/@microsoft*` (0 matches). The adapter itself does not need it
   (inbound-only), so this is a non-blocking gap today; it only matters if
   `plugins/teams_pipeline/subscriptions.py` (create/list/renew Graph subscriptions)
   is ported later — then the official SDK is recommended (typed client, retry/batch).
2. **`@azure/identity` is present in the pnpm store but not usable as runtime evidence**
   — it is a dev-tool transitive dependency (`@vscode/vsce`), and no kimi-code source
   imports it. Treat kimi-code as having **no runtime OAuth-to-Azure precedent**;
   the desktop's own OAuth machinery (`src/oauth_session.rs`) is for consumer OAuth,
   not Azure client-credentials.
3. **CIDR matching has no in-repo TS precedent** — `ipaddr.js` is only a transitive
   store artifact; recommend adding it as a direct dependency with a tiny wrapper so
   the Microsoft egress range allowlist semantics (quarterly-changing ranges) stay
   configurable, exactly like Python's `allowed_source_cidrs`.

## 6. Integration with existing Hermes-CN-Desktop frontend

- `web/src/routes/settings.tsx` — **KernelSection** already renders Gateway 状态
  (`gateway_state`, `gateway_pid`, `gateway_health_url`, `gateway_url`,
  `gatewayWsRelayActive`, lines ~1354–1474) and a diagnostics copy button. Read-only
  `msgraph_webhook` status needs **no new UI**: `StatusResponse.gateway_platforms`
  is a generic `z.record(z.string(), PlatformStatus)` (`packages/protocol/src/hermes-api.ts:47`,
  `PlatformStatus` lines 24–30) and `/api/messaging/platforms` already returns
  `MessagingPlatformInfo` (lines 127–151). Only add a label/row if the product wants
  per-platform visibility.
- `web/src/lib/im-onboarding-diagnostics.ts` (450 lines) — the feishu/weixin
  diagnostic bundle pattern (`DIAGNOSTIC_REQUIRED_KEYS`, `buildImDiagnosticBundle`,
  `explainMessagingFailure` regex triage, `buildImDiagnosticPrompt`). If a Graph
  webhook onboarding page were ever added, this is the template: required key
  `MSGRAPH_WEBHOOK_CLIENT_STATE`, checklist (public URL, tunnel, port, accepted
  resources), and a "test endpoint" step. **Requires protocol extension**:
  `ImPlatform = "feishu" | "weixin"` only today (`packages/protocol/src/channels.ts:491`).
- `web/src/routes/im-onboarding.tsx` — the onboarding route pattern (`/im/feishu`,
  `/im/weixin`; `ImSection = "feishu" | "weixin" | "dingtalk"` at line 52). Note the
  **dingtalk precedent**: `src/commands/im_onboarding.rs` already handles inbound
  webhook env keys `DINGTALK_WEBHOOK_HOST/PORT/PATH` (lines 46–48) — the same
  secret-scope + env-writer machinery would carry `MSGRAPH_WEBHOOK_*`.
- Rust reuse (sidecar future): `src/commands/browser_companion.rs` (inbound hyper
  http1 listener — copy the bind/serve pattern), `src/commands/api_proxy.rs`
  (reqwest client, external requests), `src/commands/im_onboarding.rs` (env write +
  restart orchestration), `src/state.rs` / Tauri event emit for notification delivery.
- **Not affected**: `web/src/lib/transport.ts`, `web/src/lib/gateway-client.ts`
  (WS JSON-RPC), `web/src/lib/tauri-bridge.ts` — this adapter never used the WS link.

## 7. Removing the WebSocket dependency (migration path)

This feature is **inbound-only and never used `/api/ws`**, so WS removal is trivial for
it; the only integration is the read-only REST status surface. Phased path:

1. **Today**: Python gateway hosts the listener; desktop shows
   `gateway_platforms["msgraph_webhook"]` status through the existing REST
   `/api/status` + `/api/messaging/platforms` (both plain HTTP, auth-gated) — no WS.
2. **Optional step (only when the Python gateway is removed and the desktop must
   ingest notifications)**: move the listener to the **Rust sidecar** hyper server
   (`src/graph_webhook.rs`), parse/validate in Rust, `app.emit("msgraph:notification")`
   → webview → in-process `packages/gateway-core` adapter. No WS, no REST proxy for
   ingress.
3. **Delete WS/REST path**: the WS relay (`gatewayWsRelayActive`,
   `web/src/lib/gateway-client.ts`) is independent of this platform and can be deleted
   per `plans/messaging-gateway-core.md`; the REST status surface may remain as the
   freeze point.
- **API surface to freeze during migration** (parity contract, from Python tests):
  notification batch shape (`{ value: [...] }`), status-code semantics
  (`202` accepted/deduped, `200` validation echo, `403` clientState/source-IP,
  `400` malformed, `413` oversized), `/health` JSON counters, and
  `GET ?validationToken=` echo as `text/plain`.

## 8. Migration phases & task breakdown

| Phase | Task | Scope |
|---|---|---|
| P0 | Record port decision (this plan) | Done |
| P1 | Read-only status: confirm `gateway_platforms` / `MessagingPlatformInfo` already carries `msgraph_webhook`; add optional settings row/label in `settings.tsx` KernelSection | Desktop UI (small) |
| P2 (optional, gated on standalone need) | Rust sidecar listener: `src/graph_webhook.rs` (hyper server, validation, dedupe) + `src/commands/graph_webhook.rs` (start/stop/status Tauri commands, event emit) + `packages/protocol` Zod types + `web/src/lib/graph-webhook-client.ts` (subscribe to Tauri events) | Desktop standalone |
| P3 (out of scope) | Port `plugins/teams_pipeline` subscription lifecycle + `TeamsSummaryWriter` (outbound) — needs `@microsoft/microsoft-graph-client` + `@azure/identity` | Server/headless future |
| P4 | Delete WS link per `plans/messaging-gateway-core.md` (independent of this feature) | Desktop |

## 9. Risks & open questions

- **No TS equivalent found (verified)**: `@microsoft/microsoft-graph-client` is absent
  from kimi-code entirely; `@azure/identity` is only a dev-tool transitive dep. This is
  safe for the inbound adapter but a hard prerequisite for any outbound Graph port —
  the official Microsoft packages must be added then (with rationale in §5).
- **clientState edge cases**: `timingSafeEqual` throws on length mismatch — the TS/Rust
  port must length-check first and compare UTF-8 bytes so non-ASCII attacker input is
  rejected with 403, not a crash (Python parity test
  `test_non_ascii_client_state_rejected_without_raising`).
- **Source-IP allowlist drift**: Microsoft's Graph webhook egress ranges change
  quarterly — the allowlist must stay configurable (`allowed_source_cidrs`), never
  hard-coded; TS needs `ipaddr.js` (no in-repo precedent).
- **Public HTTPS requirement** is the core reason for out-of-scope: a desktop-local
  listener cannot be reached by Graph without a tunnel/domain; document
  loopback-behind-tunnel as the only desktop-native pattern (same as Python docs).
- **Dual-stack bind**: Python default `host=None` binds IPv4+IPv6; a Rust/TS port must
  bind `[::]` with dual-stack or `0.0.0.0`+`::` separately, or it regresses
  IPv6-only networks (the documented reason for the Python default).
- **Dedupe cache restart semantics**: Python is in-memory only; if the Rust sidecar
  persists receipts (minidb/SQLite), decide the TTL/eviction policy to match `5000`
  before shipping.
- **Scheduler dependency**: the adapter is useless without a consumer
  (`set_notification_scheduler` → today `teams_pipeline`). A desktop-native port must
  define the in-process consumer (e.g. a meeting-summary or chat-ingest hook) or the
  listener only produces logs.
- **Health counters not in protocol**: `PlatformStatus`/`MessagingPlatformInfo` expose
  state/error but not accepted/duplicate counters — if Settings should show them, the
  protocol schemas need extension.

## 10. Test strategy

- **Parity unit tests (vitest)** mirroring `tests/gateway/test_msgraph_webhook.py` 1:1:
  - config object accepts `msgraph_webhook` + `get_connected_platforms` equivalent;
  - loopback connect without allowlist succeeds; public bind without allowlist fails
    closed;
  - validation token echo (200, `text/plain`, verbatim);
  - missing/wrong/non-ASCII `clientState` → 403, no crash;
  - valid batch → 202 empty body + scheduler invoked once, event fields
    (`message_id === "id:notif-1"`, `source.chat_type === "webhook"`);
  - oversized body (content-length and raw length) → 413;
  - resource pattern matching incl. leading `/` and trailing `*`;
  - source-IP allowlist accept/reject.
- **Integration**: start the Fastify/Node (or Rust hyper) server on port 0, POST
  fixture batches, assert status codes and scheduler capture; GET `?validationToken=`
  over the wire.
- **Security tests**: timing-safe compare helper (length-mismatch and non-ASCII
  paths), CIDR wrapper with Microsoft-range fixtures.
- **Rust sidecar (if P2)**: cargo unit tests on handler + validation; Tauri event
  emission test via a mock `AppHandle`.
- **Playwright E2E**: settings page renders `gateway_platforms["msgraph_webhook"]`
  status when a stub gateway returns it (generic — works today without this feature).

## 11. Reference links

- Python: `D:/hermes-agent-cn/gateway/platforms/msgraph_webhook.py`,
  `D:/hermes-agent-cn/gateway/config.py` (lines 340, 432, 895, 1681, 2262–2288),
  `D:/hermes-agent-cn/gateway/run.py` (lines 357, 6403–6430, 14456–14464),
  `D:/hermes-agent-cn/gateway/platforms/base.py` (`BasePlatformAdapter`,
  `MessageEvent`, `is_network_accessible`).
- Docs: `D:/hermes-agent-cn/website/docs/user-guide/messaging/msgraph-webhook.md`.
- Tests: `D:/hermes-agent-cn/tests/gateway/test_msgraph_webhook.py`.
- kimi-code: `packages/kap-server/package.json` (Fastify),
  `packages/kap-server/src/services/auth/tokenStore.ts` (`timingSafeEqual`),
  `apps/vscode/package.json:281` (`@vscode/vsce`), `pnpm-lock.yaml`
  (`@azure/identity@4.13.1` transitive only), pnpm store
  `node_modules/.pnpm/@azure+identity@4.13.1/`, `node_modules/.pnpm/ipaddr.js@2.4.0/`.
- Desktop: `web/src/routes/settings.tsx`, `web/src/routes/im-onboarding.tsx`,
  `web/src/lib/im-onboarding-diagnostics.ts`, `web/src/lib/transport.ts`,
  `packages/protocol/src/channels.ts` (`ImPlatform:491`, `ImRedactedValue:497`),
  `packages/protocol/src/hermes-api.ts` (`PlatformStatus:24`, `StatusResponse:32`,
  `MessagingPlatformInfo:127`), `src/commands/browser_companion.rs`,
  `src/commands/api_proxy.rs`, `src/commands/im_onboarding.rs`,
  `src/oauth_session.rs`, `Cargo.toml` (hyper/tokio/reqwest/sha2).
- Related plans: `plans/teams-platform.md` (same port decision + Graph outbound),
  `plans/messaging-gateway-core.md` (gateway core / WS removal), `plans/dingtalk-platform.md`,
  `plans/line-platform.md` (other inbound-webhook platform decisions).
