# IRC Messaging Platform Adapter — Python → TypeScript Rewrite Plan

> Feature: **IRC messaging platform adapter** — IRC bot via RFC 1459/2812, channels, PMs.
> Slug: `irc-platform` · Design-only plan (NO implementation).

## 1. Summary

IRC is a **gateway-side messaging platform adapter** in the Python backend: it opens a
long-lived TCP/TLS socket to any IRC server, relays channel messages and DMs to the Hermes
agent, and sends agent replies back as `PRIVMSG` lines. It is deliberately **zero-dependency**
— the whole client is stdlib `asyncio` + `ssl` + `re` in a single ~995-line plugin file.

**Port decision (recorded):** IRC stays on the gateway side. It is not a UI feature that can be
"moved into the React webview": a webview cannot open raw outbound TCP sockets, and the IRC
adapter's real job is holding a network connection, not rendering state. The desktop deliverable
is therefore (a) a small configuration surface (plain-form onboarding for `IRC_*` env vars, no
QR/OAuth), and (b) a long-term plan to re-host the adapter inside the in-process agent runtime
(Node-capable host or Rust via Tauri IPC) once the WebSocket link to the Python runtime is
removed. The protocol logic (parse/split/strip/address) is written as pure TypeScript so it is
unit-testable in vitest and parity-testable against the Python implementation.

## 2. Current Python implementation

Source of truth: `D:/hermes-agent-cn/plugins/platforms/irc/` (3 files):

| File | Role |
|------|------|
| `plugins/platforms/irc/adapter.py` (995 lines) | Full adapter + plugin entry point |
| `plugins/platforms/irc/plugin.yaml` | Plugin metadata, `requires_env`/`optional_env` |
| `plugins/platforms/irc/__init__.py` | Re-exports `register` |

Key symbols in `adapter.py` (line numbers verified by reading the file):

- `_parse_irc_message(raw)` (L83) — RFC 1459 line parser: `prefix / command / params`,
  handles `:prefix`, ` :trailing`, malformed no-space lines.
- `_extract_nick(prefix)` (L110) — `nick!user@host` → `nick`.
- `class IRCAdapter(BasePlatformAdapter)` (L119) — config precedence **env vars override
  `config.yaml`** (`IRC_SERVER`/`IRC_PORT`/`IRC_NICKNAME`/`IRC_CHANNEL`/`IRC_USE_TLS`, plus
  scoped-secret reads for `IRC_SERVER_PASSWORD`/`IRC_NICKSERV_PASSWORD`).
- `connect()` (L179) — TCP/TLS open (30 s timeout), `PASS`/`NICK`/`USER` registration, waits
  for `001 RPL_WELCOME`, NickServ `IDENTIFY` (+2 s sleep), `JOIN`, acquires a scoped identity
  lock per `server:nick` (`gateway.status.acquire_scoped_lock`).
- `disconnect()` (L246) — `QUIT`, releases the lock, cancels receive task.
- `send(chat_id, content, …)` (L282) — byte-aware `_split_message` (L318, 510-byte protocol
  limit with binary-search char boundary + space preference), sends `PRIVMSG <target> :<line>`
  with 0.3 s flood pacing; `send_typing` is a no-op (L305).
- `_strip_markdown` (L362) — bold/italic/code/code-block/image/link → plain text.
- `_receive_loop` (L391) + `_handle_line` (L417) — PING/PONG, `001` registration, `433`
  nick-collision retry (`nick_`, `nick_1`, …), PRIVMSG → channel/DM dispatch, CTCP `ACTION`
  → `* nick text`, other CTCP ignored, channel **address detection** (`nick:`, `nick,`,
  `nick `), case-insensitive allowlist auth, self-message ignore.
- `_standalone_send(pconfig, chat_id, message)` (L743) — ephemeral out-of-process cron
  delivery (`-cron` nick suffix, JOIN before PRIVMSG for `+n` channels, control-char
  injection stripping via `_strip_irc_control_chars` L728, registration/JOIN timeouts).
- `register(ctx)` (L953) — plugin entry: `check_requirements` (L541), `validate_config`
  (L554), `is_connected` (L669), `interactive_setup` (L562), `_env_enablement` (L677),
  `max_message_length=450`, `cron_deliver_env_var="IRC_HOME_CHANNEL"`,
  `standalone_sender_fn=_standalone_send`, `allowed_users_env="IRC_ALLOWED_USERS"`,
  `allow_all_env="IRC_ALLOW_ALL_USERS"`, `platform_hint`.

