# DingTalk Messaging Platform Adapter — Python → TypeScript Rewrite Plan

## 1. Summary

DingTalk (钉钉) bot support is a gateway messaging-platform adapter in the Python
backend (`D:/hermes-agent-cn/plugins/platforms/dingtalk/`) that connects via
DingTalk **Stream Mode** (an outbound WebSocket to DingTalk's servers) and replies
through per-message **session webhooks** (markdown). Unlike Feishu/Weixin, DingTalk
**is already inside the desktop onboarding scope**: the React route
(`web/src/routes/im-onboarding.tsx`) reserves `/im/dingtalk` with a "coming soon"
placeholder, the Rust Tauri commands already carry a `ImPlatform::Dingtalk` variant
with `DINGTALK_ALLOWED_KEYS`/`DINGTALK_SECRET_KEYS`, and the source-meta/chip
(`web/src/lib/source-meta.ts:23`) already renders a "钉钉" badge. Therefore this
plan ports **both** the adapter runtime (Stream Mode + session-webhook replies) and
the desktop onboarding UI + diagnostics, and records the adapter port decision and
the WebSocket-removal implications.

**Adapter port decision (recorded):** Port the DingTalk adapter in-process into the
TypeScript desktop as `web/src/lib/platforms/dingtalk/` (Stream Mode client built on
the `ws` npm package + REST helpers built on `undici`/fetch), behind a
`PlatformAdapter` interface shared with future Feishu/Weixin adapters. The outbound
WebSocket to DingTalk's servers is **not** the local Python-runtime WS link targeted
for removal; it is a platform-facing connection that the TS in-process module must
own after the migration. Phase 1 keeps the Python gateway as the runtime owner and
only builds the onboarding UI/diagnostics; Phase 2 moves the runtime into TS; Phase 3
deletes the local Dashboard `/api/ws` + REST bridge.

**Key gap found during research:** kimi-code has **no TS equivalent** for the
DingTalk adapter — verified: zero `dingtalk` matches in `D:/kimi-code` source,
and no `dingtalk-stream-sdk-node` / `@dingtalk` packages in its node_modules.
The TS implementation must be built from scratch (thin protocol shim), reusing only
generic `ws` (present in `packages/klient` + `packages/kap-server` package.json) and
`undici` (present in `packages/agent-core` package.json).

## 2. Current Python implementation

Source of truth under `D:/hermes-agent-cn`:

- `plugins/platforms/dingtalk/__init__.py` — plugin entry, re-exports `register`.
- `plugins/platforms/dingtalk/plugin.yaml` — metadata: `name: dingtalk-platform`,
  requires `DINGTALK_CLIENT_ID` / `DINGTALK_CLIENT_SECRET`; optional
  `DINGTALK_WEBHOOK_URL`, `DINGTALK_ALLOWED_USERS`, `DINGTALK_HOME_CHANNEL`,
  `DINGTALK_HOME_CHANNEL_NAME`.
- `plugins/platforms/dingtalk/adapter.py` (~1930 lines) — the full adapter:
  - **Stream Mode client**: `connect()` builds `dingtalk_stream.Credential(client_id,
    client_secret)` + `DingTalkStreamClient` and registers
    `dingtalk_stream.ChatbotMessage.TOPIC` with `_IncomingHandler` (an async
    `ChatbotHandler.process`, converting `CallbackMessage.data` → `ChatbotMessage`).
    `_run_stream()` auto-reconnects with backoff `[2, 5, 10, 30, 60]`.
  - **Inbound**: `_on_message` → `_extract_text` (handles legacy dict text,
    `TextContent` >=0.20, `rich_text_content.rich_text_list`, audio recognition,
    file name, `card`/`interactiveCard` doc-link extraction), `_extract_media`
    (picture/richText/audio/video → `MessageType.PHOTO/VOICE/AUDIO/VIDEO/DOCUMENT`
    with `download_code`), group gating (`_should_process_message`:
    `require_mention` via SDK `is_in_at_list`, `mention_patterns`, `allowed_chats`,
    `free_response_chats`), `allowed_users` allowlist (case-insensitive
    staff_id/sender_id, `*` = any), 5-minute `MessageDeduplicator`.
  - **Outbound**: `send()` posts `{"msgtype":"markdown","markdown":{...}}` to the
    cached `session_webhook` (validated against
    `_DINGTALK_WEBHOOK_RE = ^https://(?:api|oapi)\.dingtalk\.com/`, cache max 500);
    `send_image`, `send_image_file`, `send_document`, `send_typing`; optional AI
    Cards via `alibabacloud_dingtalk.card_1_0` + emoji reactions via
    `robot_1_0` (`_create_and_stream_card`, `_close_streaming_siblings`,
    `_fire_done_reaction`); `MAX_MESSAGE_LENGTH = 20000`.
  - **Lifecycle**: `disconnect()` closes the websocket first, cancels the stream
    task and background tasks, finalizes streaming cards, closes httpx client,
    clears webhook/context/dedup caches.
  - **Setup**: `interactive_setup()` → QR device flow
    (`hermes_cli.dingtalk_auth.dingtalk_qr_auth`, note openClaw branding on the
    consent screen) or manual Client ID/Secret entry; `_apply_yaml_config()`
    bridges `config.yaml gateway.platforms.dingtalk.extra.*` → `DINGTALK_*` env.
  - **Registry**: `register(ctx)` declares `required_env`,
    `install_hint="pip install 'dingtalk-stream>=0.20' httpx"`,
    `allowed_users_env="DINGTALK_ALLOWED_USERS"`,
    `allow_all_env="DINGTALK_ALLOW_ALL_USERS"`,
    `cron_deliver_env_var="DINGTALK_HOME_CHANNEL"`, `standalone_sender_fn`,
    `emoji="🐳"`.
- Docs: `website/docs/user-guide/messaging/dingtalk.md` (283 lines) — Stream Mode
  recommended (no public URL), env var reference, `group_sessions_per_user`,
  `require_mention`, AI Cards, emoji reactions, display settings, troubleshooting
  (credentials, stream disconnects, "No session_webhook available").
- Tests: `tests/gateway/test_dingtalk.py` (767 lines) — requirements checks,
  adapter init from `extra`, dedup, `send()` markdown payload shape, `send_image`
  markdown image, connect/disconnect (missing SDK → False; disconnect finalizes
  streaming cards before HTTP close), webhook domain allowlist (api + oapi),
  `process` is a coroutine, `_extract_text` SDK-version shapes (TextContent,
  rich_text_content, card, interactiveCard), media extraction.

Desktop-side Python-adjacent plumbing already present in
`D:/Hermes-CN-Desktop/src/commands/im_onboarding.rs` (~2483 lines):

- `ImPlatform::Dingtalk` variant with `as_str()`, `allowed_keys()`, `secret_keys()`
  (lines 92–124). `DINGTALK_ALLOWED_KEYS` (41–54) includes CLIENT_ID, CLIENT_SECRET,
  ENCRYPT_KEY, WEBHOOK_HOST/PORT/PATH, ALLOW_ALL_USERS, ALLOWED_USERS, GROUP_POLICY,
  REQUIRE_MENTION, HOME_CHANNEL; `DINGTALK_SECRET_KEYS` = CLIENT_SECRET, ENCRYPT_KEY.
- `ImManualCredentials` already carries `client_id`/`client_secret` (149–158).
- `apply_patch_from_input` DingTalk branch (1341–1362) writes
  `DINGTALK_CLIENT_ID`/`DINGTALK_CLIENT_SECRET` from manual credentials;
  `validate_required` (1466–1476) requires non-empty `DINGTALK_CLIENT_ID`.
- `im_onboarding_begin`/`im_onboarding_poll` return
  `"钉钉接入正在开发中，请使用飞书或微信。"` for DingTalk (1773–1793) — **no QR
  device flow in Rust**.
- Rust tests (2382–2482): `dingtalk_apply_patch_populates_credentials`,
  `..._rejects_empty_client_id`, `..._rejects_missing_client_id`,
  `dingtalk_begin/poll_returns_not_available_error`.

## 3. Target TypeScript design

Module layout (in-process, runs in the Tauri webview after WS removal):

```
web/src/lib/platforms/
  types.ts            # PlatformAdapter interface + shared MessageEvent types
  dingtalk/
    client.ts         # DingTalk Stream Mode WebSocket client (protocol shim)
    auth.ts           # token/credential helpers (client_credentials token fetch)
    sessionWebhook.ts # markdown reply via session webhook (HTTP)
    media.ts          # media download via robot API + MIME mapping
    adapter.ts        # DingTalkAdapter implements PlatformAdapter
    index.ts          # factory + register()
web/src/lib/im-onboarding/      # generic onboarding UI state (replaces inline route code)
web/src/lib/im-onboarding-diagnostics.ts  # extend with dingtalk branch
packages/protocol/src/channels.ts         # extend ImPlatform + ImManualCredentials
src/commands/im_onboarding.rs             # (phase 1) keep; (phase 3) retire apply REST path
```

Key interfaces (pseudocode, not implementation):

```ts
interface PlatformAdapter {
  connect(opts: { clientId: string; clientSecret: string; encryptKey?: string }): Promise<void>;
  disconnect(): Promise<void>;
  onMessage(cb: (ev: MessageEvent) => void): void;
  send(chatId: string, content: string, metadata: { sessionWebhook?: string }): Promise<SendResult>;
  sendImage(chatId: string, url: string, caption?: string, metadata?: unknown): Promise<SendResult>;
  test(): Promise<{ ok: boolean; state?: string; message?: string }>;
}

interface DingTalkStreamMessage {   // mapped from DingTalk chatbot payload
  msgId: string; conversationId: string; conversationType: "1" | "2";
  senderId: string; senderStaffId: string; senderNick: string;
  text?: string; msgtype: string; isInAtList: boolean;
  sessionWebhook: string; sessionWebhookExpiredTime: number;
  extensions?: Record<string, unknown>;   // media download codes, card payloads
}
```

Data flow (in-process target):

1. Desktop settings store holds `DINGTALK_CLIENT_ID` / `DINGTALK_CLIENT_SECRET` (+
   optional allowlist/mention keys).
2. `DingTalkAdapter.connect()` opens `wss://wss-open.dingtalk.com/...` with
   HMAC-SHA256-signed frames (client_credentials access token for auth), registers a
   chatbot-topic handler.
3. Incoming frames are normalized to `MessageEvent` (text/media/audio/video/doc;
   `is_in_at_list` drives group gating), deduplicated (LRU of message ids, 5-min
   window parity), and routed to the local agent loop (in-process, no Python).
4. Replies POST markdown to the cached `sessionWebhook` (per-chat LRU ≤500, domain
   allowlist `api|oapi.dingtalk.com`, 20k char cap). Optional AI Cards/emoji are
   REST calls to `open.dingtalk.com` robot/card APIs (phase 3 stretch).
5. `test()` performs a lightweight credential check via the token endpoint
   (mirrors `_is_connected` semantics) so the onboarding UI can run "检测连接".

## 4. Data models & persistence

- **Config keys** (parity with Rust `DINGTALK_ALLOWED_KEYS` + plugin.yaml):
  required `DINGTALK_CLIENT_ID`, `DINGTALK_CLIENT_SECRET`; optional
  `DINGTALK_ENCRYPT_KEY`, `DINGTALK_WEBHOOK_URL`, `DINGTALK_ALLOWED_USERS`,
  `DINGTALK_ALLOW_ALL_USERS`, `DINGTALK_REQUIRE_MENTION`, `DINGTALK_GROUP_POLICY`,
  `DINGTALK_HOME_CHANNEL`, `DINGTALK_HOME_CHANNEL_NAME`,
  `DINGTALK_WEBHOOK_HOST/PORT/PATH` (webhook-mode reserved).
- **Persistence strategy (migration-aware):** Phase 1 keeps writing to the Python
  runtime `.env` via the existing Rust `im_onboarding_apply` (unchanged behavior).
  Phase 2 introduces a TS-owned settings store (SQLite via Rust-side
  `src/commands/*` or JSON under the app data dir) seeded from `.env`; the
  `PlatformAdapter` reads only from the TS store. Phase 3 drops `.env` writes.
  Secrets stay redacted end-to-end (`ImRedactedValue` + fingerprint pattern from
  `im_onboarding.rs:redacted()`).
- **Session/conversation state:** no durable persistence in the adapter itself —
  sessions belong to the agent loop (existing session store). In-memory only:
  `sessionWebhooks: Map<chatId, {url, expiresAtMs}>` (max 500),
  `dedup: LRU<msgId, timestamp>` (5-min window), `messageContexts: Map<chatId, msg>`
  for AI Card routing. No SQLite schema change required; note this in migration docs.
- **Protocol types to extend** (`packages/protocol/src/channels.ts`):
  - `ImPlatform = "feishu" | "weixin" | "dingtalk"` (line 491) — **required**,
    currently missing `"dingtalk"`.
  - `ImManualCredentials` (559–566) — add `clientId?: string; clientSecret?: string`
    to match Rust (149–158); otherwise the UI cannot pass DingTalk credentials.
  - `ImCredentialSummary` — add `clientId?: ImRedactedValue | null;
    clientSecret?: ImRedactedValue | null` for parity with
    `CredentialSummary` in Rust.

## 5. Third-party library strategy

| Python dependency | TS equivalent | kimi-code evidence / status |
|---|---|---|
| `dingtalk-stream>=0.20` (Stream Mode WebSocket + frame protocol, HMAC-SHA256) | **Implement from scratch**: `ws` client + thin protocol shim (topic subscribe, ack, heartbeat, reconnect) | `ws: ^8.18.0` in `packages/klient/package.json:53` and `packages/kap-server/package.json:40`; `new WebSocket` used in kap-server tests. **No `dingtalk-stream-sdk-node` / `@dingtalk` anywhere in kimi-code node_modules — verified absent.** No DingTalk code in kimi-code at all (0 matches). |
| `httpx` (async HTTP for session webhook replies, media download) | `undici` / Node `fetch` | `undici: ^7.27.1` in `packages/agent-core/package.json:102` and `agent-core-v2:86`. Desktop renderer already uses fetch (`web/src/lib/transport.ts`). |
| `alibabacloud-dingtalk` (AI Cards `card_1_0`, robot `robot_1_0`, OpenAPI models) | **Implement from scratch** as plain REST helpers (token fetch → card create/update, emoji reaction, media download) | No Alibaba Cloud SDK in kimi-code. Stretch/optional (parity for AI Cards + emoji); core MVP needs only session-webhook markdown replies. |
| `orjson` (payload parsing) | Built-in `JSON.parse` | n/a (kimi-code uses std JSON). |
| `re` (mention patterns) | JS `RegExp` | Used throughout kimi-code (e.g. `apps/kimi-code/src/utils`). |
| QR device flow (`hermes_cli.dingtalk_auth`) | `qrcode` npm (already in desktop) + OAuth device-flow REST | `qrcode` already imported in `web/src/routes/im-onboarding.tsx:3`. Optional phase; Rust has no DingTalk QR flow today. |

**"No TS equivalent found" risks (explicit):**

1. **DingTalk Stream Mode protocol shim is fully from scratch.** kimi-code proves only
   the generic `ws` client exists; the DingTalk-specific frame format (handshake,
   topic subscription, ack codes, reconnect/backoff) must be reverse-engineered from
   the Python SDK behavior in `adapter.py` and captured in vitest fixture tests.
   Risk: undocumented protocol drift on DingTalk's side; mitigation: keep the shim
   behind `DingTalkStreamClient` interface and write fixture-based tests mirroring
   `test_dingtalk.py` SDK-compat regression tests.
2. **No TS DingTalk REST/OpenAPI SDK** — token endpoint + media/card endpoints must be
   hand-rolled; the Python SDK's auth/region defaults should be replicated
   (`region_id = "central"`, `protocol = "https"`).
3. **AI Cards + emoji reactions are optional and high-effort** (two Alibaba SDKs in
   Python); recommend shipping markdown-webhook replies first and marking cards as a
   phase-3 stretch with explicit user-facing "plain markdown" fallback.
4. **QR device-flow onboarding has no Rust/Tauri precedent** (begin/poll return 开发中
   today) and the Python flow has the openClaw consent branding caveat; recommend
   manual credential entry for MVP and revisit QR as optional phase 3.

## 6. Integration with existing Hermes-CN-Desktop frontend

- **Route**: replace the `DingtalkRoute()` placeholder
  (`web/src/routes/im-onboarding.tsx:1298-1311`) with a real `DingtalkRoute`
  (manual Client ID/Secret form + optional advanced settings), reusing the existing
  Feishu/Weixin page chrome (`SectionShell`, `MetaStrip`, `Field`, `ActionFeedback`,
  `FlowSteps`, `statusText`, `openExternal`).
- **Hooks**: reuse `use-im-onboarding.ts` as-is (it is platform-agnostic:
  `useImOnboardingState`, `useApplyImOnboarding`, `useMessagingPlatform`,
  `useTestMessagingPlatform`, `useBegin/usePollImOnboarding` — begin/poll will keep
  erroring until QR flow is implemented, so MVP hides the QR path).
- **Protocol** (`packages/protocol/src/channels.ts`): add `"dingtalk"` to
  `ImPlatform` and `clientId/clientSecret` to `ImManualCredentials` (see §4) —
  this is a hard prerequisite for the UI.
- **Diagnostics** (`web/src/lib/im-onboarding-diagnostics.ts`): add
  `dingtalk: ["DINGTALK_CLIENT_ID", "DINGTALK_CLIENT_SECRET"]` to
  `DIAGNOSTIC_REQUIRED_KEYS` (line 105), a `dingtalk` entry to
  `DIAGNOSTIC_POLICY_KEYS` (line 110), a `platform === "dingtalk"` branch in
  `explainMessagingFailure` (client_id/secret errors, stream disconnect/reconnect,
  allowlist-empty warning, no-session-webhook), and update
  `buildImDiagnosticPrompt` to add DingTalk guidance.
- **Rust commands** (`src/commands/im_onboarding.rs`): keep the existing
  `ImPlatform::Dingtalk` apply path; add nothing for MVP (begin/poll stay
  not-available). Phase 3 retires these commands once the in-process adapter owns
  config + runtime.
- **Existing chips**: `web/src/lib/source-meta.ts:23` and
  `web/src/routes/history.module.css:607` already define `dingtalk` tone/label — no
  change needed; ensures history source chips render correctly once messages exist.

## 7. Removing the WebSocket dependency (migration path)

Important clarification to record: there are **two distinct WebSockets**:

- **(A) Local Python-runtime WS link** — Dashboard `/api/ws` JSON-RPC bridge that
  this rewrite program removes. DingTalk never needs this after the port.
- **(B) DingTalk Stream Mode WS** — an outbound connection from the machine to
  `wss-open.dingtalk.com` that is the DingTalk bot's receive path. It must remain
  after the rewrite; the TS in-process adapter simply owns it directly.

Freeze surface during migration (must keep identical semantics):

- Config keys: `DINGTALK_CLIENT_ID`, `DINGTALK_CLIENT_SECRET` (+ the allowed-keys
  list) — values must round-trip between `.env` (phase 1) and TS store (phase 2).
- Adapter behavioral contract: markdown session-webhook replies,
  `api|oapi.dingtalk.com` webhook allowlist, 20k char cap, 5-min dedup, group
  `require_mention` via `isInAtList`, allowlist semantics, reconnect backoff.
- Runtime status shape (`MessagingPlatformInfo.state` values: connected / disabled /
  not_configured / pending_restart / gateway_stopped / error) surfaced to the UI.

Phases:

1. **P1 — Desktop onboarding UI only (Python still owns runtime).** Add protocol
   types, real `DingtalkRoute` (manual credentials), diagnostics branch, reuse
   `/api/messaging/platforms/dingtalk/test` for "检测连接". WS link (A) untouched.
2. **P2 — In-process TS adapter behind `PlatformAdapter`.** Implement
   `web/src/lib/platforms/dingtalk/*` (stream client, session webhook, media),
   add a `settings` page/store for `DINGTALK_*`, run adapter in the Tauri webview
   process, keep Python gateway as fallback toggle (`DINGTALK_RUNTIME=python|ts`).
   Local WS (A) still used for other features; DingTalk stops depending on it.
3. **P3 — Delete the WS/REST path.** Remove `/api/ws` + REST messaging bridge for
   DingTalk, retire `im_onboarding_begin/poll/apply` DingTalk arms (or the whole
   command), delete Python adapter after full in-process parity.

## 8. Migration phases & task breakdown

- **Phase 1 — Onboarding UI + diagnostics (no runtime port):**
  - [ ] `packages/protocol`: add `"dingtalk"` to `ImPlatform`; add
        `clientId/clientSecret` to `ImManualCredentials`; extend
        `ImCredentialSummary` (update Rust-schema parity).
  - [ ] `im-onboarding.tsx`: implement `DingtalkRoute` (manual credential form,
        advanced settings accordion, test button, save+restart) reusing Feishu/
        Weixin components.
  - [ ] `im-onboarding-diagnostics.ts`: add dingtalk required/policy keys,
        `explainMessagingFailure` branch, prompt guidance.
  - [ ] Rust: keep apply path; add unit tests for protocol schema parity.
  - [ ] Manual QA: save Client ID/Secret → gateway restart → "检测连接" ok.
- **Phase 2 — In-process TS runtime (`web/src/lib/platforms/dingtalk/`):**
  - [ ] `client.ts` stream shim (ws, HMAC-SHA256, topic subscribe, ack, heartbeat,
        reconnect backoff `[2,5,10,30,60]`).
  - [ ] `adapter.ts` implements `PlatformAdapter` (normalize messages, dedup LRU,
        group gating, allowlist, webhook cache ≤500, 20k cap, domain allowlist).
  - [ ] `sessionWebhook.ts` + `media.ts` (fetch download codes → files; optional).
  - [ ] TS settings store (SQLite/JSON) seeded from `.env`; runtime toggle.
  - [ ] Wire adapter output into the in-process agent loop/session store.
  - [ ] Status surface: map adapter state → `MessagingPlatformInfo` shape.
- **Phase 3 — Remove WS/REST dependency:**
  - [ ] Migrate all `DINGTALK_*` reads to TS store; delete `.env` write path.
  - [ ] Remove DingTalk from the Python gateway dependency for desktop users
        (docs + feature flag default to TS runtime).
  - [ ] Delete `/api/ws` bridge + REST test/status endpoints for DingTalk;
        retire `im_onboarding_begin/poll/apply` DingTalk arms.
  - [ ] Optional stretch: AI Cards + emoji reactions (REST), QR device-flow
        onboarding in TS.

## 9. Risks & open questions

- **No TS SDK**: DingTalk Stream Mode protocol shim is from scratch; risk of
  undocumented server behavior. Mitigation: fixture-based tests + reconnect logic
  ported from `_run_stream`; keep Python adapter behind a toggle until parity proven.
- **Protocol type gap**: `ImPlatform` and `ImManualCredentials` in
  `packages/protocol` must be extended before any UI work — currently they would
  reject `"dingtalk"` and `clientId` at compile time.
- **AI Cards/emoji parity**: requires hand-rolled REST against two Alibaba OpenAPI
  surfaces; recommend deferring (open question: is card parity a release blocker?).
- **QR device flow**: Python's flow depends on `hermes_cli.dingtalk_auth` and has
  openClaw consent branding; Rust returns 开发中. Open question: ship manual
  credentials only, or port the device flow to TS (needs QR + polling endpoints)?
- **Config ownership**: `.env` is Python-runtime config; moving to a TS store must
  be seamless for existing users who configured DingTalk in the CLI. Keep `.env`
  read-only migration path in phase 2.
- **DingTalk webhook-mode keys** (`DINGTALK_WEBHOOK_HOST/PORT/PATH`,
  `DINGTALK_ENCRYPT_KEY`) appear in Rust allowed keys but the adapter is
  stream-only; decide whether to expose them in the UI as reserved/advanced.
- **Session isolation**: `group_sessions_per_user` is a Core config behavior the
  in-process agent loop must preserve when consuming DingTalk group messages.

## 10. Test strategy

- **Vitest unit (parity with `test_dingtalk.py`)**:
  - Stream frame parsing: `_extract_text` equivalents for `TextContent`-style
    objects, `rich_text_content.rich_text_list`, `card`, `interactiveCard` — mirror
    `TestExtractText`.
  - `send()` payload shape: `{msgtype:"markdown", markdown:{title,text}}`;
    `send_image` → `Screenshot\n\n![image](...)` — mirror `TestSend`.
  - Webhook domain allowlist (`api` + `oapi.dingtalk.com`, reject lookalikes) —
    mirror `TestWebhookDomainAllowlist`.
  - Dedup 5-min window, webhook cache eviction (>500), 20k truncation,
    reconnect backoff sequence.
  - Group gating matrix: DM always, group @mention, mention pattern, allowed_chats,
    free_response_chats, allowlist wildcard.
- **Integration (vitest + mock `ws` server)**: spin a local `ws` server speaking the
  shimmed frame protocol; assert connect → subscribe → inbound message → reply POST
  to a mocked webhook endpoint (undici `MockAgent`).
- **Playwright E2E**: `/im/dingtalk` route renders the manual form; empty → validation
  error; save writes redacted values; "检测连接" shows ok/error; diagnostics bundle
  contains dingtalk required keys and expected issues.
- **Parity gate**: run `tests/gateway/test_dingtalk.py` against the Python adapter
  and the TS unit suite side-by-side; document any behavioral divergence in the plan
  review before phase 3 deletion.

## 11. Reference links

- Python adapter: `D:/hermes-agent-cn/plugins/platforms/dingtalk/adapter.py`,
  `__init__.py`, `plugin.yaml`
- Python docs: `D:/hermes-agent-cn/website/docs/user-guide/messaging/dingtalk.md`
- Python tests: `D:/hermes-agent-cn/tests/gateway/test_dingtalk.py`
- Desktop route: `D:/Hermes-CN-Desktop/web/src/routes/im-onboarding.tsx`
  (DingtalkRoute placeholder at lines 1298–1311, dispatch 1313–1321)
- Desktop diagnostics: `D:/Hermes-CN-Desktop/web/src/lib/im-onboarding-diagnostics.ts`
- Desktop hooks: `D:/Hermes-CN-Desktop/web/src/hooks/use-im-onboarding.ts`
- Desktop Rust: `D:/Hermes-CN-Desktop/src/commands/im_onboarding.rs`
  (DingTalk constants 41–54, apply 1341–1362, validate 1466–1476, begin/poll 1773–1793,
  tests 2382–2482)
- Desktop protocol: `D:/Hermes-CN-Desktop/packages/protocol/src/channels.ts`
  (ImPlatform line 491, ImManualCredentials 559–566),
  `packages/protocol/src/hermes-api.ts` (MessagingPlatformInfo 127–144)
- TS reference (kimi-code): `packages/klient/package.json:53`,
  `packages/kap-server/package.json:40` (`ws ^8.18.0`);
  `packages/agent-core/package.json:102` (`undici ^7.27.1`);
  no DingTalk references anywhere in `D:/kimi-code` (verified 0 matches,
  no `dingtalk-stream-sdk-node` / `@dingtalk` in node_modules)
- Plans conventions: `D:/Hermes-CN-Desktop/plans/README.md`,
  `D:/Hermes-CN-Desktop/plans/_PROMPT_TEMPLATE.md`
