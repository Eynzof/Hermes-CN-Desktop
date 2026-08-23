# Yuanbao (Tencent) Messaging Platform Adapter — Python → TypeScript Rewrite Plan

> Feature slug: `yuanbao-platform`
> Scope: Yuanbao forwarded-record heartbeat fix + media download SSRF hardening.
> Plan type: design-only (NO implementation). All paths are repo-relative to
> `D:/hermes-agent-cn` (Python), `D:/kimi-code` (TS reference),
> `D:/Hermes-CN-Desktop` (Desktop frontend).

## 1. Summary

Yuanbao is Tencent's enterprise messaging platform. Hermes connects to it with a
persistent **WebSocket client** (`gateway/platforms/yuanbao.py`), HMAC-signed
AUTH_BIND, a hand-written protobuf wire codec (`yuanbao_proto.py`), a 20-stage
inbound middleware pipeline, outbound message/media senders, and COS-based media
upload. This plan covers two hardening items in the Python source of truth and
records the port decision for the Desktop rewrite:

1. **Forwarded-record loading heartbeat** — `ForwardedRecordsParseMiddleware`
   must actually `await` the RUNNING reply heartbeat (`_send_loading_heartbeat`)
   so a forwarded WeChat chat-history bundle (elem_type 1009) shows the loading
   bubble instead of silently dropping a coroutine.
2. **Media SSRF hardening** — `yuanbao_media.download_url()` must reject
   private/loopback/metadata targets up front and on every redirect hop before
   the gateway fetches model-supplied or inbound media URLs.

**Port decision (recorded).** Messaging platform adapters are **gateway-side**:
they are long-lived outbound WS clients that require a persistent runtime and
are unrelated to the Desktop↔Python WS link being removed. Per
`plans/README.md`, this feature is marked **"out of scope for desktop
standalone"** with the following split:

- **In scope now (Core):** land the two Python fixes + parity tests. This is
  independent of the Desktop roadmap.
- **In scope now (Desktop, minimal):** the settings DebugCard already renders
  `status.gateway_platforms` generically (`web/src/routes/settings.tsx`), so a
  connected Yuanbao adapter appears automatically. Optional narrow deltas are
  described in §6 (add `"yuanbao"` to the `ImPlatform` diagnostics union).
- **Deferred (recorded, not scheduled):** a full TypeScript port of the
  adapter (Option B sketch in §3). Rationale: no official Tencent Yuanbao TS
  SDK exists (verified absent in kimi-code, §5), the wire protocol is internal
  and non-trivial, and the Desktop end-state does not need an in-process
  messaging gateway.

**WS-removal implication (key point):** there are two independent WS links —
(1) Desktop ↔ Python runtime (`/api/ws`, removal target) and (2) Yuanbao
adapter ↔ Tencent gateway (outbound, **must stay**). Removing link (1) must
never be read as removing link (2); the Python gateway remains an optional
sidecar for messaging adapters, and the frozen REST status surface is the only
Desktop-facing API (§7).

## 2. Current Python implementation

Source of truth: `D:/hermes-agent-cn`.

### 2.1 Files

