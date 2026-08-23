# TTS / Voice Messages — Python → TypeScript Rewrite Plan

## 1. Summary

Move Hermes' text-to-speech (TTS) and voice-message feature from the Python backend
(`D:/hermes-agent-cn`) into the TypeScript frontend monorepo
(`D:/Hermes-CN-Desktop`), so the React webview can synthesize and play audio
in-process without calling the managed Python runtime.

Today the desktop already has a voice UI but **zero in-process TTS**:

- `web/src/lib/voice.ts` calls the Python REST endpoints `POST /api/audio/speak`
  (returns `{ ok, data_url, mime_type, provider }`), `POST /api/audio/transcribe`,
  and `GET /api/audio/elevenlabs/voices`.
- `web/src/components/chat/message-timeline.tsx` plays read-aloud / auto-TTS with
  `new Audio(response.data_url)` — a plain `<audio>` element, no waveform.
- `web/src/routes/voice.tsx` is the settings page (provider picker + API keys).
- `web/src/hooks/use-mic-recorder.ts` covers the **input** side (MediaRecorder + STT).

The rewrite adds: an in-process provider registry covering the 11 providers
(Edge TTS default, ElevenLabs, OpenAI, MiniMax, Mistral Voxtral, Google Gemini,
xAI, DeepInfra, NeuTTS, KittenTTS, Piper) plus user-declared custom command
providers; streaming playback via the Web Audio API; voice-bubble rendering in
chat (audio element + waveform); and the platform voice-bubble delivery contract
(Telegram/Discord/WhatsApp Opus/OGG vs MP3) as a produced-artifact contract.

**Scope note**: actual Telegram/Discord/WhatsApp *upload* adapters are messaging
gateway concerns. The desktop plan defines the artifact format contract and the
delivery-profile logic so future TS gateway adapters can consume the artifacts;
the adapters themselves are marked out-of-scope for desktop standalone (see §7).

## 2. Current Python implementation

Source of truth (all under `D:/hermes-agent-cn`):

| File | Responsibility |
|---|---|
| `tools/tts_tool.py` (4591 lines) | Defaults (provider/voice/model tables), config loader `_load_tts_config` (line 631), provider dispatch `_text_to_speech_single` (3187), long-form `text_to_speech_tool` (3573), `check_tts_requirements` (3794), speaker pipeline `stream_tts_to_speaker` (4071), per-provider generators (edge 1720, elevenlabs 1750, openai 1808, deepinfra 1933, xai 2093, minimax 2217, mistral 2355, gemini 2598, neutts 2803, piper 3021, kittentts 3129), command-provider runner (1316), ffmpeg Opus conversion (1405), container sniff/repair (1477/1494), delivery packing `_build_audio_delivery_files` (1626) |
| `tools/tts_streaming.py` | `SentenceChunker` (89), `StreamingTTSProvider` ABC + `register()` registry (131–159), `resolve_streaming_provider` (182), streamers: ElevenLabs (220), OpenAI PCM (264), Gemini SSE `streamGenerateContent?alt=sse` (313), xAI WebSocket `wss://api.x.ai/v1/tts` (400); 16 MiB per-sentence cap; speech-interrupted latch (66) |
| `tools/tts_text_normalize.py` | `prepare_spoken_text` pipeline: `strip_nonspoken_blocks` → `strip_markdown_for_tts` → `normalize_symbols_for_tts` → `smooth_whitespace_for_tts` → `flatten_newlines_for_payload` |
| `tools/neutts_synth.py` | Standalone NeuTTS subprocess helper (`python -m tools.neutts_synth --text … --out … --ref-audio … --ref-text …`) |
| `gateway/streaming_tts_consumer.py` | `StreamingTTSConsumer`: sync `on_delta` → `SentenceChunker` → thread-safe queue → async drain → `StreamingTTSProvider.stream()` → PCM chunks → adapter; `suppress_whole_file` fallback semantics; idempotent abort; per-turn isolation |
| `gateway/platforms/base.py` | `AudioFormat` (592), `StreamingTTSHandle` (605), adapter contract `supports_streaming_tts`/`begin_streaming_tts`/`write_streaming_tts`/`finish_streaming_tts`/`abort_streaming_tts` (4543–4572) |
| `website/docs/user-guide/features/tts.md` | Provider table, config YAML, per-provider caps, ffmpeg requirements, command-provider docs, plugin ABC |

