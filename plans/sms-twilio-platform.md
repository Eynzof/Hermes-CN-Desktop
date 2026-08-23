# SMS (Twilio) Messaging Platform Adapter — Python → TypeScript Rewrite Plan

## 1. Summary

- Feature: **SMS (Twilio) messaging platform adapter** — send SMS via the Twilio
  REST API, receive SMS via a Twilio webhook, enforce Twilio request signature
  validation, allowlist users, strip markdown for plain-text delivery, and
  deliver cron/notification messages to a configured home channel.
- **Port decision (recorded):** messaging platform adapters are **gateway-side** —
  they live in the Python runtime process (`D:/hermes-agent-cn`), not in the
  Desktop React UI. The Twilio adapter specifically runs an **inbound HTTP
  webhook server** (`SMS_WEBHOOK_PORT`/`SMS_WEBHOOK_URL`) plus a REST client.
  Therefore the end-state TypeScript design must host the adapter **in-process
  in the TS runtime** and move the webhook listener into the **Rust Tauri
  process** (a browser webview cannot bind TCP ports). During the migration the
  adapter continues to run in the managed Python gateway; the port only flips
  when the in-process TS runtime takes over the gateway loop.
- **WS-removal implications:** inbound SMS arrives over **HTTP POST** (Twilio
  webhook), not over the Desktop `/api/ws` WebSocket. SMS has no native
  long-poll/socket dependency. Removing the WS link affects the SMS feature only
  through the shared surface it rides on: `/api/messaging/platforms`
  (info/status/test), `/api/status` `gateway_platforms`, and the agent
  message-processing loop that turns inbound `MessageEvent`s into replies. All
  of these must be re-served from in-process state in the end-state.
- **Media caveat (parity gap):** the feature title includes "media", but the
  current Python adapter has **no MMS/media support** — `send()` only posts
  `Body`, and `_handle_webhook` ignores `NumMedia`/`MediaUrl*`. The plan keeps
  this parity: no media in v1, with an explicit open question about minimal MMS
  passthrough later.
- **TS reference:** `D:/kimi-code` has **no Twilio or SMS implementation**
  (verified: zero `twilio` matches in source/package.json/lockfile, and no
  `twilio` directory under `node_modules/.pnpm`). Recommended TS dependency is
  the official **`twilio` npm SDK** (REST client + `validateRequest` signature
  helper + TypeScript types); the HTTP server side reuses Fastify/Hono patterns
  already present in kimi-code (`packages/kap-server` uses Fastify 5).

## 2. Current Python implementation

Source of truth (all under `D:/hermes-agent-cn`):

| Path | Role |
|---|---|
| `plugins/platforms/sms/adapter.py` (536 lines) | `SmsAdapter(BasePlatformAdapter)`, webhook handler, signature validation, `_standalone_send`, plugin `register()` |
| `plugins/platforms/sms/__init__.py` | exports `register` |
| `plugins/platforms/sms/plugin.yaml` | `sms-platform` manifest; `requires_env` = SID/AUTH_TOKEN/PHONE_NUMBER; optional `SMS_ALLOWED_USERS`, `SMS_HOME_CHANNEL` |
| `gateway/config.py` | `Platform.SMS` enum; `_apply_env_overrides` seeds `PlatformConfig` from `TWILIO_ACCOUNT_SID` (api_key = `TWILIO_AUTH_TOKEN`), `SMS_HOME_CHANNEL` → `home_channel` (name via `SMS_HOME_CHANNEL_NAME`, thread via `SMS_HOME_CHANNEL_THREAD_ID`) |
| `gateway/platforms/base.py` | `BasePlatformAdapter`, `MessageEvent` (incl. `media_urls`/`media_types`), `MessageType`, `SendResult` |
| `hermes_cli/web_server.py` | `/api/messaging/platforms` catalog built from plugin registry; `_PLATFORM_OVERRIDES["sms"]`; `_platform_env_prefixes["sms"] = ("TWILIO_",)`; `_PLATFORM_DEFAULT_PORTS["sms"] = ("webhook_port", 8080)` |
| `hermes_cli/plugins.py` | `ctx.register_platform(...)` registry API used by `register()` |
| `tools/send_message_tool.py` | calls plugin `standalone_sender_fn` for one-shot/cron SMS (`_PHONE_PLATFORMS` includes `sms`) |
| `website/docs/user-guide/messaging/sms.md` (+ zh-Hans) | setup guide, env table, security, troubleshooting |
| `tests/gateway/test_sms.py` (323 lines) | parity test source (see §10) |

