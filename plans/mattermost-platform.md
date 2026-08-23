# Mattermost Messaging Platform Adapter — Python → TypeScript Rewrite Plan

> Port decision recorded up front: **Mattermost is a gateway-side messaging platform adapter and is
> marked "out of scope for desktop standalone"** (per `plans/README.md`). The desktop keeps talking
> to the Core managed runtime gateway over REST (`/api/messaging/platforms`) and WS (`/api/ws`) and
> does **not** host the Mattermost bot in-process in v1. This file still designs the in-process TS
> port (Sections 3–10) so the decision is recorded and a future standalone build can pick it up.

## 1. Summary

Hermes-CN-Core ships a self-contained Mattermost bot adapter
(`D:/hermes-agent-cn/plugins/platforms/mattermost/adapter.py`, 1,327 lines) built **only on
`aiohttp`** — no external Mattermost library. It connects to a self-hosted/cloud Mattermost server
via the v4 REST API (`/api/v4/*`) and the WebSocket event stream (`/api/v4/websocket`,
`authentication_challenge`), with exponential-backoff reconnect (2 s → 60 s), thread-mode replies
(`root_id`), mention gating (`@bot` in channels), an `allowed_channels` whitelist, native file
uploads (up to 5 `file_ids` per post), media hydration (download + local cache), per-channel
prompts, an out-of-process cron "standalone sender", an interactive setup wizard, a YAML→env config
bridge, and a connectedness probe.

The Desktop currently has **no Mattermost-specific UI**: it only echoes
`status.gateway_platforms["mattermost"]` in the Settings debug card
(`web/src/routes/settings.tsx`) and lists Mattermost in Core's `/api/messaging/platforms` catalog
(`hermes_cli/web_server.py`). The existing IM onboarding flow (`/im/*`) is feishu/weixin **QR-code**
onboarding only and is not the right surface for a token/URL bot platform.

This plan records the port decision — **keep Mattermost in the Python gateway (managed runtime) for
v1; expose config/status in Desktop via REST; do not host Mattermost in-process**. It also gives the
full design for an eventual in-process TypeScript port built on the official `@mattermost/client`
(`Client4` + `WebSocketClient`), which **does not exist anywhere in `D:/kimi-code`** (verified —
see Section 5 risk).

## 2. Current Python implementation

Source of truth: `D:/hermes-agent-cn`

| Path | Role |
|---|---|
| `plugins/platforms/mattermost/adapter.py` (1,327 lines) | `MattermostAdapter(BasePlatformAdapter)` — everything (REST, WS, send, files, setup) |
| `plugins/platforms/mattermost/plugin.yaml` (49 lines) | plugin metadata; `requires_env`: `MATTERMOST_URL`, `MATTERMOST_TOKEN`; `optional_env`: `MATTERMOST_ALLOWED_USERS`, `MATTERMOST_ALLOW_ALL_USERS`, `MATTERMOST_HOME_CHANNEL`, `MATTERMOST_REPLY_MODE`, `MATTERMOST_REQUIRE_MENTION`, `MATTERMOST_FREE_RESPONSE_CHANNELS`, `MATTERMOST_ALLOWED_CHANNELS` |
| `plugins/platforms/mattermost/__init__.py` | re-exports `register` |
| `gateway/config.py` | `Platform.MATTERMOST = "mattermost"` (line 332, enum at 317); token env map (line 632); env enable block (2099–2113: token + URL required, `MATTERMOST_HOME_CHANNEL[_NAME]` → `HomeChannel`) |
| `gateway/run.py` | `_resolve_progress_thread_id` (line 846): for `{"slack","mattermost"}` the **event message id is the progress thread id**; display opt-in guard `require_platform_override_for={Platform.MATTERMOST}` (876, 18866–18881) — interim/thinking/scratch text must be enabled per-platform |
| `gateway/authz_mixin.py` | `MATTERMOST_ALLOWED_USERS` (524), `MATTERMOST_ALLOW_ALL_USERS` (551) — `_is_user_authorized` integration |
| `hermes_cli/web_server.py` | `/api/messaging/platforms` catalog entry `mattermost` (8592–8598): name, docs_url, `env_vars`, `required_env`; platform list (8819) |
| `tools/send_message_tool.py` | `_send_via_adapter` chokepoint (798) → uses adapter's `standalone_sender_fn` when gateway is not in-process (cron delivery) |
| `website/docs/user-guide/messaging/mattermost.md` (340 lines) | setup, home channel, reply mode, mention behavior, `allowed_channels`, per-channel prompts, troubleshooting (nginx WS upgrade), security |
| `tests/gateway/test_mattermost.py` (597 lines), `tests/gateway/test_mattermost_plugin_setup.py` (53 lines) | behavior + setup-wizard parity reference |

