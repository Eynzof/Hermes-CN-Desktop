# Microsoft Teams Messaging Platform Adapter — Python → TypeScript Rewrite Plan
> Feature: Teams bot via Bot Framework (`plugins/platforms/teams/`) + Teams meeting
> pipeline plugin (`plugins/teams_pipeline/`).
> Port decision recorded per `plans/README.md`: **messaging-platform adapters are
> gateway-side; the Teams bot webhook is marked OUT OF SCOPE for desktop standalone**
> (justification in §2/§3), while status/diagnostics/proactive-send surfaces are
> described for the Desktop UI.
## 1. Summary

Microsoft Teams integration in Hermes-CN-Core has two parts:

1. **Teams platform adapter** (`plugins/platforms/teams/`) — a Bot Framework bot.
   It runs an aiohttp webhook server on port 3978 (`POST /api/messages`), signs in
   with Azure AD client credentials, relays DM/group/channel messages into the
   gateway, strips `<at>Bot</at>` mentions, downloads attachments, sends
   messages/typing/media via the `microsoft-teams-apps` SDK, and renders Adaptive
   Card approval prompts (`Allow Once / Session / Always / Deny`).
2. **Teams meeting pipeline plugin** (`plugins/teams_pipeline/`) — a Graph-backed,
   transcript-first meeting-summary pipeline. It ingests Microsoft Graph change
   notifications (via the `msgraph_webhook` gateway adapter), resolves meeting
   references, fetches transcripts/recordings/call records, transcribes audio,
   summarizes via the agent LLM, and writes to Notion / Linear / Teams sinks. It
   ships a durable JSON store and an operator CLI (`hermes teams-pipeline ...`).

This plan records the port decision: **do not re-implement the inbound Teams bot
webhook in the desktop TypeScript runtime**. Teams delivers bot messages by calling
a public HTTPS endpoint, which requires an always-on, internet-reachable service —
not a desktop-local capability. The desktop should (a) surface Teams status
read-only through the existing gateway status plumbing while the Python gateway is
attached, (b) optionally implement a *proactive outbound* sender (Graph or incoming
webhook) for notifications, and (c) expose the `teams_pipeline` operator CLI
surface via the terminal tool. If a future headless/server TS runtime is desired,
§5 names the official Microsoft TS SDKs (`botbuilder`, `@microsoft/microsoft-graph-client`)
with rationale; kimi-code contains **no** Teams/botframework equivalent (verified).
## 2. Current Python implementation

Source of truth: `D:/hermes-agent-cn`.
### 2.1 Teams platform adapter — `plugins/platforms/teams/`

