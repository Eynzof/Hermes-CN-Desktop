// 回归：多轮 assistant 文本完全相同（模板化回复）时的 stored/live 合并错配
// （P-047 冒烟发现，委派场景把它变成高频路径）。
//
// 真实形态：会话里有多轮 CLI 委派，每轮 assistant 的总结文本一字不差
// （"任务已完成" 类模板回复），但 toolCallId 不同。刷新/重连后 live store
// 只含最近一轮。isSameCanonicalMessage 若只比文本，早先回合的 stored 行会
// 吃掉 live 的最近回合：那一轮 stored 行落空后整行追加 → 同一张工具卡双份，
// 且早先回合的工具卡凭空消失。工具身份守卫（toolCallId 集不同 → 非同一条
// 消息）修复此错配。
import { describe, expect, it } from "vitest";

import type { HermesUIMessage, SessionMessage } from "@hermes/protocol";

import {
  legacySessionMessagesToHermesUIMessages,
  mergeHermesUIMessages,
} from "./message-adapter";

const SID = "sess-merge";
const TOOL_ID_TURN1 = "call_e2e_f37c7d9b80a1";
const TOOL_ID_TURN3 = "call_e2e_74e995be6619";
const COMMAND = "/tmp/p047-stub-bin/claude -p '后台委派' --output-format stream-json --verbose";
const DONE_TEXT = "DELEGATION-E2E-DONE：外部编码代理已完成任务。";

let nextRowId = 1;
function legacyRow(partial: Partial<SessionMessage> & { role: string }): SessionMessage {
  nextRowId += 1;
  return {
    id: nextRowId,
    session_id: SID,
    content: "",
    ...partial,
  } as SessionMessage;
}

function delegationTurnRows(toolId: string, prompt: string): SessionMessage[] {
  return [
    legacyRow({ role: "user", content: `delegate-cli-e2e:${prompt}` }),
    legacyRow({
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: toolId,
          type: "function",
          function: {
            name: "terminal",
            arguments: JSON.stringify({ command: COMMAND, background: true }),
          },
        },
      ],
    }),
    legacyRow({
      role: "tool",
      tool_call_id: toolId,
      content:
        '{"output":"Background process started","session_id":"proc_d1","pid":4242,"exit_code":0,"error":null}',
    }),
    // 关键：每轮总结文本一字不差（模板化回复）。
    legacyRow({ role: "assistant", content: DONE_TEXT }),
  ];
}

function storedRows(): HermesUIMessage[] {
  return legacySessionMessagesToHermesUIMessages([
    ...delegationTurnRows(TOOL_ID_TURN1, "第一轮"),
    legacyRow({ role: "user", content: "你好" }),
    legacyRow({ role: "assistant", content: "PONG: 收到「你好」" }),
    ...delegationTurnRows(TOOL_ID_TURN3, "第三轮"),
  ]);
}

// 刷新后的 live store：只含最近一轮（resume 后新发的回合）。
function liveMessages(): HermesUIMessage[] {
  return [
    {
      id: "live-user-1",
      sessionId: SID,
      role: "user",
      createdAt: 3000,
      status: "complete",
      parts: [{ type: "text", text: "delegate-cli-e2e:第三轮" }],
    },
    {
      id: "live-assistant-1",
      sessionId: SID,
      role: "assistant",
      createdAt: 3100,
      status: "complete",
      parts: [
        {
          type: "tool",
          toolCallId: TOOL_ID_TURN3,
          name: "terminal",
          state: "done",
          input: { context: `Running ${COMMAND.slice(0, 80)}` },
          output: "Background process started",
          startedAt: 3100,
          completedAt: 3200,
        },
        { type: "text", text: DONE_TEXT },
        // chat store 会在 reasoning 可用时附带 reasoning part（与正文同文）。
        { type: "reasoning", text: DONE_TEXT },
      ],
    },
  ] as HermesUIMessage[];
}

function toolPartCounts(messages: HermesUIMessage[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === "tool") {
        counts[part.toolCallId] = (counts[part.toolCallId] ?? 0) + 1;
      }
    }
  }
  return counts;
}

describe("多轮同文本 assistant 的 stored/live 合并", () => {
  it("每个 toolCallId 恰出现一次：不双份、不吞卡", () => {
    const merged = mergeHermesUIMessages(storedRows(), liveMessages());
    expect(toolPartCounts(merged)).toEqual({
      [TOOL_ID_TURN1]: 1,
      [TOOL_ID_TURN3]: 1,
    });
  });

  it("live 只有半个回合（文本未流完）时同样不错配到早先回合", () => {
    const live = liveMessages();
    const assistant = live[1]!;
    assistant.status = "streaming";
    assistant.parts = assistant.parts.filter((part) => part.type === "tool");
    const merged = mergeHermesUIMessages(storedRows(), live);
    expect(toolPartCounts(merged)).toEqual({
      [TOOL_ID_TURN1]: 1,
      [TOOL_ID_TURN3]: 1,
    });
  });
});
