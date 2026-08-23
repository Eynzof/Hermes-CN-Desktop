# API Server — Python → TypeScript Rewrite Plan

## 1. Summary

Port the OpenAI-compatible HTTP API server from the Python gateway
(`gateway/platforms/api_server.py`) into the Hermes-CN-Desktop TS monorepo so
external frontends (Open WebUI, LobeChat, LibreChat, NextChat, ChatBox, Jan,
HF Chat-UI, big-AGI, OpenAI SDK) can drive the desktop's agent over
`http://127.0.0.1:8642/v1` **without the managed Python runtime's WS link**.

Surface to freeze: `POST /v1/chat/completions` (stateless + SSE),
`POST /v1/responses` (stateful `previous_response_id`), `/v1/runs` (+ SSE
events / stop / approval), jobs API, sessions API (CRUD/fork/chat[/stream]),
`/v1/models`, `/v1/capabilities`, `/v1/skills`, `/v1/toolsets`, `/health`,
per-request model override, `X-Hermes-Session-Key`/`Session-Id`, multi-profile
`/p/<profile>/` routing, and GATEWAY_PROXY_URL proxy-mode compatibility.

Key decision: the TCP listener cannot live in a Tauri webview, so the HTTP
server is implemented **in-process in Rust with hyper** (already a Cargo
dependency and already proven by `src/commands/browser_companion.rs`), and all
OpenAI protocol translation + agent orchestration lives in a TS module
(`web/src/lib/api-server/`) bridged over Tauri IPC — the same direction as the
existing `ws_proxy.rs` relay. kimi-code's `kap-server` is the TS reference for
route organization, zod validation, auth/CORS middleware, and event typing, but
it has **no OpenAI-compatible `/v1/chat/completions` endpoint**, so the wire
translators are written from scratch (SSE framing is trivial; the Rust↔TS
streaming bridge is the main new risk).

## 2. Current Python implementation

- Source of truth: `D:/hermes-agent-cn/gateway/platforms/api_server.py`
  (7,371 lines). aiohttp `web.Application` with middlewares (CORS, body limit,
  security headers, profile-prefix); routes registered in
  `APIServerAdapter._http_route_table()` (line 2049) and mirrored under
  `/p/{profile}/...` in `connect()` (line 7167).
- Registered from the gateway runner in
  `D:/hermes-agent-cn/gateway/run.py` (line 14438, `Platform.API_SERVER` →
  `APIServerAdapter(config)`; shutdown drain/interrupt at lines 7676-7700).
- Platform base/helpers: `D:/hermes-agent-cn/gateway/platforms/base.py`
  (media tag cleanup, network-access classification, media delivery path
  validation); config in `D:/hermes-agent-cn/gateway/config.py`
  (`Platform.API_SERVER`); readiness in `D:/hermes-agent-cn/gateway/readiness.py`.
- Data flow:
  1. HTTP → middlewares (auth `_check_auth`, profile scope via
     `_api_request_profile` ContextVar, CORS `cors_middleware`, body size
     `MAX_REQUEST_BYTES=10MB`, security headers).
  2. Handler parses body (`_read_json_body`), normalizes multimodal content
     (`_normalize_multimodal_content`, `_normalize_chat_content`), resolves
     model overrides (`_request_agent_overrides` +
     `_resolve_request_runtime_agent_kwargs` + `_resolve_route` model_routes),
     session continuity (`_derive_chat_session_id`,
     `X-Hermes-Session-Key` → `AIAgent(gateway_session_key=...)`).
  3. `_run_agent` (line 6128) constructs `AIAgent`, runs
     `run_conversation` on a worker thread, collects deltas via
     `stream_delta_callback`; SSE writers (`_write_sse_chat_completion`,
     `_write_sse_responses`, `_handle_session_chat_stream`) bridge
     worker→asyncio through `ThreadSafeAsyncQueue.put_threadsafe` +
     `_sse_frame()`.
  4. `/v1/responses` persists full conversation history in
     `ResponseStore` (SQLite LRU, `response_store.db` under HERMES_HOME,
     max 100); `previous_response_id`/`conversation` chains rebuild history
     (`_build_response_conversation_history`,
     `_auto_truncate_response_history`).
  5. `/v1/runs` keeps `_run_status` + `_make_run_event_callback`; SSE event
     stream, `stop`, `approval`, orphaned-run sweep (`_sweep_orphaned_runs`),
     concurrency cap `max_concurrent_runs` (default 10, 429),
     drain-on-shutdown (`_release_pending_api_work`).
  6. Sessions API reads/writes `SessionDB` (hermes_state) + agent turns;
     jobs API wraps `cron` module (`_check_jobs_available`, 501 when
     `_CRON_AVAILABLE` is False).
