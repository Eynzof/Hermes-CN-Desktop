import { type SkinPreset, type SkinSlug, isSkinSlug, listSkins } from "@/lib/skins";
import type { CommandResult } from "../types";

export interface SkinHandlerContext {
  /** Current active skin slug, if known. */
  currentSkin?: SkinSlug | null;
  /** Apply the selected skin to the DOM and/or persistent store. */
  applySkin?: (slug: SkinSlug) => Promise<void> | void;
}

function isListArg(raw: string): boolean {
  const first = raw.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  return first === "" || first === "list" || first === "ls";
}

function listSkinsResult(currentSkin?: SkinSlug | null): CommandResult {
  const skins = listSkins();
  if (skins.length === 0) {
    return { type: "exec", output: "No skins available." };
  }
  const lines = skins.map((skin) => {
    const marker = skin.slug === currentSkin ? " *" : "";
    return `- ${skin.name} (${skin.slug})${marker}${skin.description ? ` — ${skin.description}` : ""}`;
  });
  return { type: "exec", output: `Available skins:\n${lines.join("\n")}` };
}

function applySkinResult(
  raw: string,
  ctx: SkinHandlerContext,
): CommandResult | Promise<CommandResult> {
  const slug = raw.trim().toLowerCase();
  if (!isSkinSlug(slug)) {
    return { type: "error", message: `Unknown skin: ${raw.trim() || "(empty)"}` };
  }

  const persist = ctx.applySkin?.(slug) ?? Promise.resolve();
  const output = `Skin set to ${slug}.`;
  if (persist instanceof Promise) {
    return persist.then(() => ({ type: "exec", output, name: slug }));
  }
  return { type: "exec", output, name: slug };
}

/**
 * `/skin` slash command handler.
 *
 * Usage:
 *   /skin              list available skins
 *   /skin list         list available skins
 *   /skin <name>       apply a built-in skin
 *   /skin default      reset to the default skin
 */
export async function handleSkin(args: string, ctx: SkinHandlerContext): Promise<CommandResult> {
  const raw = args.trim();

  if (isListArg(raw)) {
    return listSkinsResult(ctx.currentSkin);
  }

  return applySkinResult(raw, ctx);
}

/**
 * Parse a `/skin` command into canonical form.
 */
export function formatSkinCommand(name?: string): string {
  return name?.trim() ? `/skin ${name.trim()}` : "/skin";
}
