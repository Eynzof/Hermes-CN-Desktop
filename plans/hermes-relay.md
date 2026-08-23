# Hermes Relay (Connector System) — Python → TypeScript Rewrite Plan

## 1. Summary

Hermes Relay is the "gateway relay" connector system: a generic gateway adapter
(`gateway/relay/`) that fronts messaging platforms through an external connector
service over an authenticated outbound WebSocket. The feature's four pillars are
**roundtrip** (normalized inbound `MessageEvent` → agent → outbound action),
**interrupt** (mid-turn `/stop` routed by `session_key`), **WS transport**
(newline-delimited JSON frames: hello/descriptor/inbound/outbound/
outbound_result/interrupt/interrupt_inbound, request-response correlation by
`requestId`, reconnect + 4401 revocation), and **auth** (HMAC-SHA256 upgrade
token + inbound delivery signature, multi-secret rotation).

Today the Hermes-CN-Desktop webview is **already a relay client**: `GatewayClient`
(`web/src/lib/gateway-client.ts`) speaks the managed Python gateway's `/api/ws`
JSON-RPC over a WebSocket. This plan does NOT port the Python connector *client*
into the webview; instead it designs the **relay server/protocol in-process**
(TypeScript): an `InProcessRelayServer` that speaks the *same* JSON-RPC frame
protocol the webview already consumes (roundtrip, interrupt, WS-style transport,
auth) directly against the in-process agent runtime, so the WS link (webview ⇄
Python `/api/ws`, via Rust `ws_proxy.rs` / `gateway-relay-socket.ts`) can be
removed for local mode and kept only for remote attach.

Evidence base: Python `D:/hermes-agent-cn/gateway/relay/` + 4 parity tests
(`tests/gateway/relay/`), formal contract `docs/relay-connector-contract.md`,
kimi-code's in-process RPC/WS machinery (`packages/agent-core/src/rpc`,
`packages/kap-server/src/transport/ws`, `packages/klient/src/transports`,
`packages/protocol/src/ws-control.ts`), and the Desktop's existing client surface.

## 2. Current Python implementation

Source of truth: `D:/hermes-agent-cn/gateway/relay/` (EXPERIMENTAL, additive
`contract_version = 1`).

- `transport.py` — `RelayTransport` Protocol: `connect/disconnect/handshake/
  set_inbound_handler/set_passthrough_handler/send_outbound/get_chat_info/
  send_interrupt/go_idle/send_follow_up`. The gateway side delegates ALL wire
  I/O to this; tests substitute `StubConnector`
  (`tests/gateway/relay/stub_connector.py`).
- `ws_transport.py` — `WebSocketRelayTransport`: dials `ws(s)://…/relay`
  (outbound-only networking), upgrade `Authorization: Bearer <token>`, one
  `hello {type, platform, botId}` per fronted identity (Phase 1.5 multi-platform;
  Discord also sends `command_manifest`), receives `descriptor`, `inbound`
  (MessageEvent + optional `bufferId`), `interrupt_inbound {session_key,
  chat_id}`, `passthrough_forward`, `outbound_result`; sends `outbound
  {type, requestId, action}`, `interrupt {session_key, reason}`, `going_idle`,
  `inbound_ack`. Newline-delimited JSON; per-request future keyed by
  `requestId`; reconnect supervisor with backoff; 4401-after-handshake =
  terminal auth revocation (`auth_revoked`, no reconnect); `go_idle`/`go_dormant`
  for buffered-flip.
- `adapter.py` — `RelayAdapter(BasePlatformAdapter)`: fronts N platforms on one
  logical adapter; capability surface from the handshake descriptor; per-chat
  scope/platform maps; `on_interrupt(session_key, chat_id)` →
  `interrupt_session_activity` (sets only the target `_active_sessions[key]`
  Event — sibling isolation); outbound actions (send/edit/typing/follow_up/
  prompt/react/media); revocation monitor.
- `descriptor.py` — frozen `CapabilityDescriptor` dataclass
  (`contract_version, platform, label, max_message_length, supports_draft_
  streaming, supports_edit, supports_threads, markdown_dialect, len_unit,
  emoji, platform_hint, pii_safe, supports_context, supported_ops`);
  `supports_op()` fails open to `LEGACY_OPS = (send, edit, typing, follow_up)`;
  `from_json` ignores unknown keys and normalizes `max_message_length<=0 → 4096`.
