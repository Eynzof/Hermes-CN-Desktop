# Voice Mode — Python → TypeScript Rewrite Plan

## 1. Summary

Port the Python **voice mode** feature set into the TypeScript desktop runtime so it runs
in-process (no WebSocket link / REST round-trip to the managed Python backend). Scope:

- **Push-to-talk & continuous voice chat in the app**: `/voice` toggle + **Ctrl+B**
  record key, beeps (880/660 Hz), silence auto-stop, auto-restart loop, three
  consecutive no-speech cycles end the chat, spoken **"stop"** phrase ends the chat,
  live audio-level meter in the composer.
- **Silence detection / VAD**: two-stage RMS algorithm (speech confirmation ≥0.3 s,
  end after 3.0 s silence, 15 s no-speech abort, hard `max_recording_seconds` cap),
  plus a full-duplex barge-in listener that stays armed from utterance submit until
  the reply + TTS finish (generation-phase speech interjects the turn; playback-phase
  speech cuts TTS and captures the interruption).
- **Streaming TTS**: text deltas → sentence chunker → per-sentence synthesis →
  Web Audio playback with barge-in stop; provider-agnostic (streaming providers play
  PCM chunks, others synthesize per sentence with overlap).
- **STT providers**: local faster-whisper (offline), Groq Whisper, OpenAI Whisper —
  with credential-pool resolution (config > env/.env > `hermes auth` pool).
- **Hallucination filter, TTS-echo guard, stop phrase** — parity ports from Python.
- **Telegram/Discord auto voice replies and Discord voice-channel live conversation**
  are messaging-gateway features; **out of scope for desktop standalone** (see §9) —
  recorded here so the port decision is explicit.

Existing desktop surface already covers the settings half: `web/src/routes/voice.tsx`
(STT/TTS provider config, test recording / test TTS), `web/src/lib/voice.ts` /
`web/src/lib/voice-config.ts`, `web/src/hooks/use-mic-recorder.ts` (MediaRecorder +
AnalyserNode metering), and a composer mic button in
`web/src/components/chat/goose-composer.tsx`. This plan keeps those and replaces their
backend REST/WS dependency with in-process modules.

## 2. Current Python implementation

Source of truth: `D:/hermes-agent-cn`.

