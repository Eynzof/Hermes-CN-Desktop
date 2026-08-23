# WeCom / WeCom Callback Messaging Platform Adapter — Python → TypeScript Rewrite Plan

> Port decision recorded up front: **WeCom is in the CN desktop onboarding scope** (the desktop
> source-meta / onboarding roadmap intends 飞书/微信/钉钉/企微; `plans/platform-toolsets.md` puts
> `wecom` + `wecom-callback` in the 核心集, and `plans/_INDEX.md` row 82 lists this feature). The
> current Desktop **code** does not implement WeCom onboarding yet: `web/src/routes/im-onboarding.tsx`
> covers feishu/weixin (+ a dingtalk placeholder), `packages/protocol/src/channels.ts:491` types
> `ImPlatform = "feishu" | "weixin"`, and `src/commands/im_onboarding.rs` has `Feishu/Weixin/Dingtalk`
> only. This plan records the adapter port decision and the WS-removal implications:
>
> - **Port decision:** port the **`wecom` AI Bot adapter in-process** into the TS desktop (it is an
>   *outbound* WebSocket client to `wss://openws.work.weixin.qq.com` — same "长连接无需公网" story as
>   the Feishu onboarding rail, no public endpoint needed). Mark the **`wecom_callback`** (self-built
>   app) adapter **out of scope for desktop standalone v1** because it is an *inbound* HTTP server
>   (`:8645/wecom/callback`) that requires a publicly reachable endpoint + long-running listener the
>   Tauri webview cannot host; keep it in the Python gateway (server deployments) and design a
>   Rust-side listener as the optional later path (Section 3).
> - **WS-removal implication:** the WeCom bot's WebSocket is a *platform-facing* connection to
>   Tencent, **not** the local Dashboard `/api/ws` + REST link being removed. After migration the TS
>   in-process module owns the Tencent WS directly; the Python-runtime bridge for WeCom is deleted
>   (Section 7).

## 1. Summary

Hermes-CN-Core ships WeCom (企业微信 / WeChat Work) support as **two** bundled platform plugins
under `D:/hermes-agent-cn/plugins/platforms/wecom/`:

1. **`wecom` (Smart Robot / AI Bot)** — `adapter.py` (1,932 lines): persistent WebSocket client to
   `wss://openws.work.weixin.qq.com`, authenticating with `aibot_subscribe` (bot_id + secret +
   device_id), receiving `aibot_msg_callback`/`aibot_callback`, replying with `aibot_respond_msg`
   (reply-mode) or `aibot_send_msg` (proactive), chunked media upload
   (`aibot_upload_media_init/chunk/finish`), inbound media cache + AES-256-CBC decryption, DM/group
   allowlist policies, text batching for 4000-char client-side splits, and QR scan setup.
2. **`wecom_callback` (self-built apps)** — `callback_adapter.py` (484 lines) + `wecom_crypto.py`
   (142 lines): an aiohttp HTTP server on `:8645/wecom/callback` that verifies the SHA1
   `msg_signature`, decrypts AES-CBC encrypted XML (WXBizMsgCrypt-compatible), queues the message,
   immediately acknowledges `success`, then delivers replies proactively via the `qyapi.weixin.qq.com`
   `message/send` API with a cached corp access token (7200 s TTL, 40001/42001 refresh-on-retry).

The Desktop currently has **no WeCom UI**: the IM onboarding route renders Weixin with the explicit
copy "这里接的是微信消息平台，不是企业微信或公众号后台" (`im-onboarding.tsx:625`), so 企业微信
needs its own route/section. This plan ports the bot-mode adapter runtime + onboarding UI to TS and
records the callback-mode decision.

## 2. Current Python implementation

Source of truth: `D:/hermes-agent-cn`

