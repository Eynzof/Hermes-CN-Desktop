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
  it("rejects with a ProviderError naming the provider on a non-ok response", async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ error: { message: "bad" } }), {
        status: 401,
        statusText: "Unauthorized",
        headers: { "Content-Type": "application/json" },
      });
    const adapter = new AnthropicAdapter({
      model: "claude-3-5-sonnet",
      apiKey: "sk-ant-test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(adapter.chat(minimalParams())).rejects.toSatisfy((error: unknown) => {
      return error instanceof ProviderError && error.provider === "anthropic";
    });
  });

  it("rejects with the provider_error code and a non-recoverable 401 status", async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ error: { message: "bad" } }), {
        status: 401,
        statusText: "Unauthorized",
        headers: { "Content-Type": "application/json" },
      });
    const adapter = new AnthropicAdapter({
      model: "claude-3-5-sonnet",
      apiKey: "sk-ant-test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    try {
      await adapter.chat(minimalParams());
      expect.unreachable("chat should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderError);
      const providerError = error as ProviderError;
      expect(providerError.name).toBe("ProviderError");
      expect(providerError.code).toBe("provider_error");
      expect(providerError.message).toContain("Anthropic");
      expect(providerError.statusCode).toBe(401);
    }
  });

  it("is treated as recoverable on a 500 server error", async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ error: { message: "boom" } }), {
        status: 500,
        statusText: "Internal Server Error",
        headers: { "Content-Type": "application/json" },
      });
    const adapter = new AnthropicAdapter({
      model: "claude-3",
      apiKey: "sk-ant-test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    try {
      await adapter.chat(minimalParams());
      expect.unreachable("chat should have thrown");
    } catch (error) {
      // ProviderError: recoverable = statusCode === undefined || >= 500 || 429
      expect((error as ProviderError).statusCode).toBe(500);
      expect((error as ProviderError).recoverable).toBe(true);
      expect(isRecoverableError(error)).toBe(true);
    }
  });

  it("emits adaptive thinking for Claude 4.6+ when reasoning is enabled", async () => {
    let capturedBody: Record<string, unknown> = {};
    const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = JSON.parse((init?.body as string) ?? "{}");
      return new Response(
        JSON.stringify({
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "claude-opus-4-6",
          content: [
            { type: "thinking", thinking: "Plan", signature: "sig" },
            { type: "text", text: "42" },
          ],
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 20 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };
    const adapter = new AnthropicAdapter({
      model: "claude-opus-4-6",
      apiKey: "sk-ant-test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      reasoningConfig: { enabled: true, effort: "high" },
    });
    const res = await adapter.chat(minimalParams());
    expect(capturedBody.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(capturedBody.output_config).toEqual({ effort: "high" });
    expect(res.reasoning).toBe("Plan");
    expect(res.text).toBe("42");
  });

  it("emits manual thinking for legacy Claude when reasoning is enabled", async () => {
    let capturedBody: Record<string, unknown> = {};
    const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = JSON.parse((init?.body as string) ?? "{}");
      return new Response(
        JSON.stringify({
          content: [
            { type: "thinking", thinking: "Step", signature: "sig" },
            { type: "text", text: "ok" },
          ],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 2 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };
    const adapter = new AnthropicAdapter({
      model: "claude-3-7-sonnet-20250219",
      apiKey: "sk-ant-test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      reasoningConfig: { enabled: true, effort: "high" },
    });
    const res = await adapter.chat(minimalParams());
    expect(capturedBody.thinking).toEqual({ type: "enabled", budget_tokens: expect.any(Number) });
    expect(capturedBody.temperature).toBe(1);
    expect(res.reasoning).toBe("Step");
    expect(res.text).toBe("ok");
  });

  it("omits the thinking parameter when reasoning is disabled", async () => {
    let capturedBody: Record<string, unknown> = {};
    const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = JSON.parse((init?.body as string) ?? "{}");
      return new Response(
        JSON.stringify({
          content: [{ type: "text", text: "hi" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };
    const adapter = new AnthropicAdapter({
      model: "claude-opus-4-6",
      apiKey: "sk-ant-test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      reasoningConfig: { enabled: false },
    });
    await adapter.chat(minimalParams());
    expect("thinking" in capturedBody).toBe(false);
    expect("output_config" in capturedBody).toBe(false);
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
