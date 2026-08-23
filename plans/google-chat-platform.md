# Google Chat Messaging Platform Adapter — Python → TypeScript Rewrite Plan

> Port decision recorded up front: **Google Chat is a gateway-side messaging platform adapter and is
> marked "out of scope for desktop standalone"** (per `plans/README.md`). For v1 the Desktop keeps
> talking to the Core managed-runtime gateway over REST (`/api/messaging/platforms`) and the Dashboard
> WS (`/api/ws`) and does **not** host the Google Chat bot in-process. This file still designs the
> in-process TS port (Sections 3–10) so the decision is recorded and a future standalone build can pick
> it up without re-research.

## 1. Summary

Hermes-CN-Core ships a Google Chat bot adapter (`plugins/platforms/google_chat/`, `adapter.py` ≈3,742
LOC) built on the Python `google-cloud-pubsub` + `google-api-python-client` + `google-auth` stack. It
supports **two inbound transports** (Cloud Pub/Sub pull subscription and authenticated HTTP callbacks
via Google-signed ID-token bearer verification), **outbound Chat REST API** (`chat.googleapis.com`),
a patch-in-place "Hermes is thinking…" typing marker (avoids the "message deleted" tombstone),
Markdown→Chat-dialect formatting, DM main-flow vs side-thread session isolation (persisted thread
counts), Card v2 clarify buttons, SSRF-hardened inbound attachment download, and per-user OAuth native
attachment delivery (`/setup-files`, because `media.upload` rejects service-account auth).

The Desktop currently has **no** Google Chat-specific UI: it only echoes
`status.gateway_platforms["google_chat"]` in the Settings debug card and lists Google Chat in the
managed runtime's `/api/messaging/platforms` catalog. **Verified: no TS equivalent exists in
`D:/kimi-code`** — no `@googleapis/chat`, no `googleapis`, no `@google-cloud/pubsub`; the only
Google npm packages are `@google/genai` (Gemini provider) and its transitive `google-auth-library`.
The plan records the v1 decision (keep in Python gateway; expose config/status in Desktop via REST)
plus the full in-process design for the record.

## 2. Current Python implementation

Source of truth: `D:/hermes-agent-cn`

| Path | Role |
|---|---|
| `plugins/platforms/google_chat/adapter.py` (3,742 lines) | `GoogleChatAdapter(BasePlatformAdapter)` — everything: SA/ADC auth, connect (Pub/Sub + HTTP modes), envelope parsing, outbound send/edit/delete/typing/clarify, attachments, retry, supervisor |
| `plugins/platforms/google_chat/oauth.py` (695 lines) | user-OAuth helper (CLI + library) for native attachment upload: token store, refresh, `--install-deps`, `/setup-files` backing |
| `plugins/platforms/google_chat/plugin.yaml` (50 lines) | manifest: `requires_env: GOOGLE_CHAT_SERVICE_ACCOUNT_JSON`; optional `GOOGLE_CHAT_HTTP_EVENTS_URL/_AUDIENCE/_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_CHAT_PROJECT_ID`, `GOOGLE_CHAT_SUBSCRIPTION_NAME`, `GOOGLE_CHAT_ALLOWED_USERS`, `GOOGLE_CHAT_HOME_CHANNEL` |
| `plugins/platforms/google_chat/__init__.py` (3 lines) | `from .adapter import register` |
| `hermes_cli/web_server.py` (line 8680) | `/api/messaging/platforms` catalog entry `google_chat` (name, description, docs_url); GET (10256), PUT `{platform_id}` (10351, with `_multiplex_port_binding_conflict` 10300), POST `{platform_id}/test` (10422) |
| `website/docs/user-guide/messaging/google_chat.md` (414 lines) | GCP/Pub/Sub setup, HTTP-callback config, formatting limits, thread semantics, `/setup-files`, security notes |
| `tests/gateway/test_google_chat.py` (1,746 lines) | registration, env loading, config validation, 3 envelope formats, HTTP ingress + ID-token verify, connect modes, chunking, typing patch-in-place, send/edit/delete, SSRF guard, thread store, retry, format_message, per-user attachment routing, supervisor reconnect, allowlist, cron registry, standalone send |

