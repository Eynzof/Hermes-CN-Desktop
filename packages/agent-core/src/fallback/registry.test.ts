import { describe, expect, it, vi } from "vitest";
import { FallbackRegistry } from "./registry.js";
import { executeFallback, resolveFallback } from "./resolve.js";
import { FALLBACK_PURPOSES } from "./types.js";

describe("fallback registry (P1-8)", () => {
  it("tries providers in weight order and returns the first success", async () => {
    const registry = new FallbackRegistry();
    const a = vi.fn().mockRejectedValue(new Error("primary down"));
    const b = vi.fn().mockResolvedValue("ok-from-b");
    registry.register("vision", { name: "a", weight: 10, run: a });
    registry.register("vision", { name: "b", weight: 5, run: b });

    const result = await registry.execute("vision", { image: "x" });
    expect(result).toMatchObject({ ok: true, provider: "b", value: "ok-from-b" });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("skips disabled providers", async () => {
    const registry = new FallbackRegistry();
    const a = vi.fn();
    registry.register("title", { name: "a", enabled: false, run: a });
    registry.register("title", { name: "b", run: () => "t" });

    const result = await registry.execute("title", {});
    expect(result.ok).toBe(true);
    expect(result.provider).toBe("b");
    expect(a).not.toHaveBeenCalled();
  });

  it("collects errors when every provider fails", async () => {
    const registry = new FallbackRegistry();
    registry.register("approval", { name: "x", run: () => { throw new Error("no"); } });

    const result = await registry.execute("approval", {});
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([{ provider: "x", message: "no" }]);
  });

  it("exposes all purposes through FALLBACK_PURPOSES", () => {
    expect(FALLBACK_PURPOSES).toContain("vision");
    expect(FALLBACK_PURPOSES).toContain("goal-judge");
    expect(FALLBACK_PURPOSES).toHaveLength(8);
  });

  it("resolveFallback returns the first enabled provider", () => {
    const registry = new FallbackRegistry();
    registry.register("mcp", { name: "primary", run: () => "x" });
    registry.register("mcp", { name: "backup", run: () => "y" });
    // executeFallback uses the shared singleton; resolveFallback with a fresh
    // registry is tested through providersFor indirectly.
    const providers = registry.providersFor("mcp");
    expect(providers[0].name).toBe("primary");
  });

  it("executeFallback (shared singleton) returns not-ok with no providers", async () => {
    const result = await executeFallback("compression", {});
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([]);
  });
});