| Path | Role |
|---|---|
| `plugins/platforms/wecom/__init__.py` (3) | re-exports `register` |
| `plugins/platforms/wecom/adapter.py` (1,932) | `WeComAdapter(BasePlatformAdapter)` — WS lifecycle, protocol frames, policies, media, send paths, QR scan, `interactive_setup`, registry glue |
| `plugins/platforms/wecom/callback_adapter.py` (484) | `WecomCallbackAdapter(BasePlatformAdapter)` — aiohttp GET verify / POST callback / GET health, message queue + poll loop, access-token cache, multi-app routing |
| `plugins/platforms/wecom/wecom_crypto.py` (142) | `WXBizMsgCrypt` — SHA1 signature, AES-256-CBC encrypt/decrypt with 16-byte random prefix + 4-byte big-endian length + receive_id, PKCS7(32) |
| `plugins/platforms/wecom/plugin.yaml` (52) | registers both platforms; env: `WECOM_BOT_ID`/`WECOM_SECRET` (required), `WECOM_WEBSOCKET_URL`, `WECOM_ALLOWED_USERS`, `WECOM_HOME_CHANNEL`, `WECOM_CALLBACK_CORP_ID/_CORP_SECRET/_AGENT_ID/_TOKEN/_ENCODING_AES_KEY` |
| `gateway/config.py:343` | `Platform.WECOM_CALLBACK = "wecom_callback"` |
| `hermes_cli/web_server.py` | `/api/messaging/platforms` catalog includes `wecom` / `wecom_callback` (Desktop already has `getMessagingPlatforms()`, `testMessagingPlatform(id)` in `apps/desktop/src/hermes.ts:1269–1291`) |
| Docs | `website/docs/user-guide/messaging/wecom.md` (301), `website/docs/user-guide/messaging/wecom-callback.md` (179) |
| Tests | `tests/gateway/test_wecom.py` (485), `test_wecom_callback.py` (201), `test_wecom_plugin_setup.py` (79) |

Key implementation blocks (verified by reading):

- **WS protocol constants** (`adapter.py:101–130`): `aibot_subscribe`, `aibot_msg_callback`,
  `aibot_callback`, `aibot_event_callback`, `aibot_send_msg`, `aibot_respond_msg`, `ping`,
  `aibot_upload_media_init/chunk/finish`; `MAX_MESSAGE_LENGTH = 4000`; heartbeat 30 s; reconnect
  backoff `[2, 5, 10, 30, 60]`; dedup max 1000.
- **Lifecycle**: `connect()` (225) — creates SSRF-safe httpx client + aiohttp WS, sends
  `aibot_subscribe {bot_id, secret, device_id}`, waits for correlated ack; `_listen_loop` (365) with
  backoff reconnect; `_heartbeat_loop` (406); `_dispatch_payload` (426) routes by `req_id`
  correlation + callback commands; `_send_request`/`_send_reply_request` (458/473) correlate futures
  by `req_id`.
- **Inbound**: `_on_message` (523) — dedup by `msgid`, DM/group policy gate
  (`_is_dm_intake_allowed` 909 / `_is_group_allowed` 923: `open|allowlist|disabled|pairing`,
  `wecom:user:` prefix normalization, `*` wildcard, per-group `allow_from`), `_extract_text` (684)
  handles mixed/voice/appmsg + quote context, `_extract_media` (734) caches base64/URL media with
  AES `aeskey` decryption; **text batching** (`_enqueue_text_event` 614, `_flush_text_batch` 644)
  merges 4000-char client splits with the cancel-delivery race guard.
- **Outbound**: `send()` (1422) — reply-mode via cached inbound `req_id` (`_reply_req_ids`,
  `_last_chat_req_ids` per chat, **required for groups — WeCom AI Bots cannot `aibot_send_msg` in
  groups, errcode 600039**) else proactive send; `_send_media_source` (1339) — size limits
  (image 10 MB / video 10 MB / voice AMR-only 2 MB / file 20 MB) with **auto-downgrade to file** and
  informative follow-up markdown; chunked upload 512 KB, max 100 chunks, MD5 + base64.
- **Callback**: `_handle_verify` (309) GET handshake, `_handle_callback` (324) POST with 64 KB
  pre-auth body cap (413), dedup 5-min TTL, `_build_event` (399) maps `ToUserName:FromUserName` →
  scoped chat `corp_id:user_id`, `_poll_loop` (375) drains queue to `handle_message`; `send()` (243)
  posts to `qyapi.weixin.qq.com/cgi-bin/message/send?access_token=...`, `_refresh_access_token`
  (461) caches with 7200 s TTL, retries once on 40001/42001.
- **Setup**: `qr_scan_for_bot_info` (1580) hits **unofficial** `work.weixin.qq.com/ai/qc/{generate,query_result}`
  endpoints; `interactive_setup` (1752) QR-first then manual `WECOM_BOT_ID`/`WECOM_SECRET`;
  `register` (1893) declares both platforms, `standalone_sender_fn` for cron, `cron_deliver_env_var="WECOM_HOME_CHANNEL"`.

