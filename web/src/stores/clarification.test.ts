import { createStore } from "jotai/vanilla";
import { describe, expect, it } from "vitest";
import { parseGatewayEvent } from "@hermes/protocol";
import {
  applyGatewayEventAtom, chatRuntimeBySessionAtom, markSessionInterruptedAtom,
  recordClarificationAnswerAtom, removeClarificationAtom,
} from "./chat";

const request = (sid: string, rid: string) => parseGatewayEvent({
  type: "clarify.request", session_id: sid,
  payload: { request_id: rid, question: "选择目标", choices: ["甲", "乙"], multi_select: true },
});

// The gateway's native shape for a multi-question clarify (what the desktop UI
// used to drop on the floor — no card, agent waiting until timeout).
const batchRequest = (sid: string, rid: string) => parseGatewayEvent({
  type: "clarify.request", session_id: sid,
  payload: {
    request_id: rid,
    questions: [
      { qid: "q0", question: "先说哪个？", choices: ["背景", "结论"], multi_select: false },
      { qid: "q1", question: "要多长？", choices: [], multi_select: false },
    ],
  },
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

  it("keeps a multi-question batch instead of dropping it", () => {
    const store = createStore();
    store.set(applyGatewayEventAtom, batchRequest("a", "b1"));
    const pending = store.get(chatRuntimeBySessionAtom).a.pendingClarifications!;
    expect(pending).toHaveLength(1);
    expect(pending[0].requestId).toBe("b1");
    expect(pending[0].questions?.map((q) => q.qid)).toEqual(["q0", "q1"]);
    expect(pending[0].questions?.[0].choices).toEqual(["背景", "结论"]);
    expect(pending[0].questions?.[1].choices).toEqual([]);
    expect(pending[0].answers).toEqual({});
  });

  it("records batch answers per qid and clears with the request", () => {
    const store = createStore();
    store.set(applyGatewayEventAtom, batchRequest("a", "b1"));
    store.set(recordClarificationAnswerAtom, { sessionId: "a", requestId: "b1", qid: "q0", answer: "结论" });
    store.set(recordClarificationAnswerAtom, { sessionId: "a", requestId: "b1", qid: "q1", answer: "短一点" });
    const entry = store.get(chatRuntimeBySessionAtom).a.pendingClarifications![0];
    expect(entry.answers).toEqual({ q0: "结论", q1: "短一点" });
    store.set(removeClarificationAtom, entry);
    expect(store.get(chatRuntimeBySessionAtom).a.pendingClarifications).toEqual([]);
  });
});