Key implementation blocks inside `adapter.py`:

- **Constants/config**: `MAX_POST_LENGTH = 4000` (line 61, `splits_long_messages = True`);
  `_CHANNEL_TYPE_MAP` (`D`→dm, `G`/`P`→group, `O`→channel); `_MATTERMOST_DISABLE_MENTIONS_PROPS`;
  reconnect params `2.0/60.0/0.2` (74–76); scoped-secret reader `_get_scoped_secret` (37) with
  default-profile env fallback.
- **HTTP helpers**: `_api_get/_api_post/_api_put` (159/177/259) with `..` path-traversal guard,
  `Authorization: Bearer <token>`, 30 s timeout, 400+ error capture (`_last_post_status`,
  `_last_post_error`); `_upload_file` (281) multipart `POST /api/v4/files` → `file_infos[0].id`.
- **Connect/disconnect** (310/344): `GET users/me` authenticates and caches `_bot_user_id` /
  `_bot_username`; starts `_ws_loop` task; disconnect cancels ws/reconnect tasks **before** closing
  the aiohttp session.
- **WebSocket** (734–809): `_ws_loop` reconnect loop (2 s→60 s exponential + jitter; **stops
  reconnecting on 401/403 handshake/permanent auth errors**); `_ws_connect_and_listen` swaps
  `http(s)`→`ws(s)` + `/api/v4/websocket`, heartbeat 30 s, sends `authentication_challenge` with the
  token, iterates TEXT/BINARY frames.
- **Event parsing** (811–1002): only `posted` events; double-encoded `data.post` JSON; ignores own
  posts and system posts (`post.type`); dedup via
  `gateway/platforms/helpers.py::MessageDeduplicator` (line 28, TTL-bounded); `allowed_channels`
  whitelist runs **before** other gating (DMs exempt); `require_mention` default true +
  `free_response_channels` override; strips `@username`/`@user_id` mention; thread handling
  (`post.root_id`, and in `thread` mode a top-level channel post becomes its own root); leading-space
  slash command → `MessageType.COMMAND`; downloads `file_ids` (info + bytes via auth header) and
  caches image/audio/document locally; `resolve_channel_prompt` per-channel prompt injection.
- **Outbound**: `send()` (384) truncates to 4000 and posts chunks with `disable_mentions` props +
  optional `root_id`; `_resolve_root_id` (368) walks a reply post to its thread **root**; broken-root
  fallback flat is **only** for `metadata.notify` posts (`_post_preserving_thread`, 231) — progress
  never falls back; `get_chat_info` (416); `send_typing` (430, `users/{id}/typing`); `edit_message`
  (439, `posts/{id}/patch`); `send_image`/`send_image_file`/`send_document`/`send_voice`/`send_video`
  (452–516) with SSRF-safe URL download (`tools.url_safety.is_safe_url`, 3-attempt retry);
  `send_multiple_images` (637) chunks at 5 `file_ids`/post and falls back to the base per-image loop.
- **format_message** (518): Mattermost renders Markdown; strips `![alt](url)` → plain URL.
- **Standalone send** (1012–1145): `_standalone_send` — pure REST post for out-of-process cron
  delivery (uploads media, posts with `thread_id`→`root_id`), proxy-aware
  (`MATTERMOST_PROXY`, `resolve_proxy_url`).