| File | Role |
|------|------|
| `tools/voice_mode.py` (2387 lines) | `AudioRecorder` (sounddevice `InputStream`, 16 kHz mono int16, RMS `SILENCE_RMS_THRESHOLD=200`, `SILENCE_DURATION_SECONDS=3.0`, `_min_speech_duration=0.3`, `_max_dip_tolerance=0.3`, `_max_wait=15.0`, `_max_recording_seconds` cap, live `current_rms` meter); `TermuxAudioRecorder`; `create_audio_recorder()`; beeps (`play_beep` 880/660 Hz, `beep_enabled`/`beep_volume`); `is_whisper_hallucination` (26 phrases + repeat regex); `is_voice_stop_phrase` (strict whole-utterance match, `voice.stop_phrases`, default `("stop",)`); `is_tts_echo` (char-level `difflib.SequenceMatcher` ratio ≥0.6 + sliding fragment window, min fragment 10 chars); `transcribe_recording()` (delegates to `transcription_tools.transcribe_audio`, hallucination filter, oversized-WAV chunking); `stop_playback()`; `play_audio_file()` (sounddevice WAV / `afplay` / `ffplay` / `aplay` / WSL PowerShell fallback); `listen_for_speech()` (barge monitor, rolling 90th-pct floor, 8× multiplier, 4000 RMS ceiling); `full_duplex_listen()` (quiet-room calibration, `DEFAULT_BARGE_MULTIPLIER=3.0`, `PLAYBACK_MIN_TRIGGER=1500`, `TRIGGER_CEILING=4000`, 500 ms grace, 80% windowed majority, 1200 ms pre-roll, 1250 ms endpoint, 30 s max); `check_voice_requirements()`; `cleanup_temp_recordings()`. |
| `hermes_cli/voice.py` (1060 lines) | Process-wide stateful API: `voice_record_key_from_config` / `normalize_voice_record_key_for_prompt_toolkit` / `format_voice_record_key_for_status` (Ctrl+B default, `c-b`); push-to-talk `start_recording()` / `stop_and_transcribe()`; continuous `start_continuous(on_transcript,on_status,on_silent_limit,on_stop_phrase, silence_threshold, silence_duration, auto_restart, max_recording_seconds)` with `_continuous_on_silence()` (waits for `_tts_playing`, re-arms mic, 3-strike no-speech limit, stop-phrase signal); `speak_text()` (cancels live capture, `_tts_playing` event, markdown strip via `tools/tts_text_normalize.prepare_spoken_text`, sync + streaming dispatch); `_speak_text_streaming()` → `tools.tts_tool.stream_tts_to_speaker`. |
| `tools/transcription_tools.py` (~3300 lines) | STT dispatch: provider auto-detect `local > groq > openai > mistral > xai > elevenlabs > deepinfra > command > plugin`; credential resolution `tools/tool_backend_helpers.resolve_provider_secret(env_var, provider_id)` (config > env/.env > `hermes auth` credential pool) — see `tests/tools/test_voice_credential_pool_resolution.py`; `_transcribe_local()` (faster-whisper model load, idle-unload watcher, confidence threshold, hallucinated-segment filter); `_transcribe_groq()` (`GROQ_API_KEY`, OpenAI SDK against `api.groq.com`, default `whisper-large-v3-turbo`); `_transcribe_openai()` (`VOICE_TOOLS_OPENAI_KEY` preferred over `OPENAI_API_KEY`, default `whisper-1`); `transcribe_audio()` (file-safety guard, ffmpeg prep, size gates, cloud silence trim, chunking); `transcribe_audio_local_fallback()`. |
| `tools/tts_tool.py` (~4200 lines) | Providers: edge / openai / elevenlabs / deepinfra / xai / minimax / mistral / gemini / neutts / kittentts / piper / command / plugin. `text_to_speech_tool()` (normalize → split to provider caps → sequential synth → `[[audio_as_voice]]` MEDIA tag, OGG/Opus conversion for Telegram); `_SyncSentencePipeline` (pipelined per-sentence synthesis while previous plays); `stream_tts_to_speaker(text_queue, stop_event, tts_done_event)` — `SentenceChunker` from `tools/tts_streaming.py`, streaming providers (ElevenLabs/OpenAI) play chunked PCM via sounddevice `OutputStream`, everything else per-sentence sync; `stop_event` = barge-in abort. |
| `tools/tts_streaming.py`, `tools/tts_text_normalize.py` | `SentenceChunker` / `resolve_streaming_provider`; `prepare_spoken_text` (markdown/emoji/think-block stripping). |
| `hermes_cli/web_server.py` | Desktop REST/WS API today: `POST /api/audio/transcribe` (base64 data_url → `transcribe_recording`), `POST /api/audio/speak` (TTS → base64 data_url), `GET /api/audio/elevenlabs/voices`, `WS /api/audio/speak-stream` (client `{text}`/`{done}`/`{stop}`, server `{type:"start",sample_rate,channels}` + binary PCM + `{type:"end"}` / `{type:"fallback"}`). |
| `hermes_cli/config_defaults.py` | `voice` section defaults: `record_key: ctrl+b`, `submit_mode: direct`, `max_recording_seconds: 120`, `auto_tts: false`, `beep_enabled: true`, `beep_volume: 0.3`, `thinking_sound: true`, `silence_threshold: 200`, `silence_duration: 3.0`, `barge_in: true`, `barge_in_grace_seconds: 0.5`, `barge_in_threshold_multiplier: 3.0`, `stop_phrases: ["stop"]`. |
| `gateway/run.py`, `gateway/platforms/base.py` | Messaging auto voice reply: `/voice on|tts|off|status` per chat, persisted `~/.hermes/gateway_voice_mode.json` (`off|voice_only|all`); `_should_send_voice_reply` (voice_only requires voice input, all fires always); `send_voice` (Telegram Opus/OGG bubble, Discord native voice bubble, attachment fallback); `StreamingTTSConsumer`; Discord VC: `_handle_voice_channel_join/leave/input`, `join_voice_channel` / `play_in_voice_channel`, mixer, PyNaCl Opus (see `tests/gateway/test_discord_voice_mixer.py`, `tests/integration/test_voice_channel_flow.py`). |

