/**
 * Personality / SOUL.md overlay types.
 *
 * Mirrors the data model from `hermes_cli/personality.py`:
 * - `display.personality` holds the selected preset name (empty = none).
 * - `agent.personalities` lets users override or extend the built-in catalog.
 * - `agent.system_prompt` is the manual fallback when no personality is active.
 */

/** How a personality prompt is merged into the system prompt. */
export type PersonalityOverlayMode = "prepend" | "append" | "replace";

/**
 * A personality can be a plain prompt string or a structured definition.
 * When structured, `system_prompt` is the core identity; `tone` and `style`
 * are rendered as explicit instruction lines.
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

/** Subset of config.yaml used by the personality resolver. */
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