## 3. Target TypeScript design

**Port decision (recorded):** in-process port for **`wecom` bot mode**; `wecom_callback` deferred
(Section 1). Module layout — the same `PlatformAdapter` contract as `plans/messaging-gateway-core.md`
so it plugs into the future in-process gateway:

```
web/src/lib/platforms/
  types.ts                  # PlatformAdapter interface + MessageEvent/SendResult (gateway-core contract)
  wecom/
    ws-client.ts            # thin aiohttp-WS shim: subscribe/auth, heartbeat, req_id correlation, reconnect backoff
    protocol.ts             # frame builders/parsers: aibot_subscribe / msg_callback / send_msg / respond_msg / upload_*
    policy.ts               # dm/group allowlist port: open|allowlist|disabled|pairing, wecom: prefix, * wildcard, per-group allow_from
    text-batching.ts        # 4000-char split merge + flush race guard (port of _enqueue/_flush_text_batch)
    media.ts                # inbound cache (base64/URL), AES aeskey decrypt, outbound size-limit + downgrade rules
    upload.ts               # chunked upload init/chunk/finish (512 KB, md5, base64)
    adapter.ts              # WeComAdapter implements PlatformAdapter (send/sendImageFile/sendDocument/sendVoice/sendVideo/getChatInfo/test)
    index.ts                # factory + register
web/src/lib/im-onboarding/  # generic onboarding UI state extracted from the route (feishu/weixin/wecom sections)
packages/protocol/src/channels.ts   # ImPlatform += "wecom"
src/commands/im_onboarding.rs       # phase 1: ImPlatform::Wecom + WECOM_* keys + begin/poll/apply; phase 3: retire
```

Key interfaces (pseudocode — no implementation):

```ts
interface WeComAdapterLike extends PlatformAdapter {
  connect(opts?: { isReconnect?: boolean }): Promise<boolean>;
  disconnect(): Promise<void>;
  onMessage(cb: (ev: MessageEvent) => Promise<ProcessingOutcome>): void;
  send(chatId: string, content: string, opts?: { replyTo?: string }): Promise<SendResult>;
  sendImageFile(chatId: string, path: string, opts?: { caption?: string; replyTo?: string }): Promise<SendResult>;
  sendDocument / sendVoice / sendVideo(...): Promise<SendResult>;
  test(): Promise<{ ok: boolean; state?: string; message?: string }>;
}

interface WsFrame { cmd: string; headers: { req_id: string }; body: Record<string, unknown> }
```

Data flow (in-process target):

1. Onboarding writes `WECOM_BOT_ID`/`WECOM_SECRET` (+ policy keys) into the TS settings store
   (phase 2) or the managed runtime `.env` (phase 1 via Rust `im_onboarding_apply`).
2. `WeComAdapter.connect()` opens `wss://openws.work.weixin.qq.com` via `ws`, sends `aibot_subscribe`
   with `device_id = crypto.randomUUID()`, awaits the correlated ack, starts heartbeat (30 s) and a
   reconnect loop with backoff `[2, 5, 10, 30, 60]`.
3. Inbound `aibot_msg_callback` frames → `policy.ts` gate → `media.ts` cache → `text-batching.ts`
   merge → `MessageEvent` → in-process agent loop (no Python).
4. Replies: `send()` prefers `aibot_respond_msg` against the cached inbound `req_id` (per-message and
   per-chat LRU ≤ 1000); fall back to `aibot_send_msg` for DMs. Media goes through `upload.ts` +
   native media message. Size/downgrade rules (10/10/2/20 MB, AMR-only voice) mirror Python exactly.
5. `test()` reuses the subscribe handshake (or a lightweight socket+auth probe) so the onboarding
   "检测连接" button works.