Config surface (docs `website/docs/user-guide/messaging/irc.md`): env vars `IRC_SERVER`,
`IRC_CHANNEL` (comma-separated), `IRC_NICKNAME` (required); `IRC_PORT` (default 6697 TLS /
6667 plain), `IRC_USE_TLS`, `IRC_SERVER_PASSWORD`, `IRC_NICKSERV_PASSWORD`,
`IRC_ALLOWED_USERS`, `IRC_ALLOW_ALL_USERS`, `IRC_HOME_CHANNEL` (optional); or the
`gateway.platforms.irc.extra` block in `~/.hermes/gateway-config.yaml`. Channel messages are
group conversations, PMs are DMs, cron/notifications go to the home channel.

Data flow today: `gateway` loads plugin → `register(ctx)` → `adapter_factory` →
`IRCAdapter(PlatformConfig)` → `connect()` → `_receive_loop` → `_handle_line` →
`_dispatch_message` → `MessageEvent` → `handle_message` → agent reply → `send()` PRIVMSG.

## 3. Target TypeScript design

The IRC adapter is **not a React feature**. The target has two tiers:

### Tier 1 — Desktop configuration surface (recommended now, gateway unchanged)
- New route `web/src/routes/im-onboarding.tsx`: `IrcRoute` (plain form — server, port, TLS
  toggle, nickname, channels, NickServ/server passwords, allowlist, home channel) with no QR
  flow. Add `irc` to `ImSection` / `sectionFromPath`.
- New nav item in `web/src/components/app-shell/gateway-sidebar.tsx` `IM_ITEMS` (e.g.
  `{ label: "IRC 接入", path: "/im/irc", icon: MessageCircle }`).
- Rust `src/commands/im_onboarding.rs`: add `ImPlatform::Irc`, `IRC_ALLOWED_KEYS` +
  `IRC_SECRET_KEYS` (reuse existing `write_env_patch`/`validate_env_patch`/backup/restart,
  L430–565) so the wizard persists `IRC_*` into the profile `.env` and restarts the gateway.

### Tier 2 — In-process adapter (long-term, after WS removal)
Module layout (runtime-side, NOT UI-side):
- `packages/protocol/src/irc.ts` — **pure protocol module** (no I/O, no DOM):
  - `parseIrcLine(raw): { prefix, command, params }` (parity with `_parse_irc_message`)
  - `extractNick(prefix)` (parity with `_extract_nick`)
  - `splitMessage(content, target, opts): string[]` (byte-aware, parity with `_split_message`)
  - `stripMarkdown(text)` and `stripIrcControlChars(text)` (parity with Python)
  - `isChannelTarget(target)` (`# & + !` prefixes)
  - `addressPrefixes(nick)` for `nick:` / `nick,` / `nick ` detection
- `web/src/lib/irc-adapter.ts` (or `packages/messaging/irc/` if a shared package is created)
  — adapter lifecycle mirroring `IRCAdapter`: `connect()`, `disconnect()`, `send(chatId,
  content)`, `handleLine(raw)`, PING/PONG, `001` registration, `433` nick-collision retry,
  allowlist check, CTCP `ACTION` conversion.
- Socket transport: **the webview cannot open TCP**. Two viable hosts:
  1. **Rust (Tauri) host** — new Tauri commands (`irc_connect`, `irc_send`, `irc_disconnect`,
     `irc_state` + event stream via `tauri::Emitter`) wrapping tokio `TcpStream`/`TlsStream`;
     TS module stays pure and delegates I/O through IPC.
  2. **Node-capable host / sidecar** — the in-process agent runtime runs in Node, uses
     `node:net`/`node:tls`, and can use a third-party IRC SDK.
  Recommendation: host via Rust Tauri commands (option 1) because the desktop already ships a
  Rust runtime and Tauri IPC, and it keeps the TS protocol module dependency-free and
  testable. The decision must be locked when the in-process agent runtime is chosen (see §9).

## 4. Data models & persistence

- **No new database.** IRC state is connection-scoped and in-memory: `{ reader, writer,
  recvTask, currentNick, registered, registrationEvent }` (Python `IRCAdapter.__init__`,
  L166–171). TS mirror keeps the same fields in an `IrcConnectionState` interface.
- **Persistence = env config only.** Desktop writes `IRC_*` keys into the profile `.env`
  (`~/.hermes/.env`), exactly like the existing Feishu/Weixin onboarding
  (`src/commands/im_onboarding.rs` `write_env_patch`, backup file, `restartGateway`).
  Recommended allowed keys (mirror `plugin.yaml`):
  - required: `IRC_SERVER`, `IRC_CHANNEL`, `IRC_NICKNAME`
  - optional: `IRC_PORT`, `IRC_USE_TLS`, `IRC_SERVER_PASSWORD` (secret),
    `IRC_NICKSERV_PASSWORD` (secret), `IRC_ALLOWED_USERS`, `IRC_ALLOW_ALL_USERS`,
    `IRC_HOME_CHANNEL`
