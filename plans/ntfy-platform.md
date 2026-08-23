# ntfy Messaging Platform Adapter — Python → TypeScript Rewrite Plan

> Port decision recorded up front: **ntfy is a gateway-side messaging platform adapter and is
> marked "out of scope for desktop standalone"** (per `plans/README.md`). The desktop keeps
> talking to the Core managed-runtime gateway over REST (`/api/messaging/platforms`,
> `/api/env`) and WS (`/api/ws`) for v1 and does **not** host the ntfy client in-process.
> This file still designs the in-process TS port (Sections 3–10) so the decision is recorded
> and a future standalone build can pick it up. Feature scope: ntfy push notifications via
> pub/sub — HTTP streaming subscription (`/json?poll=false`) + HTTP POST publish, no SDK.

## 1. Summary

ntfy is a simple HTTP-based pub/sub push-notification service (`ntfy.sh` or self-hosted).
Hermes-CN-Core ships a **zero-dependency** platform plugin
(`plugins/platforms/ntfy/adapter.py`, 617 lines — only `httpx`, already a Hermes dependency)
that subscribes to a topic via HTTP streaming and publishes agent replies via HTTP POST.
Every ntfy topic is treated as one trusted channel: the topic name **is** the user identity
(ntfy has no native authenticated user primitive), `user_id = topic`, `chat_type = "dm"`.

The Desktop app today has **no ntfy UI**: it only maps `NTFY_*` env vars in
`web/src/lib/env-translations.ts` (lines 315–350, verified) and echoes
`status.gateway_platforms["ntfy"]` in the Settings debug card; the existing IM onboarding
(`web/src/routes/im-onboarding.tsx`) covers Feishu/Weixin (DingTalk enum exists in Rust
only). This plan records the port decision — **keep ntfy in the Python gateway for v1,
expose config/status in Desktop via REST; do not host ntfy in-process** — and gives the
design for an eventual in-process TypeScript port built on a **thin hand-rolled REST/SSE
client** (recommended; see Section 5), which **does not exist anywhere in
`D:/kimi-code`** (verified — repo-wide search for `ntfy` returns zero matches and
node_modules contains no ntfy package; Section 5 risk).

## 2. Current Python implementation

Source of truth: `D:/hermes-agent-cn`

| Path | Role |
|---|---|
| `plugins/platforms/ntfy/adapter.py` (617 lines) | `NtfyAdapter(BasePlatformAdapter)` + plugin entry (`register`), `_env_enablement`, `_standalone_send`, auth/truncate/dedup helpers |
| `plugins/platforms/ntfy/__init__.py` | Re-exports `register` |
| `plugins/platforms/ntfy/plugin.yaml` | Plugin metadata: requires `NTFY_TOPIC`; optional `NTFY_SERVER_URL`, `NTFY_TOKEN` (secret), `NTFY_PUBLISH_TOPIC`, `NTFY_MARKDOWN`, `NTFY_ALLOWED_USERS`, `NTFY_ALLOW_ALL_USERS`, `NTFY_HOME_CHANNEL[_NAME]` |
| `hermes_cli/web_server.py` | Registry-driven catalog: `GET /api/messaging/platforms` (L10256), `PUT /api/messaging/platforms/{id}` (L10351), `POST …/test` (L10422) — ntfy appears automatically via `_messaging_platform_catalog` |
| `website/docs/user-guide/messaging/ntfy.md` (157 lines) | Setup, identity model, cron, self-host, markdown, limits, troubleshooting |
| `tests/gateway/test_ntfy_plugin.py` (493 lines) | Parity source — 12 test sections |

Key implementation details (verified by reading `adapter.py`):

- **Constants** (L102–108): `DEFAULT_SERVER="https://ntfy.sh"`, `MAX_MESSAGE_LENGTH=4096`,
  `DEDUP_WINDOW_SECONDS=300`, `DEDUP_MAX_SIZE=1000`, `RECONNECT_BACKOFF=[2,5,10,30,60]`,
  `STREAM_TIMEOUT_SECONDS=90` (ntfy keepalive default 55s + margin), `_ECHO_TAG="hermes-agent"`.