| File | Role | Key anchors |
|---|---|---|
| `gateway/platforms/yuanbao.py` (~5290 lines) | Adapter: WS lifecycle, HMAC auth, inbound pipeline, outbound send | `ForwardedRecordsParseMiddleware` L2140, `MediaResolveMiddleware` L2314, `InboundPipelineBuilder` L3045, `ConnectionManager` L3084, `HeartbeatManager` L4167, `SlowResponseNotifier` L4290, `MessageSender` L4339, `OutboundManager` L4768, `YuanbaoAdapter` L4864, `get_active_adapter()` L5286 |
| `gateway/platforms/yuanbao_media.py` | COS upload + media download/build | `download_url()` L202–270, `_cos_sign()` L275, `get_cos_credentials()` L359, `upload_to_cos()` L437, `parse_image_size()` L121 |
| `gateway/platforms/yuanbao_proto.py` | Hand-written protobuf wire codec + constants | `WS_HEARTBEAT_RUNNING=1` L101, `WS_HEARTBEAT_FINISH=2` L102, `HERMES_INSTANCE_ID=17` L98, `BIZ_SERVICES` L81–95, `next_seq_no()` L113 |
| `tools/url_safety.py` | SSRF guard used by media download | `is_safe_url()` L415, `async_is_safe_url()` L522, `SSRFConnectionBlocked` L531, `_is_blocked_ip()` L289 |
| `gateway/config.py` | Platform enum + env/config | `Platform.YUANBAO = "yuanbao"` L347, env auto-config L2528–2534 |
| `website/docs/user-guide/messaging/yuanbao.md` | User docs (342 lines) | WS gateway, HMAC auth, COS media, forwarded chat-history L101, "Media URLs are automatically validated … to prevent SSRF" L124 |

### 2.2 Inbound data flow (forwarded heartbeat context)

```
Tencent WS frame
  → ConnectionManager receive loop (L3084) decodes ConnMsg (yuanbao_proto)
  → inbound push → InboundPipeline (L736) runs 20 middlewares in order (L3053–3074):
      Decode → ExtractFields → RecallGuard → Dedup → SkipSelf → ChatRouting →
      AccessGuard → ExtractContent → PlaceholderFilter → OwnerCommand →
      BuildSource → GroupAtGuard → AutoSetHome → GroupAttribution →
      ClassifyMessageType → QuoteContext → ForwardedRecordsParse →
      MediaResolve → PatchAnchors → Dispatch
  → ForwardedRecordsParseMiddleware.handle() (L2160):
      if ctx.forwarded_records:
          await self._send_loading_heartbeat(ctx)   # L2163 (the awaited fix)
          ctx.raw_text = build_forward_text(...)
  → _send_loading_heartbeat (L2176–2184):
      await ctx.adapter._outbound.heartbeat.send_heartbeat_once(chat_id, WS_HEARTBEAT_RUNNING)
  → HeartbeatManager.send_heartbeat_once (L4181–4209):
      encode_send_group/private_heartbeat → conn.ws.send(encoded)
```

`HeartbeatManager._worker` (L4231) then keeps sending RUNNING every 2 s
(`REPLY_HEARTBEAT_INTERVAL_S=2.0`, L150) and auto-sends FINISH after 30 s
inactivity (`REPLY_HEARTBEAT_TIMEOUT_S=30.0`, L151). The connection-level
keepalive ping is separate (`HEARTBEAT_INTERVAL_SECONDS=30.0`, L123) — do not
conflate the two in any TS design.

### 2.3 Media download flow (SSRF context)

```
MediaResolveMiddleware._fetch_resource_url (L2386) → direct download URL
  (e.g. /api/resource/v1/download) — inbound media;
outbound ImageUrlHandler (L3882) / FileUrlHandler (L3935) — model-supplied URLs;
both call yuanbao_media.download_url(url, max_size_mb=50) (L202):
  from tools.url_safety import create_ssrf_safe_async_client, is_safe_url
  if not is_safe_url(url): raise ValueError("Blocked unsafe URL (SSRF protection)…")
  redirect guard on every hop: is_safe_url(redirect_url)  (L228–234)
  HEAD content-length preflight (L243–251) then streaming GET with size cap (L253–267)
```

`tools.url_safety.is_safe_url()` blocks private/loopback/link-local ranges,
cloud-metadata sentinel IPs, resolves DNS and rejects internal-host results,
and supports a global allow-private override (`_global_allow_private_urls`).
The async transport backend (`_SSRFGuardedAsyncNetworkBackend`) re-checks IPs at
connect time to close DNS-rebinding gaps.

### 2.4 Existing Python tests (parity anchors)