Key data flow (current Python):

1. **Outbound:** `SmsAdapter.send(chat_id, content)` → `format_message`
   (`strip_markdown`) → `truncate_message` (chunks ≤ `MAX_SMS_LENGTH = 1600`,
   ~10 segments) → HTTP POST `https://api.twilio.com/2010-04-01/Accounts/{sid}/Messages.json`
   with `Authorization: Basic base64(sid:auth_token)` and form fields
   `From`/`To`/`Body` → returns `SendResult(message_id=body.sid)`. Proxy-aware
   via `resolve_proxy_url()`/`proxy_kwargs_for_aiohttp()`.
2. **Inbound:** aiohttp app listens on `SMS_WEBHOOK_HOST:SMS_WEBHOOK_PORT`
   (`127.0.0.1:8080` defaults), route `POST /webhooks/twilio` (+ `GET /health`):
   - 64 KiB body cap (`_TWILIO_WEBHOOK_MAX_BODY_BYTES`, `client_max_size` + read
     check) → 413;
   - form-encoded `parse_qs`; if `SMS_WEBHOOK_URL` set, verify
     `X-Twilio-Signature` (HMAC-SHA1 over `url + sorted(key+value)` with
     default-port variant handling, `hmac.compare_digest`) → 403 on missing/invalid;
   - `SMS_INSECURE_NO_SIGNATURE=true` skips validation (dev only);
   - extract `From`/`To`/`Body`/`MessageSid`; echo-prevention: ignore
     `From == TWILIO_PHONE_NUMBER`;
   - build `MessageEvent(text, MessageType.TEXT, source=chat_id=From, raw_message=form,
     message_id=MessageSid)` and dispatch non-blocking
     `asyncio.create_task(self.handle_message(event))`;
   - reply is always the empty TwiML `<?xml version="1.0" encoding="UTF-8"?><Response></Response>`
     (content-type `application/xml`) — replies go out via REST, never inline TwiML.
3. **Fail-closed startup:** `connect()` refuses to start without
   `SMS_WEBHOOK_URL` (fatal `sms_missing_webhook_url`, non-retryable) and without
   `TWILIO_PHONE_NUMBER` (fatal `sms_missing_phone_number`).
4. **One-shot/cron delivery:** `_standalone_send(pconfig, chat_id, message, *,
   thread_id=None, media_files=None, force_document=False)` re-implements the
   same POST; returns `{"success": True, "platform": "sms", "chat_id": ..., "message_id": ...}`
   or `{"error": ...}`. `media_files` is accepted but **ignored** (no media).
5. **Registry:** `register(ctx)` with `required_env = [TWILIO_ACCOUNT_SID,
   TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER]`, `allowed_users_env =
   SMS_ALLOWED_USERS`, `allow_all_env = SMS_ALLOW_ALL_USERS`,
   `cron_deliver_env_var = SMS_HOME_CHANNEL`, `max_message_length = 1600`,
   `pii_safe=True` (phone redaction), `emoji="📱"`.

Environment variables (from adapter + docs): `TWILIO_ACCOUNT_SID` (required),
`TWILIO_AUTH_TOKEN` (required), `TWILIO_PHONE_NUMBER` (required),
`SMS_WEBHOOK_URL` (required unless insecure dev), `SMS_WEBHOOK_PORT` (8080),
`SMS_WEBHOOK_HOST` (127.0.0.1), `SMS_INSECURE_NO_SIGNATURE`,
`SMS_ALLOWED_USERS`, `SMS_ALLOW_ALL_USERS`, `SMS_HOME_CHANNEL`,
`SMS_HOME_CHANNEL_NAME`, `SMS_HOME_CHANNEL_THREAD_ID`.