- **Auth** (`_build_auth_header`, L111): token stripped of whitespace; `user:pass` →
  `Basic base64`, otherwise `Bearer <token>`; empty token → no header. Shared by adapter
  send and `_standalone_send`.
- **Inbound** (`connect` L210, `_run_stream` L229, `_consume_stream` L262): `httpx` streaming
  `GET {server}/{topic}/json?poll=false`; each non-empty line parsed with `orjson`; only
  `event == "message"` dispatched. **Fatal, non-retryable**: 401 → `ntfy_unauthorized`,
  404 → `ntfy_topic_not_found` (both halt the reconnect loop via `_FatalStreamError` and set
  gateway runtime status). Other errors → exponential backoff `[2,5,10,30,60]s`, reset to 0
  once a stream stays alive ≥60s.
- **Inbound filtering** (`_on_message` L332): dedup by `msg_id` (TTL 300s, cap 1000);
  skip own echo (`_ECHO_TAG` in `tags`); skip empty body; `user_id = user_name = topic`;
  `chat_id = chat_name = topic`; `timestamp` from `event.time` (UTC, fallback now).
- **Outbound** (`send` L405): `publish_topic = metadata.publish_topic || self._publish_topic
  || chat_id`; POST `{server}/{publish_topic}` with `Content-Type: text/plain; charset=utf-8`,
  `X-Tags: hermes-agent`, optional `X-Markdown: true`, body truncated to 4096 chars; 15s
  timeout; success = HTTP < 300 + `message_id` from JSON `id` or uuid hex[:12].
- **No-ops**: `send_typing` (ntfy has no typing indicator), `send_document`/media not used;
  `get_chat_info` returns `{"name": chat_id, "type": "dm"}`.
- **Plugin registration** (`register` L579): `env_enablement_fn=_env_enablement` (seeds
  `extra` + `home_channel` from env before adapter construction),
  `cron_deliver_env_var="NTFY_HOME_CHANNEL"`, `standalone_sender_fn=_standalone_send`
  (out-of-process cron delivery), `allowed_users_env="NTFY_ALLOWED_USERS"`,
  `allow_all_env="NTFY_ALLOW_ALL_USERS"`, `max_message_length=4096`, `emoji="🔔"`,
  `pii_safe=True`, `allow_update_command=True`, `platform_hint`.

Docs key behaviors (`website/docs/user-guide/messaging/ntfy.md`): identity model (topic =
identity, `title` must never be used for auth — L49–61), outgoing-only setup without
allowlist (L138–140), limits (4096 chars, no typing/threads/attachments — L142–147),
troubleshooting (401/404 halt reconnect loop, empty allowlist, 60s backoff — L149–157).

## 3. Target TypeScript design

**Port decision (recorded):** keep the adapter in the Python gateway for v1; the Desktop only
adds a config/status surface (Section 6). The in-process design below is the "if ported"
target, split into a **pure protocol/streaming core** (unit-testable, host-agnostic) and a
**transport host** (Rust Tauri or Node).

```
packages/messaging/ntfy/ (or web/src/lib/ntfy-adapter.ts if a shared package is deferred)
  adapter.ts        # NtfyAdapter implements PlatformAdapter from plans/messaging-gateway-core.md §3
  stream.ts         # fetch-based line stream over GET {server}/{topic}/json?poll=false
  publish.ts        # POST {server}/{publish_topic} with auth/echo/markdown headers + truncation
  auth.ts           # buildAuthHeader(token): {} | Bearer | Basic (whitespace-strip parity)
  dedup.ts          # bounded TTL map: msg_id -> timestamp (300s window, 1000 cap)
  state.ts          # connection state FSM + fatal error codes (ntfy_unauthorized / ntfy_topic_not_found)
```

Data flow (in-process):

1. `NtfyAdapter.connect()` reads config (server/topic/publish_topic/token/markdown) from the
   host secret/env store, then starts `stream.ts`.
