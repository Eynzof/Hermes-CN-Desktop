# Feishu / Lark Messaging Platform Adapter — Python → TypeScript Rewrite Plan

## 1. Summary

This plan covers the **Feishu / Lark messaging platform adapter** (飞书 / Lark 消息平台适配器): the
Feishu/Lark bot receive/send loop, interactive **approval buttons**, **meeting invite**
(`vc.bot.meeting_invited_v1`), **table markdown** (post+`md` payloads), and the shared helpers
(message/post normalization, mentions, media, markdown escape). Python source of truth is
`D:/hermes-agent-cn/plugins/platforms/feishu/` (~8.0k lines across 5 modules), documented in
`website/docs/user-guide/messaging/feishu.md` (590 lines), covered by ~15 test files under
`tests/gateway/`.

Key findings:
- **kimi-code has no Feishu/Lark equivalent** — grep for `feishu|lark|larksuiteoapi` returns only
  test fixtures referencing a fake `/skills/feishu/scripts/read_content.py` path; `node_modules`
  contains no `@larksuiteoapi` or `lark-oapi`.
- The official TS SDK **`@larksuiteoapi/node-sdk`** (ByteDance) is the direct equivalent of Python
  `lark-oapi`; verified on npm/GitHub: `Client` (REST), `WSClient` (long connection, ≥1.24.0),
  `EventDispatcher`, `messageCard.defaultCard`, and `registerApp` (device-authorization QR — the
  same flow the Rust onboarding already implements by hand).
- **Adapter port decision (recorded):** Feishu is a pure messaging-platform adapter, which the plans
  README explicitly permits to mark "out of scope for desktop standalone". The message plane
  (WS/webhook, events, cards, meeting invites) **stays in the managed Python runtime for now**;
  the desktop onboarding surface is already implemented in TS+Rust and keeps delegating to that
  runtime. This plan still provides the full in-process TS design (Sections 3–5) so the port can be
  executed later without re-research, and Section 7 records the WS-removal implications.

## 2. Current Python implementation

Source (all under `D:/hermes-agent-cn`):

| File | Lines | Role |
|---|---|---|
| `plugins/platforms/feishu/plugin.yaml` | 44 | Plugin manifest: name `feishu-platform`, label `Feishu / Lark`, `requires_env: FEISHU_APP_ID/FEISHU_APP_SECRET`, optional env list |
| `plugins/platforms/feishu/__init__.py` | 3 | Exposes `register` |
| `plugins/platforms/feishu/adapter.py` | 6013 | The adapter: settings, connect (WS/webhook), send/media, cards/approval, admission, batching, dedup, webhook security, onboarding QR |
| `plugins/platforms/feishu/feishu_meeting_invite.py` | 212 | `vc.bot.meeting_invited_v1` parse → synthetic `MessageEvent` |
| `plugins/platforms/feishu/feishu_comment.py` | 1380 | `drive.notice.comment_add_v1` doc-comment intelligent reply (separate subsystem) |
| `plugins/platforms/feishu/feishu_comment_rules.py` | 429 | 3-tier doc access rules (exact > wildcard > top), JSON hot-reload |

Adapter registration (`adapter.py::register`, line 5992) calls
`ctx.register_platform(name="feishu", label="Feishu / Lark", adapter_factory=_build_adapter,
check_fn=feishu_deps_present, ensure_deps_fn=check_feishu_requirements, is_connected=_is_connected,
validate_config=_is_connected, required_env=[FEISHU_APP_ID, FEISHU_APP_SECRET], setup_fn=interactive_setup,
apply_yaml_config_fn=..., allowed_users_env="FEISHU_ALLOWED_USERS", allow_all_env="FEISHU_ALLOW_ALL_USERS",
cron_deliver_env_var="FEISHU_HOME_CHANNEL", standalone_sender_fn=..., max_message_length=8000, emoji="🪽",
allow_update_command=True)`. Gateway `Platform.FEISHU = "feishu"` is defined in `gateway/config.py:341`.