Data flow (today): mic capture → WAV/tempfile → `transcribe_recording` → transcript →
agent turn → reply text deltas → `stream_tts_to_speaker` (or `speak_text` whole-file) →
sounddevice playback; the desktop reaches all of this over `/api/audio/*` REST + the
speak-stream WS (both served by `hermes_cli/web_server.py` inside the managed runtime).

## 3. Target TypeScript design

Module layout (renderer-owned voice engine under `web/src/lib/voice/`, wire types in
`packages/protocol`, Rust only for OS-level mic permission + optional local-STT sidecar):

```
web/src/lib/voice/
  vad.ts                # two-stage silence detector + full-duplex barge VAD (port of AudioRecorder._callback / full_duplex_listen)
  recorder.ts           # MediaRecorder capture + 16 kHz PCM path (AudioWorklet) + level meter (extends hooks/use-mic-recorder.ts)
  playback.ts           # Web Audio PCM/encoded playback queue, stop()/barge-in, beeps (880/660 Hz)
  sentence-chunker.ts   # SentenceChunker port (text deltas -> complete sentences)
  stt.ts                # STT client interface: local (sidecar/WASM), groq, openai + provider resolution
  stt-local.ts          # faster-whisper shim: Rust sidecar IPC or transformers.js WASM (see §5)
  tts.ts                # TTS provider clients: openai, elevenlabs, edge, local (sidecar) + credential resolution
  tts-stream.ts         # streamSpeak(textQueue, stopSignal, doneSignal) port of stream_tts_to_speaker
  stop-phrase.ts        # isVoiceStopPhrase / voiceStopHint port
  echo-guard.ts         # isTtsEcho port (char similarity + sliding window)
  hallucination.ts      # isWhisperHallucination port (phrase list + repeat regex)
  requirements.ts       # checkVoiceRequirements() equivalent (mic permission, provider availability)
  controller.ts         # VoiceModeController: push-to-talk + continuous loop + barge-in state machine
web/src/hooks/use-voice-mode.ts   # React hook binding controller to chat store / composer
web/src/components/chat/voice-*.tsx  # voice chat toolbar, live level bar, recording timer, status chips
packages/protocol/src/hermes-api.ts  # VoiceModeState, VoiceTurnResult, StreamSpeech types (local-only, no wire changes needed for final state)
src/commands/whisper.rs    # NEW optional Rust sidecar: whisper.cpp STT (see §5)
src/commands/voice_perm.rs # mic permission + device query (Tauri) — requestMicrophoneAccess already exists via tauri-bridge
```

Core interfaces:

```ts
interface VadConfig { silenceThreshold: number; silenceDurationMs: number; minSpeechMs: number;
                      maxDipToleranceMs: number; maxWaitMs: number; maxRecordingSeconds: number; }
interface VadEvents { onLevel(rms: number): void; onSilenceStop(): void; }

interface SttProvider { id: "local" | "groq" | "openai";
  transcribe(pcm: Int16Array | Blob, opts: { language?: string; prompt?: string }): Promise<{ transcript: string; provider: string }>; }
interface TtsProvider { id: "openai" | "elevenlabs" | "edge" | "local";
  stream(textQueue: AsyncIterable<string>, stop: AbortSignal, onChunk: (pcm: Int16Array, sampleRate: number) => void): Promise<void>; }

class VoiceModeController {  // mirrors hermes_cli/voice.py + tui_gateway wiring
  startContinuous(opts: { onTranscript(t): void; onStatus(s): void; onStopPhrase(p): void; onSilentLimit(): void }): Promise<boolean>;
  stopContinuous(forceTranscribe?: boolean): Promise<void>;
  startPushToTalk(): Promise<void>; stopPushToTalkAndTranscribe(): Promise<string | null>;
  bargeIn(): void; // playback-phase: cut TTS + capture interruption
}
```

