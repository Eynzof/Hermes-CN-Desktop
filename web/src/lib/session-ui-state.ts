import { readUiValue, subscribeUiStore, writeUiValue } from "@/lib/ui-store";

const SESSION_TITLE_OVERRIDES_STORAGE_KEY = "hermes-cn-ui.sessionTitleOverrides";
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

export function subscribeSessionUiStateChanges(listener: () => void): () => void {
  const onEvent = () => listener();
  window.addEventListener(SESSION_UI_STATE_CHANGED_EVENT, onEvent);
  const unsubscribe = subscribeUiStore(listener);
  return () => {
    window.removeEventListener(SESSION_UI_STATE_CHANGED_EVENT, onEvent);
    unsubscribe();
  };
}