Data flow (whole-file path): `text → prepare_spoken_text → _split_text_for_tts`
(per-provider char caps: edge 5000, openai 4096, xai 15000, minimax 10000, mistral
4000, gemini 32000, elevenlabs model-aware 5k–40k, neutts/kittentts 2000, piper
5000, command 5000) → one `_text_to_speech_single` call per chunk → provider
generator writes file → `_build_audio_delivery_files` (group + concat via ffmpeg,
enforce platform byte caps: Telegram 50 MiB, Discord 10 MiB) → returns
`MEDIA:<path>` (+ `[[audio_as_voice]]` marker when voice-compatible) → gateway
sends as native voice bubble. Opus/OGG is required for
`OPUS_VOICE_PLATFORMS = {telegram, matrix, feishu, whatsapp, signal}`; OpenAI /
ElevenLabs / Mistral / Gemini can emit Opus natively, Edge / MiniMax / xAI /
NeuTTS / KittenTTS / Piper need ffmpeg transcoding, and `_repair_ogg_container`
sniffs magic bytes to fix backends that write MP3/WAV into `.ogg` paths.

Streaming path: agent `stream_delta_callback` → `StreamingTTSConsumer.on_delta` →
`SentenceChunker` clauses → provider chunked API (ElevenLabs `pcm_24000`, OpenAI
`response_format=pcm`, Gemini SSE base64 PCM, xAI WS binary frames) → int16 mono
PCM at provider `sample_rate` → adapter writes voice-message chunks. Providers
without a chunked API fall back to per-sentence sync synthesis (Edge stays
conversational). CLI speaker path `stream_tts_to_speaker` plays PCM through
`sounddevice` (PortAudio) with prefetch + reinit fallback; macOS routes through
`afplay` temp files instead of PortAudio.

## 3. Target TypeScript design

New module tree under `web/src/tts/` (in-process, no Python backend):

```
web/src/tts/
  types.ts          # TTSConfig, TTSProviderId, TTSProvider, TTSSynthesisResult,
                    # AudioFormat, DeliveryProfile (port of AudioDeliveryProfile)
  normalize.ts      # full port of tools/tts_text_normalize.py prepare_spoken_text
  chunker.ts        # SentenceChunker port + PROVIDER_MAX_TEXT_LENGTH table
  registry.ts       # provider registry + dispatch (mirror _text_to_speech_single
                    # resolution order: built-in > command > plugin > edge default)
  delivery.ts       # _pack_audio_files_for_delivery / _build_audio_delivery_files port,
                    # OPUS_VOICE_PLATFORMS table, container sniff (magic bytes)
  playback.ts       # Web Audio API engine: AudioContext + AudioWorklet PCM sink,
                    # barge-in/stop, auto-TTS queue, SpeechPlaybackControls shim
  waveform.ts       # canvas waveform renderer (peaks from PCM or decoded buffer)
  providers/
    edge.ts         # Edge TTS WebSocket client (from scratch, see §5)
    elevenlabs.ts   # REST + WS streaming (pcm_24000 / opus_48000_64)
    openai.ts       # OpenAI-compatible /audio/speech (OpenAI + DeepInfra share it)
    minimax.ts      # region-aware t2a_v2 REST (global/cn endpoint+credential atom)
    mistral.ts      # Voxtral /audio/tts REST (opus/pcm)
    gemini.ts       # generateContent / streamGenerateContent?alt=sse + PCM→WAV wrap
    xai.ts          # WebSocket wss://api.x.ai/v1/tts
    piper.ts        # Rust child-process shim (bundled piper binary)
    neutts.ts       # Rust child-process shim (python -m tools.neutts_synth) or OOS
    kittentts.ts    # Rust child-process shim or OOS
    command.ts      # command-provider template renderer (Rust executes it)
  streaming.ts      # StreamingTTSProvider TS interface + streamer registry
  engine.ts         # TtsEngine facade: same API as web/src/lib/voice.ts speakText()
```

Core interfaces (signatures only, no implementation):

```ts
interface TTSProvider {
  id: string; available(): boolean | Promise<boolean>;
  synthesize(input: { text: string; format: "mp3"|"ogg"|"wav"|"opus"|"pcm";
    voice?: string; model?: string; speed?: number }): Promise<ArrayBuffer>;
  stream?(text: string, signal: AbortSignal): AsyncIterable<Uint8Array>; // PCM
}
interface TtsEngine {
  speak(input: { text: string; provider?: string }): Promise<AudioSpeakResult>;
  // AudioSpeakResult mirrors Python's { ok, data_url, mime_type, provider }
  streamSpeak(deltas: AsyncIterable<string>, signal: AbortSignal): Promise<void>;
}
```