Runtime flow (in-process, no Python):
1. User toggles `/voice` (or Ctrl+B push-to-talk). `VoiceModeController` requests mic
   via `window.hermesDesktop.requestMicrophoneAccess()` then opens `getUserMedia`.
2. Capture: `AudioWorkletProcessor` downmixes to 16 kHz mono int16 (whisper-native)
   and pushes PCM into the VAD + a rolling pre-roll ring buffer. The existing
   `AnalyserNode` metering (in `use-mic-recorder.ts`) drives the level bar; the VAD
   replaces its threshold/silence logic with the Python two-stage algorithm.
3. On silence-stop: WAV/PCM → `stt.ts` (local sidecar / Groq / OpenAI) →
   hallucination filter → stop-phrase check (strict match ends chat) →
   `onTranscript`.
4. Agent reply: text deltas are fed into `sentence-chunker.ts` →
   `tts-stream.ts` → Web Audio playback. `vad.ts` stays armed full-duplex:
   generation-phase speech interrupts the turn; playback-phase speech cuts audio,
   captures the interruption (pre-roll + endpoint), echo-guard drops TTS bleed, and
   the captured utterance becomes the next turn.
5. Status events (`listening|transcribing|idle`) drive the composer UI; three silent
   cycles or a spoken "stop" end the chat.

## 4. Data models & persistence

- **Config** (profile `config.yaml`, already written by `use-config` / `use-env` from
  `web/src/routes/voice.tsx`): port the full `voice:` section keys from
  `hermes_cli/config_defaults.py` — `record_key` (default `ctrl+b`), `submit_mode`,
  `max_recording_seconds` (120), `auto_tts`, `beep_enabled`, `beep_volume`,
  `thinking_sound`, `silence_threshold` (200), `silence_duration` (3.0),
  `barge_in`, `barge_in_grace_seconds`, `barge_in_threshold_multiplier`,
  `stop_phrases` (`["stop"]`); plus `stt.provider` / `stt.local.model` /
  `stt.groq.model` / `stt.openai.model` and `tts.provider` (already modeled in
  `web/src/lib/voice-config.ts`). `voice.max_recording_seconds` is already read
  client-side by `voiceMaxRecordingSecondsFromConfig` (`web/src/lib/voice.ts`).
- **Per-chat messaging voice mode** (`off|voice_only|all`, `gateway_voice_mode.json`):
  **out of scope** — lives only in the gateway process (§9). The desktop `/voice`
  toggle persists its own in-app `VoiceModeState` (Jotai atom or profile config).
- **Runtime state** (in-memory, no new schema): controller status
  `idle|recording|transcribing|listening|speaking`, no-speech counter (3-strike),
  `_ttsPlaying` flag, quiet-room floor calibration, active reply's spoken-text buffer
  (for echo guard). No SQLite/IndexedDB migration needed — voice leaves no durable
  message records beyond the existing chat store; temp audio is in-memory PCM or a
  temp file cleaned like `cleanup_temp_recordings`.

## 5. Third-party library strategy

Searched `D:/kimi-code` for `voice`, `stt`, `whisper`, `mediaRecorder`,
`getUserMedia`, `AudioContext`, `SpeechRecognition` (source only, excluding
`dist`/`node_modules`): **no equivalent TS implementation exists** — zero matches in
`packages/agent-core`, `apps/kimi-code/src`, or any package.json dependency list
(only false positives in bundled `dist-web/assets/*.js` and unrelated words).
Therefore §5 relies on web-platform knowledge; where no TS lib exists we design a
thin shim, exactly as the README requires.

