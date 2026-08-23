# Wake Word — Python → TypeScript Rewrite Plan

## 1. Summary

"Hey Hermes" is an always-on, fully on-device hotword listener: say the wake
phrase and Hermes opens a fresh session, captures your command through the
existing voice pipeline (STT → agent → TTS), then listens again. It is **off by
default** (`wake_word.enabled: false`) and is surfaced in CLI (`/wake`), TUI,
and the desktop GUI (composer ear toggle). The GUI always prefers **client
capture** (`wake.start` with `client_capture: true`): the renderer opens the
local mic via `getUserMedia`, resamples to 16 kHz mono int16, and streams frames
into the detector, so a headless remote backend without a mic can still run
detection.

Today the engine lives in the Python backend (`D:/hermes-agent-cn/tools/
wake_word.py`) and the desktop talks to it over the WS JSON-RPC (`wake.*`
methods in `tui_gateway/server.py`). This plan moves detection **in-process**
for the Tauri standalone desktop: the renderer keeps capturing PCM (reusing the
predecessor Electron `wake-client-capture.ts` pattern), and the engine runs in
the **Rust sidecar** (`src/wake_word/`, sherpa-onnx Rust crate) invoked via
Tauri IPC, behind an engine abstraction that also supports openWakeWord and
Porcupine. CLI/TUI remain on the Python side (shared Core), with the existing
machine-wide mic lock preserved for interop. **kimi-code has no wake-word /
hotword TS reference (0 matches)** — see §5 for the from-scratch engine
strategy; the strongest TS evidence is the predecessor Electron desktop in Core
(`apps/desktop/`), which we port rather than invent.

## 2. Current Python implementation

Source of truth: `D:/hermes-agent-cn/tools/wake_word.py` (1508 lines) plus:

- `D:/hermes-agent-cn/tools/wakewords/` — bundled `hey_hermes.onnx` /
  `hey_hermes.tflite` + `README.md` (openWakeWord models; shared feature models
  are fetched once via `openwakeword.utils.download_models()`).
- `D:/hermes-agent-cn/website/docs/user-guide/features/wake-word.md` — user
  docs (engines, config, surfaces, remote capture, macOS/Windows silence tips).
- `D:/hermes-agent-cn/tests/tools/test_wake_word.py` (783 lines, engines
  stubbed, no audio/network).
- Config default: `wake_word` section in
  `D:/hermes-agent-cn/hermes_cli/config_defaults.py` (~line 1671) and
  `cli-config.yaml.example:58`.

Data flow (gateway/desktop path):

1. Renderer (old Electron desktop or TUI) sends `wake.status` / `wake.start`
   (`{surface:"gui", client_capture:true, persist?}`) over WS to
   `tui_gateway/server.py` (`@method("wake.start")`, lines 14452–14598).
2. Server resolves capture mode (`resolve_capture_mode`, `prefer_client=True`
   for gui), probes `check_wake_word_requirements` (deps + STT + TTS + mic +
   Porcupine key), optionally persists `wake_word.enabled` via
   `save_config_value`, then calls `start_listening(...)` — the process-wide
   singleton in `tools/wake_word.py`.
3. `WakeWordDetector` runs a daemon thread: local mode opens a PortAudio
   `InputStream` (16 kHz int16 mono; native-rate capture is resampled via
   `_resample_audio_frame`); client mode drains an internal queue filled by
   `feed_audio` ← `wake.feed` (base64 int16 LE, ≤64 KB, rate must be 16000).
