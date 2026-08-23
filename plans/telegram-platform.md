# Telegram Messaging Platform Adapter — Python → TypeScript Rewrite Plan

> Port decision recorded up front: **Telegram is a gateway-side messaging platform adapter and is
> marked "out of scope for desktop standalone"** (per `plans/README.md`). The desktop keeps talking
> to the Core managed-runtime gateway over REST (`/api/messaging/platforms`, `/api/env`) and WS
> (`/api/ws`) and does **not** host the Telegram bot in-process in v1. This file still designs the
> in-process TS port (Sections 3–10) so the decision is recorded and a future standalone build can
> pick it up. Feature scope: Telegram bot (webhook + polling), approval buttons, voice messages,
> topic mode, reactions.

## 1. Summary

Hermes-CN-Core ships a large Telegram bot adapter (`plugins/platforms/telegram/adapter.py`, ~10.5k
LOC) built on **python-telegram-bot (PTB)**, with long-polling **and** webhook modes, MarkdownV2 /
HTML rendering with rich-message support, inline-keyboard approval/clarify/model-picker flows,
voice (STT transcription + TTS voice bubbles), DM/group **topic mode** (`extra.dm_topics`,
`/topic` multi-session mode, `group_topics` skill binding) backed by SQLite, atomic message
reactions, mention gating, allowlists, adaptive text/photo batching, polling-health watchdogs
(409-conflict recovery, fallback-IP transport via `telegram_network.py`), and a
webhook-secret guard (GHSA-3vpc-7q5r-276h). The Desktop app currently has **no Telegram UI**: it
only echoes `status.gateway_platforms["telegram"]` in the Settings debug card and maps
`TELEGRAM_BOT_TOKEN`/`TELEGRAM_ALLOWED_USERS`/`TELEGRAM_PROXY` in `web/src/lib/env-translations.ts`;
the existing IM onboarding (`web/src/routes/im-onboarding.tsx`) covers Feishu/Weixin only.

This plan records the port decision — **keep Telegram in the Python gateway (managed runtime) for
v1, expose config/status in Desktop via REST; do not host Telegram in-process**. It also gives the
full design for an eventual in-process TypeScript port built on **grammY** (recommended over
telegraf; see Section 5), which **does not exist anywhere in `D:/kimi-code`** (verified — a
repo-wide search for `telegram` returns zero matches, and `node_modules` contains neither
`grammY` nor `telegraf`; Section 5 risk).

## 2. Current Python implementation

Source of truth: `D:/hermes-agent-cn`

| Path | Role |
|---|---|
| `plugins/platforms/telegram/adapter.py` (10,512 lines) | `TelegramAdapter(BasePlatformAdapter)` — everything (lifecycle, handlers, send paths, callbacks) |
| `plugins/platforms/telegram/telegram_ids.py` (50 lines) | `normalize_telegram_chat_id` (int vs `@username`), `telegram_chat_id_key`, `looks_like_telegram_username` |
| `plugins/platforms/telegram/telegram_network.py` (323 lines) | `TelegramFallbackTransport` (httpx), DoH IP discovery (`discover_fallback_ips`), seed IPs `149.154.166.110`/`149.154.167.220`, proxy resolution |
| `plugins/platforms/telegram/plugin.yaml` | requires `TELEGRAM_BOT_TOKEN`; optional `TELEGRAM_ALLOWED_USERS`, `TELEGRAM_ALLOW_ALL_USERS`, `TELEGRAM_HOME_CHANNEL[_NAME]` |
| `plugins/platforms/telegram/__init__.py` | `register` re-export |
| `hermes_cli/web_server.py` (8568) | `/api/messaging/platforms` catalog entry (`TELEGRAM_BOT_TOKEN` required); PUT enable / POST test endpoints; Telegram manager-bot onboarding `/api/messaging/telegram/onboarding/*` (10036+) |
| `hermes_state.py` (10784) | `telegram_dm_topic_mode` + `telegram_dm_topic_bindings` tables (v1→v2 FK `ON DELETE CASCADE` migration) |
| `website/docs/user-guide/messaging/telegram.md` (1,324 lines) | setup, webhook/polling, topics, voice, reactions, security |

Key implementation blocks inside `adapter.py` (line refs verified by reading):