- `auth.py` — gateway-side HMAC primitives matching the connector TS exactly:
  `make_token(payload, secret, ttl)` = `base64url(payload:exp:hex_hmac_sha256(
  payload:exp, secret))`; `make_upgrade_token(gateway_id, secret, ttl=300)`;
  `verify_token` (right-split, expiry, multi-secret verify list, constant-time);
  delivery signature `HMAC(ts.body_json, key)` via `x-relay-timestamp` +
  `x-relay-signature`, 300s replay window.
- `__init__.py` — config/env resolution (`GATEWAY_RELAY_URL/ID/SECRET/PLATFORMS/
  BOT_IDS/ENDPOINT/ROUTE_KEYS/INSTANCE_ID/WAKE_URL`), `self_provision_relay()`,
  `register_relay_adapter()`.
- `media.py`, `command_manifest.py` — media upload/download client and Discord
  slash-command manifest (enrichment; out of scope for the in-process core).

Data flow (roundtrip): connector pushes `inbound` down the gateway's outbound
WS → `_event_from_wire` rebuilds `MessageEvent` (+ `delivered_via_upstream_
relay=True`, Slack `/hermes` normalization, `channel_context` rendering) →
adapter `handle_message` → agent turn → outbound action via `send_outbound` →
connector egress; results correlate back on `requestId`.

Tests defining parity (29 files; the 4 targeted):
- `test_relay_roundtrip.py` — connect registers inbound handler; inbound event
  reaches `handle_message`; `scope_id` drives `build_session_key` isolation;
  outbound send round-trips.
- `test_relay_interrupt.py` — `on_interrupt` sets only the target
  `session_key`'s Event, sibling untouched.
- `test_ws_transport.py` — real in-process `websockets` server: hello→descriptor
  handshake, inbound frame→handler, outbound request/response correlation,
  follow_up; 4401-after-handshake is terminal (no reconnect supervisor).
- `test_auth.py` — self-consistency (round-trip, tamper/expiry/skew/rotation) +
  **frozen cross-implementation vectors** from the connector's TS
  `relayAuthToken.ts` (byte-for-byte `make_token` conformance).

## 3. Target TypeScript design

Goal: run the relay **protocol in-process** so the webview talks to the agent
runtime directly; the WS byte-carrier becomes optional (remote mode only).
Module layout under `web/src/lib/relay/` (mirrors the Python package 1:1):

```
web/src/lib/relay/
  types.ts        Zod wire types: RelayFrame, MessageEventWire, SessionSourceWire,
                  OutboundAction, InterruptFrame, AckEnvelope
  descriptor.ts   CapabilityDescriptor schema + parse/serialize + LEGACY_OPS fallback
  auth.ts         HMAC token sign/verify, upgrade token, delivery signature,
                  multi-secret rotation (Web Crypto)
  transport.ts    RelayTransport interface + InProcessRelayTransport
                  + WebSocketRelayTransport (remote mode, wraps 'ws' or native WS)
  server.ts       InProcessRelayServer — session/turn registry, request dispatch,
                  event broadcast, interrupt router
  client.ts       InProcessRelaySocket — WebSocket-shaped adapter so existing
                  GatewayClient/hooks keep working unchanged
```

Key components:

- `InProcessRelayServer` — the in-process analog of the Python gateway's
  `/api/ws` JSON-RPC endpoint plus the relay transport semantics:
  - `handleRequest(id, method, params)` → resolves against the agent runtime
    facade (the future in-process TS agent; today it forwards to Rust Tauri
    commands or the existing store layer) and returns `{ok, value}` /
    `{ok, error}` — mirrors kimi-code `createRPC`'s `RpcResponse`
    (`packages/agent-core/src/rpc/client.ts`) and the memory dispatcher's
    `wireClone` JSON round-trip (`packages/klient/src/transports/memory/
    dispatcher.ts`) so in-process data is byte-identical to wire data.
  - `broadcast(event)` — fans out `{method:"event", params:{type, session_id,
    payload}}` frames (the exact shape `GatewayClient.handleFrame` parses) to
    subscribed listeners, replacing the socket.
  - `interrupt(sessionId)` — route to an in-flight turn registry (kimi-code
    `InFlightTurnTracker`, `packages/kap-server/src/transport/ws/v1/
    inFlightTurnTracker.ts`) and cancel ONLY that session's turn
    (AbortController), preserving Python's sibling isolation.
  - Optional real-WS facade `RelayWebSocketServer` (kimi-code `registerWsV1`,
    `ws` package) kept for remote attach; it authenticates the upgrade with the
    relay auth module (4401 semantics preserved).