- Docs: `D:/hermes-agent-cn/website/docs/user-guide/features/api-server.md`
  (endpoints, auth, per-request model precedence, multi-profile binding,
  proxy mode = `GATEWAY_PROXY_URL` target).
- Tests: `tests/gateway/test_api_server*.py` (10 files, ~5,300 lines) +
  `tests/tools/test_delegate_apiserver_background.py`.

## 3. Target TypeScript design

Module layout:

```
src/api_server/                    (Rust — new module, hyper listener)
  mod.rs                           start/stop, port resolution (8642), bind guard
  http.rs                          hyper service_fn, SSE transport, CORS, security headers
  bridge.rs                        Tauri IPC bridge: Rust→TS request events, TS→Rust commands
  response_store.rs                rusqlite LRU store (moved later to web runtime if desired)
web/src/lib/api-server/
  index.ts                         start/stop via Tauri command; state (enabled/port)
  routes.ts                        route table (mirrors _http_route_table())
  middleware.ts                    auth (Bearer API_SERVER_KEY), CORS allowlist, body cap, security headers
  schemas.ts                       zod request/response schemas (chat, responses, runs, sessions, jobs)
  chat-completions.ts              stateless handler + SSE chunk emitter
  responses.ts                     stateful handler + Responses event emitter
  runs.ts                          /v1/runs state machine, SSE events, stop, approval
  sessions.ts                      /api/sessions CRUD/fork/chat[/stream]
  jobs.ts                          /api/jobs CRUD + pause/resume/run
  models.ts                        /v1/models, /api/model/options
  capabilities.ts                  /v1/capabilities
  skills-toolsets.ts               /v1/skills, /v1/toolsets
  agent-bridge.ts                  interface to the agent runtime (turn runner / session store / tools)
  session-key.ts                   X-Hermes-Session-Key/Id validation (256 chars, no controls)
  sse.ts                           SSE frame builder + keep-alive (30s) + backpressure queue
```

Interfaces (pseudocode only):

```ts
interface ApiServerBridge {
  // Rust → TS (Tauri event "api-server-request"): HTTP request arrives
  handleRequest(req: ApiHttpRequest): Promise<void>;   // responds via commands below
  handleStreamOpen(req: ApiHttpRequest): Promise<string>; // returns streamId
}
// TS → Rust (Tauri commands)
api_server_respond({ requestId, status, headers, body })
api_server_begin_stream({ requestId, streamId, headers })
api_server_stream_frame({ streamId, event?, dataJson })   // one SSE frame
api_server_end_stream({ streamId, status? })

interface AgentTurnRunner {            // provided by the future in-process agent
  run(input: AgentTurnInput, hooks: TurnHooks): Promise<TurnResult>;
  stop(runId: string): Promise<void>;
  approve(runId: string, decision: ApprovalDecision): Promise<void>;
}
interface ISessionStore { list/get/create/patch/delete/fork/messages(...) }
interface IResponseStore { get/put/delete(conversationName) }
interface IJobsStore { list/create/get/patch/delete/pause/resume/run(...) }
```

