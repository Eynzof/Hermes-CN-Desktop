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
  it("rejects with ProviderError naming the openai-responses provider on a non-ok response", async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ error: { message: "bad" } }), {
        status: 401,
        statusText: "Unauthorized",
        headers: { "Content-Type": "application/json" },
      });
    const adapter = new OpenAIResponsesAdapter({
      model: "o3-mini",
      apiKey: "sk-test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(adapter.chat(minimalParams())).rejects.toSatisfy((error: unknown) => {
      return error instanceof ProviderError && error.provider === "openai-responses";
    });
  });

  it("rejects with the provider_error code and a non-recoverable 401 status", async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ error: { message: "bad" } }), {
        status: 401,
        statusText: "Unauthorized",
        headers: { "Content-Type": "application/json" },
      });
    const adapter = new OpenAIResponsesAdapter({
      model: "gpt-5",
      apiKey: "sk-test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    try {
      await adapter.chat(minimalParams());
      expect.unreachable("chat should have thrown");
    } catch (error) {
      const providerError = error as ProviderError;
      expect(providerError.code).toBe("provider_error");
      expect(providerError.message).toContain("Responses");
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
    const adapter = new OpenAIResponsesAdapter({
      model: "o3-mini",
      apiKey: "sk-test",
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

  it("sends reasoning effort and parses reasoning + message output items", async () => {
    let capturedBody: Record<string, unknown> = {};
    const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = JSON.parse((init?.body as string) ?? "{}");
      return new Response(
        JSON.stringify({
          id: "resp_1",
          status: "completed",
          model: "deepseek-v4-flash",
          output: [
            {
              type: "reasoning",
              id: "r1",
              content: [{ type: "reasoning_text", text: "Reasoning step" }],
              summary: [],
              encrypted_content: "enc-1",
            },
            {
              type: "message",
              id: "m1",
              content: [{ type: "output_text", text: "9" }],
              status: "completed",
            },
          ],
          usage: { input_tokens: 5, output_tokens: 10, total_tokens: 15 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };
    const adapter = new OpenAIResponsesAdapter({
      model: "deepseek-v4-flash",
      apiKey: "sk-test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      reasoningConfig: { enabled: true, effort: "medium" },
    });
    const res = await adapter.chat({
      messages: [{ role: "user", content: "What is 3*3? Think, then answer." }],
      tools: [],
      signal: new AbortController().signal,
    });
    expect(capturedBody.reasoning).toEqual({ effort: "medium", summary: "auto" });
    expect(capturedBody.store).toBe(false);
    expect(res.reasoning).toBe("Reasoning step");
    expect(res.text).toBe("9");
    expect(res.usage.total).toBe(15);
  });

  it("omits the reasoning kwarg when reasoning is disabled", async () => {
    let capturedBody: Record<string, unknown> = {};
    const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = JSON.parse((init?.body as string) ?? "{}");
      return new Response(
        JSON.stringify({
          status: "completed",
          output: [
            { type: "message", content: [{ type: "output_text", text: "hi" }] },
          ],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };
    const adapter = new OpenAIResponsesAdapter({
      model: "deepseek-v4-flash",
      apiKey: "sk-test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      reasoningConfig: { enabled: false },
    });
    await adapter.chat(minimalParams());
    expect("reasoning" in capturedBody).toBe(false);
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
