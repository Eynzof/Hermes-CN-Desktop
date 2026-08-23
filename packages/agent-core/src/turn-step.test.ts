import { describe, expect, it, vi } from "vitest";
import { executeTurnStep, ToolError } from "./turn-step.js";
import { AgentAbortError } from "./errors.js";
import type {
  LLM,
  LLMChatParams,
  LLMChatResponse,
  Message,
  Tool,
  ToolCall,
  ToolContext,
  ToolResult,
  TokenUsage,
} from "./types.js";

const EMPTY_USAGE: TokenUsage = { input: 0, output: 0, total: 0 };

function makeLLM(
  chat: (params: LLMChatParams) => Promise<LLMChatResponse> | LLMChatResponse,
): LLM {
  return {
    modelName: "test-llm",
    async chat(params) {
      return chat(params);
    },
  };
}

function makeTool(overrides: Partial<Tool> = {}): Tool {
  return {
    name: "get_weather",
    description: "Get the weather",
    parameters: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
    async execute() {
      return { content: "sunny" };
    },
    ...overrides,
  };
}

function makeCall(overrides: Partial<ToolCall> = {}): ToolCall {
  return { id: "call_1", name: "get_weather", arguments: { city: "Shanghai" }, ...overrides };
}

function makeResponse(overrides: Partial<LLMChatResponse> = {}): LLMChatResponse {
  return { text: "", toolCalls: [], usage: EMPTY_USAGE, ...overrides };
}

async function expectRejectsWithAbort(promise: Promise<unknown>): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(AgentAbortError);
  await expect(promise).rejects.toMatchObject({ code: "aborted" });
}

