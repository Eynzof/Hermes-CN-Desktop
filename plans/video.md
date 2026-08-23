# Video — Python → TypeScript Rewrite Plan

## 1. Summary

Port the Python **video** feature set into the TypeScript desktop runtime so it runs
in-process (no WebSocket link to the managed Python backend). Scope:

- `video_gen` toolset (opt-in): unified `video_generate` (text-to-video /
  image-to-video / reference-to-video) + provider-specific `xai_video_edit`,
  `xai_video_extend`. Backends: **xAI Grok-Imagine** (async `POST /videos/*` REST),
  **FAL.ai** (Veo 3.1 / Pixverse v6 / Kling O3 / Seedance / MiniMax H3 / FLUX 3 /
  Grok Imagine via `queue.fal.run` REST), **DeepInfra** (OpenAI-compatible
  `/v1/openai/videos` async job). Backends are pluggable through a provider registry
  exactly like Python's `agent/video_gen_registry.py`.
- `video` toolset (opt-in): `video_analyze` — send a local/URL video (≤50 MB) as a
  base64 `data:video/...` part to a video-capable auxiliary model and return a
  `{success, analysis}` JSON result.
- `bfl` toolset (`bfl_flux3_*`, `tools/flux3_video_tool.py`): FLUX 3 through the
  Nous managed gateway. It shares the same "submit job → poll → save clip" shape and
  is ported behind the same REST/polling core, gated on a Nous sign-in token.

Key design decisions:

1. **Provider registry pattern** (mirror Python): one `VideoGenProvider` interface,
   a thread/session-safe registry, active-provider resolution (explicit
   `video_gen.provider` config, else single available backend auto-select, fail
   closed on unknown). Tools dispatch through the active provider; the schema
   description is rebuilt dynamically from the active backend's `capabilities()` /
   model catalog (the "dynamic tool schema" behavior).
2. **No TS SDK for FAL/xAI** — both backends are plain REST async-job APIs, so we
   implement thin REST clients from scratch (`fetch` + Rust `external_request`
   chokepoint for SSRF safety), including idempotency keys, bounded polling with
   deadlines, and local artifact caching.
3. **Artifact handling**: downloaded/returned videos are materialized into the
   desktop media cache (Python `$HERMES_HOME/cache/videos/` equivalent) with size
   caps; tool results return a URL **or** local path; the chat timeline gains a
   `video` message part and inline `<video>` rendering (there is no video renderer
   in the Desktop webview today).
4. **Opt-in toolsets**: `video_gen` and `video` are not in the default
   `hermes-cli` set; the desktop keeps the same opt-in semantics (settings toggle /
   `toolsets` config), and credential gating (`check_fn`) decides visibility.

## 2. Current Python implementation

Source of truth: `D:/hermes-agent-cn`. Feature inventory:
`features_report.md` line 78.