- `InProcessRelayTransport` — implements `RelayTransport`-equivalent lifecycle
  (`connect/disconnect/handshake/setInboundHandler/sendOutbound/sendInterrupt/
  goIdle`) but calls the server via EventEmitter instead of a socket; the
  roundtrip correlation map `requestId → Promise` mirrors
  `ws_transport._pending` and kimi-code's ack `id` correlation
  (`ws-control.ts` `wsAckEnvelopeSchema`).
- `InProcessRelaySocket` — a `WebSocket`-subset shim (`onopen/onclose/onmessage/
  send/close`, readyState constants) exactly like `GatewayRelaySocket`
  (`web/src/lib/gateway-relay-socket.ts`) but bridged to the in-process server;
  `GatewaySocketFactory` then returns it for local mode and hooks/stores change
  zero lines.
- Auth module: port `auth.py` to TS with Web Crypto (`crypto.subtle.importKey`
  HMAC-SHA256 + `crypto.getRandomValues`); keep the Python frozen vector test as
  a conformance oracle.

## 4. Data models & persistence

- Wire models (all Zod, living in `web/src/lib/relay/types.ts` initially, later
  promoted into `packages/protocol`): `CapabilityDescriptor`, `SessionSourceWire`
  (platform/chat_id/chat_type/user_id/thread_id/scope_id/… from
  `relay-connector-contract.md` §3), `MessageEventWire`, `OutboundAction`,
  `RelayFrame` discriminated union (`hello|descriptor|inbound|outbound|
  outbound_result|interrupt|interrupt_inbound|going_idle|going_idle_ack|
  inbound_ack|passthrough_forward`), `JsonRpcFrame` (`{jsonrpc:"2.0", id,
  method, params}` / `{jsonrpc, id, result|error}` / `{method:"event",
  params:{type, session_id, payload}}` — the exact frames `GatewayClient` emits).
- `CapabilityDescriptor` normalization at the trust boundary: unknown keys
  ignored, `max_message_length <= 0 → 4096`, `supported_ops` empty ⇒
  `LEGACY_OPS` — copied verbatim from `descriptor.py`.
- Persistence: **no new database**. The relay server is a stateless protocol
  layer; sessions/turns stay in the existing Jotai stores
  (`web/src/stores/`), Rust SQLite (if needed) and, during migration, the
  Python gateway. The in-flight turn registry is an in-memory Map keyed by
  `sessionId` (like `InFlightTurnTracker`); it is rebuilt from
  `session.resume` on reconnect/page-refresh exactly as
  `use-gateway.ts`'s `reattachActiveSessionAfterReconnect` does today.
- Schema migration: none at v1. `contract_version` is additive-only; a
  breaking change updates Core + Desktop in lockstep (same rule as
  `descriptor.py`/`relay-connector-contract.md`).

## 5. Third-party library strategy

Most important section. Python dep → TS equivalent, with kimi-code evidence:

| Python (Core) | TS equivalent | Evidence in D:/kimi-code |
|---|---|---|
| `websockets` (WS client/server) | `ws` (server) / native `WebSocket` (client); in-process: none — EventEmitter | `packages/kap-server/src/transport/ws/registerWsV1.ts` `import { WebSocketServer } from 'ws'`; `wsConnectionV1.ts` socket handler |
| `asyncio` futures/events (requestId correlation, interrupt Events, go_idle ack) | `Promise` + `AbortController`/`AbortSignal`; `createControlledPromise` from `@antfu/utils` | `packages/agent-core/src/rpc/client.ts` (`createControlledPromise`, `abortable`); `wsConnectionV1.ts` heartbeat/close |
| `orjson`/`json` (frame serialization, wireClone semantics) | `JSON.stringify`/`JSON.parse`; explicit `wireClone` so in-process == network | `packages/klient/src/transports/memory/dispatcher.ts` `wireClone` ("byte-identical data no matter whether the call crossed a socket or stayed in-process") |
| `uuid.uuid4` (requestId) | `crypto.randomUUID()` or `ulid` | `node-sdk/src/sdk-rpc-client-v2.ts` `randomUUID`; `wsConnectionV1.ts` `import { ulid } from 'ulid'` |
| dataclass descriptor + wire validation | **Zod** schemas | `packages/protocol/src/ws-control.ts` — every WS envelope/control/ack is a Zod schema (`wsControlEnvelopeSchema`, `wsAckEnvelopeSchema`, `clientHello…Schema`); `packages/protocol/src/index.ts` style |
| `hmac`/`hashlib`/`pybase64` (auth tokens) | **Web Crypto** `crypto.subtle` (HMAC-SHA256, importKey/sign) + base64url encode/decode | **No direct equivalent found** in kimi-code — it has no bearer-HMAC token primitive; nearest are `node:crypto` usages (`oauth/src/identity.ts`, `minidb/src/lockfile.ts`). Design: implement `auth.ts` from scratch and pin it with Python's frozen vectors (`test_auth.py` `_CONN_TOKEN`) |
| `pytest`/`pytest-asyncio` | vitest | Desktop already uses vitest (`web/src/lib/*.test.ts`, `gateway-client.test.ts`) |
| `redis` relay bus / `RelayServer.routeBusMessage` (connector-side multi-instance) | Not needed in-process; single-process event bus (EventEmitter) | `packages/klient/src/transports/memory/serviceRegistry.ts` + `dispatcher.ts` show the in-process bus pattern |

Where no TS lib exists, sketch the shim (auth): `interface RelayAuth {
makeUpgradeToken(gatewayId, secret, ttl?): string;
verifyToken(token, secrets[]): string | null;
verifyDeliverySignature(bodyJson, timestamp, signature, keys[], maxSkew?): boolean; }`
implemented over `crypto.subtle`; TTL/replay-window constants copied from
`auth.py` (`300s` upgrade TTL, `300s` delivery skew).

## 6. Integration with existing Hermes-CN-Desktop frontend

- **Keep** `GatewayClient` (`web/src/lib/gateway-client.ts`) as the front-facing
  API: `request(method, params)`, `on/onAny/onState`, reconnect/auth-suspend
  (4401/4403), wake watchdog, `forceReconnect`. All hooks/stores
  (`use-gateway.ts`, chat stores, `gateway-delta-coalescer`) consume only this
  surface today — freeze it.
- **Swap** the socket factory: `getGatewayClient()` currently does
  `new GatewayClient(createGatewaySocket)` where `createGatewaySocket` is
  `web/src/lib/gateway-socket-path.ts`. Local mode passes
  `createInProcessGatewaySocket(url)` returning an `InProcessRelaySocket`
  (WebSocket-shaped; the `url` becomes a logical "hermes-relay://local" tag).
  Remote mode keeps the native/`GatewayRelaySocket` path.
- **Reuse**: `packages/protocol` `parseGatewayEvent` (`@hermes/protocol`) for
  event decoding — the in-process server emits the same frame shape;
  `web/src/lib/runtime.ts` `getGatewayUrl()`/`getSessionToken()` for the
  remote path; `web/src/lib/transport.ts` `authHeaders` (Bearer +
  `X-Hermes-Session-Token`) for REST stays as-is during migration.
- **Interrupt**: `use-gateway.ts` already calls
  `request("session.interrupt", {session_id})` (busy-retry path and composer
  Stop); in-process server maps it to the turn registry → AbortController. No
  hook change.
- **Rust side**: `src/commands/*` (`gateway_ws_open/send/close`, `ws_proxy.rs`)
  and `gateway-relay-socket.ts` become remote-only; `gateway-socket-path.ts`
  collapses to a local-vs-remote decision.

## 7. Removing the WebSocket dependency (migration path)