- `adapter.py` (1537 lines) — everything:
  - `TeamsAdapter(BasePlatformAdapter)` — constructor reads `client_id` /
    `client_secret` / `tenant_id` / `port` (default 3978) / `host` from
    `config.yaml` `platforms.teams.extra` or env (`TEAMS_CLIENT_ID` etc.);
    `connect()` lazy-installs the SDK, builds an aiohttp app (health at
    `/health`, webhook at `/api/messages`) via `_AiohttpBridgeAdapter`, registers
    `on_message` / `on_card_action`, starts `web.TCPSite`; `disconnect()`
    cleans up the runner.
  - Inbound `_on_message()`: self-message filter → `MessageDeduplicator`
    (max 1000) → cache `ConversationReference` per chat_id → strip `<at>` tags →
    classify `personal`/`groupChat`/`channel` → `build_source()` → attachment
    handling (SharePoint URLs, SSRF guard via `tools/url_safety.py`) →
    `handle_message(event)`.
  - Outbound: `send()` chunks at `MAX_MESSAGE_LENGTH = 28000`, `reply()` with
    flat-send fallback; `send_typing()`; media sends via
    `MessageActivityInput` + `Attachment` (base64 data URI for local files).
  - Approvals: `send_exec_approval()` builds an Adaptive Card
    (`AdaptiveCard().with_version("1.4").with_body(...).with_actions(ExecuteAction...)`);
    `_on_card_action()` validates `hermes_action`/`session_key`, **default-deny**
    user authorization (`TEAMS_ALLOWED_USERS`, `TEAMS_ALLOW_ALL_USERS`), then
    `resolve_gateway_approval(session_key, choice)`.
  - `TeamsSummaryWriter` — pipeline-facing outbound delivery surface used by
    `teams_pipeline`: `delivery_mode` = `incoming_webhook` (httpx POST of
    markdown) or `graph` (MicrosoftGraphClient POST to
    `/chats/{id}/messages` or `/teams/{id}/channels/{id}/messages`), with
    `_render_summary_markdown` / `_render_summary_html`.
  - `_standalone_send()` — out-of-process cron delivery hook: client-credentials
    token from `login.microsoftonline.com`, POST activity to
    `{service_url}v3/conversations/{chat_id}/activities`, with service-URL
    allowlist (`smba.trafficmanager.net`, `smba.infra.gov.teams.microsoft.us`)
    and conversation-ID regex guard.
  - Plugin entry `register(ctx)`: `register_platform(name="teams", ...)` with
    `check_fn` (passive), `ensure_deps_fn` (lazy-installer via
    `tools/lazy_deps.py`), `validate_config`, `is_connected`,
    `env_enablement_fn`, `cron_deliver_env_var="TEAMS_HOME_CHANNEL"`,
    `standalone_sender_fn`, `allowed_users_env`/`allow_all_env`, `emoji`,
    `platform_hint`.
- `plugin.yaml` — manifest: `requires_env` TEAMS_CLIENT_ID/SECRET/TENANT_ID,
  optional TEAMS_PORT/HOST/ALLOWED_USERS/ALLOW_ALL_USERS/HOME_CHANNEL(_NAME).
- `__init__.py` — exposes `register`.
### 2.2 Teams meeting pipeline — `plugins/teams_pipeline/`

- `pipeline.py` — `TeamsPipelineConfig`, `NotionWriter`, `LinearWriter`,
  `TeamsMeetingPipeline` (states `received → resolving_meeting →
  fetching_transcript → downloading_recording → transcribing_audio →
  summarizing → writing_notion → writing_linear → sending_teams`, terminal
  `completed/failed/retry_scheduled`); dependency-injected `graph_client`,
  `store`, `transcribe_fn` (`tools/transcription_tools.transcribe_audio`),
  `summarize_fn` (`agent/auxiliary_client.async_call_llm`), sink writers.
- `meetings.py` — Graph helpers: `resolve_meeting_reference`,
  `list_transcript_artifacts`, `select_preferred_transcript`,
  `fetch_preferred_transcript_text`, `list_recording_artifacts`,
  `download_recording_artifact`, `fetch_call_record_artifact`,
  `enrich_meeting_with_call_record`.
- `models.py` — dataclasses (snake_case ↔ camelCase-tolerant `from_dict`):
  `GraphSubscription`, `TeamsMeetingRef`, `MeetingArtifact`,
  `TeamsMeetingSummaryPayload`, `TeamsMeetingPipelineJob`.
- `store.py` — `TeamsPipelineStore`, thread-safe JSON file
  (`~/.hermes/teams_pipeline_store.json`; env override `MSGRAPH_WEBHOOK_STORE_PATH`)
  with sections `subscriptions`, `notification_receipts`, `event_timestamps`,
  `jobs`, `sink_records`; atomic temp-file persist.
- `subscriptions.py` — Graph subscription lifecycle: `build_graph_client`,
  `maintain_graph_subscriptions` (list remote `/subscriptions`, sync to store,
  renew near-expiry via PATCH, `client_state` ownership check), `is_managed_subscription`.
- `runtime.py` — `build_pipeline_runtime_config` (merges `teams.extra` +
  `meeting_pipeline` config, computes `teams_delivery.enabled`),
  `build_pipeline_runtime` (wires `TeamsSummaryWriter` as `teams_sender`),
  `bind_gateway_runtime` (sets notification scheduler on the
  `msgraph_webhook` adapter; drop-scheduler fallback).
