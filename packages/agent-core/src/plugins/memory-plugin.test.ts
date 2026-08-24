import { afterEach, describe, expect, it } from "vitest";
import {
  clearMemoryProviders,
  createActiveMemoryStore,
  getActiveMemoryProvider,
  getMemoryProvider,
  listMemoryProviders,
  manifestToMemoryProvider,
  registerMemoryProvider,
  setActiveMemoryProvider,
  unregisterMemoryProvider,
} from "./memory-plugin.js";
import type { MemoryStoreLike } from "./memory-plugin.js";
import type { PluginManifest } from "./types.js";

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

describe("manifestToMemoryProvider", () => {
  function emptyStore(): MemoryStoreLike {
    return { load: () => {}, search: () => ({ entries: [] }) };
  }

  it("builds a provider from a manifest and factory", () => {
    const manifest: PluginManifest = {
      name: "mem0",
      title: "Mem0",
      description: "External memory",
      version: "1.0.0",
      kind: "memory-provider",
    };
    const factory = () => emptyStore();
    const provider = manifestToMemoryProvider(manifest, factory);
    expect(provider.slug).toBe("mem0");
    expect(provider.name).toBe("Mem0");
    expect(provider.description).toBe("External memory");
    expect(provider.createStore({}).search("memory", "q").entries).toEqual([]);
  });

  it("falls back to the manifest name as display name", () => {
    const provider = manifestToMemoryProvider(
      { name: "plain", version: "1.0.0", kind: "memory-provider" },
      () => emptyStore(),
    );
    expect(provider.name).toBe("plain");
  });
});

describe("unregisterMemoryProvider", () => {
  afterEach(() => {
    clearMemoryProviders();
  });

  it("returns false for unknown slugs", () => {
    expect(unregisterMemoryProvider("missing")).toBe(false);
  });

  it("removes a registered provider", () => {
    registerMemoryProvider({
      slug: "tmp",
      name: "Tmp",
      createStore: () => ({ load: () => {}, search: () => ({ entries: [] }) }),
    });
    expect(unregisterMemoryProvider("tmp")).toBe(true);
    expect(getMemoryProvider("tmp")).toBeUndefined();
  });

  it("reassigns the active provider when the active one is removed", () => {
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
    expect(getActiveMemoryProvider()).toBe("a");
    expect(unregisterMemoryProvider("a")).toBe(true);
    expect(getActiveMemoryProvider()).toBe("b");
  });

  it("clears the active provider when the last one is removed", () => {
    registerMemoryProvider({
      slug: "only",
      name: "Only",
      createStore: () => ({ load: () => {}, search: () => ({ entries: [] }) }),
    });
    expect(unregisterMemoryProvider("only")).toBe(true);
    expect(getActiveMemoryProvider()).toBeUndefined();
  });
});