describe("executeTurnStep", () => {
  it("throws AgentAbortError before calling the LLM when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const chat = vi.fn(() => makeResponse({ text: "should not happen" }));

    await expectRejectsWithAbort(
      executeTurnStep({
        llm: makeLLM(chat),
        messages: [],
        tools: [],
        signal: controller.signal,
        sessionId: "s1",
      }),
    );
    expect(chat).not.toHaveBeenCalled();
  });

  it("calls the LLM with decorated messages/tools and reports the cache plan", async () => {
    const chat = vi.fn((_params: LLMChatParams) => makeResponse({ text: "hi" }));
    const onCachePlan = vi.fn();
    const messages: Message[] = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "weather?" },
    ];
    const tools = [makeTool()];

    await executeTurnStep({
      llm: makeLLM(chat),
      messages,
      tools,
      signal: new AbortController().signal,
      sessionId: "s1",
      cacheControlOptions: { provider: "anthropic" },
      onCachePlan,
    });

    expect(onCachePlan).toHaveBeenCalledTimes(1);
    const plan = onCachePlan.mock.calls[0]![0]!;
    expect(plan.messageBreakpoints).toContain(0); // system marker
    expect(plan.messageBreakpoints).toContain(messages.length - 1); // last message

    const params = chat.mock.calls[0]![0]!;
    expect(params.messages).not.toBe(messages);
    expect(params.messages[0]).toMatchObject({ role: "system", cache_control: { type: "ephemeral" } });
    // Canonical arrays must stay untouched.
    expect(messages[0]).not.toHaveProperty("cache_control");
    expect(tools[0]).not.toHaveProperty("cache_control");
  });

  it("uses the default generic cache options when none are provided", async () => {
    const chat = vi.fn((_params: LLMChatParams) => makeResponse({ text: "hi" }));
    const onCachePlan = vi.fn();
    const messages: Message[] = [{ role: "system", content: "sys" }];

    await executeTurnStep({
      llm: makeLLM(chat),
      messages,
      tools: [],
      signal: new AbortController().signal,
      sessionId: "s1",
      onCachePlan,
    });

    expect(onCachePlan).toHaveBeenCalledTimes(1);
    expect(onCachePlan.mock.calls[0]![0]!.breakpointCount).toBe(0);
    expect(chat.mock.calls[0]![0]!.messages[0]).not.toHaveProperty("cache_control");
  });

  it("emits message.delta for streamed text and for the final text", async () => {
    const chat = (params: LLMChatParams) => {
      params.onTextDelta?.("Hello");
      params.onTextDelta?.(" world");
      return makeResponse({ text: "Hello world" });
    };
    const events: unknown[] = [];
    const result = await executeTurnStep({
      llm: makeLLM(chat),
      messages: [],
      tools: [],
      signal: new AbortController().signal,
      sessionId: "s1",
      emit: (event) => events.push(event),
    });

    expect(result.assistantText).toBe("Hello world");
    expect(events.map((e) => (e as { type: string }).type)).toEqual([
      "message.delta",
      "message.delta",
      "message.delta",
    ]);
    expect(events[0]).toMatchObject({ type: "message.delta", session_id: "s1", payload: { text: "Hello" } });
    expect(events[1]).toMatchObject({ payload: { text: " world" } });
    expect(events[2]).toMatchObject({ payload: { text: "Hello world" } });
  });

  it("emits thinking.delta when the adapter streams thinking", async () => {
    const chat = (params: LLMChatParams) => {
      params.onThinkDelta?.("reasoning...");
      return makeResponse({ text: "answer" });
    };
    const events: unknown[] = [];
    await executeTurnStep({
      llm: makeLLM(chat),
      messages: [],
      tools: [],
      signal: new AbortController().signal,
      sessionId: "s1",
      emit: (event) => events.push(event),
    });

    expect(events[0]).toMatchObject({ type: "thinking.delta", payload: { text: "reasoning..." } });
  });

  it("swallows tool-call stream deltas (no partial events emitted)", async () => {
    const chat = (params: LLMChatParams) => {
      expect(typeof params.onToolCallDelta).toBe("function");
      params.onToolCallDelta?.({ id: "partial_1", name: "get_weather" });
      return makeResponse({ text: "done" });
    };
    const events: unknown[] = [];
    await executeTurnStep({
      llm: makeLLM(chat),
      messages: [],
      tools: [],
      signal: new AbortController().signal,
      sessionId: "s1",
      emit: (event) => events.push(event),
    });

    expect(events.filter((e) => (e as { type: string }).type === "tool.start")).toHaveLength(0);
  });

  it("passes the signal through to the LLM", async () => {
    const controller = new AbortController();
    const chat = vi.fn((params: LLMChatParams) => {
      expect(params.signal).toBe(controller.signal);
      return makeResponse({ text: "ok" });
    });
    await executeTurnStep({
      llm: makeLLM(chat),
      messages: [],
      tools: [],
      signal: controller.signal,
      sessionId: "s1",
    });
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it("dispatches a tool call, records the result, and emits tool events", async () => {
    const execute = vi.fn(async (_args: unknown, _context: ToolContext): Promise<ToolResult> => ({
      content: "Weather in Shanghai: sunny",
    }));
    const tool = makeTool({ execute });
    const toolCall = makeCall();
    const events: unknown[] = [];

    const result = await executeTurnStep({
      llm: makeLLM(() => makeResponse({ toolCalls: [toolCall], providerFinishReason: "tool_calls" })),
      messages: [],
      tools: [tool],
      signal: new AbortController().signal,
      sessionId: "s1",
      emit: (event) => events.push(event),
    });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]![0]).toEqual({ city: "Shanghai" });
    expect(result.toolResults).toHaveLength(1);
    expect(result.toolResults[0]!.toolCall).toBe(toolCall);
    expect(result.toolResults[0]!.result.content).toBe("Weather in Shanghai: sunny");
    expect(result.toolResults[0]!.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.finishReason).toBe("tool_calls");

    const types = events.map((e) => (e as { type: string }).type);
    expect(types).toContain("tool.start");
    expect(types).toContain("tool.complete");
    expect(events[0]).toMatchObject({
      type: "tool.start",
      session_id: "s1",
      payload: { tool_id: "call_1", name: "get_weather" },
    });
    expect(events[1]).toMatchObject({
      type: "tool.complete",
      session_id: "s1",
      payload: {
        tool_id: "call_1",
        name: "get_weather",
        summary: "Weather in Shanghai: sunny",
        error: undefined,
      },
    });
    expect(typeof (events[1] as { payload: { duration_s: unknown } }).payload.duration_s).toBe("number");
  });

  it("passes the caller toolContext to tool.execute and defaults to unknown session", async () => {
    const execute = vi.fn(async (_args: unknown, _context: ToolContext) => ({ content: "ok" }));
    const tool = makeTool({ execute });
    const toolContext: ToolContext = { sessionId: "s9", runtime: { x: 1 } };

    await executeTurnStep({
      llm: makeLLM(() => makeResponse({ toolCalls: [makeCall()] })),
      messages: [],
      tools: [tool],
      signal: new AbortController().signal,
      sessionId: "s1",
      toolContext,
    });
    expect(execute.mock.calls[0]![1]).toBe(toolContext);

    const executeDefault = vi.fn(async (_args: unknown, _context: ToolContext) => ({ content: "ok" }));
    await executeTurnStep({
      llm: makeLLM(() => makeResponse({ toolCalls: [makeCall()] })),
      messages: [],
      tools: [makeTool({ execute: executeDefault })],
      signal: new AbortController().signal,
      sessionId: "s1",
    });
    expect(executeDefault.mock.calls[0]![1]).toEqual({ sessionId: "unknown" });
  });

  it("truncates the tool.complete summary to 500 chars", async () => {
    const longContent = "x".repeat(1000);
    const tool = makeTool({ execute: async () => ({ content: longContent }) });
    const events: unknown[] = [];

    await executeTurnStep({
      llm: makeLLM(() => makeResponse({ toolCalls: [makeCall()] })),
      messages: [],
      tools: [tool],
      signal: new AbortController().signal,
      sessionId: "s1",
      emit: (event) => events.push(event),
    });

    const complete = events.find((e) => (e as { type: string }).type === "tool.complete") as {
      payload: { summary: string };
    };
    expect(complete.payload.summary).toHaveLength(500);
    expect(complete.payload.summary).toBe(longContent.slice(0, 500));
  });

  it("reports an unknown tool as an error result without executing anything", async () => {
    const execute = vi.fn(async (_args: unknown, _context: ToolContext) => ({ content: "never" }));
    const tool = makeTool({ execute });
    const events: unknown[] = [];

    const result = await executeTurnStep({
      llm: makeLLM(() =>
        makeResponse({ toolCalls: [makeCall({ name: "no_such_tool" })] }),
      ),
      messages: [],
      tools: [tool],
      signal: new AbortController().signal,
      sessionId: "s1",
      emit: (event) => events.push(event),
    });

    expect(execute).not.toHaveBeenCalled();
    expect(result.toolResults[0]!.result.isError).toBe(true);
    expect(result.toolResults[0]!.result.content).toBe('Tool "no_such_tool" is not available.');

    const complete = events.find((e) => (e as { type: string }).type === "tool.complete") as {
      payload: { error?: string; summary: string };
    };
    expect(complete.payload.error).toBe('Tool "no_such_tool" is not available.');
    expect(complete.payload.summary).toBe('Tool "no_such_tool" is not available.');
  });

  it("converts a throwing tool into a failed result", async () => {
    const tool = makeTool({
      execute: async () => {
        throw new Error("kaboom");
      },
    });
    const result = await executeTurnStep({
      llm: makeLLM(() => makeResponse({ toolCalls: [makeCall()] })),
      messages: [],
      tools: [tool],
      signal: new AbortController().signal,
      sessionId: "s1",
    });

    expect(result.toolResults[0]!.result.isError).toBe(true);
    expect(result.toolResults[0]!.result.content).toBe('Tool "get_weather" failed: kaboom');
  });

  it("stringifies non-Error tool failures", async () => {
    const tool = makeTool({
      execute: async () => {
        throw "plain string failure"; // eslint-disable-line no-throw-literal
      },
    });
    const result = await executeTurnStep({
      llm: makeLLM(() => makeResponse({ toolCalls: [makeCall()] })),
      messages: [],
      tools: [tool],
      signal: new AbortController().signal,
      sessionId: "s1",
    });

    expect(result.toolResults[0]!.result.content).toBe('Tool "get_weather" failed: plain string failure');
  });

  it("reports unparseable tool arguments as a failed result", async () => {
    const circular: Record<string, unknown> = { city: "Shanghai" };
    circular.self = circular;
    const tool = makeTool({ execute: vi.fn(async (_args: unknown, _context: ToolContext) => ({ content: "never" })) });
    const result = await executeTurnStep({
      llm: makeLLM(() => makeResponse({ toolCalls: [makeCall({ arguments: circular })] })),
      messages: [],
      tools: [tool],
      signal: new AbortController().signal,
      sessionId: "s1",
    });

    expect(result.toolResults[0]!.result.isError).toBe(true);
    expect(result.toolResults[0]!.result.content).toContain('Failed to parse arguments for "get_weather"');
    expect(tool.execute).not.toHaveBeenCalled();
  });

  it("throws AgentAbortError when the signal is aborted right after the LLM responds", async () => {
    const controller = new AbortController();
    const execute = vi.fn(async (_args: unknown, _context: ToolContext) => ({ content: "never" }));
    const chat = (params: LLMChatParams) => {
      params.onTextDelta?.("partial");
      controller.abort();
      return makeResponse({ toolCalls: [makeCall()] });
    };

    await expectRejectsWithAbort(
      executeTurnStep({
        llm: makeLLM(chat),
        messages: [],
        tools: [makeTool({ execute })],
        signal: controller.signal,
        sessionId: "s1",
      }),
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it("throws AgentAbortError when aborted mid-tool-loop after a completed tool", async () => {
    const controller = new AbortController();
    const first = makeTool({
      name: "first",
      execute: async () => {
        controller.abort();
        return { content: "done" };
      },
    });
    const second = makeTool({
      name: "second",
      execute: vi.fn(async (_args: unknown, _context: ToolContext) => ({ content: "never" })),
    });
    const events: unknown[] = [];

    await expectRejectsWithAbort(
      executeTurnStep({
        llm: makeLLM(() =>
          makeResponse({
            toolCalls: [
              makeCall({ id: "call_a", name: "first" }),
              makeCall({ id: "call_b", name: "second" }),
            ],
          }),
        ),
        messages: [],
        tools: [first, second],
        signal: controller.signal,
        sessionId: "s1",
        emit: (event) => events.push(event),
      }),
    );

    expect(second.execute).not.toHaveBeenCalled();
    const types = events.map((e) => (e as { type: string }).type);
    expect(types).toEqual(["tool.start", "tool.complete"]);
  });

  it("returns assistant text, tool calls, usage, and finish reason", async () => {
    const usage: TokenUsage = { input: 10, output: 5, total: 15 };
    const result = await executeTurnStep({
      llm: makeLLM(() =>
        makeResponse({ text: "done", usage, providerFinishReason: "stop" }),
      ),
      messages: [],
      tools: [],
      signal: new AbortController().signal,
      sessionId: "s1",
    });

    expect(result.assistantText).toBe("done");
    expect(result.toolCalls).toEqual([]);
    expect(result.usage).toBe(usage);
    expect(result.finishReason).toBe("stop");
  });

  it("runs without an emit callback", async () => {
    const result = await executeTurnStep({
      llm: makeLLM(() => makeResponse({ text: "quiet" })),
      messages: [],
      tools: [],
      signal: new AbortController().signal,
      sessionId: "s1",
    });
    expect(result.assistantText).toBe("quiet");
  });

  it("re-exports ToolError from the errors module", () => {
    expect(ToolError).toBeInstanceOf(Function);
    const error = new ToolError("boom", "get_weather");
    expect(error.code).toBe("tool_error");
    expect(error.toolName).toBe("get_weather");
    expect(error).toBeInstanceOf(Error);
  });
});
