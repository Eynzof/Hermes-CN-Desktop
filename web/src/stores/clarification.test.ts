import { createStore } from "jotai/vanilla";
import { describe, expect, it } from "vitest";
import { parseGatewayEvent } from "@hermes/protocol";
import { isRuntimeRunning, streamSilenceMs } from "@/lib/session-activity";
import {
  applyGatewayEventAtom, chatRuntimeBySessionAtom, markSessionInterruptedAtom,
  recordClarificationAnswerAtom, removeClarificationAtom, restorePendingClarificationAtom,
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

  it("keeps a single question delivered in the batch format", () => {
    const store = createStore();
    store.set(applyGatewayEventAtom, parseGatewayEvent({
      type: "clarify.request", session_id: "a",
      payload: { request_id: "only", questions: [{ qid: "q0", question: "继续吗？" }] },
    }));
    expect(store.get(chatRuntimeBySessionAtom).a.pendingClarifications?.[0].questions)
      .toEqual([{ qid: "q0", question: "继续吗？", choices: [], multiSelect: false }]);
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

describe("resuming a waiting clarification", () => {
  const session = "live-session";
  const batch = {
    request_id: "original-id",
    questions: [
      { qid: "q0", question: "颜色", choices: ["红", "绿"] },
      { qid: "q1", question: "形状", choices: ["圆", "方"] },
    ],
    answers: { q0: "绿" },
  };

  it("restores a single choice and its original reply address", () => {
    const store = createStore();
    store.set(restorePendingClarificationAtom, session, {
      request_id: "single-id", question: "饮料", choices: ["茶", "水"],
    });
    expect(store.get(chatRuntimeBySessionAtom)[session].pendingClarifications).toMatchObject([
      { sessionId: session, requestId: "single-id", question: "饮料", choices: ["茶", "水"] },
    ]);
  });

  it("restores acknowledged batch answers even when the live request is replayed", () => {
    const store = createStore();
    store.set(restorePendingClarificationAtom, session, batch);
    store.set(applyGatewayEventAtom, parseGatewayEvent({
      type: "clarify.request", session_id: session, payload: { ...batch, answers: undefined },
    }));
    const cards = store.get(chatRuntimeBySessionAtom)[session].pendingClarifications!;
    expect(isRuntimeRunning(store.get(chatRuntimeBySessionAtom)[session])).toBe(true);
    expect(streamSilenceMs(store.get(chatRuntimeBySessionAtom)[session])).toBeNull();
    expect(cards).toHaveLength(1);
    expect(cards[0].answers).toEqual({ q0: "绿" });
    expect(cards[0].questions!.find(q => !(q.qid in cards[0].answers!))?.qid).toBe("q1");
  });

  it("refreshes the same live request without duplicating it", () => {
    const store = createStore();
    store.set(applyGatewayEventAtom, parseGatewayEvent({
      type: "clarify.request", session_id: session, payload: { ...batch, answers: undefined },
    }));
    store.set(restorePendingClarificationAtom, session, batch);
    expect(store.get(chatRuntimeBySessionAtom)[session].pendingClarifications).toMatchObject([
      { requestId: "original-id", answers: { q0: "绿" } },
    ]);
  });

  it("replaces a question resolved elsewhere with the one now waiting", () => {
    const store = createStore();
    store.set(applyGatewayEventAtom, request(session, "already-resolved"));
    store.set(restorePendingClarificationAtom, session, batch);
    expect(store.get(chatRuntimeBySessionAtom)[session].pendingClarifications?.map(card => card.requestId))
      .toEqual(["original-id"]);
  });

  it("stops displaying a restored idle session as busy after its request expires", () => {
    const store = createStore();
    store.set(restorePendingClarificationAtom, session, batch);
    store.set(applyGatewayEventAtom, parseGatewayEvent({
      type: "clarify.expire", session_id: session, payload: { request_id: "original-id" },
    }));
    expect(isRuntimeRunning(store.get(chatRuntimeBySessionAtom)[session])).toBe(false);
  });

  it("closes a batch whose last answer has already been accepted", () => {
    const store = createStore();
    store.set(restorePendingClarificationAtom, session, batch);
    store.set(restorePendingClarificationAtom, session, { ...batch, answers: { q0: "绿", q1: "圆" } });
    expect(store.get(chatRuntimeBySessionAtom)[session].pendingClarifications).toEqual([]);
  });

  it("clears a resolved prompt only in the resumed session", () => {
    const store = createStore();
    store.set(applyGatewayEventAtom, request(session, "expired"));
    store.set(applyGatewayEventAtom, request("other", "still-waiting"));
    store.set(restorePendingClarificationAtom, session, undefined);
    expect(store.get(chatRuntimeBySessionAtom)[session].pendingClarifications).toEqual([]);
    expect(store.get(chatRuntimeBySessionAtom).other.pendingClarifications).toHaveLength(1);
  });
});
