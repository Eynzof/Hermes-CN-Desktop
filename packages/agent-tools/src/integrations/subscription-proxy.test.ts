import { describe, expect, it } from "vitest";
import "./subscription-proxy.js";
import { registry } from "../registry.js";

const TOOL_NAMES = ["subscription_proxy_status", "subscription_proxy_start"];

describe("subscription_proxy catalog registration", () => {
  it("registers the two subscription proxy tools", () => {
    for (const name of TOOL_NAMES) {
      const entry = registry.get(name);
      expect(entry, `expected ${name}`).toBeDefined();
      expect(entry!.toolset).toBe("subscription_proxy");
      expect(entry!.handler).toBeTypeOf("function");
    }
  });

  it("subscription_proxy_start enumerates supported providers", () => {
    const schema = registry.get("subscription_proxy_start")!.schema;
    const provider = schema.properties?.provider as { enum?: string[] } | undefined;
    expect(provider?.enum).toEqual(["nous", "xai"]);
  });
});

describe("subscription_proxy tool dispatch", () => {
  it("status returns the stub message", async () => {
    const res = await registry.dispatch("subscription_proxy_status", {}, {});
    expect(res.content).toBe("Would report subscription proxy status");
  });

  it("start names the selected provider", async () => {
    const res = await registry.dispatch("subscription_proxy_start", { provider: "xai" }, {});
    expect(res.isError).toBeFalsy();
    expect(res.content).toBe("Would start subscription proxy for xai");
  });
});
