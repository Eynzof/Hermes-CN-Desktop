import { describe, expect, it } from "vitest";
import { BoundedMemoryStore, createMemoryTool } from "./index.js";
import { ExternalMemoryProviderRegistry } from "./external.js";
import type { ToolContext } from "../types.js";

const dummyContext: ToolContext = { sessionId: "s1" };

function makeMockFetch(responseBody: unknown): typeof fetch {
  return (_input: RequestInfo | URL, _init?: RequestInit) => {
    return Promise.resolve(
      new Response(JSON.stringify(responseBody), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  };
}

describe("memory tool with external provider selection", () => {
  it("routes search_memory to an external provider", async () => {
    const store = new BoundedMemoryStore();
    const registry = new ExternalMemoryProviderRegistry();
    const fetchImpl = makeMockFetch([
      { id: "m1", memory: "external result", score: 0.9 },
    ]);
    registry.setConfig("mem0", { apiKey: "mem0-key", fetchImpl });
    const tool = createMemoryTool(store, { externalRegistry: registry });

    const result = await tool.execute(
      { action: "search_memory", scope: "memory", query: "hello", provider: "mem0" },
      dummyContext,
    );

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("external result");
  });

  it("routes add_memory to an external provider", async () => {
    const store = new BoundedMemoryStore();
    const registry = new ExternalMemoryProviderRegistry();
    const fetchImpl = makeMockFetch({ id: "m2", message: "Mem0 memory added." });
    registry.setConfig("mem0", { apiKey: "mem0-key", fetchImpl });
    const tool = createMemoryTool(store, { externalRegistry: registry });

    const result = await tool.execute(
      { action: "add_memory", scope: "memory", content: "note", provider: "mem0" },
      dummyContext,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("added");
  });

  it("routes delete_memory to an external provider", async () => {
    const store = new BoundedMemoryStore();
    const registry = new ExternalMemoryProviderRegistry();
    const fetchImpl = makeMockFetch({ status: "deleted" });
    registry.setConfig("mem0", { apiKey: "mem0-key", fetchImpl });
    const tool = createMemoryTool(store, { externalRegistry: registry });

    const result = await tool.execute(
      { action: "delete_memory", scope: "memory", external_id: "m1", provider: "mem0" },
      dummyContext,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("deleted");
  });

  it("requires external_id for external delete", async () => {
    const store = new BoundedMemoryStore();
    const registry = new ExternalMemoryProviderRegistry();
    registry.setConfig("mem0", { apiKey: "mem0-key" });
    const tool = createMemoryTool(store, { externalRegistry: registry });

    const result = await tool.execute(
      { action: "delete_memory", scope: "memory", provider: "mem0" },
      dummyContext,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("external_id is required");
  });

  it("errors for unknown provider", async () => {
    const store = new BoundedMemoryStore();
    const registry = new ExternalMemoryProviderRegistry();
    const tool = createMemoryTool(store, { externalRegistry: registry });

    const result = await tool.execute(
      { action: "search_memory", scope: "memory", query: "x", provider: "unknown" },
      dummyContext,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Unknown or unconfigured external memory provider");
  });

  it("errors when external provider config is invalid", async () => {
    const store = new BoundedMemoryStore();
    const registry = new ExternalMemoryProviderRegistry();
    const tool = createMemoryTool(store, { externalRegistry: registry });

    const result = await tool.execute(
      { action: "search_memory", scope: "memory", query: "x", provider: "mem0" },
      dummyContext,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("apiKey is required");
  });

  it("errors when no registry is configured but provider is requested", async () => {
    const store = new BoundedMemoryStore();
    const tool = createMemoryTool(store);

    const result = await tool.execute(
      { action: "search_memory", scope: "memory", query: "x", provider: "mem0" },
      dummyContext,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("no registry is configured");
  });

  it("still routes to built-in store when provider is absent", async () => {
    const store = new BoundedMemoryStore();
    store.load("memory", "foo\n§\nbar");
    const tool = createMemoryTool(store);

    const result = await tool.execute(
      { action: "search_memory", scope: "memory", query: "foo" },
      dummyContext,
    );

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("foo");
  });
});
