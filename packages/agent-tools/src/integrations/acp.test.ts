import { describe, expect, it } from "vitest";
import "./acp.js";
import { registry } from "../registry.js";

const TOOL_NAMES = ["acp_ide_start", "acp_ide_status", "acp_ide_list_sessions"];

describe("acp_ide catalog registration", () => {
  it("registers the three ACP IDE tools", () => {
    for (const name of TOOL_NAMES) {
      const entry = registry.get(name);
      expect(entry, `expected ${name}`).toBeDefined();
      expect(entry!.toolset).toBe("acp_ide");
      expect(entry!.handler).toBeTypeOf("function");
    }
  });

  it("acp_ide_start schema lists cwd as required (objectSchema defaults to all keys)", () => {
    const schema = registry.get("acp_ide_start")!.schema;
    expect(schema.required).toEqual(["cwd"]);
  });
});

describe("acp_ide tool dispatch", () => {
  it("acp_ide_start echoes the cwd argument", async () => {
    const res = await registry.dispatch("acp_ide_start", { cwd: "/workspace" }, {});
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain('"cwd":"/workspace"');
  });

  it("acp_ide_status echoes an empty args object", async () => {
    const res = await registry.dispatch("acp_ide_status", {}, {});
    expect(res.isError).toBeFalsy();
    expect(res.content).toBe("{}");
  });

  it("acp_ide_list_sessions handles missing args gracefully", async () => {
    // JSON-RPC style calls may arrive without an args payload.
    const res = await registry.dispatch("acp_ide_list_sessions", undefined, {});
    expect(res.isError).toBeFalsy();
    expect(res.content).toBe("{}");
  });
});