Rust owns: socket bind (`127.0.0.1:8642`, refuse non-loopback bind like
Python's startup guard + `is_network_accessible` warning), HTTP parse, body
limit, CORS/security headers, auth header extraction, SSE content-type
(`text/event-stream`) and chunked writes, port conflict handling. TS owns:
route matching, JSON validation (zod), OpenAI wire translation, agent
orchestration, sessions/jobs state, model/provider resolution, SSE payload
serialization (single `sse.ts` source of truth, mirroring Python `_sse_frame`).

## 4. Data models & persistence

- **Responses store** (stateful `/v1/responses`): mirror Python
  `ResponseStore` exactly — SQLite tables `responses(response_id PK, data,
  accessed_at)` + `conversations(name PK, response_id)`, LRU cap 100,
  owner-only file perms (0600 + `-wal`/`-shm`). Location: HERMES_HOME
  `response_store.db` for parity, via Rust `rusqlite` (already a bundled Cargo
  dep) with a TS wrapper; fall back to `:memory:` on open failure. Schema
  migration: keep Python's column names so a mixed-mode rollout (desktop
  serving while Python gateway still enabled) can share the file; add a
  `schema_version` pragma check.
- **Sessions**: reuse the existing `SessionSummary`/`SessionDetail`/
  `SessionMessage` zod schemas in
  `D:/Hermes-CN-Desktop/packages/protocol/src/hermes-api.ts` (lines 164,
  227, 240) as the wire contract; the backing store is initially the gateway
  SessionDB (via WS/REST bridge), later the in-process session store
  (IndexedDB or rusqlite per the sessions plan). Fork semantics must match
  `SessionDB` lineage (`test`-covered in Python).
- **Run state**: in-memory TS `Map<runId, RunRecord>` with terminal-state
  retention + 5-minute unconsumed event buffer expiry (mirror
  `_sweep_orphaned_runs`); no persistence.
- **Jobs**: read/write through the desktop's existing cron integration
  (`src/cron_runs.rs` reads `{HERMES_HOME}/cron/output/...`); CRUD parity
  targets Python cron module behavior (501 when unavailable).

## 5. Third-party library strategy

| Python dependency | TS equivalent | Evidence (kimi-code / desktop) |
|---|---|---|
| aiohttp HTTP server | **Rust hyper 1 + hyper-util (in-process)**; TS-side Fastify route/schema conventions only | hyper already in `D:/Hermes-CN-Desktop/Cargo.toml` (lines 52-53); in-process loopback server precedent `src/commands/browser_companion.rs` (hyper `service_fn`, `http1`, TcpListener, WS upgrade). kimi-code `packages/kap-server/package.json` uses fastify ^5 + @fastify/swagger for its Node server — cite as the route-organization reference, not a runtime dep |
| aiohttp SSE (`StreamResponse`, `_sse_frame`) | TS `web/src/lib/api-server/sse.ts` + Rust hyper chunked writer | **No SSE in kimi-code** — kap-server transport is WebSocket (`packages/kap-server/src/transport/ws/`); SSE built from scratch (frame = `data: <json>\n\n`, 30s keepalive, queue with backpressure mirroring Python `ThreadSafeAsyncQueue`) |
| Chat Completions wire format (chunk emitter) | TS `chat-completions.ts` (from scratch, zod-typed) | kimi-code has the **client-side** reverse direction: `packages/kosong/src/providers/chat-completions-stream.ts`, `agent-core-v2/src/kosong/provider/bases/openai/chat-completions-stream.ts` (parse `chat.completion.chunk`); server-side emitter must be written |
| Responses API wire format | TS `responses.ts` (from scratch) | kimi-code `packages/protocol/src/events.ts` + `agent-core/src/rpc/events.ts` define `AssistantDeltaEvent`, `ToolStartedEvent`, etc. — reuse event names for `response.output_text.delta` / `function_call` mapping |
| pydantic/zod-less parsing (Python `typing` + aiohttp) | zod everywhere | `packages/kap-server` deps `zod`; `src/middleware/schema.ts`, `validate.ts`; `packages/protocol/src/rest-*.ts` schemas |
| auth (Bearer API_SERVER_KEY, `_check_auth`) | TS middleware + Rust header check | `packages/kap-server/src/middleware/auth.ts` (bearer extract, 401, rate limit via `middleware/rateLimit.ts`) |
| CORS (`cors_middleware`) | TS/Rust CORS allowlist | `packages/kap-server/src/middleware/origin.ts` (parseCorsOrigins) + browser_companion.rs CORS headers |
| SQLite (ResponseStore, sqlite3 stdlib) | Rust `rusqlite` (bundled) or TS `minidb` | `rusqlite` already in Desktop Cargo.toml (line 61); kimi-code `packages/minidb` is the embedded-DB option for the TS runtime |
| SessionDB (hermes_state) | Gateway bridge now → in-process session store later | desktop `packages/protocol/src/hermes-api.ts` Session* schemas; kimi-code `packages/kap-server/src/routes/sessions.ts` + `protocol/rest-session.ts` |
| cron module (jobs API) | Reuse `src/cron_runs.rs` + gateway cron | desktop `src/cron_runs.rs`; kimi-code `agent-core/src/agent/cron/` (cron scheduling engine) |
| model routing / provider catalog (`hermes_cli.runtime_provider`) | `provider-catalog.ts`, `provider-id.ts`, `provider-probe.ts`, `model-options-cache.ts` | desktop `web/src/lib/provider-catalog.ts` etc.; kimi-code `kap-server/src/routes/modelCatalog.ts` + `services/modelCatalog/` |
| `uuid`/`time` id + created stamps | `crypto.randomUUID()` / `Date.now()` | kimi-code uses `ulid` npm pkg (kap-server package.json) |
| logging | pino (sidecar only) or TS console + debugBus | `packages/kap-server` `pino`; desktop `web/src/lib/debug-bus.ts` for in-webview logs |