- **Messages/sessions** continue to use the existing gateway session store; IRC introduces no
  new schema or migration. In-process parity: `chat_id` = channel name (`#…`/`&…`) for group
  or sender nick for DM; `home_channel` defaults to `IRC_CHANNEL` (Python `_env_enablement`,
  L719–724).

## 5. Third-party library strategy

Python dependency → TS equivalent:

| Python | TS equivalent | Evidence / decision |
|--------|---------------|---------------------|
| `asyncio` streams (`asyncio.open_connection`) | `node:net`/`node:tls` (Node host) or tokio `TcpStream`/`TlsStream` (Rust host via Tauri IPC) | No pure-webview option; raw TCP unavailable in WebView |
| `ssl.create_default_context()` | `tls.connect` (Node) / `rustls` or tokio-rustls (Rust) | Standard; same TLS 1.2+ defaults |
| `re` (markdown strip, nick suffix, address prefix) | JS `RegExp` — port the same patterns | Trivial, no dep |
| `time`-based message-id | `Date.now()` ms | Same semantics |
| (none — zero external deps) | **no npm IRC SDK is proven in-repo** | See below |

**Verified absence in `D:/kimi-code`:** searched all source + manifests + lockfile for
`irc`, `irc-framework`, `irc-upd`, `ircd`, `irc.chat`, `irc:` — every hit is a false positive
(grammar files such as `emacs-lisp`/`asciidoc`, latex `circ`/`bigcirc`, mermaid bundles).
`ls node_modules | grep -i irc` returns nothing; `grep irc-framework|irc-upd` in
`pnpm-lock.yaml` and all `package.json` files returns nothing. **kimi-code has no IRC client
and no precedent for an outbound socket messenger**, so there is no in-repo TS equivalent to
cite for this feature.

**Recommendation with rationale:**
1. **Primary: implement a thin TS protocol module from scratch** (`packages/protocol/src/irc.ts`),
   mirroring the Python stdlib implementation. Rationale: the Python feature is deliberately
   zero-dependency and proves the protocol surface is small (parser, splitter, formatter,
   lifecycle); a hand-rolled module is unit-testable, parity-testable, and avoids adopting an
   unvetted dependency in a repo with no IRC precedent.
2. **If a Node host is adopted:** evaluate `irc-framework` (kiwiirc, RFC 1459/2812 + IRCv3,
   built-in line splitting, TLS, channel/DM, CTCP) as the SDK — it is the most maintained
   option; `irc-upd` (successor of `node-irc`) is older and less maintained. Both are absent
   from kimi-code, so they would be a **new dependency with no in-repo evidence** — pin the
   version and add parity tests against Python behavior before merging.
3. **Rust host (recommended):** implement the socket layer with tokio and keep TS as pure
   protocol; the Rust `src/commands/im_onboarding.rs` shows the established pattern for
   desktop-side commands that touch the gateway.

## 6. Integration with existing Hermes-CN-Desktop frontend

Reuse (verified by reading):
- `web/src/routes/im-onboarding.tsx` — extend the wizard shell (`SectionShell`, `MetaStrip`,
  `Field`, `ReviewTable`, `ApplyResult`, `MessagingTestGuide`, `DiagnosticAssistant`);
  add `irc` to `ImSection` (L52) and `sectionFromPath` (L70); `IrcRoute` = `FeishuRoute`
  minus QR (direct form → `useApplyImOnboarding("irc")` with `settings()` = `IRC_*` patch).
- `web/src/hooks/use-im-onboarding.ts` — already platform-generic over `ImPlatform`;
  `useImOnboardingState/useBeginImOnboarding/usePollImOnboarding/useApplyImOnboarding`,
  `useMessagingPlatform`, `useTestMessagingPlatform` work once `ImPlatform` includes `irc`.
- `packages/protocol/src/channels.ts` — `ImPlatform` union (L491) + onboarding input/result
  types; extend with `"irc"` (keep `ImOnboardingBegin/Poll` IRC-optional or bypass QR flow).
- `packages/protocol/src/hermes-api.ts` — `MessagingPlatformInfo` (L127) /
  `MessagingPlatformsResponse` (L146) / `MessagingPlatformTestResponse` (L153) are
  generic; IRC appears through `/api/messaging/platforms` (verify the Python endpoint
  exposes the `irc` platform — it is registry-driven, see §9 open question).
  `StatusResponse.gateway_platforms` (L47) + `PlatformStatus` (L24) surface connection state.
