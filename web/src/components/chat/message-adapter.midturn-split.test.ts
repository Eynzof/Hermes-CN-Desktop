// 复现：回合进行中消息「裂开」成两条——上面一条在更新进度，下面一条是死的。
//
// 真实形态（对照 ~/.hermes/state.db 的行序）：Core 在回合**进行中**就把每个
// tool_calls 步骤各写成一行 assistant。此时若 session-messages 被重新拉取
// （refetchOnWindowFocus，或上一回合 message.complete 后 500ms 的 invalidate
// 落到了新回合里），stored 里就出现「半个回合」。
//
// live 侧是一整条 streaming 的 assistant，且它比 stored 半行**跑得更远**
// （已经发起了 stored 里还没有的下一个工具调用）。此时：
//   - 工具身份守卫：双方工具集不同 → isSameCanonicalMessage 直接否决；
//   - isReplayDuplicateLiveMessage：要求 stored 是 complete 且 live 工具集是
//     stored 的前缀 —— 这里方向相反（live 是超集），不命中；
//   - isSupersededByStoredTurn：要求 live 已 complete —— 流式中不命中。
// 于是 stored 半行原样保留、live 整条被追加 → 两条 assistant 同时在列。
//
// 排序：live 的 createdAt = turnStartedAt（回合开始），stored 半行的
// timestamp 是回合中途，因此 live 在上、stored 死行在下 —— 正是截图形态：
// 上面那条实时更新进度，下面那条永远不动。
import { describe, expect, it } from "vitest";

import type { HermesUIMessage, SessionMessage } from "@hermes/protocol";

import {
  legacySessionMessagesToHermesUIMessages,
  mergeHermesUIMessages,
} from "./message-adapter";

const SID = "sess-midturn";

// 回合时间线（秒，对照真实库里的 timestamp 间隔）
const T_USER = 1784085354;
const T_STEP1 = 1784085367; // 第一个 tool_calls 步骤落库
const T_STEP2 = 1784085386; // 第二个步骤落库，且这一行已带正文

const TOOL_1 = "call_midturn_aaaa1111";
const TOOL_2 = "call_midturn_bbbb2222";
const TOOL_3 = "call_midturn_cccc3333"; // live 已发起、stored 尚未落库

function row(partial: Partial<SessionMessage> & { role: string; id: number }): SessionMessage {
  return {
    session_id: SID,
    content: "",
    ...partial,
  } as SessionMessage;
}

function toolCall(id: string, name: string, args: Record<string, unknown>) {
  return {
    id,
    type: "function" as const,
    function: { name, arguments: JSON.stringify(args) },
  };
}

function toolPart(id: string, name: string, output: string) {
  return { type: "tool" as const, toolCallId: id, name, state: "done" as const, output };
}

// stored：回合**还没结束**时拉到的半个回合。
function midTurnStoredRows(): SessionMessage[] {
  return [
    row({ id: 1, role: "user", content: "帮我查一下这个问题", timestamp: T_USER }),
    row({
      id: 2,
      role: "assistant",
      content: "",
      timestamp: T_STEP1,
      finish_reason: "tool_calls",
      tool_calls: [toolCall(TOOL_1, "search_files", { pattern: "foo" })],
    }),
    row({
      id: 3,
      role: "tool",
      tool_call_id: TOOL_1,
      tool_name: "search_files",
      content: "hit a.ts\nhit b.ts",
      timestamp: T_STEP1,
    }),
    row({
      id: 4,
      role: "assistant",
      content: "我先看看这两个文件。",
      timestamp: T_STEP2,
      finish_reason: "tool_calls",
      tool_calls: [toolCall(TOOL_2, "read_file", { path: "a.ts" })],
    }),
    row({
      id: 5,
      role: "tool",
      tool_call_id: TOOL_2,
      tool_name: "read_file",
      content: "export const a = 1;",
      timestamp: T_STEP2,
    }),
  ];
}

// live：一整条仍在流式的 assistant，已经跑到 stored 之后的第三个工具。
function liveStreamingTurn(): HermesUIMessage[] {
  return [
    {
      id: "live-user-1784085354000",
      sessionId: SID,
      role: "user",
      createdAt: T_USER * 1000,
      status: "complete",
      parts: [{ type: "text", text: "帮我查一下这个问题" }],
    },
    {
      id: "live-assistant-1784085354000",
      sessionId: SID,
      role: "assistant",
      // 关键：reducer 用 turnStartedAt 作为 createdAt，即回合开始时刻，
      // 早于 stored 半行的中途 timestamp。
      createdAt: T_USER * 1000,
      status: "streaming",
      parts: [
        toolPart(TOOL_1, "search_files", "hit a.ts\nhit b.ts"),
        { type: "text", text: "我先看看这两个文件。" },
        toolPart(TOOL_2, "read_file", "export const a = 1;"),
        // live 比 stored 跑得更远：这一步 stored 里还没有。
        toolPart(TOOL_3, "read_file", "export const b = 2;"),
        { type: "progress", text: "正在读取文件…" },
      ],
    },
  ];
}

describe("回合进行中被重新拉取历史：消息不应裂成两条", () => {
  it("stored 半个回合 + live 流式整条，合并后只保留一条 assistant", () => {
    const stored = legacySessionMessagesToHermesUIMessages(midTurnStoredRows());
    const merged = mergeHermesUIMessages(stored, liveStreamingTurn());
    const assistants = merged.filter((m) => m.role === "assistant");

    expect(assistants).toHaveLength(1);
  });

  it("裂开时的形态：live(streaming) 在上、stored 死行(complete) 在下", () => {
    const stored = legacySessionMessagesToHermesUIMessages(midTurnStoredRows());
    const merged = mergeHermesUIMessages(stored, liveStreamingTurn());
    const assistants = merged.filter((m) => m.role === "assistant");

    // 若 bug 复现，这里就是截图里的两条：上面 streaming、下面 complete。
    expect(assistants.map((m) => m.status)).toEqual(["streaming"]);
  });

  it("仍在流式的那条必须存活（进度能继续更新）", () => {
    const stored = legacySessionMessagesToHermesUIMessages(midTurnStoredRows());
    const merged = mergeHermesUIMessages(stored, liveStreamingTurn());
    const streaming = merged.filter((m) => m.role === "assistant" && m.status === "streaming");

    expect(streaming).toHaveLength(1);
  });
});
