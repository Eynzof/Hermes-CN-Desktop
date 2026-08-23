import { describe, expect, it } from "vitest";
import { OpenAIResponsesAdapter, createOpenAIResponsesAdapter } from "./openai-responses.js";
import { ProviderError, isRecoverableError } from "../errors.js";
import type { LLMChatParams } from "../types.js";

function minimalParams(): LLMChatParams {
  return { messages: [], tools: [], signal: new AbortController().signal };
}

function internals(adapter: OpenAIResponsesAdapter): { baseUrl: string; apiKey?: string } {
  return adapter as unknown as { baseUrl: string; apiKey?: string };
}

describe("OpenAIResponsesAdapter constructor", () => {
  it("exposes modelName and systemPrompt", () => {
    const adapter = new OpenAIResponsesAdapter({
      model: "o3-mini",
      systemPrompt: "Reply in Chinese.",
    });
    expect(adapter.modelName).toBe("o3-mini");
    expect(adapter.systemPrompt).toBe("Reply in Chinese.");
  });

  it("defaults baseUrl to the OpenAI API endpoint", () => {
    expect(internals(new OpenAIResponsesAdapter({ model: "o3-mini" })).baseUrl).toBe("https://api.openai.com");
  });

  it("strips a trailing slash from baseUrl", () => {
    expect(
      internals(new OpenAIResponsesAdapter({ model: "o3-mini", baseUrl: "https://openai-proxy.example.com/" })).baseUrl,
    ).toBe("https://openai-proxy.example.com");
  });

  it("stores apiKey when provided", () => {
    expect(internals(new OpenAIResponsesAdapter({ model: "o3-mini", apiKey: "sk-test" })).apiKey).toBe("sk-test");
    expect(internals(new OpenAIResponsesAdapter({ model: "o3-mini" })).apiKey).toBeUndefined();
  });
});

describe("OpenAIResponsesAdapter.chat", () => {
  it("rejects with ProviderError naming the openai-responses provider", async () => {
    const adapter = new OpenAIResponsesAdapter({ model: "o3-mini" });
    await expect(adapter.chat(minimalParams())).rejects.toSatisfy((error: unknown) => {
      return error instanceof ProviderError && error.provider === "openai-responses";
    });
  });

  it("rejects with the model in the message and code provider_error", async () => {
    const adapter = new OpenAIResponsesAdapter({ model: "gpt-5" });
    try {
      await adapter.chat(minimalParams());
      expect.unreachable("chat should have thrown");
    } catch (error) {
      const providerError = error as ProviderError;
      expect(providerError.code).toBe("provider_error");
      expect(providerError.message).toContain("gpt-5");
      expect(providerError.message).toContain("not implemented");
    }
  });

  it("is treated as recoverable when no status code is set (transient semantics)", async () => {
    const adapter = new OpenAIResponsesAdapter({ model: "o3-mini" });
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

describe("createOpenAIResponsesAdapter", () => {
  it("creates an adapter from positional arguments", () => {
    const adapter = createOpenAIResponsesAdapter("o3-mini", "sk-test", "https://openai-proxy.example.com/");
    expect(adapter).toBeInstanceOf(OpenAIResponsesAdapter);
    expect(adapter.modelName).toBe("o3-mini");
    expect(internals(adapter).baseUrl).toBe("https://openai-proxy.example.com");
    expect(internals(adapter).apiKey).toBe("sk-test");
  });

  it("works without apiKey or baseUrl", () => {
    const adapter = createOpenAIResponsesAdapter("o3-mini");
    expect(internals(adapter).baseUrl).toBe("https://api.openai.com");
    expect(internals(adapter).apiKey).toBeUndefined();
  });
});
