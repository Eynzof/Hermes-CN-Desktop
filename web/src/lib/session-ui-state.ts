import { readUiValue, subscribeUiStore, writeUiValue } from "@/lib/ui-store";

const SESSION_TITLE_OVERRIDES_STORAGE_KEY = "hermes-cn-ui.sessionTitleOverrides";
const PINNED_SESSION_IDS_STORAGE_KEY = "hermes-cn-ui.pinnedSessionIds";
const SESSION_UI_STATE_CHANGED_EVENT = "hermes-cn-ui.sessionUiState.changed";

function emitSessionUiStateChange(): void {
  try {
    window.dispatchEvent(new Event(SESSION_UI_STATE_CHANGED_EVENT));
  } catch {}
}

function readJSON<T>(key: string, fallback: T): T {
  return readUiValue<T>(key, fallback);
}

function writeJSON(key: string, value: unknown): void {
  writeUiValue(key, value);
  emitSessionUiStateChange();
}

export function readSessionTitleOverrides(): Record<string, string> {
  const raw = readJSON<unknown>(SESSION_TITLE_OVERRIDES_STORAGE_KEY, {});
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>).flatMap(([sessionId, title]) => {
      const cleanSessionId = sessionId.trim();
      const cleanTitle = typeof title === "string" ? title.trim() : "";
      return cleanSessionId && cleanTitle ? [[cleanSessionId, cleanTitle]] : [];
    }),
  );
}

export function rememberSessionTitleOverride(sessionId: string, title: string): void {
  const cleanSessionId = sessionId.trim();
  const cleanTitle = title.trim();
  if (!cleanSessionId || !cleanTitle) return;
  const overrides = readSessionTitleOverrides();
  overrides[cleanSessionId] = cleanTitle;
  writeJSON(SESSION_TITLE_OVERRIDES_STORAGE_KEY, overrides);
}

function normalizeSessionIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((item) => {
    if (typeof item !== "string") return [];
    const id = item.trim();
    if (!id || seen.has(id)) return [];
    seen.add(id);
    return [id];
  });
}

export function readPinnedSessionIds(): Set<string> {
  return new Set(normalizeSessionIds(readJSON<unknown>(PINNED_SESSION_IDS_STORAGE_KEY, [])));
}

export function writePinnedSessionIds(ids: Iterable<string>): Set<string> {
  const cleanIds = normalizeSessionIds(Array.from(ids));
  writeJSON(PINNED_SESSION_IDS_STORAGE_KEY, cleanIds);
  return new Set(cleanIds);
}

export function isSessionPinned(sessionId: string): boolean {
  const cleanSessionId = sessionId.trim();
  return cleanSessionId ? readPinnedSessionIds().has(cleanSessionId) : false;
}

export function togglePinnedSession(sessionId: string): Set<string> {
  const cleanSessionId = sessionId.trim();
  const ids = readPinnedSessionIds();
  if (!cleanSessionId) return ids;
  if (ids.has(cleanSessionId)) ids.delete(cleanSessionId);
  else ids.add(cleanSessionId);
  return writePinnedSessionIds(ids);
}

export function unpinSessions(sessionIds: Iterable<string>): Set<string> {
  const ids = readPinnedSessionIds();
  let changed = false;
  for (const sessionId of sessionIds) {
    const cleanSessionId = sessionId.trim();
    if (cleanSessionId && ids.delete(cleanSessionId)) changed = true;
  }
  return changed ? writePinnedSessionIds(ids) : ids;
}

export function subscribeSessionUiStateChanges(listener: () => void): () => void {
  const onEvent = () => listener();
  window.addEventListener(SESSION_UI_STATE_CHANGED_EVENT, onEvent);
  const unsubscribe = subscribeUiStore(listener);
  return () => {
    window.removeEventListener(SESSION_UI_STATE_CHANGED_EVENT, onEvent);
    unsubscribe();
  };
}