Key implementation blocks inside `adapter.py`:

- **Deferred heavy imports** (`_load_google_modules`, 131): lazy import of `google.cloud.pubsub_v1`,
  `googleapiclient.discovery.build`, `google.oauth2.service_account`, `google_auth_httplib2` etc.
  (~110 ms / ~33 MB RSS saved on every CLI invocation); `check_google_chat_requirements()` (297) is the
  canonical availability probe.
- **Auth** (`_load_sa_credentials`, 767): inline JSON / path from `GOOGLE_CHAT_SERVICE_ACCOUNT_JSON`
  or `GOOGLE_APPLICATION_CREDENTIALS`, falling back to ADC (`google.auth.default`); scopes `chat.bot` +
  `pubsub` (`_CHAT_SCOPES`, 224).
- **Two inbound modes** (`connect`, 989): Pub/Sub pull with a reconnect supervisor (`_run_supervisor`,
  1184; exponential backoff, fatal after 10 attempts) **or** authenticated HTTP callbacks
  (`dispatch_http_event`, 1499; `verify_http_event_request`, 1524 — Google-signed ID token verified
  against `GOOGLE_CHAT_HTTP_EVENTS_AUDIENCE` and expected SA email, with a TTL-cached cert request,
  `_CachedGoogleAuthRequest`, 81).
- **Envelope parsing** (`_extract_message_payload`, 1258): three formats — Workspace Add-ons
  (`chat.messagePayload`), native Chat API Pub/Sub (`type=MESSAGE` top-level), and relay/flat
  (synthesized Chat-API shape); BOT sender self-filter, `MessageDeduplicator` for at-least-once.
- **Event normalization** (`_build_message_event`, 1817): `user_id = sender_email` (allowlist
  canonical), `user_id_alt = users/{id}` resource name, DM main-flow vs side-thread heuristic driven by
  the persisted `_ThreadCountStore` (515) at `~/.hermes/google_chat_thread_counts.json`; slash
  commands; attachment download + MIME→`MessageType` mapping.
- **Outbound** (`send`, 2061): 4000-char chunking (`_chunk_text`, 2366), typing card patch-in-place
  (no delete tombstone), `messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD` quirk
  (`_create_message`, 2579), `send_typing`/`stop_typing`/`on_processing_complete` orphan-card reaping
  (2631–2825), `edit_message` (2259), `delete_message` (2304), retry wrapper `_call_with_retry` (2533;
  429/5xx/timeout with jittered backoff).
- **Formatting** (`format_message`, 2406): Markdown subset conversion (`**bold**`→`*bold*`,
  `[t](u)`→`<u|t>`, headers→bold) with code-block placeholder protection and invisible-Unicode
  (ZWJ/variation-selector) stripping.
- **Cards** (`card_spec_to_cards_v2`, 475): generic card spec → Card v2 widgets; `send_clarify`
  (2192) builds a button card with "Other / type answer".
- **Attachments**: inbound `_download_attachment` (1943) via `media.download` bot path or
  Google-owned-host allowlisted `downloadUri` (SSRF guard `_is_google_owned_host`, 325); outbound
  `_send_file` (3113) via user-OAuth `media.upload` + `messages.create` (fallback text notice
  `_post_attachment_fallback`, 3263); per-user token routing `_acquire_user_chat_api` (3050) and
  `/setup-files` handler (1593).
- **Standalone cron send** (`_standalone_send`, 3526): raw aiohttp POST to
  `https://chat.googleapis.com/v1/{chat_id}/messages` with a refreshed SA bearer (no SDK) so
  `deliver=google_chat` cron works out-of-process; chat_id validated against
  `^(?:spaces|users)/[A-Za-z0-9_-]+$` (3523).
- **Registration** (`register`, 3678): name `google_chat`, `max_message_length=4000`,
  `cron_deliver_env_var="GOOGLE_CHAT_HOME_CHANNEL"`, `standalone_sender_fn=_standalone_send`,
  `allowed_users_env/allowed_all_env`, platform hint for the agent's system prompt.

