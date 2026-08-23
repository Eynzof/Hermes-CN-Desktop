# Google Meet (bundled plugin) — Python → TypeScript Rewrite Plan

## 1. Summary

The Python `google_meet` bundled plugin (`D:/hermes-agent-cn/plugins/google_meet/`) lets the
agent **join a Google Meet call as a headless virtual participant, scrape Google's built-in live
captions into a transcript, expose a `meet_*` toolset, and leave post-meeting artifacts**
(`transcript.txt` + `status.json`) under `$HERMES_HOME/workspace/meetings/<meeting-id>/`. It is
explicitly Linux/macOS-only (Windows `register()` no-ops), runs a detached Playwright subprocess,
and supports two optional layers: `mode='realtime'` (agent speech via OpenAI Realtime +
PulseAudio/BlackHole virtual audio) and `node='<name>'` (remote WS host).

Target TS design for the desktop standalone:

1. **Transcribe-only headless join is feasible in desktop standalone** by porting the bot into a
   Node sidecar (`packages/meet-bot`) that reuses the Playwright/CDP sidecar proposed by
   `plans/browser-automation.md`; Rust owns process lifecycle + file reads; the webview holds the
   in-process tool logic. Windows transcribe is expected to work (Chromium is platform-neutral)
   but must be labeled experimental — Python never tested it.
2. **`meet_say` realtime duplex audio is OUT OF SCOPE for v1** (no Windows virtual-audio bridge in
   Python, macOS needs manual BlackHole routing, OpenAI Realtime billing). Keep the tool surface
   (`meet_say` returns a clear `ok=false` reason) for parity.
3. **Remote node hosts (`hermes meet node …`) are OUT OF SCOPE for v1** — a LAN WS server is a
   poor fit for a single-machine desktop app; record the schema so a future sidecar mode can reuse it.
4. **Post-meeting artifacts**: primary path = scraped `transcript.txt`/`status.json` (same as
   Python). Optional v2 path = a Google Meet REST API client (`@google-apps/meet` / raw
   `meet.googleapis.com`) to fetch Workspace-generated transcripts/recordings *after* the meeting
   ends — this is not a real-time path (API exposes artifacts only post-meeting) and requires
   Google Workspace + restricted OAuth scopes.

**Key finding (evidence): kimi-code has NO Google Meet equivalent.** Verified by grep across
`D:/kimi-code`: zero matches for `google meet` / `meet.google` / `meet_join` / `meet_transcript`;
no `playwright`/`puppeteer` anywhere in any `package.json`; `@google/genai` exists only as a Gemini
LLM provider; all `transcri*` hits are the agent conversation-transcript store
(`packages/transcript`), which is a different concept (useful persistence-pattern reference, not a
meeting-transcription implementation). The whole feature must be **designed from scratch**.

## 2. Current Python implementation

Source of truth: `D:/hermes-agent-cn`.

- **Manifest** — `plugins/google_meet/plugin.yaml`: `kind: standalone`, version 0.2.0,
  `platforms: [linux, macos]`, `provides_tools: meet_join, meet_leave, meet_status,
  meet_transcript, meet_say`, `hooks: [on_session_end]`.
- **Registration** — `plugins/google_meet/__init__.py`: `register(ctx)` no-ops on Windows; on
  Linux/macOS registers 5 tools (`toolset="google_meet"`, with `check_fn=check_meet_requirements`),
  the `hermes meet` CLI, and the `on_session_end` hook that calls `pm.stop(reason="session ended")`
  if a bot is alive.
- **Bot subprocess** — `plugins/google_meet/meet_bot.py` (861 lines, standalone
  `python -m plugins.google_meet.meet_bot`): reads `HERMES_MEET_URL / OUT_DIR / GUEST_NAME /
  HEADED / AUTH_STATE / DURATION / MODE / REALTIME_*`; URL gate `_is_safe_meet_url` + `MEET_URL_RE`
  (only `https://meet.google.com/abc-defg-hij`, `/lookup/<id>`, `/new`); `_meeting_id_from_url`;
  `_BotState` (dedupe by `speaker|text`, atomic `status.json` flush, append `transcript.txt`);
  `_CAPTION_OBSERVER_JS` — a **MutationObserver injected into the Meet page** on
  `[role="region"][aria-label*="aption" i]`, `div[jsname="YSxPC"]`, `div[jsname="tgaKEf"]`,
  drained via `window.__hermesMeetDrain()`; `_enable_captions_js` dispatches keydown `c`;
  `_try_guest_name`, `_click_join` ("Join now"/"Ask to join"), `_detect_admission` (leave button /
  caption region / participants container), `_detect_denied`, lobby timeout (default 300 s,
  `HERMES_MEET_LOBBY_TIMEOUT`), `_parse_duration`, leave-cleanly click, SIGTERM/SIGINT handlers.
