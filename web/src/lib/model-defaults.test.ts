import { describe, expect, it } from "vitest";
import {
  DEFAULT_LOCAL_MAX_TOKENS,
  resolveModelDefaults,
  resolveModelMaxTokens,
  tokenizeModelName,
} from "./model-defaults";

describe("tokenizeModelName", () => {
  it("splits on separators and lowercases", () => {
    expect(tokenizeModelName("gpt-5.5")).toEqual(["gpt", "5", "5"]);
    expect(tokenizeModelName("Claude Sonnet 4.6")).toEqual(["claude", "sonnet", "4", "6"]);
    expect(tokenizeModelName("deepseek-v4-flash")).toEqual(["deepseek", "v4", "flash"]);
  });
});

describe("resolveModelDefaults", () => {
  it("resolves known models to their (context, max_tokens) defaults", () => {
    expect(resolveModelDefaults("gpt-5.5")).toEqual({ maxContextSize: 1_050_000, maxTokens: 128_000 });
    expect(resolveModelDefaults("gpt-5.4-mini")).toEqual({ maxContextSize: 1_000_000, maxTokens: 65_536 });
    expect(resolveModelDefaults("claude-sonnet-4.6")).toEqual({ maxContextSize: 1_000_000, maxTokens: 64_000 });
    expect(resolveModelDefaults("deepseek-v4-flash")).toEqual({ maxContextSize: 1_000_000, maxTokens: 384_000 });
    expect(resolveModelDefaults("claude-haiku-4.5")).toEqual({ maxContextSize: 200_000, maxTokens: 64_000 });
  });

  it("returns maxTokens null for models without an explicit output budget", () => {
    expect(resolveModelDefaults("grok-3")).toEqual({ maxContextSize: 2_000_000, maxTokens: null });
    expect(resolveModelDefaults("supergrok-heavy")).toEqual({ maxContextSize: 2_000_000, maxTokens: null });
  });

  it("returns null for unknown models", () => {
    expect(resolveModelDefaults("unknown-model")).toBeNull();
    // Version numbers must match exactly: gpt-5 is not gpt-5.4 / gpt-5.5 / gpt-5.6.
    expect(resolveModelDefaults("gpt-5")).toBeNull();
  });

  it("fuzzy-matches alphabetic keyword typos but keeps version numbers exact", () => {
    // "sonet" typo still resolves to the claude-sonnet-4.6 entry.
    expect(resolveModelDefaults("claude-sonet-4.6")).toEqual({
      maxContextSize: 1_000_000,
      maxTokens: 64_000,
    });
    // A missing version token must not match.
    expect(resolveModelDefaults("claude-sonnet")).toBeNull();
  });
});

describe("resolveModelMaxTokens", () => {
  it("uses the model's explicit max_output budget when known", () => {
    expect(resolveModelMaxTokens("gpt-5.5")).toBe(128_000);
    expect(resolveModelMaxTokens("deepseek-v4-flash")).toBe(384_000);
    expect(resolveModelMaxTokens("claude-sonnet-4.6")).toBe(64_000);
  });

  it("falls back to max_context_size // 4 when the model has no explicit budget", () => {
    expect(resolveModelMaxTokens("grok-3")).toBe(2_000_000 / 4);
    expect(resolveModelMaxTokens("supergrok-heavy")).toBe(2_000_000 / 4);
  });

  it("falls back to configured context_length // 4 for unknown models", () => {
    expect(resolveModelMaxTokens("kimi-k3", 64_000)).toBe(16_000);
    expect(resolveModelMaxTokens("qwen3-coder-plus", 200_000)).toBe(50_000);
  });

  it("falls back to DEFAULT_LOCAL_MAX_TOKENS for unknown models without context", () => {
    expect(resolveModelMaxTokens("kimi-k3")).toBe(DEFAULT_LOCAL_MAX_TOKENS);
    expect(resolveModelMaxTokens("kimi-k3", null)).toBe(DEFAULT_LOCAL_MAX_TOKENS);
    expect(resolveModelMaxTokens("kimi-k3", 0)).toBe(DEFAULT_LOCAL_MAX_TOKENS);
    expect(resolveModelMaxTokens("", 64_000)).toBe(16_000);
  });
});
