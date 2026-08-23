import { describe, expect, it } from "vitest";
import "./egress-proxy.js";
import { registry } from "../registry.js";

const TOOL_NAMES = ["egress_proxy_start", "egress_proxy_import_secrets", "egress_proxy_status"];

describe("egress_proxy catalog registration", () => {
  it("registers the three egress proxy tools", () => {
    for (const name of TOOL_NAMES) {
      const entry = registry.get(name);
      expect(entry, `expected ${name}`).toBeDefined();
      expect(entry!.toolset).toBe("egress_proxy");
      expect(entry!.handler).toBeTypeOf("function");
    }
  });

  it("egress_proxy_import_secrets requires secretsJson", () => {
    const schema = registry.get("egress_proxy_import_secrets")!.schema;
    expect(schema.required).toEqual(["secretsJson"]);
  });
});

describe("egress_proxy tool dispatch", () => {
  it("start defaults to port 8650", async () => {
    const res = await registry.dispatch("egress_proxy_start", {}, {});
    expect(res.isError).toBeFalsy();
    expect(res.content).toBe("Would start egress proxy on port 8650");
  });

  it("start honors an explicit port", async () => {
    const res = await registry.dispatch("egress_proxy_start", { port: 9000 }, {});
    expect(res.content).toBe("Would start egress proxy on port 9000");
  });

  it("import_secrets acknowledges without echoing secrets", async () => {
    const res = await registry.dispatch("egress_proxy_import_secrets", { secretsJson: '{"api_key":"topsecret"}' }, {});
    expect(res.content).toBe("Would import secrets");
    expect(res.content).not.toContain("topsecret");
  });

  it("status returns the stub message", async () => {
    const res = await registry.dispatch("egress_proxy_status", {}, {});
    expect(res.content).toBe("Would report egress proxy status");
  });
});