- **Process manager** — `plugins/google_meet/process_manager.py` (350 lines): single-active-meeting
  semantics; pointer file `workspace/meetings/.active.json` `{pid, meeting_id, out_dir, url,
  started_at, session_id, log_path, mode}`; `start()` spawns detached `sys.executable -m
  plugins.google_meet.meet_bot` (refuses PyInstaller frozen runtime via
  `tools/runtime_compat.is_frozen_runtime`); `status()` merges `.active.json` + bot `status.json`;
  `transcript(last=N)`; `enqueue_say(text)` appends to `say_queue.jsonl` (realtime mode only);
  `stop()` SIGTERM → wait 10 s → SIGKILL; `_pid_alive` uses `gateway.status._pid_exists` (Windows
  `os.kill(pid,0)` footgun avoided).
- **Tools** — `plugins/google_meet/tools.py` (348 lines): `MEET_*_SCHEMA` + handlers returning
  `{success, error, ...}` JSON; `_resolve_node_client` routes to a registered remote node or runs
  locally.
- **CLI** — `plugins/google_meet/cli.py` (485 lines): `hermes meet setup / install / auth / join /
  status / transcript / say / stop / node …`; `auth` opens headed Chromium to
  accounts.google.com and saves `storage_state` to `workspace/meetings/auth.json`.
- **Realtime (v2)** — `plugins/google_meet/audio_bridge.py` (PulseAudio null-sink + virtual source
  on Linux; BlackHole probe on macOS; Windows unsupported) + `plugins/google_meet/realtime/openai_client.py`
  (`RealtimeSession` to `wss://api.openai.com/v1/realtime`, PCM sink, `response.cancel` barge-in,
  `RealtimeSpeaker` JSONL queue).
- **Remote node (v3)** — `plugins/google_meet/node/{protocol,registry,server,client,cli}.py`:
  WS envelope `{type, id, token, payload}`, bearer token at `workspace/meetings/node_token.json`,
  registry `nodes.json`, NodeServer runs `pm.*` locally on the host machine.
- **Docs/tests** — `D:/hermes-agent-cn/website/docs/user-guide/features/built-in-plugins.md`
  §google_meet (lines ~206-235); `D:/hermes-agent-cn/tests/plugins/test_google_meet_plugin.py`
  (300 lines — URL gate, meeting-id, `_BotState` dedupe/status round-trip, duration parse, pm
  refusal/status/transcript/stop, tool handler JSON, `_on_session_end` no-op, Windows `register()`
  no-op, `enqueue_say` gate, node CLI wiring, admission probe, realtime `cancel_response`).
- **Data flow**: agent → `meet_join` → `pm.start()` → detached `meet_bot` subprocess → Playwright
  Chromium joins Meet → caption observer drains captions → `transcript.txt`/`status.json` →
  `meet_status`/`meet_transcript` read files → `meet_leave` SIGTERM → `on_session_end` cleanup.
  **No IPC beyond the filesystem** (deliberate).

## 3. Target TypeScript design

Runs in-process (TS agent loop in the Tauri webview) + a Node sidecar for Playwright/CDP I/O,
mirroring the `plans/browser-automation.md` split. The webview never holds a browser or raw CDP
socket; Rust is the transport boundary and owns process lifecycle.

