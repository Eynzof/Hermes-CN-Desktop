// Group chat (P-048) completion-race regression. Real timeline (from logs):
// default completes, reviewer starts ~155ms later, then a completed-turn
// transcript refetch fires while reviewer is still progress-only. The recovery
// logic used to match reviewer's progress-only bubble to default's stored
// completion (no sender compare), delete it, and let reviewer's later deltas
// rebuild a sender-less bubble that merged into default — giving 3 bubbles.
// The whole migration must end with exactly TWO bubbles, one per member.
import { createStore } from "jotai/vanilla";
import { describe, expect, it } from "vitest";

import type { GatewayEvent, HermesUIMessage } from "@hermes/protocol";

import {
  applyGatewayEventAtom,
  chatRuntimeBySessionAtom,
  ensureChatSessionAtom,
  recoverCompletedTurnFromStoredMessagesAtom,
} from "./chat";

const SID = "gc_race";

function ev(type: string, payload: Record<string, unknown>): GatewayEvent {
  return { type, session_id: SID, payload } as unknown as GatewayEvent;
}

function textOf(message: HermesUIMessage): string {
  return message.parts
    .filter((p): p is Extract<HermesUIMessage["parts"][number], { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join(" ");
}

describe("group chat @all completion race (P-048)", () => {
  it("default completes, reviewer starts, transcript refetch mid-turn, reviewer streams — stays two bubbles", () => {
    const store = createStore();
    store.set(ensureChatSessionAtom, SID);

    // default: start → delta → complete
    store.set(applyGatewayEventAtom, ev("message.start", { sender_agent_id: "default", sender_name: "default" }));
    store.set(applyGatewayEventAtom, ev("message.delta", { text: "default 的回复", sender_agent_id: "default", sender_name: "default" }));
    store.set(applyGatewayEventAtom, ev("message.complete", { text: "default 的回复", status: "complete", sender_agent_id: "default", sender_name: "default" }));

    // reviewer starts ~155ms later — only progress, no body yet.
    store.set(applyGatewayEventAtom, ev("message.start", { sender_agent_id: "reviewer", sender_name: "reviewer" }));

    // Completed-turn refetch fires while reviewer is progress-only. The
    // transcript so far has ONLY default's completion.
    const storedDefault: HermesUIMessage = {
      id: "stored-default",
      sessionId: SID,
      role: "assistant",
      createdAt: Date.now(),
      status: "complete",
      parts: [{ type: "text", text: "default 的回复" }],
      senderAgentId: "default",
      senderName: "default",
    };
    store.set(recoverCompletedTurnFromStoredMessagesAtom, { sessionId: SID, storedMessages: [storedDefault] });

    // reviewer streams its own reply.
    store.set(applyGatewayEventAtom, ev("message.delta", { text: "reviewer 的回复", sender_agent_id: "reviewer", sender_name: "reviewer" }));
    store.set(applyGatewayEventAtom, ev("message.complete", { text: "reviewer 的回复", status: "complete", sender_agent_id: "reviewer", sender_name: "reviewer" }));

    const runtime = store.get(chatRuntimeBySessionAtom)[SID];
    const assistants = (runtime?.messages ?? []).filter((m) => m.role === "assistant");
    expect(assistants).toHaveLength(2);
    expect(assistants.map((m) => m.senderName)).toEqual(["default", "reviewer"]);
    expect(textOf(assistants[0]!)).toContain("default");
    expect(textOf(assistants[1]!)).toContain("reviewer");
  });
});
