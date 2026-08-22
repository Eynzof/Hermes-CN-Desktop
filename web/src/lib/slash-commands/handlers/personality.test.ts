import { describe, expect, it, vi } from "vitest";
import { handlePersonality } from "./personality";
import type { PersonalityHandlerContext } from "./personality";

function makeCtx(overrides: Partial<PersonalityHandlerContext> = {}): PersonalityHandlerContext {
  return {
    activeSessionId: "session-1",
    getConfig: () => ({
      agent: {
        personalities: {
          custom: "You are custom.",
        },
      },
    }),
    savePersonality: vi.fn().mockResolvedValue(undefined),
    setSessionPersonality: vi.fn(),
    ...overrides,
  };
}

describe("/personality slash handler", () => {
  it("lists available personalities when no argument", async () => {
    const ctx = makeCtx();
    const result = await handlePersonality("", ctx);
    expect(result.type).toBe("exec");
    expect(result.output).toContain("Available personalities:");
    expect(result.output).toContain("helpful");
    expect(result.output).toContain("pirate");
  });

  it("lists personalities with explicit list argument", async () => {
    const ctx = makeCtx();
    const result = await handlePersonality("list", ctx);
    expect(result.type).toBe("exec");
    expect(result.output).toContain("helpful");
  });

  it("applies a built-in personality", async () => {
    const ctx = makeCtx();
    const result = await handlePersonality("pirate", ctx);
    expect(result.type).toBe("exec");
    expect(result.output).toContain("pirate");
    expect(ctx.setSessionPersonality).toHaveBeenCalledWith("session-1", "pirate");
    expect(ctx.savePersonality).toHaveBeenCalledWith("pirate");
  });

  it("applies a user-defined personality", async () => {
    const ctx = makeCtx();
    const result = await handlePersonality("custom", ctx);
    expect(result.type).toBe("exec");
    expect(result.output).toContain("custom");
    expect(ctx.setSessionPersonality).toHaveBeenCalledWith("session-1", "custom");
  });

  it("resolves personality case-insensitively", async () => {
    const ctx = makeCtx();
    const result = await handlePersonality("PIRATE", ctx);
    expect(result.type).toBe("exec");
    expect(result.output).toContain("pirate");
  });

  it("reports an error for unknown personalities", async () => {
    const ctx = makeCtx();
    const result = await handlePersonality("unknown", ctx);
    expect(result.type).toBe("error");
    expect(result.message).toContain("Unknown personality");
  });

  it("resets to neutral on 'none'", async () => {
    const ctx = makeCtx();
    const result = await handlePersonality("none", ctx);
    expect(result.type).toBe("exec");
    expect(result.output).toContain("neutral");
    expect(ctx.setSessionPersonality).toHaveBeenCalledWith("session-1", "");
    expect(ctx.savePersonality).toHaveBeenCalledWith("");
  });

  it("resets to neutral on 'default'", async () => {
    const ctx = makeCtx();
    const result = await handlePersonality("default", ctx);
    expect(result.type).toBe("exec");
    expect(result.output).toContain("neutral");
  });

  it("works without persistence callbacks", async () => {
    const ctx = makeCtx({ savePersonality: undefined, setSessionPersonality: undefined });
    const result = await handlePersonality("helpful", ctx);
    expect(result.type).toBe("exec");
  });
});
