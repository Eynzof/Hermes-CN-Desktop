import { describe, expect, it } from "vitest";
import {
  applyEditorAction,
  createUndoStack,
  killLineEnd,
  killLineStart,
  killWordBackward,
  killWordForward,
  matchEditorKeyBinding,
  pushUndo,
  redoEdit,
  undoEdit,
  wordBackward,
  wordForward,
} from "./editor-keys";

describe("editor keybindings", () => {
  it("matches readline shortcuts", () => {
    expect(matchEditorKeyBinding({ key: "u", ctrlKey: true, altKey: false, metaKey: false, shiftKey: false }))
      .toEqual({ type: "kill-line-start" });
    expect(matchEditorKeyBinding({ key: "k", ctrlKey: true, altKey: false, metaKey: false, shiftKey: false }))
      .toEqual({ type: "kill-line-end" });
    expect(matchEditorKeyBinding({ key: "Backspace", ctrlKey: false, altKey: true, metaKey: false, shiftKey: false }))
      .toEqual({ type: "kill-word-backward" });
    expect(matchEditorKeyBinding({ key: "d", ctrlKey: false, altKey: true, metaKey: false, shiftKey: false }))
      .toEqual({ type: "kill-word-forward" });
  });

  it("ignores mismatched modifiers", () => {
    expect(matchEditorKeyBinding({ key: "u", ctrlKey: false, altKey: true, metaKey: false, shiftKey: false }))
      .toBeNull();
  });
});

describe("kill-line operations", () => {
  it("removes text from caret to start", () => {
    const result = killLineStart("hello world", 6, 6);
    expect(result.text).toBe("world");
    expect(result.selectionStart).toBe(0);
    expect(result.killed).toBe("hello ");
  });

  it("removes text from caret to end", () => {
    const result = killLineEnd("hello world", 6, 6);
    expect(result.text).toBe("hello ");
    expect(result.selectionStart).toBe(6);
    expect(result.killed).toBe("world");
  });
});

describe("word operations", () => {
  it("moves one word backward", () => {
    expect(wordBackward("hello world", 11)).toBe(6);
    expect(wordBackward("hello world", 5)).toBe(0);
    expect(wordBackward("hello world", 3)).toBe(0);
  });

  it("moves one word forward", () => {
    expect(wordForward("hello world", 0)).toBe(5);
    expect(wordForward("hello world", 6)).toBe(11);
  });

  it("kills the word before the caret", () => {
    const result = killWordBackward("hello world", 11, 11);
    expect(result.text).toBe("hello ");
    expect(result.killed).toBe("world");
  });

  it("kills the word after the caret", () => {
    const result = killWordForward("hello world", 0, 0);
    expect(result.text).toBe(" world");
    expect(result.killed).toBe("hello");
  });
});

describe("undo stack", () => {
  it("undoes and redoes edits", () => {
    let state = createUndoStack();
    state = pushUndo(state, { text: "original", selectionStart: 0, selectionEnd: 0 });
    state = pushUndo(state, { text: "edited", selectionStart: 0, selectionEnd: 0 });

    const undo = undoEdit(state);
    expect(undo.result?.text).toBe("original");
    state = undo.state;

    const redo = redoEdit(state);
    expect(redo.result?.text).toBe("edited");
  });

  it("supports undo/redo via applyEditorAction", () => {
    let state = createUndoStack();
    state = pushUndo(state, { text: "hello world", selectionStart: 0, selectionEnd: 0 });
    state = pushUndo(state, { text: "hello", selectionStart: 0, selectionEnd: 5 });
    const { result, undoState } = applyEditorAction("hello", 0, 5, "undo", state);
    expect(result.text).toBe("hello world");
    expect(undoState).toBeDefined();
  });
});