| File | Role |
|------|------|
| `agent/video_gen_provider.py` (596 lines) | `VideoGenProvider` ABC: `name`, `display_name`, `is_available()`, `list_models()`, `capabilities()`, `default_model()`, `generate(prompt, *, model, image_url, reference_image_urls, duration, aspect_ratio, resolution, negative_prompt, audio, seed, **kwargs)`. Uniform `success_response()` / `error_response()` dicts (`success/video/model/prompt/modality/aspect_ratio/duration/provider/error/error_type`). Cache helpers `save_b64_video` / `save_bytes_video` / `save_url_video` (streaming, 200 MB cap, extension from Content-Type) under `$HERMES_HOME/cache/videos/`. Reusable `OpenAICompatibleVideoGenProvider` (DeepInfra/Sora `client.videos` async job with bounded 5 s poll / 900 s deadline). |
| `agent/video_gen_registry.py` (172 lines) | Thread-safe provider map; `register_provider` / `list_providers` / `get_provider` / `get_active_provider`; active = config `video_gen.provider` else the **single available** provider; unknown explicit config fails closed. |
| `tools/video_generation_tool.py` (605 lines) | `video_generate` schema + handler + **dynamic schema builder** `_build_dynamic_video_schema()` (description reflects active backend: modalities, aspect ratios, resolutions, duration range, audio, negative_prompt, max_reference_images, xAI chaining notice). Handler: prompt required, `_confine_source_images` sandbox guard (from `tools/image_generation_tool.py`), model resolution (arg > config > provider default), TypeError/exception → `provider_contract`/`provider_exception` JSON errors. Registers toolset `video_gen`, emoji 🎬. |
| `tools/xai_video_tools.py` (209 lines) | `xai_video_edit` / `xai_video_extend` schemas (`prompt` + `video_url` HTTPS MP4, optional `model`, `duration` for extend); gated on `video_gen.provider == "xai"` + credentials; delegates to `plugins/video_gen/xai.run_xai_video_edit/extend`. |
| `plugins/video_gen/fal/__init__.py` (913 lines) | `FALVideoGenProvider`. Family catalog `FAL_FAMILIES` (~15 families incl. veo3.1, pixverse-v6, kling-v3-4k) each with `text_endpoint` / `image_endpoint`, `aspect_ratios`, `resolutions`, `durations`, `audio`, `negative`, `seed`, `duration_int`, `duration_suffix`, `image_param_key` (Kling `start_image_url`), `image_drop_keys` (Seedance/MiniMax derive aspect from input), `resolution_aliases` (MiniMax `768P/2K/4K`). Payload builder drops unsupported keys; duration clamp (range vs enum); `fal-client` SDK via `tools/fal_common.py` (direct `FAL_KEY` or managed Nous gateway); SeedVR2 upscaler endpoint `fal-ai/seedvr/upscale/video` (best-effort, `upscaled` flag). |
| `plugins/video_gen/xai/__init__.py` (925 lines) | `XAIVideoGenProvider` + `run_xai_video_generation/edit/extend`. Async REST: `POST {base}/videos/generations` → `request_id`; poll `GET /videos/{id}` every 5 s up to 240 s; `edits` / `extensions` endpoints; model routing (`grok-imagine-video` t2v, `grok-imagine-video-1.5` i2v); reference images (max 7, cannot combine with `image_url`); storage options → `file_output.public_url` files-cdn for edit/extend chaining. Credentials from shared `tools/xai_http.resolve_xai_http_credentials` (OAuth pool → auth.json → `XAI_API_KEY`). |
| `plugins/video_gen/deepinfra/__init__.py` (90 lines) | `DeepInfraVideoGenProvider(OpenAICompatibleVideoGenProvider)`, `DEEPINFRA_API_KEY`, base `https://api.deepinfra.com/v1/openai`, live model catalog from `hermes_cli.models._fetch_deepinfra_models_by_tag("video-gen")`. |
| `plugins/video_gen/{fal,xai,deepinfra}/plugin.yaml` | `kind: backend`, `requires_env` (`FAL_KEY` / `XAI_API_KEY` / `DEEPINFRA_API_KEY`). |
| `tools/flux3_video_tool.py` (1249 lines) | `bfl` toolset: 6 pinned schemas (`bfl_flux3_text_to_video`, `_image_to_video`, `_keyframes_to_video`, `_video_continuation`, `_get_result`, `_prompting_guide`). Nous gateway REST: `POST {base}/generations {mode,...}` → `{id,status,guidance}`; poll `GET /generations/<id>` (5 s cadence, 180 s poll budget, 240 s call backstop, throttle-aware); local-path media → upload protocol `nous-upload:<token>`; on Ready downloads clip (SSRF-guarded), saves to `~/Downloads` or `save_to`, never overwrites. |
| `tools/vision_tools.py` (lines ~1806–2221) | `video_analyze` tool (toolset `video`): `VIDEO_ANALYZE_SCHEMA` (`video_url` + `question`); `video_analyze_tool()` downloads URL (SSRF-safe, retry) or reads local path (file-safety guard, terminal-backend resolver `permitted=("video",)`), base64 data URL (50 MB cap), sends `content[1] = {type:"video_url", video_url:{url:dataUrl}}` to `async_call_llm` with `auxiliary.video.model` (fallback `auxiliary.vision.model`), timeout ≥180 s, returns `{success, analysis}`. |
| `toolsets.py` | `video: ["video_analyze"]`; `video_gen: ["video_generate","xai_video_edit","xai_video_extend"]`; `bfl` = 6 `bfl_flux3_*` tools. |
| Docs | `website/docs/reference/tools-reference.md` (§`video`, §`video_gen`), `toolsets-reference.md` (both opt-in). |
| Tests | `tests/agent/test_video_gen_registry.py`; `tests/tools/test_video_generation_dispatch.py`, `test_video_generation_dynamic_schema.py`, `test_video_analyze.py`, `test_video_generation_tool_surface_matrix.py`; `tests/plugins/video_gen/test_{deepinfra_provider,fal_plugin,xai_plugin,xai_plugin_integration}.py`. |

