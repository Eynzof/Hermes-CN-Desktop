import { describe, expect, it } from "vitest";
import type { MessagesResponse } from "@hermes/protocol";
import {
  branchRuntimeMessages,
  sessionBranchCreateParams,
  sessionBranchMessages,
  withOptimisticBranch,
} from "./session-branch";

function response(): MessagesResponse {
  return {
    session_id: "parent",
    messages: [
      { id: 1, session_id: "parent", role: "user", content: "  第一问  ", timestamp: 1 },
      { id: 2, session_id: "parent", role: "assistant", content: "第一答", timestamp: 2 },
      { id: 3, session_id: "parent", role: "system", content: "系统记录", timestamp: 3 },
      { id: 4, session_id: "parent", role: "tool", content: "工具记录", timestamp: 4 },
      { id: 5, session_id: "parent", role: "assistant", content: "   ", timestamp: 5 },
      { id: 6, session_id: "parent", role: "user", content: "第二问", timestamp: 6 },
    ],
  };
}

describe("session branch messages", () => {
  it("copies only visible user and assistant text in source order", () => {
    expect(sessionBranchMessages(response()).map(({ role, content }) => ({ role, content }))).toEqual([
      { role: "user", content: "第一问" },
      { role: "assistant", content: "第一答" },
      { role: "user", content: "第二问" },
    ]);
  });

  it("re-keys optimistic messages into the branch runtime", () => {
    const runtimeMessages = branchRuntimeMessages(sessionBranchMessages(response()), "runtime-child");

    expect(runtimeMessages.map((message) => message.sessionId)).toEqual([
      "runtime-child",
      "runtime-child",
      "runtime-child",
    ]);
    expect(runtimeMessages.every((message) => message.status === "complete")).toBe(true);
    expect(new Set(runtimeMessages.map((message) => message.id)).size).toBe(3);
  });

  it("matches the official Core session.create branch contract", () => {
    const messages = sessionBranchMessages(response());

    expect(sessionBranchCreateParams(" parent ", " /workspace/demo ", messages)).toEqual({
      cols: 96,
      source: "desktop",
      parent_session_id: "parent",
      cwd: "/workspace/demo",
      messages: [
        { role: "user", content: "第一问" },
        { role: "assistant", content: "第一答" },
        { role: "user", content: "第二问" },
      ],
    });
  });

  it("adds a branch draft to session-list caches without duplicating it", () => {
    const branch = {
      id: "child",
      parent_session_id: "parent",
      model: "model",
      title: "草稿：分叉",
      started_at: 2,
      ended_at: null,
      message_count: 2,
      input_tokens: 0,
      output_tokens: 0,
      estimated_cost_usd: null,
    };
    const initial = {
      sessions: [{ ...branch, id: "parent", parent_session_id: null }],
      total: 1,
      limit: 50,
      offset: 0,
    };

    const added = withOptimisticBranch(initial, branch)!;
    const repeated = withOptimisticBranch(added, branch)!;

    expect(added.sessions.map((session) => session.id)).toEqual(["child", "parent"]);
    expect(repeated.sessions.map((session) => session.id)).toEqual(["child", "parent"]);
    expect(repeated.total).toBe(2);
  });
});
