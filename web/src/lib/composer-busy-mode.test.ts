import { describe, expect, it } from "vitest";
import { busyModeDescription, busyModeLabel, COMPOSER_BUSY_MODES, normalizeBusyMode } from "./composer-busy-mode";

describe("composer busy mode", () => {
  it("normalizes valid modes", () => {
    expect(normalizeBusyMode("interrupt")).toBe("interrupt");
    expect(normalizeBusyMode("queue")).toBe("queue");
    expect(normalizeBusyMode("steer")).toBe("steer");
  });

  it("falls back to interrupt for unknown values", () => {
    expect(normalizeBusyMode("unknown")).toBe("interrupt");
    expect(normalizeBusyMode(null)).toBe("interrupt");
    expect(normalizeBusyMode(undefined)).toBe("interrupt");
  });

  it("exposes all three modes", () => {
    expect(COMPOSER_BUSY_MODES).toEqual(["interrupt", "queue", "steer"]);
  });

  it("provides labels and descriptions", () => {
    expect(busyModeLabel("interrupt")).toBe("中断");
    expect(busyModeDescription("queue")).toContain("排队");
  });
});