- **PTB lifecycle**: `_register_handlers` (3921) — MessageHandler for TEXT/COMMAND/LOCATION/media,
  `CallbackQueryHandler`, and a group-99 `TypeHandler(Update, _on_platform_update)` observer;
  `connect()` (3951) builds `Application.builder().token(...)`, honors `base_url` +
  `local_mode` (local telegram-bot-api server), tunes httpx pool/keepalive, wires the
  fallback-IP transport, and **requires `TELEGRAM_WEBHOOK_SECRET` in webhook mode** (refusal with
  GHSA-3vpc-7q5r-276h, verified by `tests/gateway/test_telegram_webhook_secret.py`).
- **Polling health**: `_start_polling_resilient` (2502), `_handle_polling_network_error` (2633),
  `_polling_heartbeat_loop` (2754) probing `pending_update_count` + `running=False`,
  `_handle_polling_conflict` (3130, 409 `getUpdates`), `_record_polling_progress` (2230) + verifier (2368), `_probe_pending_updates` (2868).
- **Inbound pipeline**: `_handle_text_message` (9147) / `_handle_command` (9180) /
  `_handle_media_message` (9419) with adaptive text batching (`_enqueue_text_event` 9281,
  fast-path 0.18 s / 0.24 s, cap via `HERMES_TELEGRAM_TEXT_BATCH_DELAY_SECONDS`), photo/media-group
  batching, `_should_process_message` (9018), `_build_message_event` (9997), mention gating
  (`_telegram_require_mention` 8125, `_message_mentions_bot` 8533, `_explicit_bot_mentions_exclude_self`
  8616), allowlists (`_telegram_allowed_chats` 8203, `_telegram_allowed_topics` 8242,
  `_telegram_ignored_threads` 8257).
- **Outbound**: `send()` (4765) with thread kwargs + DM-topic reply-anchor retry
  (`_send_with_dm_topic_reply_anchor_retry` 1470), `format_message` (7951) MarkdownV2 escaping
  (`_escape_mdv2` 469, `_strip_mdv2` 474), `send_or_update_status` (5092) with
  `{(chat_id, status_key) → message_id}` edit cache, `edit_message` (5126),
  `delete_message` (5550), `send_typing` (7875), `send_draft` (5608) for Bot API 9.5 native
  streaming (`supports_draft_streaming` 5575), rich messages (`_try_send_rich` 1918,
  `RICH_MESSAGE_MAX_CHARS=32768`).
- **Approval / interactive buttons**: `send_exec_approval` (5789) — inline keyboard
  `ea:once/ea:session/ea:always/ea:deny:{approval_id}` with `_approval_state[approval_id] →
  session_key`; `send_slash_confirm` (5865) `sc:*`, `send_clarify` (5913) + `send_model_picker`
  (5999) / `send_choice_picker` (6069); `_handle_callback_query` (6657) dispatches all with
  **fail-closed user auth** (`_is_callback_user_authorized` 948).
- **Voice**: `send_voice` (7196) probes duration (`_probe_voice_duration_seconds` 338: stdlib
  `wave`, `mutagen`, ffprobe) and passes `duration=` to `sendVoice`/`sendAudio`; incoming voice →
  STT (`local` faster-whisper / `groq` / `openai`) or raw audio cache; outgoing TTS → Opus voice
  bubble (ffmpeg conversion for Edge TTS).
- **Topic mode**: config-driven `extra.dm_topics` (`_setup_dm_topics` 3542, `_create_dm_topic`
  3323), user-driven `/topic` multi-session (`telegram_dm_topic_mode` /
  `telegram_dm_topic_bindings` SQLite rows; `_prune_stale_dm_topic_binding` 1374), group forum
  topic skill binding via `extra.group_topics`; isolation key `agent:main:telegram:dm:{chat_id}:{thread_id}`.
- **Reactions**: `_reactions_enabled` (10167, `TELEGRAM_REACTIONS` default off),
  `_set_reaction`/`_clear_reactions` (10171/10186) via `set_message_reaction` (replace-all
  semantics — unlike Discord additive), `on_processing_start` 👀 (10207),
  `on_processing_complete` ✅/❌/clear-on-CANCELLED (10216).
- **Notification modes**: `_resolve_notifications_mode` (10260) — `important` (default) vs `all`.
- **Auth**: `_is_user_authorized_from_message` (1160), DM pairing bypass for unauthorized
  senders (`_should_pass_unauthorized_dm_for_pairing` 1126), `_telegram_auth_env_configured` (1114).

