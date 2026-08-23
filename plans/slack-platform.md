# Slack Messaging Platform Adapter — Python → TypeScript Rewrite Plan

> Port decision recorded up front: **Slack is a gateway-side messaging platform adapter and is
> marked "out of scope for desktop standalone"** (per `plans/README.md`). The desktop keeps talking
> to the Core managed runtime gateway over REST (`/api/messaging/platforms`) and WS (`/api/ws`) and
> does **not** host the Slack bot in-process in v1. This file still designs the in-process TS port
> (Section 3–10) so the decision is recorded and a future standalone build can pick it up.

## 1. Summary

Hermes-CN-Core ships a full Slack bot adapter (`plugins/platforms/slack/`, ~9.8k LOC) built on the
Python `slack-bolt` SDK in **Socket Mode** (WebSocket outbound, no public URL), with Block Kit
rendering, thread mention-gating, SSRF-hardened file downloads, a self-healing Socket Mode
watchdog, and edit-based DM streaming parity in the relay lane. The Desktop app currently has **no**
Slack UI: it only echoes `status.gateway_platforms["slack"]` in the Settings debug card and lists
Slack in Core's `/api/messaging/platforms` catalog (required env `SLACK_BOT_TOKEN` +
`SLACK_APP_TOKEN`).

This plan records the port decision — **keep Slack in the Python gateway (managed runtime) for v1,
expose config/status in Desktop via REST; do not host Slack in-process**. It also gives the full
design for an eventual in-process TypeScript port built on the official `@slack/bolt` +
`@slack/socket-mode` + `@slack/web-api` SDKs, which **do not exist anywhere in `D:/kimi-code`**
(verified — see Section 5 risk).

## 2. Current Python implementation

Source of truth: `D:/hermes-agent-cn`

| Path | Role |
|---|---|
| `plugins/platforms/slack/adapter.py` (9,110 lines) | `SlackAdapter(BasePlatformAdapter)` — everything |
| `plugins/platforms/slack/block_kit.py` (687 lines) | markdown → Block Kit renderer + sanitizer (pure) |
| `plugins/platforms/slack/plugin.yaml` | plugin metadata; requires `SLACK_BOT_TOKEN`+`SLACK_APP_TOKEN`; optional `SLACK_ALLOWED_USERS`, `SLACK_ALLOW_ALL_USERS`, `SLACK_HOME_CHANNEL[_NAME]`, `SLACK_THREAD_REQUIRE_MENTION` |
| `plugins/platforms/slack/__init__.py` | `register` re-export |
| `gateway/config.py` (line 317) | `Platform.SLACK = "slack"` |
| `hermes_cli/web_server.py` (line 8585) | `/api/messaging/platforms` catalog entry for slack: name, docs_url, `env_vars`, `required_env`; PUT enable + POST test endpoints at lines 10351/10422; `_multiplex_port_binding_conflict` (10301) |
| `website/docs/user-guide/messaging/slack.md` (977 lines) | setup, scopes, events, slash commands, config options |

Key implementation blocks inside `adapter.py`:

- **Socket Mode lifecycle**: `_start_socket_mode_handler()` (1184) wraps `AsyncSocketModeHandler`;
  `_stop_socket_mode_handler()` (1199) cancels the handler task + the SDK client's background tasks
  **before** `close_async()` closes the shared aiohttp session (pins slackapi/python-slack-sdk#1913 —
  `connect()` is an unconditional retry loop that never checks `closed`); `_restart_socket_mode()`
  (1288) guarded by `_socket_reconnect_lock`; `_socket_watchdog_loop()` (1307) every 15 s checks
  task health, `is_connected()`, and **ping/pong staleness** (`_socket_ping_pong_stale`, 1257:
  `last_ping_pong_time` older than `ping_interval * 4`, with a 60 s first-ping grace).
- **Connect / multi-workspace** (1765): comma-separated `SLACK_BOT_TOKEN`s + `slack_tokens.json`
  OAuth token file; `auth_test()` per token; `_team_clients[team_id] → AsyncWebClient`;
  `_resolve_download_token()` (8073) routes file downloads to the owning workspace client
  (explicit team_id → URL-embedded `/files-pri/<TEAM>-…` → primary token).
