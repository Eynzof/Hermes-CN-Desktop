import { describe, it, expect } from "vitest";
import { buildSessionKey, sessionIdFromKey, SessionStore, SessionMultiplexer } from "./session.js";
import type { InboundMessageEvent } from "./adapter.js";

describe("buildSessionKey", () => {
  it("produces byte-identical layout without user id", () => {
    const key = buildSessionKey({ platform: "telegram", chatId: "99", chatType: "dm", userId: "" });
    expect(key).toBe("agent:main:telegram:dm:99");
  });

  it("appends user id when present", () => {
    const key = buildSessionKey({ platform: "telegram", chatId: "99", chatType: "dm", userId: "42" });
    expect(key).toBe("agent:main:telegram:dm:99:42");
  });
});

describe("sessionIdFromKey", () => {
  it("is stable and hex-shaped", () => {
    const id = sessionIdFromKey("agent:main:telegram:dm:99");
    expect(id).toMatch(/^sess_[0-9a-f]{12}$/);
    expect(sessionIdFromKey("agent:main:telegram:dm:99")).toBe(id);
  });
});

describe("SessionStore", () => {
  it("reuses existing sessions by key", () => {
    const store = new SessionStore();
    const a = store.ensure({ platform: "telegram", chatId: "c1", chatType: "dm", userId: "u1" });
    const b = store.ensure({ platform: "telegram", chatId: "c1", chatType: "dm", userId: "u1" });
    expect(a.sessionId).toBe(b.sessionId);
    expect(store.get(a.sessionId)).toBe(a);
  });

  it("evicts least-recently active when over capacity", () => {
    const store = new SessionStore();
    const sessions: ReturnType<typeof store.ensure>[] = [];
    for (let i = 0; i < 140; i++) {
      sessions.push(store.ensure({ platform: "telegram", chatId: `c${i}`, chatType: "dm", userId: `u${i}` }));
    }
    expect(sessions.filter((s) => store.get(s.sessionId))).toHaveLength(127);
  });
});

describe("SessionMultiplexer", () => {
  function ev(text: string, userId = "u1"): InboundMessageEvent {
    return {
      id: "e1",
      platform: "telegram",
      chatId: "c1",
      chatType: "dm",
      userId,
      parts: [{ type: "text", text }],
      receivedAt: 0,
    };
  }

  it("detects slash commands", () => {
    const store = new SessionStore();
    const mux = new SessionMultiplexer(store);
    const decision = mux.route(ev("/status"));
    expect(decision.action).toBe("slash");
    if (decision.action === "slash") expect(decision.command).toBe("status");
  });

  it("queues when busy", () => {
    const store = new SessionStore();
    const mux = new SessionMultiplexer(store, { busyMode: "queue" });
    const session = store.ensure({ platform: "telegram", chatId: "c1", chatType: "dm", userId: "u1" });
    mux.markBusy(session.sessionId, true);
    const decision = mux.route(ev("hello"));
    expect(decision.action).toBe("queue");
  });

  it("drops unauthorized senders", () => {
    const store = new SessionStore();
    const mux = new SessionMultiplexer(store, { isAdmin: (e) => e.userId === "admin" });
    const decision = mux.route(ev("hello", "user"));
    expect(decision.action).toBe("drop_auth");
  });
});
