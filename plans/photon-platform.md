# Photon (iMessage) Messaging Platform Adapter — Python → TypeScript Rewrite Plan

## 1. Summary

Photon is a **gateway-side messaging platform adapter** in the Python backend
(`D:/hermes-agent-cn/plugins/platforms/photon/`) that connects Hermes to
**iMessage** through Photon's managed Spectrum platform. Photon's send/receive
path is exposed **only** through the TypeScript-only `spectrum-ts` SDK
(long-lived gRPC stream; no public HTTP message API, no webhook, no signing
secret), so Python runs a small supervised **Node sidecar**
(`plugins/platforms/photon/sidecar/index.mjs`) that owns the SDK and bridges it
to Python over a loopback HTTP control channel + NDJSON inbound stream.

**Adapter port decision (recorded):** the messaging adapter runtime is
**gateway-side and stays out of scope for the desktop standalone rewrite in the
near term** — the desktop keeps working without embedding a Photon adapter,
because it consumes gateway state through the generic REST surface (`/api/status`
`gateway_platforms`, `/api/messaging/platforms` GET/PUT/POST-test) and photon
already appears there via the catalog entry at
`D:/hermes-agent-cn/hermes_cli/web_server.py:8756-8759`. The eventual TS
port is still designed below because the "Python → TS" direction is **inverted**
here: the TS implementation (the SDK) already runs today in the sidecar, so a
port collapses the Python adapter + Node sidecar + loopback HTTP bridge into a
first-party TS module consuming `spectrum-ts` directly; the open question is
webview vs a Tauri-spawned Node process for the gRPC SDK (§3/§9).

**WS-removal implications (recorded):** Photon's transport is a **platform-facing
gRPC stream to `spectrum.photon.codes`** — not the local Dashboard `/api/ws`
JSON-RPC link this rewrite program removes. Removing `/api/ws` only affects the
desktop chat UI transport; Photon message flow is unaffected because the desktop
never routed Photon messages over `/api/ws`. The gRPC stream stays owned by
whichever runtime hosts `spectrum-ts` (Python gateway today, first-party TS later).

## 2. Current Python implementation

Source of truth under `D:/hermes-agent-cn`:

- `plugins/platforms/photon/__init__.py` — plugin entry, re-exports `register`.
- `plugins/platforms/photon/plugin.yaml` — metadata; required env
  `PHOTON_PROJECT_ID` / `PHOTON_PROJECT_SECRET`; optional env per §4.