**Callback mode (recorded, not built in v1):** `wecom_callback` needs an inbound HTTP listener with
a public URL; the Tauri webview cannot bind sockets. Server deployments keep the Python adapter;
if a desktop callback mode is ever needed, design = Rust `src/commands/wecom_callback.rs` running
`tiny_http` (or Tauri's local HTTP server) on `:8645`, decrypt/verify in Rust with `aes` + `sha1`
crates, forward normalized events to the webview via Tauri events, and reply through the
`qyapi.weixin.qq.com` REST API — but **not in v1**.

## 4. Data models & persistence

- **Config keys** (parity with `plugin.yaml` + env seeding in `gateway/config.py:2385–2401`):
  - Bot mode: required `WECOM_BOT_ID`, `WECOM_SECRET`; optional `WECOM_WEBSOCKET_URL`,
    `WECOM_ALLOW_ALL_USERS`, `WECOM_ALLOWED_USERS`, `WECOM_DM_POLICY`, `WECOM_GROUP_POLICY`,
    `WECOM_GROUP_ALLOWED_USERS`, `WECOM_HOME_CHANNEL`.
  - Callback mode (server-side only): `WECOM_CALLBACK_CORP_ID/_CORP_SECRET/_AGENT_ID/_TOKEN/
    _ENCODING_AES_KEY/_HOST/_PORT` (+ multi-app `apps` block in `config.yaml`).
- **Persistence strategy (migration-aware):** Phase 1 keeps Rust `im_onboarding_apply` writing
  `WECOM_*` to the managed-runtime `.env` (same as feishu/weixin today). Phase 2 introduces a
  TS-owned settings store (SQLite via Rust `src/commands/*` or JSON under the app data dir) seeded
  from `.env`; the adapter reads only the TS store. Phase 3 drops `.env` writes for WeCom. Secrets
  stay redacted end-to-end (`ImRedactedValue` + sha256 fingerprint pattern from
  `im_onboarding.rs:redacted()`).
- **In-memory state** (all bounded, mirroring Python): `_pending_responses: Map<req_id, Promise>` for
  WS correlation; `_dedup: LRU<msgid, timestamp>` (1000 entries / 5-min TTL); `_reply_req_ids` +
  `_last_chat_req_ids` (≤1000, needed for group replies); `_pending_text_batches` + flush tasks
  (0.6 s delay, 2.0 s near-split delay); callback-side `_access_tokens` (7200 s TTL),
  `_user_app_map`, `_seen_messages` (2000 cap) — only if callback mode is ported later.
- **No durable message store**: WeCom is the source of truth; session identity stays in the existing
  agent session store (see `plans/session-lifecycle.md` / `plans/messaging-gateway-core.md`).

## 5. Third-party library strategy

**kimi-code evidence:** a repo-wide search for `wecom|wechat|qyapi` in `D:/kimi-code` returns
**zero matches**; `node_modules` (incl. `.pnpm`) contains **no** `wecom*`, `wechat*`, `wework*`,
`qyapi*`, or `wxwork*` package. kimi-code does prove the generic building blocks: `ws@8.20.0`
(in `node_modules/.pnpm`, declared in `packages/klient`, `packages/kap-server`,
`packages/agent-core`(-v2)) and `undici@7.27.1` (declared in `packages/agent-core`). npm research
also found the official **`@wecom/aibot-node-sdk`** (AI Bot WS SDK) — **not** vendored in kimi-code,
so it is an alternative, not evidence.

| Python dependency | TS equivalent | Rationale / kimi-code evidence |
|---|---|---|
| `aiohttp` WS client (`wecom` bot) | **thin shim on `ws@8.20.0`** | Python already implements the raw frame protocol (no official Python SDK); porting the ~30 frame shapes is low-risk and gives full parity incl. `req_id` reply correlation + chunked upload. `ws` proven in kimi-code (`packages/klient`, `packages/kap-server`, `packages/agent-core(-v2)`). |
| `httpx` (REST, media download) | `undici@7.27.1` / global `fetch` | kimi-code `packages/agent-core` depends on `undici`; Tauri webview has native fetch. SSRF guard (`is_safe_url`/`_ssrf_redirect_guard`) ported as URL-scheme/host validation in `media.ts`. |
| `aiohttp.web` (callback server) | **out of scope v1**; Rust `tiny_http` later | webview cannot bind inbound sockets; recorded in Section 3. |
| `orjson` | `JSON.parse` / `JSON.stringify` | stdlib; WS frames are small JSON. |
| `pybase64` | `Buffer.from(...).toString("base64")` / `buf.toString()` | built-in. |
| `hashlib` (sha1, md5) | `node:crypto createHash` | built-in; used for `msg_signature`, upload `md5`. |
| `cryptography` (AES-256-CBC) | `node:crypto createDecipheriv/createCipheriv("aes-256-cbc")` + manual PKCS7 | built-in; exactly the 142-line `wecom_crypto.py` port (16-byte random prefix, big-endian len, `receive_id`, SHA1 signature). No npm dep needed. |
| `defusedxml` (callback XML) | **none — regex field extraction** | WeCom callback envelopes are tiny; extract `<Encrypt>` pre-auth with a regex (no entity expansion / XXE surface), then parse the *decrypted* known fields (`MsgType/Content/FromUserName/...`) with simple regex/string ops. Avoid a DOM parser on pre-auth input. |
| `qrcode` (CLI QR) | `qrcode` npm | already used by Desktop onboarding (`web/src/routes/im-onboarding.tsx:3`). |
| `uuid` | `crypto.randomUUID()` | built-in (device_id, req_id). |
| `socket` port-in-use check | Rust `std::net` (callback mode only) | not needed for bot-mode v1. |

**Recommendation (rationale):** build a **thin REST + WS shim** on `ws` + `undici` rather than adopt
`@wecom/aibot-node-sdk`. The Python adapter already documents the wire protocol frame-by-frame; the
shim keeps WeCom logic inside `web/src/lib/platforms/wecom/` with no new third-party dependency, and
the parts the official SDK would cover (auth, heartbeat, reconnect, media upload, AES decrypt) are
all small and already spec'd by `adapter.py`. `@wecom/aibot-node-sdk` is a reasonable alternative if
the team prefers an official, maintained client — but it is **not present in kimi-code** and its
API surface (event emitter + streaming helpers) diverges from the current Python adapter's
correlation model, so adoption would require an adapter layer anyway.

## 6. Integration with existing Hermes-CN-Desktop frontend

- **Onboarding route** — `web/src/routes/im-onboarding.tsx` (1,321 lines): add a WeCom section
  (`sectionFromPath` + `/im/wecom`). Mirror the Weixin route shape: MetaStrip (连接方式 =
  "长连接", no public endpoint), FlowSteps (环境检查 → 扫码/手动凭据 → 访问范围 → 保存验证),
  QrPanel reuse. The Feishu "WHY WS" rail (`railPanels`, 548–658) already sells the
  "无需公网 IP / 适合桌面端" story — reuse it for WeCom. Explicitly fix the Weixin rail copy so
  WeCom is a sibling, not confused with Weixin (line 625 currently says "不是企业微信").
- **Diagnostics** — `web/src/lib/im-onboarding-diagnostics.ts` (450 lines): extend
  `DIAGNOSTIC_REQUIRED_KEYS` with `wecom: ["WECOM_BOT_ID", "WECOM_SECRET"]`,
  `DIAGNOSTIC_POLICY_KEYS` with `wecom: [...]`, and add a `wecom` branch to
  `explainMessagingFailure` (errcode 40013 invalid secret, timeout waiting subscribe ack, port/deps
  errors for callback mode, group 600039).
- **Protocol** — `packages/protocol/src/channels.ts:491`: `ImPlatform = "feishu" | "weixin" |
  "wecom"`; `ImManualCredentials` already has `appId/appSecret`-style fields (add `botId`, `secret`
  if needed).
- **Rust** — `src/commands/im_onboarding.rs` (~2,483 lines): add `ImPlatform::Wecom` with
  `WECOM_ALLOWED_KEYS`/`WECOM_SECRET_KEYS` (mirror `WEIXIN_ALLOWED_KEYS` at 79–90); `begin`/`poll`
  can either hit the unofficial `work.weixin.qq.com/ai/qc/{generate,query_result}` endpoints (as the
  Python `qr_scan_for_bot_info` does — risky, may change) or, recommended for v1, manual
  bot_id/secret entry only; `apply` writes `WECOM_BOT_ID`/`WECOM_SECRET` + policy keys; `test`
  routes to the existing `/api/messaging/platforms/wecom/test`.
- **Hooks / REST** — `web/src/hooks/use-im-onboarding.ts` is already generic over `ImPlatform`
  (works once the protocol widens); `useMessagingPlatform("wecom")` + `useTestMessagingPlatform`
  reuse the existing `/api/messaging/platforms` and `/api/messaging/platforms/wecom/test` endpoints
  (`packages/protocol/src/hermes-api.ts:127–151`, backend `hermes_cli/web_server.py`).
- **Transport** — `web/src/lib/transport.ts` (HTTP routing + auth) and `gateway-client.ts` (WS
  JSON-RPC) stay untouched in phase 1; they are the bridge being removed in phase 3 for WeCom.

## 7. Removing the WebSocket dependency (migration path)

Freeze this API surface during migration (both sides implement it):
`PlatformAdapter` (`connect/disconnect/onMessage/send/sendImageFile/sendDocument/sendVoice/sendVideo/
sendTyping/getChatInfo/test`), `MessageEvent {text, messageType, source{platform,chat_id,chat_type,
user_id}, messageId, mediaUrls, mediaTypes, replyToMessageId, replyToText}`, `SendResult {success,
messageId, error, rawResponse}`, config keys (`WECOM_*`), and the REST endpoints
`/api/messaging/platforms[/:id][/test]`.

- **Phase 1 (keep backend call):** Desktop onboarding UI + diagnostics + Rust env writes work
  against the Python gateway exactly as Feishu/Weixin do today; the managed runtime owns the Tencent
  WS. No behavior change.
- **Phase 2 (in-process module behind same interface):** `web/src/lib/platforms/wecom/` implements
  the frozen `PlatformAdapter`; a feature flag routes WeCom messages to the in-process adapter while
  the Dashboard `/api/ws` bridge still serves other platforms. This is the risky phase for WeCom:
  the in-process module must take over the *outbound* Tencent WS (keepalive, reconnect, req_id
  correlation, group reply fallback) with no loss of connectivity during handover.
- **Phase 3 (delete WS/REST path):** stop launching the Python `wecom` platform in the managed
  runtime, retire Rust `im_onboarding_apply` env writes for `WECOM_*`, and delete the WeCom branch
  from the `/api/ws` + REST bridge. `wecom_callback` stays in the Python gateway for server
  deployments (or moves to a future Rust listener — Section 3).

## 8. Migration phases & task breakdown

1. **Phase 0 — plan & evidence** (this file): verified kimi-code has no WeCom/WeChat/qyapi
   reference; Desktop onboarding code lacks WeCom; protocol `ImPlatform` lacks `wecom`.
2. **Phase 1 — onboarding surface (Desktop ↔ Python gateway):**
   - `packages/protocol/src/channels.ts`: widen `ImPlatform` to `"wecom"`.
   - `src/commands/im_onboarding.rs`: `ImPlatform::Wecom`, `WECOM_ALLOWED_KEYS`/`WECOM_SECRET_KEYS`,
     manual-credential `begin`/`poll` (or QR via `ai/qc` as stretch), `apply` writes
     `WECOM_BOT_ID`/`WECOM_SECRET`/`WECOM_DM_POLICY`/`WECOM_ALLOWED_USERS`/`WECOM_HOME_CHANNEL`.
   - `web/src/routes/im-onboarding.tsx`: `/im/wecom` section (reuse Weixin pattern; fix rail copy).
   - `web/src/lib/im-onboarding-diagnostics.ts`: WeCom branches + required/policy keys.
   - E2E: QR/manual save → gateway restart → `useMessagingPlatform("wecom")` shows connected → test.
3. **Phase 2 — in-process adapter:**
   - `web/src/lib/platforms/wecom/`: `protocol.ts`, `ws-client.ts`, `policy.ts`, `text-batching.ts`,
     `media.ts`, `upload.ts`, `adapter.ts`, `index.ts` (Section 3).
   - Wire into the in-process gateway (see `plans/messaging-gateway-core.md`); feature-flag handover.
   - Port SSRF-safe media download + AES `aeskey` decrypt + size-limit/downgrade rules with parity
     unit tests.
4. **Phase 3 — cutover:**
   - Stop launching Python `wecom` platform; delete WeCom REST/WS bridge; retire Rust env writes.
   - Keep `wecom_callback` in Python (server-side) — record the Rust-listener follow-up ticket.

## 9. Risks & open questions

- **No TS equivalent in kimi-code (verified):** zero `wecom|wechat|qyapi` matches; no SDK packages
  in its node_modules. Every WeCom-specific behavior is a from-scratch port; only generic `ws` /
  `undici` are proven in-repo.
- **`@wecom/aibot-node-sdk` is an untested alternative:** official, covers the AI Bot WS protocol
  (auth/heartbeat/reconnect/upload/AES), but not in kimi-code and its event/streaming model diverges
  from the Python correlation model — adopt only with a spike.
- **Unofficial QR endpoints:** `work.weixin.qq.com/ai/qc/{generate,query_result}` back the admin
  console UI, may change without notice (Python docstring warns this). Desktop v1 should ship
  manual bot_id/secret entry first; QR scan is a stretch.
- **Group reply correlation:** WeCom AI Bots cannot initiate sends in groups (errcode 600039); the
  per-chat cached `req_id` fallback is load-bearing. Must be ported exactly (including not caching
  blocked senders — `test_on_message_does_not_cache_blocked_sender_req_id`).
- **Text batching race:** the cancel-delivery race guard in `_flush_text_batch` is subtle; port with
  the regression test (Section 10).
- **Callback mode in webview is impossible (inbound listener);** decision recorded — server-side
  only for v1. Open question: does the CN desktop roadmap want a Rust-hosted callback listener
  (public tunnel required) before the WS-removal milestone?
- **Media SSRF:** inbound media URLs must keep the Python `is_safe_url` + redirect-guard semantics
  in TS; risk of regression if the port is naive.
- **Media downgrade UX:** outbound downgrade notes and rejection messages are user-facing Chinese
  copy — must be preserved (tests assert exact strings).

## 10. Test strategy

Parity tests (vitest unit — port from the Python tests):

- `test_wecom.py` (485 lines): requirements check; connect records handshake failure (40013) with
  fatal error; QR scan timeout uses monotonic clock; reply-mode media uses `aibot_respond_msg` with
  the cached req_id; `_extract_text` mixed → `part1\npart2`; dispatch accepts new + legacy callback
  cmds; DM allowlist honors env-only `WECOM_ALLOWED_USERS`; pairing group policy blocks without
  explicit allow; media-type detection; voice non-AMR downgrade to file; SSRF connect-time rebind
  blocked; send_voice sends caption + downgrade note; `_on_message` builds event with media; blocked
  sender req_id not cached; chat req_id cache bounded; **proactive group send falls back to cached
  req_id (600039)**; text-batch flush superseded-task race.
- `test_wecom_callback.py` (201 lines): crypto roundtrip (encrypt→decrypt), event construction
  (`corp_id:user_id` scoped chat), multi-app routing picks correct agentid/token, 40001 token refresh
  retry once, poll loop dispatches to `handle_message`, oversized body → 413.
- `test_wecom_plugin_setup.py` (79 lines): setup wizard home-channel clear-on-blank.
- TS-specific additions: `ws-client` reconnect/backoff with a mock WS server; `req_id` correlation
  timeout; chunked upload init/chunk/finish payloads (0-based chunk index, base64, md5); AES media
  decrypt; `wecom_crypto.ts` roundtrip.

Playwright E2E: `/im/wecom` manual-credential save → env written → gateway restart →
`useMessagingPlatform("wecom")` connected → "检测连接" passes; diagnostic bundle redacts secrets and
emits no plaintext token.

## 11. Reference links

- Core Python: `D:/hermes-agent-cn/plugins/platforms/wecom/{__init__.py,adapter.py,callback_adapter.py,plugin.yaml,wecom_crypto.py}`
- Core docs: `D:/hermes-agent-cn/website/docs/user-guide/messaging/wecom.md`, `.../wecom-callback.md`
- Core tests: `D:/hermes-agent-cn/tests/gateway/test_wecom.py`, `test_wecom_callback.py`, `test_wecom_plugin_setup.py`
- Core feature inventory: `D:/hermes-agent-cn/features_report.md:128`
- Desktop onboarding: `D:/Hermes-CN-Desktop/web/src/routes/im-onboarding.tsx`,
  `web/src/lib/im-onboarding-diagnostics.ts`, `web/src/hooks/use-im-onboarding.ts`,
  `packages/protocol/src/channels.ts:491`, `packages/protocol/src/hermes-api.ts:127–151`,
  `src/commands/im_onboarding.rs`
- Reference plans: `plans/README.md`, `plans/_PROMPT_TEMPLATE.md`, `plans/_INDEX.md:106`,
  `plans/platform-toolsets.md:41`, `plans/messaging-gateway-core.md`, `plans/dingtalk-platform.md`
- TS reference: `D:/kimi-code` (no WeCom/WeChat/qyapi matches; `ws@8.20.0` +
  `undici@7.27.1` in node_modules; `packages/agent-core/package.json`)
- npm: `@wecom/aibot-node-sdk` (official AI Bot WS SDK — alternative, not vendored in kimi-code)
