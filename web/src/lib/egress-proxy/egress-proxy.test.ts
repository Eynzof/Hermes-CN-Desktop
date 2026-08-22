import { describe, it, expect, vi } from "vitest";
import { EgressProxyClient } from "./client.js";
import { compileEgressRule, evaluateEgressRules } from "./rules.js";
import { EgressOrchestrator } from "./orchestrator.js";
import { downloadText } from "./download.js";
import { collectSecrets, maskSecrets } from "./secrets-import.js";

describe("egress proxy client", () => {
  it("starts proxy", async () => {
    const invoke = vi.fn().mockResolvedValue({ running: true });
    const client = new EgressProxyClient({ invoke });
    const status = await client.start(8080);
    expect(status.running).toBe(true);
    expect(invoke).toHaveBeenCalledWith("egress_proxy_start", { port: 8080 });
  });

  it("imports secrets", async () => {
    const invoke = vi.fn().mockResolvedValue({ secrets: { API_KEY: "abc" } });
    const client = new EgressProxyClient({ invoke });
    const bundle = await client.importSecrets({ API_KEY: "abc" });
    expect(bundle.secrets.API_KEY).toBe("abc");
  });
});

describe("egress rules", () => {
  it("compiles and evaluates rules", () => {
    const rule = compileEgressRule({ id: "r1", pattern: "^https://api\.example\.com", action: "allow" });
    const match = evaluateEgressRules([rule], "https://api.example.com/v1");
    expect(match?.action).toBe("allow");
  });

  it("returns null for no match", () => {
    const rule = compileEgressRule({ id: "r1", pattern: "example", action: "deny" });
    expect(evaluateEgressRules([rule], "https://other.com")).toBeNull();
  });
});

describe("egress orchestrator", () => {
  it("deploys valid rules", async () => {
    const setRules = vi.fn().mockResolvedValue({ running: true });
    const client = { setRules } as unknown as EgressProxyClient;
    const orchestrator = new EgressOrchestrator(client);
    const res = await orchestrator.deployRulePack([
      { id: "r1", pattern: "example", action: "allow" } as any,
    ]);
    expect(res.applied).toBe(1);
  });

  it("downloads and provisions", async () => {
    const invoke = vi.fn().mockResolvedValue(JSON.stringify([{ id: "r1", pattern: "example", action: "allow" }]));
    const setRules = vi.fn().mockResolvedValue({});
    const client = new EgressProxyClient({ invoke });
    Object.assign(client, { setRules });
    const orchestrator = new EgressOrchestrator(client);
    const res = await orchestrator.provisionFromUrl("https://example.com/rules.json");
    expect(res.rules).toBe(1);
  });
});

describe("download", () => {
  it("downloads text", async () => {
    const text = await downloadText("https://example.com", async () => new Response("ok") as any);
    expect(text).toBe("ok");
  });
});

describe("secrets import", () => {
  it("collects secrets", () => {
    const bundle = collectSecrets([{ key: "API_KEY", value: "secret", source: "env" }]);
    expect(bundle.secrets.API_KEY).toBe("secret");
  });

  it("masks secrets", () => {
    const out = maskSecrets("x secret y", { API_KEY: "secret" });
    expect(out).toBe("x [MASKED:API_KEY] y");
  });
});
