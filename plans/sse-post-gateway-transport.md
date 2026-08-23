# SSE + POST Gateway Transport — Python → TypeScript Rewrite Plan

## 1. Summary

The managed Python runtime (Hermes-CN-Core) exposes the gateway JSON-RPC surface to
desktop shells over **three** fork-added transports:

1. **P-009 SSE+POST** — `GET /api/v2/events` (one-way SSE stream) + `POST /api/v2/rpc`
   (one-shot JSON-RPC POST), designed for Tauri webviews that cannot open `ws://`.
   **Deprecated since desktop ≥ 0.4** (which uses the native `/api/ws` WebSocket like the
   official desktop); kept only to serve ≤ 0.3.x shells that have no self-update.
2. **P-003 un-gated `/api/ws`** — the fork removed the `_DASHBOARD_EMBEDDED_CHAT_ENABLED`
   gate so the JSON-RPC WebSocket works even in headless `dashboard --no-open` mode
   (token + loopback guards remain; upstream v0.16.0 fixed the root cause by defaulting
   the flag to `True`, the fork keeps the explicit de-gate as defense-in-depth).
3. **P-011 RPC methods** — `model.options` gained a `slug_filter` param (region-specific
   model picker filtering) and a new `provider.probe` RPC (lightweight /models
   connectivity check with `api_mode` variants, later extended by P-036 `provider.models`).