| Python dependency | TS equivalent | Evidence / design |
|---|---|---|
| `sounddevice` + `numpy` (capture/playback) | **Web Audio API**: `getUserMedia` + `AudioContext` + `AnalyserNode` + `AudioWorklet`; playback via `AudioBufferSourceNode`/`ScriptProcessor` for PCM | Already proven in `web/src/hooks/use-mic-recorder.ts` (MediaRecorder + analyser RMS meter). kimi-code: none. Implement from scratch — extend the hook with a 16 kHz int16 AudioWorklet path and a Web Audio playback queue (`web/src/lib/voice/playback.ts`). |
| `faster-whisper` (local STT) | **No JS/WASM direct port of faster-whisper** (CTranslate2). Two shims: (a) Tauri **Rust sidecar** wrapping `whisper.cpp` (`whisper-rs`), invoked via new `src/commands/whisper.rs` IPC — model cache under profile dir, mirrors Python's auto-download + idle-unload; (b) **transformers.js** (`@huggingface/transformers`) WASM with a Whisper pipeline — pure-renderer fallback, slower, no IPC. Recommend (a) first for parity with Python's faster-whisper speed; keep the `stt.local.model` choice (tiny/base/small/medium/large-v3) | kimi-code: none found. Design the thin shim interface `SttProvider` (`web/src/lib/voice/stt-local.ts`) so both backends swap behind it. |
| `openai` SDK (`_transcribe_groq` / `_transcribe_openai`) | **Plain `fetch` multipart/form-data** REST clients (`POST https://api.groq.com/openai/v1/audio/transcriptions`; `POST https://api.openai.com/v1/audio/transcriptions`) — no SDK needed | kimi-code: none. Implement from scratch in `stt.ts` (`stt-groq.ts`/`stt-openai.ts`). Credentials: reuse desktop profile `.env` via existing `use-env`/Rust `env_file` commands (no `resolve_provider_secret` equivalent needed in-process — the renderer never sees keys stored in the profile). |
| `edge-tts` (default TTS) | **No stable npm client**; Edge TTS is an undocumented MS endpoint. Options: (a) keep as Rust sidecar fetch (REST `speech.platform.bing.com`); (b) default TTS = OpenAI/ElevenLabs or local sidecar and show "edge unavailable" like today's `voiceErrorMessage`. | kimi-code: none. Design `TtsProvider` interface in `tts.ts`; Edge is optional phase-3 provider. |
| `elevenlabs` / OpenAI TTS (`tools/tts_streaming.py` chunked PCM) | Plain REST: ElevenLabs `POST /v1/text-to-speech/{voice_id}/stream` (PCM chunks), OpenAI `POST /v1/audio/speech` (pcm/opus) — `fetch` + Web Audio playback; SentenceChunker port | kimi-code: none. `web/src/lib/voice/tts-stream.ts` implements the same `stream_tts_to_speaker` contract (queue in → PCM out, `AbortSignal` for barge-in). |
| `piper` / `neutts` / local TTS | Out of initial scope; if needed, same Rust-sidecar pattern as whisper.cpp (piper-rs) or keep provider list minimal (OpenAI/ElevenLabs/Edge) | kimi-code: none. Record as follow-up. |
| `discord.py[voice]` (PyNaCl/Opus) | **Out of scope** — Discord voice channel is a gateway-process feature (see §9) | Not ported to desktop. |
| `python-telegram-bot` / Discord text bots | **Out of scope** — messaging adapters stay in the gateway | Not ported to desktop. |
| `difflib.SequenceMatcher` (TTS echo guard) | Implement from scratch: character-level similarity via LCS/ratio on normalized strings + sliding fragment window (port `is_tts_echo`) | kimi-code: none. `web/src/lib/voice/echo-guard.ts`. |
| `wave` / ffmpeg transcode | Web Audio `decodeAudioData` + `AudioWorklet` PCM export; no ffmpeg needed in renderer | Already covered by MediaRecorder blob → decode path. |

## 6. Integration with existing Hermes-CN-Desktop frontend

Reuse (existing, verified):
- `web/src/hooks/use-mic-recorder.ts` — keep as capture/metre base; add the 16 kHz
  AudioWorklet PCM tap and the Python VAD thresholds; keep `micError` mapping and
  `requestMicrophoneAccess` gate.
- `web/src/lib/voice.ts` — keep `sanitizeTextForSpeech`, `voiceErrorMessage`,
  `voiceMaxRecordingSecondsFromConfig`; replace `transcribeAudioBlob` /
  `speakText` bodies with in-process `stt.ts` / `tts.ts` behind the same signatures
  (phase migration, §7).
