// 安全边界：中间态 stored 行只在「同一回合仍在流式」时才让位，不能变成历史丢失。
//
// isStoredRowAbsorbedByStreamingLive 会在回合进行中丢掉已被 live 覆盖的 stored
// 半行。必须确认：
//   1. 回合结束（live 不再 streaming / live 清空）后，stored 行原样回来；
//   2. 不同回合（toolCallId 不同）的 stored 行绝不会被误吞；
//   3. 无工具的纯文本 stored 行不受影响。
import { describe, expect, it } from "vitest";

import type { HermesUIMessage, SessionMessage } from "@hermes/protocol";

import {
  legacySessionMessagesToHermesUIMessages,
  mergeHermesUIMessages,
} from "./message-adapter";

const SID = "sess-safety";
const T0 = 1784090000;

const TOOL_OLD = "call_safety_old_1111"; // 上一回合
const TOOL_CUR = "call_safety_cur_2222"; // 当前回合，stored 已落库
const TOOL_NEW = "call_safety_new_3333"; // 当前回合，仅 live 有

function row(partial: Partial<SessionMessage> & { role: string; id: number }): SessionMessage {
  return { session_id: SID, content: "", ...partial } as SessionMessage;
}

function toolCall(id: string, name: string) {
  return { id, type: "function" as const, function: { name, arguments: "{}" } };
}

function toolPart(id: string, name: string, output: string) {
  return { type: "tool" as const, toolCallId: id, name, state: "done" as const, output };
}

// 上一回合（已完结）+ 当前回合的中间态半行。
function storedRows(): SessionMessage[] {
  return [
    row({ id: 1, role: "user", content: "第一个问题", timestamp: T0 }),
    row({
      id: 2,
      role: "assistant",
      content: "上一回合的结论。",
      timestamp: T0 + 5,
      finish_reason: "tool_calls",
      tool_calls: [toolCall(TOOL_OLD, "search_files")],
    }),
    row({
      id: 3,
      role: "tool",
      tool_call_id: TOOL_OLD,
      tool_name: "search_files",
      content: "old hit",
      timestamp: T0 + 5,
    }),
    row({ id: 4, role: "user", content: "第二个问题", timestamp: T0 + 100 }),
    row({
      id: 5,
      role: "assistant",
      content: "正在处理第二个问题。",
      timestamp: T0 + 110,
      finish_reason: "tool_calls",
      tool_calls: [toolCall(TOOL_CUR, "read_file")],
    }),
    row({
      id: 6,
      role: "tool",
      tool_call_id: TOOL_CUR,
      tool_name: "read_file",
      content: "cur content",
      timestamp: T0 + 110,
    }),
  ];
}

function liveTurn(status: "streaming" | "complete"): HermesUIMessage[] {
  return [
    {
      id: "live-assistant-current",
      sessionId: SID,
      role: "assistant",
      createdAt: (T0 + 100) * 1000,
      status,
      parts: [
        toolPart(TOOL_CUR, "read_file", "cur content"),
        { type: "text", text: "正在处理第二个问题。" },
        toolPart(TOOL_NEW, "read_file", "new content"),
      ],
    },
  ];
}

describe("中间态吞并的安全边界", () => {
  it("回合仍在流式：当前回合的 stored 半行让位，但上一回合完好无损", () => {
    const stored = legacySessionMessagesToHermesUIMessages(storedRows());
    const merged = mergeHermesUIMessages(stored, liveTurn("streaming"));

    // 上一回合的工具卡必须还在。
    const allTools = merged.flatMap((m) =>
      m.parts.filter((p) => p.type === "tool").map((p) => (p as { toolCallId: string }).toolCallId),
    );
    expect(allTools).toContain(TOOL_OLD);

    // 当前回合只剩一条（仍在流式的那条）。
    const streaming = merged.filter((m) => m.role === "assistant" && m.status === "streaming");
    expect(streaming).toHaveLength(1);
  });

  it("回合已结束（live 不再 streaming）：stored 行不被丢弃", () => {
    const stored = legacySessionMessagesToHermesUIMessages(storedRows());
    const merged = mergeHermesUIMessages(stored, liveTurn("complete"));

    const allTools = merged.flatMap((m) =>
      m.parts.filter((p) => p.type === "tool").map((p) => (p as { toolCallId: string }).toolCallId),
    );
    // 两个回合的工具卡都要在，一个都不能少。
    expect(allTools).toContain(TOOL_OLD);
    expect(allTools).toContain(TOOL_CUR);
  });

  it("live 清空（刷新后纯历史渲染）：stored 全量保留", () => {
    const stored = legacySessionMessagesToHermesUIMessages(storedRows());
    const merged = mergeHermesUIMessages(stored, []);

    expect(merged).toEqual(stored);
    const allTools = merged.flatMap((m) =>
      m.parts.filter((p) => p.type === "tool").map((p) => (p as { toolCallId: string }).toolCallId),
    );
    expect(allTools).toEqual([TOOL_OLD, TOOL_CUR]);
  });

  it("纯文本 stored 行（无工具）不受影响", () => {
    const textOnly: SessionMessage[] = [
      row({ id: 1, role: "user", content: "你好", timestamp: T0 }),
      row({ id: 2, role: "assistant", content: "你好，有什么可以帮你？", timestamp: T0 + 2 }),
    ];
    const stored = legacySessionMessagesToHermesUIMessages(textOnly);
    const live: HermesUIMessage[] = [
      {
        id: "live-assistant-text",
        sessionId: SID,
        role: "assistant",
        createdAt: (T0 + 50) * 1000,
        status: "streaming",
        parts: [toolPart(TOOL_NEW, "read_file", "x"), { type: "text", text: "你好，有什么可以帮你？" }],
      },
    ];

    const merged = mergeHermesUIMessages(stored, live);
    // 那条纯文本历史回复必须还在。
    const texts = merged.flatMap((m) =>
      m.parts.filter((p) => p.type === "text").map((p) => (p as { text: string }).text),
    );
    expect(texts).toContain("你好，有什么可以帮你？");
  });
});
