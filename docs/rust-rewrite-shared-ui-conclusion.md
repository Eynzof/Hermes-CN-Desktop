# Conclusion: Do Not Rewrite `@hermes/shared-ui` in Rust

- Status: **Decided — No rewrite**
- Plan: [`plans/rust-rewrite-shared-ui.md`](../plans/rust-rewrite-shared-ui.md)
- Source package: `packages/shared-ui`
- Target Rust: `src/` — **none**

## Decision

`@hermes/shared-ui` will **not** be rewritten in Rust. It stays a TypeScript
package, and the Rust shell (`src/`) remains untouched by this plan. The only
actionable follow-up is an **optional, non-required** headless extraction of the
pure `tokens/skins.ts` logic into a new TS workspace package — a refactor, not a
Rust rewrite.

## Rationale

`shared-ui` is a browser/webview-only UI package. Rust cannot render React
components, cannot consume CSS custom properties, and has no DOM access. The
Tauri webview is the only consumer of this package, and the Rust shell never
touches it.

| Candidate | Would Rust help? | Evidence |
|---|---|---|
| React components (`components/*`, `composites/dialog`, `composites/popover`) | **No.** Rust cannot render React; components run inside the webview DOM. | `button.tsx` uses `forwardRef`/JSX + `button.module.css`; `dialog.tsx`/`popover.tsx` use Radix primitives. Rewriting means reimplementing a DOM renderer in Rust — outside the established architecture (Rust = OS capabilities, webview = UI). |
| CSS design tokens (`tokens/*.css`) | **No.** Tokens are CSS custom properties consumed by the browser at paint time. | `colors.css`/`semantic.css`/`primitive.css`/`skins.css`/themes define `--h-*` vars; components reference them per the AGENTS.md styling rule. Rust's only option is generating CSS text, which is worse than the static files. |
| React hooks (`hooks/use-theme.ts`, `hooks/use-platform.ts`) | **No.** They are React/Jotai hooks plus DOM mutation (`document.documentElement.setAttribute`, `MutationObserver`, `hermesDesktop.setUiZoom`). | `use-theme.ts` uses `atom`/`useAtom` and mutates DOM; `use-platform.ts` uses `useState`/`useEffect`/`MutationObserver`. The pure bits (`normalizeThemeConfig`, `SCALE_FACTORS`, `isSkinSlug`) are tiny and trivially tested in TS. |
| `utils/cn.ts` | **No.** 7-line `clsx` wrapper; trivial. | Moving a class-name combiner to Rust via IPC would be absurd. |
| `tokens/skins.ts` (pure logic) | **Partial / not via IPC.** Pure TS (no React/DOM), so it *could* live in a headless package; but it is invoked at startup/user action in the webview, not a hot path. Rust would only help if a *native* consumer (e.g. a CLI skin-engine) needs the same schema — none exists in-repo today. | 830 lines: 14 built-in presets, hex normalization, YAML/JSON-subset parser (`parseSkinSource`), validator, `buildSkinPreset`, `skinTokenToCssVar`. Covered by `web/src/lib/skins.test.ts` + `packages/shared-ui/src/tokens/skins.test.ts` in vitest. |
| Embedded fonts (`tokens/fonts/*.woff2`) | **No.** Binary assets referenced from CSS. | 8.5 MB of the 8.7 MB package. Nothing to rewrite. |

## Evidence: consumers

- ~110 files under `web/src/` reference `@hermes/shared-ui` (grep count: 114
  occurrences across 110 files) — the entire webview UI layer.
- `web/src/lib/skins.ts` re-exports `skins.ts` and adds DOM apply/inject helpers.
- No Rust code consumes it; no other `packages/*` imports it (dependency
  direction: `web` consumes `shared-ui`).

## Optional follow-up (refactor, not required)

The only non-UI-ish code in the package is `packages/shared-ui/src/tokens/skins.ts`
(830 lines) — a pure TS skin registry + YAML/JSON-subset parser + validator with
no React/DOM dependency. It **could** be extracted to a headless workspace
package (e.g. `@hermes/skin-engine`) so it can be unit-tested/CI'd independently,
and its hand-rolled YAML-subset parser is a candidate to share with the Rust
frontmatter/YAML-subset parser proposed in `plans/rust-rewrite-skill-lint.md`
(§5/P5). That is a **TS refactor, not a Rust rewrite**, and is **not required**.

If it is done, the contract is:
- Move `skins.ts` types + registry + `parseSkinSource` / `validateSkinDefinition`
  / `buildSkinPreset` / `skinTokenToCssVar` / `loadSkinFromSource` unchanged
  into the headless package.
- `packages/shared-ui/src/tokens/skins.ts` becomes a thin re-export, keeping
  `@hermes/shared-ui`'s public API byte-identical.
- Move `skins.test.ts` with it, and add a symbol-surface parity test asserting
  `shared-ui`'s exported symbol set is unchanged after extraction
  (`Object.keys` comparison).
- Do not change the public API; do not move the DOM helpers in `web/src/lib/skins.ts`.

Recommended default: **leave `skins.ts` in TS**. Move it to Rust only if/when a
native consumer actually needs the same YAML-subset schema — and then reuse the
shared Rust `src/frontmatter/` parser from the skill-lint plan rather than
creating a new one. Do **not** route the webview skin parse through IPC; it is a
startup/user-action path where IPC adds latency and complexity for zero benefit.

## Explicitly out of scope

- Any Rust module under `src/` for shared-ui components, hooks, tokens, or
  fonts. No Tauri commands. No IPC boundary.
- Changing `packages/shared-ui/src/tokens/*.css` or React component behavior.
- Moving `use-theme.ts`/`use-platform.ts` to Rust (React hooks with DOM side
  effects — impossible and pointless).
- `utils/cn.ts` — leave as-is.
- Any change to `web/src/lib/skins.ts` DOM helpers (`applySkin`, etc.).

## Affirmation

No Rust rewrite was made. `src/`, `Cargo.toml`, and `src/lib.rs` are unchanged.
The conclusion is documented here; no code changes were required.
