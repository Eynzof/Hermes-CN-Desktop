import { describe, expect, it } from "vitest";
import { ProxyProviderSchema, ProxyStatusSchema, UpstreamCredentialSchema } from "./subscription-proxy";

describe("ProxyProviderSchema", () => {
  it("accepts nous and xai", () => {
    expect(ProxyProviderSchema.parse("nous")).toBe("nous");
    expect(ProxyProviderSchema.parse("xai")).toBe("xai");
  });

  it("rejects other providers", () => {
    expect(ProxyProviderSchema.safeParse("openai").success).toBe(false);
    expect(ProxyProviderSchema.safeParse("").success).toBe(false);
  });
});

describe("ProxyStatusSchema", () => {
  it("parses a full status", () => {
    const parsed = ProxyStatusSchema.parse({
      running: true,
      port: 8431,
      provider: "nous",
      authenticated: true,
    });
    expect(parsed).toEqual({ running: true, port: 8431, provider: "nous", authenticated: true });
  });

  it("rejects missing or invalid fields", () => {
    expect(ProxyStatusSchema.safeParse({ running: true, port: 1, provider: "nous" }).success).toBe(false);
    expect(
      ProxyStatusSchema.safeParse({ running: true, port: 1, provider: "nous", authenticated: true, extra: true }).success,
    ).toBe(true);
  });
});

describe("UpstreamCredentialSchema", () => {
  it("parses a credential with optional expiresAt", () => {
    const parsed = UpstreamCredentialSchema.parse({
      bearer: "abc",
      baseUrl: "https://api.example.com",
      tokenType: "Bearer",
      expiresAt: "2026-01-01T00:00:00Z",
    });
    expect(parsed.bearer).toBe("abc");
    expect(parsed.expiresAt).toBe("2026-01-01T00:00:00Z");
    expect(UpstreamCredentialSchema.parse({ bearer: "b", baseUrl: "u", tokenType: "t" }).expiresAt).toBeUndefined();
  });

  it("rejects a missing bearer/baseUrl/tokenType", () => {
    expect(UpstreamCredentialSchema.safeParse({ baseUrl: "u", tokenType: "t" }).success).toBe(false);
    expect(UpstreamCredentialSchema.safeParse({ bearer: "b", tokenType: "t" }).success).toBe(false);
    expect(UpstreamCredentialSchema.safeParse({ bearer: "b", baseUrl: "u" }).success).toBe(false);
  });
});