2. `stream.ts` issues `fetch(url, { headers, signal })` with `poll=false`, reads
   `response.body.getReader()` + `TextDecoder` into a line buffer; each complete line is
   `JSON.parse`d; keepalive watchdog (90s) detects silent dead streams; 401/404 raise fatal
   terminal errors; other failures trigger `setTimeout` backoff `[2,5,10,30,60]s` (reset to 0
   after a stream lived ≥60s).
3. Each `event.type === "message"` passes `dedup.ts` (skip dup `id`), echo-tag check
   (`tags` contains `hermes-agent` — skip), empty-body skip, then becomes
   `MessageEvent { text, message_type: "text", source: { platform:"ntfy", chat_id: topic,
   chat_type:"dm", user_id: topic, user_name: topic }, message_id, raw_message, timestamp }`.
4. Agent reply streams back through `NtfyAdapter.send(chatId, content, { metadata })` →
   `publish.ts` POST with `publish_topic = metadata.publish_topic || config.publish_topic ||
   chatId`; body truncated to 4096 chars; headers `Content-Type`, `X-Tags: hermes-agent`,
   optional `X-Markdown`, `Authorization` from `auth.ts`.
5. In relay mode the same adapter can speak the relay `CapabilityDescriptor` contract instead
   of owning tokens (future; same shape as other platform plans).

Key interfaces (signatures only):

```ts
interface NtfyAdapterLike extends PlatformAdapter {
  connect(opts?: { isReconnect?: boolean }): Promise<boolean>;
  disconnect(): Promise<void>;
  send(chatId: string, content: string, opts?: { replyTo?: string; metadata?: { publish_topic?: string } }): Promise<SendResult>;
  onMessage(handler: (event: MessageEvent) => Promise<void>): void;
  // fatal error state surfaced to the host/UI:
  fatalErrorCode(): "ntfy_unauthorized" | "ntfy_topic_not_found" | null;
}
// stream.ts
interface NtfyStream {
  open(url: string, headers: Record<string, string>, opts: { keepaliveTimeoutMs: number; signal: AbortSignal }): Promise<AsyncIterable<Record<string, unknown>>>;
  // emits one parsed JSON event per line; throws FatalStreamError on 401/404
}
```

## 4. Data models & persistence

- **No durable message store.** ntfy is the source of truth; the adapter holds no
  messages/sessions of its own. Session identity continues to live in the Core gateway
  sessions (v1) or the in-process gateway-core session store (future).
- **In-memory state** (mirror of Python, all bounded):
  - `seenMessages: Map<string, number>` — msg_id → epoch-seconds; prune entries older than
    `DEDUP_WINDOW_SECONDS=300` once size exceeds `DEDUP_MAX_SIZE=1000`.
  - `connectionState: "disconnected" | "connecting" | "connected" | "fatal"` +
    `fatalErrorCode` (`ntfy_unauthorized` / `ntfy_topic_not_found`, non-retryable).
  - `backoffIndex`, `streamStartedAt` (backoff reset after 60s healthy stream).
- **Persistence = env config only.** Desktop writes `NTFY_*` into the profile `.env`
  (`~/.hermes/.env`) via Rust `write_env_patch` (same as Feishu/Weixin/DingTalk onboarding),
  with `NTFY_TOKEN` treated as a secret. `NTFY_HOME_CHANNEL` / `NTFY_HOME_CHANNEL_NAME` seed
  the gateway `HomeChannel` dataclass via `_env_enablement` (Python) — the TS config UI just
  writes the env keys; no schema/migration is introduced.
- **chat_id convention**: `chat_id = chat_name = user_id = user_name = topic` (dm).
  `home_channel` defaults to `NTFY_TOPIC` when `NTFY_HOME_CHANNEL` is unset (Python
  `_env_enablement` parity).

## 5. Third-party library strategy

Python dependency → TS equivalent:

| Python | TS equivalent | Evidence / decision |
|--------|---------------|---------------------|
| `httpx.AsyncClient.stream` (line-stream over `/json?poll=false`) | native `fetch` + `response.body.getReader()` + `TextDecoder` line buffer | Dependency-free; kimi-code precedent: `packages/agent-core/src/mcp/client-sse.ts` wraps the fetch-based `SSEClientTransport` from `@modelcontextprotocol/sdk@1.29.0` (present in `node_modules/.pnpm`; its deps `eventsource-parser@3.0.6` and `eventsource@3.0.7` are in `pnpm-lock.yaml` L5847/L11326) |
| `httpx` POST (publish) | native `fetch(url, { method:"POST", headers, body })` + `AbortController` 15s timeout | Same as above |
| `orjson.loads` | `JSON.parse` | Built-in |
| `pybase64.b64encode` | `btoa` (browser) / `Buffer.from(s).toString("base64")` (Node/Rust host) | Built-in |
| `asyncio` timers / reconnect backoff | `setTimeout` / `AbortController` (or tokio timers on the Rust host) | Built-in |
| `uuid.uuid4().hex[:12]` | `crypto.randomUUID()` (or Rust `Uuid`) | Built-in |
| (no external SDK) | **no npm ntfy SDK is proven in-repo** | See below |

**Verified absence in `D:/kimi-code`:** a repo-wide search for `ntfy` (case-insensitive)
returns **zero matches** in source, manifests, and lockfile; `node_modules` contains no
`*ntfy*` package (verified by glob). kimi-code therefore has **no ntfy client and no ntfy
precedent** — the only in-repo streaming precedent is the MCP SSE client
(`packages/agent-core/src/mcp/client-sse.ts`), whose underlying `eventsource-parser` /
`eventsource` packages are present but unexported transitives.

**Recommendation with rationale — thin REST/SSE client from scratch (primary):**
1. **Hand-rolled `packages/messaging/ntfy/`** — the Python feature is deliberately
   zero-dependency and proves the API surface is tiny: one GET streaming endpoint
   (`/json?poll=false`, newline-delimited JSON, keepalive events ignored) + one POST
   publish endpoint with three headers. A fetch-based line reader + `publish()` is ~150 LOC,
   fully unit-testable in vitest, and gives exact parity with the Python behavior (dedup,
   echo tag, backoff, fatal 401/404). This is the **recommended** option.
