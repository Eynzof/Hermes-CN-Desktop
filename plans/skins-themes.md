# Skins & Themes — Python → TypeScript Rewrite Plan

## 1. Summary

Hermes Core ships a data-driven **skin/theme engine** (`hermes_cli/skin_engine.py`): 9
built-in skins (`default`, `ares`, `mono`, `slate`, `daylight`, `warm-lightmode`,
`poseidon`, `sisyphus`, `charizard`) plus user YAML skins from `~/.hermes/skins/`.
A skin is a YAML document with `colors`, paired `light_colors`/`dark_colors`,
`spinner` (faces/verbs/wings), `branding` strings, `tool_prefix`, `tool_emojis`,
and optional Rich-markup `banner_logo`/`banner_hero`. The gateway serializes the
active skin (`tui_gateway/server.py: resolve_skin`) and broadcasts it as a
`skin.changed` WS event so the CLI/TUI/desktop can repaint live.

The desktop (React webview) is **not a terminal**: it already has its own theme
system (`packages/shared-ui/src/tokens/*.css` + `hooks/use-theme.ts`, 6
`[data-theme]` variants persisted in the UI store) and **does not today consume**
`skin.changed` (no handler found in `web/src`). The rewrite therefore maps CLI
skin *semantics* (colors, spinner, branding, tool emojis) onto the existing token
system as **skin presets** that compose with the structural theme, and declares
**custom YAML skins out of scope for v1** (JSON+zod custom skins later, mirroring
kimi-code). This plan is design-only; no code is implemented here.

## 2. Current Python implementation

Source of truth and data flow (all paths under `D:/hermes-agent-cn`):

- `hermes_cli/skin_engine.py` (1068 lines) — the skin SDK:
  - `SkinConfig` dataclass: `name`, `description`, `colors`,
    `light_colors`/`dark_colors` (paired polar palettes), `spinner`, `branding`,
    `tool_prefix` (default `┊`), `tool_emojis`, `banner_logo`, `banner_hero`;
    helpers `get_color`, `get_spinner_wings`, `get_branding`.
  - `_BUILTIN_SKINS` dict holds all **9** built-ins; each is a complete palette
    (light-authored: `daylight`, `warm-lightmode`; dark-authored: the rest;
    `default` also ships a hand-tuned `light_colors` overlay).
  - `_build_skin_config` merges user overrides over the `default` skin (missing
    keys inherit; `light_colors`/`dark_colors` are NOT merged, they are optional
    overlays).
  - `list_skins()` (builtin + user, user shadows built-in), `load_skin(name)`
    (user dir first, then built-in, then fallback `default`), cached
    `get_active_skin()`, `set_active_skin()`, `init_skin_from_config(config)`
    (reads `display.skin` from config at CLI startup).
  - `get_prompt_toolkit_style_overrides()` — maps skin colors onto
    prompt_toolkit style classes (status bar, completion menu, clarify/sudo/
    approval dialogs, voice status). Convenience helpers:
    `get_active_prompt_symbol`, `get_active_help_header`, `get_active_goodbye`.
- `hermes_cli/skin_cmd.py` — `hermes skin list|use|set`:
  - `set` edits ONE color of the active skin in place (user skin) or forks a
    built-in into `<name>-custom.yaml` carrying the full palette; validates
    `#rrggbb`; writes atomically (`utils.atomic_yaml_write`, fsync — regression
    guards in tests for truncation/`safe_load("")` and symlinked files).
- `cli.py` (repo root) — CLI integration:
  - `init_skin_from_config(CLI_CONFIG)` at startup (line ~800).
  - `_handle_skin_command("/skin …")` — live switch + `_apply_tui_skin_style()`
    (prompt_toolkit refresh) + persist via `save_config_value`.
  - `_install_skin_light_mode_hook()` wraps `SkinConfig.get_color` so every read
    is remapped for light terminals; `_detect_light_mode()` probes terminal
    background (env overrides `HERMES_LIGHT`, `HERMES_TUI_*`, `COLORFGBG`,
    OSC 11 with DA1 fence), `_maybe_remap_for_light_mode` table, `_SkinAwareAnsi`
    lazy ANSI escapes; `_build_compact_banner()` uses skin branding + colors.
