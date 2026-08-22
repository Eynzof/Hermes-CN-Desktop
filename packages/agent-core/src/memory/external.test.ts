import { describe, expect, it } from "vitest";
import {
  ExternalMemoryProviderRegistry,
  EXTERNAL_MEMORY_PROVIDER_CATALOG,
} from "./external.js";

describe("ExternalMemoryProviderRegistry", () => {
  it("lists all 8 bundled providers", () => {
    const registry = new ExternalMemoryProviderRegistry();
    const names = registry.list().map((entry) => entry.name);
    expect(names).toEqual([
      "honcho",
      "openviking",
      "mem0",
      "hindsight",
      "holographic",
      "retaindb",
      "byterover",
      "supermemory",
    ]);
  });

  it("resolves a valid provider config", () => {
    const registry = new ExternalMemoryProviderRegistry();
    const resolved = registry.resolveConfig({
      provider: "mem0",
      apiKey: "test-key",
    });
    expect(resolved).not.toBeNull();
    expect(resolved?.provider.name).toBe("mem0");
    expect(resolved?.validation.valid).toBe(true);
  });

  it("returns validation errors for invalid config", () => {
    const registry = new ExternalMemoryProviderRegistry();
    const resolved = registry.resolveConfig({ provider: "mem0" });
    expect(resolved?.validation.valid).toBe(false);
    expect(resolved?.validation.errors).toContain("apiKey is required");
  });

  it("returns null for unknown providers", () => {
    const registry = new ExternalMemoryProviderRegistry();
    const resolved = registry.resolveConfig({ provider: "unknown" });
    expect(resolved).toBeNull();
  });

  it("stores and retrieves configured providers", () => {
    const registry = new ExternalMemoryProviderRegistry();
    const validation = registry.setConfig("honcho", { apiKey: "honcho-key" });
    expect(validation.valid).toBe(true);

    const provider = registry.getProvider("honcho");
    expect(provider).toBeDefined();
    expect(provider?.name).toBe("honcho");
  });

  it("rejects setConfig for unknown providers", () => {
    const registry = new ExternalMemoryProviderRegistry();
    const validation = registry.setConfig("unknown", { apiKey: "x" });
    expect(validation.valid).toBe(false);
    expect(validation.errors).toContain("Unknown provider: unknown");
  });

  it("rejects invalid config in setConfig", () => {
    const registry = new ExternalMemoryProviderRegistry();
    const validation = registry.setConfig("byterover", {});
    expect(validation.valid).toBe(false);
    expect(validation.errors).toContain("workingDir is required");
  });

  it("catalog entries expose metadata", () => {
    const entry = EXTERNAL_MEMORY_PROVIDER_CATALOG.find((e) => e.name === "openviking");
    expect(entry?.displayName).toBe("OpenViking");
    expect(entry?.description).toContain("Self-hosted");
  });
});