**Docs key behaviors** (`website/docs/user-guide/messaging/telegram.md`; line ranges): polling/webhook
+ secret (245–304), proxy (305–324), home channel + cron thread (326–349), voice (351–397), local Bot
API server (399–527), group gating (528–628), DM topics (629–720), `/topic` multi-session SQLite
(722–857), group topic skills (859–922), streaming drafts (924–956), rich rendering (958–993),
reactions (1197–1224), channel prompts (1226–1248), exec approval (1261–1267), clarify (1269–1280),
notifications (1282–1306), status edit (1308–1310), pin (1312–1314), security allowlist (1316–1324).

## 3. Target TypeScript design

**Port decision (recorded):** keep the adapter in the Python gateway for v1; the Desktop only adds
a config/status surface (Section 6). The in-process design below is the "if ported" target.

Proposed module layout (matches the `PlatformAdapter` contract in `plans/messaging-gateway-core.md`
so the adapter can plug into the future in-process gateway):

```
packages/telegram-adapter/src/
  adapter.ts            # TelegramAdapter — implements PlatformAdapter (connect/send/edit/status/approval/clarify/reactions)
  transport.ts          # PollingTransport + WebhookTransport (grammY) with 409-conflict recovery + progress verifier
  fallback-network.ts   # DoH discovery + IP-pinned fetch/undici dispatcher (port of telegram_network.py)
  events.ts             # inbound normalization: Update → MessageEvent{source:{platform:'telegram',chat_id,chat_type,user_id,thread_id}}
  mention-gating.ts     # require-mention / allowed-chats / allowed-topics / ignored-threads / bot-username cache
  markdown.ts           # format_message port: MarkdownV2 escape/strip + HTML fallback + fence-safe chunking
  batching.ts           # adaptive text/photo/media-group batch debouncers
  callbacks.ts          # approval (ea:*), slash-confirm (sc:*), clarify (cl:*), model/choice picker (mp:*:*, cp:*), gmail triage
  voice.ts              # sendVoice/sendAudio with duration probe; media-size guard; STT/TTS bridging
  topics.ts             # dm_topics / /topic multi-session / group_topics logic + SQLite access
  reactions.ts          # setMessageReaction lifecycle hooks (👀 → ✅/❌/clear)
  state.ts              # in-memory bounded caches: approval/clarify state, status-edit cache, bot username, typing cooldowns
  telegram-ids.ts       # normalizeTelegramChatId / chatIdKey / looksLikeTelegramUsername (direct port)
```

Data flow (in-process):

1. `TelegramAdapter.connect({ isReconnect })` reads `TELEGRAM_BOT_TOKEN` from the Tauri secret/env
   store, builds a grammY `Bot` (with `baseUrl` + `localMode`-style file path handling), registers
   `bot.on("message:text"|"message:media"|"message:location"|"callback_query:data")` handlers, and
   starts either `bot.start()` (polling) or a Fastify/`webhookCallback` route (webhook mode).
2. `events.ts` normalizes each update into a `MessageEvent` (same shape as Core
   `gateway/platforms/base.py`); `mention-gating.ts` + allowlists decide whether to forward to the
   agent loop; `batching.ts` coalesces client-side splits / photo bursts.
3. Agent reply streams back through `adapter.send()` / `editMessage()` / `sendDraft` (native
   streaming) with MarkdownV2 from `markdown.ts`; approval/clarify go through `callbacks.ts`
   inline keyboards.
4. Voice: inbound audio → STT provider (HTTP) or raw cache path; outbound TTS audio → `sendVoice`
   with probed duration. Topic mode: `topics.ts` routes by `(chat_id, thread_id)` and persists
   bindings to SQLite (Section 4). Reactions: `reactions.ts` on processing lifecycle.
5. In relay mode the same adapter speaks the relay `CapabilityDescriptor` contract instead of
   owning tokens (future; same shape as slack-platform plan §3).

Key interfaces (pseudocode — no implementation):

