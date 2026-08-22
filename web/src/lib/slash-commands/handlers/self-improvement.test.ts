import { describe, expect, it, vi } from "vitest";
import { handleRefine, handleLearn, buildLearnPrompt, type SelfImprovementHandlerContext } from "./self-improvement";
import { SelfImprovementLoop, defaultSelfImprovementConfig } from "@hermes/agent-core";

function makeContext(partial: Partial<SelfImprovementHandlerContext> = {}): SelfImprovementHandlerContext {
  return {
    loop: new SelfImprovementLoop({ counters: { turnsSinceMemory: 0, itersSinceSkill: 0 }, config: defaultSelfImprovementConfig() }),
    activeSessionId: "session-1",
    getMessages: () => [{ role: "user", content: "hello" }],
    ...partial,
  };
}

describe("handleRefine", () => {
  it("returns an error without an active session", () => {
    const result = handleRefine("", makeContext({ activeSessionId: null }));
    expect(result.type).toBe("error");
    expect(result.message).toContain("requires an active session");
  });

  it("requests a review and reports the focus", () => {
    const listener = vi.fn();
    const loop = makeContext().loop;
    loop.on("self-improvement.review.requested", listener);

    const result = handleRefine("typescript", makeContext({ loop }));
    expect(result.type).toBe("exec");
    expect(result.output).toContain("Self-improvement review requested");
    expect(result.output).toContain("focus: typescript");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("requests a review without focus", () => {
    const result = handleRefine("  ", makeContext());
    expect(result.type).toBe("exec");
    expect(result.output).toContain("Self-improvement review requested");
    expect(result.output).not.toContain("focus:");
  });
});

describe("handleLearn", () => {
  it("returns a usage error without arguments", () => {
    const result = handleLearn("", makeContext());
    expect(result.type).toBe("error");
    expect(result.message).toContain("Usage: /learn");
  });

  it("builds a learn prompt and returns a pending prompt", () => {
    const listener = vi.fn();
    const loop = makeContext().loop;
    loop.on("self-improvement.review.requested", listener);

    const result = handleLearn("how to use vitest", makeContext({ loop }));
    expect(result.type).toBe("exec");
    expect(result.pendingPrompt).toContain("User request: how to use vitest");
    expect(result.pendingPrompt).toContain("SKILL.md");
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("buildLearnPrompt", () => {
  it("includes authoring standards and user request", () => {
    const prompt = buildLearnPrompt("write a git skill");
    expect(prompt).toContain("User request: write a git skill");
    expect(prompt).toContain("YAML frontmatter");
    expect(prompt).toContain("untrusted source");
    expect(prompt).toContain("skill_manage");
  });
});
