import { describe, expect, it, beforeEach } from "vitest";
import { ToolRegistry } from "./tool-registry.js";
import type { DynamicToolEntry } from "./types.js";

function entry(name: string, toolset = "test"): DynamicToolEntry {
  return {
    name,
    toolset,
    description: `${name} tool`,
    schema: { type: "object", properties: { msg: { type: "string" } } },
    handler: async (args) => ({ content: String((args as { msg?: string })?.msg ?? name) }),
  };
}

describe("ToolRegistry", () => {
  let reg: ToolRegistry;

  beforeEach(() => {
    reg = new ToolRegistry();
  });

  it("registers and retrieves entries", () => {
    reg.register(entry("foo"));
    expect(reg.getEntry("foo")?.name).toBe("foo");
    expect(reg.getAllEntries()).toHaveLength(1);
    expect(reg.getEntry("missing")).toBeUndefined();
  });

  it("throws on duplicate registration without override", () => {
    reg.register(entry("foo"));
    expect(() => reg.register(entry("foo"))).toThrow(/already registered/);
    expect(() => reg.register(entry("foo"), { override: false })).toThrow(/already registered/);
  });

  it("allows duplicate registration with override=true", () => {
    reg.register(entry("foo"));
    reg.register({ ...entry("foo"), description: "replaced" }, { override: true });
    expect(reg.getEntry("foo")?.description).toBe("replaced");
    expect(reg.getAllEntries()).toHaveLength(1);
  });

  it("deregisters entries", () => {
    reg.register(entry("foo"));
    reg.deregister("foo");
    expect(reg.getEntry("foo")).toBeUndefined();
    // Deregistering an unknown name is a no-op.
    expect(() => reg.deregister("nope")).not.toThrow();
  });

  it("applies the scope option to the stored entry", () => {
    reg.register(entry("foo"), { scope: "session-1" });
    expect(reg.getEntry("foo")?.scope).toBe("session-1");
  });

  it("keeps the entry scope when no scope option is passed", () => {
    reg.register({ ...entry("foo"), scope: "keep" });
    expect(reg.getEntry("foo")?.scope).toBe("keep");
  });

  it("lists tool names per toolset, honoring aliases", () => {
    reg.register(entry("a", "srv"));
    reg.register(entry("b", "mcp-github"));
    reg.registerToolsetAlias("github", "mcp-github");
    expect(reg.getToolNamesForToolset("srv")).toEqual(["a"]);
    expect(reg.getToolNamesForToolset("mcp-github")).toEqual(["b"]);
    expect(reg.getToolNamesForToolset("github")).toEqual(["b"]);
    expect(reg.getToolNamesForToolset("unknown")).toEqual([]);
  });

  it("lists unique registered toolset names", () => {
    reg.register(entry("a", "srv"));
    reg.register(entry("b", "srv"));
    reg.register(entry("c", "other"));
    expect(reg.getRegisteredToolsetNames().sort()).toEqual(["other", "srv"]);
  });

  it("resolves toolset aliases with identity fallback", () => {
    reg.registerToolsetAlias("github", "mcp-github");
    expect(reg.getToolsetAliasTarget("github")).toBe("mcp-github");
    expect(reg.getToolsetAliasTarget("unknown")).toBeUndefined();
    expect(reg.resolveToolsetAlias("github")).toBe("mcp-github");
    expect(reg.resolveToolsetAlias("unknown")).toBe("unknown");
  });

  it("builds definitions for present tools and skips missing ones", () => {
    reg.register(entry("a"));
    const defs = reg.getDefinitions(new Set(["a", "missing"]));
    expect(defs).toHaveLength(1);
    expect(defs[0].type).toBe("function");
    expect(defs[0].function.name).toBe("a");
    expect(defs[0].function.parameters).toEqual(entry("a").schema);
  });

  it("snapshots and restores registrations", () => {
    reg.register(entry("foo"));
    const snap = reg.snapshotRegistration("foo");
    expect(snap).toBeDefined();
    expect(snap!.name).toBe("foo");

    // Replace then restore.
    reg.register({ ...entry("foo"), description: "changed" }, { override: true });
    expect(reg.getEntry("foo")?.description).toBe("changed");
    expect(reg.restoreRegistration(snap!)).toBe(true);
    expect(reg.getEntry("foo")?.description).toBe("foo tool");
  });

  it("snapshotRegistration returns undefined for unknown tools", () => {
    expect(reg.snapshotRegistration("nope")).toBeUndefined();
  });

  it("restoreRegistration refuses snapshots whose name differs from the entry", () => {
    reg.register(entry("foo"));
    const snap = reg.snapshotRegistration("foo")!;
    // Internal inconsistency: snapshot name and entry name diverge.
    const forged = { name: "foo", entry: { ...snap.entry, name: "bar" } };
    expect(reg.restoreRegistration(forged)).toBe(false);
    expect(reg.getEntry("bar")).toBeUndefined();
    expect(reg.getEntry("foo")?.description).toBe("foo tool");
  });
});
