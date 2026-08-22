import type { CommandResult } from "../types";
import {
  type PersonalityConfig,
  availablePersonalities,
  describePersonality,
  normalizePersonalityName,
  resolvePersonality,
} from "@/lib/personality";

export interface PersonalityHandlerContext {
  /** Active persistent session id, if any. */
  activeSessionId: string | null;
  /** Current config snapshot (used for listing / resolving personalities). */
  getConfig?: () => PersonalityConfig | undefined;
  /** Persist the selection to `display.personality` (must not touch `agent.system_prompt`). */
  savePersonality?: (name: string) => Promise<void> | void;
  /** Apply the selection to the in-memory session overlay. */
  setSessionPersonality?: (sessionId: string, name: string) => void;
}

function isListArg(raw: string): boolean {
  const first = raw.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  return first === "list" || first === "ls" || first === "";
}

function listPersonalities(config?: PersonalityConfig): CommandResult {
  const catalog = availablePersonalities(config);
  const names = Object.keys(catalog).sort();
  if (names.length === 0) {
    return { type: "exec", output: "No personalities available." };
  }
  const lines = names.map((name) => {
    const def = catalog[name];
    const emoji = typeof def === "string" ? "" : def.emoji ? `${def.emoji} ` : "";
    const desc = describePersonality(def, 50);
    return `- ${emoji}${name}${desc ? ` — ${desc}` : ""}`;
  });
  return { type: "exec", output: `Available personalities:\n${lines.join("\n")}` };
}

function applyPersonality(
  name: string,
  ctx: PersonalityHandlerContext,
): CommandResult | Promise<CommandResult> {
  const normalized = normalizePersonalityName(name);
  const sessionId = ctx.activeSessionId;

  if (!normalized) {
    // Reset / neutral: clear session overlay and persist empty selection.
    if (sessionId) ctx.setSessionPersonality?.(sessionId, "");
    const persist = ctx.savePersonality?.("") ?? Promise.resolve();
    if (persist instanceof Promise) {
      return persist.then(() => ({ type: "exec", output: "Personality reset to neutral." }));
    }
    return { type: "exec", output: "Personality reset to neutral." };
  }

  try {
    const resolved = resolvePersonality(name, ctx.getConfig?.());
    if (sessionId) ctx.setSessionPersonality?.(sessionId, resolved.name);
    const persist = ctx.savePersonality?.(resolved.name) ?? Promise.resolve();
    const output = `Personality set to ${resolved.name}.`;
    if (persist instanceof Promise) {
      return persist.then(() => ({ type: "exec", output, name: resolved.name }));
    }
    return { type: "exec", output, name: resolved.name };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { type: "error", message };
  }
}

/**
 * `/personality` slash command handler.
 *
 * Usage:
 *   /personality              list available personalities
 *   /personality <name>      apply a personality
 *   /personality none|default|neutral  reset to neutral
 */
export async function handlePersonality(
  args: string,
  ctx: PersonalityHandlerContext,
): Promise<CommandResult> {
  const raw = args.trim();

  if (isListArg(raw)) {
    return listPersonalities(ctx.getConfig?.());
  }

  return applyPersonality(raw, ctx);
}

/**
 * Parse a `/personality` command into canonical form.
 * Useful for composer autocomplete and command builders.
 */
export function formatPersonalityCommand(name?: string): string {
  return name?.trim() ? `/personality ${name.trim()}` : "/personality";
}
