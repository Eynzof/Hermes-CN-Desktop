# Pets (Petdex) — Python → TypeScript Rewrite Plan

## 1. Summary

Hermes ships an animated **pet / mascot** (petdex spritesheet pets, e.g. `boba`) that
reacts to what the agent is doing (idle / run / review / failed / wave / jump /
waiting), driven by a single activity→state mapping in
`D:/hermes-agent-cn/agent/pet/state.py`. It is off by default, purely cosmetic,
and configured via `display.pet.*` in `config.yaml`. The desktop today receives the
active pet's decoded spritesheet + state metadata over the gateway WS RPCs
(`pet.info` / `pet.gallery` / `pet.thumb` / `pet.cells` / `pet.select` /
`pet.generate` / `pet.hatch` / `pet.changed`) and animates it with a canvas component
in the legacy Electron app (`apps/desktop/...` under the Core repo).

This rewrite moves the whole feature in-process into the Hermes-CN-Desktop Tauri
webview: a Jotai pet store + canvas sprite engine + gallery/settings UI + the
`/pet` slash command + the `/hatch` two-step image-generation pipeline, with pets
stored on disk under `HERMES_HOME/pets/<slug>/` via new Rust IPC commands. **No
pet/mascot equivalent exists in kimi-code** (verified: the only match is a static
`KimiMascot` logo component in the VS Code webview — not an animated petdex
mascot), so the design ports the proven React/canvas implementation that already
exists in Core's legacy Electron app and re-implements the Python engine semantics
in TypeScript.

## 2. Current Python implementation

Source of truth and data flow (all paths under `D:/hermes-agent-cn`):

