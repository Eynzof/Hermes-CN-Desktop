/**
 * Desktop skin runtime helpers.
 *
 * Built-in presets live in `@hermes/shared-ui` so they can be used by any
 * workspace package; this module adds DOM-specific apply/inject helpers for the
 * web app.
 */

import {
  type SkinPreset,
  type SkinSlug,
  type SkinToken,
  getSkinBySlug,
  isSkinSlug,
  listSkins as listSharedSkins,
  skinTokenToCssVar,
} from "@hermes/shared-ui";

export type { SkinBranding, SkinDefinition, SkinPolarity, SkinPreset, SkinSlug, SkinSpinner, SkinToken } from "@hermes/shared-ui";
export {
  BUILTIN_SKINS,
  BUILTIN_SKIN_SLUGS,
  DEFAULT_SKIN_PRESET,
  SkinValidationError,
  buildSkinPreset,
  getSkinBySlug,
  isSkinSlug,
  listSkinSlugs,
  loadSkinFromSource,
  parseSkinSource,
  skinTokenToCssVar,
  validateSkinDefinition,
} from "@hermes/shared-ui";

/**
 * Resolve a built-in skin by slug.  Falls back to the default skin for unknown
 * or empty input.
 */
export function loadSkin(slug: SkinSlug | string): SkinPreset {
  return isSkinSlug(slug) ? getSkinBySlug(slug) : getSkinBySlug("default");
}

/**
 * Apply a skin slug to the document element.  The actual colour overrides come
 * from the static `[data-skin="…"]` blocks in `skins.css`.
 */
export function applySkin(slug: SkinSlug | string): void {
  const resolved = loadSkin(slug).slug;
  if (typeof document !== "undefined") {
    document.documentElement.setAttribute("data-skin", resolved);
  }
}

/**
 * Return all built-in skin presets.
 */
export function listSkins(): SkinPreset[] {
  return listSharedSkins() as SkinPreset[];
}

/**
 * Generate a CSS string that injects a skin's token overrides as CSS custom
 * properties under a `[data-skin="<slug>"]` selector.  Useful for previewing
 * or applying custom user skins at runtime.
 */
export function injectSkinStyles(skin: SkinPreset): string {
  const lines: string[] = [];
  for (const [token, value] of Object.entries(skin.tokenOverrides)) {
    const cssVar = skinTokenToCssVar(token as SkinToken);
    lines.push(`  ${cssVar}: ${value};`);
  }
  return `[data-skin="${skin.slug}"] {\n${lines.join("\n")}\n}`;
}

/**
 * Inject a `<style>` tag into the document head containing the CSS for a skin.
 * The tag is keyed by slug and replaced on subsequent calls.
 */
export function injectSkinStyleTag(skin: SkinPreset): void {
  if (typeof document === "undefined") return;
  const id = `hermes-skin-${skin.slug}`;
  let tag = document.getElementById(id) as HTMLStyleElement | null;
  if (!tag) {
    tag = document.createElement("style");
    tag.id = id;
    tag.setAttribute("type", "text/css");
    document.head.appendChild(tag);
  }
  tag.textContent = injectSkinStyles(skin);
}