Data flow (today): agent tool call → `tools/registry` dispatches `video_generate` →
`_resolve_active_provider()` (forces plugin discovery) → `VideoGenProvider.generate()`
→ plugin REST/SDK submit → **blocking poll** → artifact (URL or cached local path) →
uniform JSON response dict → model renders `video` field → messaging/CLI delivery
(`MEDIA:` tag or markdown embed). `video_analyze` is a separate path through the
auxiliary multimodal client.

## 3. Target TypeScript design

Module layout (all under the in-process agent runtime; proposal
`web/src/agent/video-gen/` + shared `web/src/lib/media/`, with `packages/protocol`
for wire types):

```
web/src/agent/video-gen/
  types.ts            # VideoGenProvider interface, capabilities, models, responses
  registry.ts         # register/list/resolve active provider (mirror video_gen_registry.py)
  dynamic-schema.ts   # _build_dynamic_video_schema equivalent (description builder)
  fal-provider.ts     # FAL queue REST client + FAL_FAMILIES catalog + payload builder + SeedVR2 upscale
  xai-provider.ts     # xAI async videos REST (generations/edits/extensions) + storage options
  openai-compatible-provider.ts  # DeepInfra/Sora OpenAI-compatible async job poller
  tools.ts            # video_generate / xai_video_edit / xai_video_extend handlers + schemas
  video-analyze.ts    # video_analyze tool (opt-in toolset "video")
  bfl-flux3.ts        # bfl_flux3_* gateway REST + poll loop + save clip (Nous-gated)
web/src/lib/media/
  video-cache.ts      # save bytes / download URL → desktop cache dir (size caps, ext detect)
  message-video.ts    # video part extraction from tool output (mirror message-images.ts)
  video-source.ts     # confine/normalize local path vs URL inputs (mirror _confine_source_images)
web/src/components/chat/message-video.tsx   # <video controls> renderer + fallback UI
packages/protocol/src/hermes-api.ts         # add HermesVideoMessagePart to HermesMessagePart union
```

Interfaces (TypeScript, mirroring the Python ABC):

```ts
interface VideoGenProvider {
  readonly name: string;                       // "fal" | "xai" | "deepinfra"
  readonly displayName: string;
  isAvailable(): boolean;                      // credential/gateway probe
  listModels(): VideoModel[];                  // {id, display, speed, strengths, price, modalities, min/maxDuration}
  capabilities(): VideoCapabilities;           // modalities, aspectRatios, resolutions, min/maxDuration, audio, negativePrompt, maxReferenceImages
  defaultModel(): string | null;
  generate(request: VideoGenerateRequest): Promise<VideoGenResponse>;  // blocks until job terminal (bounded poll)
}
type VideoGenResponse = { success: true; video: string; model: string; prompt: string;
                          modality: "text"|"image"|"reference"; aspectRatio: string; duration: number;
                          provider: string; extra?: Record<string, unknown> }
                     | { success: false; video: null; error: string; errorType: string; ... };
```

