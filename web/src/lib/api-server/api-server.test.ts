import { describe, it, expect } from "vitest";
import { ChatCompletionRequestSchema, ChatCompletionResponseSchema } from "./schemas.js";
import { sseFrame } from "./sse.js";
import { API_ROUTES, matchApiRoute } from "./routes.js";
import { handleChatCompletion } from "./chat-completions.js";

describe("api-server schemas", () => {
  it("validates a chat completion request", () => {
    const req = { model: "gpt-4", messages: [{ role: "user", content: "hi" }] };
    expect(ChatCompletionRequestSchema.parse(req).model).toBe("gpt-4");
  });

  it("rejects an invalid request", () => {
    expect(() => ChatCompletionRequestSchema.parse({})).toThrow();
  });

  it("validates a response", () => {
    const res = {
      id: "chatcmpl-1",
      object: "chat.completion" as const,
      created: 1,
      model: "gpt-4",
      choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
    };
    expect(ChatCompletionResponseSchema.parse(res).id).toBe("chatcmpl-1");
  });
});

describe("api-server sse", () => {
  it("builds a simple frame", () => {
    expect(sseFrame("delta", { x: 1 })).toBe('event: delta\ndata: {"x":1}\n\n');
  });
});

describe("api-server routes", () => {
  it("registers core routes", () => {
    expect(API_ROUTES.some((r) => r.path === "/v1/chat/completions")).toBe(true);
    expect(API_ROUTES.some((r) => r.path === "/health")).toBe(true);
  });

  it("matches a route", () => {
    const route = matchApiRoute("POST", "/v1/chat/completions");
    expect(route).toBeDefined();
    expect(route?.path).toBe("/v1/chat/completions");
  });

  it("handles a chat completion", () => {
    const result = handleChatCompletion({ model: "gpt-4", messages: [{ role: "user", content: "hi" }] });
    expect(result.object).toBe("chat.completion");
    expect(result.choices[0].message.role).toBe("assistant");
  });
});