```ts
interface TelegramAdapterLike extends PlatformAdapter {
  connect(opts?: { isReconnect?: boolean }): Promise<boolean>;
  disconnect(): Promise<void>;
  send(chatId: string, content: string, opts?: { replyTo?: string; metadata?: MsgMetadata }): Promise<SendResult>;
  editMessage(chatId: string, messageId: string, content: string, opts?: { metadata?: MsgMetadata }): Promise<SendResult>;
  sendOrUpdateStatus(chatId: string, statusKey: string, text: string, metadata?: MsgMetadata): Promise<SendResult>;
  sendVoice(chatId: string, audioPath: string, opts?: { caption?: string; metadata?: MsgMetadata }): Promise<SendResult>;
  sendExecApproval(chatId: string, content: string, approval: ApprovalRequest, opts?: { metadata?: MsgMetadata }): Promise<SendResult>;
  sendClarify(chatId: string, question: string, choices: string[], opts?: { metadata?: MsgMetadata }): Promise<SendResult>;
  setReaction(chatId: string, messageId: string, emoji: string): Promise<boolean>;
  onProcessingStart(event: MessageEvent): Promise<void>;
  onProcessingComplete(event: MessageEvent, outcome: ProcessingOutcome): Promise<void>;
  onMessage(handler: (event: MessageEvent) => Promise<ProcessingOutcome>): void;
  onReaction?(handler: (ev: ReactionEvent) => Promise<void>): void;
  pollingHealthy(): Promise<boolean | null>; // heartbeat / progress verifier
}
```

## 4. Data models & persistence

- **No durable message store**: Telegram is the source of truth (`getUpdates` / webhook events).
  Persistence strategy: **none for messages**; session identity already lives in Core gateway
  sessions and stays there in v1.
