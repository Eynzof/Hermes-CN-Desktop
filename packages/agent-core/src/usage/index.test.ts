import { describe, expect, it } from "vitest";
import {
  emptyUsageContext,
  emptyUsageCost,
  emptyUsageTokens,
  UsageTracker,
} from "./index.js";

describe("usage/index", () => {
  it("re-exports the UsageTracker class", () => {
    const tracker = new UsageTracker();
    expect(tracker.listSessions()).toEqual([]);
  });

  it("re-exports emptyUsageTokens with all counters at zero", () => {
    expect(emptyUsageTokens()).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
      total: 0,
      calls: 0,
    });
  });

  it("re-exports emptyUsageContext with zero window and estimated flag", () => {
    expect(emptyUsageContext()).toEqual({
      used: 0,
      max: 0,
      percent: 0,
      compressions: 0,
      estimated: true,
    });
  });

  it("re-exports emptyUsageCost with unknown status", () => {
    expect(emptyUsageCost()).toEqual({ costUsd: 0, status: "unknown" });
  });

  it("exposes the full tracker surface through the barrel", () => {
    const tracker = new UsageTracker();
    tracker.addTurn("s1", {
      turnIndex: 0,
      timestamp: Date.now(),
      tokens: emptyUsageTokens(),
    });
    expect(tracker.getSessionUsage("s1")).toBeDefined();
    expect(tracker.listSessions()).toEqual(["s1"]);
    tracker.resetSession("s1");
    expect(tracker.getSessionUsage("s1")).toBeUndefined();
  });
});
