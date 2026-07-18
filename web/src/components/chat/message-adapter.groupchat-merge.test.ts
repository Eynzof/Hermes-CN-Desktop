// Group chat (P-048) regression: the real-time merge path must not lose a
// member's identity. `startPrompt` inserts a sender-less optimistic assistant
// placeholder; `message.start` then opens the member's own (sender-tagged)
// bubble. consolidateAssistantMessages used to fold adjacent assistants keeping
// the first (placeholder) identity, so the completed bubble reverted to the
// global assistant. It must instead adopt the member's sender, and must NOT
// merge two distinct members into one bubble.
import { describe, expect, it } from "vitest";

import type { HermesUIMessage } from "@hermes/protocol";

import { consolidateAssistantMessages } from "./message-adapter";

const SID = "gc_test";

function assistant(partial: Partial<HermesUIMessage>): HermesUIMessage {
  return {
    id: "x",
    sessionId: SID,
    role: "assistant",
    createdAt: 1,
    status: "complete",
    parts: [],
    ...partial,
  } as HermesUIMessage;
}

describe("consolidateAssistantMessages — group chat identity (P-048)", () => {
  it("sender-less placeholder adopts the member's identity", () => {
    const placeholder = assistant({ id: "ph", status: "streaming", parts: [] });
    const member = assistant({
      id: "m1",
      parts: [{ type: "text", text: "hi" }],
      senderAgentId: "e2ea",
      senderName: "e2ea",
    });
    const out = consolidateAssistantMessages([placeholder, member]);
    expect(out).toHaveLength(1);
    expect(out[0].senderName).toBe("e2ea");
    expect(out[0].senderAgentId).toBe("e2ea");
  });

  it("distinct members stay separate bubbles", () => {
    const alice = assistant({
      id: "a",
      parts: [{ type: "text", text: "A" }],
      senderAgentId: "alice",
      senderName: "alice",
    });
    const bob = assistant({
      id: "b",
      parts: [{ type: "text", text: "B" }],
      senderAgentId: "bob",
      senderName: "bob",
    });
    const out = consolidateAssistantMessages([alice, bob]);
    expect(out.map((m) => m.senderName)).toEqual(["alice", "bob"]);
  });

  it("single-agent assistants still merge (no regression)", () => {
    const a = assistant({ id: "a", parts: [{ type: "text", text: "A" }] });
    const b = assistant({ id: "b", parts: [{ type: "text", text: "B" }] });
    const out = consolidateAssistantMessages([a, b]);
    expect(out).toHaveLength(1);
    expect(out[0].senderName).toBeUndefined();
  });
});