Key SDK usage (`_lark_bindings`, line 135): lazy `import lark_oapi` (deferred to first connect, ~2.5s
warm; `FEISHU_AVAILABLE = find_spec("lark_oapi")`), `FeishuWSClient` (websocket), `EventDispatcherHandler`,
`P2CardActionTriggerResponse`/`CallBackCard`, REST requests via `BaseRequest` (message create/update/reply,
chat get, message resource, bot info). Optional deps `aiohttp` (webhook) and `websockets` (ws availability)
are imported independently of lark_oapi.

Main data flow:
```
Feishu/Lark open platform --WS long connection (lark_oapi.ws.Client) | --HTTP webhook (aiohttp)-->
  EventDispatcherHandler -> _on_message_event / _on_reaction_event / _on_card_action_trigger /
                             _on_drive_comment_event / _on_meeting_invited_event
  -> normalize (post/card/text/media -> FeishuNormalizedMessage)
  -> admission (_admit / _mentions_self / group policy / allow_bots)
  -> MessageEvent -> gateway pipeline -> agent -> reply via send() (text | post(md) | interactive card)
```

Feature inventory (what the TS port must preserve):
- **Bot receive/send**: text, post (rich text), image/file/audio/video (upload → native bubble),
  reply/thread, edit_message, typing + processing reactions (Typing/CrossMark), per-chat serialization,
  text/media burst batching, dedup persisted to `~/.hermes/feishu_seen_message_ids.json`.
- **Approval buttons**: `send_exec_approval` builds an orange interactive card with 4 buttons
  (`approve_once|approve_session|approve_always|deny`) and stores `_approval_state[approval_id]`;
  `_on_card_action_trigger` resolves inline (`P2CardActionTriggerResponse.card.type == "raw"`), calls
  `tools.approval.resolve_gateway_approval(session_key, choice)` (line 2659), gates clicks by
  admin/allowlist (`_is_interactive_operator_authorized`). `send_update_prompt` is the update-confirmation
  y/n card that writes `.update_response`.
- **Meeting invite**: `feishu_meeting_invite.py::handle_meeting_invited_event` parses the event
  (`body.content[].data` JSON unwrap), dedups, resolves sender profile, and routes a synthetic
  `MessageEvent` to the inviter (`chat_id = inviter.open_id`); `feishu_user_id:<id>` chat ids switch
  `receive_id_type` to `user_id`.
- **Table markdown**: `_build_outbound_payload` (line 4729) chooses `post` (md tag) vs `text`; the
  regression #52786 requires pipe tables → `post` (never downgrade); `_build_markdown_post_rows`
  splits fenced code blocks into separate rows; post payload shape `{"zh_cn": {"content": [[{"tag":"md","text":...}]]}}`.
- **Helpers**: post/card parsing (`parse_feishu_post_payload`, `normalize_feishu_message`), mention
  map/hint, `_escape_markdown_text`, `_strip_markdown_to_plain_text` (delegates to
  `gateway.platforms.helpers.strip_markdown`), webhook signature
  `SHA256(timestamp + nonce + encrypt_key + body)` + verification token, rate limiting, anomaly tracker.

Docs to port alongside: `website/docs/user-guide/messaging/feishu.md` — full env table (see §4),
connection modes, group policy, card-action requirements (error 200340: subscribe `card.action.trigger`,
enable Interactive Card, set Card Request URL), meeting invite config, troubleshooting.

## 3. Target TypeScript design

Recommended module layout (new `packages/feishu` inside the desktop monorepo; used by `web/src` via
the existing `@hermes/*` workspace alias convention):

