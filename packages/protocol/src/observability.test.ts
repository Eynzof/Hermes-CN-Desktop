import { describe, expect, it } from "vitest";
import { OtelEventSchema, OtelSpanSchema, TelemetryConfigSchema } from "./observability";

describe("OtelEventSchema", () => {
  it("parses an event and defaults attributes to {}", () => {
    const parsed = OtelEventSchema.parse({ name: "tool.started" });
    expect(parsed.name).toBe("tool.started");
    expect(parsed.attributes).toEqual({});
    expect(parsed.timestamp).toBeUndefined();
  });

  it("parses a full event with timestamp and attributes", () => {
    const parsed = OtelEventSchema.parse({
      name: "tool.completed",
      timestamp: "2026-01-01T00:00:00Z",
      attributes: { tool: "read" },
    });
    expect(parsed.timestamp).toBe("2026-01-01T00:00:00Z");
    expect(parsed.attributes).toEqual({ tool: "read" });
  });

  it("rejects a missing name or malformed timestamp", () => {
    expect(OtelEventSchema.safeParse({}).success).toBe(false);
    expect(OtelEventSchema.safeParse({ name: "x", timestamp: "now" }).success).toBe(false);
  });
});

describe("OtelSpanSchema", () => {
  it("parses a span and defaults events to []", () => {
    const parsed = OtelSpanSchema.parse({
      spanId: "span-1",
      name: "hermes.gateway_health",
      startTime: "2026-01-01T00:00:00Z",
    });
    expect(parsed.events).toEqual([]);
    expect(parsed.traceId).toBeUndefined();
    expect(parsed.parentSpanId).toBeUndefined();
    expect(parsed.endTime).toBeUndefined();
  });

  it("parses a full span", () => {
    const parsed = OtelSpanSchema.parse({
      traceId: "trace-1",
      spanId: "span-1",
      parentSpanId: "span-0",
      name: "agent.turn",
      startTime: "2026-01-01T00:00:00Z",
      endTime: "2026-01-01T00:00:01Z",
      events: [{ name: "delta" }],
    });
    expect(parsed.parentSpanId).toBe("span-0");
    expect(parsed.endTime).toBe("2026-01-01T00:00:01Z");
    expect(parsed.events).toHaveLength(1);
  });

  it("rejects missing spanId/name/startTime and non-datetime startTime", () => {
    expect(OtelSpanSchema.safeParse({ name: "x", startTime: "2026-01-01T00:00:00Z" }).success).toBe(false);
    expect(OtelSpanSchema.safeParse({ spanId: "s", startTime: "2026-01-01T00:00:00Z" }).success).toBe(false);
    expect(OtelSpanSchema.safeParse({ spanId: "s", name: "x" }).success).toBe(false);
    expect(OtelSpanSchema.safeParse({ spanId: "s", name: "x", startTime: "yesterday" }).success).toBe(false);
  });
});

describe("TelemetryConfigSchema", () => {
  it("applies defaults to an empty config", () => {
    const parsed = TelemetryConfigSchema.parse({});
    expect(parsed).toEqual({ enabled: false, sampleRate: 1 });
    expect(parsed.endpoint).toBeUndefined();
  });

  it("parses a full config", () => {
    const parsed = TelemetryConfigSchema.parse({
      enabled: true,
      endpoint: "http://localhost:4318",
      sampleRate: 0.5,
    });
    expect(parsed.enabled).toBe(true);
    expect(parsed.endpoint).toBe("http://localhost:4318");
    expect(parsed.sampleRate).toBe(0.5);
  });

  it("accepts sample-rate boundaries", () => {
    expect(TelemetryConfigSchema.parse({ sampleRate: 0 }).sampleRate).toBe(0);
    expect(TelemetryConfigSchema.parse({ sampleRate: 1 }).sampleRate).toBe(1);
  });

  it("rejects out-of-range sample rates", () => {
    expect(TelemetryConfigSchema.safeParse({ sampleRate: 1.5 }).success).toBe(false);
    expect(TelemetryConfigSchema.safeParse({ sampleRate: -0.1 }).success).toBe(false);
  });
});