| Test | Coverage |
|---|---|
| `tests/gateway/test_yuanbao_forwarded_heartbeat.py` | (1) forwarded records ⇒ exactly one `("chat-1", WS_HEARTBEAT_RUNNING)` call + `next_fn` still invoked, with `RuntimeWarning` promoted to error; (2) no forwarded records ⇒ no heartbeat |
| `tests/gateway/test_yuanbao_media_ssrf.py` | `download_url("http://169.254.169.254/latest/meta-data/")` and `http://127.0.0.1:8080/secret` both raise `ValueError` matching `"SSRF protection"` |
| `tests/gateway/platforms/test_yuanbao_recall_db_only.py` | Recall branch A1 (exact `message_id`) round-trips via `state.db` `platform_message_id` column |
| `tests/gateway/platforms/test_yuanbao_state_cleanup.py` | `_processing_msg_ids/texts` cleanup + `_member_cache` TTL eviction (5 tests) |

## 3. Target TypeScript design

### 3.1 Option A — recommended: keep adapter gateway-side (no TS port)

Desktop does not host the Yuanbao adapter. The Python gateway stays as an
optional sidecar; Desktop consumes only the frozen REST/status surface (§7).
No new TS module is required for this feature. Desktop-visible work is limited
to §6 diagnostics/display deltas.

### 3.2 Option B — deferred full TS port (sketch, for the record)

If the port decision later flips (e.g. an in-process messaging gateway becomes a
product requirement), module layout under the Desktop monorepo:

```
packages/yuanbao/                  # new package (or web/src/gateway/yuanbao/)
  src/proto.ts                     # hand-written protobuf wire codec (varint/zigzag)
  src/connection.ts                # YuanbaoConnection: ws connect, AUTH_BIND, ping, reconnect
  src/sign.ts                      # SignManager: HMAC sign-token, request signing
  src/inbound.ts                   # InboundPipeline + middlewares (incl. ForwardedRecordsParse)
  src/heartbeat.ts                 # HeartbeatManager: RUNNING/FINISH reply heartbeats
  src/media.ts                     # downloadUrl, cosSign, getCosCredentials, uploadToCos
  src/ssrf.ts                      # SSRF guard (no TS equivalent found — §5)
  src/index.ts                     # YuanbaoAdapter façade (implements gateway-side interface)
```

Key interfaces (signatures only):

```ts
interface ReplyHeartbeat { sendHeartbeatOnce(chatId: string, val: 1 | 2): Promise<void>; }
interface InboundContext { adapter: unknown; chatId: string; forwardedRecords?: unknown[]; rawText?: string; }
class ForwardedRecordsParseMiddleware {
  async handle(ctx: InboundContext, next: () => Promise<void>): Promise<void> {
    if (ctx.forwardedRecords?.length) await this.sendLoadingHeartbeat(ctx); // MUST await
    ctx.rawText = this.buildForwardText(ctx.forwardedRecords, ctx);
    await next();
  }
}
async function downloadUrl(url: string, opts?: { maxSizeMb?: number }): Promise<{ data: Uint8Array; contentType: string }>;
```

Data flow mirrors §2.2/§2.3 exactly, with `ws` replacing `websockets` and
`undici`/`fetch` replacing `httpx` (§5).

## 4. Data models & persistence

All of the following lives in the Python gateway today and stays there under
Option A; the table records what a future TS port must replicate.

