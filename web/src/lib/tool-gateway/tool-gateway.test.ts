import { describe, it, expect, vi } from "vitest";
import { buildVendorGatewayUrl, managedVendorEndpoints, isManagedNousGatewayUrl } from "./origins.js";
import { readNousAccessToken, peekNousAccessToken } from "./token.js";
import { GatewayClient } from "./gateway-client.js";
import { getNousSubscriptionFeatures, setUseGateway } from "./features.js";
import { getPortalStatus } from "./portal-status.js";

describe("tool-gateway origins", () => {
  it("builds vendor gateway url", () => {
    expect(buildVendorGatewayUrl("firecrawl")).toBe("https://firecrawl-gateway.nousresearch.com");
  });

  it("detects managed gateway urls", () => {
    expect(isManagedNousGatewayUrl("https://firecrawl-gateway.nousresearch.com/api/foo")).toBe(true);
    expect(isManagedNousGatewayUrl("https://example.com")).toBe(false);
  });
});

describe("tool-gateway token", () => {
  it("peeks access token", () => {
    expect(peekNousAccessToken([{ accessToken: "abc" }])).toBe("abc");
  });

  it("reads non-expired token", () => {
    expect(readNousAccessToken([{ accessToken: "abc", expiresAt: Date.now() / 1000 + 300 }])).toBe("abc");
  });

  it("skips expired token", () => {
    expect(readNousAccessToken([{ accessToken: "abc", expiresAt: 1 }])).toBeNull();
  });
});

describe("tool-gateway client", () => {
  it("injects bearer for managed urls", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true })));
    const client = new GatewayClient({ fetch, getToken: async () => "tok" });
    await client.call("firecrawl", "/search", { method: "POST", body: "{}" });
    const call = fetch.mock.calls[0];
    expect(call[0]).toContain("firecrawl-gateway.nousresearch.com");
    expect((call[1].headers as Headers).get("Authorization")).toBe("Bearer tok");
  });

  it("returns upload token", async () => {
    const client = new GatewayClient({ fetch, getToken: async () => null });
    expect(await client.upload("firecrawl", new Blob(["x"]), "text/plain")).toContain("nous-upload");
  });
});

describe("tool-gateway features", () => {
  it("reflects use_gateway flags", () => {
    const cfg = setUseGateway({}, "web", true);
    const features = getNousSubscriptionFeatures(cfg);
    expect(features.find((f) => f.key === "web")?.active).toBe(true);
  });
});

describe("tool-gateway portal status", () => {
  it("returns status with features", () => {
    const status = getPortalStatus({ web: { useGateway: true } });
    expect(status.features.some((f) => f.key === "web" && f.active)).toBe(true);
  });
});