- **Message pipeline**: `_handle_slack_message()` (5249) with `MessageDeduplicator` 300 s TTL
  (reconnect redelivery), mention-gating checks, block/attachment text extraction
  (`_extract_text_from_slack_blocks`, `_serialize_slack_blocks_for_agent`), thread-context fetch,
  watermark/rehydration for restart gaps.
- **Thread mention gating** (8254–8430): `_slack_require_mention` (default true, explicit-false
  parse), `_slack_strict_mention`, `_slack_ignore_other_user_mentions`, `_slack_thread_require_mention`
  (default false; gating scope = thread replies only), `_slack_free_response_channels`,
  `_slack_disable_dms`, `_slack_allowed_channels`, `_slack_require_mention_channels`,
  `_slack_mention_patterns`, `_slack_message_addressed_to_other_user`, `_slack_message_mentions_self`;
  auto-triggers (mentioned-thread memory, bot-message follow-up, active session) in
  `_should_wake_on_unmentioned_message` (5174).
- **Outbound**: `send()` (2450) with reply_to_mode/reply_in_thread/reply_broadcast,
  `send_or_update_status()` (2678), `edit_message()` (2721), `delete_message()` (2832),
  `send_typing()`/`stop_typing()` (assistant.threads.setStatus, 2957), `send_private_notice()`
  (ephemeral), reactions (3722), approval/clarify buttons (`send_exec_approval` 6369,
  `send_clarify` 6556), `send_slash_ephemeral` (1533) with 5-post cap and no public fallback.
- **Block Kit** (`block_kit.py`): `render_blocks()` (367) — headers, dividers, `rich_text` nested
  lists, native `table` blocks (limits 100 rows/20 cols/10k chars, monospace fallback),
  `sanitize_blocks()` (590) — last-resort clamp to 50 blocks / 3000-char sections / 150-char
  headers; `_split_text()` fence-balanced chunking. `format_message()` (3561) is the mrkdwn path
  (links, headers, bold, code fences, CJK-width table alignment via `_align_table`).
- **Download SSRF hardening** (`_download_slack_file` 8098 / `_download_slack_file_bytes` 8183):
  `is_safe_url()` preflight (CWE-918) **+** `_is_slack_cdn_url()` allowlist (forged-file token
  exfiltration) **+** `create_ssrf_safe_async_client()` with `_ssrf_redirect_guard` per-redirect
  hook **+** DNS-pinned connect (closes rebinding TOCTOU) **+** HTML-content-type rejection **+
  3-attempt retry**. Outbound `send_image()` (4078) uses the same guard.
- **Relay / DM streaming**: `gateway/relay/` (`adapter.py`, `descriptor.py`, `transport.py`,
  `ws_transport.py`) — `CapabilityDescriptor(platform="slack", supports_edit=True,
  supports_threads=True, markdown_dialect="mrkdwn", max_message_length=4000, len_unit="chars")`;
  `RelayAdapter.send` + `GatewayStreamConsumer` disambiguate the synthetic DM thread anchor so
  edit-based streaming works in DMs (`reply_to` dropped in flat mode, kept in thread-per-message).
- **Setup**: `interactive_setup`/`_write_slack_manifest_and_instruct` (8867) — `hermes slack
  manifest` generator (slash commands from `COMMAND_REGISTRY`, `--agent-view`); `_apply_yaml_config`
  (8986) bridges `platforms.slack.*` YAML into env.

**Docs key behaviors** (`website/docs/user-guide/messaging/slack.md`): DMs respond without mention;
channels require `@mention`; once active in a thread the bot follows without mention; group DMs
(MPIM) are shared surfaces obeying channel gating; slash replies are ephemeral; `!cmd` prefix works
in threads; config keys: `reply_to_mode`, `reply_in_thread`, `reply_broadcast`, `rich_blocks`,
`feedback_buttons`, `suggested_prompts`, `assistant_thread_titles`, `allow_bots`,
`cron_continuable_surface`, `typing_status_text`, `live_status`, `group_sessions_per_user`,
`require_mention` / `strict_mention` / `ignore_other_user_mentions` / `thread_require_mention` /
`require_mention_channels` / `mention_patterns` / `reply_prefix`.

