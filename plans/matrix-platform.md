# Matrix Messaging Platform Adapter — Python → TypeScript Rewrite Plan

> Port decision recorded up front: **Matrix is a gateway-side messaging platform adapter and is
> marked "out of scope for desktop standalone"** (per `plans/README.md`). The Desktop keeps
> talking to the Core managed-runtime gateway over REST (`/api/messaging/platforms`, `/api/env`)
> and WS (`/api/ws`) and does **not** host the Matrix bot in-process in v1. This file still
> designs the in-process TS port (Sections 3–10) so the decision is recorded and a future
> standalone build can pick it up. Feature scope: Matrix bot (mautrix sync loop), voice messages
> (MSC3245), reaction-based exec approval, recovery-key secret scope, E2EE (cross-signing xsign
> bootstrap).

## 1. Summary

Hermes-CN-Core ships a Matrix gateway adapter at `D:/hermes-agent-cn/plugins/platforms/matrix/adapter.py`
(~5,425 lines, `MatrixAdapter(BasePlatformAdapter)`), built on the **mautrix-python** SDK
(`mautrix.api.HTTPAPI` + `mautrix.client.Client` + optional `OlmMachine` E2EE). It connects to
any Matrix homeserver (Synapse/Conduit/Dendrite/matrix.org) over `/sync` long-polling, auto-joins
invited rooms, isolates per-user/per-thread sessions, renders Markdown→HTML with an allowlist
sanitizer, uploads/downloads media through `mxc://` (with encrypted-media decryption), sends
MSC3245 voice bubbles (Ogg/Opus transcode + waveform metadata), resolves exec approvals via
reactions (`✅`/`🌀`/`♾️`/`❌`) plus `!approve`/`!deny`, and supports E2EE modes
`off|optional|required` with device-key verification and **cross-signing auto-bootstrap** (recovery
key import or one-time `generate_recovery_key`, unpadded base64 keyids).

The Desktop web app currently has **no Matrix-specific UI**: it only maps `MATRIX_*` env vars in
`web/src/lib/env-translations.ts` (L299–314) and `matrix.*` config keys in
`web/src/lib/config-translations.ts` (L298–301), and the IM onboarding
(`web/src/routes/im-onboarding.tsx` + `web/src/lib/im-onboarding-diagnostics.ts`) covers
Feishu/Weixin/DingTalk only. This plan records the port decision — **keep Matrix in the Python
gateway (managed runtime) for v1, expose config/status in Desktop via REST; do not host the bot
in-process** — and gives the full design for an eventual in-process TypeScript port built on
**matrix-js-sdk** (recommended; see Section 5), which **does not exist anywhere in
`D:/kimi-code`** (verified — repo-wide search for `matrix-js-sdk|mautrix|megolm|olm` returns
zero protocol hits; `node_modules/.pnpm` contains no `matrix-js-sdk`/`@matrix-org/*`).

## 2. Current Python implementation

Source of truth: `D:/hermes-agent-cn`

| Path | Role (verified by reading) |
|---|---|
| `plugins/platforms/matrix/adapter.py` (5,425 lines) | `MatrixAdapter` — connect/disconnect, initial + incremental `/sync`, `_sync_loop` (2987), `_dispatch_sync` (3068), room-message/reaction/invite handlers, all send paths, E2EE setup, recovery-key bootstrap, interactive setup |
| `plugins/platforms/matrix/__init__.py` | `register` re-export |
| `plugins/platforms/matrix/plugin.yaml` | platform manifest: requires `MATRIX_HOMESERVER` + `MATRIX_ACCESS_TOKEN` (or password), optional `MATRIX_ALLOWED_USERS`, `MATRIX_ALLOW_ALL_USERS`, `MATRIX_HOME_CHANNEL[_NAME]` |
| `website/docs/user-guide/messaging/matrix.md` (917 lines) | setup, capability matrix, session model, E2EE (353–501), cross-signing (446–497), media limits, troubleshooting |
| `tests/gateway/test_matrix*.py` (11 files) + `tests/e2e/matrix_xsign_bootstrap/` | parity source (see §10) |

Key implementation blocks inside `adapter.py` (line refs verified by reading):