- `hermes_cli/colors.py` — `should_use_color()` (NO_COLOR/TERM=dumb/
  FORCE_COLOR/CLICOLOR_FORCE/TTY) + `Colors` ANSI codes + `color()`.
- `agent/display.py` — consumer helpers: `get_skin_tool_prefix()` and
  `get_tool_emoji(tool_name)` with resolution chain **skin override → tool
  registry emoji → hardcoded `_TOOL_EMOJIS` → default `⚡`**; `_diff_ansi()`
  derives diff colors from skin; spinner faces/verbs defaults live here.
- `tui_gateway/server.py` (resolve_skin at line ~3410) — serializes the active
  skin (`name`, `colors`, `light_colors`, `dark_colors`, `branding`,
  `banner_logo`, `banner_hero`, `tool_prefix`, `help_header`); `_skin_sig()`
  (name + active user-file mtime) + `_ensure_skin_watcher()` broadcast
  `skin.changed`; `tui_gateway/ws.py` sends `{"payload": {"skin": …}}` on
  connect. `tui_gateway/methods_config.py` exposes `display.skin` RPC.
- Docs: `website/docs/user-guide/features/skins.md` — YAML schema, built-in
  table, complete key list, custom-skin template, Hermes Mod editor reference.
- Tests (parity source): `tests/test_cli_skin_integration.py`,
  `tests/cli/test_cli_light_mode.py`, `tests/hermes_cli/test_skin_engine.py`,
  `test_skin_cmd.py`, `test_skin_palettes.py` (completeness + WCAG contrast
  floors: STRONG ≥ 3.9, SOFT ≥ 2.8, fill polarity per dark/light pole).

## 3. Target TypeScript design

Two-layer model in `D:/Hermes-CN-Desktop`:

1. **UI Theme** (existing, unchanged): `ThemeVariant` =
   `light | light-modern | dark | dark-modern | dracula | catppuccin-mocha`.
   Controls the *structural* look (surfaces, borders, text) via
   `[data-theme]` CSS blocks in `packages/shared-ui/src/tokens/colors.css`.
2. **Skin Preset** (new): the ported CLI skin concept. A preset layers
   accent/brand/spinner/tool-emoji metadata on top of any UI theme. Applied via
   a new `data-skin="<slug>"` attribute + a `--h-skin-*` CSS custom-property
   block per preset; structural tokens keep resolving from the UI theme, so
   e.g. `ares` on `dark` vs `ares` on `dracula` both work.

Module layout (no implementation in this plan; signatures only):

```ts
// packages/shared-ui/src/skins/skin-presets.ts
export type SkinSlug =
  | "default" | "ares" | "mono" | "slate" | "daylight" | "warm-lightmode"
  | "poseidon" | "sisyphus" | "charizard";

export interface SkinPreset {
  slug: SkinSlug;
  name: string;              // human label
  description: string;
  source: "builtin";         // "user" reserved for future JSON custom skins
  polarity: "dark" | "light";// which terminal pole the CLI skin was authored for
  // semantic overrides keyed by existing shared-ui tokens (subset below)
  tokenOverrides: Partial<Record<SkinToken, string>>;
  branding: { agentName: string; responseLabel: string; promptSymbol?: string; welcome?: string; goodbye?: string; helpHeader?: string };
  spinner: { waitingFaces: string[]; thinkingFaces: string[]; thinkingVerbs: string[]; wings: [string, string][] };
  toolEmojis: Record<string, string>;   // per-tool emoji overrides
  bannerLogo?: string;        // optional ASCII/art text; Rich markup → later
  bannerHero?: string;
}

export type SkinToken =
  | "bgApp" | "bgSurface" | "fgDefault" | "fgMuted" | "borderDefault"
  | "accent" | "accentSoft" | "accentBorder"
  | "statusOk" | "statusWarn" | "statusDanger"
  | "codeBg" | "diffAdded" | "diffRemoved"; // mapped from CLI color keys
```

