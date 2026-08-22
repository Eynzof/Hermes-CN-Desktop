import { describe, expect, it } from "vitest";
import { BoundedMemoryStore, createMemoryTool } from "./index.js";
import type { ToolContext } from "../types.js";

const dummyContext: ToolContext = { sessionId: "s1" };

describe("createMemoryTool", () => {
  it("adds a memory entry", async () => {
    const store = new BoundedMemoryStore();
    const tool = createMemoryTool(store);
    const result = await tool.execute(
      { action: "add_memory", scope: "memory", content: "hello" },
      dummyContext,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Added");
    expect(store.getEntries("memory")).toHaveLength(1);
  });

  it("searches memory entries", async () => {
    const store = new BoundedMemoryStore();
    store.load("memory", "first\n§\nsecond");
    const tool = createMemoryTool(store);
    const result = await tool.execute(
      { action: "search_memory", scope: "memory", query: "sec" },
      dummyContext,
    );
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("second");
  });

  it("updates a memory entry", async () => {
    const store = new BoundedMemoryStore();
    store.load("memory", "old value");
    const tool = createMemoryTool(store);
    const result = await tool.execute(
      { action: "update_memory", scope: "memory", old_text: "old", content: "new" },
      dummyContext,
    );
    expect(result.isError).toBe(false);
    expect(store.serialize("memory")).toBe("new value");
  });

  it("deletes a memory entry", async () => {
    const store = new BoundedMemoryStore();
    store.load("memory", "keep\n§\nremove me");
    const tool = createMemoryTool(store);
    const result = await tool.execute(
      { action: "delete_memory", scope: "memory", old_text: "remove" },
      dummyContext,
    );
    expect(result.isError).toBe(false);
    expect(store.getEntries("memory")).toHaveLength(1);
  });

  it("rejects invalid scope", async () => {
    const store = new BoundedMemoryStore();
    const tool = createMemoryTool(store);
    const result = await tool.execute(
      { action: "add_memory", scope: "invalid", content: "x" },
      dummyContext,
    );
    expect(result.isError).toBe(true);
  });

  it("rejects unknown action", async () => {
    const store = new BoundedMemoryStore();
    const tool = createMemoryTool(store);
    const result = await tool.execute(
      { action: "unknown", scope: "memory" },
      dummyContext,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Unknown memory action");
  });
});
