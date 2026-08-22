import { describe, it, expect, vi } from "vitest";
import { TelemetryEmitter } from "./emitter.js";
import { exportSpansHttp, otlpJsonPayload } from "./exporter.js";
import { parseTelemetryConfig, telemetryConfigEq } from "./config.js";
import { ObservabilityClient } from "./client.js";

describe("telemetry emitter", () => {
  it("records spans", () => {
    const emitter = new TelemetryEmitter();
    let seen = 0;
    emitter.subscribe(() => seen++);
    const span = emitter.startSpan("test").addEvent("evt").end();
    expect(span.name).toBe("test");
    expect(emitter.snapshot()).toHaveLength(1);
    expect(seen).toBe(1);
  });

  it("supports parent span", () => {
    const emitter = new TelemetryEmitter();
    const parent = emitter.startSpan("parent").end();
    const child = emitter.startSpan("child").setParent(parent.spanId).end();
    expect(child.parentSpanId).toBe(parent.spanId);
  });
});

describe("telemetry exporter", () => {
  it("exports when enabled", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const res = await exportSpansHttp([{ spanId: "1", name: "s", startTime: new Date().toISOString(), events: [] }], { enabled: true, endpoint: "http://x", sampleRate: 1 }, fetch as any);
    expect(res.ok).toBe(true);
  });

  it("skips when disabled", async () => {
    const fetch = vi.fn();
    const res = await exportSpansHttp([{ spanId: "1", name: "s", startTime: new Date().toISOString(), events: [] }], { enabled: false, sampleRate: 1 }, fetch as any);
    expect(res.status).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("builds otlp payload", () => {
    const json = otlpJsonPayload([{ spanId: "1", name: "s", startTime: new Date().toISOString(), events: [] }]);
    expect(JSON.parse(json).resourceSpans).toHaveLength(1);
  });
});

describe("telemetry config", () => {
  it("parses config", () => {
    const c = parseTelemetryConfig({ enabled: true, endpoint: "http://x", sampleRate: 0.5 });
    expect(c.enabled).toBe(true);
    expect(c.sampleRate).toBe(0.5);
  });

  it("compares configs", () => {
    const a = { enabled: true, sampleRate: 1, endpoint: "x" };
    expect(telemetryConfigEq(a, a)).toBe(true);
    expect(telemetryConfigEq(a, { enabled: false, sampleRate: 1, endpoint: "x" })).toBe(false);
  });
});

describe("observability client", () => {
  it("gets config", async () => {
    const invoke = vi.fn().mockResolvedValue({ enabled: true, sampleRate: 1 });
    const client = new ObservabilityClient({ invoke });
    const c = await client.getConfig();
    expect(c.enabled).toBe(true);
  });
});
