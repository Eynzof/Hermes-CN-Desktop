import { describe, expect, it, vi } from "vitest";
import { buildReviewPrompt, refine, summarizeReviewActions } from "./refine.js";
import type { ReviewRequest, ReviewResult } from "./types.js";

describe("buildReviewPrompt", () => {
  it("returns a memory review prompt", () => {
    const prompt = buildReviewPrompt("memory");
    expect(prompt).toContain("MEMORY.md / USER.md");
    expect(prompt).not.toContain("SKILL.md");
  });

  it("returns a skill review prompt", () => {
    const prompt = buildReviewPrompt("skill");
    expect(prompt).toContain("SKILL.md");
    expect(prompt).not.toContain("MEMORY.md");
  });

  it("returns a combined review prompt", () => {
    const prompt = buildReviewPrompt("combined");
    expect(prompt).toContain("MEMORY.md / USER.md");
    expect(prompt).toContain("SKILL.md");
  });

  it("appends focus to the prompt", () => {
    const prompt = buildReviewPrompt("combined", "typescript errors");
    expect(prompt).toContain("User focus: typescript errors");
  });
});

describe("refine", () => {
  function makeRequest(kind: ReviewRequest["kind"] = "combined", focus?: string): ReviewRequest {
    return {
      id: "r1",
      sessionId: "s1",
      kind,
      messages: [],
      focus,
      origin: "foreground",
    };
  }

  it("returns a prepared summary without a runner", async () => {
    const result = await refine(makeRequest("memory", "test"));
    expect(result.summary).toContain("Refine review prepared");
    expect(result.prompt).toContain("MEMORY.md / USER.md");
    expect(result.request.origin).toBe("foreground");
  });

  it("runs the supplied runner and returns patches with origin injected", async () => {
    const resultPatch: ReviewResult = {
      requestId: "r1",
      patches: [
        {
          id: "p1",
          subsystem: "skills",
          action: "create",
          target: "my-skill",
          summary: "Create my-skill",
          payload: { name: "my-skill" },
        },
      ],
      summary: "Created skill",
    };
    const runner = vi.fn().mockResolvedValue(resultPatch);

    const result = await refine(makeRequest("skill"), runner);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(result.result?.patches[0]?.payload._origin).toBe("foreground");
    expect(result.summary).toContain("1 improvement");
  });

  it("reports no refinements when the runner returns empty patches", async () => {
    const runner = vi.fn().mockResolvedValue({ requestId: "r1", patches: [], summary: "nothing" });
    const result = await refine(makeRequest("memory"), runner);
    expect(result.summary).toBe("No refinements proposed.");
  });
});

describe("summarizeReviewActions", () => {
  const result: ReviewResult = {
    requestId: "r1",
    patches: [{ id: "p1", subsystem: "memory", action: "add", target: "prefers-ts", summary: "remember TS preference", payload: {} }],
    summary: "Added memory",
  };

  it("returns empty string when mode is off", () => {
    expect(summarizeReviewActions(result, "off")).toBe("");
  });

  it("returns a compact toast summary by default", () => {
    const summary = summarizeReviewActions(result, "on");
    expect(summary).toContain("💾 Self-improvement review");
    expect(summary).toContain("remember TS preference");
  });

  it("returns verbose summary with result summary", () => {
    const summary = summarizeReviewActions(result, "verbose");
    expect(summary).toContain("Added memory");
    expect(summary).toContain("remember TS preference");
  });
});
