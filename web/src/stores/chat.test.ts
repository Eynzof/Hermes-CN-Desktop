import { createStore } from "jotai/vanilla";
import { describe, expect, it } from "vitest";
import type { HermesMessagePart, HermesUIMessage } from "@hermes/protocol";
import {
  applyGatewayEventAtom,
  chatRuntimeBySessionAtom,
  createEmptyChatRuntime,
  drainLiveMessagesAtom,
  markSessionInterruptedAtom,
  markStreamsReconnectingAtom,
  recoverCompletedTurnFromStoredMessagesAtom,
  reduceGatewayEvent,
  resetStreamStateAtom,
  startPromptAtom,
  terminateAllStreamsAtom,
} from "./chat";

function assistantMessage(runtime: ReturnType<typeof createEmptyChatRuntime>): HermesUIMessage {
  const message = runtime.messages.find((item) => item.role === "assistant");
  expect(message).toBeDefined();
  return message!;
}

function systemMessage(runtime: ReturnType<typeof createEmptyChatRuntime>): HermesUIMessage {
  const message = runtime.messages.find((item) => item.role === "system");
  expect(message).toBeDefined();
  return message!;
}

function textFromParts(parts: HermesMessagePart[]): string {
  return parts
    .filter((part): part is Extract<HermesMessagePart, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function runtimeMessage(overrides: Partial<HermesUIMessage>): HermesUIMessage {
  return {
    id: "m1",
    sessionId: "s1",
    role: "assistant",
    createdAt: 1,
    status: "complete",
    parts: [{ type: "text", text: "hello" }],
    ...overrides,
  };
}

describe("chat runtime reducer", () => {
  it("uses message.complete payload even when no deltas were received", () => {
    const next = reduceGatewayEvent(
      createEmptyChatRuntime(1),
      {
        type: "message.complete",
        session_id: "s1",
        payload: { text: "最终回复", reasoning: "推理", status: "complete" },
      },
      10,
    );

    const message = assistantMessage(next);
    expect(message).toMatchObject({
      role: "assistant",
      status: "complete",
      parts: [
        { type: "text", text: "最终回复" },
        { type: "reasoning", text: "推理" },
      ],
    });
    expect(next.streamStatus).toBe("complete");
  });

  it("replaces a corrupt streamed prefix with the authoritative completion text", () => {
    let runtime = reduceGatewayEvent(
      createEmptyChatRuntime(1),
      {
        type: "reasoning.delta",
        session_id: "s1",
        payload: { text: "同一段推理" },
      },
      10,
    );
    runtime = reduceGatewayEvent(runtime, {
      type: "message.delta",
      session_id: "s1",
      payload: { text: "乱序流式前缀" },
    }, 20);
    runtime = reduceGatewayEvent(runtime, {
      type: "message.complete",
      session_id: "s1",
      payload: {
        text: "这是唯一正确的最终回复。",
        reasoning: "同一段推理",
        status: "complete",
      },
    }, 30);

    const message = assistantMessage(runtime);
    expect(textFromParts(message.parts)).toBe("这是唯一正确的最终回复。");
    expect(textFromParts(message.parts)).not.toContain("乱序流式前缀");
    expect(message.parts).toEqual([
      { type: "reasoning", text: "同一段推理" },
      { type: "text", text: "这是唯一正确的最终回复。" },
    ]);
  });

  it("keeps one assistant id from stream start through completion", () => {
    const started = reduceGatewayEvent(
      createEmptyChatRuntime(1),
      { type: "message.start", session_id: "s1" },
      10,
    );

    const withText = reduceGatewayEvent(
      started,
      {
        type: "message.delta",
        session_id: "s1",
        payload: { text: "hello" },
      },
      20,
    );

    const complete = reduceGatewayEvent(
      withText,
      {
        type: "message.complete",
        session_id: "s1",
        payload: { status: "complete" },
      },
      30,
    );

    expect(assistantMessage(started).id).toBe("live-assistant-10");
    expect(assistantMessage(complete).id).toBe("live-assistant-10");
    expect(assistantMessage(complete).status).toBe("complete");
    expect(complete.activeAssistantId).toBeUndefined();
  });

  it("preserves the optimistic assistant id created when the prompt was sent", () => {
    const runtime = {
      ...createEmptyChatRuntime(1),
      streamStatus: "streaming" as const,
      activeAssistantId: "live-assistant-5",
      turnStartedAt: 5,
    };

    const started = reduceGatewayEvent(
      runtime,
      { type: "message.start", session_id: "s1" },
      10,
    );

    expect(started.activeAssistantId).toBe("live-assistant-5");
    expect(assistantMessage(started).id).toBe("live-assistant-5");
  });

  it("shows CLI spinner thinking placeholders as progress parts and removes them on completion", () => {
    const placeholder = "ಠ_ಠ deliberating... (⌐■_■) contemplating...";
    const thinking = reduceGatewayEvent(
      createEmptyChatRuntime(1),
      {
        type: "thinking.delta",
        session_id: "s1",
        payload: { text: placeholder },
      },
      10,
    );

    expect(assistantMessage(thinking).parts).toEqual([{ type: "progress", text: placeholder }]);

    const complete = reduceGatewayEvent(
      thinking,
      {
        type: "message.complete",
        session_id: "s1",
        payload: { text: "完成", status: "complete" },
      },
      20,
    );

    expect(assistantMessage(complete).parts).toEqual([{ type: "text", text: "完成" }]);
  });

  it("removes progress when real output resumes", () => {
    const thinking = reduceGatewayEvent(
      createEmptyChatRuntime(1),
      {
        type: "thinking.delta",
        session_id: "s1",
        payload: { text: "ಠ_ಠ deliberating..." },
      },
      10,
    );
    const next = reduceGatewayEvent(
      thinking,
      {
        type: "message.delta",
        session_id: "s1",
        payload: { text: "继续回复。" },
      },
      20,
    );

    expect(assistantMessage(next).parts).toEqual([{ type: "text", text: "继续回复。" }]);
  });

  it("updates the same progress part on repeated placeholder deltas", () => {
    const firstPlaceholder = "ಠ_ಠ deliberating...";
    const secondPlaceholder = "(⌐■_■) contemplating...";
    const thinking = reduceGatewayEvent(
      createEmptyChatRuntime(1),
      {
        type: "thinking.delta",
        session_id: "s1",
        payload: { text: firstPlaceholder },
      },
      10,
    );
    const next = reduceGatewayEvent(
      thinking,
      {
        type: "thinking.delta",
        session_id: "s1",
        payload: { text: secondPlaceholder },
      },
      20,
    );

    expect(assistantMessage(next).parts).toEqual([{ type: "progress", text: secondPlaceholder }]);
  });

  it("keeps live progress stable when tools start", () => {
    const thinking = reduceGatewayEvent(
      createEmptyChatRuntime(1),
      {
        type: "thinking.delta",
        session_id: "s1",
        payload: { text: "ಠ_ಠ deliberating..." },
      },
      10,
    );
    const next = reduceGatewayEvent(
      thinking,
      {
        type: "tool.start",
        session_id: "s1",
        payload: { tool_id: "read-1", name: "read_file", context: "app.tsx" },
      },
      20,
    );

    expect(assistantMessage(next).parts).toEqual([
      expect.objectContaining({ type: "tool", toolCallId: "read-1" }),
      { type: "progress", text: "ಠ_ಠ deliberating..." },
    ]);
  });

  it("keeps real reasoning deltas", () => {
    const next = reduceGatewayEvent(
      createEmptyChatRuntime(1),
      {
        type: "reasoning.delta",
        session_id: "s1",
        payload: { text: "正在分析用户输入和约束。" },
      },
      10,
    );

    expect(assistantMessage(next).parts).toEqual([
      { type: "reasoning", text: "正在分析用户输入和约束。" },
    ]);
  });

  it("updates duplicate tool names by toolCallId when available", () => {
    const first = reduceGatewayEvent(
      createEmptyChatRuntime(1),
      {
        type: "tool.start",
        session_id: "s1",
        payload: { tool_id: "a", name: "shell", context: "first" },
      },
      10,
    );
    const started = reduceGatewayEvent(
      first,
      {
        type: "tool.start",
        session_id: "s1",
        payload: { tool_id: "b", name: "shell", context: "second" },
      },
      20,
    );

    const next = reduceGatewayEvent(
      started,
      {
        type: "tool.complete",
        session_id: "s1",
        payload: { tool_id: "b", name: "shell", summary: "done" },
      },
      30,
    );

    expect(assistantMessage(next).parts).toEqual([
      expect.objectContaining({ type: "tool", toolCallId: "a", state: "running" }),
      expect.objectContaining({ type: "tool", toolCallId: "b", state: "done", output: "done" }),
    ]);
  });

  it("uses gateway tool duration when completing live tools", () => {
    const started = reduceGatewayEvent(
      createEmptyChatRuntime(1),
      {
        type: "tool.start",
        session_id: "s1",
        payload: { tool_id: "read-1", name: "read_file", context: "app.tsx" },
      },
      1000,
    );

    const next = reduceGatewayEvent(
      started,
      {
        type: "tool.complete",
        session_id: "s1",
        payload: { tool_id: "read-1", summary: "done", duration_s: 2.25 },
      },
      9000,
    );

    expect(assistantMessage(next).parts[0]).toEqual(
      expect.objectContaining({
        type: "tool",
        state: "done",
        completedAt: 3250,
      }),
    );
  });

  it("keeps text and tool calls in one ordered assistant turn", () => {
    const started = reduceGatewayEvent(
      createEmptyChatRuntime(1),
      {
        type: "message.delta",
        session_id: "s1",
        payload: { text: "我先检查。" },
      },
      10,
    );
    const toolStarted = reduceGatewayEvent(
      started,
      {
        type: "tool.start",
        session_id: "s1",
        payload: { tool_id: "read-1", name: "read_file", context: "app.tsx" },
      },
      20,
    );
    const toolDone = reduceGatewayEvent(
      toolStarted,
      {
        type: "tool.complete",
        session_id: "s1",
        payload: { tool_id: "read-1", summary: "read ok" },
      },
      30,
    );
    const moreText = reduceGatewayEvent(
      toolDone,
      {
        type: "message.delta",
        session_id: "s1",
        payload: { text: "结论如下。" },
      },
      40,
    );
    const complete = reduceGatewayEvent(
      moreText,
      {
        type: "message.complete",
        session_id: "s1",
        payload: { status: "complete" },
      },
      50,
    );

    const message = assistantMessage(complete);
    expect(message.parts).toEqual([
      { type: "text", text: "我先检查。" },
      expect.objectContaining({
        type: "tool",
        toolCallId: "read-1",
        name: "read_file",
        state: "done",
        output: "read ok",
      }),
      { type: "text", text: "结论如下。" },
    ]);
    expect(textFromParts(message.parts)).toBe("我先检查。结论如下。");
  });

  it("preserves pre-tool commentary while replacing a corrupt final segment", () => {
    let runtime = reduceGatewayEvent(
      createEmptyChatRuntime(1),
      {
        type: "message.delta",
        session_id: "s1",
        payload: { text: "我先检查。" },
      },
      10,
    );
    runtime = reduceGatewayEvent(runtime, {
      type: "tool.start",
      session_id: "s1",
      payload: { tool_id: "read-1", name: "read_file" },
    }, 20);
    runtime = reduceGatewayEvent(runtime, {
      type: "tool.complete",
      session_id: "s1",
      payload: { tool_id: "read-1", summary: "ok" },
    }, 30);
    runtime = reduceGatewayEvent(runtime, {
      type: "message.delta",
      session_id: "s1",
      payload: { text: "损坏的尾部" },
    }, 40);
    runtime = reduceGatewayEvent(runtime, {
      type: "message.complete",
      session_id: "s1",
      payload: { text: "最终结论。", status: "complete" },
    }, 50);

    expect(assistantMessage(runtime).parts).toEqual([
      { type: "text", text: "我先检查。" },
      expect.objectContaining({
        type: "tool",
        toolCallId: "read-1",
        state: "done",
      }),
      { type: "text", text: "最终结论。" },
    ]);
  });

  it("records usage and timing metadata on complete", () => {
    let rt = reduceGatewayEvent(
      createEmptyChatRuntime(1),
      { type: "message.start", session_id: "s1" },
      100,
    );
    rt = reduceGatewayEvent(rt, {
      type: "message.delta",
      session_id: "s1",
      payload: { text: "hello" },
    }, 250);
    rt = reduceGatewayEvent(rt, {
      type: "message.complete",
      session_id: "s1",
      payload: {
        status: "complete",
        usage: {
          input: 10,
          output: 20,
          total: 30,
          model: "gpt-5.4",
          cost_usd: 0.01,
          cost_status: "estimated",
          finish_reason: "stop",
        },
      },
    }, 1100);

    expect(assistantMessage(rt).metadata).toMatchObject({
      usage: { tokensInput: 10, tokensOutput: 20, tokensTotal: 30 },
      timing: { startedAt: 100, firstTokenAt: 250, completedAt: 1100, ttftMs: 150, durationMs: 1000 },
      model: "gpt-5.4",
      costUsd: 0.01,
      costStatus: "estimated",
      finishReason: "stop",
    });
  });

  it("records interrupted completions as finishReason metadata", () => {
    let rt = reduceGatewayEvent(
      createEmptyChatRuntime(1),
      { type: "message.delta", session_id: "s1", payload: { text: "处理中" } },
      100,
    );
    rt = reduceGatewayEvent(rt, {
      type: "message.complete",
      session_id: "s1",
      payload: {
        status: "interrupted",
        text: "Operation interrupted: waiting for model response (1.7s elapsed).",
      },
    }, 1_100);

    expect(assistantMessage(rt).status).toBe("complete");
    expect(assistantMessage(rt).metadata?.finishReason).toBe("interrupted");
    expect(rt.streamStatus).toBe("complete");
  });

  it("warning and error completion generate notice messages without replacing assistant content", () => {
    let rt = reduceGatewayEvent(
      createEmptyChatRuntime(1),
      {
        type: "message.delta",
        session_id: "s1",
        payload: { text: "partial" },
      },
      10,
    );
    rt = reduceGatewayEvent(rt, {
      type: "message.complete",
      session_id: "s1",
      payload: { status: "error", warning: "quota low", error: "API key invalid (401)" },
    }, 20);

    expect(assistantMessage(rt).parts).toEqual([{ type: "text", text: "partial" }]);
    expect(rt.messages.filter((message) => message.role === "system")).toEqual([
      expect.objectContaining({ parts: [{ type: "notice", level: "warning", text: "quota low" }] }),
      expect.objectContaining({ parts: [{ type: "notice", level: "error", text: "API key invalid (401)" }] }),
    ]);
  });

  it("keeps multiple pending approvals for one session", () => {
    const first = reduceGatewayEvent(
      createEmptyChatRuntime(1),
      {
        type: "approval.request",
        session_id: "s1",
        payload: { request_id: "r1", command: "rm -rf tmp" },
      },
      10,
    );
    const second = reduceGatewayEvent(
      first,
      {
        type: "approval.request",
        session_id: "s1",
        payload: { request_id: "r2", command: "git push" },
      },
      20,
    );

    expect(second.pendingApprovals.map((item) => item.requestId)).toEqual(["r1", "r2"]);
  });

  it("gateway.disconnected resets streaming sessions to error", () => {
    const streaming = reduceGatewayEvent(
      createEmptyChatRuntime(1),
      { type: "message.start", session_id: "s1" },
      10,
    );
    expect(streaming.streamStatus).toBe("streaming");

    const disconnected = reduceGatewayEvent(
      streaming,
      { type: "gateway.disconnected", payload: { message: "connection lost" } },
      20,
    );
    expect(disconnected.streamStatus).toBe("error");
    expect(disconnected.statusMessage).toBe("连接已断开");
    expect(assistantMessage(disconnected).status).toBe("error");
  });

  it("gateway.disconnected marks live tool parts as errored", () => {
    let runtime = reduceGatewayEvent(
      createEmptyChatRuntime(1),
      {
        type: "tool.start",
        session_id: "s1",
        payload: { tool_id: "read-1", name: "read_file", context: "app.tsx" },
      },
      10,
    );
    runtime = reduceGatewayEvent(
      runtime,
      {
        type: "thinking.delta",
        session_id: "s1",
        payload: { text: "ಠ_ಠ deliberating..." },
      },
      15,
    );

    const disconnected = reduceGatewayEvent(
      runtime,
      { type: "gateway.disconnected", payload: { message: "connection lost" } },
      20,
    );

    expect(assistantMessage(disconnected).parts).toEqual([
      expect.objectContaining({ type: "tool", toolCallId: "read-1", state: "error" }),
    ]);
  });

  it("gateway.disconnected leaves idle sessions unchanged", () => {
    const idle = createEmptyChatRuntime(1);
    const result = reduceGatewayEvent(
      idle,
      { type: "gateway.disconnected", payload: { message: "connection lost" } },
      10,
    );
    expect(result).toBe(idle);
  });

  it("shows provider wait status and clears it when output arrives", () => {
    let rt = reduceGatewayEvent(
      createEmptyChatRuntime(1),
      { type: "message.start", session_id: "s1" },
      10,
    );

    rt = reduceGatewayEvent(rt, {
      type: "status.update",
      session_id: "s1",
      payload: { kind: "provider_wait", text: "仍在等待模型输出" },
    }, 20);

    expect(rt.statusMessage).toBe("仍在等待模型输出");
    expect(rt.statusKind).toBe("provider_wait");
    expect(rt.statusUpdatedAt).toBe(20);

    rt = reduceGatewayEvent(rt, {
      type: "message.delta",
      session_id: "s1",
      payload: { text: "hello" },
    }, 30);

    expect(rt.statusMessage).toBe("");
    expect(rt.statusKind).toBeUndefined();
    expect(rt.statusUpdatedAt).toBeUndefined();
    expect(assistantMessage(rt).parts).toEqual([{ type: "text", text: "hello" }]);
  });

  it("exports action atoms used for per-session updates", () => {
    expect(startPromptAtom).toBeDefined();
    expect(chatRuntimeBySessionAtom).toBeDefined();
  });
});

describe("full conversation lifecycle", () => {
  it("recovers from mid-stream disconnect and processes new message with a new assistant id", () => {
    let rt = reduceGatewayEvent(
      createEmptyChatRuntime(1),
      { type: "message.start", session_id: "s1" },
      10,
    );
    const firstAssistantId = assistantMessage(rt).id;

    rt = reduceGatewayEvent(rt, {
      type: "message.delta",
      session_id: "s1",
      payload: { text: "开始" },
    }, 20);

    rt = reduceGatewayEvent(rt, {
      type: "gateway.disconnected",
      payload: { message: "connection lost" },
    }, 30);
    expect(rt.streamStatus).toBe("error");
    expect(assistantMessage(rt).status).toBe("error");

    rt = reduceGatewayEvent(rt, { type: "message.start", session_id: "s1" }, 40);
    expect(rt.streamStatus).toBe("streaming");
    expect(rt.activeAssistantId).toBe("live-assistant-40");

    rt = reduceGatewayEvent(rt, {
      type: "message.complete",
      session_id: "s1",
      payload: { text: "恢复后的回复", status: "complete" },
    }, 50);
    expect(rt.streamStatus).toBe("complete");
    expect(rt.messages.map((message) => message.id)).toContain(firstAssistantId);
    expect(assistantMessage({ ...rt, messages: rt.messages.slice(1) }).parts).toEqual([
      { type: "text", text: "恢复后的回复" },
    ]);
  });

  it("handles reasoning followed by tools and text", () => {
    let rt = reduceGatewayEvent(
      createEmptyChatRuntime(1),
      { type: "message.start", session_id: "s1" },
      10,
    );

    rt = reduceGatewayEvent(rt, {
      type: "reasoning.delta",
      session_id: "s1",
      payload: { text: "需要读取文件。" },
    }, 20);

    rt = reduceGatewayEvent(rt, {
      type: "tool.start",
      session_id: "s1",
      payload: { tool_id: "read-1", name: "read_file", context: "config.ts" },
    }, 30);

    rt = reduceGatewayEvent(rt, {
      type: "tool.complete",
      session_id: "s1",
      payload: { tool_id: "read-1", summary: "读取完成" },
    }, 40);

    rt = reduceGatewayEvent(rt, {
      type: "message.delta",
      session_id: "s1",
      payload: { text: "根据文件内容，" },
    }, 50);

    rt = reduceGatewayEvent(rt, {
      type: "message.complete",
      session_id: "s1",
      payload: { status: "complete" },
    }, 60);

    expect(assistantMessage(rt).parts.map((part) => part.type)).toEqual([
      "reasoning",
      "tool",
      "text",
    ]);
    expect(assistantMessage(rt).parts[1]).toEqual(
      expect.objectContaining({ type: "tool", state: "done" }),
    );
  });

  it("approval during streaming preserves buffered canonical content", () => {
    let rt = reduceGatewayEvent(
      createEmptyChatRuntime(1),
      { type: "message.start", session_id: "s1" },
      10,
    );

    rt = reduceGatewayEvent(rt, {
      type: "message.delta",
      session_id: "s1",
      payload: { text: "我需要执行命令。" },
    }, 20);

    rt = reduceGatewayEvent(rt, {
      type: "approval.request",
      session_id: "s1",
      payload: { request_id: "r1", command: "rm -rf tmp" },
    }, 30);

    expect(rt.pendingApprovals).toHaveLength(1);
    expect(assistantMessage(rt).parts).toEqual([{ type: "text", text: "我需要执行命令。" }]);
    expect(rt.streamStatus).toBe("streaming");
  });

  it("error event during streaming appends a notice and transitions to error state", () => {
    let rt = reduceGatewayEvent(
      createEmptyChatRuntime(1),
      { type: "message.start", session_id: "s1" },
      10,
    );

    rt = reduceGatewayEvent(rt, {
      type: "message.delta",
      session_id: "s1",
      payload: { text: "partial" },
    }, 20);

    rt = reduceGatewayEvent(rt, {
      type: "error",
      session_id: "s1",
      payload: { message: "rate limit exceeded" },
    }, 30);

    expect(rt.streamStatus).toBe("error");
    expect(rt.statusMessage).toBe("rate limit exceeded");
    expect(systemMessage(rt).parts).toEqual([
      { type: "notice", level: "error", text: "rate limit exceeded" },
    ]);
  });
});

describe("markStreamsReconnectingAtom", () => {
  it("keeps the in-flight turn alive (transient) instead of erroring it", () => {
    const store = createStore();
    store.set(startPromptAtom, { sessionId: "s1", text: "hi", now: 5 });

    store.set(markStreamsReconnectingAtom);

    const runtime = store.get(chatRuntimeBySessionAtom).s1;
    // status is transient, not terminal
    expect(runtime.streamStatus).toBe("connecting");
    expect(runtime.statusMessage).toBe("连接中断，正在重连…");
    expect(runtime.statusKind).toBe("info");
    // the in-flight message + activeAssistantId survive (not cleared / not error)
    expect(runtime.activeAssistantId).toBe("live-assistant-5");
    expect(assistantMessage(runtime).status).not.toBe("error");
  });

  it("lets a post-reconnect delta resume onto the SAME assistant message", () => {
    const store = createStore();
    store.set(startPromptAtom, { sessionId: "s1", text: "hi", now: 5 });
    store.set(markStreamsReconnectingAtom);

    store.set(chatRuntimeBySessionAtom, (state) => ({
      ...state,
      s1: reduceGatewayEvent(
        state.s1,
        { type: "message.delta", session_id: "s1", payload: { text: "world" } },
        10,
      ),
    }));

    const runtime = store.get(chatRuntimeBySessionAtom).s1;
    expect(runtime.activeAssistantId).toBe("live-assistant-5");
    expect(runtime.streamStatus).toBe("streaming");
    expect(textFromParts(assistantMessage(runtime).parts)).toContain("world");
  });

  it("does not touch sessions that are not actively streaming", () => {
    const store = createStore();
    store.set(chatRuntimeBySessionAtom, (state) => ({
      ...state,
      done: { ...createEmptyChatRuntime(), streamStatus: "complete" },
    }));

    store.set(markStreamsReconnectingAtom);

    expect(store.get(chatRuntimeBySessionAtom).done.streamStatus).toBe("complete");
  });
});

describe("startPromptAtom", () => {
  it("adds optimistic user and assistant messages", () => {
    const store = createStore();

    store.set(startPromptAtom, { sessionId: "s1", text: "hello", now: 5 });

    const runtime = store.get(chatRuntimeBySessionAtom).s1;
    expect(runtime.messages).toEqual([
      expect.objectContaining({
        id: "live-user-5",
        role: "user",
        parts: [{ type: "text", text: "hello" }],
      }),
      expect.objectContaining({
        id: "live-assistant-5",
        role: "assistant",
        status: "streaming",
        parts: [{ type: "progress", text: "正在唤醒Hermes..." }],
      }),
    ]);
    expect(runtime.activeAssistantId).toBe("live-assistant-5");
    expect(runtime.streamStatus).toBe("streaming");
  });


  it("does not recover from stored reasoning/tools when the stored final text is still missing", () => {
    const store = createStore();

    store.set(startPromptAtom, { sessionId: "s1", text: "总结", now: 1_000 });
    store.set(chatRuntimeBySessionAtom, (state) => {
      let rt = state.s1;
      rt = reduceGatewayEvent(rt, {
        type: "reasoning.delta",
        session_id: "s1",
        payload: { text: "先检查。" },
      }, 1_500);
      rt = reduceGatewayEvent(rt, {
        type: "tool.start",
        session_id: "s1",
        payload: { tool_id: "t1", name: "read", context: "a.txt" },
      }, 1_600);
      rt = reduceGatewayEvent(rt, {
        type: "tool.complete",
        session_id: "s1",
        payload: { tool_id: "t1", summary: "ok" },
      }, 1_700);
      rt = reduceGatewayEvent(rt, {
        type: "message.delta",
        session_id: "s1",
        payload: { text: "最终回答不要消失。" },
      }, 1_800);
      return { ...state, s1: rt };
    });

    store.set(recoverCompletedTurnFromStoredMessagesAtom, {
      sessionId: "s1",
      now: 2_000,
      storedMessages: [
        runtimeMessage({
          id: "stored-no-final-text-yet",
          sessionId: "s1",
          role: "assistant",
          status: "complete",
          createdAt: 1_900,
          parts: [
            { type: "reasoning", text: "先检查。" },
            { type: "tool", toolCallId: "t1", name: "read", state: "done", output: "ok", startedAt: 1_600, completedAt: 1_700 },
          ],
        }),
      ],
    });

    const runtime = store.get(chatRuntimeBySessionAtom).s1;
    expect(runtime.streamStatus).toBe("streaming");
    expect(textFromParts(assistantMessage(runtime).parts)).toBe("最终回答不要消失。");
  });

  it("recovers a stale streaming assistant when stored messages already completed the turn", () => {
    const store = createStore();

    store.set(startPromptAtom, { sessionId: "s1", text: "你是什么模型?", now: 1_000 });
    store.set(chatRuntimeBySessionAtom, (state) => ({
      ...state,
      s1: reduceGatewayEvent(
        state.s1,
        {
          type: "message.delta",
          session_id: "s1",
          payload: { text: "我是 MiniMax-M2.7" },
        },
        2_000,
      ),
    }));

    store.set(recoverCompletedTurnFromStoredMessagesAtom, {
      sessionId: "s1",
      now: 3_000,
      storedMessages: [
        runtimeMessage({
          id: "stored-1",
          sessionId: "s1",
          role: "assistant",
          status: "complete",
          createdAt: 2_500,
          parts: [
            {
              type: "text",
              text: "我是 **MiniMax-M2.7**，通过 **minimax-cn** provider 运行的。",
            },
          ],
        }),
      ],
    });

    const runtime = store.get(chatRuntimeBySessionAtom).s1;
    expect(runtime.streamStatus).toBe("complete");
    expect(runtime.activeAssistantId).toBeUndefined();
    expect(runtime.turnStartedAt).toBeUndefined();
    expect(runtime.messages.map((message) => message.id)).toEqual(["live-user-1000"]);
  });
});

describe("terminateAllStreamsAtom", () => {
  it("terminates all streaming and connecting sessions", () => {
    const store = createStore();
    store.set(chatRuntimeBySessionAtom, {
      s1: { ...createEmptyChatRuntime(1), streamStatus: "streaming" },
      s2: { ...createEmptyChatRuntime(1), streamStatus: "connecting" },
      s3: createEmptyChatRuntime(1),
      s4: { ...createEmptyChatRuntime(1), streamStatus: "complete" },
      s5: { ...createEmptyChatRuntime(1), streamStatus: "error", statusMessage: "原始错误" },
    });

    store.set(terminateAllStreamsAtom);

    const result = store.get(chatRuntimeBySessionAtom);
    expect(result.s1.streamStatus).toBe("error");
    expect(result.s1.statusMessage).toBe("连接已断开");
    expect(result.s2.streamStatus).toBe("error");
    expect(result.s2.statusMessage).toBe("连接已断开");
    expect(result.s3.streamStatus).toBe("idle");
    expect(result.s4.streamStatus).toBe("complete");
    expect(result.s5.streamStatus).toBe("error");
    expect(result.s5.statusMessage).toBe("原始错误");
  });

  it("returns same reference when nothing to terminate", () => {
    const store = createStore();
    const state = {
      s1: createEmptyChatRuntime(1),
      s2: { ...createEmptyChatRuntime(1), streamStatus: "complete" as const },
    };
    store.set(chatRuntimeBySessionAtom, state);

    store.set(terminateAllStreamsAtom);

    expect(store.get(chatRuntimeBySessionAtom)).toBe(state);
  });
});

describe("drainLiveMessagesAtom", () => {
  it("returns and clears canonical runtime messages from session", () => {
    const store = createStore();
    const messages = [
      runtimeMessage({ id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] }),
      runtimeMessage({ id: "a1", role: "assistant", parts: [{ type: "text", text: "hello" }] }),
    ];
    store.set(chatRuntimeBySessionAtom, {
      s1: { ...createEmptyChatRuntime(1), messages },
    });

    const drained = store.set(drainLiveMessagesAtom, "s1");
    expect(drained).toEqual(messages);
    expect(store.get(chatRuntimeBySessionAtom).s1.messages).toEqual([]);
  });

  it("returns empty array for unknown session", () => {
    const store = createStore();
    const drained = store.set(drainLiveMessagesAtom, "nonexistent");
    expect(drained).toEqual([]);
  });

  it("retains error notice rows and drops the rest", () => {
    const store = createStore();
    store.set(chatRuntimeBySessionAtom, {
      s1: {
        ...createEmptyChatRuntime(1),
        messages: [
          runtimeMessage({ id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] }),
          runtimeMessage({ id: "a1", role: "assistant", parts: [{ type: "text", text: "hello" }] }),
          runtimeMessage({
            id: "e1",
            role: "system",
            status: "error",
            parts: [{ type: "notice", level: "error", text: "请求失败" }],
          }),
        ],
      },
    });

    const drained = store.set(drainLiveMessagesAtom, "s1");
    expect(drained.map((message) => message.role)).toEqual(["user", "assistant"]);

    const remaining = store.get(chatRuntimeBySessionAtom).s1.messages;
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toMatchObject({ role: "system", status: "error" });
  });
});

