import { describe, expect, it } from "vitest";
import {
  DEFAULT_REASONING_EFFORT,
  REASONING_EFFORTS,
  REASONING_EFFORT_LABELS,
  REASONING_EFFORT_SHORT_LABELS,
  clampReasoning,
  clearSessionReasoning,
  getSessionReasoning,
  isReasoningEffort,
  normalizeReasoningEffort,
  reasoningEffortFromConfig,
  setSessionReasoning,
} from "./reasoning-effort";

describe("reasoning-effort", () => {
  it("exposes the backend's effort set (none + VALID_REASONING_EFFORTS)", () => {
    expect(REASONING_EFFORTS).toEqual([
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ]);
  });

  it("has a label for every effort", () => {
    for (const effort of REASONING_EFFORTS) {
      expect(REASONING_EFFORT_LABELS[effort]).toBeTruthy();
      expect(REASONING_EFFORT_SHORT_LABELS[effort]).toBeTruthy();
    }
  });

  it("defaults to the backend fallback effort", () => {
    expect(DEFAULT_REASONING_EFFORT).toBe("medium");
    expect(isReasoningEffort(DEFAULT_REASONING_EFFORT)).toBe(true);
  });

  describe("isReasoningEffort", () => {
    it("accepts valid values and rejects everything else", () => {
      expect(isReasoningEffort("high")).toBe(true);
      expect(isReasoningEffort("none")).toBe(true);
      expect(isReasoningEffort("ultra")).toBe(true);
      expect(isReasoningEffort("HIGH")).toBe(false); // exact match only
      expect(isReasoningEffort(2)).toBe(false);
      expect(isReasoningEffort(null)).toBe(false);
    });
  });

  describe("normalizeReasoningEffort", () => {
    it("trims and lowercases known values", () => {
      expect(normalizeReasoningEffort("  High ")).toBe("high");
      expect(normalizeReasoningEffort("XHIGH")).toBe("xhigh");
      expect(normalizeReasoningEffort("MAX")).toBe("max");
      expect(normalizeReasoningEffort("  Max ")).toBe("max");
      expect(normalizeReasoningEffort("none")).toBe("none");
    });

    it("returns null for empty / unknown / non-string", () => {
      expect(normalizeReasoningEffort("")).toBeNull();
      expect(normalizeReasoningEffort("   ")).toBeNull();
      expect(normalizeReasoningEffort("turbo")).toBeNull();
      expect(normalizeReasoningEffort(undefined)).toBeNull();
      expect(normalizeReasoningEffort(123)).toBeNull();
    });

    it("normalizes ultra", () => {
      expect(normalizeReasoningEffort("ULTRA")).toBe("ultra");
    });
  });

  describe("session reasoning overrides", () => {
    it("sets and gets per-session reasoning prefs", () => {
      const prefs = setSessionReasoning("s-1", { effort: "high", full: true });
      expect(prefs.effort).toBe("high");
      expect(getSessionReasoning("s-1").full).toBe(true);
      clearSessionReasoning("s-1");
      expect(getSessionReasoning("s-1").effort).toBeNull();
    });

    it("isolates sessions", () => {
      setSessionReasoning("s-a", { effort: "low" });
      setSessionReasoning("s-b", { effort: "max" });
      expect(getSessionReasoning("s-a").effort).toBe("low");
      expect(getSessionReasoning("s-b").effort).toBe("max");
    });
  });

  describe("clampReasoning", () => {
    it("collapses reasoning to the configured line count", () => {
      const text = "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11";
      expect(clampReasoning(text, 5)).toBe("1\n2\n3\n4\n5\n…");
    });

    it("leaves short text unchanged", () => {
      expect(clampReasoning("a\nb", 10)).toBe("a\nb");
    });
  });

  describe("reasoningEffortFromConfig", () => {
    it("reads agent.reasoning_effort from a config object", () => {
      expect(reasoningEffortFromConfig({ agent: { reasoning_effort: "low" } })).toBe("low");
      expect(reasoningEffortFromConfig({ agent: { reasoning_effort: "MEDIUM" } })).toBe("medium");
    });

    it("returns null when the field is missing, empty, or malformed", () => {
      expect(reasoningEffortFromConfig(undefined)).toBeNull();
      expect(reasoningEffortFromConfig(null)).toBeNull();
      expect(reasoningEffortFromConfig({})).toBeNull();
      expect(reasoningEffortFromConfig({ agent: {} })).toBeNull();
      expect(reasoningEffortFromConfig({ agent: { reasoning_effort: "" } })).toBeNull();
      expect(reasoningEffortFromConfig({ agent: "nope" })).toBeNull();
    });
  });
});