**Key decision recorded in this plan: the SSE+POST *client* fallback is NOT ported to
TypeScript.** The existing Rust WS relay (`src/commands/ws_proxy.rs`) already solves the
original problem (webview can't open `ws://127.0.0.1`) with one ordered bidirectional
channel and no per-RPC HTTP round-trip or async-ack split. The Python `tui_gateway/sse.py`
server stays only until ≤ 0.3.x shells reach EOL and is **not** re-implemented in TS.
What IS ported: the transport-agnostic `GatewayClient` contract (frozen RPC surface
including `model.options`+`slug_filter` and `provider.probe`), and the un-gated `/api/ws`
path becomes an in-process `GatewayTransport` when the runtime moves into the webview.

## 2. Current Python implementation

Source of truth: `D:/hermes-agent-cn`.

### 2.1 SSE+POST server (P-009)

- `tui_gateway/sse.py` — `SSETransport` implements the `Transport` Protocol
  (`tui_gateway/transport.py`: `write(obj) -> bool`, `close()`). Per-connection
  `client_id`, an `asyncio.Queue(maxsize=1024)`, off-loop writes marshalled via
  `asyncio.run_coroutine_threadsafe` (10 s write timeout), SSE framing with the first
  chunk `event: client_id\ndata: {...}\n\n`, then `data: <json>\n\n` frames and a
  `: ping\n\n` comment every 15 s. Module-level registry `SSE_CLIENTS: Dict[str, SSETransport]`.
- `hermes_cli/web_server.py` (~L17260-17436):
  - `GET /api/v2/events` — token in query string (EventSource can't set headers); path is
    on `hermes_cli/dashboard_auth/public_paths.py` (`/api/v2/events`) so middleware lets it
    through to the handler's own `hmac.compare_digest` check. Accepts an optional
    `client_id=` for resumption, registers the transport, writes the `gateway.ready`
    event (with `resolve_skin()` payload — note: no `change_events` flag, unlike `/api/ws`),
    then streams; `finally` pops the registry entry and detaches sessions back to stdio.
  - `POST /api/v2/rpc` — requires `Authorization: Bearer` (regular middleware) +
    `X-Hermes-Client-Id` header; 400/410 JSON-RPC errors for missing/unknown id; body parsed
    with orjson; runs `server.dispatch(body, transport)` in a worker thread. If dispatch
    returns `None` (long handler scheduled on the pool) it replies with the sentinel
    `{"jsonrpc":"2.0","id":...,"result":{"accepted":true,"async":true}}` and the real
    response arrives over the SSE stream.
- Fork doc: `FORK_NOTES.zh-CN.md` P-009 (L358-379) — deprecated, must stay until
  ≤ 0.3.x shell EOL, `/api/v2/events` logs a deprecation line per connect so residual
  usage is quantifiable.

### 2.2 WebSocket transport / un-gated `/api/ws` (P-003)

- `tui_gateway/ws.py` — `WSTransport` (thread-safe `write`, per-token coalescing for
  `message.delta`/`reasoning.delta`/`thinking.delta` at 33 ms, `_send_lock` serialization,
  `TCP_NODELAY`), `handle_ws` (accept → `gateway.ready` with `change_events: true` →
  receive loop → `asyncio.to_thread(server.dispatch, ...)` → teardown reaps/detaches
  sessions via `server._close_sessions_for_transport`, unregisters from
  `server.register_live_transport`).
- `hermes_cli/web_server.py` `@app.websocket("/api/ws")` — P-003 removed the
  `_DASHBOARD_EMBEDDED_CHAT_ENABLED` gate; security boundary stays
  `_ws_auth_ok` (session token, close 4401) + `_ws_request_is_allowed` (loopback/host, 4403).
- `tui_gateway/server.py` `dispatch(req, transport)` (L2039) — inline handlers return the
  response dict; long handlers are submitted to the pool and write via the bound transport.
  `_LONG_HANDLERS` drives the SSE async-ack contract.

### 2.3 RPC methods (P-011)

- `tui_gateway/methods_complete.py` L411-450 — `model.options` with optional `slug_filter`
  (list of canonical provider slugs; custom providers always pass through), layered over
  `build_model_options_payload` from `hermes_cli.inventory`.
- `tui_gateway/server.py` L13274-13353 — `provider.probe` (params: `provider`, `api_key`,
  `base_url`, `api_mode` ("anthropic_messages" switches to `x-api-key` + `/v1/models`),
  `timeout_ms` 1000-30000 clamped; returns always-`_ok` `ProbeResult`
  `{ok, latency_ms, model_count, sample_models[≤5], status_code, error, error_kind}`;
  failures are data, not RPC errors). Shared `_fetch_provider_model_ids` also serves
  `provider.models` (P-036).
- `gateway/platforms/api_server.py` — the OpenAI-compatible API server is a *separate*
  SSE surface (`_sse_frame` byte-encoder, `ThreadSafeAsyncQueue`, `/v1/runs/...` event
  stream; disconnect → `agent.interrupt()` + task cancel, see test_sse_agent_cancel.py).
  Not the gateway transport, but the only Python SSE *client-behaviour* reference for
  cancellation parity.
- `gateway/relay/ws_transport.py` — a **different** WS protocol (gateway → connector
  relay: `hello`/`descriptor`/`inbound`/`outbound` frames). Evidence that Core has two
  distinct WS dialects; not part of the desktop surface.

### 2.4 Python tests to mirror

- `tests/gateway/test_sse_frame.py` — byte-contract of the SSE encoder.
- `tests/gateway/test_sse_agent_cancel.py` — SSE client disconnect cancels agent task /
  calls `agent.interrupt()` (api_server.py path).
- `tests/gateway/relay/test_ws_transport.py` — live-socket handshake/outbound correlation.
- `tests/test_tui_gateway_ws.py` — WS disconnect session reap/detach, live-transport
  registry, concurrent-send serialization, cross-batch ordering.
- `tests/test_pty_keepalive_ws.py` — `/api/pty` attach-token reuse (WS lifecycle, adjacent).

## 3. Target TypeScript design

### 3.1 Transport-carrier interface (in `web/src/lib`)

Freeze the carrier contract `GatewayClient` already consumes so the carrier can be swapped
without touching the protocol layer:

```ts
interface GatewayTransport {          // shape only — existing GatewayRelaySocket already fits
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen / onclose / onerror / onmessage: handlers;
}
```

Today there are two carriers: native `WebSocket` and `GatewayRelaySocket` (Rust relay),
selected by `gateway-socket-path.ts`. If the keep-fallback option were exercised, a third
carrier would be added:

- `web/src/lib/gateway-sse-client.ts` — `GatewaySsePostClient implements GatewayTransport`:
  - `open()`: `new EventSource(apiBase + "/api/v2/events?token=" + encodeURIComponent(token)
    + "&client_id=" + storedId)`; on `event: client_id` frame, persist `client_id`
    (localStorage, so reconnects reuse it — server honors a proposed id); on `data:` frame,
    feed `onmessage`; ignore `event: client_id` repeats and `: ping` comments.
  - `send(line)`: `POST /api/v2/rpc` via `transport.ts` (dev: browser fetch; packaged:
    Rust `api_request` IPC, which injects `Authorization`). Two-phase correlation: if the
    POST body is an RPC response, settle the pending promise; if it is the
    `{result:{accepted:true,async:true}}` sentinel, move the pending entry to
    "awaiting SSE" and let the matching SSE `data:` frame (same `id`) settle it.
  - Reconnect: exponential backoff 1-15 s (mirror `GatewayClient`), reusing `client_id`;
    no synthetic ping (server sends `: ping`; treat 20 s silence as dead and reconnect).
- Optional Rust side `src/commands/sse_proxy.rs` — only if the webview also blocks
  EventSource to `http://127.0.0.1` (it is plain GET, so CORS/connect-src usually allow
  it): mirror `ws_proxy.rs` (`sse_proxy_open {connectionId}` / emit `gateway-sse-frame` /
  `gateway-sse-closed`; POST side reuses existing `api_request`). **Not recommended** —
  `ws_proxy.rs` already covers the blocked case with fewer moving parts.

### 3.2 Un-gated `/api/ws` in-process

End state: `web/src/lib/gateway-inprocess.ts` implements the same
`GatewayTransport`-shaped bridge by calling a TS `dispatch(request)` table directly
(in-process agent runtime), so `GatewayClient` continues to work with zero UI changes.
The P-003 behaviour (WS reachable without `--tui`) becomes moot: there is no separate
dashboard process and no WS at all.

### 3.3 P-011 RPC in-process

- `model.options` + `slug_filter`: port the filter to the in-process model catalog query
  (kimi-code reference: `packages/agent-core/src/services/modelCatalog/`,
  `packages/protocol/src/modelCatalog.ts`). `web/src/lib/cn-provider-slugs.ts` keeps
  feeding `CN_BACKEND_PROVIDER_SLUGS`; custom (non-canonical) providers always pass.
- `provider.probe`: port `_fetch_provider_model_ids` semantics — GET `{base}/v1/models`
  (or `{base}/v1/messages` for `api_mode: "anthropic_messages"`), short timeout, sample 5 —
  as `web/src/lib/provider-probe.ts` extensions that run through the in-process HTTP layer
  (`transport.ts`), preserving `ProviderProbeResult` (already in
  `packages/protocol/src/hermes-api.ts` L1418). The existing direct
  `probeChatCompletionsProvider` stays for the UI "test this specific input" flow.

## 4. Data models & persistence

- **No new persistence.** The SSE client-id registry (`SSE_CLIENTS`) is in-memory on the
  Python side; the TS side's equivalent is the existing `GatewayClient.pending` map
  (RPC id → promise) plus an optional `localStorage` `client_id` for SSE resumption
  (only if the fallback carrier is kept).
- `gateway.ready` event shape (with/without `change_events`) and
  `GatewayKnownEvent`/`RawGatewayEvent` (`hermes-api.ts` L1727) are the frozen wire data
  models; no schema migration.
- P-011 result schemas (`ModelOptionsResult`, `ProviderProbeResult`,
  `ProviderModelsListResult`) already exist in `packages/protocol/src/hermes-api.ts` and
  are reused as-is by `use-gateway.ts` via `parseGatewayResult`.
- SSE frame byte format (P-009) does not need persistence; if kept, encode/decode helpers
  live next to `gateway-sse-client.ts` with vitest byte-contract tests mirroring
  `tests/gateway/test_sse_frame.py`.

## 5. Third-party library strategy

| Python dependency | TS equivalent | Evidence (kimi-code) | Notes |
|---|---|---|---|
| starlette `StreamingResponse` / `WebSocket` (SSE+WS server) | Not needed in-process; if a standalone server is ever required: `ws` npm pkg + raw http | `packages/kap-server/src/transport/ws/v1/registerWsV1.ts` L2 `import { WebSocketServer } from 'ws'` | No kimi-code SSE *server* exists; SSE servers are not part of the rewrite |
| aiohttp `web.StreamResponse` (api_server SSE) | Native `Response` streams / `ReadableStream` | `packages/kap-server/src/routes/plugins.ts` uses global `fetch` | Only for the OpenAI-compatible adapter, out of scope here |
| orjson | `JSON.parse`/`JSON.stringify` | `GatewayClient` already uses them | No lib needed |
| JSON-RPC framing | Implement from scratch (thin `encodeFrame`/`decodeFrame`/`parseGatewayEvent`) | **No JSON-RPC lib in kimi-code**: `agent-core/src/rpc/client.ts` is an in-process proxy RPC (no wire JSON-RPC); kap-server WS uses custom `{type,payload}` frames (`transport/ws/v1/protocol.ts`) | State "implement TS module from scratch"; ~80 lines |
| EventSource (client) | Browser native `EventSource` (zero-dep); fallback: `@modelcontextprotocol/sdk/client/sse.js` | `packages/agent-core/src/mcp/client-sse.ts` L4 wraps `SSEClientTransport` for MCP SSE servers | Only needed if the SSE fallback carrier is kept |
| `websockets` (Python, relay ws_transport) | `ws` npm pkg (TS) / `tokio-tungstenite` (Rust) | kimi-code `registerWsV1.ts`; Desktop `Cargo.toml` already has `tokio-tungstenite` | Desktop relay already implemented |
| `hermes_cli.inventory.build_model_options_payload` / `_fetch_provider_model_ids` | kimi-code model catalog: `packages/protocol/src/modelCatalog.ts`, `packages/agent-core/src/services/modelCatalog/` | `model-switching.md` plan already cites `refreshProviderModels()` | Port as in-process service; `provider.probe` = its `GET /v1/models` ladder + sample-5 |

**"No TS equivalent found" risks:** (1) no TS JSON-RPC wire library is used by kimi-code
— implement framing from scratch; (2) no kimi-code SSE *server* implementation exists to
reference — if the Python SSE+POST server ever needed a TS twin, that would be net-new
(decision below: don't port); (3) kimi-code's WS protocol is event-subscription
(`client_hello`/`subscribe`), not bidirectional JSON-RPC, so the reconnect/resume
semantics cannot be lifted from it directly.

## 6. Integration with existing Hermes-CN-Desktop frontend

- **Reuse as-is:** `gateway-client.ts` (`GatewayClient.request/on/onAny/onState`,
  reconnect backoff, wake listeners), `transport.ts` (`authHeaders` — `Authorization:
  Bearer` + `X-Hermes-Session-Token` — for any `POST /api/v2/rpc` fallback), `runtime.ts`
  (`getGatewayUrl`, `getSessionToken`, `isRemote`), `gateway-relay-socket.ts` +
  `src/commands/ws_proxy.rs` (Rust relay wire contract), `hermes-api.ts` schemas,
  `use-gateway.ts` (`getModelOptions` already sends `slug_filter`; `probeProvider`,
  `listProviderModels` already RPC `provider.probe`/`provider.models`),
  `cn-provider-slugs.ts`, `model-options-cache.ts`, `provider-probe.ts`.
- **Extend if fallback kept:** `gateway-socket-path.ts` path union `"native" | "relay"`
  → add `"sse"` and a learned `HERMES_GATEWAY_PATH_LEARNED` value; the selection
  precedence comment already anticipates a third carrier.
- **Rust:** `api_proxy.rs` (`api_request`) is the packaged-mode transport for
  `POST /api/v2/rpc`; `ws_proxy.rs` is the template for any SSE relay command.
- **Remove at end state:** `ws_proxy.rs`, `gateway-relay-socket.ts`,
  `gateway-socket-path.ts`, and the WS branch of `createGatewaySocket` — replaced by the
  in-process carrier; `use-gateway.ts` and all call sites stay byte-identical.

## 7. Removing the WebSocket dependency (migration path)

Phase-gated removal with a **frozen API surface**:

1. **Today:** `GatewayClient` (WS JSON-RPC) ↔ Python `/api/ws`; native WS or Rust relay;
   P-009 endpoints serve ≤ 0.3.x shells; `provider.probe`/`model.options` RPC live in
   Python.
2. **Freeze** (during migration): the RPC method list + params the desktop depends on —
   `model.options` (+`slug_filter`), `provider.probe`, `provider.models`, `session.*`,
   `prompt.submit`, `approval.*`, `config.*`, `setup.*`, `complete.*`, `command.dispatch`
   — and the `gateway.ready`/`gateway.auth_required` event payload shapes.
3. **Fallback (optional, recommended against):** implement `GatewaySsePostClient` behind
   `GatewayTransport` for webviews where both native WS and Rust relay fail. Recorded
   trade-off (FORK_NOTES P-009): no heartbeat, one HTTP round-trip per RPC, async-ack
   split makes in-flight turns fragile — the Rust relay was built specifically to avoid
   this. **Decision: drop.** Keep this section as the design record.
4. **In-process:** add `gateway-inprocess.ts` carrier → delete WS client paths → delete
   `ws_proxy.rs`/`gateway-socket-path.ts`. Python side: keep `/api/v2/events` +
   `/api/v2/rpc` until ≤ 0.3.x shell EOL (runtime hot-updates under old shells must keep
   working), then delete `tui_gateway/sse.py` + the two routes. Do NOT port the SSE+POST
   server to TS.

## 8. Migration phases & task breakdown

- **Phase A (transport contract):** define `GatewayTransport` type; prove
  `GatewayRelaySocket` satisfies it; add vitest contract tests (no behavior change).
- **Phase B (in-process carrier):** `gateway-inprocess.ts` dispatch bridge; route
  `model.options`/`provider.probe`/`provider.models` through it first (P-011 parity);
  keep WS carrier for the rest; dual-run in dev with a parity flag.
- **Phase C (cut over):** flip default carrier to in-process; keep WS relay behind a
  feature flag; verify `use-gateway.ts` flows (model picker, provider probe, session
  resume) against both carriers.
- **Phase D (delete):** remove WS client + Rust relay + socket-path selection; coordinate
  with Core to delete `tui_gateway/sse.py` + `/api/v2/*` after ≤ 0.3.x EOL; delete
  `gateway-sse-client.ts` design artifact if never shipped.
- **P-003:** no separate task — the un-gate is a Core-side patch that becomes irrelevant
  once the runtime is in-process; record in FORK_NOTES as "resolved by architecture".

## 9. Risks & open questions

- **No TS JSON-RPC lib in kimi-code** — framing must be hand-rolled; keep the
  `parseGatewayEvent` fallback semantics (known-event safe-parse → raw passthrough).
- **Async-ack split fragility** (P-009 deprecation note): any kept SSE fallback must
  implement two-phase pending correlation and a "SSE silence ⇒ reconnect" watchdog;
  strongly favors dropping the fallback.
- **Token on query string** for `GET /api/v2/events` (EventSource limitation) — leaks via
  history/proxy; the Rust relay avoided this by keeping the token in Rust. Another reason
  to drop.
- **kimi-code WS is event-subscription, not JSON-RPC** — reconnect/session-resume
  semantics must be designed from Hermes' own `GatewayClient`, not lifted from kimi-code.
- **`gateway.ready` payload drift** — SSE path lacks `change_events`; in-process must
  standardize one payload (include `change_events: true`).
- **Open question:** actual ≤ 0.3.x shell EOL date — unknown; P-009 removal is blocked on
  it, and `/api/v2/events` deprecation logs should be reviewed before removal.
- **Provider probe CORS/SSRF** — keep probe execution on the backend/in-process side with
  the existing `external_request` guard; the direct `provider-probe.ts` path is for
  user-entered keys and must not bypass SSRF.

## 10. Test strategy

- **vitest unit — `gateway-sse-client.ts`** (if kept): client_id handshake parsing, `data:`
  frame routing, `: ping` tolerance, POST sentinel → SSE response correlation, reconnect
  reusing client_id; mirror Python `tests/gateway/test_sse_frame.py` byte contract.
- **vitest unit — transport contract:** `GatewayRelaySocket`/in-process carrier satisfy
  `GatewayTransport`; concurrent-send ordering parity with
  `tests/test_tui_gateway_ws.py::test_ws_transport_preserves_cross_batch_order`.
- **vitest unit — P-011:** `model.options` slug_filter filtering (custom providers pass;
  canonical filtered) with mocked catalog; `provider.probe` result mapping
  (auth/http/timeout/network/unknown kinds) mirroring
  `tests/gateway/test_provider_models_rpc.py`; `ProviderProbeResult` Zod parse.
- **Playwright E2E:** model picker with `slug_filter`, settings "测试连接" via
  `provider.probe`; if fallback kept, a forced-`sse` path test with a fake backend.
- **Rust (if fallback kept):** `sse_proxy`/`api_request`-based POST with
  `wiremock::MockServer`; no real network.
- **Core parity (opt-in):** run `tests/test_tui_gateway_ws.py` and
  `tests/gateway/test_sse_agent_cancel.py` against the in-process bridge via a harness
  that swaps `tui_gateway.server.dispatch` for the TS dispatch.

## 11. Reference links

- `D:/hermes-agent-cn/tui_gateway/sse.py`, `tui_gateway/ws.py`, `tui_gateway/server.py`,
  `tui_gateway/methods_complete.py`, `tui_gateway/transport.py`
- `D:/hermes-agent-cn/hermes_cli/web_server.py` (`/api/ws`, `/api/v2/events`, `/api/v2/rpc`),
  `hermes_cli/dashboard_auth/public_paths.py`
- `D:/hermes-agent-cn/gateway/platforms/api_server.py` (`_sse_frame`,
  `ThreadSafeAsyncQueue`), `gateway/relay/ws_transport.py`
- `D:/hermes-agent-cn/FORK_NOTES.zh-CN.md` P-003 / P-009 / P-011 / P-036
- Tests: `tests/gateway/test_sse_frame.py`, `tests/gateway/test_sse_agent_cancel.py`,
  `tests/gateway/relay/test_ws_transport.py`, `tests/test_tui_gateway_ws.py`,
  `tests/test_pty_keepalive_ws.py`
- kimi-code: `packages/agent-core/src/rpc/client.ts`, `packages/agent-core/src/mcp/client-sse.ts`,
  `packages/kap-server/src/transport/ws/v1/registerWsV1.ts` (+ `protocol.ts`,
  `wsConnectionV1.ts`), `packages/protocol/src/envelope.ts`, `packages/protocol/src/events.ts`,
  `packages/protocol/src/modelCatalog.ts`, `packages/agent-core/src/services/modelCatalog/`
- Desktop: `web/src/lib/gateway-client.ts`, `gateway-socket-path.ts`,
  `gateway-relay-socket.ts`, `transport.ts`, `provider-probe.ts`, `cn-provider-slugs.ts`,
  `web/src/hooks/use-gateway.ts`, `packages/protocol/src/hermes-api.ts`,
  `src/commands/ws_proxy.rs`, `src/commands/api_proxy.rs`,
  `docs/gateway-connection-overhaul.md`, `docs/desktop-prd/04-backend-contract.md`
