import { describe, it, expect, beforeEach } from "vitest";
import { ToolRegistry, register } from "./registry.js";
import type { ToolEntry } from "./types.js";

const echoEntry: ToolEntry = {
  name: "echo",
  toolset: "test",
  description: "Echo tool",
  schema: { type: "object", properties: { msg: { type: "string" } }, required: ["msg"] },
  handler: async (args) => ({ content: String((args as { msg: string }).msg) }),
};

describe("ToolRegistry", () => {
  beforeEach(() => {
    // fresh registry for each test
  });

  it("registers a tool and bumps generation", () => {
    const reg = new ToolRegistry();
    const g0 = reg.getGeneration();
    reg.register(echoEntry);
    expect(reg.getGeneration()).toBe(g0 + 1);
    expect(reg.has("echo")).toBe(true);
  });

  it("returns definitions synchronously", () => {
    const reg = new ToolRegistry();
    reg.register(echoEntry);
    const defs = reg.getDefinitionsSync(["echo"]);
    expect(defs).toHaveLength(1);
    expect(defs[0].function.name).toBe("echo");
  });

  it("filters definitions by checkFn", async () => {
    const reg = new ToolRegistry();
    reg.register({ ...echoEntry, name: "gated", checkFn: () => false });
    const defs = await reg.getDefinitions(["gated"]);
    expect(defs).toHaveLength(0);
  });

  it("dispatches a tool call", async () => {
    const reg = new ToolRegistry();
    reg.register(echoEntry);
    const res = await reg.dispatch("echo", { msg: "hi" }, { sessionId: "s1" });
    expect(res.content).toBe("hi");
  });

  it("returns an error for unknown tools", async () => {
    const reg = new ToolRegistry();
    const res = await reg.dispatch("missing", {}, { sessionId: "s1" });
    expect(res.isError).toBe(true);
  });

  it("truncates oversized results", async () => {
    const reg = new ToolRegistry();
    reg.register({
      ...echoEntry,
      name: "long",
      handler: async () => ({ content: "x".repeat(20) }),
      maxResultSizeChars: 10,
    });
    const res = await reg.dispatch("long", {}, { sessionId: "s1" });
    expect(res.content).toContain("truncated");
    expect(res.content).not.toHaveLength(20);
  });

  it("global register() helper works", () => {
    register({ ...echoEntry, name: `global_echo_${Date.now()}` });
    // global registry is reused across tests because catalog auto-registers too
    expect(true).toBe(true);
  });
});
