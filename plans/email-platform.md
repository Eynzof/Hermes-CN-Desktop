# Email Messaging Platform Adapter — Python → TypeScript Rewrite Plan

> Port decision recorded up front: **Email is a gateway-side messaging platform adapter and is
> marked "out of scope for desktop standalone"** (per `plans/README.md` and the shared
> `plans/messaging-gateway-core.md` decision). The desktop keeps talking to the Core managed-runtime
> gateway over REST (`/api/messaging/platforms`, `/api/status`, `/api/env`) and WS (`/api/ws`), and
> does **not** host the IMAP/SMTP bot in-process in v1. This file still designs the in-process TS
> port (Sections 3–10) so the decision is recorded and a future standalone build can pick it up.
> Feature scope: IMAP receive (polling) + SMTP send, attachments (in/out), threading, sender
> authentication (SPF/DKIM/DMARC), access control, robustness (charset fallback, malformed IMAP
> responses, IPv4 fallback, connection cleanup, dedup).

## 1. Summary

Hermes-CN-Core ships a compact **Email gateway adapter** (`plugins/platforms/email/adapter.py`,
1,406 LOC) built entirely on the **Python standard library** (`imaplib`, `smtplib`, `email`, `ssl`,
`socket`) — no third-party dependencies and no external service (docs
`website/docs/user-guide/messaging/email.md`). It polls an IMAP INBOX for UNSEEN messages on a
configurable interval (default 15 s), normalizes each message into a `MessageEvent`, runs it through
the gateway's authorization gate (allowlist / allow-all / pairing), and replies over SMTP with
`In-Reply-To`/`References` threading. It caches inbound attachments (images → vision tool, documents
→ file access) and sends outbound attachments (`MEDIA:` path or `send_document`/`send_multiple_images`).

The Desktop app currently has **no Email UI**: `web/src/routes/settings.tsx` only echoes
`status.gateway_platforms["email"]` in the debug platform list, the IM onboarding
(`web/src/routes/im-onboarding.tsx`, `web/src/lib/im-onboarding-diagnostics.ts`) covers
Feishu/Weixin only, and `web/src/lib/env-translations.ts` has **zero `EMAIL_*` mappings** (verified).
Core already exposes Email in the messaging-platform catalog (`hermes_cli/web_server.py:8637`),
so the v1 desktop work is a REST-driven settings + diagnostics surface.

This plan records the port decision — **keep Email in the Python gateway (managed runtime) for v1,
expose config/status/test in Desktop via REST; do not host the email bot in-process**. It also gives
the full design for an eventual in-process TypeScript port built on **imapflow + nodemailer +
mailparser** (recommended; see Section 5), which **does not exist anywhere in `D:/kimi-code`**
(verified — repo search finds no IMAP/SMTP client, and `node_modules` contains neither `nodemailer`
nor `imapflow`; Section 5 risk).

## 2. Current Python implementation

Source of truth: `D:/hermes-agent-cn`

