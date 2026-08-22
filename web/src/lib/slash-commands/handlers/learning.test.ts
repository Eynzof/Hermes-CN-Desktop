import { describe, expect, it, vi } from "vitest";
import { BoundedMemoryStore, InMemorySessionStore, LearningJourney } from "@hermes/agent-core";
import { handleJourney, handleLearning, handleMemoryGraph, type LearningHandlerContext } from "./learning";

function makeContext(): { ctx: LearningHandlerContext; navigated: string[] } {
  const journey = new LearningJourney();
  const memoryStore = new BoundedMemoryStore();
  const sessionStore = new InMemorySessionStore();
  const navigated: string[] = [];

  return {
    ctx: {
      journey,
      buildGraph: async () => {
        const { buildMemoryGraph } = await import("@hermes/agent-core");
        return buildMemoryGraph({ memoryStore, sessionStore });
      },
      navigate: (to: string) => navigated.push(to),
    },
    navigated,
  };
}

describe("handleJourney", () => {
  it("shows empty journey message", async () => {
    const { ctx } = makeContext();
    const result = await handleJourney("", ctx);
    expect(result.type).toBe("exec");
    expect(result.output).toContain("No learning yet");
  });

  it("lists due reviews", async () => {
    const { ctx } = makeContext();
    ctx.journey.addTopic("TypeScript");
    const result = await handleJourney("", ctx);
    expect(result.type).toBe("exec");
    expect(result.output).toContain("TypeScript");
    expect(result.output).toContain("Due for review: 1");
  });

  it("shows memory graph with graph subcommand", async () => {
    const { ctx, navigated } = makeContext();
    const result = await handleJourney("graph", ctx);
    expect(result.type).toBe("exec");
    expect(result.output).toContain("Memory graph");
    expect(navigated).toContain("journey");
  });
});

describe("handleLearning", () => {
  it("creates a topic when given a name", async () => {
    const { ctx } = makeContext();
    const result = await handleLearning("Rust", ctx);
    expect(result.type).toBe("exec");
    expect(result.output).toContain("Created learning topic: Rust");
    expect(ctx.journey.getTopics()).toHaveLength(1);
  });

  it("falls back to journey when no name is given", async () => {
    const { ctx } = makeContext();
    const result = await handleLearning("", ctx);
    expect(result.type).toBe("exec");
    expect(result.output).toContain("No learning yet");
  });
});

describe("handleMemoryGraph", () => {
  it("shows graph summary and navigates", async () => {
    const { ctx, navigated } = makeContext();
    const result = await handleMemoryGraph("", ctx);
    expect(result.type).toBe("exec");
    expect(result.output).toContain("Memory Graph");
    expect(navigated).toContain("journey");
  });
});
