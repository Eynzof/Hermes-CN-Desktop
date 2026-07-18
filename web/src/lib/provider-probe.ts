import type { ProviderProbeResult } from "@hermes/protocol";
import { fetchExternalJSON } from "./transport";

export type ProbeErrorKind = NonNullable<ProviderProbeResult["error_kind"]>;

export function buildChatCompletionsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
}

/**
 * Anthropic Messages 端点。镜像 Anthropic SDK 的拼接规则（SDK 自动追加
 * /v1/messages，所以 Claude Code 中转的 baseUrl 通常不带 /v1）；已带 /v1
 * 的 base 只补 /messages，避免拼出 /v1/v1。
 */
export function buildAnthropicMessagesUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  return base.endsWith("/v1") ? `${base}/messages` : `${base}/v1/messages`;
}

export function buildGeminiGenerateContentUrl(baseUrl: string, model: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  return `${base}/models/${encodeURIComponent(model)}:generateContent`;
}

export function statusCodeFromErrorMessage(message: string): number | null {
  const match = message.match(/\bHTTP\s+(\d{3})\b/i);
  return match ? Number(match[1]) : null;
}

export function probeErrorKind(statusCode: number | null, message: string): ProbeErrorKind {
  const lower = message.toLowerCase();
  if (statusCode === 401 || statusCode === 403 || /unauthor|api key|token|credential/.test(lower)) {
    return "auth";
  }
  if (/timeout|timed out/.test(lower)) return "timeout";
  if (statusCode != null) return "http";
  if (/network|failed to fetch|cors|connection/.test(lower)) return "network";
  return "unknown";
}

interface DirectProbeInput {
  apiKey: string;
  baseUrl: string;
  model: string;
}

async function probeWithMinimalRequest(
  input: DirectProbeInput,
  buildUrl: (baseUrl: string) => string,
  buildHeaders: (apiKey: string) => Record<string, string>,
  buildBody: (model: string) => Record<string, unknown>,
): Promise<ProviderProbeResult> {
  const apiKey = input.apiKey.trim();
  const baseUrl = input.baseUrl.trim();
  const model = input.model.trim();
  if (!baseUrl || !model) {
    return {
      ok: false,
      latency_ms: 0,
      model_count: 0,
      sample_models: [],
      status_code: null,
      error: !baseUrl ? "base_url is required" : "model is required",
      error_kind: "unknown",
    };
  }

  const start = performance.now();
  try {
    await fetchExternalJSON<unknown>(buildUrl(baseUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        ...buildHeaders(apiKey),
      },
      body: JSON.stringify(buildBody(model)),
    });
    return {
      ok: true,
      latency_ms: Math.max(0, Math.round(performance.now() - start)),
      model_count: 1,
      sample_models: [model],
      status_code: 200,
      error: null,
      error_kind: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const statusCode = statusCodeFromErrorMessage(message);
    return {
      ok: false,
      latency_ms: Math.max(0, Math.round(performance.now() - start)),
      model_count: 0,
      sample_models: [],
      status_code: statusCode,
      error: message,
      error_kind: probeErrorKind(statusCode, message),
    };
  }
}

/**
 * 对不提供 /models 端点的 OpenAI 兼容服务商发一次极小的 chat/completions
 * 请求，真实验证 API Key + Base URL + 模型三元组。
 */
export function probeChatCompletionsProvider(input: DirectProbeInput): Promise<ProviderProbeResult> {
  return probeWithMinimalRequest(
    input,
    buildChatCompletionsUrl,
    (apiKey): Record<string, string> => (apiKey ? { "Authorization": `Bearer ${apiKey}` } : {}),
    (model) => ({
      model,
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 1,
      stream: false,
    }),
  );
}

/** Google AI Studio 原生 Gemini REST 探测；与 Core 的 GeminiNativeClient 使用同一端点。 */
export function probeGeminiProvider(input: DirectProbeInput): Promise<ProviderProbeResult> {
  return probeWithMinimalRequest(
    input,
    (baseUrl) => buildGeminiGenerateContentUrl(baseUrl, input.model.trim()),
    (apiKey): Record<string, string> => (apiKey ? { "x-goog-api-key": apiKey } : {}),
    () => ({
      contents: [{ role: "user", parts: [{ text: "ping" }] }],
      generationConfig: { maxOutputTokens: 1 },
    }),
  );
}

/**
 * Anthropic 格式（Claude Code 中转）的对称探测：POST /v1/messages +
 * x-api-key 鉴权。这类中转大多不提供 /models 端点，且严格网关会拒绝
 * Bearer-only 请求，走 OpenAI 风格探测会把有效密钥误报成鉴权失败。
 */
export function probeAnthropicMessagesProvider(input: DirectProbeInput): Promise<ProviderProbeResult> {
  return probeWithMinimalRequest(
    input,
    buildAnthropicMessagesUrl,
    (apiKey): Record<string, string> => (apiKey ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" } : {}),
    (model) => ({
      model,
      max_tokens: 1,
      messages: [{ role: "user", content: "ping" }],
    }),
  );
}