```
webview (React + TS agent loop, Tauri IPC)
  └─ web/src/lib/meet/*            tool logic, URL gate, state model, UI atoms
       └─ invoke("meet_*") ──► Rust src/commands/meet.rs
            ├─ spawn/kill sidecar (packages/meet-bot, terminal.rs pattern)
            ├─ read/write artifacts: <dataDir>/workspace/meetings/<id>/
            │    ├─ .active.json   pointer (Rust-owned)
            │    ├─ status.json    live bot state (bot-owned, atomic flush)
            │    └─ transcript.txt scraped captions (bot-owned, append)
            └─ file-watch / poll status.json → push MeetStatusEvent to webview
                 └─► packages/meet-bot (Node sidecar, JSON-RPC over stdio)
                      ├─ playwright-core: launch Chromium, goto meet.google.com
                      ├─ port of _CAPTION_OBSERVER_JS + _enable_captions_js (verbatim JS)
                      ├─ admission / lobby / denied / duration loop
                      └─ (deferred) Google Meet REST client + OpenAI Realtime speaker
```

Proposed module layout (new workspace package `packages/meet-bot` + pure-TS mirror
`web/src/lib/meet/*`):

- `packages/meet-bot/src/bot.ts` — `MeetBot` class: `join(url, opts) → {ok, pid, outDir}`,
  `status()`, `transcript(last?)`, `enqueueSay(text)`, `leave(reason)`; JSON-RPC over stdio
  (same envelope style as Python `node/protocol.py` but stdio instead of WS). Reuses
  `packages/browser-agent` (from browser-automation plan) when present for CDP/Chromium mgmt.
- `packages/meet-bot/src/captions.ts` — verbatim port of `_CAPTION_OBSERVER_JS` +
  `_enable_captions_js` + drain loop.
- `packages/meet-bot/src/admission.ts` — port of `_detect_admission`, `_detect_denied`,
  `_try_guest_name`, `_click_join`, lobby deadline, `_parse_duration`, `_looks_like_human_speaker`.
- `web/src/lib/meet/{tools,state,artifacts}.ts` — in-process tool handlers
  `handleMeetJoin/Status/Transcript/Leave/Say` mirroring `tools.py` JSON shapes exactly;
  `state.ts` reads `.active.json`; `artifacts.ts` reads `transcript.txt`/`status.json`.
- `web/src/lib/meet/url-gate.ts` — port of `MEET_URL_RE` / `_is_safe_meet_url` /
  `_meeting_id_from_url`.
- `src/commands/meet.rs` — Rust Tauri commands `meet_join/meet_status/meet_transcript/meet_leave/
  meet_say`, `meet_sidecar_spawn/kill`, `meet_setup` (Chromium install preflight), event streaming
  (status updates) — same shape as `src/commands/terminal.rs` / `ws_proxy.rs` per
  `plans/browser-automation.md`.

Tool data flow: tool call → `url-gate` → Rust `meet_join` → spawn `packages/meet-bot` sidecar →
sidecar runs Playwright + caption scraper → artifacts written to
`<dataDir>/workspace/meetings/<meeting-id>/` → `meet_status`/`meet_transcript` read files (poll
pattern identical to Python) → agent sees `{success, ...}` JSON.

