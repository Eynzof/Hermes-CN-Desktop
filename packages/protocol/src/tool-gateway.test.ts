import { describe, expect, it } from "vitest";
import {
  NousTokenSchema,
  PortalStatusResponseSchema,
  ToolFeatureStateSchema,
  ToolGatewayConfigSchema,
  ToolGatewayVendorSchema,
} from "./tool-gateway";

describe("ToolGatewayVendorSchema", () => {
  it("accepts the managed vendors", () => {
    for (const v of ["firecrawl", "fal-queue", "openai-audio", "browser-use"]) {
      expect(ToolGatewayVendorSchema.parse(v)).toBe(v);
    }
  });

  it("rejects unknown vendors", () => {
    expect(ToolGatewayVendorSchema.safeParse("serpapi").success).toBe(false);
  });
});

describe("NousTokenSchema", () => {
  it("parses a token with optional refreshToken/expiresAt", () => {
    const parsed = NousTokenSchema.parse({
      accessToken: "at",
      refreshToken: "rt",
      expiresAt: 1700000000,
    });
    expect(parsed.accessToken).toBe("at");
    expect(parsed.expiresAt).toBe(1700000000);
    expect(NousTokenSchema.parse({ accessToken: "at" }).refreshToken).toBeUndefined();
  });

  it("rejects a missing accessToken", () => {
    expect(NousTokenSchema.safeParse({}).success).toBe(false);
    expect(NousTokenSchema.safeParse({ refreshToken: "rt" }).success).toBe(false);
  });
});

describe("ToolFeatureStateSchema", () => {
  it("parses a feature state with optional overrides", () => {
    const parsed = ToolFeatureStateSchema.parse({
      key: "web_search",
      label: "Web Search",
      available: true,
      active: true,
      managedByNous: true,
      directOverride: false,
      currentProvider: "firecrawl",
    });
    expect(parsed.directOverride).toBe(false);
    expect(parsed.currentProvider).toBe("firecrawl");
  });

  it("rejects missing required fields", () => {
    expect(ToolFeatureStateSchema.safeParse({ key: "k", label: "l", available: true, active: true }).success).toBe(false);
    expect(ToolFeatureStateSchema.safeParse({ key: "k", label: "l", available: true, active: true, managedByNous: true }).success).toBe(true);
  });
});

describe("PortalStatusResponseSchema", () => {
  it("parses a portal status response", () => {
    const parsed = PortalStatusResponseSchema.parse({
      loggedIn: true,
      portalUrl: "https://portal.nousresearch.com",
      inferenceUrl: "https://inference.nousresearch.com",
      provider: "nous",
      subscriptionUrl: "https://portal.nousresearch.com/subscribe",
      features: [],
    });
    expect(parsed.loggedIn).toBe(true);
    expect(parsed.features).toEqual([]);
  });

  it("rejects a missing features array", () => {
    const result = PortalStatusResponseSchema.safeParse({
      loggedIn: true,
      portalUrl: "u",
      inferenceUrl: "i",
      provider: "p",
      subscriptionUrl: "s",
    });
    expect(result.success).toBe(false);
  });
});

describe("ToolGatewayConfigSchema", () => {
  it("parses a per-vendor gateway config record", () => {
    const parsed = ToolGatewayConfigSchema.parse({ web_search: { useGateway: true } });
    expect(parsed.web_search?.useGateway).toBe(true);
    expect(ToolGatewayConfigSchema.parse({ web_search: {} }).web_search?.useGateway).toBeUndefined();
    expect(ToolGatewayConfigSchema.parse({}).web_search).toBeUndefined();
  });
});
