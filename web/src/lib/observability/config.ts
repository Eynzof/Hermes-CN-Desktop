import { TelemetryConfigSchema, type TelemetryConfig } from "@hermes/protocol/observability";

export function parseTelemetryConfig(raw: unknown): TelemetryConfig {
  return TelemetryConfigSchema.parse(raw);
}

export function telemetryConfigEq(a: TelemetryConfig, b: TelemetryConfig): boolean {
  return a.enabled === b.enabled && a.endpoint === b.endpoint && a.sampleRate === b.sampleRate;
}