Docs key behaviors (`google_chat.md`): Pub/Sub pull = no public URL needed; HTTP callback mode requires
a public HTTPS endpoint and `GOOGLE_CHAT_HTTP_EVENTS_*` env; 4000-char message limit; limited markdown
subset; thread support with per-thread sessions; `/setup-files` per-user OAuth (`chat.messages.create`
scope only) for native attachments; `media.upload` hard-rejects SA auth; security notes (SSRF
allowlist, redaction, profile-scoped client secret).

## 3. Target TypeScript design

**Port decision (recorded):** keep the adapter in the Python gateway for v1; the Desktop only adds a
config/status surface (Section 6). The in-process design below is the "if ported" target.

Proposed module layout under `web/src/platforms/google-chat/` (or `packages/google-chat/` for reuse):

```
web/src/platforms/google-chat/
  adapter.ts      # GoogleChatAdapter — implements the gateway PlatformAdapter interface
  config.ts       # loadConfig(env) -> settings + validation (mirror _validate_config / plugin.yaml)
  auth.ts         # service-account JWT + ADC via google-auth-library; ID-token verify + cert TTL cache
  rest-client.ts  # thin typed Chat REST client (messages create/patch/delete, spaces.get,
                  #   members.list, media.download, media.upload) or @googleapis/chat wrapper
  events.ts       # inbound normalization: 3 envelope formats -> MessageEvent
                  #   {platform:'google_chat', chat_id:'spaces/X', user_id:email, user_id_alt:users/{id}}
  http-ingress.ts # Express/Fastify route (or Tauri localhost HTTP server) + bearer verification
  pubsub-ingress.ts# @google-cloud/pubsub subscriber (optional; pull + ack/nack + reconnect supervisor)
  format.ts       # markdown -> Chat dialect + invisible-Unicode strip (port of format_message)
  cards.ts        # card_spec_to_cards_v2 port (clarify Card v2 + "Other / type answer")
  thread-routing.ts# DM main-flow vs side-thread heuristic + ThreadCountStore (JSON persistence)
  attachments.ts  # SSRF host allowlist + media.download bot path + cache; media.upload user-OAuth path
  user-oauth.ts   # /setup-files flow: OAuth URL, code exchange, per-user token store
  dedup.ts        # MessageDeduplicator (TTL map)
  diagnostics.ts  # ImDiagnosticBundle-style builder for a Google Chat settings panel
  registry.ts     # registerAdapter(registry) — analogue of register()
  index.ts
```

Data flow (in-process, no Python):

```
webview (React) -> GoogleChatAdapter.connect() -> auth.ts (SA JWT / ADC)
  -> inbound: http-ingress.ts (Google-signed HTTPS POST, verify bearer)
       |       |-- pubsub-ingress.ts (optional pull, CloudEvents envelope)
       v
  events.ts -> dedup.ts -> thread-routing.ts -> MessageEvent
  -> agent runtime (in-process TS loop) -> adapter.send()/editMessage()/sendTyping()/sendClarify()
  -> rest-client.ts -> chat.googleapis.com
  -> attachments.ts -> media.download (bot) | media.upload via user-oauth.ts (per-user token)
```

Key interfaces (pseudocode):

```ts
interface PlatformAdapter {
  connect(opts?: { isReconnect?: boolean }): Promise<boolean>;
  disconnect(): Promise<void>;
  send(chatId: string, content: string, opts?: { replyTo?: string; metadata?: MsgMetadata }): Promise<SendResult>;
  editMessage(chatId: string, messageId: string, content: string): Promise<SendResult>;
  deleteMessage(chatId: string, messageId: string): Promise<boolean>;
  sendTyping(chatId: string, metadata?: MsgMetadata): Promise<void>;
  sendClarify(chatId: string, question: string, choices: string[], opts?: { metadata?: MsgMetadata }): Promise<SendResult>;
  sendImage / sendImageFile / sendDocument / sendVoice / sendVideo / sendAnimation(...): Promise<SendResult>;
  onMessage(handler: (event: MessageEvent) => Promise<ProcessingOutcome>): void;
  getStatus(): PlatformStatus; // connected | not_configured | error + error_code/message
}
```

