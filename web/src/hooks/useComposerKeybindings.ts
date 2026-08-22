import { useCallback, useRef } from "react";
import { matchEditorKeyBinding, applyEditorAction, createUndoStack, pushUndo, type UndoState } from "@/lib/editor-keys";
import { useInputHistory, type UseInputHistoryResult } from "./useInputHistory";

export interface ComposerKeybindingHandlers {
  /** Replace composer text + selection. */
  setText: (text: string, selectionStart: number, selectionEnd: number) => void;
  /** Current composer text. */
  getText: () => string;
  /** Current selection. */
  getSelection: () => { start: number; end: number };
  /** Optional callback when a prompt is recalled from history. */
  onRecalled?: (text: string) => void;
  /** Optional callback when text is changed by an edit action. */
  onEdited?: (text: string, start: number, end: number) => void;
}

export interface UseComposerKeybindingsOptions {
  enabled?: boolean;
  handlers: ComposerKeybindingHandlers;
}

export interface UseComposerKeybindingsResult {
  /** Attach to the textarea `onKeyDown` event. */
  onKeyDown: (event: {
    key: string;
    ctrlKey: boolean;
    altKey: boolean;
    metaKey: boolean;
    shiftKey: boolean;
    preventDefault: () => void;
    nativeEvent?: { isComposing?: boolean };
  }) => void;
  inputHistory: UseInputHistoryResult;
}

const DESTRUCTIVE_ACTIONS = new Set([
  "kill-line-start",
  "kill-line-end",
  "kill-word-backward",
  "kill-word-forward",
]);

/**
 * Composer keybinding shim that adds TUI parity features:
 * - Up/Down recall from input history when no modifier is held.
 * - Ctrl+U / Ctrl+K / Alt+Backspace / Alt+D readline-style editing.
 * - Ctrl+Z / Ctrl+Shift+Z undo/redo for the kill operations.
 *
 * Consumers should call this *after* slash/mention picker key handling so that
 * pickers swallow Up/Down first; when no picker is open, history recall wins.
 */
export function useComposerKeybindings(options: UseComposerKeybindingsOptions): UseComposerKeybindingsResult {
  const { enabled = true, handlers } = options;
  const inputHistory = useInputHistory();
  const undoRef = useRef<UndoState>(createUndoStack());

  const ensureInitialSnapshot = useCallback(() => {
    if (undoRef.current.stack.length === 0) {
      const text = handlers.getText();
      const { start, end } = handlers.getSelection();
      undoRef.current = pushUndo(undoRef.current, { text, selectionStart: start, selectionEnd: end });
    }
  }, [handlers]);

  const applyEdit = useCallback(
    (actionType: Exclude<ReturnType<typeof matchEditorKeyBinding>, null>["type"] | "undo" | "redo") => {
      const text = handlers.getText();
      const { start, end } = handlers.getSelection();

      if (DESTRUCTIVE_ACTIONS.has(actionType as string)) {
        ensureInitialSnapshot();
      }

      const { result, undoState } = applyEditorAction(text, start, end, actionType, undoRef.current);
      if (undoState) undoRef.current = undoState;

      if (DESTRUCTIVE_ACTIONS.has(actionType as string)) {
        undoRef.current = pushUndo(undoRef.current, result);
      }

      handlers.setText(result.text, result.selectionStart, result.selectionEnd);
      handlers.onEdited?.(result.text, result.selectionStart, result.selectionEnd);
    },
    [handlers, ensureInitialSnapshot],
  );

  const onKeyDown = useCallback(
    (event: {
      key: string;
      ctrlKey: boolean;
      altKey: boolean;
      metaKey: boolean;
      shiftKey: boolean;
      preventDefault: () => void;
      nativeEvent?: { isComposing?: boolean };
    }) => {
      if (!enabled || event.nativeEvent?.isComposing) return;

      const binding = matchEditorKeyBinding(event);
      if (binding) {
        event.preventDefault();
        applyEdit(binding.type);
        return;
      }

      if (event.key === "z" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        applyEdit(event.shiftKey ? "redo" : "undo");
        return;
      }

      if (event.key === "ArrowUp" && !event.ctrlKey && !event.altKey && !event.metaKey) {
        event.preventDefault();
        const recalled = inputHistory.recall("older", handlers.getText());
        if (recalled !== null) {
          handlers.setText(recalled, recalled.length, recalled.length);
          handlers.onRecalled?.(recalled);
        }
        return;
      }

      if (event.key === "ArrowDown" && !event.ctrlKey && !event.altKey && !event.metaKey) {
        event.preventDefault();
        const recalled = inputHistory.recall("newer", handlers.getText());
        if (recalled !== null) {
          handlers.setText(recalled, recalled.length, recalled.length);
          handlers.onRecalled?.(recalled);
        }
        return;
      }
    },
    [enabled, handlers, inputHistory, applyEdit],
  );

  return { onKeyDown, inputHistory };
}
