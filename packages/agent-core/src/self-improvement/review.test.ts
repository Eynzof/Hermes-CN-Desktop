import { describe, expect, it, vi } from "vitest";
import { SelfImprovementLoop, defaultSelfImprovementConfig } from "./review.js";
import type { Message } from "../types.js";

describe("SelfImprovementLoop", () => {
  function makeLoop(options: Partial<ConstructorParameters<typeof SelfImprovementLoop>[0]> = {}) {
    return new SelfImprovementLoop({
      counters: { turnsSinceMemory: 0, itersSinceSkill: 0 },
      config: defaultSelfImprovementConfig(),
      ...options,
    });
  }

  function makeMessages(n: number): Message[] {
    return Array.from({ length: n }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `message ${i}`,
    })) as Message[];
  }

  it("increments turnsSinceMemory on user turn start", () => {
    const loop = makeLoop();
    loop.onUserTurnStart();
    loop.onUserTurnStart();
    expect(loop.getCounters().turnsSinceMemory).toBe(2);
  });

  it("increments itersSinceSkill on tool iteration", () => {
    const loop = makeLoop();
    loop.onToolIteration("read_file");
    loop.onToolIteration("execute_code");
    expect(loop.getCounters().itersSinceSkill).toBe(2);
  });

  it("resets itersSinceSkill on skill_manage", () => {
    const loop = makeLoop();
    loop.onToolIteration("read_file");
    loop.onToolIteration("skill_manage");
    expect(loop.getCounters().itersSinceSkill).toBe(0);
  });

  it("emits a memory review when turnsSinceMemory reaches interval", () => {
    const listener = vi.fn();
    const loop = makeLoop({ config: { ...defaultSelfImprovementConfig(), memoryNudgeInterval: 3 } });
    loop.on("self-improvement.review.requested", listener);

    loop.onUserTurnStart();
    loop.onUserTurnStart();
    expect(loop.maybeSpawnAfterTurn({ sessionId: "s1", messages: [], finalResponse: "ok" })).toBeNull();

    loop.onUserTurnStart();
    const request = loop.maybeSpawnAfterTurn({
      sessionId: "s1",
      messages: makeMessages(5),
      finalResponse: "ok",
    });

    expect(request).not.toBeNull();
    expect(request!.kind).toBe("memory");
    expect(request!.messages).toHaveLength(5);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(loop.getCounters().turnsSinceMemory).toBe(0);
  });

  it("emits a skill review when itersSinceSkill reaches interval", () => {
    const listener = vi.fn();
    const loop = makeLoop({ config: { ...defaultSelfImprovementConfig(), skillNudgeInterval: 2 } });
    loop.on("self-improvement.review.requested", listener);

    loop.onToolIteration("read_file");
    expect(loop.maybeSpawnAfterTurn({ sessionId: "s1", messages: [], finalResponse: "ok" })).toBeNull();

    loop.onToolIteration("execute_code");
    const request = loop.maybeSpawnAfterTurn({
      sessionId: "s1",
      messages: makeMessages(30),
      finalResponse: "ok",
    });

    expect(request).not.toBeNull();
    expect(request!.kind).toBe("skill");
    expect(request!.messages).toHaveLength(24);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(loop.getCounters().itersSinceSkill).toBe(0);
  });

  it("emits a combined review when both counters fire together", () => {
    const loop = makeLoop({
      config: {
        ...defaultSelfImprovementConfig(),
        memoryNudgeInterval: 2,
        skillNudgeInterval: 2,
      },
    });

    loop.onUserTurnStart();
    loop.onToolIteration("read_file");
    loop.onUserTurnStart();
    loop.onToolIteration("execute_code");

    const request = loop.maybeSpawnAfterTurn({
      sessionId: "s1",
      messages: makeMessages(8),
      finalResponse: "ok",
    });

    expect(request).not.toBeNull();
    expect(request!.kind).toBe("combined");
    expect(loop.getCounters()).toEqual({ turnsSinceMemory: 0, itersSinceSkill: 0 });
  });

  it("does not emit a review when interrupted or skipped", () => {
    const loop = makeLoop({
      config: {
        ...defaultSelfImprovementConfig(),
        memoryNudgeInterval: 1,
        skillNudgeInterval: 1,
      },
    });

    loop.onUserTurnStart();
    expect(loop.maybeSpawnAfterTurn({ sessionId: "s1", messages: [], interrupted: true })).toBeNull();

    loop.onUserTurnStart();
    expect(
      loop.maybeSpawnAfterTurn({ sessionId: "s1", messages: [], skipBackgroundReview: true }),
    ).toBeNull();

    loop.onUserTurnStart();
    expect(loop.maybeSpawnAfterTurn({ sessionId: "s1", messages: [] })).toBeNull();
  });

  it("refine always emits a review request", () => {
    const listener = vi.fn();
    const loop = makeLoop();
    loop.on("self-improvement.review.requested", listener);

    const request = loop.refine({
      sessionId: "s2",
      messages: makeMessages(10),
      focus: "typescript",
      kind: "skill",
    });

    expect(request.kind).toBe("skill");
    expect(request.focus).toBe("typescript");
    expect(request.origin).toBe("foreground");
    expect(request.messages).toHaveLength(10);
    expect(listener).toHaveBeenCalledWith({ request });
  });

  it("resetCounters zeroes both counters", () => {
    const loop = makeLoop();
    loop.onUserTurnStart();
    loop.onToolIteration("read_file");
    loop.resetCounters();
    expect(loop.getCounters()).toEqual({ turnsSinceMemory: 0, itersSinceSkill: 0 });
  });

  it("scanForRefinements returns a diagnostic summary and emits a request", () => {
    const listener = vi.fn();
    const loop = makeLoop({
      tools: [
        { name: "read_file", description: "", parameters: { type: "object" }, execute: async () => ({ content: "" }) },
      ],
    });
    loop.on("self-improvement.review.requested", listener);

    const messages: Message[] = [
      { role: "user", content: "remember I like TypeScript" },
      { role: "assistant", content: "OK", toolCalls: [{ id: "1", name: "read_file", arguments: {} }] },
    ];
    const summary = loop.scanForRefinements({ sessionId: "s3", messages, focus: "ts" });

    expect(summary).toContain("Review #");
    expect(summary).toContain("focus: ts");
    expect(summary).toContain("memory");
    expect(summary).toContain("read_file");
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