## 3. Target TypeScript design

**Port decision (recorded):** keep the adapter in the Python gateway for v1; the Desktop only adds a
config/status surface (Section 6). The in-process design below is the "if ported" target.

Proposed module layout under `web/src/platforms/slack/` (or `packages/slack-adapter/` for reuse):

```
web/src/platforms/slack/
  adapter.ts        # SlackAdapter — implements the gateway PlatformAdapter interface
  transport.ts      # SocketModeTransport — @slack/socket-mode wrapper + watchdog/reconnect
  web-client.ts     # thin typed wrapper around @slack/web-api (auth, chat, files, assistant, reactions)
  events.ts         # inbound normalization: event → MessageEvent{source:{platform:'slack',chat_id,chat_type,user_id,scope_id,thread_id}}
  mention-gating.ts # require/strict/thread/ignore-other/free-response/allowed/patterns + wake checks
  mrkdwn.ts         # markdown → mrkdwn (port of format_message)
  block-kit.ts      # markdown → Block Kit render + sanitize (port of block_kit.py)
  download.ts       # SSRF-hardened file download (is-safe-url + CDN allowlist + redirect guard)
  manifest.ts       # Slack app manifest generator (port of hermes slack manifest)
  dedup.ts          # MessageDeduplicator (TTL map) + bounded LRU caches
  relay-connector.ts# CapabilityDescriptor + DM-streaming reply_to disambiguation
  state.ts          # in-memory caches: team clients, name caches, dm cache, mentioned_threads, etc.
```

Data flow (in-process):

1. `SlackAdapter.connect()` reads tokens from the Tauri secret/env store, creates
   `@slack/web-api` WebClient per workspace token, `auth_test()` each, registers listeners.
2. `SocketModeTransport` dials `@slack/socket-mode` `SocketModeClient`; a watchdog interval checks
   task liveness + ping/pong staleness; teardown cancels socket tasks before `disconnect()` (parity
   with `_stop_socket_mode_handler` ordering).
3. `events.ts` normalizes `message` / `app_mention` / `app_home_opened` / `file_shared` /
   `reaction_added` / `assistant_thread_*` into `MessageEvent`s; `mention-gating.ts` decides
   whether to forward to the agent loop.
4. Agent reply streams back through `adapter.send()` / `editMessage()` (edit-based streaming) with
   Block Kit when `rich_blocks` is on; `download.ts` hydrates file/voice/image attachments.
5. In relay mode the same adapter speaks the `CapabilityDescriptor` contract over the connector
   transport instead of owning the tokens.

Key interfaces (pseudocode):

```ts
interface PlatformAdapter {
  connect(opts?: { isReconnect?: boolean }): Promise<boolean>;
  disconnect(): Promise<void>;
  send(chatId: string, content: string, opts?: { replyTo?: string; metadata?: MsgMetadata; blocks?: Block[] }): Promise<SendResult>;
  editMessage(chatId: string, messageId: string, content: string, opts?: { metadata?: MsgMetadata }): Promise<SendResult>;
  deleteMessage(chatId: string, messageId: string, opts?: { metadata?: MsgMetadata }): Promise<boolean>;
  sendTyping(chatId: string, metadata?: MsgMetadata): Promise<void>;
  sendExecApproval(chatId: string, content: string, approval: ApprovalRequest, opts?: { replyTo?: string; metadata?: MsgMetadata }): Promise<SendResult>;
  sendClarify(chatId: string, question: string, choices: string[], opts?: { replyTo?: string; metadata?: MsgMetadata }): Promise<SendResult>;
  onMessage(handler: (event: MessageEvent) => Promise<ProcessingOutcome>): void;
  onReaction?(handler: (ev: ReactionEvent) => Promise<void>): void;
  // lifecycle probes used by the watchdog
  transportConnected(): Promise<boolean | null>;
  pingPongStale(): boolean;
}
```

## 4. Data models & persistence

