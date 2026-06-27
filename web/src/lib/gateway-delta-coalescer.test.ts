import { describe, expect, it, vi } from "vitest";
import type { GatewayEvent } from "@hermes/protocol";
import { createDeltaCoalescer } from "./gateway-delta-coalescer";

function delta(sessionId: string, text: string): GatewayEvent {
  return { type: "message.delta", session_id: sessionId, payload: { text } } as GatewayEvent;
}

/** A manual frame scheduler so tests fire the rAF flush deterministically. */
function makeFrame() {
  let cb: (() => void) | null = null;
  let handle = 0;
  return {
    requestFrame: (fn: () => void) => {
      cb = fn;
      return ++handle;
    },
    cancelFrame: () => {
      cb = null;
    },
    run: () => {
      const fn = cb;
      cb = null;
      fn?.();
    },
    pending: () => cb !== null,
  };
}

function setup() {
  const applied: GatewayEvent[] = [];
  const frame = makeFrame();
  const coalescer = createDeltaCoalescer((e) => applied.push(e), {
    requestFrame: frame.requestFrame,
    cancelFrame: frame.cancelFrame,
  });
  return { applied, frame, coalescer };
}

describe("createDeltaCoalescer", () => {
  it("merges consecutive pure-text deltas into one apply per frame", () => {
    const { applied, frame, coalescer } = setup();

    coalescer.dispatch(delta("s1", "Hello "));
    coalescer.dispatch(delta("s1", "world"));
    expect(applied).toEqual([]); // nothing applied until the frame fires

    frame.run();
    expect(applied).toHaveLength(1);
    expect(applied[0].type).toBe("message.delta");
    expect(applied[0].session_id).toBe("s1");
    expect((applied[0].payload as Record<string, unknown>).text).toBe("Hello world");
  });

  it("flushes buffered deltas before a non-delta event, preserving order", () => {
    const { applied, coalescer } = setup();

    coalescer.dispatch(delta("s1", "Hi"));
    coalescer.dispatch({ type: "message.complete", session_id: "s1", payload: {} } as GatewayEvent);

    expect(applied.map((e) => e.type)).toEqual(["message.delta", "message.complete"]);
    expect((applied[0].payload as Record<string, unknown>).text).toBe("Hi");
  });

  it("does not merge image-bearing deltas; flushes prior text then applies as-is", () => {
    const { applied, coalescer } = setup();

    coalescer.dispatch(delta("s1", "before "));
    coalescer.dispatch({
      type: "message.delta",
      session_id: "s1",
      payload: { text: "img", images: ["data:image/png;base64,AAAA"] },
    } as GatewayEvent);

    expect(applied).toHaveLength(2);
    expect((applied[0].payload as Record<string, unknown>).text).toBe("before ");
    expect((applied[1].payload as Record<string, unknown>).images).toEqual([
      "data:image/png;base64,AAAA",
    ]);
  });

  it("flush() applies pending deltas immediately and cancels the frame", () => {
    const { applied, frame, coalescer } = setup();

    coalescer.dispatch(delta("s1", "abc"));
    expect(applied).toEqual([]);
    expect(frame.pending()).toBe(true);

    coalescer.flush();
    expect(applied).toHaveLength(1);
    expect((applied[0].payload as Record<string, unknown>).text).toBe("abc");
    expect(frame.pending()).toBe(false);
  });

  it("buffers deltas per session independently", () => {
    const { applied, frame, coalescer } = setup();

    coalescer.dispatch(delta("s1", "a"));
    coalescer.dispatch(delta("s2", "x"));
    coalescer.dispatch(delta("s1", "b"));
    frame.run();

    expect(applied).toHaveLength(2);
    const bySession = Object.fromEntries(
      applied.map((e) => [e.session_id, (e.payload as Record<string, unknown>).text]),
    );
    expect(bySession).toEqual({ s1: "ab", s2: "x" });
  });

  it("applies immediately when no frame scheduler is available", () => {
    vi.stubGlobal("requestAnimationFrame", undefined);
    try {
      const applied: GatewayEvent[] = [];
      const coalescer = createDeltaCoalescer((e) => applied.push(e));
      coalescer.dispatch(delta("s1", "z"));
      // No scheduler → no buffering; the delta is applied synchronously.
      expect(applied).toHaveLength(1);
      expect((applied[0].payload as Record<string, unknown>).text).toBe("z");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
