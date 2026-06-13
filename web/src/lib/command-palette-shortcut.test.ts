import { describe, expect, it } from "vitest";
import { isCommandPaletteShortcut } from "./command-palette-shortcut";

describe("isCommandPaletteShortcut", () => {
  it("accepts Meta+K and Ctrl+K", () => {
    expect(isCommandPaletteShortcut({ key: "k", metaKey: true })).toBe(true);
    expect(isCommandPaletteShortcut({ key: "K", ctrlKey: true })).toBe(true);
  });

  it("rejects unrelated modifiers and keys", () => {
    expect(isCommandPaletteShortcut({ key: "k" })).toBe(false);
    expect(isCommandPaletteShortcut({ key: "p", metaKey: true })).toBe(false);
    expect(isCommandPaletteShortcut({ key: "k", metaKey: true, shiftKey: true })).toBe(false);
    expect(isCommandPaletteShortcut({ key: "k", ctrlKey: true, altKey: true })).toBe(false);
  });

  it("does not intercept IME composition", () => {
    expect(isCommandPaletteShortcut({ key: "k", metaKey: true, isComposing: true })).toBe(false);
  });
});