- `cli.py` — `hermes teams-pipeline {list|show|run|fetch|subscriptions|subscribe|
  renew-subscription|delete-subscription|maintain-subscriptions|token-health|validate}`.
- `__init__.py` — registers CLI only (no model tools).
- `plugin.yaml` — standalone plugin, linux/macos/windows.
### 2.3 Supporting gateway/platforms

- `gateway/platforms/msgraph_webhook.py` — Graph change-notification ingress
  (aiohttp webhook, port 8646, `/msgraph/webhook`); the pipeline binds its
  scheduler to this adapter (`bind_gateway_runtime`).
- `gateway/platforms/base.py` — `BasePlatformAdapter`, `MessageEvent`,
  `SendResult`, media cache helpers; `tools/microsoft_graph_auth.py`,
  `tools/microsoft_graph_client.py` — Graph app-only auth + REST client.
### 2.4 Docs & tests

- Docs: `website/docs/user-guide/messaging/teams.md` (bot setup, tunnel,
  env vars, approval cards, summary delivery config),
  `website/docs/user-guide/messaging/teams-meetings.md`,
  `website/docs/user-guide/features/built-in-plugins.md` (row: `teams_pipeline`).
- Tests: `tests/gateway/test_teams.py` (mocks the `microsoft_teams.*` module
  hierarchy in `sys.modules`; covers registration, connect/credential failures,
  webhook handler, dedup, `<at>` strip, attachments, card action authorization,
  summary writer), `tests/plugins/test_teams_pipeline_plugin.py` (register
  CLI-only, `build_pipeline_runtime_config` reuses teams platform settings,
  `build_pipeline_runtime` reuses `TeamsSummaryWriter`, `bind_gateway_runtime`
  attaches scheduler, store round-trips).
## 3. Target TypeScript design
### 3.1 Port decision (recorded)

**Inbound Teams bot webhook: OUT OF SCOPE for desktop standalone.**

- Teams Bot Framework is push-based: Microsoft calls your public HTTPS
  `/api/messages` endpoint. It requires an always-on, internet-reachable,
  TLS-terminated service (devtunnel/ngrok/proxy) plus Azure bot registration —
  the opposite of a desktop-local, in-process agent. The end-state desktop
  runtime (React + Tauri + Rust IPC) has no need to receive inbound Teams
  messages while a user is at the machine; users interact with the agent via the
  desktop UI/CLI.
- The Python `teams` platform stays the supported way to run a Teams bot
  (headless gateway / server). The desktop may talk to an attached gateway
  today and, in the future, to a remote gateway over the same REST surface —
  never over the WS link for Teams (see §7).

**In-scope desktop surfaces (design-only):**

1. Read-only Teams status in Settings (via existing `gateway_platforms` /
   `/api/messaging/platforms` when a gateway is attached).
2. A Teams "onboarding" page mirroring the feishu/weixin IM onboarding pattern,
   but manual-credential + checklist based (no QR flow): write `TEAMS_*` env
   vars, show tunnel/port/endpoint checklist, run the existing test endpoint.
3. Optional proactive outbound sender (Graph or incoming webhook) so desktop
   notifications reach a Teams chat/channel without running the inbound bot.
4. Optional `teams-pipeline` operator surface via the terminal tool (reuse CLI
   commands against an attached gateway), or a settings panel backed by the
   pipeline JSON store.
### 3.2 If a future in-process/server TS port is required

Module layout under `web/src/` (or a new `packages/teams/`):

```
web/src/platforms/teams/
  adapter.ts        // TeamsBotAdapter: same interface as gateway PlatformAdapter
  webhook.ts        // HTTP route handler for POST /api/messages (botbuilder)
  auth.ts           // client_credentials token provider (OAuth2)
  cards.ts          // Adaptive Card builders (approval prompt, summary card)
  attachments.ts    // inbound attachment download + SSRF guard
  sender.ts         // proactive send via conversation reference / Graph
  summary-writer.ts // TeamsSummaryWriter port (webhook + graph modes)
web/src/pipeline/teams/
  pipeline.ts       // state machine port
  meetings.ts       // Graph artifact resolution
  store.ts          // durable store port (minidb/SQLite)
  subscriptions.ts  // Graph subscription lifecycle
  cli.ts            // operator command surface
```