- `web/src/lib/voice-config.ts` — provider metadata stays; add missing `voice.*`
  keys (`record_key`, `silence_*`, `barge_in_*`, `stop_phrases`) to the draft/save.
- `web/src/routes/voice.tsx` + `/voice` route in `web/src/app.tsx` +
  `capability-sidebar.tsx` 语音 entry — extend settings with VAD/barge-in/stop-phrase
  fields; keep test STT/TTS buttons (now hitting local modules).
- `web/src/components/chat/goose-composer.tsx` — replace the fixed timer stop with
  VAD `onSilence` auto-stop, add `onStopPhrase`/`onSilentLimit` handling, add
  `voiceStatus` "listening"/"speaking" states (already has idle/recording/transcribing).
- `packages/protocol/src/hermes-api.ts` — `AudioTranscriptionResponse` /
  `AudioSpeakResponse` remain for the migration bridge; add local-only
  `VoiceModeState`/`VoiceTurnResult` types.
- Rust: `src/commands/ws_proxy.rs` (relay), `src/commands/api_proxy.rs` (HTTP proxy),
  `src/commands/gateway.rs` (runtime URL) are the WS/REST path to remove; keep
  `src/commands/notify.rs` for voice-chat events (e.g. "voice chat ended"); add
  `src/commands/whisper.rs` for the local-STT sidecar.
- Gateway WS (`web/src/lib/gateway-client.ts`) is untouched for non-voice features;
  voice no longer depends on it.

## 7. Removing the WebSocket dependency (migration path)

Freeze the API surface that migration preserves (implemented today in
`hermes_cli/web_server.py`):
- `transcribe(blob: Blob) -> { transcript, provider }` (today `POST /api/audio/transcribe`)
- `speak(text) -> { data_url }` (today `POST /api/audio/speak`)
- `streamSpeak(textDeltas, stop) -> PCM` (today `WS /api/audio/speak-stream`)

Phases:
1. **Bridge (today)**: desktop keeps calling `/api/audio/*` through `transport.ts`
   (`api_proxy.rs`); no behavior change. Introduce `web/src/lib/voice/*` interfaces
   with a `BackendVoiceAdapter` implementing them via the existing REST/WS calls.
2. **In-process STT**: implement `stt.ts` + `stt-local.ts` (sidecar) + Groq/OpenAI
   fetch clients; behind the same `transcribe()` signature. Feature-flag per provider:
   local/Groq/OpenAI go in-process; `transcribeAudioBlob` keeps the backend adapter
   only as fallback during the switch.
3. **In-process TTS**: implement `tts.ts` + `tts-stream.ts` + `playback.ts`;
   `streamSpeak` switches to Web Audio; remove the `/api/audio/speak-stream` WS
   consumer.
4. **Delete backend path**: drop `POST /api/audio/transcribe`,
   `POST /api/audio/speak`, `WS /api/audio/speak-stream` usage from
   `web/src/lib/voice.ts`; retire `api_proxy.rs`/`ws_proxy.rs` relay when no other
   feature needs it. The managed Python runtime then runs only for non-ported
   features; voice works with the runtime stopped.

## 8. Migration phases & task breakdown

1. **Phase 0 — parity unit ports (pure TS)**: `vad.ts`, `stop-phrase.ts`,
   `echo-guard.ts`, `hallucination.ts`, `sentence-chunker.ts` with vitest parity
   tables copied from `tests/tools/test_voice_mode.py`, `test_voice_stop_phrase.py`,
   `test_voice_tts_echo_guard.py`.
2. **Phase 1 — capture & VAD in renderer**: extend `use-mic-recorder.ts` (16 kHz
   AudioWorklet PCM, Python thresholds, `max_recording_seconds` enforcement) —
   parity vs `TestSilenceDetection`, `TestMaxRecordingCap`, `TestAudioRecorderStop`.
3. **Phase 2 — STT**: `stt.ts` + Groq/OpenAI fetch clients (parity vs
   `test_stt_cloud_trim.py` upload gating, `test_stt_language_resolution.py`
   language rules) and `stt-local.ts` sidecar (whisper.cpp) — parity vs
   `test_stt_silence_hallucinations.py`, `test_stt_idle_unload.py`.
