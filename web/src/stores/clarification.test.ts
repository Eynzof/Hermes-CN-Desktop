import { createStore } from "jotai/vanilla";
import { describe, expect, it } from "vitest";
import { parseGatewayEvent } from "@hermes/protocol";
import {
  applyGatewayEventAtom, chatRuntimeBySessionAtom, markSessionInterruptedAtom,
  removeClarificationAtom,
} from "./chat";

const request = (sid: string, rid: string) => parseGatewayEvent({
  type: "clarify.request", session_id: sid,
  payload: { request_id: rid, question: "选择目标", choices: ["甲", "乙"], multi_select: true },
});

describe("clarification lifecycle", () => {
  it("preserves choices and scopes answers to their session and request", () => {
    const store = createStore();
    store.set(applyGatewayEventAtom, request("a", "a1"));
    store.set(applyGatewayEventAtom, request("a", "a1"));
    store.set(applyGatewayEventAtom, request("b", "b1"));
    const pending = store.get(chatRuntimeBySessionAtom).a.pendingClarifications!;
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ choices: ["甲", "乙"], multiSelect: true });
    store.set(removeClarificationAtom, pending[0]);
    expect(store.get(chatRuntimeBySessionAtom).a.pendingClarifications).toEqual([]);
    expect(store.get(chatRuntimeBySessionAtom).b.pendingClarifications).toHaveLength(1);
  });

  it("expires only the matching question", () => {
    const store = createStore();
    store.set(applyGatewayEventAtom, request("a", "first"));
    store.set(applyGatewayEventAtom, request("a", "second"));
    store.set(applyGatewayEventAtom, parseGatewayEvent({type: "clarify.expire", session_id: "a", payload: {request_id: "first"}}));
    expect(store.get(chatRuntimeBySessionAtom).a.pendingClarifications?.map(r => r.requestId)).toEqual(["second"]);
  });

  it("removes interrupted questions and ignores late requests", () => {
    const store = createStore();
    store.set(applyGatewayEventAtom, request("a", "a1"));
    store.set(markSessionInterruptedAtom, "a");
    store.set(applyGatewayEventAtom, request("a", "late"));
    expect(store.get(chatRuntimeBySessionAtom).a.pendingClarifications).toEqual([]);
  });

  it("removes cards when the turn finishes", () => {
    const store = createStore();
    store.set(applyGatewayEventAtom, request("a", "a1"));
    store.set(applyGatewayEventAtom, parseGatewayEvent({type: "message.complete", session_id: "a", payload: {}}));
    expect(store.get(chatRuntimeBySessionAtom).a.pendingClarifications).toEqual([]);
  });
});
