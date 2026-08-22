/** @vitest-environment node */
import { describe, expect, it } from "vitest";
import { apiKeyRequired, assertApiKey } from "./api-key-guard";

describe("apiKeyRequired", () => {
  it("is false for a non-empty string key", () => {
    expect(apiKeyRequired("openrouter", "sk-xxx")).toBe(false);
  });

  it("is false for a callable token", () => {
    expect(apiKeyRequired("azure-foundry", () => "bearer")).toBe(false);
  });

  it("is false for literal aws-sdk", () => {
    expect(apiKeyRequired("openrouter", "aws-sdk")).toBe(false);
  });

  it("is false for literal no-key-required", () => {
    expect(apiKeyRequired("openrouter", "no-key-required")).toBe(false);
  });

  it("is false for bedrock provider", () => {
    expect(apiKeyRequired("bedrock", "")).toBe(false);
  });

  it("is true for empty string", () => {
    expect(apiKeyRequired("openrouter", "")).toBe(true);
  });

  it("is true for null", () => {
    expect(apiKeyRequired("openrouter", null)).toBe(true);
  });

  it("is true for undefined", () => {
    expect(apiKeyRequired("openrouter", undefined)).toBe(true);
  });

  it("treats whitespace-only key as empty", () => {
    expect(apiKeyRequired("openrouter", "   ")).toBe(true);
  });
});

describe("assertApiKey", () => {
  it("throws when key is required but missing", () => {
    expect(() => assertApiKey("openrouter", "")).toThrow(
      "no API key (param empty, env vars unset)",
    );
  });

  it("does not throw when key is present", () => {
    expect(() => assertApiKey("openrouter", "sk-xxx")).not.toThrow();
  });
});