Feasibility decision (recorded): **transcribe-only headless join = feasible** in desktop
standalone once the browser sidecar exists (Chromium is a normal npm/runtime dep, Windows works
for browsing; the DOM-scrape approach is the same as Python's). **realtime + remote nodes =
out of scope for v1** (see §9 for the audio-bridge and WS-server justifications).

## 4. Data models & persistence

Keep the Python artifact layout so existing transcripts stay readable and parity tests port 1:1.

- **Artifacts** under `<dataDir>/workspace/meetings/<meeting-id>/` (desktop data dir computed by
  Rust `src/process/runtime.rs`; today that dir is also injected to the managed Python runtime as
  `HERMES_HOME`):
  - `.active.json` — `{pid, meeting_id, out_dir, url, started_at, session_id?, log_path?, mode}`.
  - `status.json` — bot telemetry, keys frozen from `_BotState._flush()`: `meetingId`, `url`,
    `inCall`, `captioning`, `captionsEnabledAttempted`, `lobbyWaiting`, `joinAttemptedAt`,
    `joinedAt`, `lastCaptionAt`, `transcriptLines`, `transcriptPath`, `error`, `exited`, `pid`,
    `realtime*` (deferred), `leaveReason`.
  - `transcript.txt` — line format `[HH:MM:SS] Speaker: text`, dedupe key `speaker|text`.
  - `bot.log`, `say_queue.jsonl` / `say_processed.jsonl` / `speaker.pcm` (realtime, deferred),
    `auth.json` (Playwright storage_state from `hermes meet auth` equivalent),
    `nodes.json` (remote-node registry, deferred).
- **Protocol** — new `packages/protocol/src/meet-api.ts` Zod schemas (pattern:
  `packages/protocol/src/hermes-api.ts`, `mcp-api.ts`): `MeetJoinInput/Result`,
  `MeetStatusResult`, `MeetTranscriptResult`, `MeetLeaveResult`, `MeetSayResult`,
  `MeetSetupResult`, `MeetStatusEvent`. Result shapes must byte-match Python
  (`ok`/`reason`/`success`/`error` semantics preserved).
- **Config** — `google_meet.*` keys in the desktop config: `guest_name` (default "Hermes Agent"),
  `lobby_timeout_s` (300), `chromium_headless` (default true), `enabled`. Secrets in the desktop
  secret store: `HERMES_MEET_REALTIME_KEY`/`OPENAI_API_KEY` (deferred realtime), Google OAuth
  token for the Meet REST path (v2 optional).
- **Migrations** — additive-only `status.json` fields; `installed.json`/config handled by the
  plugins plan (`plans/plugins.md`); no DB migration needed for v1.

## 5. Third-party library strategy

Most important section. Python dep → TS equivalent, with kimi-code evidence:

| Python dep (Core) | TS equivalent | Evidence / status |
|---|---|---|
| `playwright` (meet_bot.py) | `playwright-core` in the Node sidecar | **No kimi-code evidence** — verified zero `playwright`/`puppeteer` matches in all kimi-code `package.json` files. Ecosystem standard; runs unchanged inside the Node sidecar (`packages/meet-bot` / `packages/browser-agent`). |
| `websockets` (node RPC + OpenAI Realtime) | `ws` ^8.18.0 in the sidecar (stdio JSON-RPC for v1; `ws` only if a WS node mode is ever added) | kimi-code evidence: `packages/klient/package.json` and `packages/kap-server/package.json` both depend on `ws ^8.18.0`. |
| Google Meet REST API (new, post-meeting artifacts) | `@google-apps/meet` npm client, or hand-rolled `fetch` to `https://meet.googleapis.com/v1/` | **No kimi-code evidence** (verified). Web-verified: npm `@google-apps/meet` exposes `conferenceRecords`, `participants`, `participantSessions`, `recordings`, `transcripts`, `spaces`. REST exposes artifacts **only after the meeting ends** — it cannot replace live caption scraping. Requires Workspace + restricted OAuth scopes. |
| Google OAuth (Meet API path / signed-in auth) | from scratch: PKCE + loopback (Rust `open`, or Tauri opener) + token store; reuse the desktop's existing OAuth UI pattern (`web/src/routes/settings-oauth-section.tsx`, `hooks/use-oauth-providers.ts`) | kimi-code `packages/oauth` is Kimi-identity-specific (PKCE/device-code shapes only) — not reusable for Google. Core precedent to port: `skills/productivity/google-workspace/scripts/google_api.py` (`google_token.json`, refresh flow) and `plugins/platforms/google_chat/oauth.py`. |
| `orjson` | `JSON.parse/stringify` | built-in. |
| `pybase64` | `Buffer.toString("base64")` / `Buffer.from(b64, "base64")` | built-in. |
| `requests`/`httpx` (REST, deferred) | `undici`/native `fetch` | kimi-code evidence: `packages/agent-core/package.json` `undici ^7.27.1`. |
| OpenAI Realtime (meet_say, deferred) | `openai` npm or raw `ws` | kimi-code evidence: `packages/kosong/package.json` and `packages/agent-core-v2/package.json` use `openai ^6.34.0`. Deferred — gate `meet_say` to `ok=false` until shipped. |
| Caption scraping (`_CAPTION_OBSERVER_JS`, `_enable_captions_js`) | **verbatim JS port** — no lib | These are already JS strings injected via `page.evaluate`; copy them into `captions.ts` unchanged. |
| PulseAudio `pactl` / BlackHole / `paplay` / `ffmpeg` (realtime audio bridge) | from scratch (Rust/Node child process) — **deferred/out of scope v1** | No npm equivalent for virtual audio; Windows has no tested path in Python either. |
| kimi-code pattern (architectural) | `MeetBot` provider interface injected into tools | Direct evidence pattern: `WebSearchTool(provider)` / `FetchURLTool(fetcher)` in kimi-code `packages/agent-core/src/tools/builtin/web/` — same provider-injection shape. |
| `packages/transcript` (conversation transcript store) | reuse as the *agent-side* artifact reader pattern (pagination, dedupe, store) | kimi-code `packages/transcript/src/store/transcriptStore.ts` — persistence pattern only; NOT a meeting-transcription equivalent. |

Explicit "implement from scratch": URL gate regex, duration parser, caption dedupe/store,
admission/lobby/denied DOM probes, process manager (Rust), artifact readers, sidecar JSON-RPC
envelope, Meet REST client if the npm SDK is rejected, OAuth loopback flow.

## 6. Integration with existing Hermes-CN-Desktop frontend

- **Settings UI**: `web/src/routes/settings.tsx` has **no plugin section today** (verified by grep;
  matches `plans/plugins.md` finding). Add a `GoogleMeetSection` (or mount inside the future
  `web/src/routes/plugins.tsx` from `plans/plugins.md`): enable toggle, `hermes meet setup`
  equivalent preflight, guest name, status/transcript viewer, "open meeting folder".
- **OAuth UI reuse**: `web/src/routes/settings-oauth-section.tsx` + `web/src/hooks/use-oauth-providers.ts`
  already render provider login/disconnect (calls `/api/providers/oauth/*` today — proxied to the
  Python dashboard via Rust). Reuse the same component pattern for Google sign-in when the Meet
  REST path lands; during migration it keeps calling the dashboard, later switches to the
  in-process PKCE flow.
- **Transport**: `web/src/lib/transport.ts` (HTTP routing + auth) stays during migration;
  `web/src/lib/gateway-client.ts` (WS JSON-RPC) is the link being removed (see §7);
  `web/src/lib/tauri-bridge.ts` is the IPC shim the Meet commands go through in-process.
- **Rust**: `src/commands/api_proxy.rs` shows the command pattern (typed inputs/results,
  `AppState`); new `src/commands/meet.rs` follows it, plus sidecar spawn/lifecycle pattern from
  `src/commands/terminal.rs` / `ws_proxy.rs` (per `plans/browser-automation.md`). Rust
  `src/process/runtime.rs` currently injects `HERMES_BUNDLED_PLUGINS` for the managed runtime —
  after migration it computes the meet artifact dir instead.
- **Protocol**: `packages/protocol/src/meet-api.ts` (new Zod schemas, §4) shared by UI, IPC, and
  sidecar contracts.
- **Tool registry**: the 5 `meet_*` tools register into the desktop agent loop's tool registry
  (the same registry `plans/plugins.md` builds), gated by a `meetRequirements()` check ported from
  `check_meet_requirements()`.

## 7. Removing the WebSocket dependency (migration path)

- **Phase A (today)**: `meet_*` tools execute inside the managed Python runtime; the desktop sees
  results/status through the gateway WS JSON-RPC + REST link (`gateway-client.ts`, `transport.ts`).
  `hermes meet setup/auth` are CLI-only today (no desktop UI).
- **Phase B (freeze the API surface)**: define the in-process `MeetTools` interface —
  `join/status/transcript/leave/say` with the exact Python input/output JSON, plus the frozen
  artifact contract (`status.json` keys, `transcript.txt` line format, `.active.json` shape, dir
  layout). Implement `web/src/lib/meet/*` + `src/commands/meet.rs` behind it; the UI and agent loop
  call the same interface via Tauri IPC, never noticing the backend swap.
- **Phase C (delete WS path)**: stop loading the Python plugin on desktop, delete the gateway
  event relay for `meet_*`, remove `HERMES_BUNDLED_PLUGINS` env injection, and drop the
  `/api/providers/oauth` dependency once in-process OAuth lands. The frozen `MeetTools` API +
  parity suite (§10) is the deletion guard.

## 8. Migration phases & task breakdown

1. **P0 — scope validation** (1 task): run the caption-scrape approach on Playwright Chromium
   (Windows + macOS) against a throwaway Meet URL; record DOM selector drift; confirm
   `@google-apps/meet` availability/scope feasibility (optional path). Decide transcribe-only v1.
2. **P1 — protocol + pure-TS parity core** (2-3 tasks): `packages/protocol/src/meet-api.ts`;
   `web/src/lib/meet/url-gate.ts` (URL regex, meeting-id, duration parse); `artifacts.ts`
   (transcript last-N, status merge, dedupe); port the non-Playwright cases of
   `test_google_meet_plugin.py` to vitest.
3. **P2 — Rust commands + sidecar scaffold** (2-3 tasks): `src/commands/meet.rs`
   (join/status/transcript/leave/say/setup, sidecar spawn/kill, artifact dir); `packages/meet-bot`
   stdio JSON-RPC skeleton; Chromium install/preflight (`meet_setup`).
4. **P3 — bot behavior parity** (2-3 tasks): `captions.ts` (verbatim JS ports + drain loop),
   `admission.ts` (guest name, join/ask-to-join, admission/denied probes, lobby timeout, duration
   auto-leave, clean leave), `.active.json` single-active semantics.
5. **P4 — optional Meet REST client + OAuth** (2-3 tasks): Google OAuth loopback flow; Meet REST
   client for post-meeting `transcripts`/`recordings`; `meet_artifacts`-style enrichment of the
   meeting folder.
6. **P5 — UI** (2 tasks): `GoogleMeetSection` in Settings (or `plugins.tsx` mount), preflight
   wizard, status/transcript viewer, open-artifacts-folder; Playwright E2E.
7. **P6 — WS teardown** (1 task): delete Python path + gateway relay + env injection; parity gate.
8. **P7 — deferred (recorded, not v1)**: `meet_say` realtime (OpenAI Realtime + audio bridge),
   remote node hosts (`nodes.json` + WS server), Windows audio bridge.

## 9. Risks & open questions

- **Meet DOM brittleness**: caption selectors already changed once (`jsname="tgaKEf"` current as of
  Apr 2026 per meet_bot.py). The observer approach is resilient-ish (multiple selector shapes +
  fallback), but the desktop must re-verify selectors on Chromium releases; make `captions.ts`
  selector table a data module with a smoke test.
- **Headless/bot detection**: `--disable-blink-features=AutomationControlled` is best-effort;
  Google may gate headless guests or show CAPTCHAs. Hosts can deny admission (handled via
  `lobbyWaiting` / `leaveReason: denied`), but there is no guarantee on all accounts.
- **Caption quality**: English-biased, lossy on overlap — identical limitation to Python; document
  in the UI ("transcript is as good as Meet live captions").
- **Meet REST API is post-meeting only + heavy auth**: verified via web search — real-time audio/
  video/transcripts are NOT exposed by the API; artifacts need Workspace + restricted OAuth scopes
  (security review can take weeks). Treat as optional v2; never the primary transcription path.
- **Sidecar sequencing**: v1 transcribe depends on the browser sidecar from
  `plans/browser-automation.md` (`packages/browser-agent`). If that plan ships late, `meet-bot`
  can embed `playwright-core` directly (its own Chromium), at the cost of a second browser install
  (~300 MB).
- **Windows untested for the meet bot**: Python never ran on Windows. Playwright + Chromium are
  fine, but the whole join/admission/caption flow needs real-browser validation on Windows before
  we call it supported.
- **Orphaned Chromium / single-active meeting**: one active meeting per install; Rust must kill
  the sidecar on app exit (`on_session_end` equivalent + Tauri exit hook), else a headless
  Chromium leaks and the mic/camera fake-device flags persist.
- **Realtime out of scope means `meet_say` parity is a stub**: model may call it and get
  `ok=false` with reason — same UX as Python calling `meet_say` against a transcribe-mode meeting.
- **No TS equivalent found (whole surface)**: kimi-code has no meeting/transcription feature;
  every row in §5 under "from scratch" carries this risk. The one thing kimi-code does offer is the
  provider-injection tool pattern + `ws`/`openai`/`undici` deps to cite.
- **Open questions**: (1) keep scraped captions as the primary transcription path, or integrate a
  paid real-time provider (Recall.ai etc.)? (recorded decision: scrape, same as Python); (2) should
  the Meet section live in Settings or the future plugins route (`plans/plugins.md`)?; (3) do we
  ship Chromium with the installer or download on first `meet_setup`?

## 10. Test strategy

- **Vitest unit (pure-TS parity)** — port every non-Playwright case in
  `D:/hermes-agent-cn/tests/plugins/test_google_meet_plugin.py`: URL gate accept/reject,
  meeting-id extraction + `/new` fallback, `_BotState`-equivalent dedupe + `status.json` round-trip,
  duration parsing, `transcript(last=N)` tail read, `enqueueSay` gate (text required + mode must be
  realtime), tool handler JSON shapes under error branches, `_looks_like_human_speaker` table.
- **Vitest unit (captions/admission)**: inject the ported `_CAPTION_OBSERVER_JS` into a jsdom
  fixture DOM; assert drain returns `{speaker, text, ts}` and dedupes; unit-test admission/denied
  probe strings (fuzzy matchers) with mocked `page.evaluate`.
- **Rust integration**: `src/commands/meet.rs` lifecycle against a mock sidecar binary —
  spawn writes `.active.json`, status merges bot `status.json`, leave clears pointer; atomic-flush
  readers tolerate missing/corrupt files.
- **Sidecar integration (vitest/node)**: JSON-RPC envelope round-trip over stdio; Chromium launch
  smoke (gated, requires `playwright install chromium`); optional real-Meet smoke behind an env
  flag (`HERMES_MEET_E2E_URL`) — never in CI (needs host admission).
- **Playwright E2E (web)**: Settings/Meet section enable + preflight + status/transcript viewer
  with a mocked Rust command layer.
- **Parity harness**: run the Python test file as the behavioral oracle during P1-P3; freeze the
  `MeetTools` interface (Phase B) and gate WS teardown (Phase C) on the parity suite.

## 11. Reference links

- Python: `D:/hermes-agent-cn/plugins/google_meet/` — `plugin.yaml`, `__init__.py`,
  `meet_bot.py`, `process_manager.py`, `tools.py`, `cli.py`, `audio_bridge.py`,
  `realtime/openai_client.py`, `node/{protocol,registry,server,client,cli}.py`, `README.md`,
  `SKILL.md`
- Docs: `D:/hermes-agent-cn/website/docs/user-guide/features/built-in-plugins.md` (§google_meet),
  `D:/hermes-agent-cn/features_report.md` (line 85)
- Tests: `D:/hermes-agent-cn/tests/plugins/test_google_meet_plugin.py`
- Related Core OAuth precedent: `D:/hermes-agent-cn/skills/productivity/google-workspace/scripts/google_api.py`,
  `D:/hermes-agent-cn/plugins/platforms/google_chat/oauth.py`
- kimi-code TS: `D:/kimi-code/packages/agent-core/src/tools/builtin/web/` (provider pattern),
  `packages/klient/package.json` + `packages/kap-server/package.json` (`ws`), `packages/kosong/package.json`
  (`openai`, `@google/genai`), `packages/agent-core/package.json` (`undici`, `jimp`),
  `packages/transcript/src/store/transcriptStore.ts` (artifact-store pattern)
- Desktop: `D:/Hermes-CN-Desktop/web/src/routes/settings.tsx` (no plugin section today),
  `web/src/routes/settings-oauth-section.tsx`, `web/src/hooks/use-oauth-providers.ts`,
  `web/src/lib/{transport,gateway-client,tauri-bridge}.ts`, `src/commands/api_proxy.rs`,
  `packages/protocol/src/{hermes-api,mcp-api}.ts`, `plans/plugins.md`, `plans/browser-automation.md`
- Web (verified): npm `@google-apps/meet`; Google Meet REST API — post-meeting `conferenceRecords` /
  `participants` / `recordings` / `transcripts` only; Workspace + restricted OAuth scopes required.