## 4. Data models & persistence

Config (env → settings; mirror `plugin.yaml` + `adapter.py` + docs):

| Env var | Default | Meaning |
|---|---|---|
| `GOOGLE_CHAT_SERVICE_ACCOUNT_JSON` | — (required) | SA JSON path or inline JSON; falls back to `GOOGLE_APPLICATION_CREDENTIALS`, then ADC |
| `GOOGLE_CHAT_HTTP_EVENTS_URL` / `_AUDIENCE` / `_SERVICE_ACCOUNT_EMAIL` | empty / =URL / empty | HTTP callback mode (public HTTPS endpoint; audience + expected SA email for bearer verification) |
| `GOOGLE_CHAT_PROJECT_ID` / `GOOGLE_CHAT_SUBSCRIPTION_NAME` | empty (fallback `GOOGLE_CLOUD_PROJECT`/`GOOGLE_CHAT_SUBSCRIPTION`) | Pub/Sub pull mode; path must match `projects/<p>/subscriptions/<s>` |
| `GOOGLE_CHAT_ALLOWED_USERS` / `GOOGLE_CHAT_ALLOW_ALL_USERS` | empty | DM allowlist (emails match `user_id`) |
| `GOOGLE_CHAT_HOME_CHANNEL` (+ `_NAME`) | empty | cron/notification delivery target (`spaces/…`) |
| `GOOGLE_CHAT_MAX_MESSAGES` / `GOOGLE_CHAT_MAX_BYTES` | 1 / 16 MiB | Pub/Sub FlowControl |
| `GOOGLE_CHAT_BOOTSTRAP_SPACES` | empty | extra spaces for bot-user_id resolution |
| `typing_status_text` (config.yaml) | "Hermes is thinking…" | typing marker text; `typing_indicator: false` disables |

Persisted state (Python paths → TS strategy):

- `~/.hermes/google_chat_thread_counts.json` — DM thread-count store; TS keeps the same JSON file
  (written via a small Rust command or `packages/minidb`); write-through after every `incr`; corrupt
  file → fresh start (non-fatal, parity with `_ThreadCountStore.load`).
- `~/.hermes/google_chat_bot_id.json` — bot `users/{id}` cache; same JSON file.
- `~/.hermes/google_chat_user_tokens/<sanitized_email>.json` + legacy
  `google_chat_user_token.json`, `google_chat_user_client_secret.json`,
  `google_chat_user_oauth_pending*/` — per-user OAuth for native attachments; TS keeps file layout,
  0o600 semantics via Rust write; never store in webview storage.
- In-memory only: `MessageDeduplicator` TTL (reconnect redelivery), `_last_inbound_thread` /
  `_last_sender_by_chat` caches, `_typing_messages` slots, `_user_creds_by_email` /
  `_user_chat_api_by_email` caches.
- No durable message store: Google Chat is the source of truth; session identity lives in the gateway
  session store (unchanged in v1).

## 5. Third-party library strategy

**Most important section.** Verified kimi-code state:

- Repo-wide grep for `google chat`, `google-chat`, `@googleapis/chat`, `GoogleChat`, `google_chat` →
  **0 matches**.
- Grep for `googleapis|@google` → 22 files, **all Google GenAI (Gemini provider)**: 
  `packages/kosong/src/providers/google-genai.ts`, `packages/kosong/test/e2e/google-genai-adapter.test.ts`,
  `packages/agent-core-v2/src/kosong/provider/bases/google-genai/google-genai.ts`,
  `docs/{zh,en}/configuration/providers.md`.
- Workspace deps: `@google/genai@^1.49.0` in `packages/kosong/package.json:47` and
  `packages/agent-core-v2/package.json:60`; `google-auth-library@10.6.2` present only as a transitive
  dep of `@google/genai` (`node_modules/.pnpm/google-auth-library@10.6.2/...`).
