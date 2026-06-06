import { describe, expect, it } from "vitest";
import { composerSubmitShortcutHint, shouldSubmitComposerKey } from "./composer-submit-shortcut";

describe("shouldSubmitComposerKey", () => {
  it("uses Enter to submit and Shift+Enter to insert a newline by default", () => {
    expect(shouldSubmitComposerKey({ key: "Enter" })).toBe(true);
    expect(shouldSubmitComposerKey({ key: "Enter", shiftKey: true })).toBe(false);
    expect(shouldSubmitComposerKey({ key: "Enter", ctrlKey: true })).toBe(false);
  });

  it("uses Ctrl+Enter to submit when the shortcut preference selects it", () => {
    expect(shouldSubmitComposerKey({ key: "Enter" }, "ctrl-enter")).toBe(false);
    expect(shouldSubmitComposerKey({ key: "Enter", shiftKey: true }, "ctrl-enter")).toBe(false);
    expect(shouldSubmitComposerKey({ key: "Enter", ctrlKey: true }, "ctrl-enter")).toBe(true);
    expect(shouldSubmitComposerKey({ key: "Enter", ctrlKey: true, shiftKey: true }, "ctrl-enter")).toBe(false);
  });

  it("does not submit during IME composition or Alt+Enter", () => {
    expect(shouldSubmitComposerKey({ key: "Enter", isComposing: true })).toBe(false);
    expect(shouldSubmitComposerKey({ key: "Enter", altKey: true })).toBe(false);
    expect(shouldSubmitComposerKey({ key: "Enter", ctrlKey: true, altKey: true }, "ctrl-enter")).toBe(false);
    expect(shouldSubmitComposerKey({ key: "a" })).toBe(false);
  });
});

describe("composerSubmitShortcutHint", () => {
  it("keeps UI hints aligned with the selected shortcut", () => {
    expect(composerSubmitShortcutHint()).toBe("Enter 发送；Shift+Enter 换行");
    expect(composerSubmitShortcutHint("ctrl-enter")).toBe("Ctrl+Enter 发送；Enter 换行");
  });
});