- `agent/pet/__init__.py` — package facade; single source of truth for the feature.
- `agent/pet/constants.py` — frame geometry (`FRAME_W=192`, `FRAME_H=208`,
  `FRAMES_PER_STATE=6`, `LOOP_MS=1100`), `DEFAULT_SCALE=0.33`, scale clamp
  `MIN_SCALE=0.1`/`MAX_SCALE=3.0`, `PetState` enum
  (`idle|wave|run|failed|review|jump|waiting`), `STATE_ROWS` for the Codex 9-row
  atlas vs legacy 8-row atlas, `STATE_ALIASES` (e.g. `wave`↔`waving`),
  `state_row_index()` (clamps to idle, never raises), `cols_for_scale()` /
  `resolve_cols()` (terminal half-block sizing — desktop doesn't need these).
- `agent/pet/state.py` — the activity→state machine. `derive_pet_state(busy,
  awaiting_input, error, celebrate, just_completed, tool_running, reasoning)` with a
  documented priority: error→failed > celebrate→jump > just_completed→wave >
  awaiting_input→waiting > tool_running→run > reasoning→review > busy→run > idle.
  `todos_all_done()` decides the `jump` celebrate beat.
- `agent/pet/manifest.py` — `https://petdex.dev/api/manifest` (307→R2 JSON),
  `ManifestEntry` dataclass, `fetch_manifest()` with 300 s in-process TTL cache,
  `find_entry()`, `prefetch()` daemon thread (desktop picker warms it).
- `agent/pet/store.py` — on-disk pet store: `pets_dir() = <HERMES_HOME>/pets`,
  `load_pet()`/`installed_pets()`/`resolve_active_pet()` (configured slug → first
  installed), `install_pet()` (host-pins petdex URLs, downloads
  `spritesheet.{webp,png}` + `pet.json`), `register_local_pet()` (writes
  `createdBy: "generator"`), `slugify()`/`unique_slug()`, `export_pet()` zip,
  `thumbnail_png()` (idle-frame crop → cached PNG for gallery previews).
- `agent/pet/render.py` — terminal rendering only (kitty/iTerm2/sixel graphics
  protocols + Unicode half-blocks, `state_frame_counts()` for ragged/blank-trimmed
  rows). The desktop uses the same *decode* semantics but draws with `<canvas>`
  instead of terminal escapes.
- `agent/pet/generate/` — the `/hatch` pipeline:
  - `imagegen.py` — wraps the active reference-capable `ImageGenProvider`
    (Nous/OpenAI/OpenRouter/Krea; `HERMES_PET_IMAGE_PROVIDER` env override),
    `resolve_provider(require_references)`, `generate(prompt, n, reference_images,
    prefix, aspect_ratio)` (square base drafts vs landscape row strips,
    transparent-background retry fallback).
  - `orchestrate.py` — `generate_base_drafts(concept, n=4, style)` (concurrent
    prompt-only variants, hardened to transparent cutouts) then
    `hatch_pet(base_image, slug, …)` (one grounded row strip per state, up to 3
    retries, `_MAX_PARALLEL_GENERATIONS=4`, progress callbacks, running-left
    mirrored from running-right, idle guaranteed from base, atlas compose +
    validate + register).
  - `atlas.py` — deterministic strip→frames extraction (`extract_strip_frames`,
    `components` vs `auto` methods), background chroma-key flood-fill + defringe,
    `normalize_cells` (consistent pose scale), `compose_atlas` (8×9 grid of
    192×208 → 1536×1872), `validate_atlas` (postage-stamp check, filled states),
    `mirror_frames`.
  - `prompts.py` — `STATE_ACTIONS` per row, `_STYLE_HINTS`, `BASE_VARIATIONS`,
    `build_base_prompt()` / `build_row_prompt()`.
- `hermes_cli/pets.py` — `hermes pets list|install|select|off|scale|show|doctor`;
  config helpers `_pet_config()`, `_set_active()`, `_set_enabled()`, `_set_scale()`,
  `set_pet_scale()` (single clamp point), `toggle_pet_display()` (`/pet`),
  `print_pet_gallery()`.
- `cli.py` + `hermes_cli/commands.py` — `/pet` and `/hatch` (alias
  `/generate-pet`) slash handlers wired into the CLI session.
- `tui_gateway/server.py` — WS RPC surface the desktop consumes (async pool):
  `pet.cells`, `pet.gallery`, `pet.generate`, `pet.hatch`, `pet.info`, `pet.select`,
  `pet.thumb`; push event `pet.changed` (2.0) carrying `PetInfoMeta`; the
  `pet.info` payload includes `enabled`, `slug`, `displayName`, `mime`,
  `spritesheetBase64`, `framesByState`/`framesByRow`, `scale`, `stateRows`.
- Docs: `website/docs/user-guide/features/pets.md` — states table, `/pet` and
  `/hatch` UX, desktop (Cmd+K palette, Settings→Appearance, Roam toggle, Alt+wheel
  resize, vibe reactions, pop-out overlay), `display.pet` config schema.
- Tests (parity source): `tests/agent/test_pet_engine.py` (state priority,
  row-index taxonomy, blank-frame trimming, kitty payload — terminal-only parts
  excluded from desktop), `tests/agent/test_pet_generate.py` (atlas ops, store
  register/adopt, orchestration with mocked imagegen), `tests/cli/test_cli_pet_pane.py`
  (pane collapse, config resolve), `tests/hermes_cli/test_pet_toggle.py` (toggle
  errors, scale clamp), `tests/tui_gateway/test_pet_generate_rpc.py` (RPC contract).

**Legacy Electron desktop (already TypeScript, the port source).** Core's
`apps/desktop/` holds a full React implementation we can port almost verbatim:
`components/pet/{pet-sprite,floating-pet,pet-egg-hatch,pixel-egg-sprite,
pet-star-shower,pet-thumb,pet-bubble,use-pet-roam}.tsx`, `app/pet-generate/
{pet-generate-overlay,pet-generate-content,components/hatch-preview,
components/hatching-view,components/draft-grid}.tsx`,
`store/{pet,pet-gallery,pet-overlay,pet-generate}.ts`, `components/chat/vibe-hearts.tsx`.
`pet-sprite.tsx` already proves the canvas animation (RAF loop, per-state frame
stepping, blank-trim, state aliases, roaming walk rows); `store/pet.ts` already
implements `derivePetState` in TS mirroring `agent/pet/state.py`.

## 3. Target TypeScript design

Runs entirely in the Tauri webview; no Python/WS dependency. Module layout under
`D:/Hermes-CN-Desktop`:

```ts
// packages/shared-ui/src/pet/            // pure logic, testable without DOM (jsdom)
//   constants.ts   PetState, PetInfo, PetInfoMeta, PetActivity, frame geometry,
//                  STATE_ROWS, STATE_ALIASES, stateRowIndex(), clampScale()
//   state.ts       derivePetState(activity): PetState  // 1:1 port of agent/pet/state.py
//   manifest.ts    fetchManifest(), findEntry()        // fetch + 300s TTL cache
//   store.ts       PetStore: list/load/resolve/install/remove/registerLocal
//   sprite.ts      decode + slice logic shared by canvas renderer and thumbs
//   atlas.ts       extractStripFrames/composeAtlas/validateAtlas/mirrorFrames
//                  (canvas-2D implementation of agent/pet/generate/atlas.py)
//   imagegen.ts    ImageGenProvider interface + resolveProvider() + generate()
//   orchestrator.ts generateBaseDrafts() / hatchPet()   // port of generate/orchestrate.py

// web/src/stores/pet.ts          Jotai: petInfoAtom, petActivityAtom, petStateAtom,
//                                petRoamAtom, petOverlayAtom (port of old store/pet.ts)
// web/src/components/pet/*.tsx   port of legacy Electron pet components
// web/src/app/pet-generate/*.tsx port of legacy generate overlay (draft grid, egg, hatch)
// src/commands/pet.rs            NEW Rust IPC: pets dir, list/read/write/remove pet
//                                files, read spritesheet (base64), atomic pet.json
// src/commands/pet_overlay.rs    NEW (follow-up): always-on-top transparent window
```

Key runtime design:

1. **Activity → state** — `derivePetState()` is fed from existing chat signals
   (`web/src/stores/chat.ts` busy/awaiting flags, tool events, todo status) exactly
   as the legacy `$petActivity`/`$petState` computed atoms did; priority order
   preserved and parity-tested.
2. **Sprite rendering** — `PetSprite` canvas component (ported from
   `pet-sprite.tsx`): HTMLImageElement loads `data:<mime>;base64,<spritesheetBase64>`
   read from disk via `pet.rs`; RAF loop steps frames per state at `loopMs / count`,
   trims trailing transparent columns, falls back to idle when a row is empty.
3. **Floating pet** — `FloatingPet` (drag, facing-mirror, roam with
   `roamWalkRow()`, Alt+wheel zoom via `usePetZoomGesture`, soft shadow, speech
   bubble, vibe hearts). Roam/position persist in localStorage; roam toggle
   persists in UI store.
4. **Gallery / settings** — `PetsSection` inside `routes/settings.tsx`
   Appearance panel (installed pets + petdex gallery search + size slider + Roam
   toggle) and a "Pets…" item in `web/src/lib/command-palette.ts`
   `COMMAND_PALETTE_COMMANDS` (Cmd+K palette).
5. **`/pet` + `/hatch` slash commands** — extend `web/src/lib/builtin-commands.ts`
   `BuiltinCommandName` from `"compress"` to `"compress" | "pet" | "hatch"`;
   client-side handlers mutate the Jotai pet store instead of delegating to the
   backend.
6. **`/hatch` pipeline** — `Orchestrator` runs in the webview: `generateBaseDrafts`
   → user picks/remixes in `DraftGrid` → `hatchPet` fans out per-state row
   generations (concurrency 4) → `atlas.ts` slices/composes/validates via a
   `<canvas>` offscreen renderer → `pet.rs` writes `spritesheet.webp` + `pet.json`
   → pet appears in store and is adoptable immediately.

## 4. Data models & persistence

- **Runtime state (Jotai)** — port of legacy `store/pet.ts`:
  ```ts
  type PetState = 'idle'|'wave'|'run'|'failed'|'review'|'jump'|'waiting';
  interface PetInfo {
    enabled: boolean; slug?: string; displayName?: string; mime?: string;
    spritesheetBase64?: string; framesByState?: Record<string, number>;
    framesByRow?: Record<string, number>; scale?: number; loopMs?: number;
    stateRows?: string[]; frameW?: number; frameH?: number; framesPerState?: number;
  }
  interface PetActivity { busy?: boolean; awaitingInput?: boolean; error?: boolean;
    celebrate?: boolean; justCompleted?: boolean; toolRunning?: boolean; reasoning?: boolean; }
  ```
  `petStateAtom` = `derivePetState($petActivity, $busy)`, with transient beat
  flashing (`flashPetActivity` 1600 ms) so `failed`/`jump` don't stick.
- **Config persistence** — `display.pet.{enabled,slug,scale}` written by the
  existing config path (`web/src/lib/config-update.ts` + Rust `ui_store.rs`);
  `render_mode`/`unicode_cols` stay terminal-only and can be ignored by desktop
  (kept in the schema for CLI/TUI). Scale clamp `[0.1, 3.0]` enforced once in
  `constants.ts`. Roam toggle + drag position + overlay state persist in
  localStorage (keys mirrored from legacy: `hermes.desktop.pet-position.v2`).
- **Asset persistence** — `HERMES_HOME/pets/<slug>/pet.json` +
  `spritesheet.webp` (or `.png`), identical layout to today so existing installs
  keep working. `pet.rs` validates slugs (bare path segment, reject `.`/`..`) and
  writes `pet.json` atomically. Generated pets get `createdBy: "generator"` so the
  UI can show the "hatched" badge and `export_pet` zip stays available.
- **Migration** — no schema change: the TS store reads the same files the Python
  store wrote. `pet.changed`/`pet.info` payloads become the in-process
  `PetInfo`/`PetInfoMeta` types unchanged.

## 5. Third-party library strategy

| Python dep / feature | TS equivalent | kimi-code evidence |
| --- | --- | --- |
| Pillow (sprite decode, thumbnails, atlas ops) | **None needed** — browser `HTMLImageElement` + Canvas 2D decode WebP/PNG natively; `canvas.toBlob('image/webp')` for writing spritesheets; `ctx.getImageData` for chroma-key/flood-fill/bbox ops | kimi-code ships **no image-processing lib**; its image utils are only MIME/attachment helpers (`apps/kimi-code/src/utils/image/image-mime.ts`, `tui/utils/image-attachment-store.ts`). Legacy Electron `pet-sprite.tsx` already proves canvas-only rendering works in the webview |
| httpx (manifest + spritesheet download) | Native `fetch` with a 300 s TTL cache mirroring `_MANIFEST_TTL`; `URL`-host pinning to `petdex.dev` | kimi-code web tools use native `fetch` (e.g. `packages/agent-core/src/tools/builtin/web/web-search.ts`) |
| orjson (pet.json read/write) | `JSON.parse` / `JSON.stringify` | — |
| YAML config (`display.pet.*`) | Existing config pipeline (`web/src/lib/config-update.ts`, Rust `ui_store.rs`) — YAML parsing belongs to the config feature, not pets | — |
| `ThreadPoolExecutor` (draft/row fan-out) | `Promise.allSettled` with a small concurrency limiter (max 4, mirroring `_MAX_PARALLEL_GENERATIONS`) | — |
| `ImageGenProvider` (OpenAI gpt-image-2 / Krea / Nous / OpenRouter) | **Implement from scratch** — TS provider adapter calling provider REST APIs via `fetch`, routed through existing `src/commands/api_proxy.rs` to dodge webview CORS; same `reference_images`/`reference_image_urls` params and transparent-background retry | kimi-code has **no image-generation provider client** (grep of `packages`/`apps` for image-gen APIs found none) |
| nanostores (legacy Electron state) | Jotai — already the Hermes-CN-Desktop state lib (`web/src/stores/ui.ts` imports `atom` from `jotai`) | kimi-code uses its own stores; no reusable pet store |
| Sprite animation lib | **From scratch** — canvas RAF loop; port `pet-sprite.tsx` (the exact loop already exists in Core's Electron app) | kimi-code's only mascot is a static `<img>` (`KimiMascot.tsx`); no animation engine |
| Terminal graphics (kitty/iTerm/sixel/half-block) | **Out of scope** — the desktop draws with `<canvas>`; terminal encoders stay Python-side | — |

## 6. Integration with existing Hermes-CN-Desktop frontend

- **Command palette** — add a `Pets…` entry to `COMMAND_PALETTE_COMMANDS` in
  `web/src/lib/command-palette.ts` (opens the Pets gallery overlay; mirrors the
  theme picker). `web/src/lib/command-palette-shortcut.ts` needs no change.
- **Settings → Appearance** — extend the `ThemeSection` appearance panel in
  `web/src/routes/settings.tsx` (it already renders `AppearanceRow`s for
  theme/scale/density): add installed-pet list + petdex search, live size slider
  (writes `display.pet.scale` via `setPetScale`), Roam toggle.
- **Composer slash commands** — extend `web/src/lib/builtin-commands.ts`
  (`BuiltinCommandName`, `BUILTIN_ALIASES`, `parseBuiltinComposerCommand`) with
  `pet` and `hatch`; the composer already distinguishes builtin vs skill commands,
  so `/pet boba` and `/hatch a fox` become client-side actions. Until Phase B, they
  fall back to the existing slash delegation path.
- **Activity signals** — reuse `web/src/stores/chat.ts` busy/awaiting flags and
  tool/error events; the legacy `$petActivity` mapping is the reference for which
  events to subscribe to (plus todos-all-done for `jump`).
- **Gateway/WS (migration only)** — `web/src/lib/gateway-client.ts` +
  `transport.ts` + `tauri-bridge.ts` remain the transport during Phase A; the pet
  store listens for `pet.changed` and calls `pet.info` etc. exactly like the
  legacy Electron app did.
- **Rust (new)** — `src/commands/pet.rs` for pet file IO (list/read/write/remove,
  spritesheet → base64, safe slug, atomic pet.json); `src/commands/api_proxy.rs`
  reused for provider image-gen calls; follow-up `src/commands/pet_overlay.rs` for
  the always-on-top pop-out window (no window-overlay command exists today —
  verified `src/commands/*.rs` has no pet/overlay command).
- **Shared UI** — put the pure pet engine in `packages/shared-ui/src/pet/` so it
  can be unit-tested and reused (e.g. by a future mini-composer overlay); React
  components stay in `web/src`.

## 7. Removing the WebSocket dependency (migration path)

Freeze this API surface while migrating (it is the contract the desktop consumes
today, `tui_gateway/server.py`):
`pet.info` · `pet.gallery` · `pet.thumb` · `pet.cells` · `pet.select` ·
`pet.generate` · `pet.hatch` · push event `pet.changed` · config keys
`display.pet.{enabled,slug,scale}`.

- **Phase A (keep backend call today)** — desktop keeps calling the frozen RPCs;
  new Jotai store + components consume `PetInfo`/`PetInfoMeta` unchanged. Add
  `pet.rs` IPC commands alongside.
- **Phase B (in-process module behind the same interface)** — the TS
  `PetStore`/`Manifest`/`Orchestrator` implement the identical interface;
  `petInfoAtom` is hydrated by `pet.rs` disk reads instead of `pet.info`; gallery
  fetches the manifest directly (fetch + TTL cache); `pet.select` writes config
  through `config-update.ts`; `/pet` and `/hatch` handled by `builtin-commands.ts`.
  A flag flips the data source so both paths can coexist and be diffed.
- **Phase C (delete WS/REST pet path)** — desktop stops subscribing to
  `pet.changed` and never calls `pet.*`; the Python gateway methods remain only
  for CLI/TUI surfaces (they are not desktop-standalone). Remove the desktop-side
  gateway pet client code; the frozen RPCs are then safe to delete once CLI/TUI
  move too.

## 8. Migration phases & task breakdown

1. **P0 — engine port**: `packages/shared-ui/src/pet/{constants,state}.ts` +
   vitest parity of `derivePetState` priority, `todos_all_done`, row-index
   taxonomy, scale clamp.
2. **P1 — store + assets**: `pet.rs` IPC (list/load/read spritesheet/install/
   remove/register-local), `manifest.ts`, `store.ts`; parity vs
   `test_pet_toggle.py` + `test_pet_engine.py` store cases.
3. **P2 — render + floating pet**: `sprite.ts` + `PetSprite`/`FloatingPet`
   (port `pet-sprite.tsx`, `floating-pet.tsx`), activity wiring to
   `stores/chat.ts`, `petInfoAtom` hydration (Phase A via `pet.info`, then B via
   `pet.rs`).
4. **P3 — UI surfaces**: Settings→Appearance PetsSection (gallery + slider +
   roam), Cmd+K "Pets…" item, `builtin-commands.ts` `/pet` handler (toggle/list/
   scale/off).
5. **P4 — polish**: Alt+wheel zoom, roam walk rows, vibe hearts, speech bubble,
   pet thumbnails (`pet-thumb.tsx` + `thumbnail` equivalent via `pet.rs`).
6. **P5 — /hatch pipeline**: `imagegen.ts` (provider adapters via
   `api_proxy.rs`), `atlas.ts` (canvas-based strip slicing/compose/validate),
   `orchestrator.ts`, `pet-generate` overlay (draft grid → egg → hatch preview);
   `/hatch` in `builtin-commands.ts`.
7. **P6 — WS removal + pop-out overlay**: flip to in-process-only, delete
   desktop pet gateway client; follow-up `pet_overlay.rs` always-on-top window +
   mini-composer.

## 9. Risks & open questions

- **No TS equivalent in kimi-code** — the feature must be built from scratch in
  TS; the main mitigation is porting the legacy Electron implementation (already
  React/TS) rather than inventing new architecture. Risk of drift from Python
  semantics is mitigated by parity tests (section 10).
- **WebP encode support in the Tauri webview** — `canvas.toBlob('image/webp')`
  is reliable in WebView2/Chromium but uncertain on Linux WebKitGTK; fallback:
  write `spritesheet.png` (PNG always encodable) and keep `mime` in `pet.json`.
- **Provider API keys + CORS** — in-process image-gen calls must reuse existing
  provider credentials and route through `api_proxy.rs`; a new "no reference-
  capable backend" error path must mirror `resolve_provider`'s actionable message.
- **Cancellation** — browsers can't hard-cancel in-flight fetches; port Python's
  cooperative `is_cancelled` polling and drop late results (a cancelled hatch
  must never write a half-built pet).
- **Pop-out overlay** — always-on-top transparent windows are platform-sensitive
  (macOS permissions, Linux compositors); treat as follow-up; in-window pet is the
  v1 target.
- **Open questions**: (a) does the desktop need `pet.cells` (per-frame PNG encode
  used by TUI/Ink) at all? — no, canvas draws from the sheet directly; (b) should
  `render_mode`/`unicode_cols` remain in the TS config schema for display only?;
  (c) the plans dir has no dedicated image-generation plan yet — this plan assumes
  the provider abstraction from `agent/image_gen_registry.py` /
  `agent/pet/generate/imagegen.py` and should be cross-linked when that plan lands.

## 10. Test strategy

- **Vitest unit (jsdom/Node)** — `packages/shared-ui/src/pet/`:
  - `state.test.ts`: port `test_pet_engine.py::test_derive_priority_order` +
    `test_todos_all_done` verbatim (table-driven parity).
  - `constants.test.ts`: `stateRowIndex` for 8-row/9-row atlases + aliases,
    `clampScale` bounds.
  - `manifest.test.ts`: TTL caching, redirect fetch, error normalization
    (mock `fetch`).
  - `store.test.ts`: safe-slug rejection, `resolveActivePet` precedence,
    register-local → adoptable (port `test_pet_toggle.py`,
    `test_pet_engine.py` store cases), `uniqueSlug` collision.
  - `atlas.test.ts`: strip extraction counts, blank/transparent padding trim,
    compose→validate shape, postage-stamp rejection, running-left mirror
    (port `test_pet_generate.py` with synthetic canvas strips — use a small
    canvas-drawn fixture or a `node-canvas` dev-dep for hermetic tests).
  - `orchestrator.test.ts`: mocked `ImageGenProvider` end-to-end hatch with
    progress events + cancellation (port `test_hatch_pet_end_to_end`).
- **Component tests (vitest + @testing-library/react)** — `PetSprite` frame
  stepping with a fake sheet; `FloatingPet` render/collapse when disabled;
  `PetsSection` adopt/slider; `builtin-commands` `/pet`/`/hatch` parsing.
- **Playwright E2E** — Settings gallery adopt → floating pet appears;
  `display.pet.scale` slider live-resizes; `/pet` toggle; `/hatch` happy path with
  a stubbed provider endpoint (draft grid → hatch → pet in gallery).
- **Parity gate** — the `derivePetState` priority table and row-taxonomy mapping
  are the two invariants that must match Python exactly; a table-driven test
  locks them.

## 11. Reference links

- Python: `D:/hermes-agent-cn/agent/pet/{__init__,constants,state,manifest,store,render}.py`,
  `agent/pet/generate/{imagegen,orchestrate,atlas,prompts,__init__}.py`,
  `hermes_cli/pets.py`, `tui_gateway/server.py` (pet RPCs + `pet.changed`),
  `website/docs/user-guide/features/pets.md`.
- Python tests (parity): `tests/agent/test_pet_engine.py`,
  `tests/agent/test_pet_generate.py`, `tests/cli/test_cli_pet_pane.py`,
  `tests/hermes_cli/test_pet_toggle.py`, `tests/tui_gateway/test_pet_generate_rpc.py`.
- Legacy Electron TS (port source): `D:/hermes-agent-cn/apps/desktop/src/components/pet/*`,
  `apps/desktop/src/app/pet-generate/*`, `apps/desktop/src/store/{pet,pet-gallery,pet-overlay,pet-generate}.ts`.
- kimi-code (no equivalent): `apps/vscode/webview-ui/src/components/KimiMascot.tsx`
  (static logo only) — verified `\bpet\b|mascot` has **0** matches under
  `packages/` and only the static mascot under `apps/`.
- Desktop integration: `D:/Hermes-CN-Desktop/web/src/lib/{command-palette.ts,
  builtin-commands.ts,gateway-client.ts,transport.ts,tauri-bridge.ts}`,
  `web/src/routes/settings.tsx`, `web/src/stores/*.ts` (Jotai),
  `src/commands/{api_proxy.rs,ui_store.rs}`.