**No TS equivalent found (explicit):**
1. **OpenAI-compatible server-side endpoint** — kimi-code has no
   `/v1/chat/completions` or `/v1/responses` server; implement translators from
   scratch (zod + SSE).
2. **SSE over Tauri IPC bridge** — no precedent anywhere; the Rust↔TS
   frame-relay channel is new (see §9).
3. **HTTP listener inside a webview** — impossible; must be Rust hyper
   (browser_companion.rs precedent) or a Node sidecar; this plan chooses Rust.
4. **Jobs REST API** — kap-server has no jobs REST surface; reuse desktop cron
   plumbing.

## 6. Integration with existing Hermes-CN-Desktop frontend

- **Rust**: new `src/api_server/` module alongside `commands/browser_companion.rs`
  (reuse its hyper listener + port-fallback + WS-upgrade idioms). Reuse
  `commands/api_proxy.rs` `validate_external_url` SSRF guards for inbound
  `image_url` fetches; reuse `state.rs` AppState for config (host/port/key/
  cors, enabled flag) and profile selection; add `api_server` handle to
  `AppStateInner` like `BrowserCompanionHandle`/`GatewayWsHandle`.
- **Transport/auth**: external clients authenticate with `API_SERVER_KEY` —
  independent of the dashboard token path in `web/src/lib/transport.ts`;
  reuse `transport.ts` for the *interim* bridge to the Python gateway
  (authHeaders + fetchJSON), and `gateway-client.ts`/`use-gateway.ts` for
  agent turns during migration.
- **Chat/event reuse**: the TS runtime already consumes `assistant.delta`,
  `tool.started`, `tool.completed`, `run.completed` in
  `web/src/stores/chat.ts` — the API-server SSE emitters use the same event
  vocabulary so one translation layer serves both the chat UI and the API.
- **Protocol schemas**: extend `packages/protocol/src/hermes-api.ts` with
  API-server-specific zod schemas (OpenAI wire + runs events + capabilities),
  keeping `SessionSummary` etc. as shared types.
- **Profiles**: `web/src/lib/api-server/` resolves `/p/<profile>/` using
  `activeProfileAtom` + per-profile key resolution; `transport.ts` already
  sends `X-Hermes-Profile` (stub) — the API server makes this real.
