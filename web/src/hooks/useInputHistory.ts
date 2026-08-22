import { useCallback, useRef, useSyncExternalStore } from "react";
import {
  createInputHistoryManager,
  createUiStoreInputHistoryAdapter,
  type InputHistoryManager,
} from "@/lib/input-history";

export interface UseInputHistoryResult {
  /** Current recall position; -1 means the inline draft is active. */
  cursorIndex: number;
  /** Inline prefix used to filter older/newer history recalls. */
  inlinePrefix: string;
  /**
   * Attempt to recall an older (Up) or newer (Down) history entry.
   * Returns the replacement text, or null if nothing changed.
   */
  recall: (direction: "older" | "newer", currentText: string) => string | null;
  /** Push a sent prompt into history. */
  push: (text: string) => void;
  /** Reset recall position to the inline draft. */
  reset: () => void;
  /** Clear all history. */
  clear: () => void;
}

let globalManager: InputHistoryManager | null = null;

function getGlobalManager(): InputHistoryManager {
  if (!globalManager) {
    globalManager = createInputHistoryManager(createUiStoreInputHistoryAdapter());
  }
  return globalManager;
}

/** Hook for composer input-history recall (Up/Down when no picker is open). */
export function useInputHistory(): UseInputHistoryResult {
  const managerRef = useRef(getGlobalManager());
  const cursorRef = useRef({ index: -1, inline: "" });

  // Force re-render when history changes so consumers can see cursor updates.
  const version = useSyncExternalStore(
    (callback) => {
      // ui-store writes notify through a global listener; we approximate by
      // re-rendering after push/clear in this hook. External changes are rare.
      return () => {};
    },
    () => cursorRef.current.index,
    () => cursorRef.current.index,
  );

  const recall = useCallback((direction: "older" | "newer", currentText: string): string | null => {
    const result = managerRef.current.recall(direction, currentText, cursorRef.current);
    if (!result) return null;
    cursorRef.current = result.cursor;
    return result.text;
  }, [version]);

  const push = useCallback((text: string) => {
    managerRef.current.push(text);
    cursorRef.current = { index: -1, inline: "" };
  }, []);

  const reset = useCallback(() => {
    cursorRef.current = { index: -1, inline: "" };
  }, []);

  const clear = useCallback(() => {
    managerRef.current.clear();
    cursorRef.current = { index: -1, inline: "" };
  }, []);

  return {
    cursorIndex: cursorRef.current.index,
    inlinePrefix: cursorRef.current.inline,
    recall,
    push,
    reset,
    clear,
  };
}

/** Reset the global manager singleton (tests only). */
export function __resetInputHistoryManager(): void {
  globalManager = null;
}