- `web/src/lib/im-onboarding-diagnostics.ts` — add `irc` to `DIAGNOSTIC_REQUIRED_KEYS`
  (L105) and `explainMessagingFailure` (L160) branches: DNS/connect timeout, TLS handshake
  failure, `433` nick collision, `464/465` password rejected, registration timeout,
  allowlist-deny, `+n` JOIN required.
- `web/src/components/app-shell/gateway-sidebar.tsx` — add IRC item to `IM_ITEMS` (L12).
- `src/commands/im_onboarding.rs` — extend `ImPlatform` enum (L94) + `allowed_keys` /
  `secret_keys`; reuse `write_env_patch` (L502), `validate_env_patch` (L465), restart flow.
- `web/src/routes/settings.tsx` — no new UI required; the Runtime/Dashboard cards (L1190–1480)
  already show gateway state; IRC status renders via `statusData.gateway_platforms.irc`.

## 7. Removing the WebSocket dependency (migration path)

Today the desktop talks to the Python gateway via REST (`/api/status`,
`/api/messaging/platforms`, `/api/messaging/platforms/<id>/test` — see
`web/src/lib/transport.ts`, `web/src/hooks/use-im-onboarding.ts`) and the JSON-RPC WebSocket
(`web/src/lib/gateway-client.ts`, `ws://…/api/ws`) for live agent events.

Because IRC is a messaging adapter, its traffic flows over the WS link twice: inbound IRC
lines → agent events → WS push to the UI; agent replies → WS → `send()` → PRIVMSG. Removing
the WS link means the IRC adapter must run **inside** the desktop process.

Phased path (API surface to freeze during migration):
1. **Keep Python adapter; add config UI only.** No WS change. Freeze: `IRC_*` env keys,
   `gateway_platforms.irc` in `/api/status`, platform id `"irc"` in `/api/messaging/platforms`,
   `max_message_length=450` default.
2. **Extract pure TS protocol module** (`packages/protocol/src/irc.ts`) with vitest parity
   tests vs `test_irc_adapter.py`. No runtime change.
3. **In-process transport** (Rust Tauri commands or Node host). IRC messages no longer need
   the WS round trip; the module emits events to the in-process agent loop instead of the
   Python gateway. Keep REST `/api/status` as the source of connection state for the UI.
4. **Delete WS messaging path** once the in-process runtime handles sessions/agent loop.
5. **Cron delivery parity** — Python `_standalone_send` (`deliver=irc` from `hermes cron`)
   must be re-implemented in-process (`irc-send` one-shot command with `-cron` nick suffix,
   JOIN-before-PRIVMSG, control-char stripping) or deferred while the gateway exists.

WS-removal implications specific to IRC: the adapter is **push-inbound** (server-initiated
lines) and **flood-limited outbound** (0.3 s pacing), so the in-process host must provide a
long-lived socket + timers, which the webview cannot do alone — this is the main reason the
port decision is "gateway-side / host-side", not "webview-side".

## 8. Migration phases & task breakdown

| Phase | Task | Output / acceptance |
|-------|------|---------------------|
| 0 | Read-only parity baseline | `tests/gateway/test_irc_adapter.py` cases enumerated as TS test list |
| 1 | Config surface: `ImPlatform` + Rust `IRC_ALLOWED_KEYS` + `IrcRoute` + sidebar item + diagnostics | `/im/irc` saves `IRC_*` to `.env`, restarts gateway, shows status |
| 2 | Pure TS protocol module (`parseIrcLine`, `extractNick`, `splitMessage`, `stripMarkdown`, `stripIrcControlChars`, `isChannelTarget`) | vitest parity green vs Python cases (incl. 300-byte Japanese split) |
| 3 | Adapter lifecycle in TS (`connect/disconnect/send/handleLine`, PING/PONG, 001, 433 retry, allowlist, CTCP ACTION) | scripted fake-server integration tests pass |
| 4 | Socket transport: Rust Tauri commands (`irc_connect/send/disconnect/state` + events) or Node host | E2E against local ircd or mock |
| 5 | In-process wiring: IRC events → agent loop; retire WS messaging path | messaging works with gateway stopped |
| 6 | Cron one-shot delivery parity | `deliver=irc` equivalent works in-process |

## 9. Risks & open questions