| Data | Python today | TS port plan (if any) |
|---|---|---|
| Sessions/transcripts | `gateway/session.py` SessionStore; JSONL + `state.db`; `platform_message_id` column round-trips `message_id` (test_yuanbao_recall_db_only.py) | Desktop `packages/minidb` (kimi-code embedded DB) or IndexedDB; must keep `message_id` column semantics for recall branch A1 |
| Session key format | `yuanbao:group:G:user:U` (build_session_key) | Same string format; parse `direct:`/`group:` prefixes |
| Recall/turn tracking | `YuanbaoAdapter._processing_msg_ids/texts` keyed by session key; cleared on turn finish (test_yuanbao_state_cleanup.py) | In-memory `Map<sessionKey, string>`; cleanup semantics per tests |
| Member cache | `_member_cache: group_code -> (ts, members[])`, `MEMBER_CACHE_TTL_S=300` | In-memory Map with read-time TTL eviction |
| Media resource cache | `MediaResolveMiddleware._resource_cache` rid → `(local_path, mime, ts)`, TTL 24 h, max 256, LRU-ish eviction | In-memory Map + disk cache dir; same TTL/cap |
| Reply heartbeat state | `HeartbeatManager._reply_heartbeat_tasks/_reply_hb_last_active` per chat | Ephemeral only — no persistence |
| Config/secrets | `~/.hermes/.env` `YUANBAO_APP_ID/SECRET/WS_URL/API_DOMAIN/BOT_ID/ROUTE_ENV/HOME_CHANNEL`; `config.yaml` `platforms.yuanbao.extra.*` | Desktop reads redacted via onboarding bridge (`ImRedactedValue`, channels.ts) — never plaintext |

No schema migration is needed for this feature; the SSRF/heartbeat changes are
behavioral only.

## 5. Third-party library strategy

**kimi-code evidence base (verified this session):**
- `grep -ri yuanbao D:/kimi-code` → **0 matches** (whole repo: source +
  node_modules + package.json).
- No `tencent`/`wechat`/`wework`/`qqbot`/`feishu`/`lark`/`dingtalk`/`telegram`
  directories or SDKs anywhere under `D:/kimi-code`.
- No `protobufjs`, no COS SDK (`cos-nodejs-sdk-v5`), no Yuanbao SDK in
  `D:/kimi-code/node_modules`.
- `ws@^8.18.0` in `packages/kap-server/package.json` L40 and
  `packages/klient/package.json` L53.
- `undici@^7.27.1` in `packages/agent-core/package.json` L102.

| Python dependency | TS equivalent | kimi-code evidence / rationale |
|---|---|---|
| `websockets` (WS client) | `ws` ^8.18.0 | kap-server L40, klient L53 — the de-facto Node WS client |
| `httpx` (async HTTP) | `undici` ^7.27.1 or global `fetch` | agent-core L102; thin REST calls (genUploadInfo, resource download, COS PUT) are plain fetch with headers |
| `pybase64`, `orjson` | Node `Buffer` + `JSON` | built-ins; no dep needed |
| `hmac` + `hashlib` (SHA1/SHA256) | `node:crypto` `createHmac('sha1'\|'sha256')` | built-in; needed for `_cos_sign` (HMAC-SHA1 q-sign) and AUTH_BIND |
| `xxhash` (`xxhash.xxh64` for file uuid) | **no exact built-in** — `xxhashjs` or a small XXH64 impl | verified absent in kimi-code node_modules; Node `crypto` md5/sha1 ≠ XXH64, so parity requires a tiny module if ported |
| hand-written protobuf codec (`yuanbao_proto.py`) | hand-written TS `DataView`/`Buffer` codec | `protobufjs` NOT in kimi-code; Python deliberately avoided a protobuf dep (docstring L16) — port should match: a ~300-line codec, no schema files |
| COS upload (Python avoids `cos-nodejs-sdk-v5`, uses HMAC PUT) | same approach: `crypto` HMAC + `undici` PUT | no COS SDK in kimi-code; keep thin REST (module docstring `yuanbao_media.py` L1–16 states the intent) |
| `tools.url_safety` (SSRF) | **no TS equivalent found** — implement `packages/protocol/src/ssrf.ts` (or eval `ssrf-req-filter` at install time) | kimi-code has no SSRF lib; Python's guard is sophisticated (DNS resolve + connect-time IP re-check + redirect guard); a TS port must match `is_safe_url` + redirect guard + IP re-check |
| **Tencent Yuanbao API SDK** | **none exists in kimi-code** (verified 0 matches); recommend **thin REST + `ws` + hand-rolled protobuf** | Python itself uses no SDK — only REST endpoints (`genUploadInfo`, `/api/resource/v1/download`) + WS; no official public SDK to adopt |