Key interfaces (pseudocode):

```ts
interface PlatformAdapter {
  connect(): Promise<boolean>;
  disconnect(): Promise<void>;
  send(chatId: string, content: string, replyTo?: string, metadata?: unknown): Promise<SendResult>;
  sendExecApproval(chatId: string, command: string, sessionKey: string, ...): Promise<SendResult>;
  onMessage(cb: (event: MessageEvent) => Promise<void>): void;
}

interface TeamsBotConfig {
  clientId: string; clientSecret: string; tenantId: string;
  port: number; host?: string; allowedUsers: string[]; allowAllUsers: boolean;
}

class TeamsSummaryWriter {
  constructor(config: TeamsDeliveryConfig, graphClient?: GraphClient);
  writeSummary(payload: TeamsMeetingSummaryPayload, config: Record<string, unknown>): Promise<Record<string, unknown>>;
}
```

The TS adapter runs an HTTP server inside the agent runtime (Node/undici or a
Rust `src/commands/*` Tauri child process); no Python backend is involved. The
same `PlatformAdapter` interface lets the app swap Teams on/off without touching
the agent loop.
## 4. Data models & persistence

- **Zod schemas** in `packages/protocol/src/` (mirroring
  `plugins/teams_pipeline/models.py` snake_case/camelCase duality):
  `GraphSubscription`, `TeamsMeetingRef`, `MeetingArtifact`,
  `TeamsMeetingSummaryPayload`, `TeamsMeetingPipelineJob`. These become the
  wire contract for any future remote-gateway/desktop-panel integration and the
  parity surface for tests.
- **In-memory conversation references** (adapter): `Map<chatId, ConversationReference>`,
  only for proactive sends; not persisted in Python either.
- **Durable pipeline store**: Python JSON file → **kimi-code `packages/minidb`**
  (embedded DB) or SQLite via a Rust Tauri command (README end-state: Rust owns
  SQLite). Sections preserved: `subscriptions`, `notification_receipts`,
  `event_timestamps`, `jobs`, `sink_records`; schema version field added for
  migrations (`_PROMPT_TEMPLATE`/README require a migration strategy).
- **Secrets**: `TEAMS_CLIENT_ID/SECRET/TENANT_ID`, `MSGRAPH_*` stay in
  `.env`/OS keychain, read through the existing profile secret-scope pattern;
  Desktop protocol already redacts values (`ImRedactedValue` in
  `packages/protocol/src/channels.ts`).
## 5. Third-party library strategy

