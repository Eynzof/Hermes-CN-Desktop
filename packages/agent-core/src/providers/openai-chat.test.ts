import { describe, expect, it, vi } from "vitest";
import { OpenAIChatAdapter, createOpenAIChatAdapter } from "./openai-chat.js";
import { ProviderError, isRecoverableError } from "../errors.js";
import type {
  LLMChatParams,
  Message,
  ReasoningConfig,
  Tool,
} from "../types.js";

function minimalParams(): LLMChatParams {
  return { messages: [], tools: [], signal: new AbortController().signal };
}

function tool(overrides: Partial<Tool> = {}): Tool {
  return {
    name: "get_weather",
    description: "Get weather for a city",
    parameters: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
    execute: async () => ({ content: "sunny" }),
    ...overrides,
  };
}

/** Private-field peek used only to verify constructor normalization. */
function internals(adapter: OpenAIChatAdapter): {
  baseUrl: string;
  apiKey?: string;
  systemPrompt?: string;
  fetchImpl: typeof fetch;
  reasoningConfig?: ReasoningConfig;
} {
  return adapter as unknown as {
    baseUrl: string;
    apiKey?: string;
    systemPrompt?: string;
    fetchImpl: typeof fetch;
    reasoningConfig?: ReasoningConfig;
  };
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function sseResponse(...chunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

describe("OpenAIChatAdapter constructor", () => {
  it("exposes modelName and systemPrompt", () => {
    const adapter = new OpenAIChatAdapter({
      model: "deepseek-v4-flash",
      systemPrompt: "Reply in Chinese.",
    });
    expect(adapter.modelName).toBe("deepseek-v4-flash");
    expect(adapter.systemPrompt).toBe("Reply in Chinese.");
  });

  it("defaults baseUrl to the OpenAI API endpoint", () => {
    expect(internals(new OpenAIChatAdapter({ model: "gpt-4o" })).baseUrl).toBe(
      "https://api.openai.com",
    );
  });

  it("strips a trailing slash from baseUrl", () => {
    expect(
      internals(
        new OpenAIChatAdapter({
          model: "gpt-4o",
          baseUrl: "https://openai-proxy.example.com/",
        }),
      ).baseUrl,
    ).toBe("https://openai-proxy.example.com");
  });

  it("keeps a baseUrl without a trailing slash unchanged", () => {
    expect(
      internals(
        new OpenAIChatAdapter({ model: "gpt-4o", baseUrl: "https://openai-proxy.example.com" }),
      ).baseUrl,
    ).toBe("https://openai-proxy.example.com");
  });

  it("stores apiKey, fetchImpl and reasoningConfig", () => {
    const fetchImpl = (async () => jsonResponse({ choices: [] })) as unknown as typeof fetch;
    const reasoningConfig: ReasoningConfig = { enabled: true, effort: "high" };
    const adapter = new OpenAIChatAdapter({
      model: "gpt-4o",
      apiKey: "sk-test",
      fetchImpl,
      reasoningConfig,
    });
    const opts = internals(adapter);
    expect(opts.apiKey).toBe("sk-test");
    expect(opts.fetchImpl).toBe(fetchImpl);
    expect(opts.reasoningConfig).toBe(reasoningConfig);
  });

  it("defaults fetchImpl to global fetch and leaves optional fields undefined", () => {
    const opts = internals(new OpenAIChatAdapter({ model: "gpt-4o" }));
    expect(opts.apiKey).toBeUndefined();
    expect(opts.systemPrompt).toBeUndefined();
    expect(opts.reasoningConfig).toBeUndefined();
    expect(opts.fetchImpl).toBe(fetch);
  });
});

describe("OpenAIChatAdapter.chat — request shape (non-streaming)", () => {
  async function runWithBody(params: Partial<LLMChatParams> = {}) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      return jsonResponse({
        choices: [{ message: { role: "assistant", content: "Hi" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
      });
    };
    const adapter = new OpenAIChatAdapter({
      model: "gpt-4o",
      apiKey: "sk-test",
      systemPrompt: "Reply in Chinese.",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const res = await adapter.chat({ ...minimalParams(), ...params });
    return { calls, res, body: JSON.parse(calls[0]?.init.body as string) as Record<string, unknown> };
  }

  it("POSTs to /v1/chat/completions with model, messages and stream=false", async () => {
    const { calls, body } = await runWithBody();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(calls[0]?.init.method).toBe("POST");
    expect(body.model).toBe("gpt-4o");
    expect(body.stream).toBe(false);
  });

  it("sets Content-Type and Authorization headers when an apiKey is present", async () => {
    const { calls } = await runWithBody();
    const headers = calls[0]?.init.headers as Headers;
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("Authorization")).toBe("Bearer sk-test");
  });

  it("omits the Authorization header when no apiKey is configured", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(_input), init: init ?? {} });
      return jsonResponse({ choices: [] });
    };
    const adapter = new OpenAIChatAdapter({
      model: "gpt-4o",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await adapter.chat(minimalParams());
    expect((calls[0]?.init.headers as Headers).has("Authorization")).toBe(false);
  });

  it("passes the abort signal through to fetch", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      return jsonResponse({ choices: [] });
    };
    const adapter = new OpenAIChatAdapter({
      model: "gpt-4o",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const signal = new AbortController().signal;
    await adapter.chat({ ...minimalParams(), signal });
    expect(calls[0]?.init.signal).toBe(signal);
  });

  it("prepends the system prompt and maps every message role (buildOpenAIMessages)", async () => {
    const messages: Message[] = [
      { role: "system", content: "Be concise." },
      { role: "user", content: "Hello" },
      {
        role: "assistant",
        content: "Previous answer",
        reasoningContent: "Previous thinking",
        toolCalls: [{ id: "call_9", name: "get_time", arguments: { tz: "UTC" } }],
      },
      { role: "tool", content: "12:00", toolCallId: "call_9" },
    ];
    const { body } = await runWithBody({ messages });
    expect(body.messages).toEqual([
      { role: "system", content: "Reply in Chinese." },
      { role: "system", content: "Be concise." },
      { role: "user", content: "Hello" },
      {
        role: "assistant",
        content: "Previous answer",
        reasoning_content: "Previous thinking",
        tool_calls: [
          {
            id: "call_9",
            type: "function",
            function: { name: "get_time", arguments: JSON.stringify({ tz: "UTC" }) },
          },
        ],
      },
      { role: "tool", content: "12:00", tool_call_id: "call_9" },
    ]);
  });

  it("falls back to message.reasoning when reasoningContent is absent (buildOpenAIMessages)", async () => {
    const messages: Message[] = [
      { role: "assistant", content: "Answer", reasoning: "Thought" },
    ];
    const { body } = await runWithBody({ messages });
    const assistant = (body.messages as Array<Record<string, unknown>>)[1];
    expect(assistant?.reasoning_content).toBe("Thought");
  });

  it("maps tools to OpenAI function definitions and sets tool_choice (toolToOpenAI)", async () => {
    const { body } = await runWithBody({
      tools: [
        tool(),
        tool({ name: "get_time", description: "Get current time", parameters: { type: "object" } }),
      ],
    });
    expect(body.tools).toEqual([
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get weather for a city",
          parameters: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
          },
        },
      },
      {
        type: "function",
        function: { name: "get_time", description: "Get current time", parameters: { type: "object" } },
      },
    ]);
    expect(body.tool_choice).toBe("auto");
  });

  it("omits tools and tool_choice when no tools are provided", async () => {
    const { body } = await runWithBody({ tools: [] });
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
  });

  it("sends reasoning_effort and enabled thinking for DeepSeek V4 (resolveReasoningEffort + buildThinkingExtraBody)", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      return jsonResponse({ choices: [] });
    };
    const adapter = new OpenAIChatAdapter({
      model: "deepseek-v4-flash",
      apiKey: "sk-test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      reasoningConfig: { enabled: true, effort: "high" },
    });
    await adapter.chat(minimalParams());
    const body = JSON.parse(calls[0]?.init.body as string) as Record<string, unknown>;
    expect(body.reasoning_effort).toBe("high");
    expect(body.extra_body).toEqual({ thinking: { type: "enabled" } });
  });

  it("defaults to medium effort when reasoning is enabled without an effort (resolveReasoningEffort)", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      return jsonResponse({ choices: [] });
    };
    const adapter = new OpenAIChatAdapter({
      model: "deepseek-v4-flash",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      reasoningConfig: { enabled: true },
    });
    await adapter.chat(minimalParams());
    const body = JSON.parse(calls[0]?.init.body as string) as Record<string, unknown>;
    expect(body.reasoning_effort).toBe("medium");
  });

  it("omits reasoning_effort when reasoning is disabled (resolveReasoningEffort)", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      return jsonResponse({ choices: [] });
    };
    const adapter = new OpenAIChatAdapter({
      model: "deepseek-v4-flash",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      reasoningConfig: { enabled: false },
    });
    await adapter.chat(minimalParams());
    const body = JSON.parse(calls[0]?.init.body as string) as Record<string, unknown>;
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.extra_body).toEqual({ thinking: { type: "disabled" } });
  });

  it("omits reasoning_effort when reasoningConfig.disabled is set (resolveReasoningEffort)", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      return jsonResponse({ choices: [] });
    };
    const adapter = new OpenAIChatAdapter({
      model: "deepseek-v4-flash",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      reasoningConfig: { disabled: true },
    });
    await adapter.chat(minimalParams());
    const body = JSON.parse(calls[0]?.init.body as string) as Record<string, unknown>;
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.extra_body).toEqual({ thinking: { type: "disabled" } });
  });

  it("maps an unknown effort (e.g. max) to medium — existing adapter contract (resolveReasoningEffort)", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      return jsonResponse({ choices: [] });
    };
    const adapter = new OpenAIChatAdapter({
      model: "deepseek-v4-flash",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      reasoningConfig: { enabled: true, effort: "max" } as unknown as ReasoningConfig,
    });
    await adapter.chat(minimalParams());
    const body = JSON.parse(calls[0]?.init.body as string) as Record<string, unknown>;
    expect(body.reasoning_effort).toBe("medium");
  });

  it("sends thinking disabled for DeepSeek models when no reasoningConfig is provided (buildThinkingExtraBody)", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      return jsonResponse({ choices: [] });
    };
    const adapter = new OpenAIChatAdapter({
      model: "deepseek-v4-flash",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await adapter.chat(minimalParams());
    const body = JSON.parse(calls[0]?.init.body as string) as Record<string, unknown>;
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.extra_body).toEqual({ thinking: { type: "disabled" } });
  });

  it("does not send extra_body or reasoning_effort for non-DeepSeek models (deepseekModelSupportsThinking)", async () => {
    for (const model of ["gpt-4o", "deepseek-v3", "deepseek-v3.1", "deepseek-chat", ""]) {
      const calls: Array<{ url: string; init: RequestInit }> = [];
      const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(input), init: init ?? {} });
        return jsonResponse({ choices: [] });
      };
      const adapter = new OpenAIChatAdapter({
        model,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        reasoningConfig: { enabled: true, effort: "medium" },
      });
      await adapter.chat(minimalParams());
      const body = JSON.parse(calls[0]?.init.body as string) as Record<string, unknown>;
      expect(body.extra_body, `model ${JSON.stringify(model)}`).toBeUndefined();
      expect(body.reasoning_effort, `model ${JSON.stringify(model)}`).toBe("medium");
    }
  });

  it("is case/whitespace-insensitive when detecting DeepSeek thinking models (deepseekModelSupportsThinking)", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      return jsonResponse({ choices: [] });
    };
    const adapter = new OpenAIChatAdapter({
      model: "  DEEPSEEK-V5-Preview ",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      reasoningConfig: { enabled: true },
    });
    await adapter.chat(minimalParams());
    const body = JSON.parse(calls[0]?.init.body as string) as Record<string, unknown>;
    expect(body.extra_body).toEqual({ thinking: { type: "enabled" } });
  });
});

