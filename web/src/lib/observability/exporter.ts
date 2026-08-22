import type { OtelSpan, TelemetryConfig } from "@hermes/protocol/observability";

export async function exportSpansHttp(
  spans: OtelSpan[],
  config: TelemetryConfig,
  fetchImpl = fetch,
): Promise<{ ok: boolean; status: number }> {
  if (!config.enabled || !config.endpoint) return { ok: true, status: 0 };
  const payload = { resourceSpans: spans };
  try {
    const res = await fetchImpl(config.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return { ok: res.ok, status: res.status };
  } catch (e) {
    return { ok: false, status: -1 };
  }
}

export function otlpJsonPayload(spans: OtelSpan[]): string {
  return JSON.stringify({ resourceSpans: spans });
}