The README's end state: React webview hosts the agent runtime in-process; Rust
stays for OS-level capabilities via Tauri IPC. Freeze the API surface first —
the JSON-RPC method set and event types currently consumed:

- Methods (grep-verified): `prompt.submit`, `session.resume`, `session.close`,
  `session.title`, `session.usage`, `session.interrupt` (plus anything else
  `use-gateway.ts`/stores call).
- Events: everything `parseGatewayEvent` accepts (message.delta, session/turn
  lifecycle, tool progress, gateway.disconnected/auth_required…).

Phases:

1. **Contract freeze** — enumerate the above into `packages/protocol` as Zod
   schemas; add a `protocol-version` note (mirror `WS_PROTOCOL_VERSION` in
   `ws-control.ts`).
2. **In-process server behind the factory** — implement `RelayServer` +
   `InProcessRelaySocket`; local mode routes through it; Python WS still runs
   for comparison and remote attach. No UI change.
3. **Delete the local WS link** — stop starting `/api/ws` for local mode;
   `ws_proxy.rs` / `gateway-ws-*` / `gateway-socket-path.ts` native+relay
   probing removed (or gated to remote); `GatewayRelaySocket` kept only for
   remote attach.
4. **Replace the managed Python runtime** — once the agent runtime is fully
   in-process, `GatewayClient` itself can be replaced by the direct client
   (`relay/client.ts`) and the WS-shaped shim deleted.

During migration the in-process transport MUST reproduce: reconnect/resume
semantics (`session.resume` re-pin after disconnect, page-refresh reattach),
delta coalescing order, and auth-suspend UX (4401 → re-login prompt).

## 8. Migration phases & task breakdown

- **P0 — Protocol freeze (1 wk)**: Zod schemas for JSON-RPC frames + events +
  `CapabilityDescriptor` in `packages/protocol`; document every consumed method
  with its Python handler (`D:/hermes-agent-cn` gateway) as conformance
  oracle.
- **P1 — Relay core in-process (2 wks)**: `relay/types.ts`, `relay/auth.ts`
  (Web Crypto + frozen-vector vitest), `relay/descriptor.ts`,
  `relay/server.ts` (request dispatch + event broadcast + wireClone),
  `relay/transport.ts` (InProcessRelayTransport + correlation map).
- **P2 — Roundtrip + interrupt parity (1 wk)**: wire `prompt.submit` →
  runtime facade, event broadcast; in-flight turn registry + `session.interrupt`
  targeting one session; port `test_relay_roundtrip.py` +
  `test_relay_interrupt.py` semantics to vitest.
- **P3 — Socket swap (1 wk)**: `InProcessRelaySocket` behind
  `GatewaySocketFactory`; local mode default; keep remote path; run full
  existing `gateway-client.test.ts` + `use-gateway` integration.
- **P4 — WS link removal (1 wk)**: local mode stops dialing Python; retire
  `ws_proxy.rs`/`gateway-ws-*` for local; `gateway-socket-path.ts` collapses;
  delete `GatewayRelaySocket` remote-only vestiges once remote mode is
  re-proven.
- **P5 — E2E + cleanup (1 wk)**: Playwright prompt→delta→stop→resume flows;
  perf (delta coalescing), memory (turn registry cleanup), doc updates.

## 9. Risks & open questions

- **No kimi-code HMAC-bearer equivalent** — `auth.ts` must be written from
  scratch; the ONLY guarantee is the frozen Python vectors. Any drift in
  base64url padding/JSON spacing breaks the signature (see `test_auth.py`
  `_CONN_BODY` comment).
- **Two protocol vocabularies must not be conflated**: the Python
  `gateway/relay` contract (connector⇄gateway, `outbound/outbound_result`,
  `interrupt_inbound`) and the Desktop `/api/ws` JSON-RPC (client⇄gateway,
  `prompt.submit`, `method:"event"`) are different. The in-process server
  speaks the **latter**; we borrow the **former's** semantics (roundtrip
  correlation, interrupt-by-key isolation, auth scheme, 4401). Document this
  explicitly in `server.ts` headers.