| Python dependency (Core) | TS equivalent | kimi-code evidence |
|---|---|---|
| `microsoft-teams-apps` (Bot Framework SDK) | **`botbuilder`** (official Microsoft Bot Framework SDK for Node) — covers JWT auth (`MicrosoftAppCredentials`), activities, conversation references, proactive send. Adaptive Cards built as plain JSON (or `adaptivecards` npm for client rendering, not needed server-side) | **None found.** `grep` of `D:/kimi-code` package.json/pnpm-lock/node_modules for `teams`, `botframework`, `botbuilder`, `teams-js`, `adaptivecards`, `microsoft/teams` matched only `@microsoft/api-extractor` (build tool, root package.json line 39). Root `node_modules/@microsoft/` contains only `api-extractor`. Implement from scratch is NOT recommended for the protocol layer — `botbuilder` is the only sane route (JWT validation + activity schema are subtle). |
| `@microsoft/teams-js` (client tab SDK) | **Not needed** — it is for Teams tab/task-module clients, not bots. Recommend explicitly *not* adding it. | Absent from kimi-code (verified). |
| `aiohttp` (webhook server) | Node `http`/Fastify route inside the runtime, or Rust hyper/axum Tauri child process | kimi-code `packages/kap-server` provides server/transport patterns to reuse (README §Reference projects); no Teams-specific server. |
| `httpx` (REST client) | global `fetch` / undici; kimi-code `apps/kimi-code/src/utils/*` HTTP helpers | kimi-code uses fetch/undici-style clients. |
| `orjson`, `pybase64` | native `JSON`, `Buffer.toString('base64')` | stdlib, no dep needed. |
| `tools/microsoft_graph_auth.py`, `microsoft_graph_client.py` | **`@microsoft/microsoft-graph-client`** + small OAuth2 `client_credentials` provider (token endpoint `login.microsoftonline.com/{tenant}/oauth2/v2.0/token`) | kimi-code `packages/oauth` covers PKCE/device code; **no client_credentials/Graph client found** — implement a thin shim modeled on the Python `MicrosoftGraphClient` interface (`get_json/post_json/patch_json/collect_paginated`). |
| `tools/transcription_tools.transcribe_audio` (STT + ffmpeg) | call external STT API or reuse kimi-code audio tooling; ffmpeg via Rust child process (`src/commands/*`, README: Rust owns child processes) | kimi-code `apps/kimi-code/src/native` has node-pty; **no STT/Teams transcription evidence found** — implement from scratch / call external API. |
| `agent/auxiliary_client.async_call_llm` | kimi-code `packages/agent-core` LLM client (README §Reference) | Present (agent-core). |
| Notion / Linear REST sinks | thin `fetch` shims (same REST shapes) | **No notion/linear clients found** — trivial to implement from scratch with `fetch`. |

**Recommendation & rationale:** For any TS port, use `botbuilder` (official,
battle-tested Bot Framework protocol + token handling) rather than a hand-rolled
shim, and `@microsoft/microsoft-graph-client` for Graph REST. `@microsoft/teams-js`
is out of scope (client-side only). Because kimi-code has **zero** in-repo
evidence for any of these, the desktop must treat them as new external deps and
verify API details (conversation-reference persistence, adaptive card schema
1.4, JWT validation) during implementation — see §9 risks.
## 6. Integration with existing Hermes-CN-Desktop frontend

- `web/src/routes/settings.tsx` — `DebugCard "Dashboard / Gateway"` already
  renders `status.gateway_platforms` (name/state/error_message, lines ~1478–1488);
  Teams appears automatically once the attached Python gateway reports it. No
  change needed for read-only status; optionally add a Teams-specific
  `DebugCard` with `MessagingPlatformInfo` env-var details (reuse
  `packages/protocol/src/hermes-api.ts` `MessagingPlatformInfo`,
  `MessagingEnvVarInfo`).
- `web/src/routes/im-onboarding.tsx` + `web/src/lib/im-onboarding-diagnostics.ts`
  — currently hardcoded to feishu/weixin (`ImPlatform = "feishu" | "weixin"` in
  `packages/protocol/src/channels.ts`, `ImSection` includes "dingtalk" but no
  route). A Teams page would extend `ImPlatform` with `"teams"` (or add a
  parallel `teams` section), reuse hooks `useMessagingPlatform`,
  `useTestMessagingPlatform`, `useApplyImOnboarding`, `useImOnboardingState`, and
  the diagnostic bundle builder — with new `DIAGNOSTIC_REQUIRED_KEYS`
  (`TEAMS_CLIENT_ID/SECRET/TENANT_ID`) and Teams-specific failure classifiers
  (tunnel unreachable, invalid client secret, bot not installed).
- `packages/protocol/src/` — extend `channels.ts`/`hermes-api.ts` with Teams env
  keys and (optionally) pipeline job schemas (§4).
- Rust `src/commands/*` — no new commands required for read-only status; a
  future in-process webhook server or SQLite store would add commands (README:
  Rust owns child processes/SQLite).
- Reuse: `web/src/lib/transport.ts` (HTTP), `web/src/hooks/use-status.ts`,
  `web/src/lib/external-links.ts` (open Azure portal / tunnel docs),
  `web/src/components/ui/*` and `packages/shared-ui`.
## 7. Removing the WebSocket dependency (migration path)