Runtime flow (in-process, no Python):

1. Agent loop resolves toolset membership (`video_gen`/`video` enabled) and
   `check_fn` gate (`isAvailable()` + credentials) — same registry gating the
   Python tool layer already does.
2. `video_generate` handler reads `video_gen.provider` / `video_gen.model` config
   (from the desktop config store), resolves the active provider via
   `registry.getActiveProvider()` (explicit config else single available backend;
   unknown → `provider_not_registered` error).
3. Provider performs async-job REST:
   - FAL: `POST https://queue.fal.run/<familyEndpoint>` (idempotency key
     `x-idempotency-key`) → `request_id`; poll status endpoint; on `COMPLETED`
     fetch result `video.url`. Direct `FAL_KEY` auth or managed gateway token —
     desktop always goes through Rust `external_request` so the key never lands in
     the webview.
   - xAI: `POST {base}/videos/generations` (or `edits`/`extensions`) → `request_id`;
     poll `GET /videos/{id}` until `done`; honor `storage_options` →
     `file_output.public_url` for chaining.
   - DeepInfra: OpenAI-compatible `POST /videos` → job → poll → `download_content`
     (or delivery URL); materialize bytes.
4. Result artifact: if the backend returns an ephemeral CDN URL (FAL/DeepInfra),
   download via Rust (`external_request` / new `download_external_media`) into
   `video-cache.ts` and return the local path; xAI stored `public_url` returns as
   HTTPS URL. The response goes back into the agent loop and the chat timeline.
5. `video_analyze` handler downloads/reads the source (50 MB cap), base64-encodes,
   and calls the in-process auxiliary multimodal client (same client `vision_analyze`
   uses) with a `video_url` data part.

## 4. Data models & persistence

- **Config** — `video_gen: {provider, model}` (plus `video_gen.fal.model`,
  `auxiliary.video.model`, `auxiliary.vision.model`) lives in the desktop config
  store (today `config.yaml` read by Rust; expose a typed read to the web layer).
  No new DB table.
- **Message parts** — extend `HermesMessagePart` (currently
  `text|reasoning|progress|image|tool|notice|moa_reference`) with
  `HermesVideoMessagePart`: `{ type: "video", url?: string, src?: string, path?:
  string, data?: string, name?: string, filename?: string, mimeType?: string,
  poster?: string }` — mirrors `HermesImageMessagePart`
  (`packages/protocol/src/hermes-api.ts` lines 329–349). Backward-compatible:
  `z.discriminatedUnion` addition; older history simply has no video parts.
  Zod schema is the migration — no SQLite migration needed.
- **Artifact cache** — `video-cache.ts` writes to the desktop media cache dir
  (Python `$HERMES_HOME/cache/videos/` analog; Rust exposes the path via
  `AppState`). Filename `<prefix>_<timestamp>_<uuid8>.<ext>`; ext from
  Content-Type (`video/mp4|webm|quicktime|x-matroska`) or URL suffix; 200 MB cap
  mirrors `save_url_video`. Downloads are streamed (byte chunks) to a `.part` file
  then renamed, never overwriting (Python `_free_path` behavior).
- **Job state** — not persisted. FAL/xAI polls are blocking inside the tool call
  (Python does the same; 240–900 s deadlines with `AbortSignal` support). The
  `bfl_flux3` jobs are restart-survivable (job id + `get_result`), so a
  `bfl` job map in memory keyed by id is enough for a session; a job-id → session
  mapping can be persisted later if resume-across-restart is required.

## 5. Third-party library strategy

