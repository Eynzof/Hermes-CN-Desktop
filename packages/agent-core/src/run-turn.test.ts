import { describe, expect, it, vi } from "vitest";
import { runTurn } from "./run-turn.js";
import type { LLM, LLMChatParams, LLMChatResponse, Message, Tool, TokenUsage } from "./types.js";

const EMPTY_USAGE: TokenUsage = { input: 0, output: 0, total: 0 };

class EchoLLM implements LLM {
  readonly modelName = "echo";
  async chat(params: LLMChatParams): Promise<LLMChatResponse> {
    const lastUser = [...params.messages].reverse().find((m) => m.role === "user");
    const text = lastUser ? `Echo: ${lastUser.content}` : "Echo: hello";
    params.onTextDelta?.(text);
    return { text, toolCalls: [], usage: { input: 1, output: 1, total: 2 } };
  }
}

class ScriptedLLM implements LLM {
  private index = 0;
  constructor(private readonly responses: LLMChatResponse[]) {}
  get modelName() {
    return "scripted";
  }
  async chat(_params: LLMChatParams): Promise<LLMChatResponse> {
    const response = this.responses[this.index++] ?? { text: "", toolCalls: [], usage: EMPTY_USAGE };
    return response;
  }
}

const weatherTool: Tool = {
  name: "get_weather",
  description: "Get current weather",
  parameters: {
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
  },
  async execute(args) {
    const { city } = args as { city: string };
    return { content: `Weather in ${city}: sunny, 24°C` };
  },
};

describe("runTurn", () => {
  it("echoes a simple user prompt", async () => {
    const events: unknown[] = [];
    const result = await runTurn({
      sessionId: "s1",
      prompt: "hello",
      llm: new EchoLLM(),
      messages: [],
      tools: [],
      emit: (event) => events.push(event.type),
    });

    expect(result.assistantMessage.content).toBe("Echo: hello");
    expect(result.stopReason).toBe("stop");
    expect(result.usage.total).toBe(2);
    expect(events).toContain("agent.turn.start");
    expect(events).toContain("message.start");
    expect(events).toContain("message.complete");
    expect(events).toContain("agent.turn.complete");
  });

  it("dispatches a tool call and continues the loop", async () => {
    const llm = new ScriptedLLM([
      {
        text: "",
        toolCalls: [{ id: "call_1", name: "get_weather", arguments: { city: "Shanghai" } }],
        usage: { input: 10, output: 5, total: 15 },
      },
      {
        text: "It is sunny in Shanghai.",
        toolCalls: [],
        usage: { input: 20, output: 5, total: 25 },
      },
    ]);

    const events: unknown[] = [];
    const result = await runTurn({
      sessionId: "s1",
      prompt: "What's the weather?",
      llm,
      messages: [],
      tools: [weatherTool],
      emit: (event) => events.push(event),
    });

    expect(result.assistantMessage.content).toBe("It is sunny in Shanghai.");
    expect(result.steps).toHaveLength(2);
    expect(result.usage.total).toBe(40);
    expect(events.some((e) => (e as { type: string }).type === "tool.start")).toBe(true);
    expect(events.some((e) => (e as { type: string }).type === "tool.complete")).toBe(true);
  });

  it("honours max steps", async () => {
    // Model always returns a tool call, so without a cap the loop would run
    // until DEFAULT_MAX_STEPS.
    const llm = new ScriptedLLM([
      {
        text: "",
        toolCalls: [{ id: "call_1", name: "get_weather", arguments: { city: "Beijing" } }],
        usage: { input: 1, output: 1, total: 2 },
      },
      {
        text: "",
        toolCalls: [{ id: "call_2", name: "get_weather", arguments: { city: "Shanghai" } }],
        usage: { input: 1, output: 1, total: 2 },
      },
    ]);

    const result = await runTurn({
      sessionId: "s1",
      prompt: "Loop test",
      llm,
      messages: [],
      tools: [weatherTool],
      maxSteps: 2,
    });

    expect(result.steps).toHaveLength(2);
    expect(result.stopReason).toBe("max_steps");
  });

  it("aborts via AbortSignal", async () => {
    const controller = new AbortController();
    const llm: LLM = {
      modelName: "slow",
      async chat() {
        controller.abort();
        return { text: "should not finish", toolCalls: [], usage: EMPTY_USAGE };
      },
    };

    const result = await runTurn({
      sessionId: "s1",
      prompt: "abort",
      llm,
      messages: [],
      tools: [],
      signal: controller.signal,
    });

    expect(result.stopReason).toBe("aborted");
  });

  it("prepends the system prompt", async () => {
    const llm: LLM = {
      modelName: "spy",
      async chat(params) {
        expect(params.messages[0]?.role).toBe("system");
        expect(params.messages[0]?.content).toBe("You are helpful.");
        return { text: "ok", toolCalls: [], usage: EMPTY_USAGE };
      },
    };

    await runTurn({
      sessionId: "s1",
      prompt: "hi",
      llm,
      messages: [],
      tools: [],
      systemPrompt: "You are helpful.",
    });
  });

  it("injects memory files into the system prompt", async () => {
    const llm: LLM = {
      modelName: "spy",
      async chat(params) {
        const system = params.messages.find((m) => m.role === "system");
        expect(system).toBeDefined();
        expect(system?.content).toContain("# Memory Context");
        expect(system?.content).toContain("MEMORY.md");
        expect(system?.content).toContain("USER.md");
        expect(system?.content).toContain("likes sushi");
        expect(system?.content).toContain("uses vim");
        return { text: "ok", toolCalls: [], usage: EMPTY_USAGE };
      },
    };

    await runTurn({
      sessionId: "s1",
      prompt: "hi",
      llm,
      messages: [],
      tools: [],
      memoryFiles: [
        { path: "/ws/MEMORY.md", source: "hermes", content: "likes sushi", provenance: "MEMORY.md" },
        { path: "/ws/USER.md", source: "hermes", content: "uses vim", provenance: "USER.md" },
      ],
    });
  });
});