In-process data flow: message completes → `autoTts`/read-aloud → `TtsEngine.speak`
→ normalize → chunk → provider.synthesize → Blob (data URL for `<audio>` /
`AudioBuffer` for Web Audio) → chat voice bubble (`<audio controls>` + waveform) →
playback with stop/barge-in. Streaming: agent deltas → `SentenceChunker` → provider
`stream()` → PCM chunks → `AudioWorklet` sink → waveform progress; `abort()` mirrors
`StreamingTTSConsumer.abort()` (idempotent, suppresses whole-file replay after
partial audio).

Rust (`src/commands/audio.rs`, new) owns OS-level work: temp-file write for command
providers, child-process execution (`Command` with process-tree kill, env scrubbing +
`env_passthrough`), optional bundled ffmpeg/piper invocation, and reveal-in-folder.
This mirrors the README rule that Rust stays for OS capabilities.

## 4. Data models & persistence

- **TTS config**: keep the existing `tts.*` config keys (`web/src/lib/voice-config.ts`
  `TTS_PROVIDER_META` + `buildVoiceSaveConfig`) and env vars (use-env / Rust secure
  store). Extend provider meta to all 11 providers + a command-provider editor.
- **Chat message extension**: add optional `voice` attachment to the message model in
  `packages/protocol` (extend `hermes-api.ts` near `AudioSpeakResponse`):

```ts
VoiceBubble = z.object({
  data_url: z.string(), mime_type: z.string(), provider: z.string(),
  duration_ms: z.number(), peaks: z.array(z.number()).optional(), // waveform
  voice_compatible: z.boolean().optional(),
}).passthrough();
```

  Persist in the existing session log / `packages/protocol/src/session-log.ts`
  schema (additive field; old sessions render text-only).
- **Audio cache**: artifact files in a Tauri-managed cache dir (Rust command), with
  an LRU eviction ported from the Python model-cache behavior
  (`tests/tools/test_tts_model_cache_lru.py`); `data_url` blobs for the current
  session stay in memory/IndexedDB. No SQLite migration needed for v1.
- **Delivery profiles**: port `_PLATFORM_AUDIO_DEFAULTS`
  (telegram 50 MiB / discord 10 MiB / default 10 MiB, safety_ratio 0.85) and
  `OPUS_VOICE_PLATFORMS` into `delivery.ts`; artifacts are produced on demand, not
  persisted.

## 5. Third-party library strategy

**Verified: kimi-code has NO TTS implementation.** Searched `D:/kimi-code` for
`tts`, `speech`, `elevenlabs`, `piper`, `AudioContext`, `waveform` — only hits are
(a) a Windows `say` bash fallback using PowerShell System.Speech SAPI in
`packages/agent-core/src/tools/support/windows-bash-fix.ts` and
`packages/agent-core-v2/src/agent/tools/os/bash/windowsBashFix.ts`, and (b)
`packages/kosong` (OpenAI-compatible provider client) which handles **audio input**
parts (`audio_url` → base64 `input_audio` via `mapAudioUrlToInputItem` in
`packages/kosong/src/providers/openai-responses.ts`, Gemini `inlineData` MIME
sniffing in `packages/kosong/src/providers/google-genai.ts`). These prove kimi-code's
fetch-based provider-client style and Gemini REST payload shape, but none synthesize
speech. Everything below is therefore "implement from scratch" unless noted.