## 3. Target TypeScript design

End-state layout (in-process TS runtime + Rust OS-level networking):

```
packages/messaging/                    # NEW workspace package (runtime-agnostic)
  src/platforms/sms/
    adapter.ts          # SmsAdapter class: send(), connect/disconnect, getChatInfo
    signature.ts        # validateTwilioSignature(url, params, signature) — node:crypto
    webhook.ts          # parseTwilioForm(body) -> InboundSms | null
    format.ts           # stripMarkdownForSms(), chunkSms()
    config.ts           # loadSmsConfig(env) -> SmsConfig (fail-closed validation)
    types.ts            # SmsConfig, InboundSms, SmsSendResult
  src/types.ts          # MessagingPlatformAdapter interface (shared with other platforms)
web/src/lib/gateway/sms/               # Desktop glue (status cards, diagnostics)
src/commands/sms.rs                    # NEW Rust Tauri command module
src/process/sms_webhook.rs             # Rust webhook listener (tokio/tiny_http or axum)
```

Key interfaces (pseudocode — no implementation):

```ts
interface MessagingPlatformAdapter {
  id: "sms";
  connect(ctx: GatewayContext): Promise<AdapterHealth>;   // fail-closed like Python
  disconnect(): Promise<void>;
  send(input: SendInput): Promise<SendResult>;            // { ok, messageId?, error? }
  formatMessage(content: string): string;                 // strip markdown
  getChatInfo(chatId: string): { name: string; type: "dm" };
}

interface SmsConfig {
  accountSid: string;
  authToken: string;
  fromNumber: string;               // E.164
  webhookUrl: string;               // required (unless insecure dev flag)
  webhookPort: number;              // default 8080
  webhookHost: string;              // default 127.0.0.1
  insecureNoSignature: boolean;
  allowedUsers: string[] | null;    // null = allow all (SMS_ALLOW_ALL_USERS)
  homeChannel: string | null;
}
```

In-process data flow (end-state, no Python):

1. `SmsAdapter` lives inside the TS agent runtime; `connect()` registers an
   inbound route handler with the **Rust webhook server** (the Tauri process
   binds `SMS_WEBHOOK_HOST:SMS_WEBHOOK_PORT` via `sms_webhook.rs` and streams
   parsed form payloads into the TS runtime through a Tauri IPC event/command,
   e.g. `smsWebhookEvent`). The webview-only TS code never binds sockets.
2. Outbound `send()` calls the Twilio REST API from the TS runtime. In Tauri,
   outbound network calls can go through the existing Rust `api_request`
   command or direct `fetch` in the runtime process (the runtime is not the
   renderer, so CSP does not apply); the interface stays the same so the Python
   gateway and TS runtime are swappable.
3. Inbound `InboundSms` → same `MessageEvent`-shaped object the rest of the
   agent loop consumes (`{ text, type: "text", source: { chatId: fromNumber },
   messageId, raw }`); reply is routed back through `SmsAdapter.send()`.
4. Status: adapter health/state/error_code (`sms_missing_webhook_url`,
   `sms_missing_phone_number`) is published to the in-process state store that
   now feeds both `/api/status`-equivalent data and the Settings debug card.

## 4. Data models & persistence