- `plugins/platforms/photon/adapter.py` (~2000 lines) — `PhotonAdapter(BasePlatformAdapter)`:
  - **Sidecar lifecycle**: `_start_sidecar` (cold `npm ci` self-heal, mixed-attachment
    patch, stdin-EOF parent-death watch, `/healthz` readiness, `lsof`/`ps` reaping),
    `_supervise_sidecar`, `_stop_sidecar` (`/shutdown` + stdin close); persists
    `{port,token,pid}` → `<hermes-home>/runtime/photon-sidecar.json` for
    `_standalone_send` out-of-process senders (issue #69960).
  - **Inbound**: `_inbound_loop` (loopback `GET /inbound` NDJSON, backoff reconnect) →
    `_dispatch_inbound` normalizes events (text/attachment/voice/reaction/
    poll_option/richlink/group), dedupes `messageId` (4000 ids / 48 h), waits 15 s on
    U+FFFC placeholders, suppresses richlink-preview attachments (30 s), promotes
    CAF→voice, caches inline base64 media, routes reactions only on bot-sent messages
    → `MessageEvent` to the gateway.
  - **Outbound**: `send` (markdown), `send_typing` (5 s cooldown), URL-only rich links,
    attachments/voice, native polls (`send_clarify` → `/send-poll`, text-capture fallback),
    reactions (`/react`/`/unreact`), effects (`/send-effect`); 8000-char cap.
  - **Health/presence**: `/healthz` poll → degraded upstream → retryable fatal;
    `_presence_watchdog`/`_probe_once` tri-state (alive/hung/inconclusive) respawns
    only after 3 consecutive hung probes (10 min interval).
  - **Mention gating** (BlueBubbles parity): `require_mention` + wake-word patterns +
    `_clean_mention_text`; groups only, DMs never gated.
  - **Error taxonomy**: `PhotonSidecarError` (`error_class`/`retryable`),
    `_PHOTON_RETRYABLE_PATTERNS` (overflow, upstream unavailable…), canonical
    `target_not_allowed` message for shared/free-tier line policy.
- `plugins/platforms/photon/auth.py` (~1164 lines) — pure-Python management plane:
  - **RFC 8628 device login** against `https://app.photon.codes/api/…`
    (`client_id=photon-cli`); token candidates from multiple response shapes
    (`access_token`, `session.access_token`, `data.*`, `set-auth-token` header)
    validated against `/api/auth/get-session` + `/api/projects/` before persist.
  - **Projects/users/lines**: list/find/create project (ids unified — dashboard id ==
    spectrum id), regenerate secret, list/register users (E.164), assigned line,
    provision iMessage line.
  - **Storage**: runtime creds → `~/.hermes/.env` via `save_env_value`; management
    metadata → `~/.hermes/auth.json` under `credential_pool.photon{,_project,_user}`
    (atomic `0o600` writes).
- `plugins/platforms/photon/cli.py` (~544 lines) — `hermes photon setup|status|
  install-sidecar|telemetry`; setup = device login → project → Spectrum creds (reuse
  valid secret, GH #50755) → register phone → print assigned line → npm install.
- `plugins/platforms/photon/sidecar_paths.py` — sidecar dir resolution
  (`PHOTON_SIDECAR_DIR` override → writable source → read-only with baked deps →
  mirror to `$HERMES_HOME/photon/sidecar`, NS-606).
- `plugins/platforms/photon/sidecar/` — `index.mjs` (loopback HTTP: `GET /inbound`,
  `POST /healthz|/probe|/send|/send-richlink|/send-attachment|/react|/unreact|/send-poll|
  /send-effect|/typing|/shutdown`), `package.json` (pins `spectrum-ts: 8.0.0`),
  `send-format.mjs`, `stream-staleness.mjs`, `patch-spectrum-mixed-attachments.mjs`.
- Docs: `website/docs/user-guide/messaging/photon.md` (250 lines) — setup flow, DM
  pairing/allowlist, mention gating, status output, env-var table, limits (inbound
  attachments metadata-only, outbound attachments/polls/effects supported, free
  quotas, standalone-send runtime record, shared-line `target_not_allowed`).
- Tests: `tests/plugins/platforms/photon/` — **22 files** (see §10 parity matrix).

## 3. Target TypeScript design

Module layout (eventual in-process target; §1 keeps the Python gateway as owner,
so this tree is the phase-2 target):

```
web/src/lib/platforms/
  types.ts                 # PlatformAdapter interface + MessageEvent/SendResult
  photon/
    auth.ts                # dashboard/spectrum REST: device flow, projects, users, lines
    client.ts              # Spectrum() SDK bootstrap + app.messages iterator
    adapter.ts             # PhotonAdapter implements PlatformAdapter
    senders.ts  mention.ts  media.ts  dedup.ts   # send builders, gating, media, LRU state
    watchdog.ts            # (mostly obsolete) presence probe/respawn semantics
    index.ts               # factory + register()
packages/protocol/src/channels.ts   # optional: photon onboarding types if UI added
```

Key interfaces (pseudocode, not implementation):

```ts
interface PlatformAdapter {
  connect(opts: { projectId: string; projectSecret: string }): Promise<void>;
  disconnect(): Promise<void>;
  onMessage(cb: (ev: MessageEvent) => void): void;
  send(chatId: string, content: string, replyTo?: string): Promise<SendResult>;
  sendTyping(chatId: string, state: "start" | "stop"): Promise<void>;
  sendRichlink(chatId: string, url: string): Promise<SendResult>;
  sendAttachment(chatId: string, path: string, kind: "attachment" | "voice", opts?): Promise<SendResult>;
  sendPoll(chatId: string, title: string, options: string[]): Promise<SendResult>;
  addReaction(chatId: string, messageId: string, emoji: string): Promise<void>;
  sendClarify(chatId: string, question: string, choices: string[] | null): Promise<SendResult>;
  test(): Promise<{ ok: boolean; state?: string; message?: string }>;
}

// Frozen inbound event shape (same as the sidecar emits today, for parity):
interface PhotonInboundEvent {
  messageId: string;
  platform: "iMessage";
  space: { id: string; type: "dm" | "group"; phone?: string };
  sender: { id: string };
  content:
    | { type: "text"; text: string }
    | { type: "attachment" | "voice"; id: string; name?: string; mimeType?: string;
        size?: number; duration?: number; data?: string; encoding?: "base64" }
    | { type: "reaction"; emoji: string; targetMessageId: string | null;
        targetDirection?: "inbound" | "outbound" | null; targetText?: string | null }
    | { type: "poll_option"; title: string; selected: boolean }
    | { type: "richlink"; url: string; title?: string; summary?: string }
    | { type: "group"; items: Array<{ content: PhotonInboundEvent["content"] }> };
  timestamp: string;
}
```

Data flow (eventual standalone):

1. Credentials come from a TS-owned settings store seeded from `.env`.
2. `client.ts` calls `Spectrum({ projectId, projectSecret, providers: [imessage.config()] })`
   (same call as `sidecar/index.mjs:9`) and iterates `for await (const [space, message] of app.messages)`.
3. Each message is normalized to `PhotonInboundEvent`, deduped, mention-gated,
   richlink-preview-suppressed, and routed to the in-process agent loop — no
   NDJSON, no loopback HTTP, no sidecar.
4. Outbound calls `space.send(...)` directly with the same content builders
   (`markdown()`, `richlink()`, `attachment()`, `voice()`, `poll()`, `effect()`,
   `typing()`) — the `/send*` endpoints become plain methods.
5. Adapter state maps to `MessagingPlatformInfo` so the Channels/status UI keeps
   working unchanged.

**Runtime-host open question (important):** `spectrum-ts` is a Node gRPC SDK
(`protobufjs` pinned via `overrides`, sidecar `package.json:18-25`); running it
directly in the Tauri **webview** is unproven (gRPC transport, Node `crypto`/`tls`).
Recommended: bundle the TS adapter into a Node process spawned by the desktop
(Tauri shell/child-process sidecar, like `apps/kimi-code/src/native` node-pty), webview
over Tauri IPC — the sidecar survives as first-party TS instead of Python-supervised.

## 4. Data models & persistence

- **Config keys** (parity with plugin.yaml / auth.py): required `PHOTON_PROJECT_ID`,
  `PHOTON_PROJECT_SECRET`; optional `PHOTON_SIDECAR_PORT` (8789),
  `PHOTON_SIDECAR_AUTOSTART`, `PHOTON_NODE_BIN`, `PHOTON_DASHBOARD_HOST`,
  `PHOTON_SPECTRUM_HOST`, `PHOTON_ALLOWED_USERS`, `PHOTON_ALLOW_ALL_USERS`,
  `PHOTON_REQUIRE_MENTION`, `PHOTON_MENTION_PATTERNS`, `PHOTON_HOME_CHANNEL[_NAME]`,
  `PHOTON_TELEMETRY`, `PHOTON_MARKDOWN`, `PHOTON_REACTIONS`, plus watchdog knobs.
- **Persistence (migration-aware):** today runtime creds live in `~/.hermes/.env`
  (`auth.py:_persist_runtime_env`) and management metadata in `~/.hermes/auth.json`
  under `credential_pool.photon*`. Phase 2 adds a TS-owned settings store (Rust-side
  SQLite or JSON) seeded from `.env`; secrets stay redacted via the existing
  `ImRedactedValue` + fingerprint pattern. Phase 3 drops `.env` writes for desktop.
- **Runtime record `photon-sidecar.json`**: **obsolete in the TS port** — no
  sidecar/loopback means no out-of-process send path to publish; `_standalone_send`
  (cron/`hermes send`) is a Python-gateway concern the in-process agent loop replaces.
- **In-memory adapter state (no durable schema):** `_seen_messages` (4000 ids / 48 h),
  `_sent_message_ids` (reaction routing), `_last_inbound_by_chat`,
  `_recent_richlinks_by_chat` (30 s), `_typing_last_sent` (5 s cooldown),
  `_pending_fffc` (15 s), watchdog counters — all bounded Maps/LRUs in `dedup.ts`.
- **Protocol types:** no change required for MVP — `MessagingPlatformInfo`
  (`packages/protocol/src/hermes-api.ts:127-144`) and `StatusResponse`
  `gateway_platforms` are already generic and photon flows through them. If a
  photon onboarding UI is added later, extend `channels.ts` (`ImPlatform =
  "feishu" | "weixin"` at line 491) with photon onboarding types.

## 5. Third-party library strategy

| Python dependency | TS equivalent | kimi-code evidence / status |
|---|---|---|
| `spectrum-ts` (npm, TS-only SDK; run via Node sidecar) | **Use the same npm package directly** — `spectrum-ts@8.0.0`, the official Photon SDK; no shim needed. | Pinned exactly in `D:/hermes-agent-cn/plugins/platforms/photon/sidecar/package.json:16`. **Verified absent from `D:/kimi-code`**: zero meaningful `photon`/`imessage` source matches (only `OpenAIMessage` types and VSCode-style `IMessageService` false positives), no `spectrum-*`/`photon-*` dir under node_modules (searched). External dependency we add. |
| Node `http` loopback server (sidecar control channel) | **Deleted in TS port** — direct in-process SDK calls; NDJSON, bearer token, `/healthz|/probe|/shutdown` disappear. | n/a. |
| `httpx` (async REST: device flow, projects, users, lines) | `undici` / Node `fetch` | `undici: ^7.27.1` in `packages/agent-core/package.json:102` (+ agent-core-v2); desktop renderer already uses fetch (`web/src/lib/transport.ts`). |
| `orjson` (NDJSON/inbound parsing) | Built-in `JSON.parse` | n/a (kimi-code uses std JSON). |
| `pybase64` (Basic auth header, base64 attachments) | `Buffer.from(...).toString("base64")` / `btoa` | Node `Buffer` used across kimi-code. |
| `agent.re_compat.re` (mention patterns, E.164, URL regex) | JS `RegExp` | Used throughout kimi-code. |
| `subprocess`/npm self-heal/`lsof`/`ps` (sidecar supervision + port reaping) | `node:child_process` + `node:net` (or Rust Tauri commands); npm only at install time | `apps/kimi-code/src/native` uses node-pty/child_process; TS can use `net` socket probes instead of `lsof`. |
| `secrets.token_hex(16)` (sidecar bearer) | `crypto.randomBytes(16).toString("hex")` | Node `crypto` in kimi-code. |
| `gateway.status._pid_exists` / `psutil` | `process.kill(pid, 0)` (POSIX); Windows: `tasklist` or Rust | n/a. |

**"No TS equivalent found" risks (explicit):**

1. **No photon/iMessage adapter code exists in kimi-code** (verified). The only real
   TS asset is the sidecar's own `index.mjs` + `spectrum-ts` — exactly the "TS
   equivalent" to adopt. Add `spectrum-ts@8.0.0` as a first-party dependency (pinned
   exactly; the SDK ships breaking majors) rather than writing a protocol shim.2. **`patch-spectrum-mixed-attachments.mjs`** is a vendor patch to the SDK (rewrites
   the iMessage mapper, tested in `test_spectrum_patch.py`). The TS port must
   vendor/re-apply it.
3. **Device-code token shapes**: auth.py extracts tokens from up to five response
   shapes and validates against the dashboard before persisting
   (`_device_response_token_candidates`, `_validated_dashboard_token`). TS must
   replicate exactly to avoid saving a stale token.
4. **Behavioral semantics have no TS counterpart** (mention gating, U+FFFC
   placeholders, richlink-preview suppression, reaction routing, `target_not_allowed`
   canonical message, retryable errors, 5 s typing cooldown): reimplement from
   scratch and parity-test against the 22 Python test files.
5. **Zombie-stream/presence watchdog** lives in the sidecar (`stream-staleness.mjs`)
   and adapter (`_presence_watchdog`). In-process TS still needs the staleness probe
   (sidecar module reused verbatim), though respawn becomes a stream reconnect.

## 6. Integration with existing Hermes-CN-Desktop frontend

- **Channels list (no change):** `web/src/routes/settings.tsx:1478-1481` renders
  `status.gateway_platforms` generically, so photon already shows state; the Core
  catalog entry (`web_server.py:8756-8759`) supplies name/docs. Channels edits env
  via `PUT /api/messaging/platforms/{id}` and tests via
  `POST /api/messaging/platforms/{id}/test` — reuse that generic surface instead of
  the feishu/weixin-scoped IM onboarding hooks.
- **IM onboarding (`/im`):** photon is **not** part of the QR-onboarding trio —
  `ImPlatform = "feishu" | "weixin"` (`channels.ts:491`), no photon arm in
  `src/commands/im_onboarding.rs`, no `/im/photon` route. No UI work for MVP; if a
  device-code onboarding UI is later desired, reuse the Feishu/Weixin page chrome
  (`SectionShell`, `MetaStrip`, `ActionFeedback`, `statusText`, `openExternal`,
  `qrcode`) with a device-code panel instead of QR scan.
- **Diagnostics (`web/src/lib/im-onboarding-diagnostics.ts`):** no photon branch today;
  if onboarding UI is added, extend `DIAGNOSTIC_REQUIRED_KEYS` with
  `["PHOTON_PROJECT_ID", "PHOTON_PROJECT_SECRET"]`, `DIAGNOSTIC_POLICY_KEYS` with
  `["PHOTON_ALLOWED_USERS", "PHOTON_ALLOW_ALL_USERS", "PHOTON_REQUIRE_MENTION",
  "PHOTON_HOME_CHANNEL"]`, and add `explainMessagingFailure` branches for:
  `target not allowed`, stale/401 device token, sidecar deps missing / npm error log,
  `upstream_overflow`/retryable sidecar errors, EADDRINUSE.
- **Protocol:** no `ImPlatform` change for MVP; `MessagingPlatformInfo` and
  `StatusResponse` already carry photon (`gateway_platforms.photon`).
- **Rust side:** no photon-specific Tauri command exists and none is needed for MVP.
  If the Node-hosted TS adapter is chosen (§3), add a Tauri command to spawn/manage
  the Node process (analogous to `src/commands/*` child-process commands).

## 7. Removing the WebSocket dependency (migration path)

Clarification to record — three distinct channels:

- **(A) Local Dashboard `/api/ws` JSON-RPC** (desktop ⇄ managed Python runtime): the
  link this rewrite removes. Photon never depends on it for message flow; the desktop
  only uses REST status/config endpoints for photon.
- **(B) Photon platform-facing gRPC stream** (sidecar ⇄ `spectrum.photon.codes`):
  inbound+outbound transport. Must remain; ownership moves from the Python-supervised
  sidecar to the first-party TS module after the port.
- **(C) Sidecar loopback HTTP** (Python adapter ⇄ sidecar, `127.0.0.1:8789`):
  disappears entirely in the TS port.

Freeze surface during migration (keep identical semantics so phase 2 can toggle back
to Python):

- Config keys: `PHOTON_PROJECT_ID`, `PHOTON_PROJECT_SECRET` and the optional keys in
  §4 — values must round-trip between `.env` (phase 1) and TS store (phase 2).
- Behavioral contract: 8000-char cap; markdown sends (kill-switch
  `PHOTON_MARKDOWN=false`); narrow URL-only richlink rule; 30 s richlink-preview
  suppression; 5 s typing cooldown; 15 s U+FFFC wait; 4000-id/48 h dedup; group
  `require_mention` + wake-word strip; allowlist semantics; canonical
  `target_not_allowed` message; retryable error classes.- Status shape: `MessagingPlatformInfo.state` values (connected/disabled/
  not_configured/pending_restart/gateway_stopped/error) + `POST .../{id}/test` response semantics.

Phases:

1. **P1 — Keep Python gateway as owner (recommended near-term).** No code changes;
   record the out-of-scope decision; keep `/api/status` + `/api/messaging/platforms`
   GET/PUT/POST-test from the generic Channels UI. WS link (A) stays.
2. **P2 — First-party TS adapter (optional, behind toggle).** Implement
   `web/src/lib/platforms/photon/*`, host in a Node process spawned by Tauri (or
   webview if proven), seed TS store from `.env`, keep Python gateway as fallback
   (`PHOTON_RUNTIME=python|ts`); channel (C) disappears.
3. **P3 — Delete the WS/REST path.** Remove `/api/ws` + the REST messaging bridge
   for photon, retire the Python adapter + sidecar for desktop users, delete the
   `/api/messaging/platforms` photon arms (or the whole bridge); channel (B) stays
   owned by the TS module.

## 8. Migration phases & task breakdown

- **Phase 1 — Record decision + no-op (gateway-side stays):**
  - [ ] Confirm photon renders in the generic Channels list via `/api/status` +
        `/api/messaging/platforms` (manual QA with a configured gateway).
  - [ ] Document that the desktop has no photon onboarding UI and needs none.
- **Phase 2 — In-process TS runtime (`web/src/lib/platforms/photon/`):**
  - [ ] `auth.ts`: port device flow (multi-shape token candidates, validation),
        projects, users, lines; vitest with mocked HTTP.
  - [ ] `client.ts`: `Spectrum({...})` bootstrap + `app.messages` iterator; decide
        webview vs Node-process hosting (spike).
  - [ ] `adapter.ts` + `dedup.ts` + `mention.ts` + `media.ts`: normalize inbound
        events, dedup, U+FFFC, richlink suppression, mention gating, CAF→voice,
        reaction routing.
  - [ ] `senders.ts`: direct SDK send builders for text/richlink/attachment/voice/
        poll/effect/typing/react/unreact (port sidecar endpoint logic).
  - [ ] TS settings store seeded from `.env`; runtime toggle (`PHOTON_RUNTIME=python|ts`);
        map adapter state → `MessagingPlatformInfo`.
  - [ ] Wire adapter into the in-process agent loop/session store; implement
        `sendClarify` text-capture + poll fallback.
- **Phase 3 — Remove WS/REST dependency:**
  - [ ] Migrate `PHOTON_*` reads to TS store; drop `.env` write path for desktop.
  - [ ] Remove photon from Python gateway dependency for desktop users; delete Python
        adapter + sidecar + runtime record (+ `hermes photon` CLI wiring if CLI-only
        installs no longer ship it).
  - [ ] Delete `/api/ws` bridge + REST messaging endpoints for photon; retire
        standalone-send runtime-record path.
  - [ ] Optional stretch: photon onboarding UI (device-code panel) in `/im`.

## 9. Risks & open questions

- **"No TS equivalent found" risks are the headline** (see §5): no photon/iMessage
  code in kimi-code; the TS plan depends on adopting the external `spectrum-ts`
  package and vendoring `patch-spectrum-mixed-attachments.mjs`; all behavioral
  semantics must be reimplemented and parity-tested.
- **gRPC SDK in the webview is unproven.** `spectrum-ts` is a Node gRPC client; the
  webview may lack the needed Node APIs. Open question: bundle the adapter into a
  Tauri-spawned Node process (recommended) vs webview bundling.
- **spectrum-ts breaking majors** (sidecar README): pin exactly, lock
  `protobufjs`/OTel overrides, and keep the mixed-attachment patch in the repo.
- **Dashboard API drift** (device-token shapes, unified project id): TS auth must
  replicate the candidate/validation logic and keep `PHOTON_DASHBOARD_HOST` /
  `PHOTON_SPECTRUM_HOST` overrides.- **Behavioral parity** is the biggest migration cost: 22 Python test files cover
  lifecycle, watchdog, overflow recovery, reactions, rich links, polls, streaming,
  runtime record, npm-error regressions — each maps to a TS suite; the Python suite
  stays the reference oracle until phase 3.
- **Free-tier `target_not_allowed`**: shared lines cannot initiate outbound to new
  targets; cron/standalone delivery to brand-new numbers fails by Photon policy —
  TS must preserve the canonical user-facing message.
- **Inbound attachment bytes**: sidecar inlines up to 20 MiB base64; docs note
  `content.read()` exists for a follow-up. Decide whether TS reads bytes directly
  (SDK-native) or keeps the metadata-only marker behavior.
- **Poll clarify interplay**: native poll votes arrive as `poll_option` events; TS
  must keep the `mark_awaiting_text`-style text-capture contract so the gateway's
  pending-clarify intercept resolves choices.
- **Windows support**: Python sidecar uses `windows_hide_flags`; TS/Node host must
  not pop consoles and must handle `lsof`-free port checks (`net` + `tasklist`/Rust).

## 10. Test strategy

Vitest parity suites mirroring the 22 Python files under
`D:/hermes-agent-cn/tests/plugins/platforms/photon/`:

| Python test file | TS suite | Coverage |
|---|---|---|
| `test_auth.py` | `auth.test.ts` | token store/load round-trip, auth.json 0600 atomic write, env-override precedence, device-code request body, poll loop (pending/slow_down/429/denied/expired), multi-shape token candidates, validate-before-persist, list/unwrap, find-by-name, create-project (no `spectrum` flag), regenerate secret, user dedup, assigned line, line provision, no-secret-leak summary, E.164 |
| `test_inbound.py` | `inbound.test.ts` | text DM dispatch, dedup window, CAF→voice, U+FFFC placeholder wait + no dispatch, disconnect cancels pending, missing space.id |
| `test_markdown.py` | `senders.test.ts` | markdown passthrough default, `supports_code_blocks` mirrors env, markdown format flag on send |
| `test_mention_gating.py` | `mention.test.ts` | default off, group drop without wake word, DM never gated, custom patterns config/env, invalid pattern skipped |
| `test_outbound_media.py` | `senders.test.ts` | attachment endpoint payload, standalone send text→media |
| `test_rich_links.py` / `test_url_send_path.py` | `senders.test.ts` | URL-only → richlink, prose/markdown-link → text, malformed URL → text, inbound richlink → URL text, `chooseSendFormat` decision table |
| `test_reactions.py` | `senders.test.ts`/`inbound.test.ts` | react/unreact payloads, soft failure, hooks noop when disabled, 👀 on processing start, bot-message reaction routed, human↔human ignored |
| `test_poll_clarify.py` | `adapter.test.ts` | poll vote → choice text, choices → native poll, poll failure → numbered-text fallback |
| `test_overflow_recovery.py` | `watchdog.test.ts` | retryable classification (overflow patterns), structured non-retryable flag, typing cooldown suppress/reset, unexpected sidecar exit → retryable fatal, degraded health → retryable fatal, `target_not_allowed` canonical message |
| `test_zombie_stream_watchdog.py` / `test_presence_watchdog.py` | `watchdog.test.ts` | probe tri-state (alive/hung/inconclusive), respawn only after N hung probes, inconclusive never accumulates |
| `test_sidecar_lifecycle.py` / `test_sidecar_deps_stale.py` / `test_spectrum_patch.py` / `test_sidecar_paths.py` / `test_runtime_record.py` / `test_npm_error_log_regression.py` / `test_check_requirements_risks.py` / `test_fatal_notify_self_cancel.py` / `test_setup_access.py` | `lifecycle.test.ts` + `setup.test.ts` | mostly **obsolete in TS** (sidecar/npm/lsof/runtime-record concerns); retain behavioral bits: supervisor self-cancellation guard, auto-configure access, env-enablement seeding home channel |
| `test_streaming.py` | `adapter.test.ts` | `SUPPORTS_MESSAGE_EDITING === false` |

- **Integration:** vitest with a mocked `Spectrum()` (fake `app.messages` iterator +
  fake `space.send` recording calls) asserting inbound→normalize→dispatch and
  outbound builder selection.
- **Playwright E2E (only if phase-2 UI is added):** Channels page shows photon state;
  `POST /test` ok/error; diagnostics bundle (if onboarding UI) lists photon keys.
- **Parity gate:** run the 22 Python files against the Python adapter and the vitest
  suites side-by-side; document divergences before phase 3 deletion.

## 11. Reference links

- Python plugin: `D:/hermes-agent-cn/plugins/platforms/photon/{__init__,adapter,auth,cli,sidecar_paths}.py`,
  `plugin.yaml`, `README.md`
- Sidecar: `D:/hermes-agent-cn/plugins/platforms/photon/sidecar/{index.mjs,package.json,send-format.mjs,stream-staleness.mjs,patch-spectrum-mixed-attachments.mjs,README.md}`
- Docs: `D:/hermes-agent-cn/website/docs/user-guide/messaging/photon.md`
- Tests: `D:/hermes-agent-cn/tests/plugins/platforms/photon/` (22 files)
- REST surface: `D:/hermes-agent-cn/hermes_cli/web_server.py` (catalog entry
  8756-8759; `GET /api/messaging/platforms` 10256-10297; `PUT .../{id}` 10351-10419;
  `POST .../{id}/test` 10422-10470)
- Desktop protocol: `D:/Hermes-CN-Desktop/packages/protocol/src/channels.ts`
  (`ImPlatform` line 491), `packages/protocol/src/hermes-api.ts`
  (`MessagingPlatformInfo` 127-144)
- Desktop UI: `D:/Hermes-CN-Desktop/web/src/routes/settings.tsx` (generic
  platform list 1478-1481), `web/src/routes/im-onboarding.tsx`,
  `web/src/lib/im-onboarding-diagnostics.ts`, `web/src/hooks/use-im-onboarding.ts`
- TS reference (kimi-code): `packages/agent-core/package.json:102` (`undici`);
  **no photon/iMessage/spectrum-ts anywhere in `D:/kimi-code` — verified**
  (source grep found only `OpenAIMessage`/`IMessageService` false positives;
  node_modules search found no `spectrum-*`/`photon-*` package directories)
- Plans conventions: `D:/Hermes-CN-Desktop/plans/README.md`,
  `D:/Hermes-CN-Desktop/plans/_PROMPT_TEMPLATE.md`; sibling example:
  `D:/Hermes-CN-Desktop/plans/dingtalk-platform.md`