describe("OpenAIChatAdapter.chat — response mapping (non-streaming)", () => {
  it("maps text, reasoning, tool calls and finish reason", async () => {
    const fetchImpl = async () =>
      jsonResponse({
        choices: [
          {
            message: {
              role: "assistant",
              content: "9",
              reasoning_content: "3*3 is 9",
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: {
                    name: "get_weather",
                    arguments: JSON.stringify({ city: "Shanghai" }),
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 },
      });
    const adapter = new OpenAIChatAdapter({
      model: "deepseek-v4-flash",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const res = await adapter.chat({
      messages: [{ role: "user", content: "Weather in Shanghai?" }],
      tools: [],
      signal: new AbortController().signal,
    });
    expect(res.text).toBe("9");
    expect(res.reasoning).toBe("3*3 is 9");
    expect(res.toolCalls).toEqual([
      {
        id: "call_1",
        name: "get_weather",
        argumentsJson: JSON.stringify({ city: "Shanghai" }),
        arguments: { city: "Shanghai" },
      },
    ]);
    expect(res.providerFinishReason).toBe("tool_calls");
    expect(res.usage).toEqual({
      input: 5,
      output: 10,
      total: 15,
      cacheRead: undefined,
      cacheWrite: undefined,
      reasoning: undefined,
    });
  });

  it("prefers reasoning_content over the plain reasoning field", async () => {
    const fetchImpl = async () =>
      jsonResponse({
        choices: [
          {
            message: { role: "assistant", content: "ok", reasoning_content: "RC", reasoning: "R" },
            finish_reason: "stop",
          },
        ],
      });
    const adapter = new OpenAIChatAdapter({
      model: "gpt-4o",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const res = await adapter.chat(minimalParams());
    expect(res.reasoning).toBe("RC");
  });

  it("normalizes every finish reason (normalizeFinishReason)", async () => {
    const cases: Array<{ wire: string | undefined; expected: string }> = [
      { wire: "stop", expected: "stop" },
      { wire: "length", expected: "length" },
      { wire: "tool_calls", expected: "tool_calls" },
      { wire: "content_filter", expected: "content_filter" },
      { wire: "function_call", expected: "unknown" },
      { wire: undefined, expected: "unknown" },
    ];
    for (const { wire, expected } of cases) {
      const fetchImpl = async () =>
        jsonResponse({
          choices: [{ message: { role: "assistant", content: "x" }, finish_reason: wire }],
        });
      const adapter = new OpenAIChatAdapter({
        model: "gpt-4o",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      const res = await adapter.chat(minimalParams());
      expect(res.providerFinishReason, `wire=${String(wire)}`).toBe(expected);
    }
  });

  it("builds usage including cache and reasoning tokens (buildUsage)", async () => {
    const fetchImpl = async () =>
      jsonResponse({
        choices: [{ message: { role: "assistant", content: "hi" } }],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 25,
          prompt_cache_read_tokens: 80,
          prompt_cache_write_tokens: 20,
          completion_tokens_details: { reasoning_tokens: 15 },
        },
      });
    const adapter = new OpenAIChatAdapter({
      model: "gpt-4o",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const res = await adapter.chat(minimalParams());
    expect(res.usage).toEqual({
      input: 100,
      output: 25,
      total: 125,
      cacheRead: 80,
      cacheWrite: 20,
      reasoning: 15,
    });
  });

  it("derives total from input+output when total_tokens is missing (buildUsage)", async () => {
    const fetchImpl = async () =>
      jsonResponse({
        choices: [{ message: { role: "assistant", content: "hi" } }],
        usage: { prompt_tokens: 7, completion_tokens: 3 },
      });
    const adapter = new OpenAIChatAdapter({
      model: "gpt-4o",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const res = await adapter.chat(minimalParams());
    expect(res.usage.total).toBe(10);
  });

  it("returns zero usage when usage is missing (buildUsage)", async () => {
    const fetchImpl = async () =>
      jsonResponse({ choices: [{ message: { role: "assistant", content: "hi" } }] });
    const adapter = new OpenAIChatAdapter({
      model: "gpt-4o",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const res = await adapter.chat(minimalParams());
    expect(res.usage).toEqual({ input: 0, output: 0, total: 0 });
  });

  it("parses tool call arguments robustly (parseJsonArguments)", async () => {
    const cases: Array<{ raw: string; expected: Record<string, unknown> }> = [
      { raw: JSON.stringify({ a: 1 }), expected: { a: 1 } },
      { raw: "123", expected: {} },
      { raw: "null", expected: {} },
      { raw: '"string"', expected: {} },
      { raw: "{not json", expected: {} },
      { raw: "", expected: {} },
    ];
    for (const { raw, expected } of cases) {
      const fetchImpl = async () =>
        jsonResponse({
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  { id: "call_x", type: "function", function: { name: "f", arguments: raw } },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        });
      const adapter = new OpenAIChatAdapter({
        model: "gpt-4o",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      const res = await adapter.chat(minimalParams());
      expect(res.toolCalls[0]?.arguments, `raw=${JSON.stringify(raw)}`).toEqual(expected);
    }
  });

  it("fires onTextDelta and onThinkDelta only for non-empty content", async () => {
    const fetchImpl = async () =>
      jsonResponse({
        choices: [
          {
            message: { role: "assistant", content: "answer", reasoning_content: "think" },
            finish_reason: "stop",
          },
        ],
      });
    const adapter = new OpenAIChatAdapter({
      model: "deepseek-v4-flash",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const onTextDelta = vi.fn();
    const onThinkDelta = vi.fn();
    await adapter.chat({ ...minimalParams(), onTextDelta, onThinkDelta });
    expect(onTextDelta).toHaveBeenCalledWith("answer");
    expect(onThinkDelta).toHaveBeenCalledWith("think");
  });

  it("does not fire deltas when text and reasoning are empty", async () => {
    const fetchImpl = async () =>
      jsonResponse({
        choices: [{ message: { role: "assistant", content: null }, finish_reason: "stop" }],
      });
    const adapter = new OpenAIChatAdapter({
      model: "gpt-4o",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const onTextDelta = vi.fn();
    const onThinkDelta = vi.fn();
    const res = await adapter.chat({ ...minimalParams(), onTextDelta, onThinkDelta });
    expect(res.text).toBe("");
    expect(res.reasoning).toBe("");
    expect(onTextDelta).not.toHaveBeenCalled();
    expect(onThinkDelta).not.toHaveBeenCalled();
  });

  it("handles an empty choices array gracefully", async () => {
    const fetchImpl = async () => jsonResponse({ choices: [] });
    const adapter = new OpenAIChatAdapter({
      model: "gpt-4o",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const res = await adapter.chat(minimalParams());
    expect(res.text).toBe("");
    expect(res.toolCalls).toEqual([]);
    expect(res.providerFinishReason).toBe("unknown");
    expect(res.usage).toEqual({ input: 0, output: 0, total: 0 });
  });
});

describe("OpenAIChatAdapter.chat — error handling", () => {
  it("rejects with a ProviderError naming the provider on a non-ok response", async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ error: { message: "bad" } }), {
        status: 401,
        statusText: "Unauthorized",
        headers: { "Content-Type": "application/json" },
      });
    const adapter = new OpenAIChatAdapter({
      model: "gpt-4o",
      apiKey: "sk-test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(adapter.chat(minimalParams())).rejects.toSatisfy((error: unknown) => {
      return error instanceof ProviderError && error.provider === "openai";
    });
  });

  it("rejects with the provider_error code and a non-recoverable 401 status", async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ error: { message: "bad" } }), {
        status: 401,
        statusText: "Unauthorized",
        headers: { "Content-Type": "application/json" },
      });
    const adapter = new OpenAIChatAdapter({
      model: "gpt-4o",
      apiKey: "sk-test",
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
      expect(providerError.message).toContain("OpenAI chat completion failed");
      expect(providerError.message).toContain("401");
      expect(providerError.statusCode).toBe(401);
      expect(providerError.recoverable).toBe(false);
      expect(isRecoverableError(error)).toBe(false);
    }
  });

  it("is treated as recoverable on a 500 server error", async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ error: { message: "boom" } }), {
        status: 500,
        statusText: "Internal Server Error",
        headers: { "Content-Type": "application/json" },
      });
    const adapter = new OpenAIChatAdapter({
      model: "gpt-4o",
      apiKey: "sk-test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    try {
      await adapter.chat(minimalParams());
      expect.unreachable("chat should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderError);
      const providerError = error as ProviderError;
      expect(providerError.statusCode).toBe(500);
      expect(providerError.recoverable).toBe(true);
      expect(isRecoverableError(error)).toBe(true);
    }
  });

  it("includes the response body text in the error message", async () => {
    const fetchImpl = async () =>
      new Response('{"error":"rate limited"}', {
        status: 429,
        statusText: "Too Many Requests",
        headers: { "Content-Type": "application/json" },
      });
    const adapter = new OpenAIChatAdapter({
      model: "gpt-4o",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(adapter.chat(minimalParams())).rejects.toMatchObject({
      message: expect.stringContaining('{"error":"rate limited"}'),
      statusCode: 429,
      recoverable: true,
    });
  });
});

describe("OpenAIChatAdapter.chat — streaming", () => {
  it("routes stream:true to the streaming path and aggregates text + reasoning deltas", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      return sseResponse(
        "data: " + JSON.stringify({ choices: [{ delta: { reasoning_content: "Think" } }] }) + "\n\n",
        "data: " + JSON.stringify({ choices: [{ delta: { content: "Hel" } }] }) + "\n\n",
        "data: " + JSON.stringify({ choices: [{ delta: { content: "lo" }, finish_reason: "stop" }] }) + "\n\n",
        "data: [DONE]\n\n",
      );
    };
    const adapter = new OpenAIChatAdapter({
      model: "deepseek-v4-flash",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const onTextDelta = vi.fn();
    const onThinkDelta = vi.fn();
    const res = await adapter.chat({ ...minimalParams(), stream: true, onTextDelta, onThinkDelta });
    const body = JSON.parse(calls[0]?.init.body as string) as Record<string, unknown>;
    expect(body.stream).toBe(true);
    expect(res.text).toBe("Hello");
    expect(res.reasoning).toBe("Think");
    expect(res.providerFinishReason).toBe("stop");
    expect(onTextDelta).toHaveBeenNthCalledWith(1, "Hel");
    expect(onTextDelta).toHaveBeenNthCalledWith(2, "lo");
    expect(onThinkDelta).toHaveBeenCalledWith("Think");
  });

  it("falls back to delta.reasoning when reasoning_content is absent", async () => {
    const fetchImpl = async () =>
      sseResponse(
        "data: " + JSON.stringify({ choices: [{ delta: { reasoning: "Step" } }] }) + "\n\n",
      );
    const adapter = new OpenAIChatAdapter({
      model: "gpt-4o",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const res = await adapter.chat({ ...minimalParams(), stream: true });
    expect(res.reasoning).toBe("Step");
  });

  it("aggregates tool call deltas by index and parses arguments (openAIToolCallToToolCall + parseJsonArguments)", async () => {
    const fetchImpl = async () =>
      sseResponse(
        "data: " +
          JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: "call_1", type: "function", function: { name: "get_", arguments: '{"city":' } },
                  ],
                },
              },
            ],
          }) +
          "\n\n",
        "data: " +
          JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, function: { name: "weather", arguments: '"Shanghai"}' } },
                    { index: 1, id: "call_2", type: "function", function: { name: "get_time", arguments: "{}" } },
                  ],
                },
              },
            ],
          }) +
          "\n\n",
        "data: " + JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }) + "\n\n",
        "data: [DONE]\n\n",
      );
    const adapter = new OpenAIChatAdapter({
      model: "gpt-4o",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const res = await adapter.chat({ ...minimalParams(), stream: true });
    expect(res.providerFinishReason).toBe("tool_calls");
    expect(res.toolCalls).toEqual([
      {
        id: "call_1",
        name: "get_weather",
        argumentsJson: '{"city":"Shanghai"}',
        arguments: { city: "Shanghai" },
      },
      {
        id: "call_2",
        name: "get_time",
        argumentsJson: "{}",
        arguments: {},
      },
    ]);
  });

  it("reads finish_reason and usage from stream chunks (buildUsage)", async () => {
    const fetchImpl = async () =>
      sseResponse(
        "data: " +
          JSON.stringify({
            choices: [{ delta: { content: "ok" } }],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 4,
              total_tokens: 14,
              prompt_cache_read_tokens: 6,
              completion_tokens_details: { reasoning_tokens: 2 },
            },
          }) +
          "\n\n",
        "data: " + JSON.stringify({ choices: [{ delta: {}, finish_reason: "length" }] }) + "\n\n",
      );
    const adapter = new OpenAIChatAdapter({
      model: "gpt-4o",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const res = await adapter.chat({ ...minimalParams(), stream: true });
    expect(res.text).toBe("ok");
    expect(res.providerFinishReason).toBe("length");
    expect(res.usage).toEqual({
      input: 10,
      output: 4,
      total: 14,
      cacheRead: 6,
      cacheWrite: undefined,
      reasoning: 2,
    });
  });

  it("ignores blank lines, non-JSON data lines and [DONE]", async () => {
    const fetchImpl = async () =>
      sseResponse(
        "\n\n",
        "data: not-json\n\n",
        "event: message\n\n",
        "data: " + JSON.stringify({ choices: [{ delta: { content: "hi" } }] }) + "\n\n",
        "data: [DONE]\n\n",
      );
    const adapter = new OpenAIChatAdapter({
      model: "gpt-4o",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const res = await adapter.chat({ ...minimalParams(), stream: true });
    expect(res.text).toBe("hi");
    expect(res.providerFinishReason).toBe("unknown");
  });

  it("flushes a trailing partial line without a newline", async () => {
    const fetchImpl = async () =>
      sseResponse("data: " + JSON.stringify({ choices: [{ delta: { content: "tail" } }] }));
    const adapter = new OpenAIChatAdapter({
      model: "gpt-4o",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const res = await adapter.chat({ ...minimalParams(), stream: true });
    expect(res.text).toBe("tail");
  });

  it("rejects with ProviderError when the response is not ok", async () => {
    const fetchImpl = async () =>
      new Response("oops", {
        status: 500,
        statusText: "Internal Server Error",
        headers: { "Content-Type": "text/plain" },
      });
    const adapter = new OpenAIChatAdapter({
      model: "gpt-4o",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    try {
      await adapter.chat({ ...minimalParams(), stream: true });
      expect.unreachable("chat should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderError);
      const providerError = error as ProviderError;
      expect(providerError.message).toContain("stream failed");
      expect(providerError.provider).toBe("openai");
      expect(providerError.statusCode).toBe(500);
      expect(providerError.recoverable).toBe(true);
    }
  });

  it("rejects with ProviderError when the response body is missing", async () => {
    const fetchImpl = async () =>
      new Response(null, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    const adapter = new OpenAIChatAdapter({
      model: "gpt-4o",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(adapter.chat({ ...minimalParams(), stream: true })).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof ProviderError && error.message.includes("stream failed"),
    );
  });
});

describe("createOpenAIChatAdapter", () => {
  it("creates an adapter from positional arguments", () => {
    const adapter = createOpenAIChatAdapter(
      "deepseek-v4-flash",
      "sk-test",
      "https://openai-proxy.example.com/",
    );
    expect(adapter).toBeInstanceOf(OpenAIChatAdapter);
    expect(adapter.modelName).toBe("deepseek-v4-flash");
    expect(internals(adapter).baseUrl).toBe("https://openai-proxy.example.com");
    expect(internals(adapter).apiKey).toBe("sk-test");
  });

  it("works without apiKey or baseUrl", () => {
    const adapter = createOpenAIChatAdapter("gpt-4o");
    expect(internals(adapter).baseUrl).toBe("https://api.openai.com");
    expect(internals(adapter).apiKey).toBeUndefined();
  });
});
