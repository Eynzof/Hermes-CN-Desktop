import { describe, expect, it } from "vitest";
import { composerSubmitShortcutHint, shouldSubmitComposerKey } from "./composer-submit-shortcut";

describe("shouldSubmitComposerKey", () => {
  it("uses Enter to submit and Shift+Enter to insert a newline by default", () => {
    expect(shouldSubmitComposerKey({ key: "Enter" })).toBe(true);
    expect(shouldSubmitComposerKey({ key: "Enter", shiftKey: true })).toBe(false);
  });

  it("can still represent Shift+Enter submit for future settings", () => {
    expect(shouldSubmitComposerKey({ key: "Enter" }, "shift-enter")).toBe(false);
    expect(shouldSubmitComposerKey({ key: "Enter", shiftKey: true }, "shift-enter")).toBe(true);
  });

  it("does not submit during IME composition or Alt+Enter", () => {
    expect(shouldSubmitComposerKey({ key: "Enter", isComposing: true })).toBe(false);
    expect(shouldSubmitComposerKey({ key: "Enter", altKey: true })).toBe(false);
    expect(shouldSubmitComposerKey({ key: "a" })).toBe(false);
  });
});

describe("composerSubmitShortcutHint", () => {
  it("keeps UI hints aligned with the selected shortcut", () => {
    expect(composerSubmitShortcutHint()).toBe("Enter 发送；Shift+Enter 换行");
    expect(composerSubmitShortcutHint("shift-enter")).toBe("Shift+Enter 发送；Enter 换行");
  });
});