- **Settings UI**: add an API Server settings pane reusing
  `settings-model-save.ts`-style save patterns; port 8642 conflicts with none
  of 9120/9545/9546 (AGENTS.md ports).

## 7. Removing the WebSocket dependency (migration path)

Frozen interface during migration = the full Python route table (see
`_http_route_table()` lines 2055-2100) + OpenAI wire formats + SSE event
schemas; do not change them until all phases land.

- **Phase A (today)**: desktop enables the Python API server inside the
  managed runtime (inject `API_SERVER_ENABLED=true` + generated
  `API_SERVER_KEY` into the runtime env, expose port 8642). External
  frontends hit Python directly; web UI unchanged (WS JSON-RPC).
- **Phase B (desktop-owned HTTP)**: Rust hyper listener starts on 8642 and
  routes to the new TS module. `agent-bridge.ts` first calls the *same* Python
  agent through the existing WS JSON-RPC surface, so every endpoint is served
  by the desktop while agent execution still runs in the managed runtime. The
  web UI's chat store and the API server share the same event stream
  translation. Python's own API server is disabled (single listener).
- **Phase C (in-process)**: swap `agent-bridge.ts` from WS JSON-RPC to the
  in-process TS agent runtime (the end-state per plans/README); delete
  Phase-B bridge code; drop the managed-runtime API-server enablement.

## 8. Migration phases & task breakdown

1. **Protocol parity harness**: zod schemas + golden fixtures from Python
   tests (chat chunks, responses events, runs SSE); unit-test `sse.ts`,
   content normalization, session-key validation, model-override precedence.
2. **Rust listener**: `src/api_server/` hyper loopback, bind guard
   (require key, refuse non-loopback like `test_api_server_bind_guard.py`),
   body limit 10MB, CORS, security headers, SSE transport, port conflict
   handling; wiremock tests.
3. **IPC bridge**: `api-server-request` event + respond/stream commands;
   correlation ids; stream backpressure (bounded channel, drop/503 policy).
4. **Read-only endpoints**: `/health`, `/health/detailed`, `/v1/models`,
   `/api/model/options`, `/v1/capabilities`, `/v1/skills`, `/v1/toolsets`
   (reuse provider-catalog / skills hub).
5. **Chat Completions**: stateless + `stream:true` SSE +
   `hermes.tool.progress`; multimodal normalization; direct_model_requests.
6. **Responses API**: ResponseStore (rusqlite), `previous_response_id`/
   `conversation` chains, GET/DELETE response, Responses SSE events.
7. **Sessions API**: list/create/get/patch/delete/messages/fork/chat/stream;
   model lock (`POST /api/sessions/{id}/model`).
8. **Runs API**: submit/status/events/stop/approval, concurrency cap,
   drain, orphan sweep; subagent lifecycle events.
9. **Jobs API**: CRUD + pause/resume/run via cron bridge.
10. **Multi-profile + proxy mode**: `/p/<profile>/` routing with per-profile
    keys; verify GATEWAY_PROXY_URL deployments against the desktop listener.
11. **Phase C swap** to in-process runtime; remove WS bridge; E2E.

## 9. Risks & open questions