- **Setup/config bridge**: `interactive_setup` (1153, home-channel clear-on-blank); `_apply_yaml_config`
  (1222, `require_mention`/`free_response_channels`/`allowed_channels` YAML→env); `_is_connected`
  (1263, token+URL set); `register` (1289): `required_env`, `allowed_users_env`,
  `allow_all_env`, `cron_deliver_env_var`, `standalone_sender_fn`, `max_message_length=4000`,
  `allow_update_command=True`.

**Docs key behaviors** (`mattermost.md`): DMs respond without mention; channels require `@mention`
unless `MATTERMOST_REQUIRE_MENTION=false` / channel is in `MATTERMOST_FREE_RESPONSE_CHANNELS`; each
DM/thread/user-in-channel gets its own session (`group_sessions_per_user: true`); `allowed_channels`
is a hard whitelist (DMs exempt); `MATTERMOST_REPLY_MODE=thread` nests replies; home channel via
`/set-home` or `MATTERMOST_HOME_CHANNEL`; per-channel ephemeral prompts; no public URL needed
(outbound WS), Team Edition compatible.

## 3. Target TypeScript design

**Port decision (recorded):** keep the adapter in the Python gateway for v1; the Desktop only adds a
config/status surface (Section 6). The in-process design below is the "if ported" target.

Proposed module layout under `web/src/platforms/mattermost/` (or `packages/mattermost-adapter/`):

```
web/src/platforms/mattermost/
  adapter.ts        # MattermostAdapter — implements the gateway PlatformAdapter interface
  client.ts         # thin typed wrapper around @mattermost/client Client4 (REST v4)
  websocket.ts      # @mattermost/client WebSocketClient wrapper + reconnect/backoff + auth challenge
  events.ts         # inbound normalization: posted → MessageEvent{source:{platform:'mattermost',chat_id,chat_type,user_id,thread_id,message_id}}
  gating.ts         # require_mention / free_response_channels / allowed_channels / allowed_users
  format.ts         # format_message (image-markdown strip) + truncate_message(4000)
  files.ts          # file_ids upload/download, media caching, 5-per-post chunking
  dedup.ts          # MessageDeduplicator (TTL map)
  standalone-send.ts# out-of-process cron REST send (port of _standalone_send)
  diagnostics.ts    # mattermost-diagnostics.ts (see Section 6)
```

Data flow (in-process):

1. `MattermostAdapter.connect()` reads `MATTERMOST_URL`/`MATTERMOST_TOKEN` from the Tauri
   secret/env store, creates `Client4` (`setUrl`, `setToken`), `GET users/me` for bot identity.
2. `websocket.ts` dials `<ws(s)>://host/api/v4/websocket`, sends `authentication_challenge`, and
   registers a message listener; reconnect uses the same 2 s→60 s backoff and **stops on 401/403**.
3. `events.ts` filters `posted` events, decodes double-encoded `data.post`, drops own/system posts,
   dedups, runs `gating.ts`, strips mentions, resolves `thread_id`, classifies
   COMMAND/TEXT/PHOTO/VOICE/DOCUMENT (with MIME from file info), hydrates media, builds `MessageEvent`.
4. Agent reply streams back through `adapter.send()` (chunked 4000, `root_id` for thread mode,
   notify-only flat fallback), `editMessage()`, `sendTyping()`, `sendImage()`/`sendMultipleImages()`.
5. Cron/notification delivery uses `standalone-send.ts` (no live adapter) exactly like Python's
   `_standalone_send`.

Key interfaces (pseudocode):