| Python dep / capability | TS equivalent | Evidence / risk |
|---|---|---|
| `edge-tts` (WebSocket to Microsoft Edge neural voices) | **From scratch**: `EdgeTTSClient` — browser `WebSocket` to `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1`, must reproduce `Sec-MS-GEC` token + `Sec-MS-GEC-Version` headers, SSML payload, binary audio frames | No kimi-code evidence. Highest risk: token algorithm is undocumented and changes. Degraded fallback: `window.speechSynthesis` (OS voices) for default provider until WS client lands |
| `elevenlabs` SDK | **From scratch**: `fetch` REST `POST /v1/text-to-speech/{voice_id}` with `output_format=pcm_24000`/`opus_48000_64`; WS `stream-input` for streaming; voice list `GET /v1/voices` (desktop already calls `/api/audio/elevenlabs/voices`) | kimi-code: none for ElevenLabs |
| `openai` SDK | **From scratch**: `fetch` to `{base_url}/audio/speech` with `response_format=mp3|opus|pcm`; DeepInfra reuses same client with `deepinfra_base_url`/model catalog | kimi-code `packages/kosong` is evidence of a fetch-based OpenAI-compatible client (chat), reuse its request/error style |
| `mistralai` SDK | **From scratch**: `fetch` `https://api.mistral.ai/v1/audio/tts` (`voxtral-mini-tts-2603`, `output_format=opus|pcm`) | None in kimi-code |
| `google-genai` / Gemini TTS | **From scratch**: `fetch` `{base_url}/models/{model}:generateContent` and `:streamGenerateContent?alt=sse`; base64 `inlineData` PCM → wrap WAV (port `_wrap_pcm_as_wav`); persona prompt + audio-tag rewrite via LLM remains a backend/tool concern or a TS port of the prompt composer | kimi-code `packages/kosong/src/providers/google-genai.ts` shows the REST shape/MIME mapping for audio content parts — reuse |
| `websockets` (xAI) | Browser `WebSocket` to `wss://api.x.ai/v1/tts`, JSON init frame + binary PCM frames; `ws` package for Node tests | None in kimi-code |
| `requests`/`httpx` | `fetch`/`undici` with `AbortController` | kimi-code uses fetch-based clients |
| `numpy` | `Int16Array`/`Float32Array` + `AudioWorklet` | Browser-native |
| `sounddevice`/PortAudio | **From scratch**: Web Audio API `AudioContext` + `AudioWorkletNode` PCM sink; barge-in = `stop()` + `abort()` | kimi-code: none |
| `ffmpeg` (mp3→ogg opus, concat, container repair) | **Option A**: Rust child process calling bundled ffmpeg binary (best parity). **Option B**: `@ffmpeg/ffmpeg` WASM in webview (no kimi-code evidence; large WASM, slower). Prefer A; keep B for non-Tauri browser fallback | Opus constraints: mono, `-application voip`, 48k (port exact flags from `_ffmpeg_transcode_to_opus`) |
| `subprocess` (command providers, piper, neutts) | **From scratch**: Rust `src/commands/audio.rs` — `std::process::Command`, Windows `taskkill /F /T`, env scrub + `env_passthrough`, timeout; port `_render_command_tts_template` placeholder quoting | Rust is the correct OS layer per repo conventions |
| `piper-tts` (ONNX model) | **From scratch**: bundled `piper` binary via Rust child process; voice download to cache dir (port `_resolve_piper_voice_path` + `python -m piper.download_voices` behavior) | No TS equivalent found; `onnxruntime-node` is possible but adds native dep — child-process is safer |
| `neutts` / `kittentts` (local Python ML) | **Defer decision**: during migration delegate to managed Python runtime; for standalone either (a) Rust child process `python -m tools.neutts_synth`, or (b) mark out-of-scope in settings UI (`unsupported: true` — desktop `VoiceProviderMeta` already supports this flag) | No TS equivalent found; models are Python/torch — not portable in-process |
| `orjson`/`json`, `dataclasses` | `zod` schemas in `packages/protocol` (already used) | — |

## 6. Integration with existing Hermes-CN-Desktop frontend

Reuse (already verified present):

- `web/src/lib/voice.ts` — keep the function signatures `speakText`,
  `transcribeAudioBlob`, `getElevenLabsVoices`, `sanitizeTextForSpeech`,
  `voiceErrorMessage`; swap `speakText` implementation from `postJSON("/api/audio/speak")`
  to `TtsEngine.speak` behind a `tts.engine` flag. `sanitizeTextForSpeech` is a
  lighter port of `prepare_spoken_text`; replace it with the full `tts/normalize.ts`
  for parity.
- `web/src/components/chat/message-timeline.tsx` — existing `SpeechPlaybackControls`
  (`state.messageId/status`, `onSpeak`, `onStop`, lines 51–64, 929–955, 990–1131)
  and auto-TTS (`autoTts`, `autoTtsSeenRef`, lines 993–1129) are the integration
  seams; swap `new Audio(response.data_url)` (line 1057) for the voice-bubble
  component + Web Audio playback.
- `web/src/components/chat/` — add `VoiceMessageBubble.tsx` (audio element +
  waveform canvas); no audio bubble exists today (verified: no `<audio>` element in
  chat except the read-aloud play).