- **Teams never traverses the WS link**: inbound Bot Framework calls hit the
  gateway's own webhook port; status is read via REST (`/api/status`,
  `/api/messaging/platforms`). The WS JSON-RPC (`web/src/lib/gateway-client.ts`)
  is only for session/turn streaming, never Teams delivery — Teams is
  WS-independent today and stays that way.
- **API surface to freeze during migration** (so the desktop UI is decoupled
  from the Python runtime): `GET /api/status` → `gateway_platforms[teams]`
  (state/error), `GET /api/messaging/platforms` →
  `MessagingPlatformInfo` (env_vars/state/home_channel), `POST
  /api/messaging/platforms/:id/test` → `MessagingPlatformTestResponse`, and
  `TEAMS_*` env-var semantics. The Desktop should consume only these.
- **Phased path**:
  1. Keep attached Python gateway; add/read Teams status + diagnostics UI.
  2. Freeze the REST surface above; move Desktop off any ad-hoc parsing.
  3. Optional proactive sender (Graph/webhook) behind a `TeamsOutboundSender`
     interface in TS — no Python in the send path.
  4. If a headless TS runtime ever ships, host `botbuilder` webhook in-process;
     delete the WS/REST path only for the agent loop, never for webhook ingress.
- Because the inbound bot is out of scope, there is **no WS dependency to
  remove for Teams**; the migration is about documenting the REST contract so the
  Python gateway can be swapped for a remote/headless gateway later.
## 8. Migration phases & task breakdown

1. **Phase 0 — decision & contract freeze (this plan).** Record "inbound bot out
   of scope"; freeze `MessagingPlatformInfo`/`gateway_platforms` contracts.
2. **Phase 1 — status surface.** Teams read-only card in `settings.tsx`;
   extend `packages/protocol` `ImPlatform`/env-var tables with `teams`; unit-test
   Zod parsing against a captured `MessagingPlatformInfo` fixture.
3. **Phase 2 — onboarding page.** New `/im/teams` route mirroring
   `im-onboarding.tsx` manual flow; extend `im-onboarding-diagnostics.ts` with
   Teams key/classifier logic; Playwright E2E for save→restart→test happy path.
4. **Phase 3 — proactive outbound (optional).** `TeamsSummaryWriter` port behind
   a TS interface: incoming_webhook mode (fetch POST) first, graph mode via
   `@microsoft/microsoft-graph-client` + `client_credentials` provider.
5. **Phase 4 — pipeline operator surface (optional).** `teams-pipeline` CLI
   commands exposed via terminal tool; durable store ported to minidb/SQLite;
   pipeline state machine ported if a headless runtime is committed.
6. **Phase 5 — (future) in-process bot.** botbuilder webhook host + approval
   card handlers; remove attached-gateway requirement for Teams.
## 9. Risks & open questions

- **No TS equivalent found in kimi-code** (verified: only `@microsoft/api-extractor`
  build dep; `pnpm-lock.yaml` has no `botbuilder`/`teams-js`/`adaptivecards`;
  `node_modules/@microsoft/` has only `api-extractor`). Every Microsoft-specific
  TS dependency is unproven in this repo — `botbuilder` API drift, ESM/CJS
  packaging, Node version requirements must be validated early.
- **Bot Framework protocol complexity** — JWT validation against
  Microsoft OpenID metadata, activity schema, conversation-reference reuse for
  proactive cards. Hand-rolling is risky; only `botbuilder` is acceptable.
- **Adaptive Cards 1.4** — Python SDK builds cards fluently; TS must produce the
  same JSON schema (approval buttons with `ExecuteAction` verbs
  `hermes_approve`, `Action.Execute` invoke flow) for parity with
  `test_teams.py` card-action coverage.
- **Default-deny authorization** — `TEAMS_ALLOWED_USERS` / `TEAMS_ALLOW_ALL_USERS`
  logic must be preserved exactly; a regression here is a security hole.
