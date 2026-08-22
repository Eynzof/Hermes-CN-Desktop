/**
 * Readline-style text-area editing helpers.
 *
 * The original TUI (`ui-tui/src/lib/editor.ts`) supports kill-line,
 * kill-to-start, word navigation, and undo. This module provides the pure
 * text-manipulation primitives that can be wired into the React composer
 * `onKeyDown` handler. Grapheme-aware operations are best-effort using JS
 * string indexing (the input is single-line for most operations).
 */

export interface TextEditResult {
  text: string;
  selectionStart: number;
  selectionEnd: number;
  killed?: string;
}

function clamp(value: number, max: number): number {
  return Math.max(0, Math.min(value, max));
}

/** Delete from caret to the start of the line, returning the removed text. */
export function killLineStart(text: string, selectionStart: number, selectionEnd: number): TextEditResult {
  const start = Math.min(selectionStart, selectionEnd);
  const end = Math.max(selectionStart, selectionEnd);
  const before = text.slice(0, start);
  const after = text.slice(end);
  return {
    text: after,
    selectionStart: 0,
    selectionEnd: 0,
    killed: before,
  };
}

/** Delete from caret to the end of the line, returning the removed text. */
export function killLineEnd(text: string, selectionStart: number, selectionEnd: number): TextEditResult {
  const start = Math.min(selectionStart, selectionEnd);
  const end = Math.max(selectionStart, selectionEnd);
  const before = text.slice(0, start);
  const after = text.slice(end);
  return {
    text: before,
    selectionStart: before.length,
    selectionEnd: before.length,
    killed: after,
  };
}

const WORD_BOUNDARY = /[^\p{L}\p{N}_]/u;

function isWordBoundary(char: string): boolean {
  return WORD_BOUNDARY.test(char);
}

/** Move the caret one word backward. Returns the new cursor position. */
export function wordBackward(text: string, position: number): number {
  let index = clamp(position, text.length);
  // Skip whitespace/non-word chars.
  while (index > 0 && isWordBoundary(text[index - 1]!)) index -= 1;
  // Skip word chars.
  while (index > 0 && !isWordBoundary(text[index - 1]!)) index -= 1;
  return index;
}

/** Move the caret one word forward. */
export function wordForward(text: string, position: number): number {
  let index = clamp(position, text.length);
  const len = text.length;
  while (index < len && isWordBoundary(text[index]!)) index += 1;
  while (index < len && !isWordBoundary(text[index]!)) index += 1;
  return index;
}

/** Delete the word before the caret. */
export function killWordBackward(text: string, selectionStart: number, selectionEnd: number): TextEditResult {
  const caret = Math.min(selectionStart, selectionEnd);
  const target = wordBackward(text, caret);
  const before = text.slice(0, target);
  const after = text.slice(Math.max(selectionStart, selectionEnd));
  return {
    text: `${before}${after}`,
    selectionStart: target,
    selectionEnd: target,
    killed: text.slice(target, caret),
  };
}

/** Delete the word after the caret. */
export function killWordForward(text: string, selectionStart: number, selectionEnd: number): TextEditResult {
  const caret = Math.max(selectionStart, selectionEnd);
  const target = wordForward(text, caret);
  const before = text.slice(0, Math.min(selectionStart, selectionEnd));
  return {
    text: `${before}${text.slice(target)}`,
    selectionStart: caret,
    selectionEnd: caret,
    killed: text.slice(caret, target),
  };
}

export interface UndoState {
  /** Chronological stack of editor snapshots. */
  stack: TextEditResult[];
  /** Index of the current snapshot in `stack`. */
  index: number;
}

export function createUndoStack(): UndoState {
  return { stack: [], index: -1 };
}

/** Append a snapshot to the undo history, dropping any redo branch. */
export function pushUndo(state: UndoState, snapshot: TextEditResult, maxDepth = 50): UndoState {
  const nextStack = state.stack.slice(0, state.index + 1);
  nextStack.push(snapshot);
  if (nextStack.length > maxDepth) nextStack.shift();
  return { stack: nextStack, index: nextStack.length - 1 };
}

