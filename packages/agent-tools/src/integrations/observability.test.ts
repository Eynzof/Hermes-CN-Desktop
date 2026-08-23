import { describe, expect, it } from "vitest";
import "./observability.js";
import { registry } from "../registry.js";

const TOOL_NAMES = ["observability_get_config", "observability_set_config"];

describe("observability catalog registration", () => {
  it("registers the two observability tools", () => {
    for (const name of TOOL_NAMES) {
      const entry = registry.get(name);
      expect(entry, `expected ${name}`).toBeDefined();
      expect(entry!.toolset).toBe("observability");
      expect(entry!.handler).toBeTypeOf("function");
    }
  });

  it("observability_set_config lists all keys as required (objectSchema default)", () => {
    const schema = registry.get("observability_set_config")!.schema;
    expect(schema.required).toEqual(["enabled", "endpoint", "sampleRate"]);
    expect(schema.properties).toHaveProperty("endpoint");
    expect(schema.properties).toHaveProperty("sampleRate");
  });
});

describe("observability tool dispatch", () => {
  it("get_config returns the stub message", async () => {
    const res = await registry.dispatch("observability_get_config", {}, {});
    expect(res.content).toBe("Would return telemetry config");
  });

  it("set_config echoes the full args", async () => {
    const res = await registry.dispatch(
      "observability_set_config",
      { enabled: true, endpoint: "http://collector:4318", sampleRate: 0.5 },
      {},
    );
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain('"enabled":true');
    expect(res.content).toContain("http://collector:4318");
    expect(res.content).toContain("0.5");
  });
});
