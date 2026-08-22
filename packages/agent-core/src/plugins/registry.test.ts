import { afterEach, describe, expect, it, vi } from "vitest";
import { PluginRegistry, validateManifest } from "./registry.js";
import type { PluginManifest } from "./types.js";

function makeManifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    name: "test-plugin",
    version: "1.0.0",
    kind: "general",
    ...overrides,
  };
}

describe("validateManifest", () => {
  it("passes for a valid manifest", () => {
    const result = validateManifest(makeManifest());
    expect(result.ok).toBe(true);
    expect(result.diagnostics).toHaveLength(0);
  });

  it("reports missing name", () => {
    const result = validateManifest(makeManifest({ name: "" }));
    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]?.code).toBe("missing_name");
  });

  it("reports missing version", () => {
    const result = validateManifest(makeManifest({ version: "" }));
    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]?.code).toBe("missing_version");
  });

  it("coerces unknown kind to general", () => {
    const manifest = makeManifest({ kind: "unknown-kind" as "general" });
    const result = validateManifest(manifest);
    expect(result.ok).toBe(true);
    expect(result.diagnostics[0]?.code).toBe("unknown_kind");
    expect(manifest.kind).toBe("general");
  });
});

describe("PluginRegistry", () => {
  afterEach(async () => {
    // Shared module state is cleared between tests via the registry instance.
  });

  it("registers and retrieves a plugin", () => {
    const registry = new PluginRegistry();
    registry.register(makeManifest({ name: "demo" }));

    const record = registry.get("demo");
    expect(record).toBeDefined();
    expect(record?.manifest.name).toBe("demo");
    expect(record?.id).toBe("demo");
  });

  it("normalizes ids", () => {
    const registry = new PluginRegistry();
    registry.register(makeManifest({ name: "My Plugin" }));
    expect(registry.get("my-plugin")).toBeDefined();
    expect(registry.get("My Plugin")).toBeDefined();
  });

  it("discovers multiple manifests", () => {
    const registry = new PluginRegistry();
    const result = registry.discover([
      makeManifest({ name: "a" }),
      makeManifest({ name: "b" }),
    ]);

    expect(result.errors).toHaveLength(0);
    expect(result.plugins).toHaveLength(2);
    expect(registry.list()).toHaveLength(2);
  });

  it("reports discovery errors without crashing", () => {
    const registry = new PluginRegistry();
    const badManifest = makeManifest({ name: "", version: "" });
    const result = registry.discover([badManifest]);

    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    expect(result.plugins).toHaveLength(1);
    expect(result.plugins[0]?.state).toBe("error");
  });

  it("lists summaries", () => {
    const registry = new PluginRegistry();
    registry.register(makeManifest({ name: "summary-test", title: "Summary Test" }));

    const summaries = registry.summaries();
    expect(summaries[0]?.name).toBe("summary-test");
    expect(summaries[0]?.title).toBe("Summary Test");
  });

  it("enables and disables plugins", () => {
    const registry = new PluginRegistry();
    registry.register(makeManifest({ name: "toggle" }), "local", "", false);

    expect(registry.enable("toggle")?.enabled).toBe(true);
    expect(registry.disable("toggle")?.enabled).toBe(false);
    expect(registry.setEnabled("missing", true)).toBeUndefined();
  });

  it("removes a plugin and runs unloaders", async () => {
    const registry = new PluginRegistry();
    const unloader = vi.fn();
    registry.register(makeManifest({ name: "unloadable" }));

    await registry.activate("unloadable");
    const record = registry.get("unloadable");
    expect(record).toBeDefined();
    record && registry["makeContext"](record).onUnload(unloader);

    const removed = await registry.remove("unloadable");
    expect(removed).toBe(true);
    expect(registry.get("unloadable")).toBeUndefined();
    expect(unloader).toHaveBeenCalled();
  });

  it("clears all plugins", async () => {
    const registry = new PluginRegistry();
    registry.register(makeManifest({ name: "a" }));
    registry.register(makeManifest({ name: "b" }));

    await registry.clear();
    expect(registry.list()).toHaveLength(0);
  });

  it("reloads a manifest", () => {
    const registry = new PluginRegistry();
    registry.register(makeManifest({ name: "reloadable", version: "1.0.0" }));

    const reloaded = registry.reload("reloadable", makeManifest({ name: "reloadable", version: "2.0.0" }));
    expect(reloaded?.manifest.version).toBe("2.0.0");
  });

  it("returns undefined for unknown reload/remove", async () => {
    const registry = new PluginRegistry();
    expect(registry.reload("missing", makeManifest())).toBeUndefined();
    expect(await registry.remove("missing")).toBe(false);
  });

  it("filters by kind", () => {
    const registry = new PluginRegistry();
    registry.register(makeManifest({ name: "general-plugin", kind: "general" }));
    registry.register(makeManifest({ name: "model-provider", kind: "model-provider" }));

    expect(registry.byKind("general")).toHaveLength(1);
    expect(registry.byKind("model-provider")).toHaveLength(1);
    expect(registry.byKind("memory-provider")).toHaveLength(0);
  });

  it("computes dependents", () => {
    const registry = new PluginRegistry();
    registry.register(makeManifest({ name: "base" }));
    registry.register(makeManifest({ name: "child", requiresPlugins: ["base"] }));

    expect(registry.dependentsOf("base")).toEqual(["child"]);
    expect(registry.dependentsOf("missing")).toEqual([]);
  });

  it("activates general plugins through the configured activator", async () => {
    const activator = vi.fn();
    const registry = new PluginRegistry({ activator });
    registry.register(makeManifest({ name: "activatable" }));

    await registry.activate("activatable");
    expect(activator).toHaveBeenCalledWith("activatable", expect.any(Object));
  });

  it("does not activate non-general plugins", async () => {
    const activator = vi.fn();
    const registry = new PluginRegistry({ activator });
    registry.register(makeManifest({ name: "mp", kind: "model-provider" }));

    const result = await registry.activate("mp");
    expect(result).toBeUndefined();
    expect(activator).not.toHaveBeenCalled();
  });

  it("seeds bundled manifests on construction", () => {
    const registry = new PluginRegistry({
      bundled: [makeManifest({ name: "bundled" })],
    });

    expect(registry.get("bundled")?.source).toBe("bundled");
  });
});