| Python dependency | TS equivalent | Evidence / decision |
|---|---|---|
| `fal-client` SDK (`plugins/video_gen/fal`) | **No SDK — implement from scratch** (REST queue API) | kimi-code has **no** `fal`/`veo`/`pixverse`/`kling` package or tool (verified: grep of `packages/*/src`, `apps/kimi-code/src`, package.json found nothing). FAL's queue API is plain HTTPS: `POST queue.fal.run/<endpoint>` + status poll; implement `FalQueueClient` with `fetch` and idempotency header; payload builder ported verbatim from `FAL_FAMILIES`. |
| `openai` Python SDK (`OpenAICompatibleVideoGenProvider`, DeepInfra/Sora) | `openai` npm (only if `client.videos` exists in v6) — otherwise REST | kimi-code depends on `openai@^6.34.0` (`packages/agent-core-v2/package.json:77`, `packages/kosong/package.json:48`). JS SDK video surface is uncertain; safest is a REST poller against `POST /videos` + `GET /videos/{id}` + `download_content` with a 5 s/900 s bounded loop (port of Python `_create_and_poll`). |
| `httpx` / `requests` (xAI, vision downloads, gateway) | `fetch` (webview) → Rust `external_request` for server-side SSRF-safe calls | kimi-code uses fetch-based clients (`packages/agent-core/src/tools/providers/local-fetch-url.ts`, `utils/proxy.ts`). Desktop already routes credentialed/network calls through `src/commands/api_proxy.rs` (`external_request` HTTPS-only, SSRF/IP guards, 15 s default; `DASHBOARD_AUDIO_PROXY_TIMEOUT` 180 s precedent for long downloads). |
| `orjson` / `json` | `JSON.parse`/`stringify` | — |
| `pybase64` / `mimetypes` | `Buffer.toString('base64')` + extension→MIME map | Port `_VIDEO_MIME_TYPES` / `_URL_VIDEO_CONTENT_TYPES` maps from `vision_tools.py:1811` / `video_gen_provider.py:253`. |
| `asyncio` (bounded poll loops) | `Promise` + `setTimeout` with wall-clock deadline | Port `_create_and_poll`, `_poll`, `_poll_until_done` budgets (poll gap 5 s, backstop 240 s, max 3 consecutive transport errors for bfl). |
| xAI OAuth (SuperGrok) credential resolver (`tools/xai_http.py`) | Desktop credential store + `packages/oauth` | kimi-code ships a full OAuth package (`packages/oauth`, PKCE/device code) — reuse its patterns; desktop already has OAuth session plumbing (`src/commands/connection_auth.rs`, `oauth_session.rs`) and Settings stores for keys. Fallback `XAI_API_KEY` from settings. |
| `ffmpeg` | Not needed | Python video_analyze does **not** run ffmpeg; it base64-encodes the whole file (50 MB cap). kimi-code has no ffmpeg dependency either (only image compress wasm). Keep the same approach; document the 50 MB data-URL cost in the webview. |
| `file-type`-style MIME sniffing | Optional | kimi-code has `packages/agent-core/src/tools/support/file-type.ts` for images; for videos extension + Content-Type is sufficient (parity with Python). |

**No TS equivalent found (explicit risks):**
- No FAL/xAI/Kling/Veo SDK or tool in kimi-code — the entire provider layer is
  designed from scratch (REST + polling). Risk: FAL/xAI API contract drift must be
  pinned by parity tests, not a maintained SDK.
- No `video_analyze`-style tool in kimi-code. kimi-code only has **input-side**
  video delivery for prompts (`packages/agent-core/src/tools/support/video-delivery.ts`,
  `media-resolve.ts`) — a useful precedent for upload-vs-base64 fallback, but the
  analysis call itself is a new module.
- No video chat renderer in Desktop (`web/src` has no `<video>`; `MessageImage`
  is the only media renderer) — `MessageVideo` must be built.

## 6. Integration with existing Hermes-CN-Desktop frontend

- **Protocol** — add `HermesVideoMessagePart` to
  `packages/protocol/src/hermes-api.ts` `HermesMessagePart` union
  (line 384); update `HermesUIMessage` consumers automatically (passthrough).