- **No durable message store needed**: Slack is the source of truth (`channels.history` /
  `conversations.history` for thread-context backfill). Persistence strategy: **none for messages**;
  session identity/watermarks already live in Core's gateway sessions and stay there in v1.
- **In-memory state** (all bounded, mirroring the Python caches):
  - `_team_clients: Map<teamId, WebClient>` + `_team_bot_user_ids/names` (multi-workspace);
  - name caches (`user_name_cache`, `channel_name_cache`, `user_is_bot_cache`) max 5000;
  - `_channel_team`/`_channel_teams` max 10000; `_dm_conversation_cache` max 5000;
  - `_mentioned_threads`, `_bot_message_ts`, `_processed_message_ts` max 5000;
  - `MessageDeduplicator` TTL 300 s (reconnect redelivery), `_thread_context_cache` TTL 60 s max 2500;
  - `_approval_resolved`/`_clarify_resolved` max 1000; `_slash_command_contexts` bounded;
  - `_thread_rehydration_checked` (restart-gap rehydration).
- **Persisted credentials**: `SLACK_BOT_TOKEN` / `SLACK_APP_TOKEN` (+ `slack_tokens.json` OAuth
  multi-workspace file) in the managed runtime env/secret store; if in-process later, Tauri
  keychain/`~/.hermes/.env` via existing `runtime.ts`/transport patterns. No DB migration needed.
- **Relay lane**: `CapabilityDescriptor` (`CONTRACT_VERSION`, `max_message_length=4000`,
  `supports_draft_streaming=false`, `supports_edit=true`, `supports_threads=true`,
  `markdown_dialect="mrkdwn"`, `len_unit="chars"`) is a plain typed object; frames are transient.

## 5. Third-party library strategy

**Verified: no TS equivalent exists in `D:/kimi-code`.** A repo-wide search for `slack`
(package.json, imports, source) found only coincidental hits: `@secretlint/secretlint-rule-slack`
(secret-lint rule), `@shikijs/themes` `slack-dark`/`slack-ochin` (editor color themes), MCP test
fixtures named `slack` (`mcp__slack__echo`), comments ("plenty of slack"), and a token-redaction
regex in `packages/agent-core-v2/src/app/telemetry/privacy.ts` (`/xox[baprs]-[A-Za-z0-9-]{10,}/g`).
`node_modules/@slack`, `node_modules/.pnpm/@slack*`, and all `package.json` files contain **no**
`@slack/*` package. **Risk: any TS port must add the official Slack SDKs as new dependencies.**

| Python dependency | TS equivalent | kimi-code evidence |
|---|---|---|
| `slack_bolt` (`AsyncApp`) | `@slack/bolt` (official TS SDK) | **none** — new dependency |
| `slack_bolt.adapter.socket_mode.async_handler` | `@slack/socket-mode` (official; `SocketModeClient`) | **none** — new dependency |
| `slack_sdk.web.async_client.AsyncWebClient` | `@slack/web-api` (`WebClient`, shipped with `@slack/bolt`) | **none** — new dependency |
| `aiohttp`/`httpx` SSRF-safe client (`create_ssrf_safe_async_client`, `_ssrf_redirect_guard`) | Node `fetch`/`undici` + custom `Dispatcher` (block private IPs, per-redirect guard) or `@httptoolkit/undici-fetch` | none; kimi-code has no SSRF-safe fetch shim (only generic `fetch`) |
| `orjson` / stdlib json | `JSON.stringify` / `JSON.parse` | n/a |
| YAML config (`config.yaml`) | Core REST already owns config; Zod for UI schemas (`packages/protocol/src/hermes-api.ts`) | n/a |
| `slack_tokens.json` OAuth multi-workspace | keep same file format on disk; parse with `zod` | n/a |

Rationale for recommending `@slack/bolt` + `@slack/socket-mode` even though kimi-code has no
equivalent: they are the official, maintained Slack SDKs for Node/TS, cover Socket Mode outbound
dialing, event dispatch, slash commands, and web APIs; hand-rolling a Socket Mode client would
duplicate protocol work (envelope encryption `xapp` handshake, `connections:write` app-token
auth). The parts kimi-code *could* inform: generic WS reconnect/backoff patterns
(`packages/kap-server` transport), Zod validation (`packages/protocol`), and the MCP tool-interface
pattern — but none is a Slack adapter.