- **Event ordering / resume**: in-process must preserve
  `use-gateway.ts`'s `needsResumeOnReopen` + `reattachActiveSessionAfterReconnect`
  behavior or in-flight turns strand after refresh — mirror the
  `gateway.disconnected` → `session.resume` handshake.
- **Auth trust boundary**: in-process mode removes the WS trust boundary; do
  NOT store `GATEWAY_RELAY_SECRET`-grade material in the renderer. Loopback
  trust only; the HMAC module is for remote mode + conformance.
- **Delta coalescing parity**: the in-process broadcast must feed
  `gateway-delta-coalescer` with identical event order/ids, or
  `message-adapter.ts` dedup/merge tests regress.
- Open: does remote mode need the full connector protocol (going_idle,
  passthrough_forward) or just the JSON-RPC subset? Recommend JSON-RPC subset
  first; connector ops remain Core-only for now.
- Open: where does the in-process agent runtime facade live until the full
  agent port lands — Tauri command proxy, or store-level stub? P1 assumes a
  `RuntimeFacade` interface with a Rust-IPC implementation today.

## 10. Test strategy

- **vitest unit — auth** (`relay/auth.test.ts`): port `test_auth.py` 1:1 —
  token round-trip, wrong-secret/expired/tamper rejection, multi-secret
  rotation, delivery-signature skew (±300s), and the **frozen connector vector**
  (`make_token("gw-instance-1", SECRET, 0)` === `_CONN_TOKEN`).
- **vitest unit — roundtrip** (`relay/roundtrip.test.ts`): in-process
  connect registers inbound handler; inbound wire event reaches the handler;
  `scope_id` drives session-key isolation; outbound send round-trips with
  correlated result (mirrors `test_relay_roundtrip.py`).
- **vitest unit — interrupt** (`relay/interrupt.test.ts`): interrupt sets only
  the target session's abort/turn signal; sibling untouched (mirrors
  `test_relay_interrupt.py`).
- **vitest — WS transport (remote mode)** (`relay/ws-transport.test.ts`):
  real `ws` server: hello→descriptor, inbound→handler, outbound correlation,
  4401-after-handshake terminal/no-reconnect (port of `test_ws_transport.py`);
  skipped when the `ws` dep is absent.
- **Regression**: existing `gateway-client.test.ts` and store/hook tests run
  unchanged after the socket swap (GatewayClient surface frozen).
- **Playwright E2E**: send prompt → streaming deltas render; composer Stop →
  `session.interrupt` cancels only the active turn; page-refresh mid-turn →
  `session.resume` reattach; remote attach still works.

## 11. Reference links

- `D:/hermes-agent-cn/gateway/relay/__init__.py`, `adapter.py`,
  `transport.py`, `ws_transport.py`, `auth.py`, `descriptor.py`,
  `media.py`, `command_manifest.py`
- `D:/hermes-agent-cn/docs/relay-connector-contract.md`
- `D:/hermes-agent-cn/website/docs/user-guide/messaging/relay.md`
- `D:/hermes-agent-cn/tests/gateway/relay/test_relay_roundtrip.py`,
  `test_relay_interrupt.py`, `test_ws_transport.py`, `test_auth.py`,
  `stub_connector.py`
- `D:/kimi-code/packages/agent-core/src/rpc/client.ts`, `core-api.ts`,
  `types.ts`, `index.ts`
- `D:/kimi-code/packages/kap-server/src/transport/ws/bearerProtocol.ts`,
  `connectionRegistry.ts`, `v1/registerWsV1.ts`, `v1/wsConnectionV1.ts`,
  `v1/inFlightTurnTracker.ts`, `v1/protocol.ts`
- `D:/kimi-code/packages/protocol/src/ws-control.ts`
- `D:/kimi-code/packages/klient/src/transports/memory/dispatcher.ts`,
  `ipc/host.ts`, `core/channel.ts`
- `D:/Hermes-CN-Desktop/web/src/lib/gateway-client.ts`,
  `gateway-relay-socket.ts`, `gateway-socket-path.ts`, `transport.ts`,
  `runtime.ts`
- `D:/Hermes-CN-Desktop/web/src/hooks/use-gateway.ts`
- `D:/Hermes-CN-Desktop/packages/protocol/src/hermes-api.ts`, `index.ts`