**Recommendation with rationale:** thin REST. The Python adapter already proves
the protocol is reachable with just `httpx` + `websockets` + a small codec. A TS
port should not introduce `tencentcloud-sdk-nodejs` (not Yuanbao-specific) or
any unofficial SDK; instead reuse `ws` + `undici` + `node:crypto` and port the
hand-written codec. Only two items have **no TS equivalent found**: XXH64
file-uuid hashing and the SSRF guard — both are small, well-scoped modules.

## 6. Integration with existing Hermes-CN-Desktop frontend

Verified current state (no "yuanbao" string anywhere in these files):

- `packages/protocol/src/channels.ts` L491: `export type ImPlatform = "feishu" | "weixin";`
- `web/src/lib/im-onboarding-diagnostics.ts`: `DIAGNOSTIC_REQUIRED_KEYS` /
  `DIAGNOSTIC_POLICY_KEYS` keyed by `ImPlatform` (weixin/feishu only, L105–118);
  reads `statusData.gateway_platforms` (L266).
- `web/src/routes/settings.tsx`: generic `gateway_platforms` DebugCard renders
  `{name, state, error_message}` for every platform (L1478–1491) — Yuanbao
  appears **automatically** once Core reports `yuanbao` in gateway status; no
  code change needed for display.
- `web/src/routes/im-onboarding.tsx`: feishu/weixin QR onboarding only; no
  yuanbao entry.

Recommended deltas (small, optional, desktop-side):

1. Add `"yuanbao"` to the `ImPlatform` union in `packages/protocol/src/channels.ts`.
2. Add `yuanbao: ["YUANBAO_APP_ID", "YUANBAO_APP_SECRET"]` to
   `DIAGNOSTIC_REQUIRED_KEYS` and optional policy keys
   (`YUANBAO_DM_POLICY`, `YUANBAO_GROUP_POLICY`, `YUANBAO_HOME_CHANNEL`) in
   `im-onboarding-diagnostics.ts`, plus label/explain branches.
3. **Do not** reuse the feishu/weixin QR onboarding bridge for Yuanbao: docs
   show Yuanbao setup is a CLI wizard (`hermes gateway setup`) with APP_ID /
   APP_SECRET, no QR device flow. If a guided flow is wanted later, it needs a
   new backend flow (form → write `.env` → restart gateway), not the existing
   `im_onboarding_begin/poll/apply` commands.
4. Rust `src/commands/*`: no new Tauri command is required for this feature.

## 7. Removing the WebSocket dependency (migration path)

Two distinct WS links must be kept separate:

| Link | Direction | Status under roadmap |
|---|---|---|
| Desktop ↔ Python runtime (`/api/ws` JSON-RPC, `web/src/lib/gateway-client.ts`) | client→server | **removal target** (in-process TS agent) |
| Yuanbao adapter ↔ Tencent WS gateway (`wss://bot-wss.yuanbao.tencent.com/wss/connection`, `yuanbao.py` `ConnectionManager`) | outbound client | **must stay** while Yuanbao is supported |

**WS-removal implications for this feature:**

1. Removing the Desktop↔Python WS link must not remove the Yuanbao outbound WS
   client. The Python gateway becomes an optional **messaging sidecar**, which
   is exactly why the port decision is "out of scope for desktop standalone".
2. Freeze the Desktop-facing API surface that the adapter must keep exporting:
   - GET gateway status: `gateway_platforms[<name>] -> {state, error_message}` (settings.tsx already renders it);
   - config read: `YUANBAO_*` keys as `ImRedactedValue` (set/fingerprint only);
   - health endpoint (`gateway_health_url`).
