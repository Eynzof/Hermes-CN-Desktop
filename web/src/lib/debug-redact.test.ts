import { describe, expect, it } from "vitest";
import { redact, redactSummary } from "./debug-redact";

describe("redact", () => {
  it("masks sensitive top-level keys", () => {
    const out = redact({ api_key: "sk-aaa", baseUrl: "https://x" }) as Record<string, unknown>;
    expect(out.api_key).toBe("***");
    expect(out.baseUrl).toBe("https://x");
  });

  it("masks case-insensitive variants and nested objects", () => {
    const out = redact({
      headers: {
        Authorization: "Bearer secret123",
        "X-Hermes-Session-Token": "tok",
      },
      apiKey: "leak",
      payload: { session_token: "abc" },
    }) as Record<string, any>;
    expect(out.headers.Authorization).toBe("***");
    expect(out.headers["X-Hermes-Session-Token"]).toBe("***");
    expect(out.apiKey).toBe("***");
    expect(out.payload.session_token).toBe("***");
  });

  it("scrubs Bearer tokens and provider-specific token shapes inside string values", () => {
    const out = redact({
      message: "request failed: Bearer abcdefghij returned 401",
      detail: "key=sk-abcdefghijklmnop1234567890 not allowed",
    }) as Record<string, string>;
    expect(out.message).toContain("Bearer ***");
    expect(out.message).not.toContain("abcdefghij");
    expect(out.detail).toContain("***");
    expect(out.detail).not.toContain("sk-abcdefghijklmnop1234567890");
  });

  it("walks arrays and preserves non-sensitive primitives", () => {
    const out = redact([
      { user: "claw", password: "pw" },
      { token: 42, foo: "bar" },
    ]) as any[];
    expect(out[0].user).toBe("claw");
    expect(out[0].password).toBe("***");
    expect(out[1].foo).toBe("bar");
  });

  it("does not blow up on cycles or oversized depth", () => {
    const a: any = { name: "root" };
    a.self = a;
    expect(() => redact(a)).not.toThrow();
  });

  it("preserves null / undefined / numbers / booleans", () => {
    expect(redact(null)).toBeNull();
    expect(redact(undefined)).toBeUndefined();
    expect(redact(42)).toBe(42);
    expect(redact(true)).toBe(true);
  });
});

describe("redactSummary", () => {
  it("masks Bearer in human summaries", () => {
    expect(redactSummary("PUT /api/x → 401 (Bearer abcdefghij)")).toContain("Bearer ***");
  });
  it("leaves plain summaries untouched", () => {
    expect(redactSummary("message.complete · sid=abc")).toBe("message.complete · sid=abc");
  });
  it("masks sensitive key-value fragments in log text", () => {
    expect(redactSummary("gateway failed token=secret-value api_key='sk-abcdefghijklmnop1234567890'"))
      .toBe("gateway failed token=*** api_key='***'");
  });
});
