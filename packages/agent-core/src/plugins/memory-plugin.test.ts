import { afterEach, describe, expect, it } from "vitest";
import {
  clearMemoryProviders,
  createActiveMemoryStore,
  getActiveMemoryProvider,
  getMemoryProvider,
  listMemoryProviders,
  registerMemoryProvider,
  setActiveMemoryProvider,
} from "./memory-plugin.js";

describe("memory provider plugin registry", () => {
  afterEach(() => {
    clearMemoryProviders();
  });

  it("registers and retrieves providers", () => {
    registerMemoryProvider({
      slug: "mem-test",
      name: "Memory Test",
      createStore: () => ({ load: () => {}, search: () => ({ entries: [] }) }),
    });

    expect(getMemoryProvider("mem-test")?.name).toBe("Memory Test");
    expect(listMemoryProviders()).toHaveLength(1);
  });

  it("selects the first registered provider as active", () => {
    registerMemoryProvider({
      slug: "first",
      name: "First",
      createStore: () => ({ load: () => {}, search: () => ({ entries: [] }) }),
    });

    expect(getActiveMemoryProvider()).toBe("first");
  });

  it("allows changing the active provider", () => {
    registerMemoryProvider({
      slug: "a",
      name: "A",
      createStore: () => ({ load: () => {}, search: () => ({ entries: [] }) }),
    });
    registerMemoryProvider({
      slug: "b",
      name: "B",
      createStore: () => ({ load: () => {}, search: () => ({ entries: [] }) }),
    });

    expect(setActiveMemoryProvider("b")).toBe(true);
    expect(getActiveMemoryProvider()).toBe("b");
    expect(setActiveMemoryProvider("missing")).toBe(false);
  });

  it("creates a store from the active provider", () => {
    registerMemoryProvider({
      slug: "active-store",
      name: "Active Store",
      createStore: () => ({
        load: () => {},
        search: () => ({ entries: [{ content: "hello" }] }),
      }),
    });

    const store = createActiveMemoryStore();
    expect(store).toBeDefined();
    expect(store?.search("memory", "hi").entries).toHaveLength(1);
  });

  it("returns undefined when no provider is active", () => {
    expect(createActiveMemoryStore()).toBeUndefined();
  });
});
