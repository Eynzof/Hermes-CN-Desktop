# Buzz (Nostr) Messaging Platform Adapter — Python → TypeScript Rewrite Plan

> Port decision recorded up front: **Buzz is a gateway-side messaging platform adapter and is marked
> "out of scope for desktop standalone"** (per `plans/README.md`). The desktop keeps talking to the
> Core managed-runtime gateway over REST (`/api/messaging/platforms`, `/api/env`) and WS (`/api/ws`)
> and does **not** host the Buzz bot in-process in v1. This file still designs the in-process TS port
> (Sections 3–10) so the decision is recorded and a future standalone build can pick it up. Feature
> scope: Buzz (Block's Nostr-based human+agent platform) channel/DM relay — Nostr client bot
> (outbound via `buzz` CLI) + NIP-42-authenticated Nostr WebSocket subscription (inbound, with CLI
> polling fallback).

## 1. Summary

The Buzz adapter (`D:/hermes-agent-cn/plugins/platforms/buzz/`, ~1.8k lines) connects Hermes to a
[Buzz](https://github.com/block/buzz) community relay — Block's open-source human+agent collaboration
platform built on the Nostr protocol — and relays messages between Buzz channels / DMs and the agent.
It does **not** speak Nostr itself for outbound: it shells out to the `buzz` CLI binary ("JSON in,
JSON out") via `asyncio.create_subprocess_exec`, passing the nsec only through the subprocess
environment. Inbound uses a **NIP-42-authenticated persistent Nostr WebSocket subscription** (kind-9
chat events filtered by channel `#h` tag, plus kind-44100 membership events for live DM discovery)
with automatic fallback to CLI polling (`buzz messages get`) when the WS cannot be established
(`BUZZ_TRANSPORT=auto|websocket|poll`). No extra Python packages are required — the crypto for NIP-42
(`nostr_auth.py`: bech32 nsec decode + pure-stdlib BIP-340 secp256k1 Schnorr signing) is implemented
from scratch.

Key findings:
- **kimi-code has no Buzz/Nostr equivalent** — verified: repo-wide grep for `nostr|buzz|websocket-pool|nostr-tools`
  returns only one minified `dist-web` asset containing the unrelated token `nostrip` (false positive);
  `node_modules` contains **no** `nostr-tools`, no `websocket-pool`, and no `@noble/*`. See §5 risk.
- The de-facto TS Nostr SDK is **`nostr-tools`** (event building/signing/verification, NIP-19 bech32,
  `SimplePool`/`Relay`, pluggable WebSocket implementation); combined with **`ws`** (already used by
  kimi-code's `packages/kap-server`) or the Tauri webview's native WebSocket, it maps 1:1 onto the
  Python adapter's WS transport. Recommended with rationale in §5.
- **Port decision (recorded):** Buzz stays in the managed Python runtime for v1; the desktop surfaces
  config/status through the existing settings debug card and env-var translation layer. §7 records the
  WS-removal implications: the **Nostr inbound WS** is a platform requirement and is *not* the
  Dashboard `/api/ws` JSON-RPC link that this rewrite program removes.

## 2. Current Python implementation

Source of truth: `D:/hermes-agent-cn`

| Path | Role |
|---|---|
| `plugins/platforms/buzz/plugin.yaml` (59 lines) | Plugin manifest: `name: buzz-platform`, requires `BUZZ_RELAY_URL` + `BUZZ_PRIVATE_KEY` (secret); optional `BUZZ_TRANSPORT`, `BUZZ_AUTH_TAG`, `BUZZ_CHANNELS`, `BUZZ_HOME_CHANNEL`, `BUZZ_ALLOWED_USERS`, `BUZZ_ALLOW_ALL_USERS`, `BUZZ_POLL_INTERVAL`, `BUZZ_CLI_PATH`, `BUZZ_CREDENTIALS_FILE` |
| `plugins/platforms/buzz/__init__.py` (3 lines) | Exposes `register` |
| `plugins/platforms/buzz/adapter.py` (1528 lines) | `BuzzAdapter(BasePlatformAdapter)` — everything: config precedence, CLI plumbing, connect/disconnect, send/send_image/send_reaction, WS transport, poll loop, DM classification, mention gating, plugin registration |
| `plugins/platforms/buzz/nostr_auth.py` (230 lines) | Dependency-free Nostr signing: bech32 nsec decode, secp256k1 point ops, BIP-340 Schnorr sign, `build_auth_event` (kind 22242 + optional NIP-OA `auth` tag from `BUZZ_AUTH_TAG`) |
| `website/docs/user-guide/messaging/buzz.md` (123 lines) | Setup, env table, defaults (`interim_assistant_messages:false`, `tool_progress:off`), mentions/channels/DMs, access control, notes/limitations |
| `tests/gateway/test_buzz_adapter.py` (540 lines) | bech32 helpers, init/config precedence, CLI error contract, seeding/dedupe, mention gating, DM classification (#68871), send, lifecycle/lock, credentials, registration/standalone send |
| `tests/gateway/test_buzz_websocket.py` (121 lines) | BIP-340 vector 0, key decode rejection, auth-event shape + NIP-OA tag, WS handshake replay (AUTH → OK) / rejection |
| `features_report.md` (line 143) | Feature inventory: `Buzz (Nostr)` → `messaging/buzz.md`, `plugins/platforms/buzz/`, the two test files |

Key implementation blocks inside `adapter.py` (line refs verified by reading):

- **Config precedence** (`__init__` 357–438): env overrides `config.yaml` `gateway.platforms.buzz.extra`;
  `BUZZ_TRANSPORT` in `auto|websocket|poll` (default `auto`); `require_mention` default true;
  `_resolve_cli_path` order: explicit → PATH → `~/bin/buzz`; `_resolve_private_key` (246–275):
  `BUZZ_PRIVATE_KEY` env (scope-aware) → credentials JSON (`nsec`/`private_key_hex`/`private_key`).
- **CLI contract** (`_exec_buzz` 278–317): `asyncio.create_subprocess_exec` with `env["BUZZ_RELAY_URL"]`
  and `env["BUZZ_PRIVATE_KEY"]` — the key **never appears in argv**; 30s timeout; stderr JSON error
  contract `{"error","message"}` (`_cli_error_message` 320–333).
- **Connect lifecycle** (459–568): validate relay/cli/key → `buzz users get` (own pubkey/display name,
  drives self-echo suppression + mention gate) → scoped identity lock `buzz:{relay}:{pubkey}`
  (`gateway/status.acquire_scoped_lock`, prevents duplicate replies) → `buzz channels list` → seed
  high-water marks from newest events (`_seed_channel` 921–946, **never replays history**) →
  `_discover_dms` (948–987) → start WS (`transport auto|websocket`) or poll loop.
- **Inbound WS transport** (729–899): `_websocket_url` maps http(s)→ws(s); `_start_websocket` probes
  `import websockets`; `_authenticate_websocket` (763–791) waits for the relay `AUTH` challenge,
  answers with a signed kind-22242 event (+ optional NIP-OA tag), waits for `OK`; `_subscribe_websocket`
  (803–823) sends one `REQ` per watched channel (`{"kinds":[9],"#h":[channel],"since":last_ts-1}`) plus
  membership sub `{"kinds":[44100],"#p":[self_pubkey]}`; `_websocket_loop` (839–899) has bounded
  reconnect backoff (1→30s), ping/keepalive, `max_size=2MB`, routes every event through `_handle_event`
  — identical semantics to the poll path.
- **Inbound polling** (903–1006): every `poll_interval` (default 4s, min 1s) → `buzz messages get
  --channel <id> --limit 50 [--since last_ts]`; DM discovery every 5 sweeps.
- **Dispatch pipeline** (`_handle_event` 1008–1059): de-dupe by event id (per-channel `seen` set,
  cap 500), only kind 9, skip self-echo by pubkey, DM re-classification (`_maybe_latch_dm` /
  `_is_direct_message_event` 1102–1137, issue #68871: DMs p-tag us without a visible mention; real
  channels never do), mention gate in channels (`_is_mentioned` 1139–1150: display name / npub / hex),
  adapter allow-list, `_strip_mention` (1152–1177, leading @-mention), then `_dispatch_message`
  (1213–1251) builds `MessageEvent` and posts a 👀 reaction.
- **Outbound** (`send` 602–635, `send_image` 667–703, `send_reaction` 641–665): `buzz messages send
  --channel <id> --content -` (stdin, never argv), `--reply-to <event_id>` for threading, `--file` for
  local images (URLs become markdown links); marks own event id seen for echo suppression.
- **Registration** (1487–1528): `register_platform(name="buzz", ..., required_env=[BUZZ_RELAY_URL,
  BUZZ_PRIVATE_KEY], cron_deliver_env_var="BUZZ_HOME_CHANNEL", standalone_sender_fn=_standalone_send,
  allowed_users_env/allow_all_env, emoji="🐝", platform_hint=...)`; `_apply_yaml_config` (1276–1319)
  bridges `config.yaml` extra → `BUZZ_*` env (env wins); `_env_enablement` (1322–1356) seeds
  `PlatformConfig.extra` for env-only setups; `interactive_setup` (1410–1484) is the `hermes gateway
  setup` wizard.

Docs behaviors to port alongside (`website/docs/user-guide/messaging/buzz.md`): full env table
(lines 45–58), recommended display defaults (59–96), mention/channel/DM semantics (98–102), access
control (104–108), home-channel cron delivery (108), poll-latency note + WS future (118–120),
re-seed-on-connect (121).

## 3. Target TypeScript design

Recommended module layout (new `packages/buzz` inside the desktop monorepo; used by `web/src` via the
existing `@hermes/*` workspace alias convention):

```
packages/buzz/src/
  types.ts        # BuzzSettings, BuzzChannelState, BuzzEvent, BuzzSendResult, GatewayPlatformAdapter interface
  config.ts       # loadConfig(env, extra) -> BuzzSettings (mirror __init__ 357-438 precedence)
  bech32.ts       # npub<->hex, nsec decode, normalizeUserRef (port of adapter.py 142-225 + nostr_auth.py 39-69)
  nostr.ts        # BIP-340 schnorr signing + buildAuthEvent (port of nostr_auth.py 72-230)
  relayClient.ts  # NIP-42 WS subscription + bounded reconnect + REQ/EVENT/CLOSED/NOTICE handling (port 729-899)
  poller.ts       # poll sweep + DM discovery + high-water seeding (port 903-1006, 948-987)
  buzzCli.ts      # child-process wrapper over `buzz` binary (JSON contract; key via env only) (port 278-333)
  dispatch.ts     # dedupe / self-echo / DM latch / mention gate / allow-list / strip mention (port 1008-1177)
  adapter.ts      # BuzzAdapter implements GatewayPlatformAdapter (connect/disconnect/send/sendImage/sendReaction/status)
  registry.ts     # registerAdapter(registry) — analogue of register()
  index.ts
```

Core interfaces (signatures only):

```ts
interface BuzzSettings {
  relayUrl: string;            // BUZZ_RELAY_URL | extra.relay_url
  privateKey: string;          // BUZZ_PRIVATE_KEY | credentials file (NEVER logged/argv)
  channels: string[];          // BUZZ_CHANNELS | extra.channels (empty = all joined)
  homeChannel: string;         // BUZZ_HOME_CHANNEL | extra.home_channel
  pollInterval: number;        // default 4, min 1
  transport: "auto" | "websocket" | "poll";
  requireMention: boolean;     // default true
  allowAllUsers: boolean;
  allowedPubkeys: Set<string>; // npub/hex normalized to hex
  authTagJson: string;         // BUZZ_AUTH_TAG (NIP-OA owner attestation)
  cliPath: string;             // resolved: config -> PATH -> ~/bin/buzz
}

interface ChannelState { chatType: "group" | "dm"; lastTs: number; seen: Map<string, null>; } // cap 500

interface GatewayPlatformAdapter {
  connect(opts?: { isReconnect?: boolean }): Promise<boolean>;
  disconnect(): Promise<void>;
  send(target: SendTarget, content: string, replyTo?: string): Promise<SendResult>;
  sendImage(target: SendTarget, imageUrl: string, caption?: string, replyTo?: string): Promise<SendResult>;
  sendReaction(chatId: string, messageId: string, emoji: string): Promise<boolean>;
  getChatInfo(chatId: string): Promise<{ name: string; type: string; chatId: string }>;
}
```

Data flow (in-process, no Python backend):

```
Buzz relay --NIP-42 WS (kind 9 / #h / kind 44100 / #p)--> relayClient.ts --EVENT-->
  dispatch.ts (dedupe by id, self-echo, DM latch, mention gate, allow-list, strip mention)
  --> MessageEvent --> gateway pipeline (in-process agent loop) --> send() via buzzCli.ts (or native Nostr publish, see §5)
```

The `buzz` CLI binary requirement stays for outbound (exact JSON contract parity with Python); inbound
can be fully native TS via `nostr-tools` + `ws`, mirroring the Python WS transport — no CLI needed for
inbound when WS is healthy, with `poller.ts` as fallback when `transport=auto`/`poll`.

## 4. Data models & persistence

Python keeps **all** runtime state in memory (no SQLite/JSON files): per-channel
`{chat_type, last_ts, seen: OrderedDict capped 500}`, `_channel_names`, `_channel_meta`, `_user_names`
(negative-cached), `_self_pubkey/_self_npub/_display_name`. On (re)connect the high-water marks are
**re-seeded from the newest events** so history is never replayed — no durable cursor needed.

TS parity recommendation:
- Keep the same in-memory model (`Map<channelId, ChannelState>`, `Map<pubkey, name>` cache with
  negative caching) for v1 — this preserves the exact de-dupe/seed semantics and needs **no schema
  migration**.
- Optional future durability (only if the in-process adapter runs across restarts without re-seed):
  one SQLite table `buzz_channel_state(channel_id TEXT PRIMARY KEY, chat_type TEXT, last_ts INTEGER,
  seen_json TEXT)` using the existing `packages/minidb` (kimi-code evidence: `packages/minidb` is the
  monorepo's embedded DB engine) or Rust-side SQLite (per plans README, SQLite is a permitted Rust
  capability). Mark this as an open question — Python parity says re-seed, so persistence is a
  deviation that must be opt-in.
- Credentials: nsec stays in the profile `.env` / OS secret store, **never** in SQLite/IndexedDB;
  mirror `_resolve_private_key` precedence (env → credentials JSON) in `config.ts`.

## 5. Third-party library strategy

Most important section. Evidence from `D:/kimi-code`:

| Python dependency | TS equivalent | kimi-code evidence |
|---|---|---|
| `websockets` (bundled, WS client) | **`ws`** (client mode) or native `WebSocket` in the Tauri webview; `nostr-tools`' `useWebSocketImplementation` can plug either in | `packages/kap-server/package.json` depends on `"ws": "^8.18.0"`; pnpm store contains `ws@8.20.0`. kimi-code uses it server-side in `packages/kap-server/src/transport/ws/v1/registerWsV1.ts` / `wsConnectionV1.ts`. Also present in store: `undici@7.27.1` (not needed — a pool is not required, see below). |
| `nostr_auth.py` — pure-stdlib BIP-340 secp256k1 Schnorr + bech32 nsec | **`nostr-tools`** (`generateSecretKey`, `getPublicKey`, `finalizeEvent`, `verifyEvent`, `nip19.decode/encode`) — it bundles `@noble/curves` secp256k1 (`schnorr.sign/getPublicKey`) and `@noble/hashes` | **ABSENT in kimi-code** (verified: no `node_modules/nostr-tools`, no `node_modules/@noble/curves`, no `@noble/hashes`; package.json grep for `nostr-tools|websocket-pool` returns nothing). Fallback if `nostr-tools`' NIP-42 `AUTH` support is insufficient for the Buzz relay: port `nostr_auth.py` directly against `@noble/curves/secp256k1` `schnorr` — the API is stable and matches the BIP-340 vector already in `tests/gateway/test_buzz_websocket.py`. |
| bech32 helpers (`npub`/`nsec`, in adapter.py + nostr_auth.py) | `nostr-tools` `nip19` (`npubEncode`/`npubDecode`/`nsecDecode`) — same BIP-173 scheme | Absent in kimi-code (no `nostr-tools`). Pure algorithm; trivially portable as `bech32.ts` if we avoid the dependency. |
| `asyncio.create_subprocess_exec` (buzz CLI shell-out) | Rust Tauri command (e.g. `src/commands/buzz_cli.rs`) spawning the child with `BUZZ_RELAY_URL`/`BUZZ_PRIVATE_KEY` in the env; or Node `child_process.spawn` if the adapter ever runs in a Node runtime | plans README: Rust stays for OS-level capabilities incl. **child processes** (invoked via Tauri IPC). kimi-code native layer (`apps/kimi-code/src/native`) shows the pattern for pty/child-process management. |
| `urllib.parse` (`http`→`ws` URL mapping) | native `new URL()` + tiny scheme map (trivial, no dependency) | n/a (stdlib equivalence in TS). |
| `websockets` availability probe (`import websockets`) | `import('ws')` / `typeof WebSocket` feature probe in `relayClient.ts` | kimi-code uses `ws` in kap-server; no probe pattern needed — just lazy-import. |

Recommendation & rationale:
- **Use `nostr-tools`** as the Nostr layer: it is the de-facto TS Nostr SDK (event finalization,
  NIP-19, NIP-04/44, `SimplePool`/`Relay`, pluggable WebSocket via `useWebSocketImplementation`),
  which removes ~230 lines of hand-rolled secp256k1 crypto and gives us verified BIP-340 signing out
  of the box. **Risk:** the Buzz relay is a *community* relay — inbound REQ filtering (`#h` channel
  tags, kind 44100 membership discovery) and NIP-42 auth (plus the NIP-OA `BUZZ_AUTH_TAG` 4-string
  tag) are relay-specific; `nostr-tools` covers standard NIP-42, but the exact Buzz handshake and
  auth-event tag shape must be verified against the live relay before committing. Mitigation: keep
  `nostr.ts` as a thin, isolated module so it can be swapped for a direct `@noble/curves` port of
  `nostr_auth.py` without touching the adapter.
- **No "websocket-pool" is needed**: the Python adapter uses one persistent authenticated socket with
  bounded reconnect backoff — not a pool. kimi-code has no `websocket-pool` package (verified absent),
  and `undici`'s pool is for HTTP, not applicable. Do **not** invent a pool abstraction; a single
  `RelayConnection` with reconnect backoff (1→30s) is the parity behavior.
- **Keep the `buzz` CLI for outbound**: kind-9 posting to a Buzz community relay depends on
  community-membership semantics that the CLI encapsulates (NIP-OA owner attestation etc.).
  Reverse-engineering native outbound is a larger, separate effort — flag as an open question (§9).

## 6. Integration with existing Hermes-CN-Desktop frontend

Desktop is currently an observer of Buzz (gateway-side), and v1 keeps it that way:

- **`web/src/routes/settings.tsx`** — the Dashboard/Gateway debug card (lines 1478–1488) already
  renders `status.gateway_platforms[name]` generically, so `gateway_platforms.buzz` (state /
  error_message) shows up automatically once the managed runtime reports it. No code change needed for
  v1; optionally add a platform label map ("Buzz" / 🐝).
- **`web/src/lib/env-translations.ts`** — add Chinese labels for the `BUZZ_*` env vars (currently
  **absent** — verified: no `BUZZ_` keys exist). Add to the `messaging` category:
  `BUZZ_RELAY_URL` (必填), `BUZZ_PRIVATE_KEY` (secret, redacted), `BUZZ_TRANSPORT`,
  `BUZZ_AUTH_TAG`, `BUZZ_CHANNELS`, `BUZZ_HOME_CHANNEL`, `BUZZ_ALLOWED_USERS`, `BUZZ_ALLOW_ALL_USERS`,
  `BUZZ_REQUIRE_MENTION`, `BUZZ_POLL_INTERVAL`, `BUZZ_CLI_PATH`, `BUZZ_CREDENTIALS_FILE` — mirroring
  the `plugin.yaml` `optional_env` list. The `/models` env page and config-schema rendering pick these
  up through `EnvVarInfo`/`useConfigSchema` with no schema change.
- **`packages/protocol/src/channels.ts`** — `ImPlatform = "feishu" | "weixin"` (line 491) covers the
  QR-onboarding surface only. **Buzz onboarding is out of scope for `web/src/routes/im-onboarding.tsx`**
  (Feishu/Weixin/DingTalk QR flows) and `web/src/lib/im-onboarding-diagnostics.ts` (feishu/weixin
  issue heuristics). For Buzz v1: users configure via the env/config surface + the settings debug
  card; no QR flow. If a Buzz onboarding page is later wanted, `ImPlatform` and the diagnostics
  `Record<ImPlatform, ...>` maps would need a `"buzz"` entry — record as future work (§9).
- **Hooks/lib to reuse (future in-process port)**: `useStatus`, `useConfig`/`useSaveConfig`,
  `useMessagingPlatform`/`useTestMessagingPlatform` (`web/src/hooks/use-im-onboarding.ts`,
  `web/src/hooks/use-config.ts`), `web/src/lib/transport.ts` (HTTP routing + auth),
  `web/src/lib/gateway-client.ts` (WS JSON-RPC, `/api/ws`), `web/src/lib/tauri-bridge.ts` (Rust IPC
  shim), `web/src/lib/gateway-relay-socket.ts` (WS-compatible shim over Rust `/api/ws` relay,
  `src/commands/ws_proxy.rs`).
- **Rust side**: v1 requires no new commands. If the in-process port happens, add `src/commands/buzz*`
  (spawn `buzz` CLI with key in env) following the existing 60-command pattern; the webview would then
  call those through `tauri-bridge.ts` instead of REST/WS.

## 7. Removing the WebSocket dependency (migration path)

Two distinct "WebSockets" must not be confused:

1. **Dashboard WS link** (`/api/ws` JSON-RPC in `web/src/lib/gateway-client.ts`; Rust relay in
   `src/commands/ws_proxy.rs` / `web/src/lib/gateway-relay-socket.ts`) — the webview ↔ managed Python
   runtime link this rewrite program removes.
2. **Nostr inbound WS** — the adapter's NIP-42-authenticated subscription to the Buzz relay. This is a
   **platform requirement** (near-zero-latency inbound), not removable; `transport=poll` is the only
   alternative and carries up to one poll-interval of latency. The TS design's `relayClient.ts` runs
   this socket wherever the adapter runs.

Current state: the Buzz message plane runs inside the managed Python runtime; the webview learns about
it through the Dashboard WS (status `gateway_platforms.buzz`) and REST (`/api/messaging/platforms`,
`/api/env`).

**Port decision + implications:**
- Near term (recommended): Buzz remains a managed-runtime messaging adapter (permitted "out of scope
  for desktop standalone"); the Dashboard WS link must therefore **stay for messaging status** as long
  as Feishu/Weixin/Buzz ship in the desktop. Removing `/api/ws` entirely requires one of:
  (a) dropping messaging platforms from standalone, (b) porting adapters in-process (this plan's §3
  design), or (c) keeping a minimal managed runtime purely for messaging.
- If/when the in-process port happens: freeze the protocol surface first —
  `StatusResponse.gateway_platforms["buzz"]` (`{state, error_code, error_message, updated_at}`),
  `MessagingPlatformInfo` (`enabled/configured/gateway_running/state/home_channel/env_vars`),
  `/api/messaging/platforms` catalog entry, `/api/env` `BUZZ_*` keys, and the
  `gateway.platforms.buzz.extra` config block. Then run `BuzzAdapter` in-process behind an adapter
  registry (same interface), flip the settings/env hooks to Tauri IPC, and delete the Buzz REST/WS
  paths in `transport.ts`/`gateway-client.ts`. Buzz's own outbound WS (Nostr) then runs wherever the
  TS adapter runs (see §9 for the Tauri webview constraint).

## 8. Migration phases & task breakdown

- **Phase 0 — decision record (this plan):** No code. Confirm Buzz stays in the managed Python
  runtime; document WS-removal implications in §7.
- **Phase 1 — TS groundwork (recommended now):** add `nostr-tools` (and `ws` if needed) to the
  monorepo as planned dependencies; create `packages/buzz` skeleton with `types.ts`, `config.ts`,
  `bech32.ts` pure helpers and vitest parity tests (npub/hex known pair, nsec decode, BIP-340 vector 0,
  auth-event shape). Add `BUZZ_*` Chinese labels to `web/src/lib/env-translations.ts`. No behavior
  change in the running product.
- **Phase 2 — in-process adapter (optional, gated by product decision):**
  1. `nostr.ts` signing + `relayClient.ts` WS (NIP-42 auth, REQ subs, reconnect backoff) — parity with
     `test_buzz_websocket.py` (AUTH→OK replay, rejection raises).
  2. `poller.ts` + `buzzCli.ts` (Rust `spawn` command or Node child_process; key via env only) —
     parity with `test_buzz_adapter.py` seeding/dedupe/poll classes.
  3. `dispatch.ts` mention gating, allow-list, DM latch (#68871), strip-mention — parity with
     `TestMentionGating`, `TestDmClassification`.
  4. `adapter.ts` connect/disconnect/send/sendImage/sendReaction + scoped identity lock — parity with
     `TestBuzzAdapterSend`, `TestBuzzAdapterLifecycle`.
  5. `registry.ts` + cron `standalone_send` parity (`test_standalone_send_success`, key never in argv).
- **Phase 3 — swap & delete:** wire `BuzzAdapter` into the Tauri IPC surface, freeze protocol types,
  flip settings/env hooks to IPC, delete Buzz REST/WS paths in `transport.ts`/`gateway-client.ts`.

Out of scope for the port (record, do not port now): `interactive_setup` CLI wizard (`hermes gateway
setup`), Buzz QR onboarding page (not part of `im-onboarding.tsx`), native Nostr outbound (keep `buzz`
CLI), doc-comment/other Buzz subsystems (none exist in this plugin).

## 9. Risks & open questions

- **No TS equivalent in kimi-code (main risk):** Buzz must be one of the first platform adapters added
  to the TS monorepo; `nostr-tools` is a **new dependency** (license/version pin decision needed).
  Verified: kimi-code has no `nostr-tools`, no `websocket-pool`, no `@noble/*` in node_modules; the
  only grep hit was a minified `nostrip` token. The fallback is a from-scratch `nostr.ts` port of
  `nostr_auth.py` against `@noble/curves` — same crypto, more maintenance.
- **Buzz relay NIP-42 handshake + NIP-OA tag:** `nostr-tools`' built-in NIP-42 auth may not cover the
  Buzz relay's exact challenge/OK flow or the 4-string `auth` tag (`BUZZ_AUTH_TAG`). Must be verified
  against a live relay; keep `nostr.ts` isolated so it can be swapped.
- **Tauri webview vs Node `ws`:** a webview's native `WebSocket` may lack `max_size` limits,
  ping/keepalive, and reconnect ergonomics the Python `websockets` transport has; `ws` under a Node
  runtime or the Rust WS relay (`gateway-relay-socket.ts` pattern) may be required for the in-process
  port. Open question: where does the in-process adapter run (webview vs Rust vs Node sidecar)?
- **`buzz` CLI dependency remains for outbound:** kind-9 posting to a community relay depends on
  community-membership/NIP-OA semantics the CLI encapsulates; native outbound via `nostr-tools` is a
  bigger effort (recorded, not planned). Desktop therefore still needs the binary (or a Rust/TS
  reimplementation of the CLI's posting path).
- **DM classification heuristics (#68871) are relay-behavior-specific** (p-tag-without-mention = DM;
  name "DM" + empty description = DM-shaped; real channel metadata never reclassifies). Port exactly;
  a relay change can regress it — keep the Python tests as the parity oracle.
- **Secret hygiene:** nsec must never appear in argv, logs, or persisted state; only the subprocess
  environment (Rust `spawn` env) or the signer module should hold it. Desktop env-var translation must
  mark `BUZZ_PRIVATE_KEY` secret/redacted.
- **Open questions:** Should `buzz_channel_state` be persisted (deviation from re-seed parity)? Should
  a Buzz onboarding page be added later (requires `ImPlatform = "feishu" | "weixin" | "buzz"` +
  diagnostics maps)? Does Core expose a Buzz test endpoint for `useTestMessagingPlatform` parity?

## 10. Test strategy

- **Vitest unit (parity with Python):**
  - `bech32.ts`: `hex_to_npub`/`npub_to_hex` known pair (`test_hex_to_npub_known_pair`,
    `test_npub_to_hex_known_pair`), `_normalize_user_ref` forms.
  - `nostr.ts`: BIP-340 test vector 0 (`test_schnorr_sign_matches_official_bip340_vector_zero`),
    key decode rejection (`test_decode_private_key_rejects_bad_input`), auth-event shape + NIP-OA tag
    (`test_build_auth_event_shape_and_owner_tag`).
  - `relayClient.ts`: fake-socket handshake replay — `AUTH` challenge → signed reply → `OK` accepted /
    `OK` rejected raises (`test_websocket_auth_raises_on_rejection`, `_FakeWebSocket` pattern); EVENT /
    CLOSED / NOTICE handling; reconnect backoff bounds (fake timers).
  - `dispatch.ts`/`poller.ts`: seeding sets high-water mark without dispatch; new event dispatched
    once; identical response de-duped; unaddressed channel ignored; name mention dispatched;
    allow-list blocks; DM latch + channel-stays-channel via p-tags; send-via-stdin (content never in
    argv) and `--file` image path (`TestBuzzAdapterSend`, `TestPollingDedupe`, `TestMentionGating`,
    `TestDmClassification`).
  - `config.ts`: env-overrides-config precedence; transport normalization; interval min clamp.
  - `buzzCli.ts`/standalone send: fake spawn captures env (key not in argv), JSON error contract
    parse, timeout path.
- **Integration:** against a mock Nostr relay (`ws` server in vitest) — full connect → auth → REQ →
  EVENT → dispatch → send roundtrip; `transport=websocket` fails connect when auth fails;
  `transport=auto` falls back to polling; `transport=poll` never opens a socket.
- **Playwright E2E (desktop):** settings debug card renders `gateway_platforms.buzz` state/error; env
  page shows `BUZZ_*` translations with `BUZZ_PRIVATE_KEY` redacted.
- **Parity gate:** every Python class in `tests/gateway/test_buzz_adapter.py` +
  `test_buzz_websocket.py` maps to a named vitest suite; run both until pass counts match.

## 11. Reference links

- `D:/hermes-agent-cn/plugins/platforms/buzz/adapter.py` (1528 lines) — adapter source of truth
- `D:/hermes-agent-cn/plugins/platforms/buzz/nostr_auth.py` (230 lines) — NIP-42/BIP-340 signing
- `D:/hermes-agent-cn/plugins/platforms/buzz/plugin.yaml` — env manifest
- `D:/hermes-agent-cn/website/docs/user-guide/messaging/buzz.md` — user docs
- `D:/hermes-agent-cn/tests/gateway/test_buzz_adapter.py` (540 lines), `test_buzz_websocket.py` (121 lines)
- `D:/hermes-agent-cn/features_report.md` — feature inventory line 143
- `D:/Hermes-CN-Desktop/plans/README.md`, `_PROMPT_TEMPLATE.md`, `_INDEX.md` (#96)
- `D:/Hermes-CN-Desktop/web/src/routes/settings.tsx` (debug card 1478–1488),
  `web/src/lib/env-translations.ts`, `web/src/lib/im-onboarding-diagnostics.ts`,
  `web/src/routes/im-onboarding.tsx`, `web/src/lib/transport.ts`, `web/src/lib/gateway-client.ts`,
  `web/src/lib/gateway-relay-socket.ts`, `web/src/lib/tauri-bridge.ts`
- `D:/Hermes-CN-Desktop/packages/protocol/src/channels.ts` (`ImPlatform` line 491)
- `D:/kimi-code/packages/kap-server/package.json` (`ws ^8.18.0`), `packages/kap-server/src/transport/ws/v1/`
- npm/GitHub: `nostr-tools` (https://github.com/nbd-wtf/nostr-tools), `@noble/curves`
  (https://github.com/paulmillr/noble-curves), Buzz (https://github.com/block/buzz)