- `skin-schema.ts` — zod schema (name required; hex regex; unknown keys dropped),
  mirroring kimi-code `custom-theme-loader.ts`'s zod pattern (evidence §5).
- `use-skin.ts` (hook) — reads `skinAtom`, exposes `activeSkin`,
  `toolEmoji(toolName)`, `spinnerFrame()`, `branding`.
- `applySkinToDOM(skin)` — sets `document.documentElement.dataset.skin` and
  injects `--h-skin-*` custom properties (or relies on CSS
  `[data-skin="ares"]` blocks in a new `tokens/skins.css`).

Data flow: `main.tsx` bootstrap reads `hermes-theme` from UI store →
`hydrateThemeAtom` seeds `themeAtom` (extended with `skin`) → `applyThemeToDOM`
sets `data-theme` + `data-skin` → components use `useTheme()`/`useSkin()`
live; switching in Settings writes the atom, persists to UI store, re-applies
to DOM — same hot-swap pattern as kimi-code's `currentTheme.setPalette()`.

The 9 built-ins port as follows: `default` = Hermes gold accent; `ares` =
crimson/bronze; `mono` = grayscale; `slate` = royal blue; `daylight` &
`warm-lightmode` = light-polarity presets; `poseidon`, `sisyphus`, `charizard`
= character skins (spinner/branding/tool emojis + accent). Terminal-only keys
(`status_bar_*`, `completion_menu_*`, `voice_status_bg`, `selection_bg`,
`shell_dollar`) have **no React mapping** and are dropped or folded into
`statusOk/Warn/Danger`/`codeBg` equivalents — see §9 risk.

## 4. Data models & persistence

- `ThemeConfig` (in `packages/shared-ui/src/hooks/use-theme.ts`) gains an
  optional `skin: SkinSlug` field; `normalizeThemeConfig` defaults unknown
  values to `"default"` (no breaking change for existing persisted config).
- Persistence: the existing UI-store key `hermes-theme` (JSON written via
  `__HERMES_UI_STORE__?.set?.("hermes-theme", …)`, read in `main.tsx`) — extend
  the object with `skin`. No SQLite/IndexedDB schema change; the store is a
  kv JSON blob, so no migration step is required (old blobs normalize).
- Built-in presets are TS/JSON constants (port of `_BUILTIN_SKINS`); no
  `~/.hermes/skins/` filesystem access in v1 (custom YAML out of scope).
- Future custom skins (v2, JSON): files under the profile dir
  (`~/.hermes/themes/` analogue — kimi-code uses `getDataDir()/themes/*.json`);
  Tauri side would expose a Rust command to list/read/write them, or a browser
  export/import flow.

## 5. Third-party library strategy