describe("manual interrupt (markSessionInterruptedAtom)", () => {
  function storeWithStreamingTurn() {
    const store = createStore();
    store.set(startPromptAtom, { sessionId: "s1", text: "你好", now: 1_000 });
    store.set(applyGatewayEventAtom, { type: "message.start", session_id: "s1", payload: {} });
    store.set(applyGatewayEventAtom, {
      type: "message.delta",
      session_id: "s1",
      payload: { text: "部分回复" },
    });
    return store;
  }

  function runtimeOf(store: ReturnType<typeof createStore>) {
    return store.get(chatRuntimeBySessionAtom).s1;
  }

  it("marks the session idle so the composer can send again", () => {
    const store = storeWithStreamingTurn();

    store.set(markSessionInterruptedAtom, "s1");

    const runtime = runtimeOf(store);
    expect(runtime.streamStatus).toBe("idle");
    expect(runtime.interrupted).toBe(true);
    expect(runtime.activeAssistantId).toBeDefined();
  });

  it("drops late stream events from the interrupted turn", () => {
    const store = storeWithStreamingTurn();
    store.set(markSessionInterruptedAtom, "s1");

    store.set(applyGatewayEventAtom, {
      type: "message.delta",
      session_id: "s1",
      payload: { text: "迟到的输出" },
    });
    store.set(applyGatewayEventAtom, {
      type: "tool.start",
      session_id: "s1",
      payload: { id: "t1", name: "shell" },
    });
    store.set(applyGatewayEventAtom, {
      type: "status.update",
      session_id: "s1",
      payload: { text: "处理中" },
    });

    const runtime = runtimeOf(store);
    expect(runtime.streamStatus).toBe("idle");
    expect(runtime.statusMessage).toBe("");
    expect(textFromParts(assistantMessage(runtime).parts)).not.toContain("迟到的输出");
    expect(assistantMessage(runtime).parts.some((part) => part.type === "tool")).toBe(false);
  });

  it("still finalizes the interrupted turn on message.complete", () => {
    const store = storeWithStreamingTurn();
    store.set(markSessionInterruptedAtom, "s1");

    store.set(applyGatewayEventAtom, {
      type: "message.complete",
      session_id: "s1",
      payload: { status: "interrupted", text: "部分回复" },
    });

    const runtime = runtimeOf(store);
    expect(assistantMessage(runtime).status).toBe("complete");
    expect(assistantMessage(runtime).metadata?.finishReason).toBe("interrupted");
    expect(runtime.interrupted).toBeUndefined();
  });

  it("resumes rendering when the next turn starts without a local prompt", () => {
    const store = storeWithStreamingTurn();
    store.set(markSessionInterruptedAtom, "s1");

    store.set(applyGatewayEventAtom, { type: "message.start", session_id: "s1", payload: {} });
    store.set(applyGatewayEventAtom, {
      type: "message.delta",
      session_id: "s1",
      payload: { text: "新回合" },
    });

    const runtime = runtimeOf(store);
    expect(runtime.interrupted).toBeUndefined();
    expect(runtime.streamStatus).toBe("streaming");
  });

  it("clears the interrupt gate when the user sends the next prompt", () => {
    const store = storeWithStreamingTurn();
    store.set(markSessionInterruptedAtom, "s1");

    store.set(startPromptAtom, { sessionId: "s1", text: "再来", now: 2_000 });

    expect(runtimeOf(store).interrupted).toBeUndefined();
  });

  it("keeps resetStreamStateAtom free of interrupt semantics (sendPrompt busy-retry path)", () => {
    const store = createStore();
    store.set(startPromptAtom, { sessionId: "s1", text: "你好", now: 1_000 });

    store.set(resetStreamStateAtom, "s1");
    store.set(applyGatewayEventAtom, { type: "message.start", session_id: "s1", payload: {} });
    store.set(applyGatewayEventAtom, {
      type: "message.delta",
      session_id: "s1",
      payload: { text: "重试回合" },
    });

    const runtime = runtimeOf(store);
    expect(runtime.streamStatus).toBe("streaming");
    const assistants = runtime.messages.filter((message) => message.role === "assistant");
    expect(textFromParts(assistants[assistants.length - 1].parts)).toContain("重试回合");
  });
});

