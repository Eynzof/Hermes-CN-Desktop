import { describe, expect, it } from "vitest";
import {
  ApiServerStatusSchema,
  ChatCompletionChunkSchema,
  ChatCompletionMessageSchema,
  ChatCompletionRequestSchema,
  ChatCompletionResponseSchema,
} from "./api-server";

const textMessage = { role: "user", content: "hello" } as const;

describe("ChatCompletionMessageSchema", () => {
  it("parses a plain text message", () => {
    const parsed = ChatCompletionMessageSchema.parse(textMessage);
    expect(parsed.role).toBe("user");
    expect(parsed.content).toBe("hello");
  });

  it("parses multimodal content parts", () => {
    const parsed = ChatCompletionMessageSchema.parse({
      role: "user",
      content: [
        { type: "text", text: "look" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AA" } },
      ],
    });
    expect(parsed.content).toHaveLength(2);
  });

  it("keeps unknown part fields on multimodal content", () => {
    const parsed = ChatCompletionMessageSchema.parse({
      role: "assistant",
      content: [{ type: "tool_call", id: "call_1", extra: true }],
    });
    const content = parsed.content;
    expect(Array.isArray(content)).toBe(true);
    if (Array.isArray(content)) {
      expect(content[0]).toMatchObject({ type: "tool_call", id: "call_1", extra: true });
    }
  });

  it("makes content optional", () => {
    const parsed = ChatCompletionMessageSchema.parse({ role: "system" });
    expect(parsed.content).toBeUndefined();
  });

  it("rejects unknown roles", () => {
    expect(ChatCompletionMessageSchema.safeParse({ role: "tool", content: "x" }).success).toBe(false);
  });

  it("rejects non-string/non-array content", () => {
    expect(ChatCompletionMessageSchema.safeParse({ role: "user", content: 42 }).success).toBe(false);
  });
});

describe("ChatCompletionRequestSchema", () => {
  it("parses a minimal request", () => {
    const parsed = ChatCompletionRequestSchema.parse({
      model: "hermes",
      messages: [textMessage],
    });
    expect(parsed.model).toBe("hermes");
    expect(parsed.messages).toHaveLength(1);
    expect(parsed.stream).toBeUndefined();
    expect(parsed.temperature).toBeUndefined();
    expect(parsed.max_tokens).toBeUndefined();
  });

  it("parses optional generation params", () => {
    const parsed = ChatCompletionRequestSchema.parse({
      model: "hermes",
      messages: [textMessage],
      stream: true,
      temperature: 0.7,
      max_tokens: 512,
    });
    expect(parsed).toMatchObject({ stream: true, temperature: 0.7, max_tokens: 512 });
  });

  it("rejects a missing model or messages", () => {
    expect(ChatCompletionRequestSchema.safeParse({ messages: [] }).success).toBe(false);
    expect(ChatCompletionRequestSchema.safeParse({ model: "m" }).success).toBe(false);
    expect(ChatCompletionRequestSchema.safeParse({}).success).toBe(false);
  });

  it("rejects an invalid message inside the array", () => {
    const result = ChatCompletionRequestSchema.safeParse({
      model: "m",
      messages: [{ role: "robot", content: "x" }],
    });
    expect(result.success).toBe(false);
  });

  it("strips unknown request keys", () => {
    const parsed = ChatCompletionRequestSchema.parse({
      model: "m",
      messages: [],
      n: 2,
    });
    expect(parsed).not.toHaveProperty("n");
  });
});

describe("ChatCompletionResponseSchema", () => {
  it("parses a chat completion response", () => {
    const parsed = ChatCompletionResponseSchema.parse({
      id: "chatcmpl-1",
      object: "chat.completion",
      created: 1700000000,
      model: "hermes",
      choices: [{ index: 0, message: textMessage, finish_reason: "stop" }],
    });
    expect(parsed.object).toBe("chat.completion");
    expect(parsed.choices[0]?.message.content).toBe("hello");
    expect(parsed.choices[0]?.finish_reason).toBe("stop");
  });

  it("defaults choice index to 0 and finish_reason to stop", () => {
    const parsed = ChatCompletionResponseSchema.parse({
      id: "chatcmpl-2",
      object: "chat.completion",
      created: 1,
      model: "m",
      choices: [{ message: textMessage }],
    });
    expect(parsed.choices[0]?.index).toBe(0);
    expect(parsed.choices[0]?.finish_reason).toBe("stop");
  });

  it("keeps an explicit null finish_reason", () => {
    const parsed = ChatCompletionResponseSchema.parse({
      id: "chatcmpl-3",
      object: "chat.completion",
      created: 1,
      model: "m",
      choices: [{ message: textMessage, finish_reason: null }],
    });
    expect(parsed.choices[0]?.finish_reason).toBeNull();
  });

  it("rejects a wrong object literal", () => {
    const result = ChatCompletionResponseSchema.safeParse({
      id: "x",
      object: "chat.completion.chunk",
      created: 1,
      model: "m",
      choices: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing choices", () => {
    const result = ChatCompletionResponseSchema.safeParse({
      id: "x",
      object: "chat.completion",
      created: 1,
      model: "m",
    });
    expect(result.success).toBe(false);
  });
});

describe("ChatCompletionChunkSchema", () => {
  it("parses an SSE chunk with a delta", () => {
    const parsed = ChatCompletionChunkSchema.parse({
      id: "chatcmpl-4",
      object: "chat.completion.chunk",
      created: 2,
      model: "m",
      choices: [{ index: 0, delta: { role: "assistant", content: "Hel" }, finish_reason: null }],
    });
    expect(parsed.object).toBe("chat.completion.chunk");
    expect(parsed.choices[0]?.delta.content).toBe("Hel");
    expect(parsed.choices[0]?.finish_reason).toBeNull();
  });

  it("accepts an empty delta", () => {
    const parsed = ChatCompletionChunkSchema.parse({
      id: "x",
      object: "chat.completion.chunk",
      created: 3,
      model: "m",
      choices: [{ index: 0, delta: {} }],
    });
    expect(parsed.choices[0]?.delta).toEqual({});
  });

  it("rejects chunks with the completion object name", () => {
    const result = ChatCompletionChunkSchema.safeParse({
      id: "x",
      object: "chat.completion",
      created: 3,
      model: "m",
      choices: [],
    });
    expect(result.success).toBe(false);
  });
});

describe("ApiServerStatusSchema", () => {
  it("parses running status with port", () => {
    expect(ApiServerStatusSchema.parse({ running: true, port: 8642 })).toEqual({
      running: true,
      port: 8642,
    });
  });

  it("rejects missing port or non-boolean running", () => {
    expect(ApiServerStatusSchema.safeParse({ running: true }).success).toBe(false);
    expect(ApiServerStatusSchema.safeParse({ running: 1, port: 8642 }).success).toBe(false);
  });
});
