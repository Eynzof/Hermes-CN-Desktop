import { describe, expect, it } from "vitest";
import {
  evaluateUrlSafety,
  isAlwaysBlockedUrl,
  normalizeUrlForRequest,
  redactCdpUrl,
  assertSafeUrl,
} from "./ssrf.js";

describe("normalizeUrlForRequest", () => {
  it("normalizes and collapses path traversal", () => {
    expect(normalizeUrlForRequest("https://example.com/foo/../bar")).toBe("https://example.com/bar");
  });

  it("returns trimmed string for invalid url", () => {
    expect(normalizeUrlForRequest("not a url")).toBe("not a url");
  });

  it("returns empty for empty string", () => {
    expect(normalizeUrlForRequest("  ")).toBe("");
  });
});

describe("isAlwaysBlockedUrl", () => {
  it("blocks file scheme", () => {
    expect(isAlwaysBlockedUrl("file:///etc/passwd")).toBe(true);
  });

  it("blocks ftp scheme", () => {
    expect(isAlwaysBlockedUrl("ftp://example.com")).toBe(true);
  });

  it("blocks metadata endpoint", () => {
    expect(isAlwaysBlockedUrl("http://169.254.169.254/latest/meta-data/")).toBe(true);
  });

  it("allows public http", () => {
    expect(isAlwaysBlockedUrl("https://example.com")).toBe(false);
  });
});

describe("evaluateUrlSafety", () => {
  it("allows public https", () => {
    const result = evaluateUrlSafety("https://example.com/path?query=1");
    expect(result.safe).toBe(true);
    expect(result.normalizedUrl).toBe("https://example.com/path?query=1");
  });

  it("blocks file URLs", () => {
    const result = evaluateUrlSafety("file:///etc/passwd");
    expect(result.safe).toBe(false);
    expect(result.reason).toContain("always-blocked");
  });

  it("blocks localhost by default", () => {
    const result = evaluateUrlSafety("http://localhost:8080/");
    expect(result.safe).toBe(false);
    expect(result.reason).toContain("private/loopback");
  });

  it("blocks 127.0.0.1 by default", () => {
    expect(evaluateUrlSafety("http://127.0.0.1/").safe).toBe(false);
  });

  it("blocks ::1 by default", () => {
    expect(evaluateUrlSafety("http://[::1]:3000/").safe).toBe(false);
  });

  it("blocks 10.x.x.x", () => {
    expect(evaluateUrlSafety("http://10.0.0.1/").safe).toBe(false);
  });

  it("blocks 192.168.x.x", () => {
    expect(evaluateUrlSafety("http://192.168.1.1/").safe).toBe(false);
  });

  it("blocks 172.16-31.x.x", () => {
    expect(evaluateUrlSafety("http://172.16.0.1/").safe).toBe(false);
    expect(evaluateUrlSafety("http://172.31.255.255/").safe).toBe(false);
    expect(evaluateUrlSafety("http://172.15.0.1/").safe).toBe(true);
  });

  it("blocks .local suffix", () => {
    expect(evaluateUrlSafety("http://printer.local/").safe).toBe(false);
  });

  it("allows private URLs when opted in", () => {
    const result = evaluateUrlSafety("http://localhost:8080/", { allowPrivateUrls: true });
    expect(result.safe).toBe(true);
  });

  it("respects allowedHosts whitelist", () => {
    const result = evaluateUrlSafety("http://localhost:8080/", { allowedHosts: ["localhost"] });
    expect(result.safe).toBe(true);
  });

  it("rejects non-http schemes", () => {
    const result = evaluateUrlSafety("javascript:alert(1)");
    expect(result.safe).toBe(false);
    expect(result.reason).toContain("scheme");
  });
});

describe("assertSafeUrl", () => {
  it("returns normalized URL for safe input", () => {
    expect(assertSafeUrl("https://example.com")).toBe("https://example.com/");
  });

  it("throws for unsafe input", () => {
    expect(() => assertSafeUrl("file:///etc/passwd")).toThrow("Unsafe URL");
  });
});

describe("redactCdpUrl", () => {
  it("redacts browserbase token in path", () => {
    const redacted = redactCdpUrl("wss://api.browserbase.com/v1/sessions/abc-123?token=secret");
    expect(redacted).not.toContain("abc-123");
    expect(redacted).not.toContain("secret");
    expect(redacted).not.toContain("%3Credacted%3E");
  });

  it("returns placeholder for non-URL", () => {
    expect(redactCdpUrl("not a url")).toBe("<redacted-cdp-url>");
  });
});