- **Public endpoint requirement** — Teams cannot be exercised locally without a
  tunnel; E2E/parity tests must mock `botbuilder` (mirroring
  `test_teams.py`'s `sys.modules` SDK mock strategy).
- **Graph subscription lifecycle** (`maintain_graph_subscriptions`) — token
  expiry, `client_state` ownership, pagination; port only if Phase 4 is funded.
- **Open questions:** Should the desktop ship a proactive sender at all, or rely
  on the attached gateway? Should `teams_pipeline` operator commands run against
  the attached gateway (terminal tool) rather than being re-implemented? Do we
  extend `ImPlatform` or introduce a separate "connectivity" section for
  non-QR platforms (teams/slack/discord)? Is `@microsoft/microsoft-graph-client`
  acceptable as a new dependency, or should we hand-roll the ~5 Graph calls used?
## 10. Test strategy

- **Parity tests (vitest) against Python behavior** from `tests/gateway/test_teams.py`:
  - Registration/connect: missing SDK/credentials → typed errors.
  - Webhook handler: `MessageActivity` → `MessageEvent` mapping, dedup by
    activity id, `<at>` stripping, personal/group/channel classification.
  - Attachments: skip `text/html`/card attachments, SharePoint download with
    SSRF guard, media cache naming.
  - Card actions: `session_key`/`hermes_action` validation, default-deny
    authorization matrix (no allowlist / allowlist hit / miss / allow-all),
    `resolve_gateway_approval` resolution mapping.
  - Summary writer: markdown vs html rendering, incoming_webhook vs graph
    delivery, force_resend semantics.
- **Pipeline parity tests** from `tests/plugins/test_teams_pipeline_plugin.py`:
  store round-trips (atomic persist, dedupe receipts), runtime config merge,
  scheduler binding, subscription maintain logic (dry-run/renew/skip).
- **Unit:** Zod model parsing (snake/camel), store with minidb/SQLite, auth
  provider (mock token endpoint).
- **Integration:** fake `botbuilder` app server + fake Graph
  (`@microsoft/microsoft-graph-client` mocked) exercising the full summary →
  sink path.
- **Playwright E2E:** `/im/teams` save→restart→test flow; Settings card shows
  `teams` state from a stubbed `gateway_platforms` payload.
- **Lint/build:** `tsc` strict, vitest run in CI.
## 11. Reference links

- Python: `D:/hermes-agent-cn/plugins/platforms/teams/adapter.py`,
  `plugin.yaml`, `__init__.py`; `plugins/teams_pipeline/{pipeline,meetings,models,store,subscriptions,runtime,cli,__init__}.py`, `plugin.yaml`;
  `gateway/platforms/msgraph_webhook.py`, `gateway/platforms/base.py`,
  `tools/microsoft_graph_auth.py`, `tools/microsoft_graph_client.py`,
  `tools/url_safety.py`, `tools/lazy_deps.py`.
- Docs: `D:/hermes-agent-cn/website/docs/user-guide/messaging/teams.md`,
  `.../messaging/teams-meetings.md`,
  `.../features/built-in-plugins.md` (teams_pipeline row), `features_report.md`
  line 132.
- Tests: `D:/hermes-agent-cn/tests/gateway/test_teams.py`,
  `tests/plugins/test_teams_pipeline_plugin.py`.
- Desktop: `D:/Hermes-CN-Desktop/web/src/routes/settings.tsx`,
  `web/src/routes/im-onboarding.tsx`, `web/src/lib/im-onboarding-diagnostics.ts`,
  `web/src/hooks/use-im-onboarding.ts`, `packages/protocol/src/channels.ts`,
  `packages/protocol/src/hermes-api.ts`.
- TS reference (no Teams evidence): `D:/kimi-code/package.json` (line 39:
  `@microsoft/api-extractor` only), `pnpm-lock.yaml`, `node_modules/@microsoft/`
  (api-extractor only).
- External TS SDKs (recommended, not in kimi-code): `botbuilder`
  (https://github.com/microsoft/botbuilder-js), `@microsoft/microsoft-graph-client`,
  `@microsoft/teams-js` (explicitly NOT needed for a bot).
