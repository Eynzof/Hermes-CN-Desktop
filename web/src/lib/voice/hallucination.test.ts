import { describe, expect, it } from "vitest";
import { isWhisperHallucination } from "./hallucination";

describe("isWhisperHallucination", () => {
  it("flags empty transcript", () => {
    expect(isWhisperHallucination("")).toBe(true);
  });

  it("flags known hallucinated phrases", () => {
    expect(isWhisperHallucination("Thank you")).toBe(true);
    expect(isWhisperHallucination("  um  ")).toBe(true);
  });

  it("flags repeated words", () => {
    expect(isWhisperHallucination("谢谢 谢谢 谢谢 谢谢")).toBe(true);
  });

  it("accepts normal transcript", () => {
    expect(isWhisperHallucination("Please open the browser.")).toBe(false);
  });
});