| Path | Role |
|---|---|
| `plugins/platforms/email/adapter.py` (1,406 lines) | `EmailAdapter(BasePlatformAdapter)` — everything: config, connect/disconnect, poll loop, fetch, dispatch, send paths, auth, plugin glue |
| `plugins/platforms/email/__init__.py` | `register` re-export |
| `plugins/platforms/email/plugin.yaml` | platform metadata; `requires_env`: `EMAIL_ADDRESS`, `EMAIL_PASSWORD`, `EMAIL_SMTP_HOST`; `optional_env`: `EMAIL_SMTP_PORT`, `EMAIL_IMAP_HOST`, `EMAIL_ALLOWED_USERS`, `EMAIL_HOME_ADDRESS` |
| `gateway/config.py` (2164–2183) | `_apply_env_overrides` seeds `Platform.EMAIL` `extra` (`address`, `imap_host`, `smtp_host`) + `home_channel` from `EMAIL_HOME_ADDRESS` |
| `hermes_cli/web_server.py` (8637, 8884–8897, 9072) | `/api/messaging/platforms` catalog entry `"email"` (required env list + field metadata), prefix `"email": ("EMAIL_",)` |
| `website/docs/user-guide/messaging/email.md` (198 lines) | setup (Gmail/Outlook app passwords), manual `.env` config, how it works, access control, troubleshooting, security, env var reference |
| `tests/gateway/test_email.py` (911 lines) | config env overrides, requirements check, helpers, body extraction, attachments, dispatch/threading, send, connect/disconnect, fetch, poll, standalone send, SMTP/IMAP cleanup, NetEase IMAP ID, IPv4 fallback, missing-host fatal error, sender authentication |
| `tests/gateway/test_email_robustness.py` (81 lines) | malformed IMAP fetch responses skipped (UID marked seen before fetch → abort loses mail), Message-ID domain without `@` |
| `tests/gateway/test_email_charset_fallback.py` (103 lines) | unknown/malformed charsets never raise (#35901 `unknown-8bit`, #55381 RFC 2047, #55383 body charset) |
| `tests/gateway/test_email_secret_scope.py` (248 lines) | profile-scoped secret reads (`agent.secret_scope`) — no cross-profile credential leak under multiplexing (#50051/#52307) |

Key implementation blocks inside `adapter.py` (line refs verified by reading):
- **Config**: `_get_esecret` scope-aware `EMAIL_*` reader (line 74) — falls back to `os.environ`
  only for the unscoped DEFAULT profile under multiplexing; `_esecret_int`/`_esecret_bool`; config
  resolution honors `PlatformConfig.extra` (`address`/`imap_host`/`smtp_host`/`skip_attachments`/
  `require_authenticated_sender`/`authserv_id`) after env vars (549–601).
- **Connect** (679): validates required vars up front → non-retryable fatal error
  `email_missing_configuration` (#40715); tests IMAP (`IMAP4_SSL` + login + `_send_imap_id` +
  marks all existing messages seen via `UID SEARCH ALL`) then SMTP (`_connect_smtp` login); starts
  `_poll_loop` task.
- **Polling receive** (761–878): `_check_inbox` runs `_fetch_new_messages` in an executor thread
  (IMAP is blocking); `UID SEARCH UNSEEN`, skips already-seen UIDs, `UID FETCH (RFC822)`, guards
  malformed response structures (`IndexError`/`TypeError`/non-bytes → skip, never abort batch),
  `_send_imap_id` after login (RFC 2971 — required by 163/NetEase, best-effort elsewhere).
- **Parsing robustness**: `_safe_decode` (274) alias table (`unknown-8bit`, `gb2312→gb18030`,
  `ks_c_5601-1987→cp949`, …) then UTF-8 then latin-1, `errors="replace"` — never raises (#35901,
  #55381, #55383); `_decode_header_value` (294) RFC 2047; `_extract_text_body` (313) prefers
  text/plain, falls back to `_strip_html` (348); `_extract_email_address` (362); `_domain_of` (370).
- **Sender authentication** (406): `_verify_sender_authentication` parses the first (topmost)
  `Authentication-Results` header and requires `dmarc=pass` or aligned `spf=pass` or aligned
  `dkim=pass`; optional `authserv_id` pinning; **fail-closed when no header** (GHSA-rxqh-5572-8m77);
  opt-out via `platforms.email.require_authenticated_sender: false` /
  `EMAIL_TRUST_FROM_HEADER=true`.
- **Dispatch** (910–1023): skip self-messages; drop automated/noreply senders (`_NOREPLY_PATTERNS`
  + `_AUTOMATED_HEADERS`: `Auto-Submitted`, `Precedence: bulk`, `List-Unsubscribe`); fail-closed
  allowlist logic (`EMAIL_ALLOWED_USERS` / `EMAIL_ALLOW_ALL_USERS` / `GATEWAY_ALLOW_ALL_USERS`);
  From-auth gate only when an allowlist is in effect; `[Subject: …]` prefix for non-`Re:` mail;
  attachment → `MessageType.PHOTO`/`DOCUMENT` + `media_urls`; stores `_thread_context[chat_id] =
  {subject, message_id}`; builds `MessageEvent` via `build_source(chat_id=sender_addr, …)`.
- **Attachments** (486–543): `_extract_attachments` — image ext (`jpg/jpeg/png/gif/webp`) →
  `cache_image_from_bytes` (invalid magic bytes skipped), others → `cache_document_from_bytes`;
  `skip_attachments: true` skips `attachment`/`inline` parts before decoding (malware/bandwidth).
- **Send paths**: `send` → `_send_email` (1053) with threading headers, `Re:` prefix (no double
  `Re: Re:`), Message-ID `<hermes-{uuid12}@{domain}>` (falls back `localhost`), plain UTF-8 body;
  `send_image` (1099, URL appended to body); `send_multiple_images` (1116, local `file://` paths
  attached, remote URLs linked); `send_document` (1222, MIMEBase + base64 attachment);
  `send_typing` no-op; `get_chat_info` (1299).
- **SMTP connection** (633): port 465 → implicit TLS `SMTP_SSL`; other ports → `SMTP` + STARTTLS
  with verified default context; connection-level timeout/OSError → retry through IPv4-only socket
  path (`_create_ipv4_connection`, AF_INET only) without mutating global resolver state; TLS verify
  errors never retried; `finally: quit() → close()` cleanup.
- **Dedup/memory**: `_seen_uids` set capped at 2000 with `_trim_seen_uids` (keep top half);
  `MAX_MESSAGE_LENGTH = 50_000`.
- **Plugin glue** (1310–1406): `register()` exposes `check_email_requirements`, `_is_connected`,
  `required_env`, `allowed_users_env`, `allow_all_env`, `cron_deliver_env_var="EMAIL_HOME_ADDRESS"`,
  `standalone_sender_fn=_standalone_send` (one-shot SMTP for cron/notifications), `max_message_length`,
  `pii_safe=True`, `emoji="📧"`.

**Docs key behaviors** (`website/docs/user-guide/messaging/email.md`): startup tests IMAP+SMTP and
marks existing mail seen (94–98); subject-as-context (106–114); threading (118–123);
`MEDIA:/path` attachments (127); `skip_attachments` (131–139); access control 4-step (143–154);
troubleshooting incl. duplicate replies = single gateway instance (158–168); security: dedicated
account + app passwords + `chmod 600` `.env` (172–182); env var reference table (185–198).

## 3. Target TypeScript design

**Port decision (recorded):** keep the adapter in the Python gateway for v1; the Desktop only adds
a config/status/test surface (Section 6). The in-process design below is the "if ported" target.

Proposed module layout (matches the `PlatformAdapter` contract in `plans/messaging-gateway-core.md`
so the adapter can plug into the future in-process gateway):

```
packages/email-adapter/src/
  adapter.ts          # EmailAdapter — implements PlatformAdapter (connect/disconnect/send/sendDocument/
                      #   sendMultipleImages/sendTyping/getChatInfo), poll task lifecycle, seen-UID set
  imap-client.ts      # thin imapflow wrapper: connect/ID/login/select, UID SEARCH UNSEEN, UID FETCH
                      #   RFC822, mark-seen policy, malformed-response guards, logout/finally cleanup
  smtp-client.ts      # thin nodemailer wrapper: STARTTLS/implicit-TLS by port, login, sendMail,
                      #   quit/close, IPv4-only retry hook (net.connect family 4)
  mime.ts             # mailparser wrapper: text/plain vs html fallback, RFC 2047 decode, charset
                      #   alias table (unknown-8bit/gb2312→gb18030/…) + utf-8/latin-1 last-resort
  html-strip.ts       # minimal tag stripper (br/p→newline, entity decode, collapse blank lines)
  auth-results.ts     # port of _verify_sender_authentication: parse Authentication-Results, dmarc/spf/dkim
                      #   alignment, authserv-id pinning, fail-closed
  access.ts           # port of allowlist/allow-all/automated-sender gates (_NOREPLY_PATTERNS, _AUTOMATED_HEADERS)
  attachments.ts      # port of _extract_attachments: image vs document classification, cache to
                      #   disk, skip_attachments, invalid-magic skip
  threading.ts        # Re: prefix (no double Re:), In-Reply-To/References, Message-ID, thread context
  poller.ts           # setInterval-based poll loop with reconnect/backoff + poll-interval env
  diagnostics.ts      # connect-time checks (IMAP then SMTP) + fatal-error model (email_missing_configuration)
  ids.ts              # extractEmailAddress / domainOf / domainsAligned (pure ports)
```

Key interfaces (pseudocode — no implementation):

```ts
interface EmailAdapterLike extends PlatformAdapter {
  connect(opts?: { isReconnect?: boolean }): Promise<boolean>; // tests IMAP+SMTP, marks existing seen, starts poller
  disconnect(): Promise<void>;
  send(chatId: string, content: string, opts?: { replyTo?: string; metadata?: MsgMetadata }): Promise<SendResult>;
  sendDocument(chatId: string, filePath: string, caption?: string, opts?: { fileName?: string }): Promise<SendResult>;
  sendMultipleImages(chatId: string, images: Array<[url: string, alt: string]>): Promise<void>;
  getChatInfo(chatId: string): Promise<ChatInfo>;
  onMessage(handler: (event: MessageEvent) => Promise<unknown>): void;
}

interface ImapPollResult { messages: FetchedMessage[]; } // uid, senderAddr, senderName, subject, messageId,
                                                         // inReplyTo, body, attachments, date, senderAuthenticated, authReason
```

Data flow (in-process):
1. `EmailAdapter.connect()` reads `EMAIL_*` from the profile secret/env store, checks required vars
   (missing → non-retryable fatal `email_missing_configuration`), opens an imapflow connection,
   sends the RFC 2971 ID command, `UID SEARCH ALL` to seed the seen-UID set (existing mail skipped),
   tests nodemailer SMTP login, then starts `poller.ts` (interval = `EMAIL_POLL_INTERVAL`).
2. Each tick: `UID SEARCH UNSEEN` → skip seen UIDs → `UID FETCH (RFC822)` → `mime.ts` parse →
   `auth-results.ts` verdict (while the raw message is in scope) → `attachments.ts` cache →
   `access.ts` gates (self, automated, allowlist, allow-all, authenticated-From) → `threading.ts`
   context store → `MessageEvent` → agent loop (same pipeline as `LocalChatAdapter`).
3. Agent reply streams back through `adapter.send()` (threading headers, `Re:` prefix, UTF-8 body)
   and `sendDocument`/`sendMultipleImages` for attachments.
4. Cron/notification delivery reuses the same adapter's send path or a one-shot `sendStandaloneEmail`
   (port of `_standalone_send`).

**Runtime constraint (must be resolved before any port):** the webview renderer has no raw
TCP/TLS sockets, so IMAP/SMTP cannot run directly in the React webview. The in-process adapter must
run in (a) a Node main-process / sidecar host with `net`/`tls` (imapflow + nodemailer), or (b) Rust
behind Tauri IPC (crates `imap`/`lettre`/`mail-parser`/`native-tls`). Option (a) keeps the Section 5
SDKs; option (b) drops the JS SDKs but doubles the port effort — open question (§9).

## 4. Data models & persistence
- **No durable message store**: the mailbox is the source of truth (IMAP UNSEEN flag prevents
  re-delivery). Persistence strategy: **none for messages**; session identity lives in Core gateway
  sessions and stays there in v1.
- **In-memory state** (all bounded, mirroring the Python adapter):
  - `_seenUids: Set<number>` — UIDs already processed; cap 2000, trim to top half when exceeded
    (`_trim_seen_uids` parity);
  - `_threadContext: Map<chatId, { subject: string; messageId?: string }>` — per-sender threading
    context, overwritten on each inbound message;
  - `_pollTask` / `_running` flag; `_fatalError?: { code, message, retryable }`.
- **Attachment cache**: inbound attachments are written to the existing media/cache dir used by the
  Desktop (images → vision tool paths, documents → file-access paths), reusing Core's
  `cache_image_from_bytes`/`cache_document_from_bytes` semantics — in v1 the Python gateway owns
  this; if in-process, route through a small Rust `cache_attachment` command or the existing media
  API so the vision/file tools see the same paths. `skip_attachments: true` skips attachment/inline
  parts before decode.
- **Credentials/config**: `EMAIL_ADDRESS`, `EMAIL_PASSWORD`, `EMAIL_IMAP_HOST`, `EMAIL_IMAP_PORT`,
  `EMAIL_SMTP_HOST`, `EMAIL_SMTP_PORT`, `EMAIL_POLL_INTERVAL`, `EMAIL_ALLOWED_USERS`,
  `EMAIL_ALLOW_ALL_USERS`, `EMAIL_HOME_ADDRESS`, `EMAIL_TRUST_FROM_HEADER`, `EMAIL_AUTHSERV_ID` in
  the managed-runtime env/secret store (`~/.hermes/.env` via existing `runtime.ts`/transport
  patterns, or Rust keychain). No new DB schema or migration — **no SQLite/IndexedDB needed**.

## 5. Third-party library strategy

**Verified: no TS equivalent exists in `D:/kimi-code`.** A repo-wide search for
`email|imap|smtp|nodemailer` finds **no email client implementation** — only incidental hits: an
email regex in `packages/agent-core-v2/src/app/telemetry/privacy.ts:5` (PII redaction),
`plugin/types.ts`/`plugin/manifest.ts` (a generic `email` plugin field), and markdown email-link
rendering in `packages/pi-tui`. `node_modules` contains **no `nodemailer`** and **no `imapflow`**; no
`package.json` depends on either. **Risk: the TS port must add new dependencies with no in-repo
precedent** (same posture as the Telegram/Slack platform plans).

| Python dependency (stdlib) | TS equivalent | kimi-code evidence |
|---|---|---|
| `imaplib` (`IMAP4_SSL`, `uid search/fetch`, `xatom('ID', …)`, `select`, `logout`) | **imapflow** (recommended) — promise-based IMAP client: `ImapFlow.connect()`, `mailboxOpen('INBOX')`, `search({seen:false})`, `fetchOne(uid, {source:true})`, `client.id({…})` (RFC 2971), `logout()`, built-in TLS/STARTTLS, UID semantics | **none** — new dependency; not in kimi-code `node_modules` or any package.json |
| `smtplib` (`SMTP`/`SMTP_SSL`, `starttls`, `login`, `send_message`, `quit`/`close`) | **nodemailer** (recommended) — `nodemailer.createTransport({host,port,secure: port===465, auth:{user,pass}, tls})`, `sendMail()`, attachment objects, `close()`; `secure` maps implicit TLS, STARTTLS otherwise | **none** — new dependency; absent from kimi-code |
| `email` stdlib (MIME parse/build, RFC 2047 `decode_header`, `message_from_bytes`, `MIMEMultipart`/`MIMEBase`/`encoders`, `formatdate`) | **mailparser** (recommended) for inbound (`simpleParser` → `subject/text/html/attachments/headers`), nodemailer's built-in MIME builder for outbound; RFC 2047 handled by mailparser; `Date` via `new Date().toUTCString()` | **none** — new dependency; kimi-code has no MIME lib (markdown/transcript libs only) |
| `ssl` (`create_default_context`, verified TLS) | Node built-in `tls`; imapflow and nodemailer accept `tls` options (rejectUnauthorized default true) | built-in, n/a |
| `socket` IPv4-only fallback (`_create_ipv4_connection`, AF_INET retry) | Node `net.connect({family: 4})`; imapflow/nodemailer accept a custom `socket`/`connection` factory — implement `ipv4-retry.ts` | no custom dispatcher shim exists in kimi-code |
| `_safe_decode` charset aliases + latin-1 last resort | `mime.ts` alias table (port verbatim) + `TextDecoder` (`fatal:false`) / Buffer `toString('latin1')` | no charset lib in kimi-code; `iconv-lite` would be another new dep — prefer port |
| `_strip_html` naive stripper | `html-strip.ts` port (regex-based, no dep) or `node-html-to-text` (new dep, unverified) | no equivalent in kimi-code |
| `_verify_sender_authentication` (Authentication-Results parsing) | `auth-results.ts` — **implement from scratch** (regex port of `_AUTH_METHOD_RE`/`_AUTH_PROP_RE`, dmarc/spf/dkim alignment, authserv-id pinning, fail-closed) | no equivalent in kimi-code |
| `uuid.uuid4` | Node `crypto.randomUUID()` | kimi-code uses `crypto.randomUUID()` patterns (no lib needed) |
| `re` (regex) | built-in RegExp | n/a |

**Recommendation rationale — imapflow over alternatives:**
- imapflow is the actively maintained promise-based IMAP client with first-class UID SEARCH/FETCH,
  built-in TLS, mailbox selection, and a documented `id()` extension hook for the RFC 2971 ID
  command that NetEase/163 requires — the Python adapter's `_send_imap_id` maps 1:1.
- **nodemailer over alternatives:** de-facto standard SMTP client; `secure: true` (port 465) vs
  STARTTLS mapping matches `_connect_smtp` exactly; attachments via `attachments: [{filename, content}]`
  mirror `MIMEBase` + base64; `sendMail` is promise-based; message size handled by the transport.
- **mailparser over alternatives:** `simpleParser` returns `text`, `html`, `attachments[]`
  (filename/contentType/content) and decodes RFC 2047 headers and charsets — the closest 1:1 to the
  Python `email` module surface used by `_extract_text_body`/`_decode_header_value`/`_extract_attachments`.
- Where no TS lib exists at all, design thin shims (`auth-results.ts`, `html-strip.ts`, `mime.ts`
  charset alias, `ipv4-retry.ts`) — pure/typed ports, no third-party dependency.

## 6. Integration with existing Hermes-CN-Desktop frontend

Today there is **no Email UI** in the desktop (verified: `web/src/routes/im-onboarding.tsx` covers
Feishu/Weixin/DingTalk paths only; `web/src/lib/im-onboarding-diagnostics.ts` and
`web/src/lib/env-translations.ts` have zero `email`/`EMAIL_*` references).
- `web/src/routes/settings.tsx` (line ~1478) already renders `status.gateway_platforms` as a debug
  platform list; add an Email card/row reusing the existing status shape (`state`, `error_code`,
  `error_message`) — no new backend needed.
- `web/src/routes/im-onboarding.tsx` + `web/src/lib/im-onboarding-diagnostics.ts` are
  **Feishu/Weixin-specific** (`ImPlatform = "feishu" | "weixin"` in
  `packages/protocol/src/channels.ts:491`). Email has **no QR flow** — onboarding is a plain form:
  address, app password, IMAP host/port, SMTP host/port, allowed users, poll interval, and advanced
  toggles (`skip_attachments`, `require_authenticated_sender`). Recommended: a standalone
  `settings/platforms/email` route (not forced into the QR wizard), with an `email-diagnostics.ts`
  modeled on the same `ImDiagnosticBundle` shape (required keys, state, test result, issues).
- REST surface to reuse: Core already registers Email in the messaging-platform catalog
  (`hermes_cli/web_server.py:8637` — required env `EMAIL_ADDRESS`/`EMAIL_PASSWORD`/
  `EMAIL_IMAP_HOST`/`EMAIL_SMTP_HOST`, field metadata at 8884–8897, `"email": ("EMAIL_",)` prefix at
  9072), so `GET /api/messaging/platforms`, PUT enable, and POST
  `/api/messaging/platforms/email/test` (pattern proven by `use-im-onboarding.ts` →
  `useMessagingPlatform`/`useTestMessagingPlatform`) work today; env writes go through the existing
  REST PUT `/api/env` (pattern: `useConfig`/`useSaveConfig` + `web/src/lib/transport.ts`
  `fetchJSON`/`postJSON`/`putJSON`).
- `web/src/lib/env-translations.ts` / `config-translations.ts`: add `EMAIL_*` labels and the
  `platforms.email.skip_attachments` / `require_authenticated_sender` / `authserv_id` config.yaml
  keys (currently absent — verified).
- `packages/protocol/src/channels.ts`: extend `ImPlatform` with `"email"` **or** (preferred) add a
  dedicated `EmailPlatformSettings` schema (Zod) + `EmailDiagnosticBundle` type so the email flow
  does not borrow the QR-specific `ImCredentialSummary` shape.
- Rust `src/commands/*`: no email commands needed for v1. If in-process later, add a
  `src/commands/email.rs` only if the Rust-host option (raw sockets/TLS, attachment cache) is chosen.

## 7. Removing the WebSocket dependency (migration path)

Email is a **gateway-side** adapter; the WS-removal story is owned by
`plans/messaging-gateway-core.md` (gateway becomes an in-process service). This plan's phases keep
Email out of the desktop in v1 and record the swap contract.
- **Phase A (v1, recommended): Python gateway owns Email; Desktop adds UI only.** New
  `settings/platforms/email` route (or settings card) reusing `useMessagingPlatform`-style hooks +
  `email-diagnostics.ts`; write env via existing REST PUT `/api/env`; enable/test via
  `/api/messaging/platforms/email`. **Zero WS changes.**
- **Phase B (optional): in-process `EmailAdapter` behind the same interface.** Extract the
  `PlatformAdapter` interface (Section 3), run imapflow + nodemailer in the Node/Rust host (see
  §3 runtime constraint), bridge inbound events to the agent loop through the same message pipeline
  the desktop chat UI uses (`LocalChatAdapter` in the gateway-core plan). Delete path: keep the
  Python adapter as fallback; flip per-profile flag.
- **Phase C (only if desktop fully standalone): delete the Python WS/REST path** for Email config
  (keep `/api/ws` for agent sessions as long as the Python agent exists). The frozen surface the TS
  implementation must satisfy:
  1. `PlatformAdapter` interface (Section 3) — connect/disconnect/send/sendDocument/
     sendMultipleImages/sendTyping/getChatInfo + lifecycle probes;
  2. env names (`EMAIL_ADDRESS/PASSWORD/IMAP_HOST/IMAP_PORT/SMTP_HOST/SMTP_PORT/POLL_INTERVAL/`
     `ALLOWED_USERS/ALLOW_ALL_USERS/HOME_ADDRESS/TRUST_FROM_HEADER/AUTHSERV_ID`) and
     `plugin.yaml` requires_env/optional_env;
  3. session isolation keys `agent:main:email:dm:{sender}` and `build_session_key` semantics;
  4. security surfaces that must not regress: Authentication-Results fail-closed gate +
     `authserv_id` pinning (GHSA-rxqh-5572-8m77), automated-sender filtering, self-message filter,
     seen-UID dedup (cap 2000), `email_missing_configuration` non-retryable fatal;
  5. `standalone_sender_fn` contract (`EMAIL_HOME_ADDRESS` cron/notification delivery).

## 8. Migration phases & task breakdown

| Phase | Tasks | Est. |
|---|---|---|
| A1 | `/settings/platforms/email` route (or settings card): show `gateway_platforms.email` state/error; form for `EMAIL_ADDRESS`/`EMAIL_PASSWORD`/`EMAIL_IMAP_HOST`/`EMAIL_IMAP_PORT`/`EMAIL_SMTP_HOST`/`EMAIL_SMTP_PORT`/`EMAIL_POLL_INTERVAL`/`EMAIL_ALLOWED_USERS` → REST PUT `/api/env`; enable toggle → PUT `/api/messaging/platforms/email`; test button → POST `/api/messaging/platforms/email/test` | S |
| A2 | `web/src/lib/email-diagnostics.ts` modeled on `im-onboarding-diagnostics.ts`; add `EMAIL_*`/`platforms.email.*` translations in `env-translations.ts`/`config-translations.ts`; docs link to Core `messaging/email.md` | S |
| A3 | (Optional, no-port fallback) In-process **outbound-only** email notification sender for desktop cron/alerts (nodemailer; no IMAP polling, no inbound events) — smallest useful TS email surface | M |
| B1 | Port pure modules: `ids.ts`, `html-strip.ts`, `mime.ts` (charset alias), `auth-results.ts`, `threading.ts` + parity tests | M |
| B2 | Port `imap-client.ts` (imapflow; ID command, UNSEEN search, malformed-response guards, cleanup) + `smtp-client.ts` (nodemailer; 465 vs STARTTLS, IPv4 retry) + `access.ts` + `attachments.ts` | L |
| B3 | Port `adapter.ts` (lifecycle, poller, dispatch, send paths, seen-UID cap) + `diagnostics.ts`; wire to `PlatformAdapter`/agent-loop bridge; decide Node-host vs Rust-host for sockets | L |

(S=small ≤3d, M=medium ≤1w, L=large >1w. A1–A2 are the actual v1 work; B* is the recorded port
backlog.)

## 9. Risks & open questions
- **No TS equivalent found in kimi-code (HIGH).** Zero IMAP/SMTP client implementation in the
  reference monorepo; `nodemailer`/`imapflow`/`mailparser` absent from `node_modules` and all
  package.json files. There is no in-repo precedent for raw-socket email I/O; the port relies on
  new pnpm dependencies and official library docs.
- **Raw sockets in the Tauri webview (HIGH).** The renderer cannot open TCP/TLS sockets, so an
  in-process email bot cannot live in the React webview. Must choose (a) Node main-process/sidecar
  host for imapflow+nodemailer, or (b) Rust-hosted IMAP/SMTP via Tauri IPC (crates `imap`,
  `lettre`, `mail-parser`, `native-tls`) — replacing the Section 5 SDKs; affects
  `messaging-gateway-core`'s host model and every external messaging platform plan.
- **Sender-authentication parity (HIGH, security).** The Authentication-Results fail-closed gate
  and `authserv_id` pinning are security-critical (`test_email.py::TestSenderAuthentication`).
  Header ordering, alignment (relaxed DMARC domain matching), and opt-out semantics must port
  exactly; a TS parser bug would silently weaken spoof protection.
- **Charset/decoding parity (MEDIUM).** `unknown-8bit`, `gb2312→gb18030`, malformed RFC 2047, and
  latin-1 last-resort must degrade instead of raising — a throw in per-message decode permanently
  loses mail because UIDs are marked seen before fetch (#35901/#55381/#55383). mailparser's
  default charset handling differs from Python's; the alias table must be applied explicitly.
- **NetEase/163 IMAP ID (MEDIUM).** Without the RFC 2971 ID command, 163 returns `BYE Unsafe
  Login` on every UID SEARCH; imapflow's `id()` must be wired post-login and best-effort.
- **IPv4-only retry (MEDIUM).** SMTP connect must retry through an IPv4-only socket path on
  connection-level timeout (unreachable IPv6), while TLS verification errors must NOT be retried;
  nodemailer/imapflow custom-socket injection is needed and unverified.
- **Poll-based receive (LOW-MEDIUM).** Email has no push; default 15 s latency and one-connection
  polling are inherent. Duplicate replies can only happen with multiple gateway instances — the
  seen-UID set is in-memory per process.
- **Gmail/outlook auth modes (MEDIUM, open).** Python uses plain password/app-password LOGIN;
  OAuth2/XOAUTH2 is not implemented in Core. The TS port should stay parity (app passwords) and
  note XOAUTH2 as a future extension.
- **Open questions:** Where does the in-process adapter run (Node sidecar vs Rust IPC)? Should the
  Desktop surface Email inside `im-onboarding.tsx` or a dedicated settings route (recommended: no
  QR)? Should `require_authenticated_sender` stay fail-closed in the UI (yes — keep parity, expose
  opt-out)? Need `EMAIL_HOME_ADDRESS` cron delivery UI now? Surface Core's `env_vars` metadata?

## 10. Test strategy

Parity tests (vitest) mirroring the Python suites 1:1 in `packages/email-adapter/src/**/*.test.ts`
(in-process port) plus Playwright E2E for the v1 settings surface:
- `helpers.test.ts` ↔ `test_email.py::TestHelperFunctions` + `test_email_robustness.py::TestMessageIdDomain`:
  RFC 2047 header decode, `extractEmailAddress("John Doe <john@example.com>")`, HTML strip,
  Message-ID domain falls back to `localhost` without `@`.
- `mime.test.ts` ↔ `test_email_charset_fallback.py`: `unknown-8bit` decode, garbage charset labels
  never throw, `gb2312`→GBK extensions, malformed encoded-word, latin-1 last resort; multipart
  prefers plain over html, html-only fallback strip.
- `auth-results.test.ts` ↔ `test_email.py::TestSenderAuthentication`: dmarc=pass authenticates,
  aligned dkim passes, misaligned spf rejected, injected header below trusted header ignored with
  `authserv_id` pinning, fail-closed with no header.
- `access.test.ts` ↔ `test_email.py::TestDispatchMessage`: self-message filtered, `[Subject: …]`
  prefix for non-`Re:`, reply subject not duplicated, image attachment → PHOTO + media_urls,
  empty allowlist without allow-all drops (fail-closed 2.6), allow-all bypasses auth gate;
  automated-sender patterns (`noreply@`, `Auto-Submitted`, `Precedence: bulk`, `List-Unsubscribe`).
- `threading.test.ts` ↔ `test_email.py::TestThreadContext`/`TestSendMethods`: `Re:` prefix (no
  double), `In-Reply-To`/`References` from `_threadContext`, `sendDocument` produces an
  `attachment` part, `getChatInfo` returns `{name, type:'dm', subject}`.
- `connect.test.ts` ↔ `test_email.py::TestConnectDisconnect` + `TestConnectionConfigResolution`:
  successful connect skips existing messages (seen UID count), missing host → `False` +
  non-retryable `email_missing_configuration` without touching IMAP, blank env vars are not
  required.
- `imap-client.test.ts` ↔ `test_email.py::TestFetchNewMessages`/`TestImapConnectionCleanup`/
  `TestImapIdExtensionForNetEase` + `test_email_robustness.py`: skip seen UIDs, fetch dispatch,
  logout called even when fetch raises, `ID` sent after LOGIN (before UID SEARCH), malformed fetch
  responses (`[None]`, single-bytes, non-bytes) skipped without aborting the batch, UID seen-before-
  fetch ordering.
- `smtp-client.test.ts` ↔ `test_email.py::TestSmtpConnectionCleanup`/`TestConnectSmtp`/
  `TestSendEmailStandalone`: close called when quit also fails, IPv6 timeout → IPv4-only retry,
  port 465 implicit TLS vs 587 STARTTLS, standalone send uses verified STARTTLS context + subject
  `Hermes Agent` + Date header.
- `secret-scope.test.ts` ↔ `test_email_secret_scope.py`: profile-scoped EMAIL_* reads (no
  cross-profile leak), unscoped DEFAULT-profile fallback under multiplex, scoped ports/poll-interval/
  trust-flag do not inherit environ.
- `email-settings.e2e.ts` (Playwright): open `/settings/platforms/email`, save form → PUT `/api/env`
  called, enable → PUT platform, test → POST `/api/messaging/platforms/email/test`, diagnostics
  bundle renders required keys without plaintext secrets. Unit tests use mocked imapflow/nodemailer/
  fetch only — **no network in unit tests**. CI runs `pnpm typecheck` + `pnpm test:unit`.

## 11. Reference links
- Core source: `D:/hermes-agent-cn/plugins/platforms/email/{adapter.py,__init__.py,plugin.yaml}`
- Core config: `D:/hermes-agent-cn/gateway/config.py` (2164–2183 `_apply_env_overrides`)
- Core REST: `D:/hermes-agent-cn/hermes_cli/web_server.py` (8637 email catalog; 8884–8897 field
  metadata; 9072 `"email": ("EMAIL_",)` prefix)
- Core docs: `D:/hermes-agent-cn/website/docs/user-guide/messaging/email.md`
- Core tests: `D:/hermes-agent-cn/tests/gateway/test_email.py`, `test_email_robustness.py`,
  `test_email_charset_fallback.py`, `test_email_secret_scope.py`
- Desktop: `web/src/routes/settings.tsx` (1478 platform list), `web/src/routes/im-onboarding.tsx`,
  `web/src/lib/im-onboarding-diagnostics.ts`, `web/src/hooks/use-im-onboarding.ts`,
  `web/src/lib/transport.ts`, `web/src/lib/env-translations.ts` (no `EMAIL_*` yet),
  `packages/protocol/src/channels.ts` (`ImPlatform = "feishu" | "weixin"` at 491),
  `packages/protocol/src/hermes-api.ts` (`MessagingPlatformInfo` at 127)
- Sibling plans: `D:/Hermes-CN-Desktop/plans/telegram-platform.md` (same port-decision
  pattern), `slack-platform.md`, `messaging-gateway-core.md` (`PlatformAdapter` contract,
  WS-removal ownership), `_INDEX.md` (#75 `email-platform`)
- TS SDKs (new deps, not in kimi-code): https://github.com/mscdex/imapflow (IMAP, recommended),
  https://github.com/nodemailer/nodemailer (SMTP, recommended), https://github.com/postalsys/mailparser
  (MIME parsing); RFCs: RFC 2971 (IMAP ID), RFC 2047 (encoded words), RFC 7489 (DMARC alignment)