## 6. Integration with existing Hermes-CN-Desktop frontend

- **Existing to reuse (v1, recommended path)**:
  - `web/src/routes/settings.tsx` (1993 lines) — already renders
    `status.gateway_platforms["slack"]` state/error in the "Dashboard / Gateway" DebugCard; add a
    Slack row/card linking to a new settings surface.
  - `web/src/hooks/use-im-onboarding.ts` — `useMessagingPlatform` (GET `/api/messaging/platforms`
    → find by id) and `useTestMessagingPlatform` (POST
    `/api/messaging/platforms/{id}/test`) are generic enough to reuse for a Slack settings panel;
    the protocol schema `MessagingPlatformInfo`/`MessagingPlatformTestResponse`
    (`packages/protocol/src/hermes-api.ts` lines 127–160) already covers slack (id, name,
    enabled, configured, gateway_running, state, error_code/message, home_channel, env_vars).
  - `web/src/lib/im-onboarding-diagnostics.ts` (450 lines) — the `ImDiagnosticBundle` builder is a
    template for a `slack-diagnostics.ts`: required keys `SLACK_BOT_TOKEN`/`SLACK_APP_TOKEN`,
    policy keys `SLACK_ALLOWED_USERS`/`SLACK_HOME_CHANNEL`/`SLACK_THREAD_REQUIRE_MENTION` etc.,
    gateway platform state, test result, issues list.
  - `web/src/lib/transport.ts` — all REST calls must go through it (auth injection); never raw
    fetch in a new Slack settings page.
  - `web/src/lib/gateway-client.ts` + `use-gateway.ts` — for live gateway platform state updates.
- **Do NOT extend `web/src/routes/im-onboarding.tsx` / `src/commands/im_onboarding.rs`**:
  those are feishu/weixin/dingtalk **QR-code** onboarding flows; Slack uses manifest-based app
  creation (`hermes slack manifest`), so Slack gets a separate settings/onboarding route (e.g.
  `/settings/platforms/slack`), no new Rust command needed in v1 (REST PUT
  `/api/messaging/platforms/slack` + POST test suffice; `im_onboarding.rs` stays untouched).