- `web/src/routes/voice.tsx` + `web/src/lib/voice-config.ts` — extend provider
  metadata to all 11 providers + command-provider editor; keep the schema-first
  options flow (`CONFIG_SCHEMA`).
- `web/src/hooks/use-mic-recorder.ts` — unchanged (STT input side).
- `packages/protocol/src/hermes-api.ts` — extend with `VoiceBubble` schema.
- `web/src/lib/transport.ts` / `gateway-client.ts` — during migration the REST path
  stays; the in-process engine bypasses transport entirely (direct module call).
- `web/src/lib/tauri-bridge.ts` + new Rust `src/commands/audio.rs` (registered in
  `src/commands/mod.rs`) — add `ttsWriteTempFile`, `ttsRunCommand`,
  `ttsConvertOpus`, `ttsRevealAudio`; `src/commands/notify.rs` is notifications
  (unrelated to audio) and is not reused.

## 7. Removing the WebSocket dependency (migration path)

1. **Today**: `speakText()` → `POST /api/audio/speak` (Python backend); message
   timeline plays the returned data URL.
2. **Freeze the API surface** that must stay byte-compatible during migration:
   `POST /api/audio/speak` `{text} → {ok, data_url, mime_type, provider}`,
   `GET /api/audio/elevenlabs/voices`, and the gateway WS JSON-RPC methods used by
   `StreamingTTSConsumer` / adapters (`begin_streaming_tts`, `write_streaming_tts`,
   `finish_streaming_tts`, `abort_streaming_tts`).
3. **Phase in-process engine behind the same interface**: `TtsEngine.speak` returns
   the same `AudioSpeakResult`; feature-flag `tts.engine: "in-process" | "backend"`.
   Voice-bubble rendering is purely client-side and needs no backend.
4. **Streaming migration**: replace the WS consumer with `TtsEngine.streamSpeak`
   fed by the in-process agent loop deltas; keep the Python consumer's
   suppression/partial semantics as parity tests (§10).
5. **Platform delivery**: Telegram/Discord/WhatsApp adapters remain on the messaging
   gateway. The TS side produces the right artifact (Opus/OGG for Telegram/Discord,
   MP3 for WhatsApp) via `delivery.ts`; porting the upload adapters to TS is a
   separate feature (mark "out of scope for desktop standalone" until then).
6. **Delete**: once the flag flips to `in-process` for all users, remove
   `/api/audio/speak` + `AudioSpeakResponse` REST path from the runtime and the
   desktop call sites.

## 8. Migration phases & task breakdown

- **P0 — Foundation + default provider** (unblocks free default):
  `tts/types.ts`, `normalize.ts` (full port), `chunker.ts`, `registry.ts`,
  `playback.ts` (AudioWorklet), `EdgeTTSClient` (Sec-MS-GEC WS), voice bubble +
  waveform in chat; flip `speakText` to in-process behind flag.
- **P1 — Cloud REST providers**: OpenAI + DeepInfra (shared client), ElevenLabs
  REST + streaming, Gemini (SSE + WAV wrap), Mistral, MiniMax (region atom), xAI WS.
  Extend `routes/voice.tsx` provider meta.
- **P2 — Local engines via Rust**: `src/commands/audio.rs` (temp files, child
  process, env scrub, process-tree kill); Piper child process + voice download;
  command-provider template renderer; ffmpeg/Opus conversion (bundled binary or
  WASM).
- **P3 — NeuTTS / KittenTTS decision**: delegate to managed runtime during
  migration; choose child-process port or mark `unsupported` in the picker.
- **P4 — Delivery + cleanup**: `delivery.ts` profiles, Opus artifact contract for
  Telegram/Discord/WhatsApp, auto-TTS parity, remove REST `/api/audio/speak`.

## 9. Risks & open questions

- **Edge TTS token algorithm** (`Sec-MS-GEC`) is undocumented and may change; the
  default provider depends on it. Fallback: `speechSynthesis` or prompt user to
  switch providers (existing error-mapping UX in `voice.ts`).
- **Local models (NeuTTS/KittenTTS/Piper)** are Python/ONNX; no TS equivalent
  found. Piper via bundled binary is feasible; NeuTTS/KittenTTS standalone support
  needs a product decision.
- **ffmpeg/Opus in the webview**: WASM size/perf vs bundling a binary; container
  sniffing (`_repair_ogg_container`) must be ported so `.ogg` is never fake.
