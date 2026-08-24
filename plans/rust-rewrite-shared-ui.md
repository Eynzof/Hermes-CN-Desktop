# Plan: Rewrite shared-ui from TypeScript to Rust (`src/`)

- Status: Draft
- Source: `packages/shared-ui/src/...`
- Target Rust: `src/...` — **none recommended**
- Author: analysis subagent
- Date: 2026-08-24

## 1. Executive summary

**NO rewrite is recommended.** `@hermes/shared-ui` is a browser/webview-only UI
package: React components, React/Jotai hooks, CSS Modules, and CSS design tokens
(9 token files + 4 theme files, ~24 KB text) plus two embedded woff2 fonts
(~8.5 MB — that is the bulk of the 8.7 MB package). Rust cannot render React
components, cannot consume CSS custom properties, and has no DOM access; the
Tauri webview is the only consumer of this package (109 files in `web/src`
import `@hermes/shared-ui`, verified by grep). The Rust shell never touches it.

The honest conclusion: shared-ui stays TypeScript, full stop. The only
non-UI-ish code is `src/tokens/skins.ts` (830 lines) — a pure TS skin
registry + YAML/JSON-subset parser + validator with no React/DOM dependency.
It **could** be extracted to a headless package (`@hermes/shared-lib` or
similar) to be unit-tested/CI'd independently, and its hand-rolled YAML-subset
parser is a candidate to share the Rust frontmatter/YAML-subset parser proposed
in `plans/rust-rewrite-skill-lint.md` §5/P5 — but that is a **refactor**, not a
Rust rewrite, and moving it to Rust would add IPC for a startup/user-action
path with no measurable benefit. Recommended: leave skins.ts in TS, optionally
extract it to a headless package, and reuse a shared Rust YAML-subset parser
only if/when a native consumer actually needs the same schema.

## 2. Why rewrite (value/motivation; be honest — "no rewrite" is the conclusion)

| Candidate | Would Rust help? | Evidence |
|---|---|---|
| React components (`components/*`, `composites/dialog`, `composites/popover`) | **No.** Rust cannot render React; components run inside the webview DOM. | `button.tsx` uses `forwardRef`/JSX + `button.module.css`; `dialog.tsx`/`popover.tsx` use Radix primitives. Rewriting means reimplementing a DOM renderer in Rust — outside the established architecture (Rust = OS capabilities, webview = UI, per `docs/typescript-runtime.md`). |
| CSS design tokens (`tokens/*.css`) | **No.** Tokens are CSS custom properties consumed by the browser at paint time. | `colors.css`/`semantic.css`/`primitive.css`/`skins.css`/themes define `--h-*` vars; web components reference them per AGENTS.md styling rule. Rust has no way to "consume" them except generating CSS text, which is worse than the static files. |
| React hooks (`hooks/use-theme.ts`, `hooks/use-platform.ts`) | **No.** They are React/Jotai hooks plus DOM mutation (`document.documentElement.setAttribute`, MutationObserver, `hermesDesktop.setUiZoom`). | `use-theme.ts` uses `atom`/`useAtom` and mutates DOM; `use-platform.ts` uses `useState`/`useEffect`/`MutationObserver`. The pure bits (`normalizeThemeConfig`, `SCALE_FACTORS`, `isSkinSlug`) are tiny and trivially tested in TS. |
| `utils/cn.ts` | **No.** 7-line `clsx` wrapper; trivial. | Moving a class-name combiner to Rust via IPC would be absurd. |
| `tokens/skins.ts` (pure logic) | **Partial / not via IPC.** It is pure TS (no React/DOM), so it *could* live in a headless package; but it is invoked at startup/user action in the webview, not hot path. Rust would only help if a *native* consumer (e.g. a CLI skin-engine) needs the same schema — none exists in-repo today. | File is 830 lines: 14 built-in presets, hex normalization, YAML/JSON-subset parser (`parseSkinSource`), validator, `buildSkinPreset`, `skinTokenToCssVar`. `web/src/lib/skins.ts` re-exports it; `web/src/lib/skins.test.ts` + `packages/shared-ui/src/tokens/skins.test.ts` cover it in vitest. |
| Embedded fonts (`tokens/fonts/*.woff2`) | **No.** Binary assets referenced from CSS. | 8.5 MB of the 8.7 MB package. Nothing to rewrite. |

