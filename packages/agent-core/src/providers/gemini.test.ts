import { describe, expect, it } from "vitest";
import { GeminiAdapter, createGeminiAdapter } from "./gemini.js";
import { ProviderError, isRecoverableError } from "../errors.js";
import type { LLMChatParams } from "../types.js";

function minimalParams(): LLMChatParams {
  return { messages: [], tools: [], signal: new AbortController().signal };
}

function internals(adapter: GeminiAdapter): { baseUrl: string; apiKey?: string } {
  return adapter as unknown as { baseUrl: string; apiKey?: string };
}

describe("GeminiAdapter constructor", () => {
  it("exposes modelName and systemPrompt", () => {
    const adapter = new GeminiAdapter({
      model: "gemini-1.5-pro",
      systemPrompt: "You are a helpful assistant.",
    });
    expect(adapter.modelName).toBe("gemini-1.5-pro");
    expect(adapter.systemPrompt).toBe("You are a helpful assistant.");
  });

  it("defaults baseUrl to the Google GenAI endpoint", () => {
    expect(internals(new GeminiAdapter({ model: "gemini-1.5-pro" })).baseUrl).toBe(
      "https://generativelanguage.googleapis.com",
    );
  });

  it("strips a trailing slash from baseUrl", () => {
    expect(
      internals(new GeminiAdapter({ model: "gemini-1.5-pro", baseUrl: "https://genai.example.com/" })).baseUrl,
    ).toBe("https://genai.example.com");
  });

  it("stores apiKey when provided", () => {
    expect(internals(new GeminiAdapter({ model: "gemini-1.5-pro", apiKey: "g-key" })).apiKey).toBe("g-key");
    expect(internals(new GeminiAdapter({ model: "gemini-1.5-pro" })).apiKey).toBeUndefined();
  });
});

describe("GeminiAdapter.chat", () => {
  it("rejects with ProviderError naming the gemini provider", async () => {
    const adapter = new GeminiAdapter({ model: "gemini-1.5-pro" });
    await expect(adapter.chat(minimalParams())).rejects.toSatisfy((error: unknown) => {
      return error instanceof ProviderError && error.provider === "gemini";
    });
  });

  it("rejects with the model in the message and code provider_error", async () => {
    const adapter = new GeminiAdapter({ model: "gemini-1.5-flash" });
    try {
      await adapter.chat(minimalParams());
      expect.unreachable("chat should have thrown");
    } catch (error) {
      const providerError = error as ProviderError;
      expect(providerError.code).toBe("provider_error");
      expect(providerError.message).toContain("gemini-1.5-flash");
      expect(providerError.message).toContain("not implemented");
    }
  });

  it("is treated as recoverable when no status code is set (transient semantics)", async () => {
    const adapter = new GeminiAdapter({ model: "gemini-1.5-pro" });
    try {
      await adapter.chat(minimalParams());
      expect.unreachable("chat should have thrown");
    } catch (error) {
      // ProviderError: recoverable = statusCode === undefined || >= 500 || 429
      expect((error as ProviderError).statusCode).toBeUndefined();
      expect((error as ProviderError).recoverable).toBe(true);
      expect(isRecoverableError(error)).toBe(true);
    }
  });
});

describe("createGeminiAdapter", () => {
  it("creates an adapter from positional arguments", () => {
    const adapter = createGeminiAdapter("gemini-1.5-pro", "g-key", "https://genai.example.com/");
    expect(adapter).toBeInstanceOf(GeminiAdapter);
    expect(adapter.modelName).toBe("gemini-1.5-pro");
    expect(internals(adapter).baseUrl).toBe("https://genai.example.com");
    expect(internals(adapter).apiKey).toBe("g-key");
  });

  it("works without apiKey or baseUrl", () => {
    const adapter = createGeminiAdapter("gemini-1.5-pro");
    expect(internals(adapter).baseUrl).toBe("https://generativelanguage.googleapis.com");
    expect(internals(adapter).apiKey).toBeUndefined();
  });
});