- **Web Audio streaming latency + audio focus**: barge-in semantics, macOS
  permission quirks (Python had a PortAudio TCC workaround; TS needs equivalent
  handling).
- **CORS / network**: provider APIs called from the webview need Tauri capability
  config or a Rust proxy command; env-based base_url overrides (self-hosted
  ElevenLabs/MiniMax/Gemini) must be honored.
- **Credential storage**: env vars vs secure store; the Python
  `resolve_provider_secret` (config > env > credential pool) needs a TS equivalent.
- **kimi-code has no TTS reference** — the entire provider layer is greenfield;
  parity tests against Python are the main safety net.

## 10. Test strategy

- **vitest unit parity (per Python cluster)**:
  - `tts/normalize.test.ts` ↔ `tests/tools/test_tts_text_normalize.py` /
    `test_tts_prepare_spoken.py` (markdown, symbols, think blocks, emoji).
  - `tts/chunker.test.ts` ↔ `tests/tools/test_tts_streaming.py`
    (`TestSentenceChunker` boundary/think/paragraph cases, min_len merge, flush).
  - `tts/registry.test.ts` ↔ `test_tts_plugin_dispatch.py` (built-in wins,
    command wins over plugin, case-insensitivity), `test_tts_max_text_length.py`,
    `test_tts_piper.py` (registration + caps), `test_tts_path_traversal.py`
    (reject `..`, protected dirs), `test_tts_deepinfra.py`, `test_tts_gemini.py`
    (WAV header, key fallback, default voice/model), `test_tts_mistral.py`,
    `test_tts_minimax_region.py`, `test_tts_xai_speech_tags.py`,
    `test_tts_opus_routing.py` (OPUS_VOICE_PLATFORMS), `test_tts_long_form_chunking.py`
    (split + packing), `test_tts_response_body_cap.py` (16 MiB cap),
    `test_tts_command_providers.py` (template quoting, timeout, env passthrough).
  - `tts/streaming.test.ts` ↔ `test_tts_streaming.py` streamers + consumer:
    `gateway/test_streaming_tts_consumer.py` (queue backpressure, abort idempotent,
    pre/post-audio fallback suppression, concurrent turn isolation, finish-sentinel
    race, adapter finish failure) and `gateway/test_base_auto_tts_output_format.py`
    (mp3 vs opus by platform).
  - `hermes_cli/test_plugins_tts_registration.py` parity → registry registration
    guards (reject non-provider, reject built-in shadow).
- **Provider client tests**: mocked `fetch`/`WebSocket` fixtures asserting exact
  request bodies/headers and PCM chunk decoding (mirrors `mock_gemini_response`,
  FakeStreamer patterns).
- **Playwright E2E**: voice settings page (11 providers + command editor), read-aloud
  button states (`idle|preparing|speaking`), auto-TTS on completed messages, voice
  bubble render + waveform + stop; Tauri integration test for `ttsRunCommand`
  against a fake CLI writing a temp file.

## 11. Reference links

- Python: `D:/hermes-agent-cn/tools/tts_tool.py`, `tools/tts_streaming.py`,
  `tools/tts_text_normalize.py`, `tools/neutts_synth.py`,
  `gateway/streaming_tts_consumer.py`, `gateway/platforms/base.py`
- Docs: `D:/hermes-agent-cn/website/docs/user-guide/features/tts.md`
- Tests: `D:/hermes-agent-cn/tests/tools/test_tts_*.py` (~30), `tests/gateway/test_streaming_tts_consumer.py`,
  `tests/gateway/test_base_auto_tts_output_format.py`,
  `tests/hermes_cli/test_plugins_tts_registration.py`
- kimi-code (no TTS equivalent): `packages/agent-core/src/tools/support/windows-bash-fix.ts`
  (SAPI `say`), `packages/agent-core-v2/src/agent/tools/os/bash/windowsBashFix.ts`,
  `packages/kosong/src/providers/openai-responses.ts` + `google-genai.ts` (audio-input
  parts, REST client style)
- Desktop: `web/src/lib/voice.ts`, `web/src/lib/voice-config.ts`,
  `web/src/routes/voice.tsx`, `web/src/components/chat/message-timeline.tsx`,
  `web/src/hooks/use-mic-recorder.ts`, `web/src/lib/tauri-bridge.ts`,
  `packages/protocol/src/hermes-api.ts`, `src/commands/mod.rs`, `src/commands/notify.rs`
