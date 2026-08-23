import { describe, expect, it } from "vitest";
import "./tool-gateway.js";
import { registry } from "../registry.js";

const TOOL_NAMES = ["tool_gateway_status", "tool_gateway_call"];

describe("tool_gateway catalog registration", () => {
  it("registers the two tool gateway tools", () => {
    for (const name of TOOL_NAMES) {
      const entry = registry.get(name);
      expect(entry, `expected ${name}`).toBeDefined();
      expect(entry!.toolset).toBe("tool_gateway");
      expect(entry!.handler).toBeTypeOf("function");
    }
  });

  it("tool_gateway_call enumerates vendors and methods", () => {
    const schema = registry.get("tool_gateway_call")!.schema;
    const vendor = schema.properties?.vendor as { enum?: string[] } | undefined;
    const method = schema.properties?.method as { enum?: string[] } | undefined;
    expect(vendor?.enum).toEqual(["firecrawl", "fal-queue", "openai-audio", "browser-use"]);
    expect(method?.enum).toEqual(["GET", "POST"]);
  });
});

describe("tool_gateway tool dispatch", () => {
  it("status returns the stub message", async () => {
    const res = await registry.dispatch("tool_gateway_status", {}, {});
    expect(res.content).toBe("Would return tool gateway status");
  });

  it("call returns the stub message regardless of routing args", async () => {
    const res = await registry.dispatch(
      "tool_gateway_call",
      { vendor: "firecrawl", path: "/v1/scrape", method: "POST", body: "{}" },
      {},
    );
    expect(res.isError).toBeFalsy();
    expect(res.content).toBe("Would call managed tool gateway");
  });
});