- **Platform config:** credentials stay in the profile `.env`
  (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`, `SMS_*`)
  exactly as today — the Desktop already writes `.env` through
  `src/commands/im_onboarding.rs` (`parse_env`/env write + redacted values) and
  the Core `PUT /api/messaging/platforms/{id}` endpoint. Reuse that seam; do not
  invent a new secret store in v1. In the end-state, the Tauri command
  `smsApplySettings` writes the same keys so the Python gateway and TS runtime
  agree on one config file.
- **Sessions:** Python keys each inbound phone number to its own Hermes session
  (`chat_id = From` E.164, `chat_type = dm`). Persist as `{ platform: "sms",
  chatId, sessionId, updatedAt }` in the existing session store (IndexedDB in
  renderer today; SQLite via Rust when the runtime moves in-process). No SMS
  schema migration is required; SMS is just another source with `chatId` being a
  phone number.
- **Messages/transcript:** reuse the existing session-log/transcript format —
  SMS events carry `messageId = MessageSid` for idempotent dedup on webhook
  retries (Twilio retries webhooks on non-2xx; the 200-empty-TwiML response plus
  `MessageSid` dedup is the parity behavior to preserve).
- **Home channel / cron:** `SMS_HOME_CHANNEL` (+ name/thread) maps to the same
  `HomeChannel` model already in `MessagingHomeChannel`
  (`packages/protocol/src/hermes-api.ts`); persist alongside platform config.

## 5. Third-party library strategy

| Python dependency | TS equivalent | Evidence / rationale |
|---|---|---|
| `aiohttp` (webhook server + REST client) | **`twilio` npm SDK** for the REST/signature half; **Fastify 5** or **Hono 4** for the webhook HTTP server (or Rust-side listener in Tauri) | kimi-code has **no twilio** (verified absent in source, all `package.json`s, `pnpm-lock.yaml`, and `node_modules/.pnpm`). `packages/kap-server/package.json` uses `fastify@^5.1.0` (+ `@fastify/multipart`); store also has `hono@4.12.14`, `fastify@5.8.5`, `express@5.2.1`, `form-data@4.0.6`. The official `twilio` package is the ecosystem-standard choice: `client.messages.create()`, `validateRequest()` (Twilio's own HMAC-SHA1 webhook validation), and bundled TS types. In Tauri end-state the listener itself should live in Rust (`tiny_http`/`axum`/`tokio`) since only the Rust process can bind a port; TS then only parses/validates. |
| `pybase64` / `base64.b64encode` | `Buffer.from(`${sid}:${token}`).toString("base64")` (node:crypto/Buffer) | Node built-in; no dependency. |
| `hmac` / `hashlib.sha1` (signature validation) | `node:crypto.createHmac("sha1", authToken)` + `crypto.timingSafeEqual` | Node built-in; mirrors `hmac.compare_digest`. If using the `twilio` SDK, `validateRequest` covers this plus the default-port URL variant. |
| `urllib.parse.parse_qs` / `urlparse` | `URLSearchParams` (for form body) + `new URL(url)` (for port-variant logic) | Node built-ins. |
| `aiohttp.FormData` | `URLSearchParams` body (Twilio accepts `application/x-www-form-urlencoded`) or `form-data` package | `form-data@4.0.6` present in kimi-code store; simpler to use `URLSearchParams` since Twilio's API accepts form-encoded POST. |
| `strip_markdown` (gateway/platforms/helpers.py regexes) | **Implement from scratch** as `stripMarkdownForSms()` — same regex set (bold/italic/code/headings/links/newline collapse) | kimi-code has markdown ecosystems (`markdown-it@14.2.0`, `marked@9.1.6`, `unified`, `remark`, `micromark`) but a full parser is overkill and would change behavior; a ~20-line regex port gives exact parity with Python `_strip_markdown_for_sms`. |
| `aiohttp.ClientSession(timeout=30, trust_env)` (proxy support) | Node `fetch` with proxy-agent or kimi-code's proxy helper; **or** keep `trust_env` semantics via `undici`/`global-agent` | Python honors `HTTP_PROXY`/`HTTPS_PROXY` via `trust_env`; TS equivalent is a small proxy-aware fetch wrapper (kimi-code has proxy utilities in `apps/kimi-code/src/utils/*` — treat as reference, verify exact module during implementation). |

**Decision:** add the official `twilio` npm package to the new `packages/messaging`
workspace; keep a thin `SmsHttpClient` interface so a hand-rolled `fetch` shim can
replace it (useful for vitest mocks and for running without the SDK). No
equivalent exists in kimi-code — this is a net-new third-party dependency, which
is acceptable because Twilio's SDK is the de-facto TS client and removes
signature-validation/typing risk.

## 6. Integration with existing Hermes-CN-Desktop frontend

Reuse (already present in `D:/Hermes-CN-Desktop`):

- `web/src/routes/im-onboarding.tsx` — the `/im/*` wizard route
  (`app.tsx:129`). Add an `sms` section: `ImSection` today is
  `"feishu" | "weixin" | "dingtalk"` (`im-onboarding.tsx:52`); extend it with
  `"sms"` and map `/im/sms`. SMS onboarding is **manual-form** (no QR flow):
  render `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_PHONE_NUMBER` +
  optional `SMS_WEBHOOK_URL` / `SMS_WEBHOOK_PORT` / `SMS_ALLOWED_USERS` /
  `SMS_HOME_CHANNEL` fields and a "test connection" button.
- `web/src/hooks/use-im-onboarding.ts` — reuse `useImOnboardingState`,
  `useApplyImOnboarding`, `useMessagingPlatform`, `useTestMessagingPlatform`.
  SMS needs a **manual credentials path** (`ImManualCredentials` currently has
  no Twilio fields — extend with `accountSid?`, `authToken?`, `fromNumber?`) and
  an env-key allowlist for `settings` (`TWILIO_*`/`SMS_*`).
- `web/src/lib/im-onboarding-diagnostics.ts` — `ImDiagnosticBundle` is generic,
  but `DIAGNOSTIC_REQUIRED_KEYS` / `DIAGNOSTIC_POLICY_KEYS` / platformLabel /
  `explainMessagingFailure` are feishu/weixin-only (`platform: ImPlatform` type
  at `channels.ts:491`). Add an `"sms"` arm: required keys =
  `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`; policy keys =
  `SMS_ALLOWED_USERS`, `SMS_ALLOW_ALL_USERS`, `SMS_HOME_CHANNEL`; failure hints
  for `sms_missing_webhook_url`, `sms_missing_phone_number`, Twilio API 4xx/5xx,
  port-in-use (`SMS_WEBHOOK_PORT`), and signature/forged-webhook warnings.
- `packages/protocol/src/channels.ts` — extend `ImPlatform` to include
  `"sms"` (or introduce `PlatformId = ImPlatform | "sms" | ...`), and extend
  `ImManualCredentials` / `ImOnboardingApplyInput.settings` typing.
- `packages/protocol/src/hermes-api.ts` — `MessagingPlatformInfo` /
  `MessagingPlatformTestResponse` already fit SMS (`id: "sms"`); no schema
  change needed, only the `env_vars` contents from Core's catalog.
- `web/src/routes/settings.tsx` (lines 1478-1488) — the DebugCard
  `gateway_platforms` list already renders any platform state generically; no
  change required, but the SMS card should redact phone numbers (`pii_safe`).
- `src/commands/im_onboarding.rs` — existing `.env` parse/write + redacted-value
  helpers are the template for a new `sms` Tauri command (`smsApplySettings`)
  and later the Rust webhook listener (`src/process/sms_webhook.rs`).
- `components/app-shell/gateway-sidebar.tsx` — add a "短信接入" link
  (`/im/sms`) alongside 飞书接入/微信接入; `use-active-top-tab.ts` already
  matches `/im` to the gateway tab.

## 7. Removing the WebSocket dependency (migration path)

SMS is a **webhook/REST** platform, so it never used `/api/ws` directly. The WS
link matters only because the agent loop, platform state, and messaging REST
surface currently live in the Python gateway. Phased freeze surface:

- **Phase A (today):** SMS runs in the managed Python gateway. Desktop UI calls
  `/api/messaging/platforms` (GET/PUT/test) + `/api/status` over HTTP and reads
  the WS stream for live state. Keep this path unchanged.
- **Phase B (interface freeze):** define the in-process
  `MessagingPlatformAdapter` interface (§3) and a `SmsAdapter` implementation
  that can run **either** in Python (via the existing plugin) **or** in TS
  behind the same contract. Freeze the wire contracts:
  `MessagingPlatformInfo`, `MessagingPlatformTestResponse`, `PlatformStatus`
  (`gateway_platforms`), env-key set (`TWILIO_*` + `SMS_*`), and the
  `MessageEvent` shape (text/type/source/messageId/raw).
- **Phase C (in-process):** the TS runtime owns the adapter; `SmsAdapter`
  connects to the Rust webhook listener via IPC; the agent loop consumes SMS
  events from the in-process bus; `useMessagingPlatform` and the Settings card
  read in-process state instead of `/api/messaging/platforms` + `/api/status`.
- **Phase D (delete WS/REST path):** once all platforms are in-process, remove
  the Desktop's dependency on Python `/api/ws` and the messaging REST routes.
  SMS-specific consequence: the `SMS_WEBHOOK_URL` validation and fail-closed
  startup move into TS; the Rust listener replaces `aiohttp.web`; nothing else
  in SMS depends on WS, so the WS teardown itself is platform-agnostic.

## 8. Migration phases & task breakdown

1. **P0 — Parity unit module (TS):** `packages/messaging/src/platforms/sms/`
   with `format.ts` (`stripMarkdownForSms`, `chunkSms`), `signature.ts`
   (`validateTwilioSignature` incl. default-port variant), `config.ts`
   (fail-closed validation mirroring `connect()` fatal errors). Unit tests port
   `tests/gateway/test_sms.py` cases (§10).
2. **P1 — HTTP client + send:** `SmsHttpClient` (twilio SDK behind interface) +
   `SmsAdapter.send()` chunk loop + `SendResult` mapping + redaction. Verify
   with mock fetch against the Python parity vectors (`sid`, error `message`).
3. **P2 — Webhook inbound:** `webhook.ts` form parser + echo-prevention + 64 KiB
   cap + empty-TwiML response shape; bind to Rust listener
   (`src/process/sms_webhook.rs`, new Tauri IPC event) in a dev flag; or first
   verify against a local Node http server mirroring `aiohttp.web` behavior.
4. **P3 — Desktop onboarding UI:** extend `/im/sms` route, `ImPlatform`,
   `ImManualCredentials`, diagnostics bundle, sidebar link; wire
   `useMessagingPlatform`/`useTestMessagingPlatform`/`useApplyImOnboarding` for
   `TWILIO_*`/`SMS_*` keys; add Rust `smsApplySettings` command if the REST PUT
   path is insufficient in end-state.
5. **P4 — Cron/home-channel + standalone send:** `SMS_HOME_CHANNEL` delivery
   through the same one-shot `sendSms` used by cron tools (parity with
   `_standalone_send`); port `media_files` signature but keep it a no-op with a
   documented TODO (Python parity).
6. **P5 — In-process flip + WS removal:** move adapter into the in-process
   runtime bus; freeze interfaces (§7); delete Python messaging REST/WS usage
   only after every platform is migrated.

## 9. Risks & open questions

- **No TS equivalent found:** no Twilio/SMS code exists in kimi-code; the
  official `twilio` npm SDK is a **net-new dependency**. Risk is low (standard
  client) but it must be justified in review; the `SmsHttpClient` seam keeps a
  `fetch`-only fallback.
- **Media/MMS is a parity gap in Python itself.** The spec says "media", but the
  Python adapter ignores `NumMedia`/`MediaUrl*` and `media_files`. Open question:
  add minimal MMS inbound (parse `MediaUrl*`, hydrate `media_urls`/`media_types`,
  cache/download in Rust) as a small superset, or keep v1 parity (no media) and
  document it. Outbound MMS is impractical from a desktop (Twilio needs public
  `MediaUrl`) — recommend out of scope for v1.
- **Webhook reachability:** SMS inbound requires a **public URL** pointed at the
  desktop (tunnel/cloudflared/ngrok) — a desktop app is not always reachable.
  Python parity: `SMS_WEBHOOK_URL` required + `SMS_INSECURE_NO_SIGNATURE` dev
  escape hatch. Open: how the UI guides users through tunnel setup.
- **Port conflicts / CSP:** `SMS_WEBHOOK_PORT=8080` collides with common dev
  servers; Rust listener must report `EADDRINUSE` as a friendly fatal error.
  Outbound requests from the Rust-side runtime must not be blocked by webview
  CSP (they are not — the runtime is not the renderer; verify in Tauri build).
- **Secret handling:** `TWILIO_AUTH_TOKEN` is a password-class env var; reuse
  the existing redacted-value/fingerprint flow; never render full tokens or
  phone numbers (E.164 `pii_safe`).
- **Signature parity risk:** Twilio signs the URL **as Twilio saw it**; the
  default-port variant logic must be ported exactly (`_port_variant_url`), and
  `timingSafeEqual` must compare bytes. Test vectors come from
  `test_sms.py::TestTwilioSignatureValidation`.

## 10. Test strategy

- **Vitest unit (port of `tests/gateway/test_sms.py`):**
  - config loading: env overrides set home channel (`SMS_HOME_CHANNEL` + name);
  - `stripMarkdownForSms`: code-block strip, newline collapse, bold/italic/links;
  - echo prevention: `from === fromNumber` ignored;
  - requirements check: missing SID/TOKEN → not configured;
  - fail-closed startup: missing phone → `sms_missing_phone_number`
    non-retryable; missing webhook URL → `sms_missing_webhook_url`; insecure
    flag skips the guard;
  - signature: valid/invalid/wrong-token/443-port-variant (same vectors as
    Python's `_compute_twilio_signature`);
  - webhook enforcement: insecure skips, missing signature → 403, oversized body
    (64 KiB) → 413, empty TwiML + `application/xml` response.
- **Integration:** mock `fetch`/twilio client for `send()` (chunking, `sid`
  mapping, 4xx error mapping); test the Rust webhook listener with a local HTTP
  POST fixture (wiremock-style, no real Twilio); verify `MessageSid` dedup on
  retried webhook payloads.
- **Playwright E2E:** `/im/sms` onboarding form → fill credentials → "检测连接"
  against a fake Core (existing e2e fake-model pattern) → assert
  `MessagingPlatformInfo` state transitions and the Settings debug card shows
  `sms` with redacted values.
- **Parity harness:** keep a small table of Python test cases ↔ TS tests so the
  migration stays 1:1 (names, inputs, expected outputs).

## 11. Reference links

- Python adapter: `D:/hermes-agent-cn/plugins/platforms/sms/adapter.py`
- Manifest: `D:/hermes-agent-cn/plugins/platforms/sms/plugin.yaml`
- Config seeding: `D:/hermes-agent-cn/gateway/config.py` (lines ~2186-2200)
- Base classes: `D:/hermes-agent-cn/gateway/platforms/base.py`
  (`MessageEvent` ~2294, `SendResult` ~2460, `BasePlatformAdapter` ~2884)
- Messaging catalog/overrides: `D:/hermes-agent-cn/hermes_cli/web_server.py`
  (`_messaging_platform_catalog` ~8980, `_PLATFORM_OVERRIDES["sms"]` ~8654,
  `_PLATFORM_DEFAULT_PORTS["sms"]` ~3498, `GET /api/messaging/platforms` ~10256)
- Plugin registry: `D:/hermes-agent-cn/hermes_cli/plugins.py`
  (`register_platform` ~2435)
- One-shot send contract: `D:/hermes-agent-cn/tools/send_message_tool.py`
  (standalone_sender_fn usage ~857)
- Docs: `D:/hermes-agent-cn/website/docs/user-guide/messaging/sms.md`
- Tests: `D:/hermes-agent-cn/tests/gateway/test_sms.py`
- Desktop UI: `D:/Hermes-CN-Desktop/web/src/routes/im-onboarding.tsx`,
  `web/src/routes/settings.tsx` (platform list ~1478),
  `web/src/lib/im-onboarding-diagnostics.ts`,
  `web/src/hooks/use-im-onboarding.ts`
- Desktop protocol: `D:/Hermes-CN-Desktop/packages/protocol/src/channels.ts`
  (`ImPlatform` ~491), `packages/protocol/src/hermes-api.ts`
  (`MessagingPlatformInfo` ~127)
- Desktop Rust template: `D:/Hermes-CN-Desktop/src/commands/im_onboarding.rs`
- TS reference (no Twilio; Fastify evidence):
  `D:/kimi-code/packages/kap-server/package.json`,
  `D:/kimi-code/node_modules/.pnpm/` (fastify@5.8.5, hono@4.12.14,
  form-data@4.0.6; **no twilio**)
