import { describe, expect, it } from "vitest";
import { AnthropicAdapter, createAnthropicAdapter } from "./anthropic.js";
import { ProviderError, isRecoverableError } from "../errors.js";
import type { LLMChatParams } from "../types.js";

function minimalParams(): LLMChatParams {
  return { messages: [], tools: [], signal: new AbortController().signal };
}

/** Private-field peek used only to verify constructor normalization. */
function internals(adapter: AnthropicAdapter): {
  baseUrl: string;
  apiKey?: string;
  thinkingBudget?: number;
  adaptiveEffort?: "low" | "medium" | "high";
} {
  return adapter as unknown as {
    baseUrl: string;
    apiKey?: string;
    thinkingBudget?: number;
    adaptiveEffort?: "low" | "medium" | "high";
  };
}

describe("AnthropicAdapter constructor", () => {
  it("exposes modelName and systemPrompt", () => {
    const adapter = new AnthropicAdapter({
      model: "claude-3-5-sonnet",
      systemPrompt: "You are helpful.",
    });
    expect(adapter.modelName).toBe("claude-3-5-sonnet");
    expect(adapter.systemPrompt).toBe("You are helpful.");
  });

  it("defaults baseUrl to the Anthropic API endpoint", () => {
    expect(internals(new AnthropicAdapter({ model: "claude-3" })).baseUrl).toBe(
      "https://api.anthropic.com",
    );
  });

  it("strips a trailing slash from baseUrl", () => {
    expect(internals(new AnthropicAdapter({ model: "claude-3", baseUrl: "https://proxy.example.com/" })).baseUrl).toBe(
      "https://proxy.example.com",
    );
  });

  it("keeps a baseUrl without a trailing slash unchanged", () => {
    expect(internals(new AnthropicAdapter({ model: "claude-3", baseUrl: "https://proxy.example.com" })).baseUrl).toBe(
      "https://proxy.example.com",
    );
  });

  it("stores apiKey, thinkingBudget and adaptiveEffort", () => {
    const adapter = new AnthropicAdapter({
      model: "claude-3",
      apiKey: "sk-ant-test",
      thinkingBudget: 1024,
      adaptiveEffort: "high",
    });
    const opts = internals(adapter);
    expect(opts.apiKey).toBe("sk-ant-test");
    expect(opts.thinkingBudget).toBe(1024);
    expect(opts.adaptiveEffort).toBe("high");
  });

  it("leaves optional options undefined when omitted", () => {
    const opts = internals(new AnthropicAdapter({ model: "claude-3" }));
    expect(opts.apiKey).toBeUndefined();
    expect(opts.thinkingBudget).toBeUndefined();
    expect(opts.adaptiveEffort).toBeUndefined();
  });

  it("supports every adaptive effort level", () => {
    for (const level of ["low", "medium", "high"] as const) {
      const adapter = new AnthropicAdapter({ model: "claude-3", adaptiveEffort: level });
      expect(internals(adapter).adaptiveEffort).toBe(level);
    }
  });
});

describe("AnthropicAdapter.chat", () => {
  it("rejects with a ProviderError naming the provider", async () => {
    const adapter = new AnthropicAdapter({ model: "claude-3-5-sonnet" });
    await expect(adapter.chat(minimalParams())).rejects.toSatisfy((error: unknown) => {
      return error instanceof ProviderError && error.provider === "anthropic";
    });
  });

  it("rejects with the provider_error code and model in the message", async () => {
    const adapter = new AnthropicAdapter({ model: "claude-3-5-sonnet" });
    try {
      await adapter.chat(minimalParams());
      expect.unreachable("chat should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderError);
      const providerError = error as ProviderError;
      expect(providerError.name).toBe("ProviderError");
      expect(providerError.code).toBe("provider_error");
      expect(providerError.message).toContain("claude-3-5-sonnet");
      expect(providerError.message).toContain("not implemented");
    }
  });

  it("is treated as recoverable when no status code is set (transient semantics)", async () => {
    const adapter = new AnthropicAdapter({ model: "claude-3" });
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

describe("createAnthropicAdapter", () => {
  it("creates an adapter from positional arguments", () => {
    const adapter = createAnthropicAdapter("claude-3", "sk-ant-test", "https://proxy.example.com/");
    expect(adapter).toBeInstanceOf(AnthropicAdapter);
    expect(adapter.modelName).toBe("claude-3");
    expect(internals(adapter).baseUrl).toBe("https://proxy.example.com");
    expect(internals(adapter).apiKey).toBe("sk-ant-test");
  });

  it("works without apiKey or baseUrl", () => {
    const adapter = createAnthropicAdapter("claude-3");
    expect(internals(adapter).baseUrl).toBe("https://api.anthropic.com");
    expect(internals(adapter).apiKey).toBeUndefined();
  });
});