```ts
interface PlatformAdapter {
  connect(opts?: { isReconnect?: boolean }): Promise<boolean>;
  disconnect(): Promise<void>;
  send(chatId: string, content: string, opts?: { replyTo?: string; metadata?: MsgMetadata }): Promise<SendResult>;
  editMessage(chatId: string, messageId: string, content: string, opts?: { finalize?: boolean }): Promise<SendResult>;
  sendTyping(chatId: string, metadata?: MsgMetadata): Promise<void>;
  sendImage(chatId: string, url: string, opts?: { caption?: string; replyTo?: string; metadata?: MsgMetadata }): Promise<SendResult>;
  sendMultipleImages(chatId: string, images: Array<[url, alt]>, opts?: { metadata?: MsgMetadata; humanDelay?: number }): Promise<void>;
  onMessage(handler: (event: MessageEvent) => Promise<ProcessingOutcome>): void;
  getChatInfo(chatId: string): Promise<{ name: string; type: ChatType }>;
}
```

## 4. Data models & persistence

- **No durable message store needed**: Mattermost is the source of truth (`POST /posts`,
  `GET /posts/{id}` for thread-root resolution). Persistence strategy: **none for messages**;
  session identity/home channels already live in Core's gateway sessions and stay there in v1.
- **In-memory state** (bounded, mirroring Python):
  - bot identity (`bot_user_id`, `bot_username`);
  - `MessageDeduplicator` TTL cache (reconnect redelivery), `last_post_status`/`last_post_error`
    (broken-thread detection), `reply_mode` flag;
  - optional small caches: channel name/type (`get_chat_info`), media cache dir paths.
- **Persisted credentials**: `MATTERMOST_URL`, `MATTERMOST_TOKEN`, `MATTERMOST_ALLOWED_USERS`,
  `MATTERMOST_HOME_CHANNEL`, `MATTERMOST_REPLY_MODE`, `MATTERMOST_REQUIRE_MENTION`,
  `MATTERMOST_FREE_RESPONSE_CHANNELS`, `MATTERMOST_ALLOWED_CHANNELS` — all in the managed runtime
  env/secret store today; if in-process later, Tauri keychain / `~/.hermes/.env` via existing
  `web/src/lib/runtime.ts` + transport patterns. No DB migration needed.
- **Config contract**: plugin.yaml `requires_env`/`optional_env` + `mattermost:` YAML block
  (`allowed_channels`, `channel_prompts`, `require_mention`, `free_response_channels` via
  `_apply_yaml_config`). A Zod schema (like `packages/protocol/src/hermes-api.ts`) should freeze this
  if a Desktop settings form is built.

## 5. Third-party library strategy

**Verified: no TS equivalent exists in `D:/kimi-code`.** A repo-wide scan for `mattermost`
(recursive `os.walk` over source **and** `node_modules`, plus every `package.json` dependency) found
**0 hits** — no adapter, no fixture, no dependency. So any TS port must add the official
`@mattermost/client` (npm, maintained by Mattermost, used by the Mattermost web app) as a **new
dependency**; it provides `Client4` (REST v4) and `WebSocketClient` (`initialize(url, token)`,
`addMessageListener`, expects `globalThis.WebSocket` — in Node set it from `ws`, which kimi-code
already uses).

| Python dependency | TS equivalent | kimi-code evidence |
|---|---|---|
| `aiohttp` (HTTP client) | `@mattermost/client` `Client4` (**recommended**, official, typed, covers posts/files/channels/users REST) — fallback: native `fetch` shim | **none** for Mattermost; generic `fetch` used everywhere |
| `aiohttp` (WebSocket client) | `@mattermost/client` `WebSocketClient` (recommended) or browser `WebSocket` / `ws` `^8.18.0` | `ws` `^8.18.0` + `@types/ws` in `packages/kap-server` and `packages/klient` (`package.json`); WS transport: `packages/kap-server/src/transport/ws/v1/registerWsV1.ts` |
| `orjson` | `JSON.parse` / `JSON.stringify` | n/a (standard JSON throughout kimi-code) |
| stdlib `re` | JS `RegExp` (mention strip, image-markdown strip, scheme swap) | `apps/kimi-code/src/utils/*` uses regex utilities |
| `pathlib.Path` / stdlib `mimetypes` | `node:path` + small mime map / `mime-types` | n/a |
| `asyncio` tasks + exponential backoff | async/await + `setTimeout` loops; WS reconnect pattern | `packages/kap-server` WS transport; retry/backoff patterns in `packages/klient` e2e harness and `packages/agent-core-v2` (5xx backoff retries) |
| `gateway/platforms/helpers.py::MessageDeduplicator` | small TTL `Map` LRU (port directly) | n/a |
| `tools.url_safety.is_safe_url` (SSRF) | port as `isSafeUrl` (URL allow/deny + private-IP check) before any download | kimi-code has no SSRF fetch shim — new utility |