- **Message adapter / rendering** —
  `web/src/components/chat/message-adapter.ts`: in `partsToBlocks` (line 507) add a
  `video` block branch next to `image` (line 527) → `ChatVideoItem`; tool outputs
  also scanned by `extractVideoPartsFromUnknown` (new, mirroring
  `extractImagePartsFromUnknown` in `web/src/lib/message-images.ts`) so
  `video_generate` results with `video:` URL/path render inline.
  `web/src/components/chat/markdown-renderer.tsx` + new
  `message-video.tsx` render `<video controls preload="metadata">` with a
  loading/failed fallback identical in spirit to `MessageImage`
  (`message-image.tsx`): direct HTTPS/data URLs play inline; local paths go through
  `fetchMediaDataUrl` (`web/src/lib/transport.ts:168`) / `readFileDataUrl`.
- **Rust commands** — reuse `src/commands/api_proxy.rs`:
  `external_request` for all FAL/xAI REST submits and CDN video downloads
  (SSRF + HTTPS enforcement already there); add `download_external_media` (video
  variant of `download_external_image`, larger cap ~200 MB, longer timeout — the
  180 s `DASHBOARD_AUDIO_PROXY_TIMEOUT` precedent); `upload_file` already handles
  media uploads (100 MB cap) if a provider needs upload-then-reference.
- **Settings** — desktop Settings stores / config file: add the `video_gen`
  provider+model picker and credential prompts (FAL_KEY / XAI_API_KEY /
  DEEPINFRA_API_KEY); keep Python's "opt-in toolset" semantics so `video_gen` /
  `video` are disabled by default. Toolset gating reuses the existing agent tool
  registry (`web/src/.../tools` equivalent of `toolsets.py`).
- **OAuth** — xAI Grok OAuth reuses existing desktop auth flows
  (`src/commands/connection_auth.rs`, `oauth_session.rs`, Settings stores); token
  refresh patterns from kimi-code `packages/oauth`.

## 7. Removing the WebSocket dependency (migration path)

1. **Today**: the agent loop calls Python over WS JSON-RPC / dashboard REST; tool
   schemas come from the Python registry; results are JSON strings (already the
   `success/video/model/...` envelope).
2. **Phase A — same interface in-process**: implement the TS modules behind the
   existing tool-call interface (tool name + args → JSON result string). The
   desktop routes `video_generate` / `xai_video_edit` / `xai_video_extend` /
   `video_analyze` / `bfl_flux3_*` to the in-process registry while everything else
   still proxies. **Freeze this API surface** as the migration contract:
   - tool names: `video_generate`, `xai_video_edit`, `xai_video_extend`,
     `video_analyze`, `bfl_flux3_text_to_video`, `bfl_flux3_image_to_video`,
     `bfl_flux3_keyframes_to_video`, `bfl_flux3_video_continuation`,
     `bfl_flux3_get_result`, `bfl_flux3_prompting_guide`;
   - argument schemas (from `VIDEO_GENERATE_SCHEMA`, `XAI_VIDEO_EDIT/EXTEND_SCHEMA`,
     `VIDEO_ANALYZE_SCHEMA`, `*_SCHEMA` in `flux3_video_tool.py`);
   - response envelope: `{success, video, model, prompt, modality, aspect_ratio,
     duration, provider, error?, error_type?, extra?}`;
   - config keys: `video_gen.provider`, `video_gen.model`, `video_gen.fal.model`,
     `auxiliary.video.model`, env `FAL_KEY` / `XAI_API_KEY` / `DEEPINFRA_API_KEY`.
3. **Phase B — in-process default**: flip the router so the video tools always use
   the TS implementation; keep the Python path behind a feature flag for A/B and
   rollback.
4. **Phase C — delete**: remove WS/REST routing for these tools (and eventually the
   Python backend entirely for this feature). Verify parity suite (section 10)
   passes before delete.