Cross-cutting observation: `skins.ts` contains its own hand-rolled YAML/JSON
subset parser (lines ~655–822), which is a **third** YAML-subset parser in the
monorepo alongside `packages/skill-lint/src/frontmatter.ts` and
`packages/agent-core/src/skills/loader.ts`. That duplication is a real
maintainability issue — but the fix is a shared parser (TS or Rust), not a Rust
rewrite of the UI package.

## 3. Scope (in-scope / out-of-scope)

### In-scope (this plan)

- Document and justify the no-rewrite conclusion.
- Propose the optional **headless extraction** of `src/tokens/skins.ts` pure
  logic (registry, parser, validator, preset builder) into a new headless
  workspace package (e.g. `@hermes/skin-engine`) that `shared-ui` re-exports
  from. This is a **refactor**, listed here only so it is tracked; it is not a
  Rust rewrite and is **not required**.

### Out-of-scope (explicitly)

- Any Rust module under `src/` for shared-ui components, hooks, tokens, or
  fonts. No Tauri commands. No IPC boundary.
- Changing `packages/shared-ui/src/tokens/*.css` or React component behavior.
- Moving `use-theme.ts`/`use-platform.ts` to Rust (they are React hooks with DOM
  side effects — impossible and pointless).
- `utils/cn.ts` — leave as-is.
- Any change to `web/src/lib/skins.ts` DOM helpers (`applySkin`, etc.).

## 4. Current contract (TS exports, types, consumers, invariants)

### Exports (`packages/shared-ui/src/index.ts`, 40 lines)

- `hooks/use-theme`: `DEFAULT_THEME_CONFIG`, `SCALE_FACTORS`,
  `applyThemeToDOM`, `hydrateThemeAtom`, `normalizeThemeConfig`, `themeAtom`,
  `themeWriteAtom`, `useTheme`; types `DensityVariant`, `ScaleVariant`,
  `ThemeConfig`, `ThemeVariant`.
- `hooks/use-platform`: `usePlatform`, `applyPlatformToDOM`.
- `tokens/skins`: `BUILTIN_SKINS`, `BUILTIN_SKIN_SLUGS`,
  `DEFAULT_SKIN_PRESET`, `SkinValidationError`, `buildSkinPreset`,
  `getSkinBySlug`, `isSkinSlug`, `listSkinSlugs`, `listSkins`,
  `loadSkinFromSource`, `parseSkinSource`, `skinTokenToCssVar`,
  `validateSkinDefinition`; types `SkinBranding`, `SkinDefinition`,
  `SkinPolarity`, `SkinPreset`, `SkinSlug`, `SkinSpinner`, `SkinToken`.
- `utils/cn`: `cn`, type `ClassValue`.
- `components` (re-exported): `alert`, `badge`, `button` (+`IconButton`),
  `card`, `copy-button`, `empty-state`, `field`, `input`, `loading`,
  `page-tabs`.
- `composites`: `Dialog`, `Popover` (Radix-based).

### Types & invariants

- Design tokens: `--h-*` CSS custom properties; AGENTS.md mandates components
  reference these tokens, never hardcode colors.
- `ThemeConfig { theme: ThemeVariant; density: DensityVariant; scale: ScaleVariant; skin: SkinSlug }`;
  `normalizeThemeConfig` falls back to defaults for invalid values.
- Skins: 14 built-in slugs; every preset well-formed (unique slug, non-empty
  branding/spinner arrays, `tokenOverrides.accent` present); user skins parsed
  from a small YAML/JSON subset, hex-normalized (lowercase, 3/4-digit
  expansion), invalid keys/values dropped; `SkinValidationError` on
  non-object/malformed source; `parseSkinSource` auto-detects JSON (`{` prefix).
- `usePlatform` reads `document.body/dataset` → `data-hermes-window-type` and
  observes mutations.

### Consumers (verified by grep)

- **109 files under `web/src/`** import `@hermes/shared-ui` (routes,
  components, app shell, etc.) — the entire webview UI layer.
- `web/src/lib/skins.ts` re-exports and adds DOM apply/inject helpers.
- No Rust code consumes it; no other `packages/*` import it (dependency
  direction per `docs/typescript-runtime.md`: `web` consumes shared-ui).

## 5. Rust design (module layout, public API, serde types, state handling)

N/A — no rewrite. Nothing to design under `src/`.

If the optional headless extraction happens, the target is a **TS** package,
not Rust. Rust involvement is limited to a possible future shared YAML-subset
parser (see §7): if a native consumer ever needs `parseSkinSource` semantics
(e.g. a CLI skin-engine parity tool), reuse the `src/frontmatter/` module from
`plans/rust-rewrite-skill-lint.md` rather than creating a new one — but do not
route the webview skin parse through IPC; it is a startup/user-action path where
IPC adds latency and complexity for zero benefit.