- **No TS equivalent found in kimi-code (confirmed):** `irc-framework` / `irc-upd` are absent
  from node_modules, all package.json manifests, and pnpm-lock.yaml; the 165 "irc" grep hits
  are substring false positives. Any npm IRC SDK would be a **new unvetted dependency** — the
  plan mitigates by hand-rolling the protocol module and treating SDK adoption as optional.
- **WebView cannot open TCP sockets.** The in-process adapter must live in a Node-capable host
  or Rust (Tauri). Open question: which host will the final in-process agent runtime use? If
  Rust, the "TS implementation" is really "TS protocol mirror + Rust socket commands"; if
  Node, `irc-framework` becomes viable. This must be decided before Phase 4.
- **`/api/messaging/platforms` IRC exposure is an assumption.** The desktop's
  `MessagingPlatformInfo` comes from a generic endpoint; verify the Python side lists
  `id="irc"` with `env_vars` from `plugin.yaml` (registry-driven, so likely, but must be
  confirmed in Phase 1).
- **Nick unauthenticated on IRC:** allowlist is weak on public networks (same as Python);
  desktop copy must repeat the NickServ-only guidance from `interactive_setup`.
- **Byte-aware splitting parity** is the highest-risk unit (multibyte UTF-8 + space
  preference + 510-byte limit); needs exact port of the binary-search algorithm and parity
  tests with the Python version.
- **Timing semantics:** NickServ 2 s sleep, 30 s registration timeout, 0.3 s flood pacing —
  nondeterministic in tests; script with fake clocks/servers like Python's `_FakeIRCConnection`.
- **`_standalone_send` cron path** is a separate process concern; if the gateway is removed
  before parity, `deliver=irc` cron silently breaks — sequence Phase 6 before deleting the
  Python gateway.

## 10. Test strategy

- **Vitest unit (pure TS protocol):** port every case from
  `D:/hermes-agent-cn/tests/gateway/test_irc_adapter.py`:
  - `_parse_irc_message` parity (`PING :server…`, malformed `:justaprefix`)
  - `_extract_nick` parity (`nick!user@host`)
  - `splitMessage` byte-limit parity (100 Japanese chars → ≤512 bytes per line)
  - `stripMarkdown` parity (link/image/bold/italic/code cases)
  - addressing (`nick:` / `nick,` / `nick `), allowlist case-insensitivity, CTCP ACTION
- **Integration (vitest + fake TCP server):** scripted handshake server mirroring Python's
  `_FakeIRCConnection` (001 welcome, 433 collision, PING); assert NICK/USER/PRIVMSG/QUIT
  order, JOIN-before-PRIVMSG, registration-timeout error.
- **Rust unit:** extend `src/commands/im_onboarding.rs` tests — `env_patch_preserves_comments…`
  style for `IRC_*` keys, cross-platform key rejection (`write_env_patch` L1862+ precedent).
- **Playwright E2E:** `/im/irc` form → save → restart gateway → `statusData.gateway_platforms.irc`
  shows `connected` against a local mock ircd (or stub `/api/status`).
- **Parity matrix:** one row per Python test class (`TestIRCProtocolHelpers`,
  `TestIRCAdapterInit`, `TestIRCAdapterSend`, `TestIRCAdapterMessageParsing`,
  `TestIRCAdapterSplitting`, `TestIRCAdapterMarkdown`, `TestIRCStandaloneSend`) mapped to TS
  tests; document in the plan's companion test doc if needed.

## 11. Reference links

- Python source: `D:/hermes-agent-cn/plugins/platforms/irc/adapter.py`,
  `…/plugin.yaml`, `…/__init__.py`
- Python docs: `D:/hermes-agent-cn/website/docs/user-guide/messaging/irc.md`
- Python tests: `D:/hermes-agent-cn/tests/gateway/test_irc_adapter.py`
- Feature inventory: `D:/hermes-agent-cn/features_report.md` (row 124: IRC)
- Desktop integration: `D:/Hermes-CN-Desktop/web/src/routes/im-onboarding.tsx`,
  `…/web/src/hooks/use-im-onboarding.ts`, `…/web/src/lib/im-onboarding-diagnostics.ts`,
  `…/web/src/components/app-shell/gateway-sidebar.tsx`, `…/web/src/routes/settings.tsx`,
  `…/packages/protocol/src/channels.ts`, `…/packages/protocol/src/hermes-api.ts`,
  `…/src/commands/im_onboarding.rs`
- Transport/WS: `D:/Hermes-CN-Desktop/web/src/lib/transport.ts`,
  `…/web/src/lib/gateway-client.ts`
- TS reference searched: `D:/kimi-code` (no IRC SDK found — see §5)
