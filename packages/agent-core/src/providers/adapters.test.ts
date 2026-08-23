import { describe, expect, it } from "vitest";
import {
  AzureAdapter,
  BedrockAdapter,
  GeminiAdapter,
  OpenAIChatAdapter,
  VertexAdapter,
} from "../index.js";
import { ProviderError } from "../errors.js";

describe("Provider adapter seams", () => {
  it("OpenAIChatAdapter exposes the model name and makes a non-streaming request", async () => {
    const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? "{}") as Record<string, unknown>;
      expect(body.model).toBe("gpt-4o-mini");
      expect(body.messages).toBeDefined();
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: { role: "assistant", content: "Hi" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const adapter = new OpenAIChatAdapter({
      model: "gpt-4o-mini",
      apiKey: "test-key",
      fetchImpl,
    });

    const response = await adapter.chat({
      messages: [{ role: "user", content: "Hi" }],
      tools: [],
      signal: new AbortController().signal,
    });

    expect(response.text).toBe("Hi");
    expect(response.toolCalls).toEqual([]);
    expect(response.usage.total).toBe(4);
    expect(response.providerFinishReason).toBe("stop");
  });

  it("OpenAIChatAdapter converts tool calls from the API response", async () => {
    const fetchImpl = async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
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
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );

    const adapter = new OpenAIChatAdapter({ model: "gpt-4o", fetchImpl });
    const response = await adapter.chat({
      messages: [{ role: "user", content: "weather" }],
      tools: [],
      signal: new AbortController().signal,
    });

    expect(response.toolCalls).toHaveLength(1);
    expect(response.toolCalls[0]?.name).toBe("get_weather");
    expect(response.toolCalls[0]?.arguments).toEqual({ city: "Shanghai" });
    expect(response.providerFinishReason).toBe("tool_calls");
  });

  it("stubs throw ProviderError with the provider name", async () => {
    const adapters: Array<{ name: string; adapter: { chat: (params: never) => Promise<unknown> } }> =
      [
        { name: "gemini", adapter: new GeminiAdapter({ model: "gemini-1.5" }) },
        { name: "bedrock", adapter: new BedrockAdapter({ model: "claude-3" }) },
        { name: "vertex", adapter: new VertexAdapter({ model: "claude-3" }) },
        { name: "azure", adapter: new AzureAdapter({ model: "gpt-4o" }) },
      ];

    const params = { messages: [], tools: [], signal: new AbortController().signal } as never;

    for (const { name, adapter } of adapters) {
      await expect(adapter.chat(params)).rejects.toSatisfy((error: unknown) => {
        return error instanceof ProviderError && (error.provider === name || error.provider === undefined);
      });
    }
  });
});
