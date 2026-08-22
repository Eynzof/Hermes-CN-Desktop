import type { ContextFile } from "../types.js";
import type { PersonalityConfig, PersonalityOverlayMode } from "./types.js";
import { activePersonalityName, renderPersonalityPrompt, resolvePersonality } from "./catalog.js";

export const DEFAULT_AGENT_IDENTITY = `You are Hermes Agent, a helpful AI coding and automation assistant. Always respond in Chinese.`;

/**
 * Apply a personality prompt to a system prompt using the chosen overlay mode.
 *
 * - `prepend`: personality first, then original system prompt.
 * - `append`: original system prompt first, then personality.
 * - `replace`: personality replaces the system prompt entirely.
 */
export function applyPersonalityToSystemPrompt(
  systemPrompt: string,
  personalityPrompt: string,
  mode: PersonalityOverlayMode = "append",
): string {
  const base = systemPrompt.trim();
  const overlay = personalityPrompt.trim();
  if (!overlay) return base;
  if (!base) return overlay;

  switch (mode) {
    case "prepend":
      return `${overlay}\n\n${base}`;
    case "replace":
      return overlay;
    case "append":
    default:
      return `${base}\n\n${overlay}`;
  }
}

/**
 * Build the stable identity block: SOUL.md wins over the default identity.
 */
export function buildIdentityBlock(soul: string | null, defaultIdentity = DEFAULT_AGENT_IDENTITY): string {
  const identity = soul?.trim();
  return identity && identity.length > 0 ? identity : defaultIdentity;
}

interface SplitContextFilesResult {
  /** The first SOUL.md-style file found (highest-priority identity). */
  soul: ContextFile | null;
  /** Remaining project-context files that belong in the user prompt. */
  others: ContextFile[];
}

/**
 * Split loaded context files into SOUL.md identity and everything else.
 * This mirrors Python `build_context_files_prompt(skip_soul=True)` dedup:
 * when SOUL.md is consumed as the identity, it must not be repeated.
 */
export function splitContextFilesBySoul(files: ContextFile[]): SplitContextFilesResult {
  const soul = files.find((f) => f.source === "soul") ?? null;
  const others = files.filter((f) => f.source !== "soul");
  return { soul, others };
}

/** Format a set of project-context files as a Markdown block for the user prompt. */
export function formatContextBlock(files: ContextFile[]): string {
  if (files.length === 0) return "";
  const sections = files.map((f) => `## ${f.provenance ?? basename(f.path)}\n${f.content}`);
  return `# Project Context\nThe following project context files have been loaded and should be followed:\n\n${sections.join("\n\n")}`;
}

function basename(path: string): string {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return idx < 0 ? path : path.slice(idx + 1);
}

/** Options for {@link resolveSystemPrompt}. */
export interface ResolveSystemPromptOptions {
  /** Optional base system prompt (e.g. default identity). */
  baseSystemPrompt?: string;
  /** Loaded project context files (may include SOUL.md). */
  contextFiles?: ContextFile[];
  /** Active personality name or raw prompt; applied as an ephemeral overlay. */
  personality?: string;
  /** Personality overlay mode (default: append). */
  personalityMode?: PersonalityOverlayMode;
  /** Optional config used to resolve a named personality. */
  personalityConfig?: PersonalityConfig;
}

/** Result of {@link resolveSystemPrompt}. */
export interface SystemPromptResolution {
  /** Final system prompt, or undefined when empty. */
  systemPrompt: string | undefined;
  /** Context files with SOUL.md removed (ready for the user prompt). */
  contextFiles: ContextFile[];
  /** Whether a SOUL.md identity was consumed. */
  soulUsed: boolean;
  /** Whether a personality overlay was applied. */
  personalityUsed: boolean;
}

/**
 * Resolve the final system prompt and the remaining user-context files.
 *
 * Tier order (highest priority last):
 * 1. Default identity or `baseSystemPrompt`.
 * 2. SOUL.md from `contextFiles` replaces the default identity.
 * 3. Non-SOUL project context files are appended as guidance.
 * 4. Personality overlay is applied with the chosen mode.
 *
 * This matches the Python stable-tier ordering:
 * `load_soul_md()` or `DEFAULT_AGENT_IDENTITY`, then caller system message +
 * context files, then the ephemeral personality overlay.
 */
export function resolveSystemPrompt(options: ResolveSystemPromptOptions): SystemPromptResolution {
  const { soul, others } = splitContextFilesBySoul(options.contextFiles ?? []);
  const identity = buildIdentityBlock(soul?.content ?? null, options.baseSystemPrompt);
  const contextBlock = formatContextBlock(others);

  let systemParts: string[] = [];
  if (identity && identity.trim().length > 0) systemParts.push(identity.trim());
  if (contextBlock && contextBlock.trim().length > 0) systemParts.push(contextBlock.trim());

  let systemPrompt = systemParts.length > 0 ? systemParts.join("\n\n") : undefined;
  let personalityUsed = false;

  const rawPersonality = options.personality?.trim();
  if (rawPersonality) {
    let resolved = "";
    try {
      resolved = resolvePersonality(rawPersonality, options.personalityConfig).prompt;
    } catch {
      // Not a known name: treat the raw string as an ad-hoc prompt overlay.
      resolved = renderPersonalityPrompt(rawPersonality);
    }
    if (resolved) {
      systemPrompt = applyPersonalityToSystemPrompt(
        systemPrompt ?? "",
        resolved,
        options.personalityMode ?? "append",
      );
      personalityUsed = true;
    }
  }

  return {
    systemPrompt,
    contextFiles: others,
    soulUsed: soul !== null,
    personalityUsed,
  };
}

/**
 * Convenience: resolve the ephemeral overlay text from config without merging.
 * Personality wins; otherwise falls back to `agent.system_prompt`.
 */
export function resolvePersonalityOverlay(config?: PersonalityConfig): string {
  const name = activePersonalityName(config);
  if (name) {
    return resolvePersonality(name, config).prompt;
  }
  return config?.agent?.system_prompt?.trim() ?? "";
}