Rationale for recommending `@mattermost/client` even though kimi-code has no equivalent: it is the
**official, maintained** Mattermost TS client used by the Mattermost web app; `Client4` maps 1:1 to
the v4 REST endpoints the Python adapter calls (`users/me`, `posts`, `posts/{id}/patch`, `files`,
`channels/{id}`, `users/{id}/typing`) and `WebSocketClient` already implements the
`authentication_challenge` handshake + message listeners, removing the riskiest hand-rolled code.
Costs: it is a heavier dependency and expects `globalThis.WebSocket` in Node (a 2-line `ws` shim —
the same library kimi-code already depends on). If bundle size becomes a concern, the fallback is a
~300-line thin shim over `fetch` + `ws` (or browser `WebSocket`), but that duplicates the v4 API
surface and re-implements the WS handshake; not recommended.

## 6. Integration with existing Hermes-CN-Desktop frontend

- **Existing to reuse (v1, recommended path)**:
  - `web/src/routes/settings.tsx` (1,993 lines) — already renders
    `status.gateway_platforms` state/error generically in the "Dashboard / Gateway" DebugCard
    (lines 1478–1488); a Mattermost row would appear there for free once the gateway is enabled.
  - `web/src/hooks/use-im-onboarding.ts` — `useMessagingPlatform` (GET `/api/messaging/platforms`
    → find by id) and `useTestMessagingPlatform` (POST `/api/messaging/platforms/{id}/test`) are
    generic; `MessagingPlatformInfo`/`MessagingPlatformTestResponse` +
    `StatusResponse.gateway_platforms` (`packages/protocol/src/hermes-api.ts`, line 47) already
    model a `mattermost` platform.
  - `web/src/lib/im-onboarding-diagnostics.ts` (450 lines) — the `ImDiagnosticBundle` builder is a
    template for `mattermost-diagnostics.ts`: required keys `MATTERMOST_URL`/`MATTERMOST_TOKEN`,
    policy keys `MATTERMOST_ALLOWED_USERS`/`MATTERMOST_ALLOWED_CHANNELS`/
    `MATTERMOST_HOME_CHANNEL`/`MATTERMOST_REQUIRE_MENTION`/`MATTERMOST_REPLY_MODE`, gateway platform
    state, test result, issues list.
  - `web/src/lib/transport.ts` — all REST calls go through it (auth injection); never raw fetch.
  - `web/src/lib/gateway-client.ts` / `use-gateway.ts` — live gateway platform state updates.
- **Do NOT extend `web/src/routes/im-onboarding.tsx` / `packages/protocol/src/channels.ts`**:
  `ImPlatform = "feishu" | "weixin"` (channels.ts line 491) and the `/im/*` route are QR-code
  onboarding flows; Mattermost is a token/URL bot platform and gets a separate settings surface
  (e.g. `/settings/platforms/mattermost`), leaving `gateway-sidebar.tsx` ("飞书接入"/"微信接入")
  untouched.
