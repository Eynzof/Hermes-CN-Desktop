# Gateway Core — Python → TypeScript Rewrite Plan

## 1. Summary

The Python **gateway** (`D:/hermes-agent-cn/gateway/`) is one long-lived process
that serves all messaging platforms: per-chat sessions, cron delivery, voice
messages, slash commands with admin/user split, multiplexing (profiles +
credentials), auto-reset / session eviction, media resend dedup, approval prompts,
PII redaction, busy-session auth, shutdown drains, and restart flows
(`features_report.md` §5; `website/docs/user-guide/messaging/index.md`).

Today the Hermes-CN-Desktop web app is a **WS client** of that gateway
(`web/src/lib/gateway-client.ts`, JSON-RPC over `/api/ws`). This plan moves the
**gateway core** in-process into the TS monorepo as a service layer — an event bus,
a session multiplexer, a slash-command dispatcher, a cron scheduler, a delivery
ledger, and a local platform adapter — so the webview hosts the orchestration and
the WS link can be deleted. The desktop chat UI becomes the "local platform"
adapter; the agent loop itself is a separate in-process runtime (per
`plans/README.md` end-state) and is out of scope here. External messaging platform
adapters (Telegram/Discord/Slack/…) are marked **out of scope for desktop
standalone** per `plans/README.md` conventions; the core interfaces are kept
platform-neutral so they can be re-attached later.

## 2. Current Python implementation

Source of truth: `D:/hermes-agent-cn/gateway/`.

| File | Role (verified by reading) |
|---|---|
| `gateway/run.py` | `GatewayRunner` (god-file): adapter registry, `_session_key_for_source`, busy-input modes (queue/interrupt/steer), agent-cache LRU + idle-TTL eviction (`_AGENT_CACHE_MAX_SIZE=128`, `_AGENT_CACHE_IDLE_TTL_SECS=3600`), `_redact_gateway_user_facing_secrets` (delegates to `agent.redact.redact_sensitive_text`), delivery ledger hooks, restart/drain, auto-resume scheduling |
| `gateway/session.py` | `SessionSource` (platform/chat_id/chat_type/user_id/thread_id/scope_id/profile/…), `SessionContext`, `AsyncSessionStore`, `build_session_key` (e.g. `agent:main:telegram:dm:99`), PII hash helpers `_hash_id`/`_hash_sender_id`/`_hash_chat_id` (12-hex xxhash), path-safety guards, `auto_continue_freshness_window()` |
| `gateway/slash_commands.py` | `GatewaySlashCommandsMixin` — 42 in-session handlers (~3,200 LOC): `/new /reset /model /status /whoami /stop /approve /deny /sethome /compress /title /resume /sessions /usage /voice /rollback /background /update /help` etc. |
| `gateway/slash_access.py` | admin/user tier registry per platform+scope (`allow_admin_from`, `user_allowed_commands`, group variants) |
| `gateway/hooks.py` | `HookRegistry` — discovers `~/.hermes/hooks/*/HOOK.yaml` + `handler.py`; events `gateway:startup`, `session:start/end/reset`, `agent:start/step/end`, `command:*`; errors never block pipeline |
| `gateway/stream_consumer.py` | `GatewayStreamConsumer` — thread-safe delta queue → async edit/draft streaming (`StreamConsumerConfig`: `edit_interval`, `buffer_threshold`, `transport: auto|draft|edit|off`, `fresh_final_after_seconds`), code-fence repair |
| `gateway/platforms/base.py` | `BasePlatformAdapter` ABC (`connect/disconnect/send/send_document/send_image_file/send_multiple_images/send_typing`), `MessageEvent`, `EphemeralReply`, `MessageType`, media/audio extension routing, auto-TTS output path |
| `gateway/delivery.py`, `gateway/delivery_ledger.py` | durable at-least-once delivery: 3 attempts / 24 h freshness, "♻️ Recovered reply" prefix, prune 7 days |
| `gateway/drain_control.py`, `gateway/restart.py`, `gateway/shutdown_flush.py` | external drain marker (`.drain_request.json` + epoch), exit codes 75/78, `restart_drain_timeout` / `restart_after_turn_timeout`, transcript flush-to-file spool |
| `gateway/turn_lease.py`, `gateway/session_stall.py`, `gateway/agent_cache_pressure.py` | turn ownership, stall watchdog, memory-pressure cache sweep |
| `gateway/config.py`, `gateway/platform_registry.py`, `gateway/profile_routing.py` | config, platform registry, multi-profile routing |