- **Port decision + WS-removal implications** (recorded):
  - Messaging adapters are **gateway-side**; the Desktop's managed runtime already runs the Core
    gateway. Enabling Slack = `PUT /api/messaging/platforms/slack {enabled:true, env_vars}` and
    reading status — no change to `EXPECTED_BACKEND_VERSION`, no new port, no WS change.
  - Removing the Python/WS link (the repo's end-state goal) is about the **agent session
    transport** (`/api/ws`), not the Slack transport. If the Desktop ever becomes fully
    standalone (no managed Python runtime), the Slack bot must then run in-process (Section 3) —
    until then **do not port**; the Python gateway keeps owning `SLACK_*` secrets, which is safer
    (token exfiltration hardening lives with the download guard).
  - In-process port implications if it ever happens: Tauri webview needs outbound WS (Slack
    socket-mode) — the existing `ws_proxy.rs` relay is for `ws://` to the dashboard; a
    webview-originated Slack socket is a different origin and would need a Rust `slack_transport`
    command or `@tauri-apps/plugin-websocket`; secrets move from `.env` to OS keychain; the
    `hermes slack manifest` onboarding moves to Desktop (Rust command + web flow).

## 7. Removing the WebSocket dependency (migration path)

API surface to freeze during any migration (these must keep working whether Slack lives in the
Python gateway or in-process):

1. `GET /api/messaging/platforms` + `PUT /api/messaging/platforms/slack` + `POST
   /api/messaging/platforms/slack/test` (Core `hermes_cli/web_server.py` 10351/10422).
2. `StatusResponse.gateway_platforms["slack"]` shape (`state`, `error_message`, …) in
   `packages/protocol/src/hermes-api.ts`.
3. Slack env var names (`SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_ALLOWED_USERS`, …) and
   `plugin.yaml` requires_env — the config contract.
4. Relay `CapabilityDescriptor` fields if a connector lane is used.

Phases:

- **Phase A (v1, recommended): Python gateway owns Slack; Desktop adds UI only.** Add
  `settings/platforms/slack` route reusing `useMessagingPlatform`/`useTestMessagingPlatform` +
  `slack-diagnostics.ts`; write env via existing REST PUT. Zero WS changes.
- **Phase B (optional): in-process `PlatformAdapter` behind the same interface.** Extract the
  interface in Section 3, run `SlackAdapter` inside the webview (or a Rust-side socket transport),
  and bridge inbound events to the agent loop through the existing `gateway-client` message
  pipeline. Delete path: keep Python adapter as fallback; flip per-profile flag.
- **Phase C (only if desktop fully standalone): delete the Python WS/REST path** for Slack config
  (keep `/api/ws` for agent sessions as long as the Python agent exists). The frozen surface above
  is what the TS implementation must satisfy so the swap is invisible to the UI.

## 8. Migration phases & task breakdown

| Phase | Tasks | Est. |
|---|---|---|
| A1 | New `/settings/platforms/slack` route (reuse `useMessagingPlatform`); env editor for `SLACK_BOT_TOKEN`/`SLACK_APP_TOKEN`/`SLACK_ALLOWED_USERS`; enable toggle → PUT; test button → POST test | S |
| A2 | `web/src/lib/slack-diagnostics.ts` modeled on `im-onboarding-diagnostics.ts`; show gateway_platforms.slack state/error; docs link to Core `messaging/slack.md` | S |
| A3 | (Optional, no-port fallback) In-process `@slack/web-api` outbound-only **webhook/notification** sender for desktop cron/alerts (does NOT receive events; no Socket Mode) — smallest useful TS Slack surface | M |
| B1 | Port `block-kit.ts` + `mrkdwn.ts` (pure functions) + parity tests | M |
| B2 | Port `mention-gating.ts`, `events.ts`, `dedup.ts`; `transport.ts` (Socket Mode + watchdog) | L |
| B3 | Port `download.ts` SSRF hardening (fetch dispatcher + CDN allowlist + redirect guard) | M |
| B4 | Port `adapter.ts` send/edit/status/approval/clarify + `manifest.ts`; relay-connector DM streaming | L |

(S=small ≤3d, M=medium ≤1w, L=large >1w. A1–A2 are the actual v1 work; B* is the recorded port
backlog.)

## 9. Risks & open questions

- **No TS equivalent found in kimi-code (HIGH).** `@slack/bolt`/`@slack/socket-mode`/`@slack/web-api`
  are not present anywhere in the reference monorepo, so there is no in-repo precedent for Slack
  API usage, Socket Mode reconnect quirks, or Block Kit. The port must rely on official SDK docs
  and new dependencies; npm install + license/version checks land on Desktop's pnpm workspace.
- **Socket Mode teardown parity (HIGH).** Python pins a specific cancel-before-close ordering
  (slackapi/python-slack-sdk#1913, issue #46990). The TS `SocketModeClient` has its own internal
  retry loop; the watchdog/ping-pong-stale design must be re-verified against the TS SDK's event
  surface (`on('connecting')`, `on('error')`, `on('disconnected')`) and its `last_ping_pong_time`
  equivalent (may not exist — needs a custom heartbeat probe).
- **SSRF DNS-pinning in JS (MEDIUM-HIGH).** Node `fetch`/undici can attach a custom `Dispatcher`
  and `connect` options for IP pinning, but the "resolve once, validate, dial vetted IP" behavior
  of `create_ssrf_safe_async_client` needs a bespoke `Agent`/`Client` — kimi-code has no shim.
- **Webhook vs Socket Mode scope (MEDIUM).** Core's Slack adapter is Socket-Mode-only; there is no
  Slack-webhook inbound plugin (generic `webhooks.md` platform exists separately). The feature title
  mentions "socket mode + webhook" — decision needed: treat webhook as **outbound-only**
  notification sender (Phase A3) or require a full webhook inbound receiver (public URL, not
  standalone-friendly).
- **Agent/Assistant view parity (MEDIUM).** `app_home_opened`, `app_context_changed`,
  `assistant_thread_*` lifecycle, suggested prompts, status line (`assistant.threads.setStatus`)
  are API-heavy; TS SDK covers them but scope `assistant:write` + messages tab behavior must be
  re-tested.
- **Open questions:** should Desktop ship its own Slack onboarding manifest generator (port
  `hermes slack manifest`)? Where do `SLACK_*` tokens live if in-process (OS keychain vs `.env`)?
  Is multi-workspace support required for desktop (affects `_team_clients` design)? Keep
  `EXPECTED_BACKEND_VERSION` in sync when Core changes slack endpoints?

## 10. Test strategy

Parity tests (vitest) mirroring the Python suites:

- `block-kit.test.ts` ↔ `tests/gateway/test_slack_block_kit.py`: render_blocks basics, nested
  list indents, native table + monospace fallback + escaped pipes, >50 blocks → None, empty-content
  schema guards, sanitize clamps (3000/150), fence-balanced `_split_text`.
- `mrkdwn.test.ts` ↔ `test_slack.py` `TestFormatMessage`/`TestEditMessage`: escape control chars,
  broadcast mentions, code fences, blockquotes, CJK table alignment, no double-escape.
- `mention-gating.test.ts` ↔ `tests/test_slack_thread_require_mention.py` + `TestMessageRouting`:
  env/YAML bridge, DM no-mention, channel mention required, thread_require_mention blocks
  unmentioned thread replies, free-response channels, ignore-other-user, sticky-thread behavior.
- `transport.test.ts` ↔ `tests/gateway/test_slack_socket_reconnect_heal.py`: fake SocketModeClient
  (`_FakeSession`/`_FakeSocketModeClient`) asserting cancel-before-close ordering and watchdog
  restart on transport disconnect / ping staleness.
- `download.test.ts` ↔ `tests/gateway/test_slack_download_ssrf.py`: unsafe URL blocked before
  network (mock fetch dispatcher), redirect guard wired, non-CDN URL rejected, HTML content-type
  rejection, token routing per team.
- `relay-dm-streaming.test.ts` ↔ `tests/gateway/relay/test_relay_slack_dm_streaming.py`: StubConnector
  captures frames; flat mode drops synthetic anchor, thread-per-message keeps it, real thread kept,
  stream consumer emits send+edit on its own ts in DMs.
- `slack-settings.e2e.ts` (Playwright): enable slack via mocked `/api/messaging/platforms/slack`,
  diagnostics bundle renders required keys, test button shows state.
- CI: run `pnpm typecheck` + `pnpm test:unit` per repo conventions; no network in unit tests
  (all fetch/WebClient mocked).

## 11. Reference links

- Core source: `D:/hermes-agent-cn/plugins/platforms/slack/{adapter.py,block_kit.py,plugin.yaml}`
- Core docs: `D:/hermes-agent-cn/website/docs/user-guide/messaging/slack.md`,
  `D:/hermes-agent-cn/website/docs/user-guide/messaging/relay.md`
- Core REST: `D:/hermes-agent-cn/hermes_cli/web_server.py` (8585 catalog; 10351 PUT; 10422 POST test)
- Core tests: `tests/gateway/test_slack.py`, `test_slack_block_kit.py`,
  `test_slack_socket_reconnect_heal.py`, `test_slack_download_ssrf.py`,
  `tests/test_slack_thread_require_mention.py`, `tests/gateway/relay/test_relay_slack_dm_streaming.py`
- Desktop: `web/src/routes/settings.tsx`, `web/src/routes/im-onboarding.tsx`,
  `web/src/lib/im-onboarding-diagnostics.ts`, `web/src/hooks/use-im-onboarding.ts`,
  `packages/protocol/src/hermes-api.ts`, `src/commands/im_onboarding.rs`
- TS SDKs (new deps, not in kimi-code): https://github.com/slackapi/bolt-js,
  https://github.com/slackapi/node-slack-sdk (socket-mode, web-api)
- Slack platform docs: https://api.slack.com/apis/socket-mode, https://docs.slack.dev/block-kit/