describe("lastActivityAt (stall watchdog source)", () => {
  it("stamps lastActivityAt with the event time for applied backend events", () => {
    const base = createEmptyChatRuntime(0);
    const started = reduceGatewayEvent(base, { type: "message.start", session_id: "s1" }, 1_000);
    expect(started.lastActivityAt).toBe(1_000);

    const delta = reduceGatewayEvent(
      started,
      { type: "message.delta", session_id: "s1", payload: { text: "hi" } },
      2_500,
    );
    expect(delta.lastActivityAt).toBe(2_500);
  });

  it("does not advance lastActivityAt for dropped late events on an interrupted turn", () => {
    const interrupted = {
      ...createEmptyChatRuntime(0),
      streamStatus: "streaming" as const,
      interrupted: true,
      lastActivityAt: 1_000,
    };
    // A late stream delta from the interrupted turn is dropped (no-op) — it must
    // not count as activity, otherwise an interrupted-but-noisy turn would keep
    // resetting the watchdog.
    const next = reduceGatewayEvent(
      interrupted,
      { type: "message.delta", session_id: "s1", payload: { text: "late" } },
      9_000,
    );
    expect(next).toBe(interrupted);
    expect(next.lastActivityAt).toBe(1_000);
  });

  it("appends moa.reference blocks and keeps them ordered before the aggregator text", () => {
    const ref1 = reduceGatewayEvent(
      createEmptyChatRuntime(1),
      {
        type: "moa.reference",
        session_id: "s1",
        payload: { label: "gpt-5", text: "GPT 的分析", index: 0, count: 2 },
      },
      10,
    );
    expect(ref1.statusKind).toBe("moa_reference");
    expect(ref1.statusMessage).toContain("gpt-5");
    expect(ref1.statusMessage).toContain("1/2");

    const ref2 = reduceGatewayEvent(
      ref1,
      {
        type: "moa.reference",
        session_id: "s1",
        payload: { label: "claude", text: "Claude 的分析", index: 1, count: 2 },
      },
      20,
    );

    const aggregating = reduceGatewayEvent(
      ref2,
      { type: "moa.aggregating", session_id: "s1", payload: { aggregator: "grok-4" } },
      30,
    );
    expect(aggregating.statusKind).toBe("moa_aggregating");
    expect(aggregating.statusMessage).toContain("grok-4");

    const answered = reduceGatewayEvent(
      aggregating,
      { type: "message.delta", session_id: "s1", payload: { text: "综合结论" } },
      40,
    );
    // 聚合器开始输出后，MoA 状态提示被 provider-status 清除逻辑收走。
    expect(answered.statusKind).toBeUndefined();
    expect(assistantMessage(answered).parts).toEqual([
      { type: "moa_reference", label: "gpt-5", text: "GPT 的分析", index: 0, count: 2 },
      { type: "moa_reference", label: "claude", text: "Claude 的分析", index: 1, count: 2 },
      { type: "text", text: "综合结论" },
    ]);
  });

  it("ignores empty moa.reference payloads and keeps thinking placeholders working", () => {
    const noop = reduceGatewayEvent(
      createEmptyChatRuntime(1),
      { type: "moa.reference", session_id: "s1", payload: {} },
      10,
    );
    expect(noop.messages).toHaveLength(0);

    // 回归守卫：thinking.delta 仍走 reasoning.delta 的 fallthrough（历史上
    // 在两者之间插分支会截胡 fallthrough）。
    const placeholder = "ಠ_ಠ deliberating...";
    const thinking = reduceGatewayEvent(
      createEmptyChatRuntime(1),
      { type: "thinking.delta", session_id: "s1", payload: { text: placeholder } },
      10,
    );
    expect(assistantMessage(thinking).parts).toEqual([{ type: "progress", text: placeholder }]);
  });

  describe("empty message.delta should not create messages", () => {
    it("message.delta with empty text should NOT create a new assistant message when no turn is active", () => {
      // Simulate the real bug: backend emits empty-string deltas during
      // reasoning-to-content transitions, WITHOUT a preceding message.start.
      const now = 1000;
      let runtime = createEmptyChatRuntime(now);
      const messageCountBefore = runtime.messages.length;

      // Send an empty delta — this should be a no-op
      runtime = reduceGatewayEvent(
        runtime,
        {
          type: "message.delta",
          session_id: "s1",
          payload: { text: "" },
        },
        now + 1,
      );

      const messageCountAfter = runtime.messages.length;

      // without the fix, empty delta creates an assistant message with parts: []
      expect(messageCountAfter).toBe(messageCountBefore);
    });

    it("message.delta with real text should create an assistant message normally", () => {
      const now = 1000;
      let runtime = createEmptyChatRuntime(now);

      runtime = reduceGatewayEvent(
        runtime,
        {
          type: "message.delta",
          session_id: "s1",
          payload: { text: "Hello, world!" },
        },
        now + 1,
      );

      const assistant = runtime.messages.find((m) => m.role === "assistant");
      expect(assistant).toBeDefined();
      expect(assistant!.parts.length).toBeGreaterThan(0);
      const text = textFromParts(assistant!.parts);
      expect(text).toBe("Hello, world!");
    });

    it("message.complete removes empty assistant message (existing safety)", () => {
      const now = 1000;
      let runtime = createEmptyChatRuntime(now);
      runtime = reduceGatewayEvent(
        runtime,
        {
          type: "message.start",
          session_id: "s1",
        },
        now,
      );
      // Complete with empty text and no reasoning — parts.length === 0 → removed
      runtime = reduceGatewayEvent(
        runtime,
        {
          type: "message.complete",
          session_id: "s1",
          payload: { text: "" },
        },
        now + 1,
      );

      // Should have no assistant message after complete with empty parts
      const assistants = runtime.messages.filter((m) => m.role === "assistant");
      expect(assistants).toHaveLength(0);
    });
  });
});