/** Move back one snapshot if possible. */
export function undoEdit(state: UndoState): { state: UndoState; result: TextEditResult | null } {
  if (state.index <= 0) return { state, result: null };
  const nextIndex = state.index - 1;
  return { state: { ...state, index: nextIndex }, result: state.stack[nextIndex]! };
}

/** Move forward one snapshot if possible. */
export function redoEdit(state: UndoState): { state: UndoState; result: TextEditResult | null } {
  if (state.index < 0 || state.index >= state.stack.length - 1) return { state, result: null };
  const nextIndex = state.index + 1;
  return { state: { ...state, index: nextIndex }, result: state.stack[nextIndex]! };
}

export interface EditorKeyAction {
  type: "kill-line-start" | "kill-line-end" | "kill-word-backward" | "kill-word-forward" | "undo" | "redo";
}

const MODIFIERS = ["ctrl", "alt", "meta", "shift"] as const;

type Modifier = (typeof MODIFIERS)[number];

export interface KeyBinding {
  key: string;
  modifiers: Modifier[];
  action: EditorKeyAction["type"];
}

export const DEFAULT_EDITOR_KEY_BINDINGS: KeyBinding[] = [
  { key: "u", modifiers: ["ctrl"], action: "kill-line-start" },
  { key: "k", modifiers: ["ctrl"], action: "kill-line-end" },
  { key: "w", modifiers: ["ctrl"], action: "kill-word-backward" },
  { key: "Backspace", modifiers: ["alt"], action: "kill-word-backward" },
  { key: "d", modifiers: ["alt"], action: "kill-word-forward" },
  { key: "ArrowLeft", modifiers: ["alt"], action: "kill-word-backward" }, // movement handled by caller
  { key: "ArrowRight", modifiers: ["alt"], action: "kill-word-forward" },
];

export function matchEditorKeyBinding(
  event: { key: string; ctrlKey: boolean; altKey: boolean; metaKey: boolean; shiftKey: boolean },
  bindings: KeyBinding[] = DEFAULT_EDITOR_KEY_BINDINGS,
): EditorKeyAction | null {
  for (const binding of bindings) {
    if (binding.key !== event.key) continue;
    const required = new Set(binding.modifiers);
    if (
      event.ctrlKey !== required.has("ctrl") ||
      event.altKey !== required.has("alt") ||
      event.metaKey !== required.has("meta") ||
      event.shiftKey !== required.has("shift")
    ) {
      continue;
    }
    return { type: binding.action };
  }
  return null;
}

/**
 * Apply an editor action to the current textarea state.
 * For undo/redo, pass the current undo state and receive the restored result.
 */
export function applyEditorAction(
  text: string,
  selectionStart: number,
  selectionEnd: number,
  action: EditorKeyAction["type"],
  undoState?: UndoState,
): { result: TextEditResult; undoState?: UndoState } {
  switch (action) {
    case "kill-line-start":
      return { result: killLineStart(text, selectionStart, selectionEnd) };
    case "kill-line-end":
      return { result: killLineEnd(text, selectionStart, selectionEnd) };
    case "kill-word-backward":
      return { result: killWordBackward(text, selectionStart, selectionEnd) };
    case "kill-word-forward":
      return { result: killWordForward(text, selectionStart, selectionEnd) };
    case "undo":
      if (!undoState) return { result: { text, selectionStart, selectionEnd } };
      {
        const { state, result } = undoEdit(undoState);
        return { result: result ?? { text, selectionStart, selectionEnd }, undoState: state };
      }
    case "redo":
      if (!undoState) return { result: { text, selectionStart, selectionEnd } };
      {
        const { state, result } = redoEdit(undoState);
        return { result: result ?? { text, selectionStart, selectionEnd }, undoState: state };
      }
    default:
      return { result: { text, selectionStart, selectionEnd } };
  }
}