- **Connection / auth**: `connect()` (1679) — token via `whoami()` (resolves user/device ID,
  token-bound device wins over stale `MATRIX_DEVICE_ID`, #71543), or password `client.login()`;
  `_create_matrix_session` (718) — aiohttp session with HTTP/SOCKS proxy (`aiohttp_socks`) or
  `trust_env`; `disconnect` (2112); `_sync_loop` (2987) with clock-skew grace drops and reconnect.
- **Inbound**: `_on_room_message` (3173) → `_resolve_message_context` (3314) → `_handle_text_message`
  (3432) / `_handle_media_message` (3516); mention gating (`_is_bot_mentioned` 4879, `_strip_mention`
  4912, `_parse_require_mention` 1362, `_parse_thread_require_mention` 1381); room identity
  (`MatrixRoomIdentity` 496, `_resolve_room_identity` 4637); DM cache + `m.direct` recording
  (`_refresh_dm_cache` 4702, `_record_dm_room` 4730); invite auto-join gated by allowlist
  (`_on_invite` 3744, `_schedule_pending_invite_joins` 3847); reply-fallback parsing
  (`_extract_reply_fallback` 363, `_strip_reply_fallback` 393); `!command` alias
  (`_resolve_matrix_bang_command` 286, `_normalize_matrix_bang_command` 337); text batching
  (`_enqueue_text_event` 4245).
- **Voice**: `send_voice` (2543) — transcodes non-Ogg input to Ogg/Opus via ffmpeg
  (`_matrix_transcode_voice_to_ogg` 227, `asyncio.to_thread`), adds `org.matrix.msc3245.voice`
  field + duration/waveform metadata (`_matrix_voice_metadata_for_file` 147, ffprobe/ffmpeg);
  inbound `m.audio` with `org.matrix.msc3245.voice` → `MessageType.VOICE`, cached locally
  (`_handle_media_message` 3516–3683); encrypted-media `file.url` decryption via
  `mautrix.crypto.attachments.decrypt_attachment`.
- **Exec approval**: `send_exec_approval` (2612) — posts `_format_exec_approval` text + scope
  legend, registers `_MatrixApprovalPrompt` (513), attaches reactions `✅/🌀/♾️/❌` and records bot
  reaction event IDs for cleanup; `_on_reaction` (3971) resolves prompts with requester binding
  (`_validate_matrix_prompt_reactor` 4119, `MATRIX_APPROVAL_REQUIRE_SENDER` default true), expiry
  (`_expire_matrix_approval_prompt` 4172), fail-closed feedback (`_send_invalid_reaction_feedback`
  4161). Model/choice pickers use the same reaction machinery (`send_model_picker` 2684,
  `send_choice_picker` 2765).
- **Recovery key scope**: `_scoped_recovery_key()` (886) — reads `MATRIX_RECOVERY_KEY` through
  `agent.secret_scope.get_secret` (scope-aware under `gateway.multiplex_profiles`, #69090) and
  only falls back to `os.environ` on `UnscopedSecretError` (#59739 Slack pattern); one-time key
  output file with mode 0600 (`_write_matrix_recovery_key_output_file` 805,
  `_get_matrix_recovery_key_output_target` 831, `_handle_generated_matrix_recovery_key` 846).
- **E2EE / xsign bootstrap**: `_check_e2ee_deps` (751, requires `mautrix.crypto.OlmMachine` +
  `PgCryptoStore` + `asyncpg` + `aiosqlite`), `_CryptoStateStore` (1070, mautrix crypto
  StateStore adapter), `_verify_device_keys_on_server` (1595, stale-key detection/re-upload),
  `_reset_crypto_store_if_device_changed` (1443), `_migrate_legacy_crypto_pickle` (1474) +
  `_repickle_crypto_sessions` (1540); connect-time block (1828–2030): SQLite crypto store
  `~/.hermes/platforms/matrix/store/crypto.db` (`_CRYPTO_DB_PATH` 603), then `verify_with_recovery_key`
  **or** `get_own_cross_signing_public_keys` → `generate_recovery_key()` (unpadded base64 keyids;
  the e2e suite pins this).
- **Outbound / tools**: `send` (2155), `format_message` (2825, Markdown→HTML via
  `_markdown_to_html` 4966 + allowlist sanitizer `_MatrixHtmlSanitizer` 416 + `_sanitize_matrix_html`
  904), `_build_text_message_content` (4775), mention link injection (`_inject_outbound_mention_links`
  4835, `_extract_outbound_mentions` 4818), media sends (`send_image` 2329, `send_image_file` 2480,
  `send_multiple_images` 2493, `send_document` 2529, `send_video` 2593, `_upload_and_send` 2835),
  Matrix tools (`redact_message` 4339, `create_room` 4364, `invite_user` 4404, `fetch_history` 4416,
  `set_presence` 4479), diagnostics (`get_diagnostics` 2225, redacts tokens/recovery keys/device IDs).
- **Registry / setup**: `register` (5405), `interactive_setup` (5233), `_is_connected` (5379),
  `check_matrix_requirements` (974) / `ensure_matrix_deps` (998) / `matrix_deps_present` (959)
  with lazy-install via `tools.lazy_deps`.

Docs key behaviors (`website/docs/user-guide/messaging/matrix.md`): capability matrix (32–52),
session model + `group_sessions_per_user` (54–78), mention/threading config (80–130), E2EE modes
`off|optional|required` (382–407), cross-signing verification (446–497), media limits `mxc://` only
(432–444), hardening/allowlists (292–339).

## 3. Target TypeScript design

**Port decision (recorded):** keep the adapter in the Python gateway for v1; the Desktop only
adds a config/status surface (Section 6). The in-process design below is the "if ported" target,
matching the `PlatformAdapter` contract in `plans/messaging-gateway-core.md`
(`typedCommandPrefix(): "!"` — Matrix uses `!command` aliases).

Proposed module layout (`packages/matrix-adapter/` or, if kept web-local, `web/src/platforms/matrix/`):

```
packages/matrix-adapter/src/
  adapter.ts          # MatrixAdapter — implements PlatformAdapter (connect/send/edit/approval/reactions/tools)
  config.ts           # MatrixConfig: homeserver/token/user/password/e2eeMode/deviceId/proxy/allowlists
  client.ts           # matrix-js-sdk facade: createClient, login/whoami, uploadMedia, downloadMedia
  sync.ts             # startClient + sync event dispatch; reconnect/clock-skew grace; invite auto-join
  events.ts           # inbound normalization: RoomMessage/Reaction → MessageEvent{source:{platform:'matrix',...}}
  mention-gating.ts   # require-mention / allowed-users / allowed-rooms / free-response / ignore patterns
  room-identity.ts    # room name/topic/alias/member-count/DM detection + m.direct cache
  formatting.ts       # markdown → Matrix HTML (+ sanitizer), mention link injection, reply fallback parse
  media.ts            # mxc→http, size caps, encrypted-media decrypt (AES-256-CTR), local cache
  voice.ts            # Ogg/Opus transcode (ffmpeg) + duration/waveform metadata; MSC3245 field
  approvals.ts        # reaction-based exec approval / model / choice pickers + bot-reaction cleanup
  crypto.ts           # E2EE setup: crypto store, device-key verify, recovery-key import, xsign bootstrap
  text-batch.ts       # _enqueue_text_event port (debounced inbound text batching)
```

Key interfaces (signatures only, design intent — not implementation):

```ts
interface MatrixAdapter {
  connect(cfg: MatrixConfig): Promise<boolean>;        // login + start sync + (E2EE) xsign bootstrap
  disconnect(): Promise<void>;
  onMessage(ev: MessageEvent): Promise<void>;          // gateway-core hook (SessionMultiplexer.route)
  send(chatId: string, content: string, meta?: SendMeta): Promise<SendResult>;
  sendVoice(chatId: string, audioPath: string, meta?: SendMeta): Promise<SendResult>; // MSC3245
  sendExecApproval(req: { chatId; command; sessionKey; ... }): Promise<SendResult>;
  redactMessage(roomId: string, eventId: string): Promise<boolean>;
  fetchHistory(roomId: string, opts: { limit?; dir? }): Promise<HistoryEvent[]>;
  getDiagnostics(): MatrixDiagnostics;                 // redacted token/recovery-key/device previews
}

interface MatrixCrypto {
  mode: "off" | "optional" | "required";
  verifyRecoveryKey(key: string): Promise<void>;       // import cross-signing keys + sign current device
  bootstrapIfMissing(outFile?: string): Promise<string | null>; // generate_recovery_key once
  verifyDeviceKeysOnServer(): Promise<boolean>;        // stale-key detect/re-upload
}
```

Running shape: if ported, the adapter runs as a long-lived in-process task inside the Tauri
webview (or a sidecar), connecting directly to the homeserver over HTTPS — no Python runtime, no
WS. Events flow into the in-process gateway core (`SessionMultiplexer.route`), outbound sends go
back through `matrix-js-sdk` room sends. For v1 (recommended), **none of this runs in the Desktop**;
the Python gateway remains the only Matrix client.

## 4. Data models & persistence

| Data | Python location/structure | TS strategy |
|---|---|---|
| E2EE crypto store (Olm account, olm/megolm sessions, device keys, cross-signing keys) | SQLite `~/.hermes/platforms/matrix/store/crypto.db` (`_CRYPTO_DB_PATH`, `PgCryptoStore` w/ pickle keys) | matrix-js-sdk built-in crypto store — **IndexedDB** (`indexeddb-crypto-store`) or in-memory with export; if SQLite needed, reuse `packages/minidb`. Schema migration N/A (SDK-owned) |
| Room identity cache (`MatrixRoomIdentity`) | in-memory `_room_identities` + `_room_identity_cached_at` (4624) | in-memory `Map<roomId, RoomIdentity>` with TTL; optionally minidb for offline status |
| DM room cache (`m.direct`) | in-memory `_dm_rooms` + `_record_dm_room` (4730) | in-memory `Map` rebuilt from account data; optional minidb |
| Approval/model/choice prompts | in-memory `_MatrixApprovalPrompt` (513) / `_MatrixModelPickerPrompt` (535) / `_MatrixChoicePickerPrompt` (550) + `_approval_prompts_by_event`/`_approval_prompt_by_session` | in-memory `Map<eventId, Prompt>` + `Map<sessionKey, eventId>` with `expiresAt` (approvals.ts); parity: fail-closed reactor validation + bot-reaction cleanup |
| Media cache (inbound files) | `cache_image_from_bytes` / `cache_audio_from_bytes` / `cache_document_from_bytes` (`gateway/platforms/base.py`) | file cache dir + `fs/promises`; download via `client.downloadMedia`, decrypt attachments first |
| Text-batch debouncer state | in-memory `_pending_text_batches` (`_enqueue_text_event` 4245) | in-memory `Map<batchKey, {timer, events}>` (text-batch.ts) |
| Sessions / messages / delivery ledger | gateway session store (`~/.hermes/sessions/`) + delivery ledger | owned by `plans/messaging-gateway-core.md` / session-lifecycle plan — not this adapter |

The adapter itself introduces no new durable schema beyond the SDK-managed crypto store; the only
Hermes-owned persistence would be optional caches (room identity / DM / media). No schema
migrations needed beyond "create IndexedDB store on first use".

## 5. Third-party library strategy

**kimi-code verification (measured this session):**
- Repo-wide grep for `matrix-js-sdk|mautrix|megolm|olm|from 'matrix` → **0 protocol hits**
  (the ~20 "matrix" file matches are 2-D test matrices / provider names, e.g.
  `packages/klient/test/e2e/invalid-input-matrix.test.ts`, `packages/minidb/test/e2e/recovery-matrix.test.ts`).
- `node_modules/.pnpm` contains **no** `matrix-js-sdk`, no `@matrix-org/olm`,
  no `@matrix-org/matrix-sdk-crypto-wasm`.
- Useful TS precedents that DO exist: `marked@18.0.5` (`packages/pi-tui/package.json`),
  `markdown-it@14.2.0`, `dompurify@3.4.7` (all in `node_modules/.pnpm`); approval/permission
  service `packages/agent-core/src/services/approval/approval.ts`.

| Python dependency | TS equivalent | Evidence / design |
|---|---|---|
| `mautrix` (SDK: HTTPAPI, Client, sync, room state, media, events) | **`matrix-js-sdk`** (recommended) — official Matrix TS/JS client: `createClient`, `startClient` (sync), room/message/reaction events, `uploadContent`/`downloadContent`, E2EE crypto built in | **Not present in kimi-code** — must add as new npm dep (`npm i matrix-js-sdk`). Rationale: it is the ecosystem-standard client (Element uses it), covers sync/media/reactions/threads, and — critically — bundles E2EE (see next row), avoiding a from-scratch Matrix client-server protocol implementation |
| `mautrix[encryption]` / `python-olm` / `libolm` C lib + `asyncpg`/`aiosqlite` crypto store | matrix-js-sdk crypto: modern **`@matrix-org/matrix-sdk-crypto-wasm`** (matrix-rust-sdk bindings, WASM, no C lib) or legacy `@matrix-org/olm` (WASM olm) | kimi-code absent; recommended = `matrix-sdk-crypto-wasm` (matches Element's rust crypto; unpadded base64 keyids, cross-signing, recovery-key import are supported). **Big implication**: behavior parity with Python `OlmMachine`/`PgCryptoStore` must be re-verified against a real homeserver (see R2) |
| `mautrix.crypto.attachments.decrypt_attachment` | `@matrix-org/matrix-sdk-crypto-wasm` decrypt attachment helper (AES-256-CTR + SHA-256) | part of crypto WASM package; port `_handle_media_message` encrypted branch |
| `aiohttp` (+ `aiohttp_socks` for SOCKS) | Node `fetch`/`undici` + proxy (undici `ProxyAgent` / global-agent for HTTP(S); SOCKS via `socks-proxy-agent`) | kimi-code: `apps/kimi-code` uses `fetch` heavily; proxy precedent exists in `packages/kap-server` / `src/services` |
| `Markdown` (Python lib) + `html.parser` sanitizer | `marked`/`markdown-it` + **DOMPurify** (`isomorphic-dompurify`) for the allowlist sanitizer port | kimi-code evidence: `marked@18.0.5` (pi-tui), `markdown-it@14.2.0`, `dompurify@3.4.7` in `node_modules/.pnpm`. Keep `_MatrixHtmlSanitizer` tag/attr allowlist (416–491) as a DOMPurify config |
| `orjson` | built-in `JSON` | — |
| `ffmpeg` / `ffprobe` (voice transcode + duration/waveform) | `ffmpeg-static` + `child_process`, or Tauri Rust sidecar (`src/commands/`) | kimi-code: `apps/kimi-code/src/native` child-process precedent; Desktop already has Rust commands for subprocess/media |
| `asyncio` tasks/locks (sync loop, batch debounce, prompt expiry) | single-thread async Promise loops + timers | kimi-code: `packages/agent-core` async patterns; simpler in single-threaded JS |
| gateway approval plumbing (`tools.approval.resolve_gateway_approval`) | `packages/agent-core/src/services/approval/approval.ts` + gateway-core `ApprovalBroker` (messaging-gateway-core §3) | kimi-code has approval service; reaction transport is Matrix-private (approvals.ts) |
| `agent.secret_scope.get_secret` (recovery-key scope) | env/config scope provider in gateway-core (per-profile secrets) | Python-specific multiplex; TS in-process equivalent is the desktop's profile/secret store; keep `MATRIX_RECOVERY_KEY` scope semantics |

**Recommendation summary:** adopt `matrix-js-sdk` (+ `@matrix-org/matrix-sdk-crypto-wasm` for E2EE)
if a future in-process port happens; everything else maps to kimi-code-proven libs or thin shims.

**"No TS equivalent found" risk list (details in §9):**
1. **matrix-js-sdk is absent from kimi-code** — no in-repo proof; must add new npm dependency and
   validate its sync/event model against mautrix behavior.
2. **E2EE crypto semantics differ** (rust/WASM crypto store vs mautrix SQLite pickle) — device-key
   verification, store reset, and xsign bootstrap are not drop-in parity.
3. **Reaction-based approval/picker machinery** is Hermes-private logic (prompt tracking, bot
   reaction cleanup, requester binding) — no library; must port from `_on_reaction`/`send_exec_approval`.
4. **MSC3245 voice metadata** (waveform bins, ffprobe duration) is Hermes-private; Ogg/Opus
   transcode depends on bundling ffmpeg.
5. **Recovery-key bootstrap** (`generate_recovery_key` + unpadded keyid assertion) needs re-proof
   against a real homeserver for the TS crypto stack.

## 6. Integration with existing Hermes-CN-Desktop frontend

Current state (no Matrix-specific UI, verified by reading):
- `web/src/routes/settings.tsx` — generic config editor; Matrix has **no dedicated card/route**
  (grep `matrix` in `web/src` only hits translations/assets/persona prompts). `MATRIX_*` env vars
  are already mapped: `web/src/lib/env-translations.ts` L299–314 (`MATRIX_HOMESERVER`,
  `MATRIX_ACCESS_TOKEN`, `MATRIX_USER_ID`, `MATRIX_ALLOWED_USERS`); `web/src/lib/config-translations.ts`
  L298–301 (`matrix.allowed_rooms`, `matrix.free_response_rooms`, `matrix.require_mention`).
- `web/src/routes/im-onboarding.tsx` + `web/src/lib/im-onboarding-diagnostics.ts` — **CN IM only**:
  `ImPlatform = "feishu" | "weixin"` (also dingtalk in onboarding routes); no Matrix onboarding and
  none is recommended — Matrix is gateway-side env config, so the generic env editor suffices.
- Generic messaging-platform surface already exists in protocol:
  `packages/protocol/src/hermes-api.ts` L127–160 (`MessagingPlatformInfo`,
  `MessagingPlatformsResponse`, `MessagingPlatformTestResponse`), backed by Core
  `hermes_cli/web_server.py` `GET /api/messaging/platforms` + `POST /api/messaging/platforms/{id}/test`
  — a future "检测连接" button for Matrix can reuse these without new protocol types.
- Rust side: no new Tauri commands needed for v1; `src/commands/ws_proxy.rs`, `src/commands/api_proxy.rs`,
  `src/commands/gateway.rs` are the WS-removal targets (see §7). A future in-process port would add
  at most a `matrix` sidecar / ffmpeg helper command.

## 7. Removing the WebSocket dependency (migration path)

Freeze the API surface the Desktop consumes today (Python `hermes_cli/web_server.py` → Desktop
`transport.ts`/`gateway-client.ts`):
- `GET /api/status` → `status.gateway_platforms.matrix` (connection state / error code) — consumed
  by `useStatus` in Settings debug cards;
- `GET /api/messaging/platforms` + `POST /api/messaging/platforms/matrix/test` — protocol schemas
  already exist (`hermes-api.ts` L127–160);
- `GET/POST /api/config` + env save/restart (`MATRIX_*`, `matrix.*`) — settings page already consumes.

Migration path:
1. **Today (Bridge)**: Desktop manages Matrix config through the generic env editor and reads
   platform state over REST/WS; the adapter runs only in the managed Python runtime. No change.
2. **WS removal impact on Matrix**: Matrix message traffic **never traverses the Desktop WS** — the
   Python gateway connects directly to the homeserver. WS removal only affects
   `gateway_platforms.matrix` status pushes; switch to REST polling (`useStatus` already has polling)
   or drop that display (follow messaging-gateway-core Phase A `GatewayServiceAdapter` façade).
3. **If the Desktop ever self-hosts the gateway (in-process TS agent)**: Matrix adapter would be
   ported (§3 design) using matrix-js-sdk, and `ws_proxy.rs`/`api_proxy.rs` forwarding would be
   deleted in favor of direct homeserver connection. Recorded as future work, not in the current
   Desktop roadmap.
4. **Recommendation**: keep Matrix gateway-side out of scope; WS removal affects only status
   display, not feature ownership.

## 8. Migration phases & task breakdown

- **Phase 0 — record decision (this plan)**: mark Matrix out of scope for desktop standalone;
  document TS design + matrix-js-sdk recommendation. No code.
- **Phase 1 — maintain status quo (Desktop side)**: keep `MATRIX_*` env save/restart and
  `gateway_platforms.matrix` status read working; if WS is removed first, add `useStatus` polling
  fallback via the messaging-gateway-core façade. Optionally add a "检测连接" button reusing
  `POST /api/messaging/platforms/matrix/test`.
- **Phase 2 (conditional future work) — TS client**: `packages/matrix-adapter/` with matrix-js-sdk:
  `client.ts`, `sync.ts`, `events.ts`, `config.ts`; parity vs `test_matrix.py` (connect/sync/
  mention/allowlist), `test_matrix_mention.py`, `test_matrix_dm_invite_recording.py`,
  `test_matrix_message_event_metadata.py`, `test_matrix_project_context_isolation.py`,
  `test_matrix_message_length.py`.
- **Phase 3 (conditional) — media/voice/approvals**: `media.ts`, `voice.ts` (ffmpeg transcode +
  MSC3245), `approvals.ts` (reaction exec approval/model/choice pickers); parity vs
  `test_matrix_voice.py`, `test_matrix_exec_approval.py`, `test_matrix_approval_reaction_fail_closed.py`,
  plus inbound encrypted-media decrypt tests.
- **Phase 4 (conditional) — E2EE / xsign bootstrap**: `crypto.ts` with
  `@matrix-org/matrix-sdk-crypto-wasm`; parity vs `test_matrix_recovery_key_scope.py` (scope
  semantics) and the docker-based `tests/e2e/matrix_xsign_bootstrap/` suite (unpadded keyids,
  second-startup skip, recovery-key precedence).
- Each phase ends with `pnpm test` / vitest full run to prevent regressions.

## 9. Risks & open questions

- **R1 — matrix-js-sdk absent from kimi-code (highest adoption risk)**: no in-repo TS evidence;
  must add a new npm dependency. Its event/sync model (client-side filtering, room state objects)
  differs from mautrix's handler-based dispatcher; inbound normalization in `events.ts` must be
  validated against `_on_room_message`/`_on_reaction` behavior with the Python test suite as the
  spec.
- **R2 — E2EE crypto semantics differ (highest technical risk)**: Python uses mautrix
  `OlmMachine` + SQLite `PgCryptoStore` (pickle keys, device-change reset, legacy-pickle
  migration); matrix-js-sdk crypto is IndexedDB-based rust/WASM or legacy olm. Device-key
  verification (`_verify_device_keys_on_server`), store reset (`_reset_crypto_store_if_device_changed`),
  and stale-one-time-key refusal must be re-proven against a real homeserver; the
  `matrix_xsign_bootstrap` E2E is the parity gate.
- **R3 — reaction-based approval machinery is private logic**: prompt registry, bot-reaction
  cleanup, requester binding (`MATRIX_APPROVAL_REQUIRE_SENDER`), expiry/redaction, and
  `!approve`/`!deny` text aliases are Hermes-specific; no library exists. Must port
  `send_exec_approval`/`_on_reaction` exactly and keep fail-closed reactor validation.
- **R4 — voice pipeline depends on ffmpeg/ffprobe**: Ogg/Opus transcode and waveform/duration
  metadata need bundled ffmpeg (Tauri sidecar) or graceful degradation (send original file) to
  match Python behavior; waveform bins (`_MATRIX_VOICE_WAVEFORM_BINS = 30`) must match exactly for
  client rendering parity.
- **R5 — recovery-key secret scope is Python-gateway-specific**: `_scoped_recovery_key` relies on
  `agent.secret_scope` multiplex semantics (#69090). If ported, TS must reproduce scope behavior
  (per-profile secrets) or document that single-profile desktop doesn't need it; the Python tests
  (`test_matrix_recovery_key_scope.py`) define the required semantics.
- **R6 — 7×24 bot presence vs desktop standalone**: a Matrix bot must stay connected around the
  clock to answer; that conflicts with the desktop's interactive-local-agent positioning — the core
  reason Matrix stays gateway-side.
- **Open Q1**: add a Matrix "仅配置管理" card in Settings (homeserver + token + allowed users +
  detect connection) or keep the generic env editor? Recommendation: generic editor + optional
  test button (reuses existing protocol types).
- **Open Q2**: after WS removal, what polling interval/degradation for `gateway_platforms.matrix`
  status? (Follow messaging-gateway-core decision.)
- **Open Q3**: for a future port, rust crypto (`matrix-sdk-crypto-wasm`) vs legacy olm — recommend
  rust crypto (matches Element), but it changes WASM packaging for Tauri; confirm before Phase 4.

## 10. Test strategy

Python parity sources (all verified present):
- `tests/gateway/test_matrix.py` (3,349 lines) — fake-mautrix adapter harness; connect/sync/
  message/reaction/format/mention/send/approval coverage (largest parity source).
- `tests/gateway/test_matrix_voice.py` (266 lines) — MSC3245 inbound detection → local path,
  cache-failure HTTP fallback, `send_voice` non-Ogg→Ogg/Opus transcode + cleanup + content fields.
- `tests/gateway/test_matrix_exec_approval.py` (38 lines) — reaction resolves pending approval via
  `resolve_gateway_approval("sess-1", "once")`, prompt registry cleanup.
- `tests/gateway/test_matrix_recovery_key_scope.py` (79 lines) — `_scoped_recovery_key` under
  multiplex active/inactive, scoped miss ⇒ empty, whitespace strip.
- Other `test_matrix_*.py`: `test_matrix_approval_reaction_fail_closed.py`,
  `test_matrix_dm_invite_recording.py`, `test_matrix_mention.py`,
  `test_matrix_message_event_metadata.py`, `test_matrix_message_length.py`,
  `test_matrix_plugin_setup.py`, `test_matrix_project_context_isolation.py`.
- `tests/e2e/matrix_xsign_bootstrap/` — docker Continuwuity homeserver on 127.0.0.1:26167;
  asserts (a) unpadded base64 keyids after bootstrap, (b) second startup skips bootstrap,
  (c) `MATRIX_RECOVERY_KEY` path takes precedence.

TS strategy:
- **vitest unit**: port each helper with parity assertions — `formatting.ts` vs `format_message`/
  `_sanitize_matrix_html`/`_extract_reply_fallback`; `voice.ts` vs `test_matrix_voice.py`;
  `approvals.ts` vs `test_matrix_exec_approval.py` + fail-closed test; `crypto.ts` scope helper vs
  `test_matrix_recovery_key_scope.py`.
- **integration**: mock matrix-js-sdk client to replay Python's fake-mautrix event shapes
  (`test_matrix.py` fixtures) and assert normalized `MessageEvent` parity.
- **Playwright E2E**: only if a Settings "detect connection" UI is added — mock
  `/api/messaging/platforms/matrix/test` responses; the bot itself is not testable in the Desktop.
- **real-homeserver parity**: reuse `tests/e2e/matrix_xsign_bootstrap/docker-compose.yml` flow for
  the TS crypto stack (Phase 4), asserting the same three invariants.

## 11. Reference links

- Python source: `D:/hermes-agent-cn/plugins/platforms/matrix/adapter.py`,
  `D:/hermes-agent-cn/plugins/platforms/matrix/__init__.py`,
  `D:/hermes-agent-cn/plugins/platforms/matrix/plugin.yaml`
- Docs: `D:/hermes-agent-cn/website/docs/user-guide/messaging/matrix.md`
- Tests: `D:/hermes-agent-cn/tests/gateway/test_matrix*.py` (11 files),
  `D:/hermes-agent-cn/tests/e2e/matrix_xsign_bootstrap/`
- Shared gateway design: `D:/Hermes-CN-Desktop/plans/messaging-gateway-core.md`;
  sibling decisions: `plans/signal-platform.md`, `plans/telegram-platform.md`,
  `plans/discord-platform.md`, `plans/slack-platform.md`
- Desktop integration: `D:/Hermes-CN-Desktop/web/src/routes/settings.tsx`,
  `web/src/lib/env-translations.ts` (L299–314), `web/src/lib/config-translations.ts` (L298–301),
  `web/src/routes/im-onboarding.tsx`, `web/src/lib/im-onboarding-diagnostics.ts`,
  `packages/protocol/src/hermes-api.ts` (L127–160)
- TS reference (kimi-code): `packages/pi-tui/package.json` (marked), `node_modules/.pnpm`
  (markdown-it, dompurify), `packages/agent-core/src/services/approval/approval.ts`; verified
  **absent**: `matrix-js-sdk`, `@matrix-org/*` (olm / matrix-sdk-crypto-wasm)
- Ecosystem (recommended, not in kimi-code): `matrix-js-sdk` (npm),
  `@matrix-org/matrix-sdk-crypto-wasm` / `@matrix-org/olm`
