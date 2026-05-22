import { readUiValue, subscribeUiStore, writeUiValue } from "@/lib/ui-store";

const PINNED_SOURCES_KEY = "hermes-cn-ui.pinnedSources";
const PINNED_CHANGED_EVENT = "hermes-cn-ui.pinnedSources.changed";

const DEFAULT_PINNED: ReadonlySet<string> = new Set(["web", "cli"]);

function emitChange(): void {
  try {
    window.dispatchEvent(new Event(PINNED_CHANGED_EVENT));
  } catch {}
}

export function readPinnedSources(): Set<string> {
  const parsed = readUiValue<unknown>(PINNED_SOURCES_KEY, Array.from(DEFAULT_PINNED));
  if (!Array.isArray(parsed)) return new Set(DEFAULT_PINNED);
  return new Set(parsed.filter((id): id is string => typeof id === "string" && id.length > 0));
}

export function writePinnedSources(ids: Set<string>): void {
  writeUiValue(PINNED_SOURCES_KEY, Array.from(ids));
  emitChange();
}

export function togglePinnedSource(key: string): Set<string> {
  const ids = readPinnedSources();
  if (ids.has(key)) ids.delete(key);
  else ids.add(key);
  writePinnedSources(ids);
  return ids;
}

export function subscribePinnedSourcesChange(listener: () => void): () => void {
  window.addEventListener(PINNED_CHANGED_EVENT, listener);
  const unsubscribe = subscribeUiStore(listener);
  return () => {
    window.removeEventListener(PINNED_CHANGED_EVENT, listener);
    unsubscribe();
  };
}