3. Migration phases:
   - Today: Desktop reads `gateway_platforms` over the WS JSON-RPC status.
   - Phase 2 (pre-removal): switch status/config reads to REST polling so the
     adapter status is WS-link-independent before link (1) is deleted.
   - After link (1) removal: gateway sidecar + REST remains; the Yuanbao
     adapter never touches the Desktop WS path.

## 8. Migration phases & task breakdown

| Phase | Work | Acceptance criteria |
|---|---|---|
| **P0 — Core fixes (not Desktop-blocked)** | Land `await` in `ForwardedRecordsParseMiddleware.handle()` (yuanbao.py L2163); keep SSRF guard in `download_url` + `tools.url_safety` as-is; add/keep parity tests | `pytest tests/gateway/test_yuanbao_forwarded_heartbeat.py tests/gateway/test_yuanbao_media_ssrf.py` green; `RuntimeWarning` promoted to error stays in test |
| **P1 — Desktop diagnostics surface (optional, small)** | Add `"yuanbao"` to `ImPlatform`; add `DIAGNOSTIC_REQUIRED_KEYS`/policy keys; add labels/explain branches | `pnpm typecheck`; unit tests for diagnostics keys; settings DebugCard shows `yuanbao` state from mocked `gateway_platforms` |
| **P2 — WS-removal prep** | Move status/config reads from WS JSON-RPC to REST polling (`web/src/lib/transport.ts` path); freeze `gateway_platforms` schema | Desktop shows Yuanbao status with gateway WS link disconnected |
| **P3 — Deferred full TS port (only if decision flips)** | Port per §3.2: proto codec → connection → sign → inbound pipeline → heartbeat → media + ssrf; parity-test against Python fixtures | Vitest parity suite (§10) passes against captured Python fixtures |

## 9. Risks & open questions

- **No TS equivalent found (highest risk):** the Yuanbao wire protocol is
  internal; no official Tencent SDK exists in kimi-code (verified 0 matches).
  A TS port is a from-scratch protocol reimplementation with drift risk against
  `yuanbao_proto.py`. Mitigation: keep Python as source of truth; only port if
  product requires an in-process gateway.
- **SSRF guard parity:** Python `tools.url_safety` blocks private IPs, link
  local, metadata sentinel IPs, DNS-resolves hosts, and re-checks IPs at
  connect time (DNS-rebinding defense). A TS thin shim must replicate at least
  `is_safe_url` + redirect guard; naive URL-string checks are insufficient.
- **XXH64 vs md5:** `yuanbao_media.md5_hex` uses `xxhash.xxh64`, not md5. Node
  `crypto` has no XXH64; parity requires `xxhashjs` or a hand-written impl
  (verify at install time; absent from kimi-code node_modules).
- **Heartbeat semantics:** reply heartbeat (RUNNING/FINISH, typing bubble,
  2 s/30 s) is distinct from the connection keepalive ping (30 s). A TS port
  must not merge them; the forwarded-record path only needs the one-shot
  RUNNING send + the periodic worker.
- **WS-removal confusion:** reviewers may assume "remove WS" includes the
  Yuanbao outbound client. The plan records the distinction explicitly (§7).
- **Open question:** should Desktop ship a Yuanbao guided-setup flow at all?
  Docs show CLI-only wizard today; adding a form flow is product scope beyond
  this feature.
- **Open question:** is `media_resolve_concurrency` (default 6, L189) and the
  24 h resource cache part of the SSRF contract? They are orthogonal but
  should be pinned in parity fixtures if a TS port happens.

## 10. Test strategy

**Python parity anchors (already in Core, keep green):**
- `tests/gateway/test_yuanbao_forwarded_heartbeat.py` — await-heartbeat regression,
  `RuntimeWarning` → error.
