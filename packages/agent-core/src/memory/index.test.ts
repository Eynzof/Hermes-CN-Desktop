import { describe, expect, it } from "vitest";
import * as memoryIndex from "./index.js";
import {
  BoundedMemoryStore,
  charCount,
  defaultImportance,
  parseMemoryEntries,
  serializeEntries,
} from "./store.js";
import {
  createMemoryTool,
  executeMemoryTool,
  MEMORY_TOOL_SCHEMA,
} from "./tool.js";
import {
  ExternalMemoryProviderRegistry,
  defaultExternalMemoryRegistry,
  EXTERNAL_MEMORY_PROVIDER_CATALOG,
} from "./external.js";
import {
  createHonchoProvider,
  createOpenVikingProvider,
  createMem0Provider,
  createHindsightProvider,
  createHolographicProvider,
  createRetainDBProvider,
  createByteRoverProvider,
  createSupermemoryProvider,
  HttpMemoryProvider,
} from "./providers/index.js";
import type { ExternalMemoryProvider } from "./providers/types.js";

describe("memory/index re-exports", () => {
  it("re-exports built-in bounded memory store helpers and class", () => {
    expect(memoryIndex.BoundedMemoryStore).toBe(BoundedMemoryStore);
    expect(memoryIndex.charCount).toBe(charCount);
    expect(memoryIndex.defaultImportance).toBe(defaultImportance);
    expect(memoryIndex.parseMemoryEntries).toBe(parseMemoryEntries);
    expect(memoryIndex.serializeEntries).toBe(serializeEntries);
  });

  it("re-exports the memory tool", () => {
    expect(memoryIndex.createMemoryTool).toBe(createMemoryTool);
    expect(memoryIndex.executeMemoryTool).toBe(executeMemoryTool);
    expect(memoryIndex.MEMORY_TOOL_SCHEMA).toBe(MEMORY_TOOL_SCHEMA);
  });

  it("re-exports the external memory registry", () => {
    expect(memoryIndex.ExternalMemoryProviderRegistry).toBe(ExternalMemoryProviderRegistry);
    expect(memoryIndex.defaultExternalMemoryRegistry).toBe(defaultExternalMemoryRegistry);
    expect(memoryIndex.EXTERNAL_MEMORY_PROVIDER_CATALOG).toBe(EXTERNAL_MEMORY_PROVIDER_CATALOG);
  });

  it("re-exports every provider factory from providers/index", () => {
    expect(memoryIndex.createHonchoProvider).toBe(createHonchoProvider);
    expect(memoryIndex.createOpenVikingProvider).toBe(createOpenVikingProvider);
    expect(memoryIndex.createMem0Provider).toBe(createMem0Provider);
    expect(memoryIndex.createHindsightProvider).toBe(createHindsightProvider);
    expect(memoryIndex.createHolographicProvider).toBe(createHolographicProvider);
    expect(memoryIndex.createRetainDBProvider).toBe(createRetainDBProvider);
    expect(memoryIndex.createByteRoverProvider).toBe(createByteRoverProvider);
    expect(memoryIndex.createSupermemoryProvider).toBe(createSupermemoryProvider);
  });

  it("re-exports the HttpMemoryProvider base class", () => {
    expect(memoryIndex.HttpMemoryProvider).toBe(HttpMemoryProvider);
  });
});

describe("memory/index integration through the index surface", () => {
  it("factory-created providers satisfy the ExternalMemoryProvider interface", async () => {
    const providers: ExternalMemoryProvider[] = [
      createHonchoProvider({}),
      createOpenVikingProvider({}),
      createMem0Provider({}),
      createHindsightProvider({}),
      createHolographicProvider({}),
      createRetainDBProvider({}),
      createByteRoverProvider({}),
      createSupermemoryProvider({}),
    ];
    expect(providers).toHaveLength(8);
    for (const provider of providers) {
      expect(provider.name).toBeTypeOf("string");
      expect(provider.displayName).toBeTypeOf("string");
      expect(provider.description).toBeTypeOf("string");
      expect(typeof provider.search).toBe("function");
      expect(typeof provider.add).toBe("function");
      expect(typeof provider.delete).toBe("function");
      expect(typeof provider.getConfigSchema).toBe("function");
      expect(typeof provider.validateConfig).toBe("function");
    }
    // Every catalog entry maps to a working factory-created provider.
    expect(EXTERNAL_MEMORY_PROVIDER_CATALOG.map((entry) => entry.name).sort()).toEqual(
      providers.map((p) => p.name).sort(),
    );
  });

  it("the default registry can create all bundled providers", () => {
    const names = defaultExternalMemoryRegistry.list().map((entry) => entry.name);
    expect(names).toHaveLength(8);
    for (const name of names) {
      const created = defaultExternalMemoryRegistry.getProvider(name);
      expect(created).toBeDefined();
      expect(created?.name).toBe(name);
    }
  });

  it("built-in store round-trips through the shared index exports", () => {
    const store = new BoundedMemoryStore({ memoryCharLimit: 1000 });
    const text = serializeEntries([{ content: "hello", importance: 0.5 }]);
    expect(parseMemoryEntries(text)).toHaveLength(1);
    expect(charCount("abc")).toBe(3);
    expect(defaultImportance("x")).toBeGreaterThan(0);
    expect(store).toBeDefined();
  });
});
