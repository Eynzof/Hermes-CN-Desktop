import { describe, expect, it } from "vitest";
import {
  CodexItemEventSchema,
  CodexModelInfoSchema,
  CodexPluginInfoSchema,
  CodexRuntimeSchema,
  CodexRuntimeStatusSchema,
  CodexTurnResultSchema,
} from "./codex-runtime";

describe("CodexRuntimeSchema", () => {
  it("accepts the supported runtimes", () => {
    expect(CodexRuntimeSchema.parse("auto")).toBe("auto");
    expect(CodexRuntimeSchema.parse("codex_app_server")).toBe("codex_app_server");
  });

  it("rejects unknown runtimes", () => {
    expect(CodexRuntimeSchema.safeParse("cli").success).toBe(false);
    expect(CodexRuntimeSchema.safeParse(1).success).toBe(false);
  });
});

describe("CodexTurnResultSchema", () => {
  it("parses a full turn result", () => {
    const parsed = CodexTurnResultSchema.parse({
      finalText: "done",
      projectedMessages: [{ role: "user" }],
      toolIterations: 3,
      interrupted: true,
      error: "boom",
      turnId: "t1",
      threadId: "th1",
      tokenUsageLast: 100,
      tokenUsageTotal: 500,
    });
    expect(parsed.finalText).toBe("done");
    expect(parsed.projectedMessages).toHaveLength(1);
    expect(parsed.toolIterations).toBe(3);
    expect(parsed.interrupted).toBe(true);
    expect(parsed.error).toBe("boom");
    expect(parsed.tokenUsageTotal).toBe(500);
  });

  it("applies defaults for a minimal result", () => {
    const parsed = CodexTurnResultSchema.parse({});
    expect(parsed.finalText).toBeUndefined();
    expect(parsed.projectedMessages).toEqual([]);
    expect(parsed.toolIterations).toBe(0);
    expect(parsed.interrupted).toBe(false);
    expect(parsed.error).toBeUndefined();
    expect(parsed.turnId).toBeUndefined();
    expect(parsed.threadId).toBeUndefined();
  });

  it("rejects a non-boolean interrupted flag", () => {
    const result = CodexTurnResultSchema.safeParse({ interrupted: "yes" });
    expect(result.success).toBe(false);
  });
});

describe("CodexItemEventSchema", () => {
  it("parses an item event with optional item and delta", () => {
    const parsed = CodexItemEventSchema.parse({
      type: "message",
      item: { id: "i1" },
      delta: { text: "hi" },
    });
    expect(parsed.type).toBe("message");
    expect(parsed.item).toEqual({ id: "i1" });
    expect(parsed.delta).toEqual({ text: "hi" });
  });

  it("accepts a bare type and rejects a missing type", () => {
    expect(CodexItemEventSchema.parse({ type: "tool_call" }).type).toBe("tool_call");
    expect(CodexItemEventSchema.safeParse({ item: {} }).success).toBe(false);
  });
});

describe("CodexPluginInfoSchema / CodexModelInfoSchema", () => {
  it("parses plugin info with optional version", () => {
    expect(CodexPluginInfoSchema.parse({ name: "skills" }).version).toBeUndefined();
    expect(CodexPluginInfoSchema.parse({ name: "skills", version: "1.2.0" }).version).toBe("1.2.0");
    expect(CodexPluginInfoSchema.safeParse({ version: "1.2.0" }).success).toBe(false);
  });

  it("parses model info with optional name", () => {
    expect(CodexModelInfoSchema.parse({ id: "gpt-5" }).name).toBeUndefined();
    expect(CodexModelInfoSchema.parse({ id: "gpt-5", name: "GPT-5" }).name).toBe("GPT-5");
    expect(CodexModelInfoSchema.safeParse({ name: "GPT-5" }).success).toBe(false);
  });
});

describe("CodexRuntimeStatusSchema", () => {
  it("parses runtime status", () => {
    expect(CodexRuntimeStatusSchema.parse({ runtime: "auto", binaryOk: true })).toEqual({
      runtime: "auto",
      binaryOk: true,
    });
  });

  it("rejects an invalid runtime value or missing binaryOk", () => {
    expect(CodexRuntimeStatusSchema.safeParse({ runtime: "nope", binaryOk: true }).success).toBe(false);
    expect(CodexRuntimeStatusSchema.safeParse({ runtime: "auto" }).success).toBe(false);
  });
});