```
packages/feishu/src/
  types.ts        # FeishuMessage, FeishuNormalizedMessage, FeishuMentionRef, MediaRef, FeishuAdapterSettings
  config.ts       # loadConfig(env: Record<string,string>) -> FeishuAdapterSettings (mirror _load_settings/_apply_settings)
  client.ts       # thin wrapper over @larksuiteoapi/node-sdk Client + WSClient (lazy init, like _lark_bindings)
  normalize.ts    # parse post/card/text payloads -> FeishuNormalizedMessage (port of parse_feishu_post_payload etc.)
  markdown.ts     # markdown detection + post payload builder (_MARKDOWN_HINT_RE, _build_markdown_post_payload/_rows), plain-text fallback
  cards.ts        # approval card + update-prompt card builders & resolved-card builders
  approval.ts     # approval state store + resolve (mirror _approval_state/_resolve_approval, calls ApprovalService)
  meetingInvite.ts# parse vc.bot.meeting_invited_v1 + build prompt + route (port of feishu_meeting_invite.py)
  adapter.ts      # FeishuAdapter implements GatewayPlatformAdapter interface (connect/disconnect/send/edit/approval hooks/status)
  registry.ts     # registerAdapter(registry: PlatformRegistry) — analogue of register()
  index.ts
```

Core interfaces (signatures only):

```ts
interface GatewayPlatformAdapter {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  send(target: SendTarget, payload: OutboundPayload, opts?: SendOptions): Promise<SendResult>;
  editMessage(messageId: string, payload: OutboundPayload): Promise<SendResult>;
  sendExecApproval(input: ExecApprovalInput): Promise<SendResult>;   // approval card
  sendUpdatePrompt(input: UpdatePromptInput): Promise<SendResult>;   // y/n card
  onMessage?: (event: MessageEvent) => void | Promise<void>;
  getStatus(): PlatformStatus;   // state: connected|not_configured|error, error_message, bot identity
}

interface ApprovalService { resolve(sessionKey: string, choice: "once"|"session"|"always"|"deny"): Promise<void>; }
```

Data flow in-process (no Python):
```
webview (React) -> FeishuAdapter.connect() -> lark.WSClient.start(EventDispatcher)
  -> onEvent -> normalize.ts -> admission (allowlist/group policy/@mention) -> MessageEvent
  -> agent runtime (in-process TS loop) -> adapter.send() -> lark.Client.im.v1.message.create
  -> card action -> approval.ts -> ApprovalService -> inline card update via lark API
```

The plan explicitly does **not** require implementing this now (see §8 Phase 1); this is the reference
design for the optional port.

## 4. Data models & persistence

Config (env → `FeishuAdapterSettings`; mirror `docs/user-guide/messaging/feishu.md` env table and
`gateway/config.py:2334-2358`):

| Env var | Default | Meaning |
|---|---|---|
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | — (required) | credentials |
| `FEISHU_DOMAIN` | `feishu` | `feishu` (CN) or `lark` (international) |
| `FEISHU_CONNECTION_MODE` | `websocket` | `websocket` or `webhook` |
| `FEISHU_ALLOWED_USERS` / `FEISHU_ALLOW_ALL_USERS` | empty / — | DM allowlist |
| `FEISHU_ALLOW_BOTS` | `none` | `none`/`mentions`/`all` |
| `FEISHU_REQUIRE_MENTION` | `true` | group @mention gate |
| `FEISHU_GROUP_POLICY` | `allowlist` | `open`/`allowlist`/`disabled` |
| `FEISHU_HOME_CHANNEL` (+ `_NAME`) | — | cron/notification delivery target |
| `FEISHU_ENCRYPT_KEY` / `FEISHU_VERIFICATION_TOKEN` | empty | webhook auth |
| `FEISHU_BOT_OPEN_ID` / `FEISHU_BOT_USER_ID` / `FEISHU_BOT_NAME` | empty | bot identity (auto-hydrated via `/bot/v3/info`) |
| `FEISHU_WEBHOOK_HOST/PORT/PATH` | `127.0.0.1`/`8765`/`/feishu/webhook` | webhook mode |
| `HERMES_FEISHU_DEDUP_CACHE_SIZE`, `HERMES_FEISHU_TEXT_BATCH_*`, `HERMES_FEISHU_MEDIA_BATCH_DELAY_SECONDS` | 2048 / 0.6s,8,4000 / 0.8s | tuning |

