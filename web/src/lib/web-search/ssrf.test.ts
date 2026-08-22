import { describe, it, expect } from "vitest";
import { isSafeUrl, hasSecretQueryParam, normalizeUrlForRequest } from "./ssrf.js";

describe("ssrf guards", () => {
  it("allows public https URLs", () => {
    expect(isSafeUrl("https://api.example.com/v1/search").ok).toBe(true);
  });

  it("allows localhost in dev mode", () => {
    expect(isSafeUrl("http://localhost:8080/search", true).ok).toBe(true);
  });

  it("blocks private IP literals", () => {
    expect(isSafeUrl("https://192.168.1.1/secret").ok).toBe(false);
    expect(isSafeUrl("https://10.0.0.1/secret").ok).toBe(false);
  });

  it("blocks non-http schemes", () => {
    expect(isSafeUrl("file:///etc/passwd").ok).toBe(false);
  });

  it("blocks URLs with sensitive query params", () => {
    expect(hasSecretQueryParam("https://x.com/?api_key=secret")).toBe(true);
    expect(hasSecretQueryParam("https://x.com/?token=abc")).toBe(true);
    expect(hasSecretQueryParam("https://x.com/?q=hello")).toBe(false);
  });

  it("normalizes URLs by stripping fragments", () => {
    expect(normalizeUrlForRequest("https://example.com/page#section")).toBe("https://example.com/page");
  });
});