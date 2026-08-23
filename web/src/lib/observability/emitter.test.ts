import { describe, expect, it, vi } from "vitest";
import { SpanBuilder, TelemetryEmitter } from "./emitter";
import type { OtelSpan } from "@hermes/protocol/observability";

const HEX_RE = /^[0-9a-f]{16}$/;

describe("TelemetryEmitter", () => {
  it("starts a span with a random 16-hex spanId and an ISO start time", () => {
    const emitter = new TelemetryEmitter();
    const span = emitter.startSpan("chat.completion").end();
    expect(span.spanId).toMatch(HEX_RE);
    expect(span.name).toBe("chat.completion");
    expect(span.traceId).toBeUndefined();
    expect(new Date(span.startTime).getTime()).not.toBeNaN();
    expect(span.events).toEqual([]);
  });

  it("propagates the traceId into the span", () => {
    const emitter = new TelemetryEmitter();
    const span = emitter.startSpan("s", "trace-1").end();
    expect(span.traceId).toBe("trace-1");
  });

  it("generates distinct span ids", () => {
    const emitter = new TelemetryEmitter();
    const ids = new Set(Array.from({ length: 50 }, () => emitter.startSpan("s").end().spanId));
    expect(ids.size).toBe(50);
  });

  it("records ended spans in the snapshot", () => {
    const emitter = new TelemetryEmitter();
    emitter.startSpan("a").end();
    emitter.startSpan("b").end();
    const snapshot = emitter.snapshot();
    expect(snapshot.map((s) => s.name)).toEqual(["a", "b"]);
    expect(snapshot[0].endTime).toBeDefined();
  });

  it("does not include unfinished spans in the snapshot", () => {
    const emitter = new TelemetryEmitter();
    emitter.startSpan("finished").end();
    emitter.startSpan("unfinished");
    expect(emitter.snapshot().map((s) => s.name)).toEqual(["finished"]);
  });

  it("notifies subscribers when a span finishes", () => {
    const emitter = new TelemetryEmitter();
    const listener = vi.fn();
    emitter.subscribe(listener);
    const span = emitter.startSpan("chat.completion", "trace-9").end();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(span);
  });

  it("unsubscribes listeners", () => {
    const emitter = new TelemetryEmitter();
    const listener = vi.fn();
    const unsubscribe = emitter.subscribe(listener);
    emitter.startSpan("one").end();
    unsubscribe();
    emitter.startSpan("two").end();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("supports multiple listeners", () => {
    const emitter = new TelemetryEmitter();
    const a = vi.fn();
    const b = vi.fn();
    emitter.subscribe(a);
    emitter.subscribe(b);
    emitter.startSpan("s").end();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("returns a defensive copy from snapshot", () => {
    const emitter = new TelemetryEmitter();
    emitter.startSpan("s").end();
    const snapshot = emitter.snapshot();
    snapshot.length = 0;
    expect(emitter.snapshot()).toHaveLength(1);
  });

  it("exposes the SpanBuilder class for chaining", () => {
    expect(SpanBuilder).toBeTypeOf("function");
  });
});

describe("SpanBuilder", () => {
  it("adds events with a timestamp and default attributes", () => {
    const emitter = new TelemetryEmitter();
    const builder = emitter.startSpan("s");
    builder.addEvent("llm.start");
    builder.addEvent("llm.end", { tokens: 12 });
    const span = builder.end();
    expect(span.events).toHaveLength(2);
    expect(span.events[0]).toMatchObject({ name: "llm.start", attributes: {} });
    expect(new Date(span.events[0].timestamp as string).getTime()).not.toBeNaN();
    expect(span.events[1].attributes).toEqual({ tokens: 12 });
  });

  it("supports chaining", () => {
    const emitter = new TelemetryEmitter();
    const span = emitter
      .startSpan("s", "t")
      .addEvent("e1")
      .setParent("parent-1")
      .addEvent("e2")
      .end();
    expect(span.parentSpanId).toBe("parent-1");
    expect(span.events.map((e) => e.name)).toEqual(["e1", "e2"]);
  });

  it("end() returns the finished span and emits it once", () => {
    const emitter = new TelemetryEmitter();
    const listener = vi.fn();
    emitter.subscribe(listener);
    const span = emitter.startSpan("s").end();
    expect(span.endTime).toBeDefined();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("setParent is chainable", () => {
    const builder = new TelemetryEmitter().startSpan("s");
    expect(builder.setParent("p")).toBe(builder);
    expect(builder.addEvent("e")).toBe(builder);
  });
});
