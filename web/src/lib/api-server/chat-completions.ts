import type { ChatCompletionRequest, ChatCompletionResponse } from "./schemas.js";

export function handleChatCompletion(req: ChatCompletionRequest): ChatCompletionResponse {
  return {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: req.model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: `Echo: ${JSON.stringify(req.messages)}` },
        finish_reason: "stop",
      },
    ],
  };
}