4. **Phase 3 — TTS streaming + playback**: `tts.ts`, `tts-stream.ts`,
   `playback.ts`; provider REST clients (OpenAI/ElevenLabs, edge optional).
5. **Phase 4 — controller + UI**: `controller.ts` (push-to-talk, continuous loop,
   stop-phrase halt, 3-strike limit, barge-in with echo guard), `use-voice-mode.ts`,
   composer toolbar + `/voice` status + Ctrl+B global shortcut
   (`command-palette-shortcut.ts` pattern; renderer `keydown` or Tauri menu
   accelerator).
6. **Phase 5 — migration & cleanup**: switch `voice.ts` calls to in-process modules
   (§7 phases 2–4), remove `/api/audio/*` usage, retire relay path.
7. **Phase 6 — out-of-scope notes**: messaging auto-voice-reply and Discord VC stay
   in the gateway; document in `website/docs/user-guide/features/voice-mode.md`-style
   user docs that in-app voice is desktop-native.

## 9. Risks & open questions

- **No TS equivalent found for local STT/TTS (biggest risk)**: faster-whisper has no
  faithful JS port; a whisper.cpp sidecar adds a binary + model-download story
  (parity with Python auto-download) and doubles Rust surface. transformers.js WASM
  avoids the sidecar but is slower and heavier on first load. Decision needed:
  sidecar-first vs WASM-first.
- **Edge TTS is an unofficial endpoint**; if a stable npm/HTTP client isn't
  acceptable, default TTS in the desktop becomes OpenAI/ElevenLabs/local — a user
  experience change vs Python's free-by-default Edge.
- **Echo cancellation**: Python's full-duplex listener has no AEC and relies on the
  echo guard; Web Audio gives `echoCancellation`/`noiseSuppression` constraints (the
  existing hook already sets them) but speaker bleed behavior in Tauri webview needs
  hardware testing (`HERMES_VOICE_DEBUG` equivalent = a `voiceDebug` flag + level
  stream).
- **Global Ctrl+B**: browser key handling inside the webview can collide with OS/Tauri
  accelerators; needs a Tauri menu-accelerator or webview keydown policy; also
  Python's reserved-keys blocklist (`ctrl+c/d/l`) must be mirrored.
- **MediaRecorder vs AudioWorklet**: MediaRecorder emits compressed WebM/Opus; the
  local sidecar and Web Audio VAD prefer raw PCM. Plan is AudioWorklet tap for VAD +
  PCM, MediaRecorder only for the blob-upload STT path — must confirm webview
  AudioWorklet availability on Windows WebView2 / macOS WKWebView.
- **Out of scope (recorded, not ported)**: Telegram/Discord auto voice replies,
  Discord voice-channel live conversation, `gateway_voice_mode.json` persistence —
  these belong to the gateway process and cannot run "in-process desktop" without
  reimplementing platform clients. `/voice` in the desktop app means the in-app
  conversation only.
- **Open questions**: (1) keep `auto_tts` (auto-read assistant replies) — desktop
  already has this toggle; (2) whether `thinking_sound` ambience is worth porting
  (Web Audio synth blips) — low priority; (3) credential pool (`hermes auth add`)
  integration: read-only resolution in Rust vs renderer env-only.

## 10. Test strategy