## 8. Migration phases & task breakdown

1. **P0 — Render + protocol**: add `HermesVideoMessagePart`; `message-video.ts`
   extraction; `MessageVideo.tsx` + adapter wiring. Deliver: generated video URLs
   render inline in chat (even while backend still generates).
2. **P1 — Core interfaces**: `video-gen/types.ts`, `registry.ts`,
   `dynamic-schema.ts`, `video-cache.ts`, `video-source.ts`; config reader for
   `video_gen.*`. Unit tests for registry parity.
3. **P2 — FAL provider** (largest): port `FAL_FAMILIES` catalog + payload builder
   + clamping + `FalQueueClient` REST + SeedVR2 upscale; `video_generate` handler
   + dynamic schema. Parity tests vs `tests/plugins/video_gen/test_fal_plugin.py`.
4. **P3 — xAI provider**: `xai-provider.ts` (generations/edits/extensions,
   storage options, model routing, reference-image rules); `xai_video_edit` /
   `xai_video_extend` tools + credential resolution via desktop auth.
5. **P4 — OpenAI-compatible provider**: DeepInfra `openai-compatible-provider.ts`
   (REST poller); plugin-equivalent registration.
6. **P5 — video_analyze**: `video-analyze.ts` (download/read + base64 data URL +
   auxiliary model call + error taxonomy from `vision_tools.py`); opt-in `video`
   toolset wiring.
7. **P6 — bfl toolset**: `bfl-flux3.ts` gateway REST submit/poll/save + 6 schemas
   + prompting guide, Nous-token gated.
8. **P7 — Rust**: `download_external_media` + cache dir command + config passthrough;
   long-poll timeouts for video.
9. **P8 — Cutover**: feature-flag in-process default; delete WS/REST path for video
   tools; E2E pass.

## 9. Risks & open questions

- **No TS provider SDKs**: FAL/xAI contracts are reimplemented from REST docs
  (`fal-ai/veo3.1`, `fal-ai/pixverse/v6`, `fal-ai/kling-video/v3/4k`, xAI
  `/videos/*`). Mitigate with parity fixtures captured from the Python plugin
  tests and a "contract snapshot" test file per family (payload builder golden
  tests).
- **xAI OAuth in desktop**: Python reads `auth.json` / OAuth pool; desktop must map
  to its own credential store and refresh flow. Open question: does the desktop
  already persist xAI OAuth tokens? (connection_auth.rs exists; needs verification
  during P3.)
- **50 MB base64 in webview**: `video_analyze` mirrors Python but encoding 50 MB in
  JS is heavy; consider kimi-code's upload-channel-first ladder
  (`video-delivery.ts`: upload → `video_url` part, base64 fallback) if the
  auxiliary provider supports it.
- **Long blocking polls vs UI**: Python blocks the tool call for minutes; the
  desktop agent loop must either accept blocking (with `AbortSignal`) or expose job
  progress events. Decision needed; bfl already has `get_result` polling semantics
  to preserve.
- **Nous gateway dependency** (bfl toolset): desktop standalone may lack Nous
  sign-in; hide the toolset when no token (mirror `check_bfl_requirements`). Open:
  whether to ship bfl in the first desktop release.
- **Sandbox/file-path semantics**: `_confine_source_images` and terminal-backend
  resolution are Python-host concepts; the webview analog must reuse Rust file
  reads (`readFileDataUrl`) and the file-safety deny-list instead.
- **Dynamic schema caching**: Python memoizes on config mtime; TS must rebuild the
  description when `video_gen.*` config changes in-session.
- **`openai` JS SDK video surface**: `client.videos` may not exist in v6 — verify
  before choosing SDK vs REST for DeepInfra.

## 10. Test strategy

- **Vitest unit — registry** (parity `tests/agent/test_video_gen_registry.py`):
  reject empty name, sorted listing, single-available auto-resolve,
  unknown-explicit-config fails closed.
