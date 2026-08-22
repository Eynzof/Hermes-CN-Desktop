import { z } from "zod";

export const OtelEventSchema = z.object({
  name: z.string(),
  timestamp: z.string().datetime().optional(),
  attributes: z.record(z.unknown()).default({}),
});
export type OtelEvent = z.infer<typeof OtelEventSchema>;

export const OtelSpanSchema = z.object({
  traceId: z.string().optional(),
  spanId: z.string(),
  parentSpanId: z.string().optional(),
  name: z.string(),
  startTime: z.string().datetime(),
  endTime: z.string().datetime().optional(),
  events: z.array(OtelEventSchema).default([]),
});
export type OtelSpan = z.infer<typeof OtelSpanSchema>;

export const TelemetryConfigSchema = z.object({
  enabled: z.boolean().default(false),
  endpoint: z.string().optional(),
  sampleRate: z.number().min(0).max(1).default(1),
});
export type TelemetryConfig = z.infer<typeof TelemetryConfigSchema>;