- **Vitest unit (parity vs Python tests)**:
  - `vad.test.ts` — two-stage silence, dip tolerance, no-speech 15 s abort,
    `max_recording_seconds` cap (parity: `test_voice_mode.py::TestSilenceDetection`,
    `TestMaxRecordingCap`, `tests/test_voice_max_recording_seconds.py`).
  - `stop-phrase.test.ts` — strict bare-phrase match, punctuation/case variants,
    config `[]` disables, hint text (parity: `test_voice_stop_phrase.py`).
  - `echo-guard.test.ts` — near-verbatim echo, stutter, short-fragment window,
    CJK no-whitespace, threshold honored (parity: `test_voice_tts_echo_guard.py`).
  - `hallucination.test.ts` — known phrases + repeat regex (parity:
    `test_voice_mode.py::TestWhisperHallucinationFilter`).
  - `stt.test.ts` — provider resolution/credential pool, language rules, cloud trim
    gating, local model normalization (parity: `test_voice_credential_pool_resolution.py`,
    `test_stt_cloud_trim.py`, `test_stt_default_language.py`,
    `test_stt_language_resolution.py`, `test_stt_silence_hallucinations.py`).
  - `sentence-chunker.test.ts` — delta buffering, min 20 chars, markdown strip
    (parity: `test_voice_cli_integration.py::TestMarkdownStripping`).
- **Integration (vitest + Playwright E2E)**:
  - Controller state machine: recording→transcribing→idle, 3-strike silent limit,
    stop-phrase halt, TTS-wait re-arm (parity: `test_voice_cli_integration.py`,
    `hermes_cli/voice.py` loop semantics).
  - Barge-in: fake PCM streams; generation-phase interrupt, playback-phase cut +
    capture + echo guard (parity: `TestVoiceBargeCaptureSubmit`,
    `TestVoiceFullDuplexListener`).
  - REST contract tests for the migration bridge: `transcribe`/`speak`/`streamSpeak`
    adapters against a mock backend; then delete-bridge tests after phase 5.
  - Playwright E2E: mic permission flow, composer mic button auto-stop on silence,
    `/voice` toggle UI, Ctrl+B binding (mock `getUserMedia` with synthetic audio).
- **Rust tests**: `src/commands/whisper.rs` sidecar command — model resolution,
  PCM→text smoke (mock binary), error paths (parity: WSL/pipewire env gates are
  Python-only; desktop equivalents covered by `test_voice_wsl_pipewire.py` mapped to
  a `requirements.ts` environment report).
- **Gateway out-of-scope tests kept as-is**: `test_auto_voice_reply_format.py`,
  `test_voice_channel_flow.py`, `test_discord_voice_mixer.py` continue to cover the
  Python gateway; no desktop parity required (documented in §9).

## 11. Reference links

- Python: `D:/hermes-agent-cn/tools/voice_mode.py`,
  `hermes_cli/voice.py`, `tools/transcription_tools.py`, `tools/tts_tool.py`,
  `tools/tts_streaming.py`, `tools/tts_text_normalize.py`,
  `hermes_cli/web_server.py` (`/api/audio/*`), `hermes_cli/config_defaults.py`
  (`voice:` section), `gateway/run.py` + `gateway/platforms/base.py` (messaging
  auto voice reply / Discord VC).
- Docs: `D:/hermes-agent-cn/website/docs/user-guide/features/voice-mode.md`.
- Tests: `tests/tools/test_voice_mode.py`, `test_voice_cli_integration.py`,
  `test_voice_stop_phrase.py`, `test_voice_tts_echo_guard.py`,
  `test_voice_credential_pool_resolution.py`, `test_voice_wsl_pipewire.py`,
  `tests/tools/test_stt_*.py`, `tests/gateway/test_auto_voice_reply_format.py`,
  `tests/integration/test_voice_channel_flow.py`,
  `tests/test_voice_max_recording_seconds.py`.
- Desktop: `D:/Hermes-CN-Desktop/web/src/hooks/use-mic-recorder.ts`,
  `web/src/routes/voice.tsx`, `web/src/lib/voice.ts`, `web/src/lib/voice-config.ts`,
  `web/src/components/chat/goose-composer.tsx`, `web/src/lib/transport.ts`,
  `web/src/lib/gateway-client.ts`, `web/src/lib/tauri-bridge.ts`,
  `web/src/lib/gateway-relay-socket.ts`, `packages/protocol/src/hermes-api.ts`,
  `src/commands/notify.rs`, `src/commands/ws_proxy.rs`, `src/commands/api_proxy.rs`,
  `src/commands/gateway.rs`.
- TS reference: `D:/kimi-code` — **no voice/STT/whisper/MediaRecorder
  implementation found** (verified by source search; only dist false positives).