| Python dependency | TS equivalent | Evidence / decision |
|---|---|---|
| PyYAML (`yaml.safe_load`, skin files) | **JSON + zod**; YAML **out of scope for v1** | kimi-code `apps/kimi-code/src/tui/theme/custom-theme-loader.ts` reads `~/.kimi-code/themes/<name>.json`, validates with `CustomThemeSchema = z.object({ name, displayName, base: z.enum(['dark','light']), colors: z.record(z.string(), z.string()) })`, drops non-hex values, merges over `base` palette (`loadCustomThemeMerged`), reserves `dark/light/auto` names, lists via `readdir`. If YAML import is ever wanted, npm `yaml` exists — but JSON-first keeps the zod schema + no parser dependency. |
| Rich console markup (`[bold #hex]…[/]` in `banner_logo`/`banner_hero`, diff/banner styling) | **Implement a thin from-scratch subset parser** (tags `[bold]`, `[dim]`, `[#rrggbb]`, `[/]`) → React spans/ANSI; desktop mainly needs banner art in a `<pre>` | kimi-code has **no Rich equivalent**; it uses `chalk` (`theme/theme.ts`, `pi-tui-theme.ts`) and `cli-highlight` (`pi-tui-theme.ts` `highlightCode`) for terminal ANSI. React webview does not need ANSI — CSS styling suffices; only the ASCII-art strings need parsing. |
| prompt_toolkit (style overrides for live TUI refresh) | **N/A — CSS variables** (`tokens/*.css`) + atom-driven DOM re-apply | No prompt_toolkit in TS. kimi-code's live-switch analogue is `Theme.setPalette` + `transcriptContainer.invalidate()` (`tui/kimi-tui.ts` `applyTheme`); desktop achieves the same via `applyThemeToDOM`. |
| ANSI color utilities (`hermes_cli/colors.py`, `should_use_color`) | **N/A in webview**; CSS + `data-theme`; embedded terminal passes raw ANSI through the existing Rust pty/xterm path untouched | `colors.py` exists only for terminal output; desktop components never emit ANSI. If a shared ANSI renderer is needed for transcript code blocks later, kimi-code evidence: `chalk` + `cli-highlight` (`pi-tui-theme.ts`). |
| skin file watcher (gateway `_ensure_skin_watcher`, mtime sig) | **Out of scope v1** (no user skin files); if custom skins land, Tauri `notify` crate or `fs.watch` | kimi-code custom themes are read once at startup and on explicit `/theme` switch (`custom-theme-loader.ts` uses `readFile`/`readdir`, no watcher). |
| `utils.atomic_yaml_write` (fsync, symlink-safe writes) | **N/A v1**; future JSON custom-skin writer should mirror `skin_cmd._skin_set` semantics (fork built-in → `<name>-custom`, atomic write) | Port the *behavior* (edit-one-token-never-disturbs-rest) into the future editor UI; no TS fs library needed until then. |

Terminal-background detection (OSC 11 / COLORFGBG in `cli.py` and kimi-code
`theme/detect.ts`) is **not needed**: the webview knows its theme explicitly.

## 6. Integration with existing Hermes-CN-Desktop frontend

- **Reuse**: `packages/shared-ui/src/hooks/use-theme.ts` (atoms +
  `applyThemeToDOM` + UI-store persistence), `tokens/colors.css` /
  `semantic.css` (extend with `[data-skin="…"]` blocks in a new
  `tokens/skins.css`), `web/src/main.tsx` bootstrap, `web/src/routes/settings.tsx`
  `ThemeSection` + `ThemeSkinPicker` (currently a hard-coded `THEME_SKINS` array
  of 6; replace/extend with the 9 preset entries + a "skin preview" card),
  `web/src/components/app-shell/app-top-bar.tsx` (`useTheme` consumer).
- **New hook**: `useSkin()` in shared-ui (or `web/src/hooks/use-skin.ts` if it
  needs protocol types) exposing preset metadata; consumed by:
  - `components/chat/message-timeline.tsx` tool cards + `tool-activity.ts` —
    use `skin.toolEmojis` for the tool name badge/status chip (resolution:
    skin override → built-in tool emoji map → generic icon), matching
    `agent/display.py:get_tool_emoji`.
  - `components/loading/loading.tsx` (`LoadingIndicator`) — optional
    `face`/`verb` props fed from `skin.spinner` for the running/tool states.
  - App header / welcome / goodbye surfaces — `skin.branding.agentName`,
    `responseLabel` where the product shows the agent identity (guide.tsx
    already branches on `themeConfig.theme`; add skin branding there).
- **Rust side**: no new Tauri commands in v1 (presets are frontend constants).
  Future custom-skin JSON I/O would add `src/commands/` commands following the
  existing `ui_store.rs` pattern.
