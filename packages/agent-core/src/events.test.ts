import { describe, expect, it, vi } from "vitest";
import { createEventEmitter } from "./events.js";
import type { AgentEvent } from "./events.js";

function sampleEvent(overrides: Partial<AgentEvent> = {}): AgentEvent {
  return {
    type: "agent.status",
    session_id: "s1",
    payload: { kind: "info", text: "hello" },
    ...overrides,
  } as AgentEvent;
}

describe("createEventEmitter", () => {
  it("emits an event to all registered listeners in registration order", () => {
    const emitter = createEventEmitter();
    const received: string[] = [];
    emitter.on(() => received.push("first"));
    emitter.on(() => received.push("second"));
    emitter.on(() => received.push("third"));

    const event = sampleEvent();
    emitter.emit(event);

    expect(received).toEqual(["first", "second", "third"]);
  });

  it("passes the exact event object to listeners", () => {
    const emitter = createEventEmitter();
    const listener = vi.fn();
    emitter.on(listener);

    const event = sampleEvent({ type: "agent.error", payload: { message: "boom" } });
    emitter.emit(event);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(event);
  });

  it("does not notify listeners when none are registered", () => {
    const emitter = createEventEmitter();
    expect(() => emitter.emit(sampleEvent())).not.toThrow();
  });

  it("unsubscribe removes a listener", () => {
    const emitter = createEventEmitter();
    const listener = vi.fn();
    const unsubscribe = emitter.on(listener);

    unsubscribe();
    emitter.emit(sampleEvent());

    expect(listener).not.toHaveBeenCalled();
  });

  it("unsubscribe only removes the targeted listener", () => {
    const emitter = createEventEmitter();
    const a = vi.fn();
    const b = vi.fn();
    emitter.on(a);
    const unsubscribe = emitter.on(b);
    unsubscribe();

    emitter.emit(sampleEvent());

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).not.toHaveBeenCalled();
  });

  it("unsubscribe is idempotent", () => {
    const emitter = createEventEmitter();
    const listener = vi.fn();
    const unsubscribe = emitter.on(listener);

    unsubscribe();
    unsubscribe();
    emitter.emit(sampleEvent());

    expect(listener).not.toHaveBeenCalled();
  });

  it("deduplicates the same listener subscribed twice (Set semantics)", () => {
    const emitter = createEventEmitter();
    const listener = vi.fn();
    emitter.on(listener);
    emitter.on(listener);

    emitter.emit(sampleEvent());

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("listeners added during emit are not called for the current event (snapshot semantics)", () => {
    const emitter = createEventEmitter();
    const late = vi.fn();
    const early = vi.fn(() => {
      emitter.on(late);
    });
    emitter.on(early);

    emitter.emit(sampleEvent());

    expect(early).toHaveBeenCalledTimes(1);
    expect(late).not.toHaveBeenCalled();
  });

  it("a listener removed by another listener during emit is still called for the current event (snapshot semantics)", () => {
    const emitter = createEventEmitter();
    const a = vi.fn(() => {
      unsubscribeB();
    });
    const b = vi.fn();
    const unsubscribeB = emitter.on(b);
    emitter.on(a);

    emitter.emit(sampleEvent());

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("re-emits subsequent events after a listener unsubscribed itself", () => {
    const emitter = createEventEmitter();
    const b = vi.fn();
    const a = vi.fn(() => {
      // a stays subscribed; b unsubscribes itself on first event
      unsubscribeB();
    });
    const unsubscribeB = emitter.on(b);
    emitter.on(a);

    emitter.emit(sampleEvent());
    emitter.emit(sampleEvent());

    expect(a).toHaveBeenCalledTimes(2);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("propagates a throwing listener and skips later listeners (Node EventEmitter-compatible)", () => {
    const emitter = createEventEmitter();
    const boom = new Error("listener failed");
    const bad = vi.fn(() => {
      throw boom;
    });
    const good = vi.fn();
    emitter.on(bad);
    emitter.on(good);

    expect(() => emitter.emit(sampleEvent())).toThrow(boom);
    expect(good).not.toHaveBeenCalled();
  });

  it("a throwing listener does not permanently break the emitter", () => {
    const emitter = createEventEmitter();
    const bad = vi.fn(() => {
      throw new Error("listener failed");
    });
    const good = vi.fn();
    const unsubscribeBad = emitter.on(bad);
    emitter.on(good);

    expect(() => emitter.emit(sampleEvent())).toThrow("listener failed");

    unsubscribeBad();
    expect(() => emitter.emit(sampleEvent())).not.toThrow();
    // `good` only ran during the second emit: the first emit aborted at `bad`.
    expect(good).toHaveBeenCalledTimes(1);
  });
});