- **Port decision + WS-removal implications** (recorded):
  - Messaging adapters are **gateway-side**; the Desktop's managed runtime already runs the Core
    gateway. Enabling Mattermost = `PUT /api/messaging/platforms/mattermost {enabled:true,
    env_vars}` and reading status — no change to `EXPECTED_BACKEND_VERSION`, no new port, no change
    to the Desktop↔Python WS link.
  - Removing the Python/WS link (the repo's end-state goal) targets the **agent session transport**
    (`/api/ws`), **not** the Mattermost adapter's own **outbound** WebSocket to the MM server. The
    adapter keeps its outbound WS regardless; what changes is *where* the gateway process lives.
  - If the Desktop ever becomes fully standalone (no managed Python runtime), the Mattermost bot
    must run in-process (Section 3): the Tauri webview needs outbound WS to the MM server — a
    browser `WebSocket` in the webview generally works, but if the webview blocks it (macOS
    WKWebView quirks already seen for `ws://127.0.0.1`), route it through a Rust Tauri command or
    `@tauri-apps/plugin-websocket`; secrets move from `.env` to OS keychain; the `allowed_users`
    authz gate must be re-implemented in-process.

## 7. Removing the WebSocket dependency (migration path)

API surface to freeze during any migration (these must keep working whether Mattermost lives in the
Python gateway or in-process):

1. `GET /api/messaging/platforms` + `PUT /api/messaging/platforms/mattermost` + `POST
   /api/messaging/platforms/mattermost/test` (Core `hermes_cli/web_server.py` catalog entry 8592).
2. `StatusResponse.gateway_platforms["mattermost"]` shape (`state`, `error_message`, …) in
   `packages/protocol/src/hermes-api.ts`.
3. `MATTERMOST_*` env var names + `plugin.yaml` requires_env — the config contract.
4. Adapter interface: `connect/disconnect/send/edit_message/send_typing/send_image/
   send_multiple_images/get_chat_info` + `standalone_sender_fn` (cron) + `is_connected` +
   `apply_yaml_config_fn` (YAML→env).
5. Gateway-side routing rules: `_resolve_progress_thread_id` (event message id = progress thread id
   for slack/mattermost) and the per-platform display opt-in
   (`require_platform_override_for={Platform.MATTERMOST}`).

Phases:

- **Phase A (v1, recommended): Python gateway owns Mattermost; Desktop adds UI only.** Add
  `settings/platforms/mattermost` route reusing `useMessagingPlatform`/`useTestMessagingPlatform` +
  `mattermost-diagnostics.ts`; write env via existing REST PUT; test button via POST test. Zero WS
  changes; the adapter's own outbound WS stays in the gateway process.
- **Phase B (optional): in-process `PlatformAdapter` behind the same interface.** Extract the
  interface in Section 3, run `MattermostAdapter` inside the webview (or a Rust-side socket
  transport), bridge inbound events through the existing `gateway-client` message pipeline. Delete
  path: keep the Python adapter as fallback; flip per-profile flag.
- **Phase C (only if desktop fully standalone): delete the Python WS/REST path** for Mattermost
  config (keep `/api/ws` for agent sessions as long as the Python agent exists). The frozen surface
  above is what the TS implementation must satisfy so the swap is invisible to the UI.

## 8. Migration phases & task breakdown

| Phase | Tasks | Est. |
|---|---|---|
| A1 | New `/settings/platforms/mattermost` route (reuse `useMessagingPlatform`); env editor for `MATTERMOST_URL`/`MATTERMOST_TOKEN`/`MATTERMOST_ALLOWED_USERS`; enable toggle → PUT; test button → POST test | S |
| A2 | `web/src/lib/mattermost-diagnostics.ts` modeled on `im-onboarding-diagnostics.ts`; show `gateway_platforms.mattermost` state/error; link to Core `messaging/mattermost.md` | S |
| A3 | (Optional, no-port fallback) In-process **outbound-only** REST sender for desktop cron/alerts (port of `_standalone_send`; does NOT receive events, no WS) — smallest useful TS Mattermost surface | M |
| B1 | Port `format.ts` + `dedup.ts` (pure functions) + parity tests | S |
| B2 | Port `events.ts` + `gating.ts` (posted parsing, mention rules, allowed_channels, COMMAND detection) | M |
| B3 | Port `client.ts` + `websocket.ts` (`@mattermost/client` wrappers, auth challenge, 2s→60s backoff, 401/403 stop) | M |
| B4 | Port `files.ts` (upload/download/cache, 5-per-post chunks, SSRF `isSafeUrl`) + `adapter.ts` + `standalone-send.ts` | L |

(S=small ≤3d, M=medium ≤1w, L=large >1w. A1–A2 are the actual v1 work; B* is the recorded port
backlog.)

## 9. Risks & open questions

- **No TS equivalent found in kimi-code (HIGH).** `@mattermost/client` is absent from the reference
  monorepo (0 hits incl. `node_modules`), so there is no in-repo precedent for Mattermost REST/WS
  usage, the `authentication_challenge` handshake, or `posted` event quirks. The port relies on
  official SDK docs + a new dependency; npm install + license/version checks land on Desktop's pnpm
  workspace. WebSearch confirmed the package is official and current (npm `@mattermost/client`,
  used by the Mattermost web app).
- **`WebSocketClient` runtime requirement (MEDIUM).** `@mattermost/client`'s `WebSocketClient`
  expects `globalThis.WebSocket` (browser); in Node/Electron-like runtimes you must shim it from
  `ws` — the same package kimi-code already depends on (`ws` ^8.18.0 in kap-server/klient). A Tauri
  webview (WKWebView on macOS) may also need the Rust WS-relay path already proven for
  `ws://127.0.0.1` — but note that is a *different* WS connection (Mattermost server, remote origin)
  and will need a dedicated Rust command or `@tauri-apps/plugin-websocket`.
- **WS reconnect parity (MEDIUM).** Python hand-rolls auth challenge + 2s→60s backoff + "stop on
  401/403" (`_ws_loop`, 738). `@mattermost/client`'s `WebSocketClient` manages its own connection
  lifecycle; verify it exposes close/reconnect hooks so the permanent-auth-failure stop rule and
  backoff can be reproduced (otherwise wrap it with the Python-style loop).
- **Thread/CRT semantics (MEDIUM).** `root_id` must point at the thread **root** (`_resolve_root_id`);
  broken-root fallback-flat applies **only** to `metadata.notify` posts; progress/status must stay
  quiet (`test_progress_send_*`). These subtle rules need exact parity tests before a port.
- **TypeScript peer range (LOW today).** `@mattermost/client` declares peer `typescript` `^4.3 ||
  ^5.0` (upstream issue mattermost/mattermost#37128); Desktop `web/` + `packages/protocol` use
  `^5.9.3`, so compatible now — re-check before a future TS 6 upgrade.
- **Bundle weight (LOW-MEDIUM).** Official client is heavier than a custom `fetch`+`ws` shim; if the
  desktop ever hosts this in-process, measure impact — the fallback shim (~300 LOC) is documented
  but not recommended.
- **Open questions:** should the Desktop expose per-channel prompts (`channel_prompts`) and
  `allowed_channels` in the settings form, or only required env? Where do `MATTERMOST_*` tokens live
  in an in-process build (OS keychain vs `.env`)? Is `MATTERMOST_ALLOW_ALL_USERS` (dev-only) needed
  in desktop UI? Does Desktop need its own Mattermost setup wizard (port of `interactive_setup`),
  or is a docs link + env editor enough? Keep `EXPECTED_BACKEND_VERSION` in sync when Core changes
  Mattermost endpoints?

## 10. Test strategy

Parity tests (vitest) mirroring the Python suites in
`D:/hermes-agent-cn/tests/gateway/test_mattermost*.py`:

- `format.test.ts` ↔ `TestMattermostFormatMessage`: `![alt](url)` → plain URL; regular Markdown
  preserved. `truncate.test.ts` ↔ `TestMattermostTruncateMessage`: 5000-char message splits into
  ≤4000-char chunks.
- `client.test.ts` ↔ `TestMattermostSend`: mock `Client4`; POST `/api/v4/posts` payload
  `{channel_id, message}`; thread mode sets `root_id` from `_resolve_root_id`; broken thread root →
  flat fallback **only** when `metadata.notify` (with "Mattermost thread delivery failed" prefix);
  progress sends stay quiet on failure.
- `events.test.ts` ↔ `TestMattermostWebSocketParsing`: double-encoded `data.post` JSON parsed;
  own/system posts ignored; leading-space slash command → `MessageType.COMMAND` (`/new`).
- `gating.test.ts` ↔ `TestMattermostMentionBehavior`: default require_mention skips unmentioned
  channel posts; `MATTERMOST_FREE_RESPONSE_CHANNELS` responds without mention; `allowed_channels`
  whitelist drops non-listed channels (DMs exempt).
- `thread-root.test.ts` ↔ `test_mattermost_top_level_channel_post_is_thread_root` + progress routing
  (`TestMattermostProgressThreadRouting`): top-level channel post in thread mode becomes its own
  `thread_id`/`message_id`; `event_message_id` is the progress thread id.
- `media-types.test.ts` ↔ `TestMattermostMediaTypes`: attachment MIME propagated as full MIME
  (`image/png`, not `image`); `dedup.test.ts` ↔ `TestMattermostDedup`: TTL pruning.
- `display-gating.test.ts` ↔ `TestMattermostDisplayHygiene`: per-platform opt-in for
  interim/thinking/scratch text does not leak to other platforms.
- `setup.test.ts` ↔ `test_mattermost_plugin_setup.py`: if the interactive setup is ported, blank
  home channel removes `MATTERMOST_HOME_CHANNEL` (clear-on-blank).
- `settings.e2e.ts` (Playwright): Mattermost row renders from mocked
  `status.gateway_platforms.mattermost`; diagnostics bundle lists required keys; test button shows
  gateway state.
- CI: `pnpm typecheck` + `pnpm test:unit` per repo conventions; no network in unit tests (all
  `@mattermost/client` calls mocked).

## 11. Reference links

- Core source: `D:/hermes-agent-cn/plugins/platforms/mattermost/{adapter.py,__init__.py,plugin.yaml}`;
  `gateway/config.py` (332/632/2099–2113); `gateway/run.py` (846, 18866); `gateway/authz_mixin.py`
  (524/551); `gateway/platforms/helpers.py` (MessageDeduplicator, 28); `hermes_cli/web_server.py`
  (8592 catalog); `tools/send_message_tool.py` (`_send_via_adapter`, 798)
- Core docs: `D:/hermes-agent-cn/website/docs/user-guide/messaging/mattermost.md`;
  `website/docs/reference/environment-variables.md`; `website/docs/developer-guide/gateway-internals.md`
- Core tests: `D:/hermes-agent-cn/tests/gateway/test_mattermost.py`,
  `tests/gateway/test_mattermost_plugin_setup.py`
- Desktop: `web/src/routes/settings.tsx` (1478–1488), `web/src/routes/im-onboarding.tsx`,
  `web/src/lib/im-onboarding-diagnostics.ts`, `web/src/hooks/use-im-onboarding.ts`,
  `web/src/lib/transport.ts`, `web/src/lib/gateway-client.ts`,
  `packages/protocol/src/hermes-api.ts`, `packages/protocol/src/channels.ts` (491)
- TS SDK (new dep, not in kimi-code): https://www.npmjs.com/package/@mattermost/client
  (official `Client4` + `WebSocketClient`; TS peer `^4.3 || ^5`, issue #37128 for TS6)
- kimi-code WS evidence: `packages/kap-server/package.json`, `packages/klient/package.json`
  (`ws` ^8.18.0), `packages/kap-server/src/transport/ws/v1/registerWsV1.ts`
- Mattermost API: https://api.mattermost.com/ (v4 REST + WebSocket events,
  `/api/v4/websocket` authentication challenge)