- **No** `@googleapis/chat`, **no** `googleapis`, **no** `@google-cloud/pubsub` anywhere
  (`node_modules/.pnpm/@googleapis*` absent; `pnpm-lock.yaml` hits = 0).

| Python dependency | TS equivalent | kimi-code evidence / decision |
|---|---|---|
| `google-api-python-client` (`googleapiclient.discovery.build("chat","v1")`) | **`@googleapis/chat`** (official Google REST SDK) — or hand-rolled `rest-client.ts` on `fetch` | **none** — new dependency. Recommended: add `@googleapis/chat` (typed, maintained); the adapter only touches a small surface (`spaces.messages.create/patch/delete`, `spaces.get`, `spaces.members.list`, `media.download`, `media.upload`) so a from-scratch typed client is a viable fallback. |
| `google-auth` (SA JWT, ADC, `id_token.verify_oauth2_token`) | **`google-auth-library`** (`GoogleAuth`, `JWT`, `OAuth2Client.verifyIdToken`) | present in kimi-code only as transitive dep of `@google/genai` (`google-auth-library@10.6.2`); add as a direct dependency. Port `_CachedGoogleAuthRequest` TTL cache (5 min) for the cert fetch. |
| `google-cloud-pubsub` (pull subscription, FlowControl, ack/nack) | **`@google-cloud/pubsub`** (official TS SDK) — optional | **none** — new dependency. Recommend **HTTP callback mode first** for standalone (plain HTTPS POST + bearer verify, no extra SDK); Pub/Sub pull adds streaming/reconnect complexity and needs the SDK. |
| `google-auth-httplib2` + `httplib2` (`AuthorizedHttp`) | Node `fetch`/`undici` with `Authorization: Bearer <token>` header | n/a — kimi-code has no equivalent shim; `rest-client.ts` refreshes the SA token before each request. |
| `aiohttp` (webhook server + standalone send) | Node `http`/`express`/`fastify` or Tauri localhost command | kimi-code `packages/kap-server` has HTTP infra; reuse patterns. |
| `orjson` | `JSON.stringify`/`JSON.parse` + Zod (`packages/protocol`) | n/a. |
| `re`-based markdown converter (`format_message`) | **implement from scratch as `format.ts`** | no kimi-code Chat-dialect converter; port regexes + placeholder protection + invisible-Unicode strip directly (parity with `TestFormatMessage`). |
| Card v2 builder (`card_spec_to_cards_v2`, `_widget_to_chat`) | **implement from scratch as `cards.ts`** | no kimi-code Card v2 code; small pure port. |
| `gateway.platforms.helpers.MessageDeduplicator`, `cache_*_from_bytes` | **implement from scratch** (TTL Map; cache to temp dir) | kimi-code has TTL-cache patterns but nothing platform-specific. |
| SSRF-safe attachment fetch (`_is_google_owned_host`, redirect guard) | **implement from scratch in `attachments.ts`** | kimi-code has no SSRF-safe fetch shim (only generic `fetch`); port the Google-owned-host allowlist + https-only preflight. |
| OAuth flow for native upload (`oauth.py`; `chat.messages.create` scope) | `google-auth-library` `OAuth2Client` (authorization code → refresh token) + `user-oauth.ts` | kimi-code has OAuth infra (`packages/oauth` — PKCE/device code per README); reuse its token-storage patterns, but the Google user-OAuth consent flow is new. |

**"No TS equivalent found" risks:** no Google Chat adapter in kimi-code; `@googleapis/chat`,
`@google-cloud/pubsub` (if needed) and direct `google-auth-library` must be **new dependencies**;
attachment upload requires the per-user OAuth flow (no simple drop-in); ID-token verification needs a
cert-cache shim; Pub/Sub pull semantics (ack/nack, redelivery dedup, reconnect supervisor) need
careful porting.

## 6. Integration with existing Hermes-CN-Desktop frontend

Existing surface (verified by reading):

