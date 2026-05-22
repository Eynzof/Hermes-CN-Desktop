import type { ComposerModelSelection } from "@/components/chat/composer-types";

// Carries the picker selection across the panel composer → detail navigation.
// This is intentionally renderer-memory only: overrides should die with the
// current window so stale entries don't accumulate in persistent UI state.

const overrides = new Map<string, ComposerModelSelection>();

function isValid(value: unknown): value is ComposerModelSelection {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (typeof v.model !== "string" || !v.model) return false;
  if (v.provider !== undefined && typeof v.provider !== "string") return false;
  if (v.providerName !== undefined && typeof v.providerName !== "string") return false;
  if (v.contextWindow !== undefined && typeof v.contextWindow !== "number") return false;
  return true;
}

export function rememberSessionModelOverride(
  sessionId: string,
  selection: ComposerModelSelection,
): void {
  if (!sessionId || !isValid(selection)) return;
  overrides.set(sessionId, { ...selection });
}

export function readSessionModelOverride(sessionId: string): ComposerModelSelection | null {
  if (!sessionId) return null;
  const value = overrides.get(sessionId);
  return value ? { ...value } : null;
}

export function forgetSessionModelOverride(sessionId: string): void {
  if (!sessionId) return;
  overrides.delete(sessionId);
}

export function __resetSessionModelOverridesForTests(): void {
  overrides.clear();
}