Persisted state (Python paths → TS strategy):
- `~/.hermes/feishu_seen_message_ids.json` — dedup cache; TS keeps JSON file, written via a small
  Rust command or `packages/minidb` key-value; keep the same 24h TTL + 2048-entry cap semantics.
- `_approval_state` — in-memory only (no persistence in Python); TS keeps in-memory Map; card inline
  update is the durable record.
- `_sender_name_cache`, bot identity cache — in-memory + `.env` refresh (`_hydrate_bot_identity` writes
  `FEISHU_BOT_OPEN_ID` back to env).
- `~/.hermes/feishu_comment_rules.json` + `feishu_comment_pairing.json` — only if doc-comment
  subsystem is ported (out of scope for the core port; keep as later phase).
- Secrets remain in `~/.hermes/.env` (managed by `src/commands/im_onboarding.rs` today); TS adapter
  reads via the same Rust env-access path — never store secrets in webview storage.

## 5. Third-party library strategy

**Most important section.** Every Python dependency → TS equivalent, with kimi-code evidence:

| Python | TS equivalent | Evidence / decision |
|---|---|---|
| `lark-oapi` (Feishu SDK) | **`@larksuiteoapi/node-sdk`** (official ByteDance SDK) | **NOT present in kimi-code** (`node_modules/@larksuiteoapi` absent; no `lark-oapi`; grep hits are only test-fixture paths). Verified on npm (`npmjs.com/package/@larksuiteoapi/node-sdk`) and `github.com/larksuite/node-sdk`: `Client` REST, `WSClient` long-connection (≥1.24.0), `EventDispatcher`, `messageCard.defaultCard`, `registerApp` (device-auth QR). **Recommendation: add this dependency** — it is the only maintained SDK covering both REST + WS long connection + card callbacks, which maps 1:1 to Python `lark-oapi`. |
| `websockets` (Python ws transport) | `WSClient` built on `ws`; monorepo already uses `ws ^8.18.0` in `packages/klient` + `packages/kap-server` | If a raw client is ever needed (webview/sidecar), `ws` is proven in-repo. kimi-code evidence: `packages/klient/package.json:53`, `packages/kap-server/package.json:40`. |
| `aiohttp` (webhook mode) | Node `http`/`express` or Tauri Rust command | Webhook mode is optional/low priority for desktop; no kimi-code server dep needed (kap-server has its own HTTP+WS infra that can be reused). |
| `orjson` | built-in `JSON` (or `zod` in `packages/protocol` for wire validation) | Python's `orjson` is a perf choice; TS native JSON suffices; protocol schemas already zod-based. |
| `markdown` regex helpers (`_MARKDOWN_HINT_RE`, table detection, escape) | **Implement from scratch as `packages/feishu/src/markdown.ts`** | No kimi-code equivalent does Feishu post conversion. `marked@18.0.5` exists in `packages/pi-tui/package.json:61` if tokenization is wanted, but Python uses lightweight regexes; port the regexes + table/fence logic directly (issue #52786 parity). |
| `tools.approval` (resolve_gateway_approval) | kimi-code approval/permission services (`packages/agent-core/src/agent/permission/`, `src/services/approval/`) | TS equivalent exists in-repo (README cites these paths); the Feishu card layer only needs `ApprovalService.resolve(sessionKey, choice)` shim. |
| `gateway/platforms/helpers.strip_markdown` | port to `markdown.ts` (plain-text fallback) | Implement from scratch (small). |
| lark-oapi lazy import pattern | dynamic `await import("@larksuiteoapi/node-sdk")` on first connect | Preserve the Python lazy-load behavior (test_feishu_lazy_import.py parity) so startup stays fast. |

**"No TS equivalent found" risks:** no kimi-code Feishu adapter, no in-repo card/post/markdown
helpers for Feishu, and `@larksuiteoapi/node-sdk` must be newly added (dependency decision needed);
`WSClient` may pull Node-only APIs (see §9).

## 6. Integration with existing Hermes-CN-Desktop frontend

Existing surface (Feishu is **already in CN onboarding scope** — verified by reading):
- `web/src/routes/im-onboarding.tsx` (1321 lines): `ImSection = "feishu" | "weixin" | "dingtalk"`;
  `sectionFromPath("/im")` → feishu; `FEISHU_REQUIRED_SCOPES`/`FEISHU_GROUP_SCOPE`/
  `FEISHU_RECOMMENDED_SCOPES`/`FEISHU_RECEIVE_EVENT`; `FeishuRoute` (line 749) drives QR onboarding
  via `useBeginImOnboarding/usePollImOnboarding/useApplyImOnboarding/useMessagingPlatform/
  useTestMessagingPlatform`, saves `FEISHU_DOMAIN`, `FEISHU_CONNECTION_MODE=websocket`,
  `FEISHU_ALLOW_ALL_USERS`, `FEISHU_ALLOWED_USERS` (with `__HERMES_SCANNED_FEISHU_OPEN_ID__` token),
  `FEISHU_GROUP_POLICY`, `FEISHU_REQUIRE_MENTION`, `FEISHU_HOME_CHANNEL`; backend checklist,
  MessagingTestGuide, DiagnosticAssistant.
- `web/src/lib/im-onboarding-diagnostics.ts` (450 lines): `buildImDiagnosticBundle` + Feishu-specific
  failure classifier (`explainMessagingFailure`: permission/scope, event subscription/长连接, bot not
  enabled) + `buildImDiagnosticPrompt` — reuse as-is.
- `src/commands/im_onboarding.rs` (2483 lines): Tauri commands `im_onboarding_state/begin/poll/apply`;
  Feishu device-code flow against `accounts.feishu.cn/oauth/v1/app/registration`
  (begin/poll/probe_bot), writes env patch to `~/.hermes/.env`, restarts the **managed Python gateway**
  (`spawn_managed_gateway_process`). Dingtalk begin/poll return not-available.
- Protocol: `packages/protocol/src/channels.ts` — `ImPlatform = "feishu" | "weixin"`,
  `ImOnboardingState/Begin/Poll/Apply*` types (note: Dingtalk is missing from the TS union — add if
  Dingtalk ever ships); `src/hermes-api.ts` — `MessagingPlatformInfo`, `MessagingPlatformTestResponse`
  (REST models of the managed runtime).
- Link layer: `web/src/lib/transport.ts` (HTTP routing + auth), `web/src/lib/gateway-client.ts` (WS
  JSON-RPC), `web/src/lib/tauri-bridge.ts` (Rust IPC shim).

Reuse strategy: onboarding UI + diagnostics stay; **freeze** the `ImOnboarding*`/`MessagingPlatform*`
protocol types and the `use-*` hooks as the stable interface so the in-process adapter can replace the
REST/WS calls behind them. Rust keeps env writing, gateway process management, and (optionally) the QR
registration flow (or it can later switch to the SDK's `registerApp`).

## 7. Removing the WebSocket dependency (migration path)

Two distinct "WebSockets" must not be confused:
1. **Dashboard WS link** (`/api/ws` JSON-RPC in `web/src/lib/gateway-client.ts`) — the webview ↔ managed
   Python runtime link this rewrite program removes.
2. **Feishu long connection** — outbound WS from the adapter to Feishu open platform (lark_oapi
   `FeishuWSClient`); this is a platform requirement, not removable.

Current state: the Feishu message plane runs inside the managed Python runtime; the webview learns
about it through the Dashboard WS (status `gateway_platforms.feishu`) and REST (`messaging/platforms`,
`test`). The onboarding page's MetaStrip (连接方式 长连接 / 网关 已运行 / 平台连接) is fed by these.

**Port decision + implications:**
- Near term (recommended): Feishu remains a managed-runtime messaging adapter (permitted "out of scope
  for desktop standalone"); the Dashboard WS link must therefore **stay for Feishu/Weixin messaging
  status** as long as those platforms ship in onboarding. Removing the WS link entirely requires one of:
  (a) dropping messaging platforms from standalone, (b) porting adapters in-process (this plan's §3
  design), or (c) keeping a minimal managed runtime purely for messaging.
- If/when the in-process port happens, migration is: keep the same `MessagingPlatformInfo`/onboarding
  protocol surface → run `FeishuAdapter` in-process behind an adapter registry → the webview talks to
  it through Tauri IPC instead of REST/WS → delete the Feishu REST/WS paths. Feishu's own outbound WS
  then runs wherever the TS adapter runs (see §9 for the Tauri webview constraint).

## 8. Migration phases & task breakdown

- **Phase 0 — decision record (this plan):** No code. Confirm Feishu message plane stays in managed
  Python runtime; document WS-removal implications in §7.
- **Phase 1 — TS groundwork (recommended now):** add `@larksuiteoapi/node-sdk` to the monorepo as a
  planned dependency; create `packages/feishu` skeleton with only `types.ts`/`config.ts`/`markdown.ts`
  pure helpers and vitest parity tests (table markdown, escape, plain-text fallback). No behavior
  change in the running product.
- **Phase 2 — in-process adapter (optional, gated by product decision):**
  1. `client.ts` + lazy SDK load + `connect()` via `WSClient` (websocket) — parity with
     `test_feishu_lazy_import.py`, `test_feishu_sdk_executor.py`.
  2. `normalize.ts` post/card/text + mentions — parity with `test_feishu.py` normalization classes.
  3. `admission.ts` (allowlist/group policy/@mention/bot identity) — parity with
     `test_feishu_bot_admission.py`, `test_feishu_bot_auth_bypass.py`, `TestGroupMentionAtAll`.
  4. `cards.ts` + `approval.ts` — parity with `test_feishu_approval_buttons.py`.
  5. `meetingInvite.ts` — parity with `test_feishu_meeting_invite.py`.
  6. `send.ts` media/upload + batching + dedup + reactions.
  7. Webhook mode (optional) + webhook security (signature/token/rate limit) — parity with
     `TestWebhookSecurity`.
- **Phase 3 — swap & delete:** wire `FeishuAdapter` into the Tauri IPC surface, freeze protocol types,
  flip onboarding hooks to IPC, delete Feishu REST/WS paths in `transport.ts`/`gateway-client.ts`.

Out of scope for the port (record, do not port now): `feishu_comment.py` + `feishu_comment_rules.py`
(doc-comment subsystem, 1.8k lines, separate 3-tier ACL), CLI `gateway setup` interactive wizard
(`interactive_setup`), Dingtalk (still placeholder in onboarding).

## 9. Risks & open questions

- **No TS equivalent in kimi-code**: Feishu must be the first platform adapter added to the TS
  monorepo; `@larksuiteoapi/node-sdk` is a new dependency (license/version pin decision needed).
- **Tauri webview vs Node SDK**: `@larksuiteoapi/node-sdk` `WSClient` is Node-oriented (uses `ws`,
  Node crypto/http). In a Tauri webview (no Node runtime) the adapter may need to run in a Rust-side
  or sidecar Node process; verify `WSClient` browser compatibility before committing to in-process.
- **Behavior parity**: lark-oapi ↔ node-sdk payload differences (post/md rendering, card callback
  shape, `receive_id_type` handling incl. `feishu_user_id:` prefix, tenant vs user token cache,
  error 200340 interactive-card config) must be parity-tested; the Python adapter has ~5.2k lines of
  tests encoding subtle behavior.
- **Secret handling**: `.env` management lives in Rust; TS adapter must not duplicate secret storage;
  webview cannot hold app secrets in localStorage.
- **Scope creep**: full port is very large (6013-line adapter + comment subsystem); recommend keeping
  doc comments and webhook mode out of the first port.
- **Gateway lock semantics**: Python uses `acquire_scoped_lock("feishu-app-id")` to prevent two
  gateways using one app_id; TS/Rust must replicate (Rust already has managed-gateway port checks).
- **Open questions**: (1) does the product intend standalone messaging at all? (2) should
  `ImPlatform` include `dingtalk` in `packages/protocol`? (3) who owns the `@larksuiteoapi/node-sdk`
  dependency review? (4) run in webview vs Rust sidecar?

## 10. Test strategy

Parity-first vitest suite mapping (fixtures ported from `tests/gateway/feishu_helpers.py`:
`make_sender/make_message/make_adapter_skeleton/install_dedup_state/stub_mention`):

| Python test | TS test |
|---|---|
| `test_feishu_table_markdown.py` (issue #52786: pipe table → `post` not `text`) | `packages/feishu/src/__tests__/markdown.test.ts` |
| `test_feishu_approval_buttons.py` (card payload, state, auth, inline card update, `/card button` routing) | `__tests__/approval.test.ts` (mock SDK + ApprovalService) |
| `test_feishu_meeting_invite.py` (parse, prompt, route, `feishu_user_id:` receive_id_type) | `__tests__/meeting-invite.test.ts` |
| `test_feishu_lazy_import.py`, `test_feishu_sdk_executor.py` | `__tests__/client.test.ts` (dynamic import + owned executor analog) |
| `test_feishu.py` normalization/admission/group policy/batching/dedup/webhook security classes | split into `normalize.test.ts`, `admission.test.ts`, `send.test.ts`, `webhook.test.ts`, `dedup.test.ts` |
| `test_feishu_onboard.py`, `test_setup_feishu.py` | onboarding flow tests against Rust commands (kept) |

- Unit: vitest with `@larksuiteoapi/node-sdk` fully mocked (client + WSClient + EventDispatcher).
- Integration: run adapter against a stub Feishu HTTP/WS server for connect/send/edit/card flows.
- E2E: Playwright on `web/src/routes/im-onboarding.tsx` FeishuRoute against a fake adapter — QR →
  poll → save → status → test-guide → diagnostics (existing diagnostics bundle format).
- Persistence tests: dedup JSON round-trip, approval state map semantics.

## 11. Reference links

- Python: `D:/hermes-agent-cn/plugins/platforms/feishu/{plugin.yaml,__init__.py,adapter.py,feishu_comment.py,feishu_comment_rules.py,feishu_meeting_invite.py}`
- Docs: `D:/hermes-agent-cn/website/docs/user-guide/messaging/feishu.md`
- Tests: `D:/hermes-agent-cn/tests/gateway/feishu_helpers.py`, `test_feishu.py`,
  `test_feishu_approval_buttons.py`, `test_feishu_meeting_invite.py`, `test_feishu_table_markdown.py`,
  `test_feishu_bot_admission.py`, `test_feishu_bot_auth_bypass.py`, `test_feishu_channel_prompts.py`,
  `test_feishu_comment.py`, `test_feishu_comment_rules.py`, `test_feishu_lazy_import.py`,
  `test_feishu_onboard.py`, `test_feishu_sdk_executor.py`, `test_feishu_setup_feishu.py`,
  `test_feishu_voice_message_type.py`
- Gateway: `D:/hermes-agent-cn/gateway/config.py` (Platform.FEISHU, env mapping),
  `gateway/platform_registry.py`, `tools/approval.py` (`resolve_gateway_approval` line 2659)
- TS SDK: `https://www.npmjs.com/package/@larksuiteoapi/node-sdk`,
  `https://github.com/larksuite/node-sdk` (WSClient ≥1.24.0, EventDispatcher, registerApp)
- kimi-code evidence (no Feishu equivalent): grep `feishu|lark|larksuiteoapi` under
  `D:/kimi-code` (only `packages/agent-core/test/tools/glob.test.ts` fixtures);
  `ws` in `packages/klient/package.json:53`, `packages/kap-server/package.json:40`;
  `marked` in `packages/pi-tui/package.json:61`
- Desktop: `D:/Hermes-CN-Desktop/web/src/routes/im-onboarding.tsx`,
  `web/src/lib/im-onboarding-diagnostics.ts`, `src/commands/im_onboarding.rs`,
  `web/src/lib/transport.ts`, `web/src/lib/gateway-client.ts`, `web/src/lib/tauri-bridge.ts`,
  `packages/protocol/src/channels.ts`, `packages/protocol/src/hermes-api.ts`