- `web/src/routes/settings.tsx` (line 1478–1488) — DebugCard "Dashboard / Gateway" already renders
  every `status.gateway_platforms` entry generically (`{name, state, error_message}`), so a configured
  `google_chat` platform shows up today with zero new code. A new Google Chat settings panel can follow
  the same card pattern.
- `web/src/hooks/use-im-onboarding.ts` — `useMessagingPlatform` (GET `/api/messaging/platforms` →
  find by id) and `useTestMessagingPlatform` (POST `/api/messaging/platforms/{id}/test`) are generic
  and reusable for Google Chat.
- `packages/protocol/src/hermes-api.ts` (127–160) — `MessagingPlatformInfo` /
  `MessagingPlatformTestResponse` already cover `google_chat` (id/name/enabled/configured/
  gateway_running/state/error_code/error_message/home_channel/env_vars).
- `web/src/lib/im-onboarding-diagnostics.ts` (450 lines) — `buildImDiagnosticBundle` is the template
  for a new `google-chat-diagnostics.ts`: required keys `GOOGLE_CHAT_SERVICE_ACCOUNT_JSON`,
  HTTP-mode keys `GOOGLE_CHAT_HTTP_EVENTS_URL/_AUDIENCE/_SERVICE_ACCOUNT_EMAIL`, policy keys
  `GOOGLE_CHAT_ALLOWED_USERS`/`GOOGLE_CHAT_HOME_CHANNEL`; failure classifier keywords (bearer/401/403,
  pubsub, 4000-char limit, `/setup-files`).
- `web/src/lib/transport.ts` + `web/src/lib/gateway-client.ts` — all REST/status reads must go through
  them (auth injection), never raw fetch.
- `packages/protocol/src/channels.ts` (line 491) — `ImPlatform = "feishu" | "weixin"`; **do not add
  Google Chat here** — Google Chat is not a QR-code onboarding flow.

Reuse / don't-touch plan:

- **Reuse**: settings.tsx platform-list card; `useMessagingPlatform`/`useTestMessagingPlatform`;
  `MessagingPlatformInfo` schema; transport layer; diagnostics builder pattern.
- **Add (v1, optional)**: a Google Chat settings/status panel (e.g. `/settings/platforms/google-chat`)
  that lists env vars, shows gateway state from `status.gateway_platforms.google_chat`, runs the REST
  `test` endpoint, and renders `google-chat-diagnostics.ts` issues.
- **Do NOT extend** `web/src/routes/im-onboarding.tsx` or `src/commands/im_onboarding.rs`: those are
  feishu/weixin/dingtalk QR flows; Google Chat config is GCP-console + `.env` based, handled by the
  managed runtime's `interactive_setup` / REST PUT. No new Rust command needed in v1.

## 7. Removing the WebSocket dependency (migration path)

Two distinct "WebSockets" must not be confused:

1. **Dashboard WS link** (`/api/ws` JSON-RPC in `web/src/lib/gateway-client.ts`) — the webview ↔
   managed Python runtime link this rewrite program removes.
2. **Google Chat inbound** — Pub/Sub pull (a streaming RPC, not WS) or HTTPS webhook; **neither is a
   WebSocket**, so unlike Feishu there is no platform-level WS to remove. This is a point in Google
   Chat's favor for a future standalone build.

**Port decision + implications (recorded):**

