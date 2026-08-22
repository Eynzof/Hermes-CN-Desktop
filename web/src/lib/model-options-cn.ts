/**
 * CN fork-specific model catalog helpers.
 *
 * Mirrors the P-011 RPC additions:
 *   - model.options with slug_filter
 *   - provider.probe via GET /v1/models (or /v1/messages for anthropic_messages)
 */
import {
  ProviderProbeResult,
  type ModelOptionsResult,
  type GatewayModelProvider,
} from "@hermes/protocol";
import { fetchExternalJSON } from "./transport";
import { CN_BACKEND_PROVIDER_SLUGS } from "./cn-provider-slugs";

const CN_SLUG_SET = new Set<string>(CN_BACKEND_PROVIDER_SLUGS);

export function isCnCanonicalProvider(slug: string): boolean {
  return CN_SLUG_SET.has(slug);
}

export function filterModelOptionsBySlugFilter(
  result: ModelOptionsResult,
  slugFilter?: string[] | readonly string[],
): ModelOptionsResult {
  const allowed = slugFilter ? new Set(slugFilter) : CN_SLUG_SET;
  const providers = result.providers.filter((p) => {
    const slug = (p as GatewayModelProvider & { slug?: string }).slug ?? p.provider;
    // Custom providers (not in the canonical filter set) always pass through.
    if (!allowed.has(slug)) return false;
    return true;
  });
  return { ...result, providers };
}

export type ProbeApiMode = "openai" | "anthropic_messages";

function buildProbeUrl(baseUrl: string, apiMode: ProbeApiMode): string {
  const base = baseUrl.replace(/\/+$/, "");
  if (apiMode === "anthropic_messages") {
    return base.endsWith("/v1") ? `${base}/models` : `${base}/v1/models`;
  }
  return `${base}/v1/models`;
}

function probeHeaders(apiKey: string, apiMode: ProbeApiMode): Record<string, string> {
  if (apiMode === "anthropic_messages") {
    return apiKey ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" } : {};
  }
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

interface RawModelsResponse {
  data?: Array<{ id?: string }>;
}

export async function probeProviderModels(
  provider: string,
  apiKey: string,
  baseUrl: string,
  apiMode: ProbeApiMode = "openai",
  timeoutMs = 5000,
): Promise<ProviderProbeResult> {
  const url = buildProbeUrl(baseUrl, apiMode);
  const start = performance.now();
  try {
    const data = await fetchExternalJSON<RawModelsResponse>(url, {
      headers: probeHeaders(apiKey, apiMode),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const latency = Math.max(0, Math.round(performance.now() - start));
    const models =
      Array.isArray(data?.data)
        ? data.data
            .map((m) => m.id)
            .filter((id): id is string => typeof id === "string")
        : [];
    return {
      ok: true,
      latency_ms: latency,
      model_count: models.length,
      sample_models: models.slice(0, 5),
      status_code: 200,
      error: null,
      error_kind: null,
    };
  } catch (error) {
    const latency = Math.max(0, Math.round(performance.now() - start));
    const message = error instanceof Error ? error.message : String(error);
    const statusCode = /\bHTTP\s+(\d{3})\b/i.exec(message)?.[1];
    const status = statusCode ? Number(statusCode) : null;
    let errorKind = "unknown" as NonNullable<ProviderProbeResult["error_kind"]>;
    if (status === 401 || status === 403) errorKind = "auth";
    else if (/timeout|timed out/i.test(message)) errorKind = "timeout";
    else if (status != null) errorKind = "http";
    else if (/network|failed to fetch|cors|connection/i.test(message)) errorKind = "network";
    return {
      ok: false,
      latency_ms: latency,
      model_count: 0,
      sample_models: [],
      status_code: status,
      error: message,
      error_kind: errorKind,
    };
  }
}