- `tests/gateway/test_yuanbao_media_ssrf.py` — metadata + loopback blocked.
- `tests/gateway/platforms/test_yuanbao_recall_db_only.py`,
  `test_yuanbao_state_cleanup.py` — persistence/turn-state parity.

**Vitest (only if Option B port happens):**
- `proto.test.ts`: round-trip encode/decode fixtures captured from Python
  (`yuanbao_proto` hex dumps).
- `heartbeat.test.ts`: fake WS server asserts RUNNING frame before FINISH;
  forwarded-records path sends exactly one RUNNING and still calls `next`.
- `media.test.ts` / `ssrf.test.ts`: URL table (169.254.169.254, 127.0.0.1,
  ::1, link-local, private DNS names) all reject; redirect to private IP rejects;
  `xxh64` uuid matches Python fixture.
- `cos.test.ts`: HMAC-SHA1 q-sign string matches Python `_cos_sign` golden value.

**Playwright / integration:**
- Settings page renders `yuanbao: connected` from a mocked `gateway_platforms`
  payload (covers §6 display).
- Diagnostics page for `platform: "yuanbao"` lists `YUANBAO_APP_ID/SECRET`
  required-key warnings (if P1 accepted).

**Parity matrix (Python → TS):**

| Behavior | Python test | TS test (if ported) |
|---|---|---|
| Forwarded records ⇒ RUNNING heartbeat awaited | test_yuanbao_forwarded_heartbeat.py | heartbeat.test.ts |
| No forwarded records ⇒ no heartbeat | same file, 2nd test | same |
| SSRF: metadata IP blocked | test_yuanbao_media_ssrf.py | ssrf.test.ts |
| SSRF: loopback blocked | same file | same |
| `message_id` round-trip through DB | test_yuanbao_recall_db_only.py | minidb test (if ported) |
| Turn tracking cleanup | test_yuanbao_state_cleanup.py | in-memory test (if ported) |

## 11. Reference links

- `D:/hermes-agent-cn/gateway/platforms/yuanbao.py`
- `D:/hermes-agent-cn/gateway/platforms/yuanbao_media.py`
- `D:/hermes-agent-cn/gateway/platforms/yuanbao_proto.py`
- `D:/hermes-agent-cn/gateway/platforms/ADDING_A_PLATFORM.md`
- `D:/hermes-agent-cn/gateway/platforms/base.py` (BasePlatformAdapter)
- `D:/hermes-agent-cn/gateway/config.py` (Platform.YUANBAO L347, env L2528)
- `D:/hermes-agent-cn/tools/url_safety.py`
- `D:/hermes-agent-cn/website/docs/user-guide/messaging/yuanbao.md`
- `D:/hermes-agent-cn/tests/gateway/test_yuanbao_forwarded_heartbeat.py`
- `D:/hermes-agent-cn/tests/gateway/test_yuanbao_media_ssrf.py`
- `D:/hermes-agent-cn/tests/gateway/platforms/test_yuanbao_recall_db_only.py`
- `D:/hermes-agent-cn/tests/gateway/platforms/test_yuanbao_state_cleanup.py`
- `D:/Hermes-CN-Desktop/plans/README.md` (template + scope conventions)
- `D:/Hermes-CN-Desktop/packages/protocol/src/channels.ts` (ImPlatform L491)
- `D:/Hermes-CN-Desktop/web/src/lib/im-onboarding-diagnostics.ts`
- `D:/Hermes-CN-Desktop/web/src/routes/im-onboarding.tsx`
- `D:/Hermes-CN-Desktop/web/src/routes/settings.tsx` (gateway_platforms L1478)
- `D:/Hermes-CN-Desktop/web/src/lib/gateway-client.ts`, `web/src/lib/transport.ts`
- `D:/kimi-code/packages/kap-server/package.json` (`ws` ^8.18.0)
- `D:/kimi-code/packages/klient/package.json` (`ws` ^8.18.0)
- `D:/kimi-code/packages/agent-core/package.json` (`undici` ^7.27.1)