4. Engines implement `_Engine` (frame_length, `process(frame)->bool`,
   `reset()`, `close()`, optional `last_match`):
   - `_OpenWakeWordEngine` (default): ONNX/tflite, 1280-sample frames,
     per-frame score ≥ `sensitivity` for `confirmation_frames` in a row,
     `ensure_tflite_runtime()` + macOS-ARM64 onnx→tflite coercion (upstream
     openWakeWord#336).
   - `_SherpaKwsEngine`: open-vocabulary KWS, downloads
     `sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01` (~13 MB) into
     `$HERMES_HOME/cache/wakewords/`, tokenizes every enrolled profile's phrase
     at runtime, maps `sensitivity` → `keywords_threshold`, reports
     `last_match (phrase, profile)` for profile routing.
   - `_PorcupineEngine`: `PORCUPINE_ACCESS_KEY`, built-in `.ppn` keywords,
     sensitivity inverted ("higher = stricter" shared contract).
5. On fire: 2 s cooldown, callback thread → gateway `_on_detect()` →
   `wake.detected` event `{phrase, profile, start_new_session}`. Detector
   pauses itself; voice conversation `wake.pause` / `wake.resume` (with a
   15 s retry loop) arbitrate the mic; `wake.status` reports availability,
   listening, `audio_silent`, input-device diagnostics, capture mode.

Tests to use as parity anchors (all in `test_wake_word.py`): config defaults and
clamping, `wake_surface_enabled` gate, engine dispatch, requirements probe
(incl. lazy-install regression), bundled-model existence, macOS framework
selection, confirmation-streak scoring, detector device/rate/resampling, silent
stream flag + recovery, singleton owner semantics, machine lock
cross-process, `resolve_capture_mode` auto/local/client, `feed_audio` owner
check and fire path.

## 3. Target TypeScript design

End state: no Python backend, no WS. The renderer captures audio; the Rust
sidecar runs the detector and emits an event on detection.

Module layout (new):

- `web/src/lib/wake-word/wake-word-store.ts` — Jotai atom + reducers (port of
  `apps/desktop/src/store/wake-word.ts`, switching the requester from WS RPC to
  the IPC bridge).
- `web/src/lib/wake-word/client-capture.ts` — port of
  `apps/desktop/src/lib/wake-client-capture.ts`: `getUserMedia` → AudioContext
  → (AudioWorklet preferred; ScriptProcessor fallback) → downsample to 16 kHz →
  int16 LE base64 → `wake.feed` IPC. Same constants: `TARGET_RATE=16000`,
  `DEFAULT_FRAME=1280`, coalesce ≤4 frames/call, bounded queue (drop oldest).
- `web/src/lib/wake-word/types.ts` — `WakeWordState`, `WakeStatusResponse`,
  `WakeStartResponse`, `WakeStopResponse`, `WakeInputDeviceStatus`
  (mirrors `apps/desktop/src/store/wake-word.ts:82-130`); zod versions go in
  `packages/protocol`.
- `src/wake_word/mod.rs` — Rust engine layer:
  - `trait WakeWordEngine { fn frame_length(&self)->usize; fn process(&mut self, frame:&[i16])->bool; fn reset(&mut self); fn close(&mut self); fn last_match(&self)->Option<(String,String)>; }`
    (direct mirror of `_Engine`).
  - `SherpaKwsEngine` (primary): sherpa-onnx Rust crate; same model dir /
    `tokens.txt` + `bpe.model` + encoder/decoder/joiner; generates the
    keywords-file lines with `@DISPLAY` names per enrolled profile
    (mirrors `_SherpaKwsEngine`), `keywords_threshold = 0.05 + 0.4*sensitivity`.
  - `WakeWordDetector` struct: owns engine + capture sink; external-audio mode
    with a bounded queue (mirrors `WakeWordDetector` + `feed()`); silence
    detection (`peak ≤ 10` for `_SILENCE_ALERT_SECONDS=10`); 2 s fire cooldown;
    confirmation-streak helper for the openWakeWord path.
  - Optional engines behind the same trait: `OpenWakeWordEngine` (onnxruntime
    crate, from scratch) and `PorcupineEngine` (porcupine Rust/JS binding —
    verify crate) — or renderer-side via onnxruntime-web / `@picovoice/...`
    (§5). Default engine = sherpa to maximize parity and avoid the macOS
    openWakeWord-onnx bug.
- `src/commands/wake.rs` — Tauri commands (`wake_start`, `wake_stop`,
  `wake_pause`, `wake_resume`, `wake_status`, `wake_feed`, `wake_frame_info`)
  registered in `src/main.rs` `generate_handler!`; detector state in
  `AppState` (or a dedicated `Mutex<WakeWordService>`); emits `wake.detected`
  `{phrase, profile, start_new_session}` via `app.emit` (existing
  `@tauri-apps/api/event` listener pattern in `web/src/lib/tauri-bridge.ts`).

In-process data flow (final):

1. Renderer `armWakeWord()` → `wake_status` (IPC) → if available and not
   listening → `wake_start {surface:'gui', client_capture:true, persist?}`.
2. Rust builds engine, opens external-audio mode, returns
   `{started, phrase, provider, capture, sample_rate:16000, frame_length}`.
3. Renderer starts `client-capture.ts`, pushes base64 PCM batches →
   `wake_feed`.
4. Rust `process()` detects → cooldown check → emit `wake.detected` event.
5. Renderer handler (port of `apps/desktop/src/app/contrib/wiring.tsx:692-719`):
   stop client capture, play wake sound, optional profile routing, then start a
   fresh session + voice conversation (`use-mic-recorder`).
6. Before opening the voice mic: `wake_pause` (barrier, port of
   `use-composer-voice.ts:217-231`); after the turn: `resumeWakeAfterVoice`
   (resume → status verify → re-arm, port of `wake-word.ts:342-402`).

CLI/TUI scope: the CLI and TUI keep using Core's Python `tools/wake_word.py`
via `tui_gateway` (`/wake` in `ui-tui/src/app/slash/commands/wake.ts`) — they
are out of scope for the standalone desktop and are **not** rewritten here; the
port decision recorded is: GUI in-process, CLI/TUI unchanged on the Python
side. Interop: the Rust detector must honor the same machine-wide
`~/.hermes/runtime/wake-word.lock` (`_acquire_machine_lock` in
`tools/wake_word.py:1285`) so a concurrently running `hermes --tui` cannot open
the same mic (details in §9).

## 4. Data models & persistence

No new DB tables. Persistence is the existing per-profile `config.yaml`
`wake_word:` section (already in `hermes_cli/config_defaults.py`); the toggle
**is** the config — only explicit gestures (`persist: true`) flip
`wake_word.enabled`.

- Defaults to freeze (from `tools/wake_word.py` `_DEFAULTS`): `enabled:false`,
  `surface:'auto'`, `capture:'auto'`, `provider:'openwakeword'` (Python
  default; desktop in-process default becomes sherpa — see §9),
  `phrase:'hey hermes'`, `sensitivity:0.6`, `confirmation_frames:3`,
  `start_new_session:true`, `openwakeword.model:'hey_hermes'`,
  `openwakeword.inference_framework:''`, `porcupine.keyword:'jarvis'`.
- Runtime state (in-memory only): `WakeWordState` atom
  (`available|enabled|listening|notice|pending|phrase`) — same shape as the
  predecessor Electron store; no IndexedDB/SQLite.
- Protocol types: add zod schemas to
  `D:/Hermes-CN-Desktop/packages/protocol/src/` (new `wake.ts`, re-exported
  from `index.ts`): `WakeStatusResponse`, `WakeStartResponse`,
  `WakeStopResponse`, `WakeInputDeviceStatus`, `WakeDetectedEvent`
  (`{phrase, profile: string|null, start_new_session: boolean}`). Today
  `packages/protocol/src/hermes-api.ts` only has REST audio schemas
  (`AudioTranscriptionResponse` etc.); wake RPC types currently live only in the
  old desktop store.
- Model artifacts on disk: reuse `$HERMES_HOME/cache/wakewords/` for the sherpa
  KWS model (same path as `_sherpa_model_root()`, so a model fetched by Python
  CLI/TUI is shared with the desktop and vice versa). Bundled `hey_hermes.onnx/
  .tflite` stays in Core only if we implement the openWakeWord engine (§5).
- Migration: config stays in the same YAML; no schema migration needed. The
  `wake_word` keys are additive/back-compatible.

## 5. Third-party library strategy

The most important section. **Verified: `D:/kimi-code` has 0 matches** for
`wake word|hotword|porcupine|openwakeword|sherpa`; the only audio hit in the
whole monorepo is a bundled vendor rive animation asset under
`apps/kimi-code/dist-web/assets/` — no agent audio-capture code, no engine.
So there is **no kimi-code TS equivalent** for any engine; the design comes from
the Core Python source plus the predecessor Electron desktop (Core
`apps/desktop/`, package.json shows Electron 40.x — the app Hermes-CN-Desktop
replaces), which is TS but contains **only client capture, no engine**.

| Python dependency (Core) | TS/Rust equivalent | Evidence / decision |
|---|---|---|
| `sounddevice` + `numpy` capture | Browser `getUserMedia` + Web Audio (AudioContext → AudioWorklet/ScriptProcessor, downsample to 16 kHz, int16 LE) | Port `D:/hermes-agent-cn/apps/desktop/src/lib/wake-client-capture.ts` (downsampleTo16k/floatToInt16LE/bytesToBase64/queue); reuse `web/src/hooks/use-mic-recorder.ts` patterns. kimi-code: none. |
| `sherpa_onnx` (open vocabulary KWS) | **sherpa-onnx Rust crate** in `src/` (same upstream k2-fsa/sherpa-onnx, same model files) | No TS port exists; Rust sidecar is the natural fit (native CPU, Tauri IPC, same model artifacts as Python). Verify crate name/version at impl time. |
| `openwakeword` (ONNX/tflite) | From scratch: onnxruntime-web in renderer (run `melspectrogram.onnx` → `embedding.onnx` → `hey_hermes.onnx` graphs) OR `ort` (onnxruntime) crate in Rust | openWakeWord is Python-only; graph pipeline must be re-implemented. tflite backend (macOS ARM64 fix, openWakeWord#336) needs `@tensorflow/tfjs-tflite` or is skipped in favor of sherpa. Mark as secondary engine; **risk**: high. |
| `pvporcupine` | `@picovoice/porcupine-web` + `@picovoice/web-voice-processor` (renderer) or Porcupine Rust binding | Official Picovoice web SDK exists on npm — verify availability/pricing; premium, needs access key; optional third engine. kimi-code: none. |
| `threading`/`queue` detector loop | Rust thread + bounded queue (`std::sync::mpsc`/VecDeque); renderer `requestAnimationFrame`/AudioWorklet | Direct port of `WakeWordDetector._run` + `feed()` (split/pad to `frame_length`). |
| YAML config (`pyyaml`) | `serde_yaml 0.9` | Already in `D:/Hermes-CN-Desktop/Cargo.toml` (line 21) — no new dep. |
| WS JSON-RPC transport (`wake.*`) | Tauri IPC commands + `app.emit` event | Existing pattern: `web/src/lib/tauri-bridge.ts` invokes commands and listens to `@tauri-apps/api/event` (used by `onSystemResume`). |

Because no TS engine exists, the abstraction is mandatory: renderer code must
only know `frame_length` + the `wake_*` surface, never the engine. This keeps
the sherpa (default) ↔ openWakeWord ↔ Porcupine swap behind one interface and
makes stubbed-engine tests trivial.

## 6. Integration with existing Hermes-CN-Desktop frontend

Reuse (already present):

- `web/src/hooks/use-mic-recorder.ts` — getUserMedia, permission-error
  mapping, level meter, silence detection; the voice conversation side. Note:
  it calls `window.hermesDesktop?.requestMicrophoneAccess?.()` which is **only
  declared** in `web/src/lib/runtime.ts:458` — no Rust implementation exists;
  the plan adds a real Tauri command (or macOS entitlement) for it.
- `web/src/lib/voice.ts` + `routes/voice.tsx` — transcribe/speak + voice
  settings page (STT/TTS requirements already surfaced; wake requirements
  `_stt_ready`/`_tts_ready` map to the same config).
- `web/src/lib/tauri-bridge.ts`, `web/src/lib/transport.ts`,
  `web/src/lib/gateway-client.ts` — IPC + HTTP + WS layers; transitional phase
  uses `gateway-client` for `wake.*` RPCs exactly like the predecessor store's
  `gatewayRequester` (with the 180 s `WAKE_START_TIMEOUT_MS` for first-use
  lazy installs).
- `packages/protocol` — zod schemas + IPC types home (new `wake.ts`).
- `src/` Rust side — `AppState`/`state.rs` for detector ownership,
  `src/error.rs` for `WakeWordInUse`-style errors, `main.rs` command
  registration, `Cargo.toml` for the sherpa-onnx crate.
- Session/profile plumbing — `web/src/stores/chat.ts` (fresh session draft) and
  profile switching, used by the `wake.detected` handler for multi-profile
  routing.

New UI: composer ear toggle (in `web/src/components/chat/goose-composer.tsx`,
where the voice control lives today — there is currently **no wake UI** in
Hermes-CN-Desktop; the only `wake` hits in `web/src` are unrelated
sleep/wake-reconnect code). Tooltip surfaces `WakeWordState.notice` (armed /
refused / "mic delivers only silence") like the predecessor.

## 7. Removing the WebSocket dependency (migration path)

API surface to freeze during migration (exact payloads from
`tui_gateway/server.py` and the old store):

- `wake.status {client_capture?, surface?}` →
  `{listening, owned_by_caller, owner_surface, phrase, provider,
  configured_surface, input_device, available, hint, enabled, audio_silent,
  capture, local_input_available, sample_rate, frame_length}` (14658–14723).
- `wake.start {surface, client_capture?, persist?}` →
  `{started, reason?, hint?, phrase, provider, owner_surface?,
  enabled_persisted?, capture, sample_rate, frame_length}` (14452–14598).
- `wake.stop {persist?}` → `{stopped, reason?, disabled_persisted?}`;
  `wake.pause` → `{paused, reason?}`; `wake.resume` → `{resumed, reason?}`.
- `wake.feed {pcm: base64 int16 LE, sample_rate:16000}` → `{fed, reason?}`
  (14728–14764); event `wake.detected {phrase, profile|null, start_new_session}`.

Phases:

- **Phase A (today → bridge):** port the predecessor store +
  `wake-client-capture.ts` into Hermes-CN-Desktop `web/src/lib/wake-word/`,
  wired to `gateway-client` (`wake.*` RPCs, `client_capture:true`). Backend
  unchanged; the desktop gains the ear toggle for the first time.
- **Phase B (in-process behind same interface):** add
  `src/wake_word/` + `src/commands/wake.rs` with a `WakeWordService` whose
  method signatures match the frozen RPC payloads exactly; add an IPC transport
  behind the same `WakeRequester` shape, so the store is untouched when it
  switches `request('wake.start')` → `invoke('wake_start')`.
- **Phase C (delete WS path):** remove `wake.*` calls from `web` (gateway
  client usage for wake), remove the `wake.pause/resume` round-trips around
  voice; Python `tools/wake_word.py` + `tui_gateway` wake methods stay in Core
  for CLI/TUI/gateway but the desktop no longer uses them. Keep the machine
  lock file so the two worlds don't fight over the mic.

## 8. Migration phases & task breakdown

1. **Phase A1 — store + UI:** port `wake-word.ts` store (Jotai atom; keep
   `applyWakeStatus/Start/Stop`, `toggleWakeWord`, `armWakeWord`,
   `resumeWakeAfterVoice`, `WAKE_START_TIMEOUT_MS=180_000`); add zod wake
   types to `packages/protocol/src/wake.ts`; add ear toggle in
   `goose-composer.tsx`.
2. **Phase A2 — client capture:** port `wake-client-capture.ts` with WS
   `wake.feed` requester; wire `wake.detected` handler (stop feed, wake sound,
   profile routing, fresh session + voice via `use-mic-recorder`);
   `wake.pause` barrier + `resumeWakeAfterVoice` in the voice conversation
   hook (port `use-composer-voice.ts:125-239`).
3. **Phase B1 — Rust engine abstraction:** `src/wake_word/mod.rs` trait +
   `WakeWordDetector` + frame queue + silence/cooldown/confirmation logic;
   unit tests with stub engines.
4. **Phase B2 — sherpa engine:** add sherpa-onnx crate; model ensure/download
   under `$HERMES_HOME/cache/wakewords/`; keywords-file generation +
   per-profile routing (`enrolled_profile_phrases` equivalent); sensitivity
   mapping.
5. **Phase B3 — Tauri commands:** `commands/wake.rs` + `AppState` wiring +
   `generate_handler!`; `wake.detected` event emit; `wake_feed` base64 decode +
   size cap (64 KB) + rate check.
6. **Phase B4 — transport switch:** `WakeRequester` backed by IPC;
   store/UI unchanged; keep WS path behind a flag during rollout.
7. **Phase C — cleanup:** remove WS wake calls; delete dead paths; document
   CLI/TUI interop (lock file); update `tauri.conf.json`/entitlements for mic
   if needed; add `request_microphone_access` command (macOS/Windows privacy).
8. **Phase D — optional engines:** openWakeWord (onnxruntime-web/ort) and
   Porcupine behind the same trait; settings UI for provider/sensitivity/
   phrase/confirmation_frames in `routes/voice.tsx`.

## 9. Risks & open questions

- **No TS equivalent found (highest risk):** kimi-code has zero wake-word code,
  and even the predecessor Electron desktop only implements client capture —
  the engines are Python-only. sherpa-onnx Rust crate is the only engine with a
  near-1:1 upstream parity story; openWakeWord needs a from-scratch ONNX graph
  pipeline (melspectrogram → embedding → classifier) with high effort and the
  macOS ARM64 onnx bug (openWakeWord#336) ported over; Porcupine web SDK needs
  npm/price verification. Recommend sherpa as the desktop default.
- **Default provider divergence:** Python defaults to openWakeWord, desktop
  in-process defaults to sherpa (parity in behavior, not in default). Decide
  whether to ship openWakeWord first to keep config semantics identical.
- **Machine-wide lock interop:** Rust must acquire/release the same
  `~/.hermes/runtime/wake-word.lock` (Windows `msvcrt.locking`, POSIX `flock`)
  to coexist with Python CLI/TUI surfaces; verify cross-process semantics from
  Rust.
- **Mic permissions:** `requestMicrophoneAccess` is a declared-but-unimplemented
  shim; macOS needs the app/backend TCC grant and the webview
  entitlement/capability; Windows silent-mic diagnostics depend on
  `input_device` config that the in-process Rust side must replicate.
- **Always-on cost:** 16 kHz int16 ≈ 32 KB/s IPC plus native inference;
  battery/CPU on laptops; privacy indicator expectations (off by default).
- **AudioWorklet vs ScriptProcessor:** ScriptProcessor is deprecated; the
  predecessor uses it (4096 buffer) — plan an AudioWorklet port for the
  renderer capture.
- **Wake→voice mic race:** pause-before-getUserMedia barrier and
  resume-with-retry must be ported exactly (`wake.pause` round-trip latency was
  a real bug source on Windows).
- **Model download:** sherpa model ~13 MB one-time download; China-mirror /
  offline consideration for `$HERMES_HOME/cache/wakewords/` (consistent with
  the repo's China-mirror release concerns); first `wake.start` may take
  minutes (180 s timeout).
- **Open questions:** sherpa-onnx crate name/version on crates.io; onnxruntime
  crate licensing/size; whether `packages/protocol` should own wake RPC types
  or keep them local to `web/src/lib/wake-word` (recommend protocol for
  e2e/IPC reuse); whether voice pipeline (STT/TTS) will also move in-process in
  a later feature (wake depends on it, so requirements gating needs a stub).

## 10. Test strategy

- **Vitest unit (web):** port cases from
  `apps/desktop/src/store/wake-word.test.ts` (status/start/stop/arm/
  resume-after-voice reducers, pending guard, reason mapping); client-capture
  downsample/queue coalescing/frame split-pad (mirror `wake-client-capture.ts`
  logic); base64 round-trip; IPC transport vs WS transport parity (same fake
  responses).
- **Rust unit (`#[cfg(test)]` in `src/wake_word/`):** engine trait dispatch,
  sherpa keywords-file generation + `last_match` routing, frame queue
  split/pad/drop-oldest, silence flag + recovery, cooldown, confirmation
  streak, lock-file acquire/release (use `tempfile::TempDir` +
  `#[serial_test::serial]` per AGENTS.md), base64 decode + 64 KB cap.
- **Integration (Rust, `tests/`):** Tauri command tests with a stub engine
  (no real mic/model) covering `wake_start/stop/pause/resume/status/feed`
  payload parity against the frozen RPC shapes; `wake.detected` event emit.
- **Parity vs Python:** map `tests/tools/test_wake_word.py` cases to TS/Rust:
  config defaults/clamping, sensitivity mapping (sherpa `0.05+0.4*s`,
  porcupine inversion), `confirmation_frames`, `resolve_capture_mode`
  auto/local/client + prefer_client, `wake_surface_enabled` gate, owner-only
  `feed_audio`, startup/stream failure releasing owner + lock.
- **Playwright E2E (`e2e/`):** toggle ear → `wake_start` (stubbed engine IPC or
  fake model) → listening state; `wake.detected` → fresh session + voice
  permission flow; remote mode (`capture: client`) with `wake_feed`; off by
  default (toggle hidden/unmounted when `available:false`).

## 11. Reference links

- `D:/hermes-agent-cn/tools/wake_word.py` — engines, detector, singleton,
  client feed, requirements probe.
- `D:/hermes-agent-cn/tools/wakewords/README.md` (+ `hey_hermes.onnx`/
  `.tflite`).
- `D:/hermes-agent-cn/website/docs/user-guide/features/wake-word.md`.
- `D:/hermes-agent-cn/tests/tools/test_wake_word.py`.
- `D:/hermes-agent-cn/tui_gateway/server.py` lines 14341–14764 (wake.*
  RPCs, `wake.detected`).
- `D:/hermes-agent-cn/hermes_cli/config_defaults.py` (~1671) —
  `wake_word` defaults; `cli-config.yaml.example:58`.
- Predecessor Electron desktop (TS client reference):
  `D:/hermes-agent-cn/apps/desktop/src/store/wake-word.ts`,
  `apps/desktop/src/lib/wake-client-capture.ts`,
  `apps/desktop/src/store/wake-word.test.ts`,
  `apps/desktop/src/app/contrib/wiring.tsx:692`,
  `apps/desktop/src/app/chat/composer/hooks/use-composer-voice.ts:125-239`,
  `apps/desktop/src/app/session/hooks/use-prompt-actions/slash.ts:670-734`.
- `D:/kimi-code` — **verified 0 matches** for wake/hotword/porcupine/
  openwakeword/sherpa; no audio capture code (only a vendor rive asset in
  `dist-web/`).
- Hermes-CN-Desktop: `web/src/hooks/use-mic-recorder.ts`, `web/src/lib/voice.ts`,
  `web/src/lib/runtime.ts:448-458`, `web/src/lib/tauri-bridge.ts`,
  `web/src/lib/gateway-client.ts`, `web/src/components/chat/goose-composer.tsx`,
  `packages/protocol/src/hermes-api.ts`, `src/commands/*`, `src/state.rs`,
  `src/error.rs`, `src/main.rs`, `Cargo.toml`, `tauri.conf.json`.