- CSS convention from `AGENTS.md`: never hard-code colors in components — all
  skin colors flow through `--h-*` tokens / `data-skin` blocks.

## 7. Removing the WebSocket dependency (migration path)

Current state: Core pushes skin state over the gateway (`tui_gateway/ws.py`
sends `skin` payload on connect; `server.py` broadcasts `skin.changed` on
config/skin-file change), and `display.skin` is exposed as a config RPC
(`methods_config.py`). **The desktop already ignores these** — no
`skin.changed` handler exists in `web/src` (grep confirms); theme switching is
purely local via `use-theme.ts` + UI store. So the skin feature is effectively
WS-independent today; the migration is mostly *formalizing* that:

- **Phase A (today)**: freeze the `resolve_skin()` payload shape as a zod
  schema `SkinPresetPayload` in `packages/protocol` (documented, not consumed);
  keep desktop theme local. Optional parity bridge: writing the desktop's skin
  choice back to `display.skin` via the config REST API so CLI/TUI match.
- **Phase B (in-process)**: ship the TS skin engine (`skin-presets.ts` +
  `use-skin.ts`) behind the same interface as the frozen payload; desktop
  renders from local state only.
- **Phase C (WS removed)**: delete the `skin.changed` handling/consumption on
  the backend-facing side; the frozen schema stays as the interop contract for
  embedded-terminal parity. The in-app terminal (Rust `terminal.rs` spawns the
  CLI with `FORCE_COLOR=1`) continues to use the CLI's own YAML skins — that
  path is a pty passthrough and is unaffected.

API surface to freeze: `SkinPresetPayload` = `{ name, colors, light_colors,
dark_colors, branding, banner_logo, banner_hero, tool_prefix, help_header }`
(from `tui_gateway/server.py:resolve_skin`).

## 8. Migration phases & task breakdown

| Phase | Tasks | Deliverable |
|---|---|---|
| P1 — Port data & schema | Port `_BUILTIN_SKINS` → `skin-presets.ts` (9 entries, colors→`SkinToken` mapping, spinner/branding/toolEmojis); zod `skin-schema.ts`; extend `ThemeConfig` with `skin`; `normalizeThemeConfig` | Registry + schema (pure TS, unit-testable) |
| P2 — Token mapping | New `tokens/skins.css` with `[data-skin="…"]` blocks; define `--h-skin-*` mapping table (CLI key → token); add light-polarity variants for `daylight`/`warm-lightmode`; contrast audit | CSS variables + mapping doc |
| P3 — State & UI | Extend `use-theme.ts` atoms + `applyThemeToDOM` (set `data-skin`); `useSkin()` hook; extend `ThemeSkinPicker`/`ThemeSection` in `settings.tsx` with preset cards; persist via UI store | Live theme switching for 9 skins |
| P4 — Surface integration | Tool emoji lookup in `message-timeline.tsx`/`tool-activity.ts`; spinner faces in `LoadingIndicator`; branding strings in header/welcome/guide | Skins affect chat + loading + branding |
| P5 — Parity & protocol | `SkinPresetPayload` zod schema in `packages/protocol`; optional `display.skin` write-back bridge; docs page | Interop contract frozen |
| P6 — Cleanup | Remove/never-add `skin.changed` subscription; delete WS skin path when backend link is removed | WS-independent skin system |

## 9. Risks & open questions

- **No TS equivalent found**: YAML skins (PyYAML) and Rich console markup have
  no kimi-code/TS equivalent; v1 avoids YAML (JSON+zod instead) and implements a
  tiny Rich-subset parser for banner art only. If the team wants true
  `~/.hermes/skins/*.yaml` support in desktop, that is a separate feature
  (adds `yaml` npm dep + Rust fs commands + watcher).
- Terminal-only skin keys (`status_bar_*`, `completion_menu_*`,
  `voice_status_bg`, `selection_bg`, `shell_dollar`, `diff_*`) have no direct
  React mapping; dropping them changes the "complete palette" contract — decide
  whether to keep a 1:1 hex map in the preset for reference even when unused.
