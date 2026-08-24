import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Message } from "../types.js";
import {
  clearContextEngines,
  compressWithActiveEngine,
  getActiveContextEngine,
  getContextEngine,
  listContextEngines,
  manifestToContextEngine,
  registerContextEngine,
  setActiveContextEngine,
  unregisterContextEngine,
} from "./context-plugin.js";
import type { PluginManifest } from "./types.js";

describe("context engine plugin registry", () => {
  beforeEach(() => {
    clearContextEngines();
  });

  afterEach(() => {
    clearContextEngines();
  });

  it("registers and retrieves engines", () => {
    registerContextEngine({
      slug: "noop",
      name: "Noop Engine",
      compress: async () => undefined,
    });

    expect(getContextEngine("noop")?.name).toBe("Noop Engine");
    expect(listContextEngines()).toHaveLength(1);
  });

  it("compresses with the active engine", async () => {
    registerContextEngine({
      slug: "summary",
      name: "Summary Engine",
      compress: async (messages: Message[]) => ({
        messages,
        summary: "compressed",
        tokensSaved: 10,
      }),
    });

    const result = await compressWithActiveEngine([]);
    expect(result?.summary).toBe("compressed");
    expect(result?.tokensSaved).toBe(10);
  });

  it("allows switching active engines", () => {
    registerContextEngine({
      slug: "a",
      name: "A",
      compress: async () => undefined,
    });
    registerContextEngine({
      slug: "b",
      name: "B",
      compress: async () => undefined,
    });

    expect(getActiveContextEngine()).toBe("a");
    expect(setActiveContextEngine("b")).toBe(true);
    expect(getActiveContextEngine()).toBe("b");
    expect(setActiveContextEngine("missing")).toBe(false);
  });

  it("clears active slug after clear", () => {
    registerContextEngine({
      slug: "custom",
      name: "Custom",
      compress: async () => undefined,
    });
    clearContextEngines();
    expect(getActiveContextEngine()).toBeUndefined();
  });
});

describe("manifestToContextEngine", () => {
  it("builds an engine from a manifest and compress implementation", async () => {
    const manifest: PluginManifest = {
      name: "rolling-summary",
      title: "Rolling Summary",
      description: "Summarizes context",
      version: "1.0.0",
      kind: "context-engine",
    };
    const compress = async (messages: Message[]) => ({
      messages,
      summary: "done",
      tokensSaved: 7,
    });
    const engine = manifestToContextEngine(manifest, compress);
    expect(engine.slug).toBe("rolling-summary");
    expect(engine.name).toBe("Rolling Summary");
    expect(engine.description).toBe("Summarizes context");
    await expect(engine.compress([])).resolves.toEqual({
      messages: [],
      summary: "done",
      tokensSaved: 7,
    });
  });

  it("falls back to the manifest name as display name", () => {
    const manifest: PluginManifest = { name: "plain", version: "1.0.0", kind: "context-engine" };
    const engine = manifestToContextEngine(manifest, async () => undefined);
    expect(engine.slug).toBe("plain");
    expect(engine.name).toBe("plain");
    expect(engine.description).toBeUndefined();
  });
});

describe("unregisterContextEngine", () => {
  afterEach(() => {
    clearContextEngines();
  });

  it("returns false for unknown slugs", () => {
    expect(unregisterContextEngine("missing")).toBe(false);
  });

  it("removes a registered engine", () => {
    registerContextEngine({ slug: "tmp", name: "Tmp", compress: async () => undefined });
    expect(unregisterContextEngine("tmp")).toBe(true);
    expect(getContextEngine("tmp")).toBeUndefined();
  });

  it("reassigns the active engine when the active one is removed", () => {
    registerContextEngine({ slug: "a", name: "A", compress: async () => undefined });
    registerContextEngine({ slug: "b", name: "B", compress: async () => undefined });
    expect(getActiveContextEngine()).toBe("a");
    expect(unregisterContextEngine("a")).toBe(true);
    expect(getActiveContextEngine()).toBe("b");
  });

  it("clears the active engine when the last one is removed", () => {
    registerContextEngine({ slug: "only", name: "Only", compress: async () => undefined });
    expect(unregisterContextEngine("only")).toBe(true);
    expect(getActiveContextEngine()).toBeUndefined();
  });
});
