import { describe, expect, it } from "vitest";
import { composerSubmitShortcutHint, shouldSubmitComposerKey } from "./composer-submit-shortcut";

describe("shouldSubmitComposerKey", () => {
  it("uses Ctrl+Enter to submit and Enter to insert a newline by default", () => {
    expect(shouldSubmitComposerKey({ key: "Enter" })).toBe(false);
    expect(shouldSubmitComposerKey({ key: "Enter", shiftKey: true })).toBe(false);
    expect(shouldSubmitComposerKey({ key: "Enter", ctrlKey: true })).toBe(true);
    expect(shouldSubmitComposerKey({ key: "Enter", ctrlKey: true, shiftKey: true })).toBe(false);
  });

  it("uses Enter to submit when the shortcut preference selects it", () => {
    expect(shouldSubmitComposerKey({ key: "Enter" }, "enter")).toBe(true);
    expect(shouldSubmitComposerKey({ key: "Enter", shiftKey: true }, "enter")).toBe(false);
    expect(shouldSubmitComposerKey({ key: "Enter", ctrlKey: true }, "enter")).toBe(false);
  });

  it("does not submit during IME composition or Alt+Enter", () => {
    expect(shouldSubmitComposerKey({ key: "Enter", isComposing: true })).toBe(false);
    expect(shouldSubmitComposerKey({ key: "Enter", altKey: true })).toBe(false);
    expect(shouldSubmitComposerKey({ key: "Enter", ctrlKey: true, altKey: true })).toBe(false);
    expect(shouldSubmitComposerKey({ key: "a" })).toBe(false);
  });
});

describe("composerSubmitShortcutHint", () => {
  it("keeps UI hints aligned with the selected shortcut", () => {
    expect(composerSubmitShortcutHint()).toBe("Ctrl+Enter 发送；Enter 换行");
    expect(composerSubmitShortcutHint("enter")).toBe("Enter 发送；Shift+Enter 换行");
  });
});