Data flow: adapter event → `SessionSource` → `build_session_key` → per-chat
`AsyncSessionStore` → authz gate (`_is_user_authorized`) → busy-input decision →
`AIAgent` turn (stream deltas via `GatewayStreamConsumer`) → delivery ledger →
`adapter.send`. Cron: `gateway/` scheduler ticks 60 s and delivers through the
same per-chat session path.

Docs: `D:/hermes-agent-cn/website/docs/user-guide/messaging/index.md`
(architecture, reset policies, admin/user split, delivery reliability, busy-input
modes, restart resume, `/platform` circuit breaker).

Tests (parity source): `D:/hermes-agent-cn/tests/gateway/` (596 files):
`test_multiplex_phase0.py` (session-key byte-identical guard),
`test_busy_session_auth_bypass.py` (#17775 unauthorized busy-path injection),
`test_pii_redaction.py`, `test_approval_prompt_redaction.py`,
`test_73771_media_resend_dedup.py` (#73771 explicit `MEDIA:` never filtered),
`test_shutdown_flush.py`, `test_restart_drain.py`, `test_restart_resume_pending.py`,
`test_cron_shutdown_drain.py`, `test_slash_access.py`, `test_gateway_shutdown.py`,
`test_session_store_stale_prune.py`.

## 3. Target TypeScript design

New module tree (suggested `packages/gateway-core/` so both web and future Tauri
hosts can import; web-facing glue stays in `web/src/lib/`):

```
packages/gateway-core/src/
  event-bus.ts            # IEventBus: Emitter-based pub/sub (VSCode-style)
  gateway-service.ts      # GatewayService: lifecycle, adapter registry, drain/restart FSM
  session/
    session-source.ts     # SessionSource type (Zod) + buildSessionKey()
    session-multiplexer.ts# per-chat sessions, busy-input mode, auto-reset/eviction, auth gate
    session-store.ts      # persistence (see §4)
  slash-commands/
    registry.ts           # command registry: name, aliases, adminTier, handler(ctx)
    dispatcher.ts         # parse "/cmd args", tier check, dispatch, slash-confirm
    access.ts             # admin/user split per platform+scope
  cron/
    scheduler.ts          # 60 s tick, due-jobs, missed-fire coalescing, drain-aware
    session-cron-store.ts # per-session cron persistence + rehydrate on resume
  delivery/
    delivery-ledger.ts    # at-least-once rows, redelivery, media-resend dedup
  hooks/
    hook-registry.ts      # JSON/TS manifest discovery + emit; never blocks pipeline
  stream/
    stream-consumer.ts    # delta queue, buffer/rate-limit, edit/draft transport
  platforms/
    adapter.ts            # PlatformAdapter interface + LocalChatAdapter (desktop UI)
  pii.ts                  # hashId/hashChatId/hashSenderId + redactSensitiveText
  approval.ts             # ApprovalBroker: request()/resolve()/listPending()
```

Key interfaces (signatures only):

```ts
interface IEventBus { publish(ev: GatewayEvent): void;
                      onDidPublish: (cb: (ev: GatewayEvent) => void) => () => void; }

interface PlatformAdapter {
  readonly platform: string;
  connect(): Promise<void>; disconnect(): Promise<void>;
  send(chatId: string, content: OutboundContent, meta?: SendMeta): Promise<SendResult>;
  sendDocument(...): Promise<SendResult>; sendImageFile(...): Promise<SendResult>;
  sendTyping(chatId: string): Promise<void>; editMessage(...): Promise<void>;
  typedCommandPrefix(): string; // "/" default, "!" for slack/matrix parity
}

interface SessionMultiplexer {
  route(event: InboundMessageEvent): Promise<RouteDecision>;
  // decision = { sessionId, action: "run"|"queue"|"steer"|"interrupt"|"drop_auth"|"slash" }
  resetIfDue(sessionId: string): Promise<void>;   // idle/daily reset policy
  evictIdleSessions(now: number): Promise<void>;  // LRU + TTL eviction
}

interface SlashDispatcher {
  register(cmd: SlashCommand): void;
  dispatch(ctx: SlashContext): Promise<DispatchResult>; // tier-checked
  whoami(ctx: SlashContext): TierInfo;                  // admin | user | unrestricted
}

interface ApprovalBroker {
  request(req: ApprovalRequest & { sessionId: string }): Promise<ApprovalResponse>;
  resolve(id: string, resp: ApprovalResponse): void;
  listPending(sessionId: string): readonly PendingApproval[];
}

interface DeliveryLedger {
  begin(sessionId: string, payload: OutboundPayload): Promise<LedgerRow>;
  ack(rowId: string): Promise<void>;
  redeliverOnBoot(): Promise<number>;  // ♻️ prefix for mid-send rows, 3 attempts / 24 h
  dedupeMedia(sessionId: string, path: string, explicit: boolean): Promise<boolean>;
}

interface GatewayService {
  start(): Promise<void>;  // connect adapters, start cron tick, replay ledger, resume interrupted sessions
  stop(opts: { drainTimeoutMs: number }): Promise<void>;
  shutdownFlush(): Promise<void>; // spool pending transcript rows
  restart(opts: { afterTurnTimeoutMs: number }): Promise<void>; // in-process FSM, exit-75 parity not needed
}
```

In-process data flow: `LocalChatAdapter` (chat submit in React) → `SessionMultiplexer.route`
(auth gate + busy mode + reset check) → `SlashDispatcher` OR agent turn → stream events
published on `IEventBus` → `stream-consumer` → adapter send (UI update) → `DeliveryLedger`.

## 4. Data models & persistence

- `GatewaySession`: `{ sessionId, sessionKey, platform, chatId, chatType, userId,
  threadId?, scopeId?, profile?, title?, modelOverride?, resetPolicy, createdAt,
  lastActiveAt, restartInterrupted? }` — `sessionKey` built by
  `buildSessionKey(source, profile?)`; must be **byte-identical** to Python's
  `agent:main:<platform>:<chatType>:<chatId>[:<userId>]` layout while the two
  runtimes coexist (parity guard from `test_multiplex_phase0.py`).
- `GatewayMessage`: `{ id, sessionId, role, parts: TextPart|ImagePart|VoicePart[],
  createdAt, status, deliveryState }`; voice = `VoicePart { path, mime, durationMs,
  transcript? }`.
- `DeliveryRow`: `{ rowId, sessionId, payload, state: pending|sending|delivered,
  attempts, createdAt, dedupeKey? }`; media dedup: bare local paths filtered with
  **logged suppression**; explicit `MEDIA:<path>` / image tags never filtered
  (#73771 parity).
- Persistence strategy: Python uses `sessions_dir/*.json` + SQLite `state.db`.
  Desktop options, in order of fit: (a) **Rust-side SQLite** via one new Tauri
  command (README allows Rust for SQLite) with a thin `SessionStore` wrapper;
  (b) IndexedDB inside the webview for transcript, JSON files for session meta.
  Prefer (a) for `DeliveryLedger` durability (crash-safe acks) and reuse the
  existing Rust `AppState` (`src/state.rs`). Schema versioning via a
  `schema_version` table; migration runner in Rust, invoked by `GatewayService.start()`.
- Cron persistence: port kimi-code's per-session cron file pattern
  (`<sessionDir>/cron/<id>.json`, `SessionCronStore.loadFromDisk`) instead of a
  global table.

## 5. Third-party library strategy

| Python dependency | TS equivalent | Evidence / notes |
|---|---|---|
| `asyncio` (event loop, tasks, queues) | native `async/await`, per-session FIFO arrays, `EventEmitter`-style bus | kimi-code `packages/agent-core/src/services/event/eventService.ts` — thin `Emitter<Event>` wrapper, `publish()` fire-and-forget; `base/common/event.ts` |
| `xxhash` (PII deterministic hashing) | **implement from scratch**: `hashId(v): string` (12-hex FNV-1a/xxhash64 port) | no kimi-code equivalent found; keep `user_<12hex>` / `platform:<hash>` shape from `gateway/session.py` for byte-parity |
| `orjson` / `json` | `JSON.stringify` + Zod | kimi-code `packages/protocol` Zod schemas; desktop `packages/protocol/src/hermes-api.ts` already Zod |
| `yaml` (hooks `HOOK.yaml`, gateway-config) | `js-yaml` **or drop YAML — use JSON/Zod** for in-process hooks | js-yaml not verified in kimi-code; desktop config is JSON/Zod, so prefer JSON manifests (`hooks/*/hook.json`) |
| `sqlite3` / `aiosqlite` (`state.db`) | Rust `rusqlite` behind Tauri command, or `better-sqlite3` | kimi-code uses file-based `SessionStore` (`src/session/store/session-store.ts`, zod-validated state) + `packages/minidb`; no Node sqlite lib verified — mark risk below |
| `croniter` / cron scheduler | port kimi-code `tools/cron/scheduler.ts` + `clock.ts` + `SessionCronStore` | evidence: `packages/agent-core/src/agent/cron/manager.ts` (gate fires via `steer(...)` + `CronJobOrigin`, missed-fire coalescing, wall-clock via injectable clocks) |
| event bus / per-session ordering | `IEventService` + `Emitter`, per-session seq/epoch journal | evidence: `services/event/eventService.ts`; `packages/kap-server/src/transport/ws/v1/sessionEventBroadcaster.ts` (seq, epoch, journal, resync on overflow) |
| approval broker | `IApprovalService` one-shot broker: `request/resolve/listPending` | evidence: `packages/agent-core/src/services/approval/approval.ts` (SDK↔protocol adapters, expiry 60 s) |
| session multiplexing / busy facts | `SessionService` work facts: `busy`, `mainTurnActive`, `pendingInteraction: approval\|question\|none` | evidence: `packages/agent-core/src/services/session/sessionService.ts` (`SessionWorkFacts`, `onDidCreate/onDidClose`, `event.session.work_changed`) |
| redaction (PII + secrets) | `redactSnapshotForGrade` from `@moonshot-ai/transcript`; port `agent.redact.redact_sensitive_text` behavior | evidence: kap-server `sessionEventBroadcaster.ts` imports `redactSnapshotForGrade`; Python `gateway/run.py:_redact_gateway_user_facing_secrets` |
| platform SDKs (python-telegram-bot, discord.py, slack sdk…) | **out of scope** for desktop standalone (grammY/discord.js exist but no kimi-code evidence) | keep `PlatformAdapter` interface; external adapters remain on Python gateway if ever needed |
| TTS / STT (Edge TTS, ElevenLabs…) | **no TS equivalent verified**; route via Rust Tauri command or Web Speech API | mark risk; voice part is stored as opaque `VoicePart` until a TTS plan lands |
| p-queue / queue lib | per-session FIFO written from scratch | kimi-code has no queue lib (only TUI `queue-pane.ts`); busy modes are queue/interrupt/steer semantics, implement as `SessionMultiplexer` policies |
| signal / systemd / launchd lifecycle | **not needed** — in-process service uses a drain/restart FSM | Python `gateway/restart.py` exit-75 semantics map to `GatewayService.restart()` in-memory; OS supervision stays with Tauri/Rust |

## 6. Integration with existing Hermes-CN-Desktop frontend

- **Reuse unchanged**: `packages/protocol/src/hermes-api.ts` — freeze the `GatewayEvent`
  union (`GatewayKnownEvent | RawGatewayEvent`, `parseGatewayEvent`) and the RPC
  result schemas (`SessionCreateResult`, `PromptSubmitParams`, `CommandDispatchResult`,
  `SessionUsageResult`, …) as the in-process event/method contract.
- **Reuse as reducer**: `web/src/stores/chat.ts` — `applyGatewayEventAtom`,
  `chatRuntimeBySessionAtom`, `startPromptAtom`, `reduceGatewayEvent` consume events;
  the in-process `GatewayService` publishes the same shapes, so the store barely changes.
- **Replace**: `web/src/lib/gateway-client.ts` (WS transport, reconnect, `session.resume`)
  and `web/src/lib/gateway-socket-path.ts` (native vs Rust relay) with a synchronous
  `subscribeGatewayEvents()` facade over `IEventBus`.
- **Adapt**: `web/src/hooks/use-gateway.ts` — keep the subscriber bridge shape
  (`setConnectionState` / `applyGatewayEvent` / `terminateAllStreams`), swap the
  underlying connection for an in-process `GatewayService.handle` + event subscription;
  `connectionState` becomes "runtime ready".
- **Rust**: `src/commands/gateway.rs` (runtime config + gateway URL refresh) becomes
  obsolete for the gateway core; keep Rust for SQLite persistence, TTS, and native
  notifications. `src/commands/ws_proxy.rs` is deleted in the final phase.

## 7. Removing the WebSocket dependency (migration path)

Phased, freezing this API surface during migration (all names already in
`packages/protocol/src/hermes-api.ts`):

1. **Phase A — façade**: introduce `GatewayServiceAdapter` in `web/src/lib/` with the
   same method surface as `GatewayClient` (`session.create/resume/title`,
   `prompt.submit`, `command.dispatch`, `session.usage/compress`, event stream);
   consumers (`use-gateway.ts`, `chat.ts`) keep compiling untouched. Adapter delegates
   to the real WS client.
2. **Phase B — in-process core behind the same interface**: `GatewayService` implements
   the adapter surface for the **local chat** platform (desktop UI); `IEventBus`
   replaces the WS message pump for local events. Python gateway still handles external
   platforms; dual-write session keys must stay byte-identical (guard:
   `test_multiplex_phase0.py`).
3. **Phase C — flip**: local chat routes 100% in-process; `gateway-client.ts` and
   `gateway-socket-path.ts` deleted; `use-gateway.ts` connects directly to
   `GatewayService`. Remove `GET /api/ws` usage; `EXPECTED_BACKEND_VERSION` check
   (`web/src/lib/build-info.ts`) no longer gates the gateway path.

Frozen contract during B→C: every `GatewayEvent` discriminator and every RPC method
name/result shape in `hermes-api.ts`; any change goes through the protocol package
first.

## 8. Migration phases & task breakdown

- **P0 — bus + multiplexer + local adapter**: `IEventBus`, `SessionSource`/`buildSessionKey`,
  `SessionMultiplexer` (auth gate, busy modes, reset/eviction), `LocalChatAdapter`,
  `GatewayService.start/stop` skeleton. Tests: session-key byte-identity, busy auth.
- **P1 — slash commands + approval**: `SlashRegistry`/`Dispatcher`/`access.ts`
  (admin/user split, `/whoami`), `ApprovalBroker` + native approval UI prompt
  (reuse `PendingApproval` in `chat.ts`). Tests: tier gating, approval redaction,
  approve/deny.
- **P2 — cron + delivery ledger + media dedup**: cron scheduler (kimi-code pattern),
  `DeliveryLedger` (ack/redeliver/♻️ prefix), media resend dedup (#73771). Tests:
  `test_cron_shutdown_drain` parity, `test_73771_media_resend_dedup` parity.
- **P3 — PII + auto-reset + busy auth hardening**: `pii.ts` (hash helpers +
  secret redaction), auto-reset/eviction, busy-path auth parity (#17775). Tests:
  `test_pii_redaction`, `test_busy_session_auth_bypass`, eviction tests.
- **P4 — shutdown drain / restart flows**: `shutdownFlush` (transcript spool),
  drain FSM, restart with after-turn wait + auto-resume scheduling. Tests:
  `test_shutdown_flush`, `test_restart_drain`, `test_restart_resume_pending`.
- **P5 — cutover**: delete WS/REST gateway path; wire Playwright E2E; remove
  `EXPECTED_BACKEND_VERSION` gateway gate.

## 9. Risks & open questions

- **No TS equivalent found (flagged)**: `xxhash` (deterministic PII hashing — must
  port exactly for byte parity), cron expression matcher (kimi-code ships its own —
  port it, don't add `cron-parser` without review), SQLite driver (kimi-code uses
  file store + minidb; Rust `rusqlite` path unverified in TS), TTS/STT providers,
  and YAML hook manifests (prefer JSON/Zod; js-yaml unverified in kimi-code).
- **Out of scope platform SDKs**: Telegram/Discord/Slack adapters have TS SDKs but no
  kimi-code evidence; if external platforms are ever needed from the desktop, that is
  a separate plan. The `PlatformAdapter` interface is the seam.
- **Python agent loop is the real dependency**: the gateway orchestrates `AIAgent`
  turns; in-process TS agent runtime is another rewrite plan. This plan assumes an
  `AgentRunner` interface exists.
- **Parity drift**: busy-input modes (queue/interrupt/steer), silence tokens, delivery
  "♻️ Recovered reply" prefix, `[SILENT]` suppression, and session-key byte-identity
  are subtle; each needs a parity test named after the Python test.
- **Multi-user semantics**: desktop standalone is single-user; admin/user split and
  pairing/allowlists keep their data models for future adapters but will be mostly
  exercised in unit tests, not E2E.
- **Persistence migration**: if a user later runs the Python gateway on the same
  `HERMES_HOME`, session stores must not orphan existing sessions — the byte-identical
  key guard is non-negotiable (mirror `test_multiplex_phase0.py`).

## 10. Test strategy

- **vitest unit** (mirror Python names 1:1 in `packages/gateway-core/src/**/*.test.ts`):
  `session-key-byte-identical` (parity `test_multiplex_phase0.py`),
  `busy-session-auth-bypass` (#17775), `pii-redaction` (determinism + prefix
  preservation), `media-resend-dedup` (explicit `MEDIA:` never filtered vs bare path
  logged suppression), `approval-prompt-redaction`, `slash-access` tier matrix,
  `delivery-ledger-redeliver` (3 attempts/24 h, ♻️ prefix), `shutdown-flush` spool
  round-trip, `restart-drain` FSM, `cron-shutdown-drain`, `auto-reset-eviction` LRU/TTL.
- **Integration**: in-process `GatewayService` + fake `AgentRunner` + fake adapter
  driving full turn → stream → delivery; event bus ordering with per-session seq
  (kimi-code journal pattern).
- **Playwright E2E** (`e2e/`): chat submit → slash command → approval prompt →
  approve/deny → streamed reply; restart (stop/start service) → resume-interrupted
  notice; media resend.
- **Parity harness**: a table mapping each Python test file to its TS test file;
  CI asserts the mapping list stays complete (596-file suite is the behavior contract).

## 11. Reference links

- Python: `D:/hermes-agent-cn/gateway/run.py`, `session.py`, `slash_commands.py`,
  `slash_access.py`, `hooks.py`, `stream_consumer.py`, `platforms/base.py`,
  `delivery.py`, `delivery_ledger.py`, `drain_control.py`, `restart.py`,
  `shutdown_flush.py`, `config.py`, `profile_routing.py`
- Docs: `D:/hermes-agent-cn/website/docs/user-guide/messaging/index.md`;
  `D:/hermes-agent-cn/features_report.md` §5
- Tests: `D:/hermes-agent-cn/tests/gateway/` (596 files; representative:
  `test_multiplex_phase0.py`, `test_busy_session_auth_bypass.py`,
  `test_pii_redaction.py`, `test_approval_prompt_redaction.py`,
  `test_73771_media_resend_dedup.py`, `test_shutdown_flush.py`,
  `test_restart_drain.py`, `test_restart_resume_pending.py`,
  `test_cron_shutdown_drain.py`)
- TS reference: `D:/kimi-code/packages/agent-core/src/services/event/eventService.ts`,
  `…/services/session/sessionService.ts`, `…/services/approval/approval.ts`,
  `…/session/store/session-store.ts`, `…/agent/cron/manager.ts`,
  `…/tools/cron/{scheduler,clock,session-store}.ts`;
  `D:/kimi-code/packages/kap-server/src/transport/ws/v1/sessionEventBroadcaster.ts`
- Desktop: `D:/Hermes-CN-Desktop/web/src/lib/gateway-client.ts`,
  `web/src/hooks/use-gateway.ts`, `web/src/stores/chat.ts`,
  `web/src/lib/gateway-socket-path.ts`, `packages/protocol/src/hermes-api.ts`,
  `src/commands/gateway.rs`, `src/commands/ws_proxy.rs`