- **In-memory state** (all bounded, mirroring the Python caches):
  - `_approval_state: Map<approvalId, sessionKey>`, `_slash_confirm_state`, `_clarify_state`,
    `_choice_picker_state`, `_model_picker_state` (bounded ~1000, TTL'd);
  - `_status_edit_cache: Map<`${chatId}:${statusKey}`, messageId>` (status edit-in-place);
  - `_pending_text_batches` / `_pending_photo_batches` / `_media_group_events` (debounce windows);
  - `_bot_username_observed` + `_bot_identity_checked_at` (getMe refresh loop);
  - `_telegram_typing_cooldown_until: Map<chatId, number>`;
  - `_dm_topic_binding_cache` (chat_id+thread_id → session), topic-mode capability probe cache.
- **Persisted SQLite state** (only for topic mode, port of `hermes_state.py` 10784):
  - `telegram_dm_topic_mode(chat_id PK, user_id, enabled, activated_at, updated_at,
    has_topics_enabled, allows_users_to_create_topics, capability_checked_at, intro_message_id,
    pinned_message_id)`;
  - `telegram_dm_topic_bindings(chat_id, thread_id, user_id, session_key, session_id FK→sessions
    ON DELETE CASCADE, managed_mode, linked_at, updated_at, PK(chat_id, thread_id))` +
    unique index on `session_id`.
  - If in-process: keep SQLite in Rust (`src/commands/`, rusqlite via Tauri IPC) to preserve the
    exact FK `ON DELETE CASCADE` semantics and the opt-in migration ("runs on first `/topic` call,
    never on gateway startup"); `packages/minidb` (kimi-code) is an option but its schema/FK model
    differs — recommend Rust SQLite for parity.
- **Credentials/config**: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_USERS`, `TELEGRAM_PROXY`,
  `TELEGRAM_WEBHOOK_URL`/`SECRET`/`PORT`, `TELEGRAM_REACTIONS`, `TELEGRAM_HOME_CHANNEL[_NAME]` in
  the managed runtime env/secret store; if in-process later, Tauri keychain or `~/.hermes/.env`
  via existing `runtime.ts`/transport patterns. No new migration beyond the two topic tables.

## 5. Third-party library strategy

**Verified: no TS equivalent exists in `D:/kimi-code`.** A repo-wide search for `telegram`
(imports, source, package.json) returns **zero matches**; `node_modules` contains **no** `grammY`
and **no** `telegraf`; no package.json depends on either. kimi-code's HTTP stack is Fastify + `ws`
+ Node built-in `fetch`/undici (see `packages/kap-server/package.json`: `fastify`, `ws`, `pino`,
`smol-toml`, `zod`). **Risk: the TS Telegram port must add a new dependency with no in-repo
precedent** (same posture as the Slack plan).

| Python dependency | TS equivalent | kimi-code evidence |
|---|---|---|
| `python-telegram-bot` (`Application`, `Bot`, `Message`, `InlineKeyboardButton/Markup`, `CallbackQueryHandler`, `filters`, `ParseMode`, `ChatType`, `HTTPXRequest`) | **grammY** (recommended) or **telegraf** — see rationale below | **none** — new dependency |
| `httpx` (`AsyncBaseTransport` for fallback IPs, proxy, timeouts) | Node `fetch`/undici + custom `Dispatcher`/`Agent` (IP-pin `api.telegram.org` while keeping SNI/Host) or grammY `ApiClient` custom `fetch` | kimi-code uses undici-based fetch indirectly; no custom dispatcher shim exists |
| `orjson` / stdlib json | `JSON.stringify` / `JSON.parse` | n/a |
| `mutagen` / stdlib `wave` / `ffprobe` (voice duration) | `music-metadata` (pure JS) or `ffprobe` via `child_process` (kimi-code has `apps/kimi-code/src/utils/process` helpers) | no media-metadata lib found; needs verification |
| `faster-whisper` (local STT) | HTTP STT providers (Groq/OpenAI) or local `whisper.cpp` via Tauri child process | kimi-code has no STT; `voice-mode` plan owns this |
| `tools.lazy_deps` (lazy-install PTB) | npm `optionalDependencies` + feature-flag; no lazy-install needed in bundle | n/a |
| YAML config (`config.yaml` extra keys) | Core REST owns config; Zod UI schemas; kimi-code uses `smol-toml` (evidence `packages/kap-server/package.json`) | n/a |
| webhook server (PTB webhook) | grammY `webhookCallback` mounted on Fastify (kimi-code has Fastify precedent) or Node `http` | Fastify precedent in kimi-code |

**grammY vs telegraf recommendation — choose grammY:**

- **TypeScript-first with Bot API type generation**: grammY ships per-method typed `bot.api.*`
  calls (e.g. `setMessageReaction`, `createForumTopic`, `sendMessageDraft`) for the wide surface
  here (topics, reactions, rich messages, drafts); telegraf is older, callback-style, and weaker
  on Bot API 9.4/9.5/10.1 endpoints.
- **Webhook is first-class**: grammY `webhookCallback` composes with Fastify — kimi-code already
  proves Fastify usage in `packages/kap-server`; telegraf's webhook is more ad-hoc.
- **Inline keyboard ergonomics**: grammY `InlineKeyboard` maps 1:1 to Python
  `InlineKeyboardMarkup` rows used by approval/clarify/model-picker; callback-data 64-byte limit
  forces the same short-ID scheme (`ea:once:{id}`) the Python side already uses.
- **Transport injection**: grammY lets you override the `ApiClient` fetch — where the fallback-IP
  transport (port of `telegram_network.py`) and DoH discovery attach.
- telegraf remains a valid fallback for a larger community/middleware ecosystem, but grammY's
  maintenance cadence and TS surface make it the better parity match for a 10.5k-LOC adapter.

Where no TS lib exists at all, design a thin shim: `markdown.ts` (MarkdownV2 escape/strip),
`batching.ts`, `callbacks.ts`, `mention-gating.ts`, `fallback-network.ts` (custom undici
dispatcher) are pure/typed ports with sketched interfaces above — no third-party dependency.

## 6. Integration with existing Hermes-CN-Desktop frontend

Today there is **no Telegram UI** in the desktop (verified: `grep -ri telegram web/src` only hits
`lib/source-meta.ts`, `lib/env-translations.ts`, `lib/config-translations.ts`; `src/` (Rust) has
zero Telegram references).

- `web/src/routes/settings.tsx` (line ~1478) already renders `status.gateway_platforms` as a
  debug platform list; add a Telegram card/row reusing the existing status shape
  (`state`, `error_code`, `error_message`) — no new backend needed.
- `web/src/routes/im-onboarding.tsx` + `web/src/lib/im-onboarding-diagnostics.ts` are
  **Feishu/Weixin-specific** (`ImPlatform = "feishu" | "weixin"` in
  `packages/protocol/src/channels.ts`). For v1, do **not** force Telegram into that flow — either
  add a minimal `telegram-diagnostics.ts` modeled on the same `ImDiagnosticBundle` shape, or a
  standalone `settings/platforms/telegram` route with env editor (`TELEGRAM_BOT_TOKEN`,
  `TELEGRAM_ALLOWED_USERS`, `TELEGRAM_PROXY`) using the existing REST PUT `/api/env` + enable via
  `/api/messaging/platforms/telegram` (Core catalog entry at `hermes_cli/web_server.py:8568`) and
  POST test endpoint. Core also exposes a **Telegram manager-bot onboarding**
  (`/api/messaging/telegram/onboarding/start` + `/{pairing_id}` status, `web_server.py:10036+`) —
  decide whether Desktop surfaces it (it is a separate BotFather-manager flow, not the adapter).
- `web/src/lib/transport.ts` (HTTP routing + auth) and `web/src/lib/gateway-client.ts` (WS JSON-RPC)
  are the existing transport to reuse; `web/src/lib/env-translations.ts` already maps
  `TELEGRAM_BOT_TOKEN` / `TELEGRAM_ALLOWED_USERS` / `TELEGRAM_PROXY`.
- `packages/protocol/src/channels.ts` — if Telegram onboarding is added, extend `ImPlatform` or add
  a new `TelegramPlatformInfo` schema (Zod) for the diagnostics bundle.
- Rust `src/commands/*` has no Telegram commands; none needed for v1. If in-process later, add
  `src/commands/telegram.rs` only for SQLite topic tables and (optionally) a Rust-side HTTP
  webhook listener.

## 7. Removing the WebSocket dependency (migration path)

Telegram is a **gateway-side** adapter; the WS-removal story is therefore owned by
`plans/messaging-gateway-core.md` (gateway becomes an in-process service). This plan's phases keep
Telegram out of the desktop in v1 and record the swap contract.

- **Phase A (v1, recommended): Python gateway owns Telegram; Desktop adds UI only.** New
  `settings/platforms/telegram` route (or diagnostics card) reusing `useMessagingPlatform`-style
  hooks + `telegram-diagnostics.ts`; write env via existing REST PUT; enable/test via
  `/api/messaging/platforms/telegram`. **Zero WS changes.**
- **Phase B (optional): in-process `TelegramAdapter` behind the same interface.** Extract the
  `PlatformAdapter` interface (Section 3), run grammY inside the webview (or Rust-side child for
  webhook listening), bridge inbound events to the agent loop through the same message pipeline
  the desktop chat UI uses (`LocalChatAdapter` in gateway-core plan). Delete path: keep the Python
  adapter as fallback; flip per-profile flag.
- **Phase C (only if desktop fully standalone): delete the Python WS/REST path** for Telegram
  config (keep `/api/ws` for agent sessions as long as the Python agent exists). The frozen
  surface the TS implementation must satisfy:
  1. `PlatformAdapter` interface (Section 3) — connect/send/edit/status/voice/approval/clarify/
     reactions/lifecycle probes;
  2. env names (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_USERS`, `TELEGRAM_PROXY`,
     `TELEGRAM_WEBHOOK_URL`/`SECRET`/`PORT`, `TELEGRAM_REACTIONS`, `TELEGRAM_HOME_CHANNEL[_NAME]`,
     `TELEGRAM_CRON_THREAD_ID`, `HERMES_TELEGRAM_*` tuning vars) and `plugin.yaml` requires_env;
  3. SQLite topic tables (`telegram_dm_topic_mode`, `telegram_dm_topic_bindings`) and the
     opt-in migration timing;
  4. session isolation keys `agent:main:telegram:dm:{chat_id}:{thread_id}` and
     `build_session_key` semantics;
  5. webhook secret requirement (GHSA-3vpc-7q5r-276h) — the one **security** surface that must
     not regress.

## 8. Migration phases & task breakdown

| Phase | Tasks | Est. |
|---|---|---|
| A1 | `/settings/platforms/telegram` route (or settings card): show `gateway_platforms.telegram` state/error; env editor for `TELEGRAM_BOT_TOKEN`/`TELEGRAM_ALLOWED_USERS`/`TELEGRAM_PROXY` → REST PUT; enable toggle → PUT; test button → POST test | S |
| A2 | `web/src/lib/telegram-diagnostics.ts` modeled on `im-onboarding-diagnostics.ts`; docs link to Core `messaging/telegram.md`; decide whether to surface manager-bot onboarding endpoints | S |
| A3 | (Optional, no-port fallback) In-process grammY **outbound-only** notification sender for desktop cron/alerts (no inbound events, no webhook listener) — smallest useful TS Telegram surface | M |
| B1 | Port `telegram-ids.ts` + `markdown.ts` (pure) + parity tests | M |
| B2 | Port `events.ts`, `mention-gating.ts`, `batching.ts`, `callbacks.ts` (approval/clarify/pickers), `reactions.ts` | L |
| B3 | Port `transport.ts` (polling + webhook, 409-conflict recovery, progress verifier, bot-identity refresh) + `fallback-network.ts` (DoH + IP-pinned undici dispatcher) | L |
| B4 | Port `adapter.ts` send/edit/status/voice + `topics.ts` SQLite integration + `voice.ts` duration probe | L |

(S=small ≤3d, M=medium ≤1w, L=large >1w. A1–A2 are the actual v1 work; B* is the recorded port
backlog.)

## 9. Risks & open questions

- **No TS equivalent found in kimi-code (HIGH).** Zero `telegram` matches in the reference
  monorepo; `grammY`/`telegraf` absent from `node_modules` and all package.json files. There is no
  in-repo precedent for a Telegram/IM bot SDK, Bot API quirks, or the fallback-IP transport; the
  port relies on official grammY docs and new pnpm dependencies.
- **PTB-specific lifecycle parity (HIGH).** Python's `Application` owns initialize/shutdown,
  `getUpdates` long-poll health, 409 conflict recovery, and the "transient-initialization rebuild"
  path (`_register_handlers` re-run). grammY's `bot.start()`/`bot.stop()` and `bot.botInfo` caching
  differ; the polling progress verifier (`tests/test_telegram_polling_progress_ptb.py` exercises a
  real PTB runtime with custom `BaseRequest`) must be re-written against grammY's `ApiClient`
  injection point and re-verified.
- **Webhook secret & TLS (HIGH).** The webhook-secret guard is a security-critical parity test
  (`test_telegram_webhook_secret.py` does source-level checks). In-process webhook mode needs a
  public HTTPS URL + local listener (Node http/Fastify or Rust axum), which conflicts with a
  laptop-standalone desktop; polling is the natural desktop default.
- **Voice duration probing (MEDIUM).** `_probe_voice_duration_seconds` uses stdlib `wave` +
  `mutagen` + ffprobe; the TS equivalent (`music-metadata` or ffprobe child process) is unverified
  in kimi-code and must handle OGG/Opus/M4A/MP3 without native deps.
- **Reactions API shape (MEDIUM).** PTB accepts a string emoji convenience; grammY uses Bot API
  `setMessageReaction` with `ReactionType[]`. Replace-not-add semantics and silent failure in
  groups must be preserved.
- **Topic-mode SQLite fidelity (MEDIUM-HIGH).** The `ON DELETE CASCADE` FK on `session_id`, the
  unique index, and the opt-in migration timing are behavior-contract items; if in-process, Rust
  SQLite is recommended over `packages/minidb` for exact FK semantics (verify minidb supports FK
  cascades first).
- **Bot API recency (MEDIUM).** Bot API 9.4 Private Chat Topics, 9.5 `sendMessageDraft` native
  streaming, and 10.1 Rich Messages are new enough that TS SDK type coverage lags; grammY's
  generated types may need manual `raw` calls.
- **Open questions:** Should Desktop surface Core's Telegram **manager-bot onboarding**
  (`/api/messaging/telegram/onboarding/*`) or only the token allowlist flow? Where do
  `TELEGRAM_*` tokens live if in-process (OS keychain vs `.env`)? Is `/topic` multi-session mode
  required for desktop in-process, or is `extra.dm_topics` + `group_topics` enough? Does the
  desktop need webhook mode at all (public URL constraint) or polling only? Keep
  `EXPECTED_BACKEND_VERSION` in sync when Core changes telegram endpoints?

## 10. Test strategy

Parity tests (vitest) mirroring the Python suites:

- `connect.test.ts` ↔ `tests/gateway/test_telegram_connect.py`: missing token / missing SDK →
  non-retryable fatal error (`missing_dependency`/`missing_credentials`), no reconnect queueing.
- `webhook-secret.test.ts` ↔ `tests/gateway/test_telegram_webhook_secret.py`: webhook mode without
  `TELEGRAM_WEBHOOK_SECRET` refuses to start (fail-closed); polling branch has no secret guard;
  `X-Telegram-Bot-Api-Secret-Token` header validated on inbound webhook POSTs.
- `approval-buttons.test.ts` ↔ `tests/gateway/test_telegram_approval_buttons.py` (+
  `test_telegram_callback_auth_fail_closed.py`, `test_telegram_slash_confirm.py`,
  `test_telegram_clarify_buttons.py`, `test_telegram_model_picker.py`): `ea:*`/`sc:*`/`cl:*`
  keyboard payloads, short approval IDs, `_approval_state` lookup, unauthorized callback rejected,
  smart-denied variant omits Session/Always buttons.
- `voice-duration.test.ts` ↔ `tests/gateway/test_telegram_voice_duration.py` (+
- `voice-duration.test.ts` ↔ `tests/gateway/test_telegram_voice_duration.py` (+ `test_telegram_audio_vs_voice.py`,
  `test_telegram_voice_caption_markdown.py`, `test_telegram_voice_v0_regressions.py`): duration probe
  rounding (WAV fixture), `.ogg` → `sendVoice` duration, `.mp3` → `sendAudio` duration, omit on unknown; media-size guard.
- `topic-mode.test.ts` ↔ `tests/gateway/test_telegram_topic_mode.py` (+ `test_base_topic_sessions.py`,
  `test_telegram_forum_commands.py`, `test_telegram_prune_stale_topic_binding_31501.py`, `test_telegram_thread_fallback.py`):
  root-DM lobby, binding routing, `/topic` prereq check, `/new` binding rewrite, `ON DELETE CASCADE` pruning, `ignore_root_dm`, skill binding.
- `reactions.test.ts` ↔ `tests/gateway/test_telegram_reactions.py`: disabled by default;
  `setMessageReaction` args (normalized chat id, int message id, `ReactionType[]`); 👀 → ✅/❌
  swap; CANCELLED clears reaction.
- `polling-progress.test.ts` ↔ `tests/test_telegram_polling_progress_ptb.py` + `test_telegram_polling_progress.py`
  + `test_telegram_start_polling_timeout.py` + `test_telegram_network_reconnect.py`: fake grammY
  `ApiClient`/fetch asserting getUpdates progress, 409 conflict → replacement generation, heartbeat stuck escalation, send-path-degraded.
- `fallback-network.test.ts` ↔ `tests/gateway/test_telegram_network.py`: DoH discovery parse,
  seed-IP fallback, IP rewriting preserves Host/SNI, private-IP rejection, sticky-IP behavior.
- `markdown.test.ts` ↔ `tests/gateway/test_telegram_format.py`, `test_telegram_rich_messages.py`,
  `test_telegram_rich_newlines.py`, `test_telegram_reply_quote.py`: MarkdownV2 escape round-trip,
  fence-safe chunking, CJK newline handling, rich-message fallback.
- `telegram-settings.e2e.ts` (Playwright): enable Telegram via mocked
  `/api/messaging/platforms/telegram`, diagnostics bundle renders required keys, test button shows
  state; CI runs `pnpm typecheck` + `pnpm test:unit`; no network in unit tests (all
  grammY/fetch mocked).

## 11. Reference links

- Core source: `D:/hermes-agent-cn/plugins/platforms/telegram/{adapter.py,telegram_ids.py,telegram_network.py,plugin.yaml,__init__.py}`
- Core docs: `D:/hermes-agent-cn/website/docs/user-guide/messaging/telegram.md`
- Core state: `D:/hermes-agent-cn/hermes_state.py` (10784 `telegram_dm_topic_mode` /
  `telegram_dm_topic_bindings`; v1→v2 FK migration)
- Core REST: `D:/hermes-agent-cn/hermes_cli/web_server.py` (8568 catalog; PUT enable / POST
  test; `/api/messaging/telegram/onboarding/*` at 10036+)
- Core tests: `D:/hermes-agent-cn/tests/gateway/test_telegram_*.py` (~58 files; the six named:
  `test_telegram_connect.py`, `test_telegram_webhook_secret.py`, `test_telegram_approval_buttons.py`,
  `test_telegram_voice_duration.py`, `test_telegram_topic_mode.py`, `test_telegram_reactions.py`),
  `D:/hermes-agent-cn/tests/test_telegram_polling_progress_ptb.py`
- Desktop: `web/src/routes/settings.tsx`, `web/src/routes/im-onboarding.tsx`,
  `web/src/lib/im-onboarding-diagnostics.ts`, `web/src/lib/env-translations.ts`,
  `packages/protocol/src/channels.ts` (`ImPlatform = "feishu" | "weixin"`), `web/src/lib/transport.ts`,
  `web/src/lib/gateway-client.ts`
- Sibling plan: `D:/Hermes-CN-Desktop/plans/slack-platform.md` (same port-decision pattern),
  `D:/Hermes-CN-Desktop/plans/messaging-gateway-core.md` (`PlatformAdapter` contract)
- TS SDKs (new deps, not in kimi-code): https://github.com/grammyjs/grammY (recommended),
  https://github.com/telegraf/telegraf (alternative); Bot API docs:
  https://core.telegram.org/bots/api, https://github.com/tdlib/telegram-bot-api (local server)