- Near term (recommended): Google Chat remains a managed-runtime messaging adapter (permitted "out of
  scope for desktop standalone"); the Dashboard WS link must **stay for messaging-platform status** as
  long as messaging platforms ship in the Desktop. Removing the WS link entirely requires one of:
  (a) dropping messaging platforms from standalone, (b) porting adapters in-process (this plan's §3
  design), or (c) keeping a minimal managed runtime purely for messaging.
- API surface to freeze during any migration (must keep working whether Google Chat lives in the
  Python gateway or in-process):
  1. `GET /api/messaging/platforms` → catalog incl. `google_chat`;
  2. `PUT /api/messaging/platforms/google_chat` (enable + env_vars; honors
     `_multiplex_port_binding_conflict`);
  3. `POST /api/messaging/platforms/google_chat/test`;
  4. `MessagingPlatformInfo`/`MessagingPlatformTestResponse` schemas;
  5. env var names (`GOOGLE_CHAT_*`) and `.env` file layout.
- If/when the in-process port happens: webview talks to `GoogleChatAdapter` through Tauri IPC instead
  of REST/WS; secrets move to OS keychain via Rust; HTTP callback mode needs a public HTTPS URL (or a
  tunnel / Cloud Run) because Google will not POST to localhost; Pub/Sub pull mode needs
  `@google-cloud/pubsub` and GCP credentials on the host. Then delete the Python REST/WS paths for
  Google Chat.

## 8. Migration phases & task breakdown

- **Phase 0 — decision record (this plan):** no code. Confirm Google Chat message plane stays in the
  managed Python gateway (v1) and the Desktop only surfaces config/status via REST.
- **Phase 1 — Desktop config/status UI (v1, recommended):** add `google-chat-diagnostics.ts` (port of
  `buildImDiagnosticBundle` patterns; required/policy env keys, gateway platform state, test result);
  add a Google Chat settings panel reusing `useMessagingPlatform`/`useTestMessagingPlatform` +
  `MessagingPlatformInfo`; no TS adapter code, no new Rust commands.
- **Phase 2 — optional in-process TS adapter:** add `@googleapis/chat` + `google-auth-library`
  (direct) deps; implement `config.ts`/`auth.ts`/`rest-client.ts`/`events.ts`/`format.ts`/`cards.ts`/
  `thread-routing.ts`/`dedup.ts`/`attachments.ts`; ship **HTTP callback inbound first** (plain HTTPS +
  bearer verify), Pub/Sub pull via `@google-cloud/pubsub` later; freeze the §7 API surface behind the
  adapter registry; parity tests vs the Python suite.
- **Phase 3 — WS removal (only if standalone ships):** switch webview from REST/WS to Tauri IPC for
  Google Chat status/config; secret handling via Rust keychain; delete Python paths once nothing else
  consumes them.

## 9. Risks & open questions

- **No TS equivalent in kimi-code:** `@googleapis/chat` (and optionally `@google-cloud/pubsub`) must be
  new dependencies — dependency-addition decision needed; a from-scratch `rest-client.ts` is the
  fallback but loses upstream type updates.
- **Inbound hosting:** HTTP callback mode requires a public HTTPS endpoint (Google won't call
  localhost); Pub/Sub pull mode requires GCP credentials + the pubsub SDK. Standalone desktop needs
  either a tunnel/Cloud Run or the Pub/Sub SDK — open question which the product wants.
- **Native attachments:** `media.upload` rejects SA auth; per-user OAuth (`/setup-files`) is a
  multi-step in-chat consent flow. v1 of any in-process port could ship text-only fallback notices
  (parity with Python when no token exists).
- **ID-token verification** needs the Google cert-fetch TTL cache to avoid rate limits; token
  audience/email mismatch semantics must match `verify_http_event_request`.
- **Pub/Sub pull semantics:** ack/nack, at-least-once redelivery, dedup, and the reconnect supervisor
  (fatal after 10 attempts) are subtle; a naive port can silently drop or duplicate messages.
- **DM thread heuristic:** the persisted thread-count store drives session isolation; parity bugs here
  leak context across threads (the exact bug the Python code documents).
- **Card v2 interactivity (`CARD_CLICKED`)** is deliberately NOT implemented in Python v1 — keep out of
  scope for TS v1 too; clarify cards fall back to text on send failure.
- **API quirks:** `messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD` must be set whenever a
  thread name is included; `messages.patch` cannot change `thread` (immutable) — typing cards must be
  created in the resolved thread; delete creates tombstones, so patch-in-place is the norm.
- **Open question:** should `ImPlatform` union (channels.ts) ever grow a non-QR variant, or should
  Google Chat live purely under `MessagingPlatformInfo`? Recommend the latter for v1.

## 10. Test strategy

Parity targets from `tests/gateway/test_google_chat.py` (cite class → vitest equivalent):

- **Unit (vitest):**
  - `format.ts` — port every `TestFormatMessage` case (bold, links, headers, code-block protection,
    ZWJ/variation-selector stripping).
  - `cards.ts` — widget/card conversion + validation errors (`TestHelpers` / card builder).
  - `events.ts` — the three envelope formats (`TestExtractMessagePayload`: workspace_addons,
    native_chat_api, relay_flat) + BOT self-filter (`test_relay_flat_bot_sender_is_filtered_end_to_end`).
  - `config.ts` — missing subscription raises, project/subscription mismatch
    (`TestValidateConfig`), HTTP-mode skips pubsub (`TestConnectModes`).
  - `thread-routing.ts` — `TestThreadCountStore` (missing/corrupt file → fresh), DM first/second
    message main-flow vs side-thread (`TestBuildMessageEvent`), outbound cached-thread fallback
    (`TestOutboundThreadRouting`).
  - `attachments.ts` — `_is_google_owned_host` allowlist (`TestGoogleOwnedHost`), SSRF reject
    (`TestAttachmentSSRFGuard`).
  - `rest-client.ts` — retry classification/backoff (`TestOutboundRetry`), `_chunk_text`
    (`TestChunkText`), standalone send URL/bearer (`TestGoogleChatStandaloneSend`).
  - `user-oauth.ts` — email sanitize + per-user token routing/revoke (`TestUserOAuthHelper`,
    `TestPerUserAttachmentRouting`).
  - `auth.ts` — ID-token verify audience/email + cert-cache TTL (`TestHttpEventIngress`).
- **Integration (vitest, mocked fetch/HTTP):** HTTP callback ingress end-to-end with a fake signed
  bearer; Pub/Sub callback ack/nack + dedup; typing marker create→patch→sentinel lifecycle;
  edit/delete; allowlist email match (`TestAuthorizationEmailMatch`).
- **Playwright E2E (Desktop):** settings panel shows `google_chat` platform state; REST `test` flow;
  diagnostics bundle renders issues (ported `buildImDiagnosticBundle` fixtures).
- **Parity note:** Python tests shim the google-* modules; TS tests should shim `fetch`/`rest-client`
  the same way so the suite runs without GCP credentials.

## 11. Reference links

- Python adapter: `D:/hermes-agent-cn/plugins/platforms/google_chat/adapter.py`
- Python OAuth helper: `D:/hermes-agent-cn/plugins/platforms/google_chat/oauth.py`
- Plugin manifest: `D:/hermes-agent-cn/plugins/platforms/google_chat/plugin.yaml`
- Docs: `D:/hermes-agent-cn/website/docs/user-guide/messaging/google_chat.md`
- Tests: `D:/hermes-agent-cn/tests/gateway/test_google_chat.py`
- Feature inventory: `D:/hermes-agent-cn/features_report.md` (line 138)
- Managed-runtime REST catalog: `D:/hermes-agent-cn/hermes_cli/web_server.py` (8680, 10256, 10351,
  10422)
- Desktop settings debug card: `D:/Hermes-CN-Desktop/web/src/routes/settings.tsx` (1478–1488)
- IM onboarding diagnostics template: `D:/Hermes-CN-Desktop/web/src/lib/im-onboarding-diagnostics.ts`
- IM onboarding hooks: `D:/Hermes-CN-Desktop/web/src/hooks/use-im-onboarding.ts`
- Protocol schemas: `D:/Hermes-CN-Desktop/packages/protocol/src/hermes-api.ts` (127–160),
  `D:/Hermes-CN-Desktop/packages/protocol/src/channels.ts` (491)
- kimi-code Google evidence: `packages/kosong/src/providers/google-genai.ts`,
  `packages/kosong/package.json:47`, `packages/agent-core-v2/package.json:60`,
  `node_modules/.pnpm/google-auth-library@10.6.2` (transitive only; no `@googleapis/chat`)
- Google Chat REST API reference:
  https://developers.google.com/workspace/chat/api/reference/rest/v1/spaces.messages/create
