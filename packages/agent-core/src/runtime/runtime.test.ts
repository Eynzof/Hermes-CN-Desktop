import { describe, expect, it } from "vitest";
import { AgentRuntime } from "../index.js";
import type { AgentEvent, LLM, LLMChatParams, LLMChatResponse, ProfileSnapshot, Tool } from "../index.js";

function makeProfile(model = "echo", provider = "test"): ProfileSnapshot {
  return {
    model,
    provider,
    apiMode: "chat_completions",
  };
}

class EchoLLM implements LLM {
  readonly modelName = "echo";
  async chat(params: LLMChatParams): Promise<LLMChatResponse> {
    const lastUser = [...params.messages].reverse().find((m) => m.role === "user");
    const text = lastUser ? `Echo: ${lastUser.content}` : "Echo";
    return { text, toolCalls: [], usage: { input: 1, output: 1, total: 2 } };
  }
}

const weatherTool: Tool = {
  name: "get_weather",
  description: "Weather",
  parameters: {
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
  },
  async execute(args) {
    const { city } = args as { city: string };
    return { content: `${city}: sunny` };
  },
};

describe("AgentRuntime", () => {
  it("creates a session and emits session.info", async () => {
    const events: AgentEvent[] = [];
    const runtime = new AgentRuntime();
    runtime.on((event) => events.push(event));

    const session = await runtime.createSession(makeProfile());

    expect(session.profile.model).toBe("echo");
    expect(events.some((e) => e.type === "session.info")).toBe(true);
  });

  it("resumes a session", async () => {
    const runtime = new AgentRuntime();
    const session = await runtime.createSession(makeProfile());
    const resumed = await runtime.resumeSession(session.id);

    expect(resumed?.id).toBe(session.id);
  });

  it("submits a prompt using the injected LLM factory", async () => {
    const runtime = new AgentRuntime({
      llmFactory: () => new EchoLLM(),
      tools: [weatherTool],
    });
    const session = await runtime.createSession(makeProfile());

    const result = await runtime.submitPrompt(session.id, "hello");

    expect(result.text).toBe("Echo: hello");
    expect(result.usage.total).toBe(2);

    const stored = await runtime.getStore().getMessages(session.id);
    expect(stored.some((m) => m.role === "user" && m.content === "hello")).toBe(true);
    expect(stored.some((m) => m.role === "assistant" && m.content === "Echo: hello")).toBe(true);
  });

  it("throws when submitting to a missing session", async () => {
    const runtime = new AgentRuntime();
    await expect(runtime.submitPrompt("missing", "hi")).rejects.toThrow("Session missing not found");
  });

  it("switches model and provider", async () => {
    const runtime = new AgentRuntime();
    const session = await runtime.createSession(makeProfile("old-model", "old-provider"));
    const updated = await runtime.switchModel(session.id, "new-model", "new-provider");

    expect(updated?.profile.model).toBe("new-model");
    expect(updated?.profile.provider).toBe("new-provider");
  });

  it("lists models from registered providers", async () => {
    const { registerProvider } = await import("../index.js");
    registerProvider({
      slug: "test",
      name: "Test Provider",
      apiMode: "chat_completions",
      authKind: "api_key",
      model: "test-model",
      fallbackModels: ["fallback-model"],
    });

    const runtime = new AgentRuntime();
    const models = await runtime.listModels();

    expect(models.map((m) => m.model)).toContain("test-model");
    expect(models.map((m) => m.model)).toContain("fallback-model");
  });
});