- **Vitest unit — dispatch** (parity `tests/tools/test_video_generation_dispatch.py`):
  `no_provider_configured` / `provider_not_registered` errors; kwargs passthrough to
  provider; TypeError → `provider_contract`.
- **Vitest unit — dynamic schema** (parity `test_video_generation_dynamic_schema.py`):
  no-backend wording; both-modalities claim; i2v-only model caveat must not claim
  t2v; active-model duration window preferred.
- **Provider golden tests** (parity `tests/plugins/video_gen/test_fal_plugin.py`,
  `test_xai_plugin*.py`, `test_deepinfra_provider.py`): payload builder per family
  (key dropping, aliases, duration clamp/suffix/int), endpoint routing
  (image_url → i2v), xAI model routing/reference limits, upscale failure fallback.
  Mock `fetch`; assert request method/URL/headers/body and poll loop behavior
  (deadline, terminal statuses, retry-after throttle for bfl).
- **Video analyze** (parity `tests/tools/test_video_analyze.py`): MIME detection,
  data URL shape, schema fields, `auxiliary.video.model` fallback, read-guard
  blocks non-video files, size cap error, non-local source materialization.
- **Adapter/render**: Vitest for `message-adapter.ts` video block mapping and
  `message-video.ts` extraction; Playwright E2E: run `video_generate` (mocked
  provider) → inline `<video>` appears; failure path shows fallback UI; local-path
  video renders via `fetchMediaDataUrl`.
- **Parity harness**: a fixture corpus (request args → Python provider JSON) fed to
  the TS provider builders; assert byte-identical payloads for shared families
  (veo3.1, pixverse-v6, kling-v3-4k, xAI t2v/i2v).

## 11. Reference links

- Python: `D:/hermes-agent-cn/tools/video_generation_tool.py`,
  `tools/xai_video_tools.py`, `tools/flux3_video_tool.py`,
  `tools/vision_tools.py` (§Video Analysis, lines 1806–2221),
  `agent/video_gen_provider.py`, `agent/video_gen_registry.py`,
  `plugins/video_gen/{fal,xai,deepinfra}/__init__.py` + `plugin.yaml`,
  `tools/image_source.py` (`_confine_source_images`), `tools/fal_common.py`,
  `tools/xai_http.py`, `tools/managed_tool_gateway.py`, `toolsets.py`,
  `website/docs/reference/tools-reference.md` (§video, §video_gen),
  `website/docs/reference/toolsets-reference.md`.
- Tests: `D:/hermes-agent-cn/tests/agent/test_video_gen_registry.py`,
  `tests/tools/test_video_generation_dispatch.py`,
  `tests/tools/test_video_generation_dynamic_schema.py`,
  `tests/tools/test_video_analyze.py`,
  `tests/tools/test_video_generation_tool_surface_matrix.py`,
  `tests/plugins/video_gen/test_{deepinfra_provider,fal_plugin,xai_plugin,xai_plugin_integration}.py`.
- TS reference: `D:/kimi-code/packages/agent-core/src/tools/support/video-delivery.ts`,
  `packages/agent-core/src/agent/turn/media-resolve.ts`,
  `packages/agent-core/src/tools/providers/local-fetch-url.ts`,
  `packages/agent-core/src/utils/proxy.ts`, `packages/oauth`,
  `packages/agent-core-v2/package.json` (`openai@^6.34.0`), `packages/kosong/package.json`.
- Desktop: `D:/Hermes-CN-Desktop/web/src/lib/message-images.ts`,
  `web/src/lib/transport.ts` (`fetchMediaDataUrl`),
  `web/src/components/chat/message-adapter.ts`, `message-image.tsx`,
  `markdown-renderer.tsx`, `web/src/components/chat/chat-types.ts`,
  `src/commands/api_proxy.rs`, `src/commands/connection_auth.rs`,
  `src/state.rs`, `packages/protocol/src/hermes-api.ts`.