## 6. IPC / boundary (Tauri commands; browser-only-dev fallback strategy)

- **No new Tauri commands.** Shared-ui runs entirely in the webview; the Rust
  shell's only touchpoint is the existing `hermesDesktop.setUiZoom` bridge
  (called from `use-theme.ts` `applyThemeToDOM`), which stays as-is.
- Browser-only dev (`python run.py`) runs the same TS shared-ui with no Rust —
  consistent with the current architecture; nothing changes.
- If skins parsing were ever needed natively (hypothetical CLI), it would be
  invoked as a library/CLI, not as IPC — and only after the headless extraction
  refactor, so the webview keeps its synchronous TS path.

## 7. Implementation phases (ordered, each shippable + testable)

The only actionable phase is a **refactor**, optional and decoupled:

1. **R1 (optional) — Extract pure skins logic to a headless package**
   (`packages/skin-engine/` or extend an existing headless package): move
   `skins.ts` types + registry + `parseSkinSource`/`validateSkinDefinition`/
   `buildSkinPreset`/`skinTokenToCssVar`/`loadSkinFromSource` unchanged;
   `packages/shared-ui/src/tokens/skins.ts` becomes a thin re-export (keeping
   `@hermes/shared-ui` public API byte-identical); move `skins.test.ts` with it
   (plus a shared-ui smoke test that the re-export surface is unchanged).
   *Effort: S–M.*
2. **R2 (optional, only if R1 lands and a native consumer appears) — Share the
   YAML-subset parser with Rust**: decide whether `parseSkinSource` should use
   the Rust `src/frontmatter/` module semantics or stay TS; because skins
   parsing is webview-side, the default is **stay TS** and only dedupe the
   *concept* (document the shared schema), not the runtime.
   *Effort: M, low priority.*
3. **No Rust phases for components/hooks/tokens/fonts.**

## 8. Testing strategy (Rust unit/integration; TS↔Rust parity; vitest parity tests)

- **Rust:** none needed for shared-ui. If R2 ever creates a shared
  `src/frontmatter/` parser, it follows the skill-lint plan's Rust testing
  strategy (§8 of `plans/rust-rewrite-skill-lint.md`).
- **TS (current):** `pnpm test:unit` covers `skins.test.ts` (471 lines),
  `use-theme.test.ts`, `use-platform.test.ts`, `cn.test.ts`; plus
  `web/src/lib/skins.test.ts` and `web/src/lib/theme-defaults.test.ts`. Keep
  green.
- **If R1 lands:** add a re-export parity test asserting `shared-ui`'s exported
  symbol set is unchanged after extraction (`Object.keys` comparison), and keep
  the moved vitest tests in the new headless package.
- **No TS↔Rust parity harness** for shared-ui — there is no Rust counterpart.

## 9. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Someone attempts a partial Rust rewrite of "pure" skins.ts | Document the no-rewrite rationale here; the value of native skins parsing is ~zero (startup/user-action path, webview-side). Revisit only if a native consumer is built. |
| YAML-subset parser duplication grows (3 hand-rolled parsers) | Track as a refactor (R1/R2); prefer a shared TS parser first, Rust shared parser only via the skill-lint plan's P5 when a native consumer exists. |
| Headless extraction changes public API | Keep `src/tokens/skins.ts` re-exporting; add symbol-surface parity test. |
| `web/src/lib/skins.ts` DOM helpers drift from headless package | Leave DOM helpers in `web/`; headless package stays DOM-free (that is the point). |
| Bundled fonts make the package "big" and tempting to move | Fonts are static assets; they belong with the UI. No action. |

## 10. Effort estimate (S/M/L per phase)

| Phase | Scope | Effort |
|---|---|---|
| R1 (optional) | Headless extraction of `tokens/skins.ts` pure logic + re-export + parity tests | S–M |
| R2 (optional) | Shared YAML-subset parser dedupe (TS-first; Rust only via skill-lint P5) | M, low priority |
| Rust rewrite of shared-ui | **Not planned** | — |

Total: **no Rust effort.** Optional refactor R1 ≈ S–M if the team wants
headless testability/CI for the skin engine. Cross-cutting value lives in the
skill-lint plan's shared frontmatter parser (P5), which can later serve any
native consumer of the same YAML-subset schema (including, in theory, skins).
