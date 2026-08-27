/**
 * Minimal personality helpers for the GUI-event test coverage.
 *
 * Personality catalog/resolver logic lives in `@hermes/agent-core` on the
 * dev-lite line; this branch does not carry that package, so the
 * PersonalityPicker component keeps a self-contained copy of the small
 * surface it renders (see feature_report.md §3 — personality-picker tests).
 */
export interface PersonalityDefinition {
  /** Core system-prompt identity. */
  system_prompt?: string;
  /** Optional tone line rendered as `Tone: …`. */
  tone?: string;
  /** Optional style line rendered as `Style: …`. */
  style?: string;
  /** Short description shown in pickers / help lists. */
  description?: string;
  /** Emoji shown in the UI picker. */
  emoji?: string;
}

export interface PersonalityConfig {
  display?: {
    /** Selected personality name (empty / none / default / neutral = disabled). */
    personality?: string;
  };
  agent?: {
    /** User-defined/overridden personalities keyed by canonical lowercase name. */
    personalities?: Record<string, PersonalityDefinition | string>;
    /** Manual system-prompt fallback when no personality is active. */
    system_prompt?: string;
  };
}

/** Return a short preview of a personality, capped at `width` characters. */
export function describePersonality(value: PersonalityDefinition | string, width = 50): string {
  const text =
    typeof value === "string" ? value : value.description?.trim() ?? value.system_prompt?.trim() ?? "";
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (singleLine.length <= width) return singleLine;
  return `${singleLine.slice(0, width - 1)}…`;
}