- **Rust↔TS SSE bridge latency/backpressure (highest)**: token-per-frame over
  Tauri events may stall large streams; mitigation is the bounded channel +
  batched frames + Rust-side buffering (mirror Python's queue). Needs a
  perf spike (10k-token stream) before committing to the IPC design.
- **No OpenAI-compatible server precedent in kimi-code**: wire translators are
  greenfield; rely on Python golden fixtures for byte parity.
- **Tauri event ordering/overhead for high-frequency deltas**: consider
  compression or a Rust-side aggregator; open question whether `emit` per
  frame is acceptable.
- **Webview lifecycle**: if the webview is closed/minimized (hidden window),
  does the Rust listener keep serving? Decide: Rust keeps the bridge queue
  alive (preferred) vs pause API server when the window hides.
- **Auth key storage**: `API_SERVER_KEY` must be generated/persisted where the
  Rust listener can read it at boot (state.rs) without exposing it to the
  webview's JS bundle.
- **Concurrency cap parity**: Python counts agent work precisely; the TS side
  must define "active run" against the in-process runtime early to avoid 429
  drift.
- **Port 8642 conflicts** with a user's own Python gateway instance; port
  fallback must be visible in settings (like 9120/9545 handling).

## 10. Test strategy

- **Vitest unit** (per repo convention, `pnpm test:unit`): `sse.ts` frame
  bytes (parity with `_sse_frame`), `_normalize_chat_content` /
  `_normalize_multimodal_content` behavior (port `test_api_server_normalize.py`
  + `test_api_server_multimodal.py` cases), session-key validation,
  model-override precedence, route table vs frozen surface, zod schema
  rejection (mirror `invalid-input-matrix` style of klient tests).
- **Rust integration** (`tests/`, `wiremock::MockServer`, per AGENTS.md):
  hyper listener auth/bind guard/CORS/security headers/body limit; SSE
  transport framing; port conflict. Env-dependent tests `#[serial_test::serial]`.
- **Bridge tests**: TS side against a mocked `api-server-request` event bus;
  Rust side against a mock TS responder (no webview in `cargo test`).
- **Parity/integration** (vitest + fake agent runtime): replay Python golden
  fixtures for chat chunks, Responses events, runs SSE; run full endpoint
  matrix through the real Rust listener (test binary spawning the listener).
- **E2E (Playwright)**: real desktop → real Core backend (Phase A/B) with the
  local fake model — connect a headless OpenAI client (OpenAI SDK + curl) and
  assert tool progress SSE; reuse `e2e/` conventions from web-e2e.yml.
- **Explicit parity mapping**: `test_api_server.py` (chat/responses/auth/
  models), `test_api_server_jobs.py`, `test_api_server_runs.py`,
  `test_api_server_multimodal.py`, `test_api_server_active_work_drain.py`,
  `test_api_server_toolset.py`, `test_api_server_normalize.py`,
  `test_api_server_bind_guard.py`, `test_api_server_media_data_urls.py`,
  `test_api_server_multiplex_secret_scope.py`,
  `test_delegate_apiserver_background.py` — each Python file gets a TS
  counterpart file (or a table-driven fixture suite).

## 11. Reference links

- Python: `D:/hermes-agent-cn/gateway/platforms/api_server.py`,
  `D:/hermes-agent-cn/gateway/run.py` (lines 14438, 7676-7700),
  `D:/hermes-agent-cn/gateway/platforms/base.py`,
  `D:/hermes-agent-cn/gateway/config.py`,
  `D:/hermes-agent-cn/website/docs/user-guide/features/api-server.md`,
  `D:/hermes-agent-cn/tests/gateway/test_api_server*.py`,
  `D:/hermes-agent-cn/tests/tools/test_delegate_apiserver_background.py`.
- TS reference: `D:/kimi-code/packages/kap-server/` (`src/start.ts`,
  `src/middleware/auth.ts`, `src/middleware/origin.ts`, `src/routes/`,
  `src/protocol/envelope.ts`, `src/transport/ws/`, `package.json`),
  `D:/kimi-code/packages/protocol/src/events.ts`,
  `D:/kimi-code/packages/agent-core/src/rpc/` (`client.ts`, `core-api.ts`,
  `events.ts`), `D:/kimi-code/packages/kosong/src/providers/chat-completions-stream.ts`.
- Desktop: `D:/Hermes-CN-Desktop/src/commands/browser_companion.rs`,
  `src/commands/ws_proxy.rs`, `src/commands/api_proxy.rs`, `src/cron_runs.rs`,
  `src/state.rs`, `web/src/lib/transport.ts`, `web/src/lib/gateway-client.ts`,
  `web/src/stores/chat.ts`, `web/src/lib/provider-catalog.ts`,
  `packages/protocol/src/hermes-api.ts`, `tauri.conf.json` (CSP allows
  `http://127.0.0.1:*` and `ws://127.0.0.1:*`), `Cargo.toml` (hyper,
  hyper-util, tokio, rusqlite).
