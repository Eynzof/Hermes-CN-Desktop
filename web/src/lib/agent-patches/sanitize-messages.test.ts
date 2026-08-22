/** @vitest-environment node */
import { describe, expect, it } from "vitest";
import {
  assistantHasPayload,
  isEmptyContentDroppable,
  sanitizeApiMessages,
} from "./sanitize-messages";

function assistantDictCall(
  callId: string,
  name = "terminal",
): Record<string, unknown> {
  return { id: callId, function: { name, arguments: "{}" } };
}

function toolResult(callId: string, content = "ok"): Record<string, unknown> {
  return { role: "tool", tool_call_id: callId, content };
}

describe("sanitizeApiMessages", () => {
  it("removes orphaned tool results", () => {
    const msgs: Record<string, unknown>[] = [
      { role: "assistant", tool_calls: [assistantDictCall("c1")] },
      toolResult("c1"),
      toolResult("c_ORPHAN"),
    ];
    const out = sanitizeApiMessages(msgs);
    expect(out.messages).toHaveLength(2);
    expect(out.messages.every((m) => m.tool_call_id !== "c_ORPHAN")).toBe(true);
    expect(out.orphanedResults).toBe(1);
  });

  it("injects stub result for orphaned calls", () => {
    const msgs: Record<string, unknown>[] = [
      { role: "assistant", tool_calls: [assistantDictCall("c2")] },
    ];
    const out = sanitizeApiMessages(msgs);
    expect(out.messages).toHaveLength(2);
    expect(out.messages[1].role).toBe("tool");
    expect(out.messages[1].tool_call_id).toBe("c2");
    expect(out.missingResultStubs).toBe(1);
  });

  it("passes clean messages through unchanged", () => {
    const msgs: Record<string, unknown>[] = [
      { role: "user", content: "hello" },
      { role: "assistant", tool_calls: [assistantDictCall("c3")] },
      toolResult("c3"),
      { role: "assistant", content: "done" },
    ];
    const out = sanitizeApiMessages(msgs);
    expect(out.messages).toEqual(msgs);
    expect(out.dropped).toBe(0);
  });

  it("handles mixed orphan result and orphan call", () => {
    const msgs: Record<string, unknown>[] = [
      {
        role: "assistant",
        tool_calls: [assistantDictCall("c4"), assistantDictCall("c5")],
      },
      toolResult("c4"),
      toolResult("c_DANGLING"),
    ];
    const out = sanitizeApiMessages(msgs);
    const ids = out.messages
      .filter((m) => m.role === "tool")
      .map((m) => m.tool_call_id);
    expect(ids).not.toContain("c_DANGLING");
    expect(ids).toContain("c4");
    expect(ids).toContain("c5");
  });

  it("is safe with an empty list", () => {
    const out = sanitizeApiMessages([]);
    expect(out.messages).toEqual([]);
  });

  it("drops assistant with empty content and no tool_calls", () => {
    const msgs: Record<string, unknown>[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "", tool_calls: null },
      { role: "user", content: "follow-up" },
    ];
    const out = sanitizeApiMessages(msgs);
    expect(out.messages).toHaveLength(2);
    expect(out.dropped).toBe(1);
  });

  it("drops user with empty content", () => {
    const msgs: Record<string, unknown>[] = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "" },
      { role: "assistant", content: "hi" },
    ];
    const out = sanitizeApiMessages(msgs);
    expect(out.messages).toHaveLength(2);
    expect(out.messages[0].role).toBe("system");
    expect(out.messages[1].role).toBe("assistant");
  });

  it("preserves assistant with empty content but tool_calls payload", () => {
    const msgs: Record<string, unknown>[] = [
      { role: "user", content: "search something" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "c1",
            function: { name: "web_search", arguments: "{}" },
          },
        ],
      },
      { role: "tool", tool_call_id: "c1", content: "results" },
    ];
    const out = sanitizeApiMessages(msgs);
    expect(out.messages).toHaveLength(3);
    expect(out.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
    ]);
  });

  it("preserves system with empty content", () => {
    const msgs: Record<string, unknown>[] = [
      { role: "system", content: "" },
      { role: "user", content: "hello" },
    ];
    const out = sanitizeApiMessages(msgs);
    expect(out.messages).toHaveLength(2);
  });

  it("drops function with empty content", () => {
    const msgs: Record<string, unknown>[] = [
      { role: "function", content: "" },
      { role: "user", content: "hello" },
    ];
    const out = sanitizeApiMessages(msgs);
    expect(out.messages).toHaveLength(1);
    expect(out.messages[0].role).toBe("user");
  });

  it("drops multiple consecutive empty-content messages", () => {
    const msgs: Record<string, unknown>[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "" },
      { role: "assistant", content: "" },
      { role: "user", content: "" },
      { role: "assistant", content: "final answer" },
    ];
    const out = sanitizeApiMessages(msgs);
    expect(out.messages).toHaveLength(2);
    expect(out.messages[1].content).toBe("final answer");
  });

  it("is idempotent", () => {
    const msgs: Record<string, unknown>[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "" },
      { role: "assistant", content: "final" },
    ];
    const out1 = sanitizeApiMessages(msgs);
    const out2 = sanitizeApiMessages(out1.messages);
    expect(out1.messages).toEqual(out2.messages);
  });

  it("preserves assistant with codex reasoning payload", () => {
    const msgs: Record<string, unknown>[] = [
      { role: "user", content: "continue" },
      {
        role: "assistant",
        content: "",
        finish_reason: "incomplete",
        codex_reasoning_items: [
          { type: "reasoning", id: "rs_001", encrypted_content: "enc" },
        ],
      },
    ];
    const out = sanitizeApiMessages(msgs);
    expect(out.messages).toHaveLength(2);
    expect(out.messages[1].role).toBe("assistant");
  });

  it("preserves assistant with reasoning_content payload", () => {
    const msgs: Record<string, unknown>[] = [
      { role: "user", content: "continue" },
      { role: "assistant", content: "", reasoning_content: "thinking..." },
    ];
    const out = sanitizeApiMessages(msgs);
    expect(out.messages).toHaveLength(2);
    expect(out.messages[1].reasoning_content).toBe("thinking...");
  });

  it("repairs blank tool-call names and keeps their results", () => {
    const msgs: Record<string, unknown>[] = [
      {
        role: "assistant",
        tool_calls: [{ id: "c1", function: { name: "", arguments: "{}" } }],
      },
      toolResult("c1"),
    ];
    const out = sanitizeApiMessages(msgs);
    expect(out.repairedBlankNames).toBe(1);
    const tc = (out.messages[0].tool_calls as Record<string, unknown>[])[0];
    expect((tc.function as { name: string }).name).toBe("invalid_tool_call");
  });

  it("drops messages with invalid roles", () => {
    const msgs: Record<string, unknown>[] = [
      { role: "user", content: "hello" },
      { role: "session_meta", content: "metadata" },
      { role: "assistant", content: "hi" },
    ];
    const out = sanitizeApiMessages(msgs);
    expect(out.messages).toHaveLength(2);
    expect(out.dropped).toBe(1);
  });

  it("strips empty tool_calls arrays but keeps the message", () => {
    const msgs: Record<string, unknown>[] = [
      { role: "assistant", content: "hi", tool_calls: [] },
      { role: "assistant", content: "hi", tool_calls: null },
    ];
    const out = sanitizeApiMessages(msgs);
    expect(out.messages).toHaveLength(2);
    expect(out.messages.every((m) => !("tool_calls" in m))).toBe(true);
    expect(out.droppedEmptyToolCalls).toBe(2);
  });

  it("deduplicates repeated tool_call_ids", () => {
    const msgs: Record<string, unknown>[] = [
      {
        role: "assistant",
        tool_calls: [
          assistantDictCall("c1", "a"),
          assistantDictCall("c1", "b"),
        ],
      },
      toolResult("c1"),
    ];
    const out = sanitizeApiMessages(msgs);
    expect(out.duplicateToolCallIds).toBe(1);
    expect((out.messages[0].tool_calls as unknown[]).length).toBe(1);
  });
});

describe("isEmptyContentDroppable", () => {
  it("keeps null content", () => {
    expect(
      isEmptyContentDroppable({ role: "assistant", content: null }),
    ).toBe(false);
  });

  it("drops exactly empty string for user", () => {
    expect(isEmptyContentDroppable({ role: "user", content: "" })).toBe(true);
  });

  it("keeps assistant with payload", () => {
    expect(
      isEmptyContentDroppable({
        role: "assistant",
        content: "",
        tool_calls: [{ id: "x" }],
      }),
    ).toBe(false);
  });
});

describe("assistantHasPayload", () => {
  it("detects reasoning_content", () => {
    expect(assistantHasPayload({ reasoning_content: "x" })).toBe(true);
  });

  it("detects non-empty tool_calls", () => {
    expect(assistantHasPayload({ tool_calls: [{ id: "x" }] })).toBe(true);
  });

  it("ignores empty tool_calls", () => {
    expect(assistantHasPayload({ tool_calls: [] })).toBe(false);
  });
});