2. **`eventsource` npm package** (already in kimi-code's lockfile at 3.0.7 via MCP SDK) —
   only if we switch the subscribe endpoint to ntfy's `/sse` stream instead of `/json`.
   **Not recommended**: Python uses `/json`; `/sse` has a different wire format and the
   `eventsource` package would be a new direct dependency with no in-repo usage evidence.
3. **Community ntfy SDKs** (e.g. `ntfy-ts`, `ntfy-client`, `ntfy-rest`) — **unverified,
   absent from kimi-code**, and would be new unvetted dependencies for a two-endpoint
   protocol. Avoid unless a later requirement (e.g. attachments, JSON publish, WebSocket
   subscribe) justifies it.

**Transport host constraint:** a long-lived HTTP stream from the Tauri webview is fragile
(CSP, CORS to arbitrary self-hosted servers, webview background throttling). For the
in-process tier, host `stream.ts`/`publish.ts` behind Rust Tauri commands (`ntfy_connect`,
`ntfy_publish`, `ntfy_disconnect`, `ntfy_state` + `tauri::Emitter` events) using
`reqwest` streaming, or a Node host — same pattern as the IRC plan's §3 Tier 2. The TS
module stays pure (no I/O beyond injected `fetch`/`AbortSignal`) so vitest can inject mocks.

## 6. Integration with existing Hermes-CN-Desktop frontend

Reuse (verified by reading):

- `web/src/lib/env-translations.ts` — **already contains all `NTFY_*` translations**
  (L315–350: topic, server, token, publish topic, markdown, allowed topics, allow-all, home
  channel, home channel name). No change needed; used by
  `web/src/routes/settings-models-section.tsx` (L56).
- `web/src/routes/im-onboarding.tsx` — extend the wizard shell for a plain-form `NtfyRoute`
  (no QR flow): add `"ntfy"` to `ImSection` (L52) and `sectionFromPath` (L70); reuse
  `SectionShell`, `Field`, `ReviewTable`, `ApplyResult`, `MessagingTestGuide`,
  `DiagnosticAssistant` from the Feishu/Weixin routes; save via
  `useApplyImOnboarding("ntfy")` with `settings()` = `NTFY_*` patch.
- `web/src/hooks/use-im-onboarding.ts` — already platform-generic:
  `useImOnboardingState/useApplyImOnboarding` (L29/L51), `useMessagingPlatform` (L69, calls
  `GET /api/messaging/platforms`), `useTestMessagingPlatform` (L88, calls
  `POST /api/messaging/platforms/{id}/test`). Works once `ImPlatform` includes `"ntfy"`.
- `packages/protocol/src/channels.ts` — `ImPlatform` union (L491: `"feishu" | "weixin"`):
  extend with `"ntfy"`; onboarding input/result types already accept `platform: string`.
- `packages/protocol/src/hermes-api.ts` — `MessagingPlatformInfo` (L127),
  `MessagingPlatformsResponse` (L146), `MessagingPlatformTestResponse` (L153) are generic;
  ntfy flows through them unchanged.
- `web/src/lib/im-onboarding-diagnostics.ts` — add `ntfy: ["NTFY_TOPIC"]` to
  `DIAGNOSTIC_REQUIRED_KEYS` (L105); add `explainMessagingFailure` branches (L160) for:
  `401/unauthorized` → check `NTFY_TOKEN`; `404/topic not found` → check topic/server;
  `allowlist` empty → add `NTFY_ALLOWED_USERS`; network/keepalive → self-host/CORS check.
- `src/commands/im_onboarding.rs` — extend `ImPlatform` enum (L94) + `NTFY_ALLOWED_KEYS` /
  `NTFY_SECRET_KEYS` (`["NTFY_TOKEN"]`); reuse `write_env_patch` (L502),
  `validate_env_patch`, backup, and `restartGateway` flow (same as DingTalk pattern at
  L41–55).
- `web/src/components/app-shell/gateway-sidebar.tsx` — add ntfy entry to `IM_ITEMS` (L12),
  e.g. `{ label: "ntfy 接入", path: "/im/ntfy", icon: Bell }`.
- `web/src/routes/settings.tsx` — no new UI: `status.gateway_platforms` debug list
  (L1478–1488) already renders `ntfy` connection state.
- `src/commands/notify.rs` — **desktop OS notifications (system toast/attention)**; distinct
  layer from ntfy (a network pub/sub channel to the user's phone). Reuse direction only:
  an inbound ntfy message could call `desktop_notify` for local alerting, but the platform
  adapter itself stays gateway-side; do not conflate the two in the UI copy.

## 7. Removing the WebSocket dependency (migration path)

Today the desktop talks to the Python gateway via REST (`/api/status`,
`/api/messaging/platforms`, `/api/messaging/platforms/<id>/test` — see
`web/src/lib/transport.ts`, `web/src/hooks/use-im-onboarding.ts`) and the JSON-RPC WebSocket
(`web/src/lib/gateway-client.ts`, `ws://…/api/ws`) for live agent events.

Because ntfy is a messaging adapter, its traffic crosses the WS link twice in v1: inbound
ntfy topic → agent events → WS push to the UI; agent reply → WS → `send()` → POST to ntfy.
Removing the WS link means the ntfy client must run **inside** the desktop process.

Phased path (API surface to freeze during migration):

1. **Keep Python adapter; add config UI only.** No WS change. Freeze: platform id `"ntfy"`,
   `NTFY_*` env keys (plugin.yaml), `gateway_platforms.ntfy` in `/api/status`,
   `max_message_length=4096`, fatal error codes `ntfy_unauthorized` / `ntfy_topic_not_found`,
   echo tag `X-Tags: hermes-agent`.
2. **Extract pure TS core** (`auth.ts`, `dedup.ts`, `stream.ts` parsing, `publish.ts`
   header/truncation logic) with vitest parity tests vs `test_ntfy_plugin.py`. No runtime
   change.
3. **In-process transport** (Rust Tauri commands or Node host): `stream.ts` no longer needs
   the WS round trip; events go to the in-process agent loop instead of the Python gateway.
   Keep REST `/api/status` as connection-state source for the UI.
4. **Delete the WS messaging path** once the in-process runtime handles sessions/agent loop
   (per `plans/messaging-gateway-core.md`).
5. **Cron delivery parity** — Python `_standalone_send` (`deliver=ntfy` from `hermes cron`)
   must be re-implemented in-process (`ntfy-publish` one-shot with auth/echo/markdown
   headers + 4096 truncation) or deferred while the gateway exists.

WS-removal implications specific to ntfy: the adapter is **push-inbound via a long-lived
HTTP stream** (server keepalives every ~55s, 90s client watchdog) and **stateless outbound**
(single POST per reply). The webview alone cannot reliably hold the stream (CSP/CORS,
throttling), so the in-process host must provide the streaming loop — the main reason the
port decision is "gateway-side / host-side", not "webview-side".

## 8. Migration phases & task breakdown

| Phase | Task | Output / acceptance |
|-------|------|---------------------|
| 0 | Read-only parity baseline | Enumerate `tests/gateway/test_ntfy_plugin.py` cases (12 sections) as a TS test list |
| 1 | Config surface: `ImPlatform` + Rust `NTFY_ALLOWED_KEYS`/`NTFY_SECRET_KEYS` + `NtfyRoute` + sidebar item + diagnostics | `/im/ntfy` saves `NTFY_*` to `.env`, restarts gateway, shows state from `/api/messaging/platforms` |
| 2 | Pure TS core: `auth.ts`, `dedup.ts`, `stream.ts` parser, `publish.ts` | vitest parity green vs Python cases (auth shapes, whitespace strip, truncation, dedup TTL/cap, echo-tag skip, fatal 401/404, backoff reset) |
| 3 | Adapter lifecycle in TS (`connect/disconnect/send/onMessage`, state FSM) | Scripted mock-stream integration tests pass |
| 4 | Stream/publish transport: Rust Tauri commands or Node host | E2E against ntfy.sh test topic or a local mock server |
| 5 | In-process wiring: ntfy events → agent loop; retire WS messaging path | messaging works with gateway stopped |
| 6 | Cron one-shot delivery parity (`_standalone_send`) | `deliver=ntfy` equivalent works in-process |

## 9. Risks & open questions

- **No TS equivalent found in kimi-code (confirmed):** `ntfy` has zero matches in
  `D:/kimi-code` source, manifests, and lockfile; no ntfy npm package exists in
  node_modules. The mitigation is a hand-rolled ~150-LOC client mirroring the deliberately
  zero-dependency Python implementation; the only in-repo streaming precedent is the MCP SSE
  client (`packages/agent-core/src/mcp/client-sse.ts`) and its transitive
  `eventsource`/`eventsource-parser` deps. **Risk: low for the protocol, medium for adopting
  any community ntfy SDK without in-repo evidence** — avoid SDK adoption unless a future
  requirement (attachments/JSON publish/WebSocket) justifies it.
- **WebView cannot reliably hold long-lived HTTP streams.** The in-process tier must live in
  a Node-capable host or Rust (Tauri `reqwest` + `tauri::Emitter`). Open question: which
  host will the final in-process agent runtime use? Lock before Phase 4 (same as IRC plan §9).
- **`/json` NDJSON vs `/sse` parity**: Python subscribes to `/json?poll=false` and parses
  line-delimited JSON, ignoring keepalive events. If the TS port uses the `/sse` endpoint
  instead, `data:`-prefixed framing changes the parser — keep `/json` for exact parity.
- **Char-truncation parity**: Python truncates by `len(message)` code points; JS
  `string.length` counts UTF-16 units, so surrogate-pair messages (emoji/CJK rare chars)
  need a code-point-aware truncator + parity tests vs `_truncate_body`.
- **Identity/auth semantics must be repeated in UI copy**: topic name = user identity;
  `NTFY_TOKEN` is a secret (Bearer vs `user:pass` Basic); empty allowlist = one-way
  push-only mode (documented in Python docs L138–140). Fatal 401/404 halts reconnect — the
  UI should surface `gateway_platforms.ntfy.error_code` rather than a generic "disconnected".
- **`/api/messaging/platforms` ntfy exposure is registry-driven** (same pattern as IRC plan
  §9): verify in Phase 1 that the catalog lists `id="ntfy"` with `env_vars` from
  `plugin.yaml` (expected — `_messaging_platform_catalog` reads plugin metadata; ntfy is not
  a port-binding platform, so the multiplex port-binding conflict guard at web_server.py
  L10300 does not apply).

## 10. Test strategy

- **Vitest unit (pure TS core)** — parity with Python cases:
  - `auth.ts`: no token → `{}`; plain token → `Bearer`; `user:pass` → `Basic`; whitespace /
    trailing-newline strip; whitespace-only → `{}`.
  - `publish.ts`: URL selection (`metadata.publish_topic` > config > chat_id), echo header
    `X-Tags: hermes-agent`, `X-Markdown` toggle, 4096-char code-point truncation.
  - `dedup.ts`: first-seen not dup, second-seen dup, TTL 300s expiry, 1000-cap prune.
  - `stream.ts`: line framing from a `ReadableStream` fixture, keepalive lines ignored,
    non-message events ignored, empty-body skip, echo-tag skip, 401/404 → fatal errors.
  - `state.ts`: backoff sequence `[2,5,10,30,60]`, reset after ≥60s healthy stream,
    `fatalErrorCode` propagation.
- **Integration (mock server)**: local HTTP listener streaming NDJSON (`/json?poll=false`)
  + accepting POST; assert reconnect after mid-stream error and fatal halt on 401/404.
- **Parity tests vs Python**: map each of the 12 sections in
  `tests/gateway/test_ntfy_plugin.py` to a vitest describe block; green list is the Phase 0
  acceptance.
- **Playwright E2E (Tier 1 only)**: `/im/ntfy` saves `NTFY_TOPIC` + optional keys,
  restarts gateway, shows `ntfy` state in Settings debug card and diagnostics bundle
  (`buildImDiagnosticBundle` with `platform="ntfy"`).
- **Cron parity (Phase 6)**: one-shot publish produces same headers/truncation as Python
  `_standalone_send` (echo tag assertion from `test_standalone_send::test_emits_echo_tag_header`).

## 11. Reference links

- Python adapter: `D:/hermes-agent-cn/plugins/platforms/ntfy/adapter.py`
- Plugin metadata: `D:/hermes-agent-cn/plugins/platforms/ntfy/plugin.yaml`
- Docs: `D:/hermes-agent-cn/website/docs/user-guide/messaging/ntfy.md`
- Tests: `D:/hermes-agent-cn/tests/gateway/test_ntfy_plugin.py`
- Platform base contract: `D:/hermes-agent-cn/gateway/platforms/base.py`
- Gateway REST catalog: `D:/hermes-agent-cn/hermes_cli/web_server.py` L10256–10455
- Feature inventory: `D:/hermes-agent-cn/features_report.md` L135
- In-process gateway contract: `D:/Hermes-CN-Desktop/plans/messaging-gateway-core.md` §3
- Sibling out-of-scope adapter plans: `D:/Hermes-CN-Desktop/plans/telegram-platform.md`,
  `D:/Hermes-CN-Desktop/plans/irc-platform.md`
- Desktop IM onboarding: `D:/Hermes-CN-Desktop/web/src/routes/im-onboarding.tsx`,
  `D:/Hermes-CN-Desktop/web/src/hooks/use-im-onboarding.ts`,
  `D:/Hermes-CN-Desktop/web/src/lib/im-onboarding-diagnostics.ts`,
  `D:/Hermes-CN-Desktop/src/commands/im_onboarding.rs`
- Env labels (already present): `D:/Hermes-CN-Desktop/web/src/lib/env-translations.ts` L315–350
- Desktop notifications (separate layer): `D:/Hermes-CN-Desktop/src/commands/notify.rs`
- kimi-code SSE precedent: `D:/kimi-code/packages/agent-core/src/mcp/client-sse.ts`
  (deps `eventsource@3.0.7`, `eventsource-parser@3.0.6` in `pnpm-lock.yaml` via
  `@modelcontextprotocol/sdk@1.29.0`); `grep -ri ntfy D:/kimi-code` → 0 matches
