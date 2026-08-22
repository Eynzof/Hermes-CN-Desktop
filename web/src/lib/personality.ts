import {
  type PersonalityConfig,
  type PersonalityDefinition,
  activePersonalityName,
  availablePersonalities,
  normalizePersonalityName,
  resolvePersonality,
} from "@hermes/agent-core";

export {
  type PersonalityConfig,
  type PersonalityDefinition,
  type PersonalityOverlayMode,
  BUILTIN_PERSONALITIES,
  NEUTRAL_PERSONALITY_NAMES,
  activePersonalityName,
  availablePersonalities,
  builtinPersonalityCount,
  describePersonality,
  normalizePersonalityName,
  promptText,
  renderPersonalityPrompt,
  resolveEphemeralSystemPrompt,
  resolvePersonality,
} from "@hermes/agent-core";

/**
 * Session-level ephemeral personality overlay.
 *
 * This is intentionally in-memory and never persisted to disk; it mirrors the
 * Python `ephemeral_system_prompt` session state. The persisted selection lives
 * in `config.yaml` under `display.personality`.
 */
const sessionOverlays = new Map<string, string>();

/** Set (or clear) the ephemeral personality for a session. */
export function setSessionPersonality(sessionId: string | null | undefined, name: string): void {
  if (!sessionId) return;
  const normalized = normalizePersonalityName(name);
  if (!normalized) {
    sessionOverlays.delete(sessionId);
  } else {
    sessionOverlays.set(sessionId, normalized);
  }
}

/** Read the ephemeral personality for a session, or empty string if none. */
export function getSessionPersonality(sessionId: string | null | undefined): string {
  if (!sessionId) return "";
  return sessionOverlays.get(sessionId) ?? "";
}

/** Remove the ephemeral personality for a session. */
export function clearSessionPersonality(sessionId: string | null | undefined): void {
  if (!sessionId) return;
  sessionOverlays.delete(sessionId);
}

/**
 * Resolve the effective personality for a session.
 * Session-level overlay wins; otherwise fall back to `display.personality`.
 */
export function resolveSessionPersonality(
  sessionId: string | null | undefined,
  config?: PersonalityConfig,
): string {
  const sessionName = getSessionPersonality(sessionId);
  if (sessionName) return sessionName;
  return activePersonalityName(config);
}

/** Return the currently active personality name from config (empty if none). */
export function getDisplayPersonality(config?: PersonalityConfig): string {
  return activePersonalityName(config);
}

/**
 * Build a minimal config.yaml patch for `display.personality`.
 * This intentionally never touches `agent.system_prompt`.
 */
export function buildPersonalityConfigUpdate(name: string): Record<string, unknown> {
  return { display: { personality: normalizePersonalityName(name) } };
}

/**
 * Persist a personality selection by writing the canonical name to
 * `display.personality`. `saveConfig` is typically `useSaveConfig().mutateAsync`.
 */
export async function persistDisplayPersonality(
  name: string,
  saveConfig: (patch: Record<string, unknown>) => Promise<unknown>,
): Promise<void> {
  await saveConfig(buildPersonalityConfigUpdate(name));
}

/** List all available personalities as picker items. */
export function listPersonalities(
  config?: PersonalityConfig,
): Array<{ name: string; definition: PersonalityDefinition; emoji?: string }> {
  const catalog = availablePersonalities(config);
  return Object.entries(catalog).map(([name, def]) => ({
    name,
    definition: def,
    emoji: def.emoji,
  }));
}

/**
 * Render the ephemeral system-prompt overlay for a session.
 * Returns the empty string when no personality/system_prompt override is active.
 */
export function renderSessionPersonalityPrompt(
  sessionId: string | null | undefined,
  config?: PersonalityConfig,
): string {
  const name = resolveSessionPersonality(sessionId, config);
  if (!name) return "";
  try {
    return resolvePersonality(name, config).prompt;
  } catch {
    return "";
  }
}
