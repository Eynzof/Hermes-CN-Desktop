import { describe, expect, it } from "vitest";
import { UsageTracker } from "./tracker.js";

describe("UsageTracker", () => {
  it("starts empty", () => {
    const tracker = new UsageTracker();
    expect(tracker.getSessionUsage("s1")).toBeUndefined();
    expect(tracker.listSessions()).toEqual([]);
  });

  it("adds a turn and aggregates tokens", () => {
    const tracker = new UsageTracker();
    tracker.addTurn("s1", {
      turnIndex: 1,
      timestamp: 0,
      model: "gpt-4o",
      provider: "openai",
      tokens: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5, reasoning: 0, total: 150, calls: 1 },
    });
    const usage = tracker.getSessionUsage("s1")!;
    expect(usage.tokens.input).toBe(100);
    expect(usage.tokens.output).toBe(50);
    expect(usage.tokens.total).toBe(150);
    expect(usage.tokens.calls).toBe(1);
    expect(usage.model).toBe("gpt-4o");
    expect(usage.provider).toBe("openai");
  });

  it("aggregates multiple turns per session", () => {
    const tracker = new UsageTracker();
    tracker.addTurn("s1", {
      turnIndex: 1,
      timestamp: 0,
      tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 150, calls: 1 },
    });
    tracker.addTurn("s1", {
      turnIndex: 2,
      timestamp: 1,
      tokens: { input: 80, output: 40, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 120, calls: 1 },
    });
    const usage = tracker.getSessionUsage("s1")!;
    expect(usage.tokens.input).toBe(180);
    expect(usage.tokens.output).toBe(90);
    expect(usage.tokens.total).toBe(270);
    expect(usage.turns).toHaveLength(2);
  });

  it("overwrites an existing turn index", () => {
    const tracker = new UsageTracker();
    tracker.addTurn("s1", {
      turnIndex: 1,
      timestamp: 0,
      tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 150, calls: 1 },
    });
    tracker.addTurn("s1", {
      turnIndex: 1,
      timestamp: 1,
      tokens: { input: 50, output: 25, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 75, calls: 1 },
    });
    const usage = tracker.getSessionUsage("s1")!;
    expect(usage.tokens.input).toBe(50);
    expect(usage.tokens.total).toBe(75);
    expect(usage.turns).toHaveLength(1);
  });

  it("isolates sessions", () => {
    const tracker = new UsageTracker();
    tracker.addTurn("s1", { turnIndex: 1, timestamp: 0, tokens: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 10, calls: 1 } });
    tracker.addTurn("s2", { turnIndex: 1, timestamp: 0, tokens: { input: 20, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 20, calls: 1 } });
    expect(tracker.getSessionUsage("s1")!.tokens.input).toBe(10);
    expect(tracker.getSessionUsage("s2")!.tokens.input).toBe(20);
  });

  it("merges context windows and costs", () => {
    const tracker = new UsageTracker();
    tracker.addTurn("s1", {
      turnIndex: 1,
      timestamp: 0,
      tokens: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 10, calls: 1 },
      context: { used: 1000, max: 4000, percent: 25, compressions: 0, estimated: false },
      cost: { costUsd: 0.001, status: "ok" },
    });
    tracker.addTurn("s1", {
      turnIndex: 2,
      timestamp: 1,
      tokens: { input: 20, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 20, calls: 1 },
      context: { used: 2000, max: 4000, percent: 50, compressions: 1, estimated: false },
      cost: { costUsd: 0.002, status: "ok" },
    });
    const usage = tracker.getSessionUsage("s1")!;
    expect(usage.context.used).toBe(2000);
    expect(usage.context.max).toBe(4000);
    expect(usage.context.compressions).toBe(1);
    expect(usage.cost.costUsd).toBeCloseTo(0.003);
  });

  it("resets sessions", () => {
    const tracker = new UsageTracker();
    tracker.addTurn("s1", { turnIndex: 1, timestamp: 0, tokens: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 10, calls: 1 } });
    tracker.resetSession("s1");
    expect(tracker.getSessionUsage("s1")).toBeUndefined();
  });
});