- Spinner faces/verbs and ASCII `banner_logo`/`banner_hero` are terminal
  culture (kawaii/ASCII art); porting all 9 verb sets into a web UI may feel
  kitschy — needs design review; character skins (poseidon/sisyphus/charizard)
  may ship as accent+branding only.
- Contrast: Core enforces WCAG-ish floors (`test_skin_palettes.py` STRONG ≥
  3.9 / SOFT ≥ 2.8); desktop skins must re-run the audit against the real
  `--h-bg-*` surfaces, not the CLI's assumed poles.
- Naming collision: `default` skin slug vs `ThemeVariant` default; keep slugs
  under a separate `data-skin` namespace to avoid ambiguity.
- User expectation: CLI users may expect the desktop to pick up their
  `~/.hermes/skins` YAML; v1 must document "custom YAML skins out of scope".

## 10. Test strategy

- **Vitest unit** (`packages/shared-ui`): registry completeness (9 presets, all
  required `SkinToken`s, unique slugs); `normalizeThemeConfig` accepts/ignores
  `skin`; `applyThemeToDOM` sets `data-theme`+`data-skin`; `useSkin`
  `toolEmoji` resolution order (skin → builtin → default); spinner/branding
  validation; **contrast audit ported from `test_skin_palettes.py`** (WCAG
  luminance/contrast helpers in TS, run against each `[data-skin]` block's
  effective tokens on the dark/light pole).
- **Integration**: Settings `ThemeSkinPicker` → atom update → DOM attrs →
  UI-store persistence (mock `__HERMES_UI_STORE__`); parity test comparing a
  few golden values (e.g. `ares.banner_border` `#A93333`, `slate.ui_accent`
  `#7eb8f6`) against the Python `_BUILTIN_SKINS` values (snapshot fixture).
- **Playwright E2E** (`e2e/`): switch each of the 9 skins, assert
  `document.documentElement` attributes + a screenshot/visual check per skin;
  assert tool-card emoji updates for a real tool event; assert no regressions
  in the 6 existing `data-theme` variants.
- **Rust tests**: none required in v1 (frontend-only). If custom JSON skins
  land, add `#[tauri::command]` unit tests per `AGENTS.md` conventions.

## 11. Reference links

- Python: `D:/hermes-agent-cn/hermes_cli/skin_engine.py`, `skin_cmd.py`,
  `colors.py`, `D:/hermes-agent-cn/cli.py`,
  `D:/hermes-agent-cn/agent/display.py`,
  `D:/hermes-agent-cn/tui_gateway/server.py` (resolve_skin),
  `D:/hermes-agent-cn/tui_gateway/ws.py`, `tui_gateway/methods_config.py`
- Docs: `D:/hermes-agent-cn/website/docs/user-guide/features/skins.md`
- Tests: `D:/hermes-agent-cn/tests/test_cli_skin_integration.py`,
  `tests/cli/test_cli_light_mode.py`, `tests/hermes_cli/test_skin_engine.py`,
  `test_skin_cmd.py`, `test_skin_palettes.py`
- TS reference (kimi-code): `apps/kimi-code/src/tui/theme/{index,theme,colors,
  custom-theme-loader,detect,pi-tui-theme}.ts`, `tui/kimi-tui.ts` (applyTheme),
  `cli/run-shell.ts`, `packages/pi-tui/src/components/{markdown,editor}.ts`
- Desktop: `packages/shared-ui/src/tokens/{index,colors,semantic,primitive,
  component}.css`, `packages/shared-ui/src/hooks/use-theme.ts`,
  `packages/shared-ui/src/components/loading/loading.tsx`,
  `web/src/main.tsx`, `web/src/routes/settings.tsx`,
  `web/src/components/app-shell/app-top-bar.tsx`,
  `web/src/components/chat/{message-timeline.tsx,tool-activity.ts}`
