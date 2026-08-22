import { describe, expect, it } from "vitest";
import { isVoiceStopPhrase, voiceStopHint } from "./stop-phrase";

describe("isVoiceStopPhrase", () => {
  it("matches configured stop phrase", () => {
    expect(isVoiceStopPhrase("stop", ["stop"])).toBe(true);
  });

  it("normalizes punctuation", () => {
    expect(isVoiceStopPhrase("Stop!", ["stop"])).toBe(true);
  });

  it("returns false when no stop phrases configured", () => {
    expect(isVoiceStopPhrase("stop", [])).toBe(false);
  });

  it("returns false for non-matching phrase", () => {
    expect(isVoiceStopPhrase("continue", ["stop"])).toBe(false);
  });
});

describe("voiceStopHint", () => {
  it("returns hint when phrases exist", () => {
    expect(voiceStopHint(["stop", "结束"])).toContain("stop");
  });

  it("returns empty string when disabled", () => {
    expect(voiceStopHint([])).toBe("");
  });
});
