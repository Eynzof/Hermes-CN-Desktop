// 匿名使用统计。上报到 landing 站点的 Cloudflare Worker
// （POST /api/telemetry → Workers Analytics Engine），只含版本 / 系统类型 /
// 语言这类聚合字段与一个本地随机生成的 device_id，不含对话内容、密钥或
// 任何硬件指纹。默认开启，可在「设置 → 常规」关闭（hermes.telemetry-enabled）。
import { fetchExternalJSON } from "./transport";
import {
  getUiTurnStatsWindow,
  readUiValue,
  writeUiValue,
  type UiTurnStats,
} from "./ui-store";
import { detectHostOS } from "./runtime";
import { DESKTOP_VERSION } from "./build-info";
import { BUILTIN_PROVIDER_CATALOG_VERSION } from "./provider-catalog";

const DEFAULT_TELEMETRY_URL = "https://desktop.hermesagent.org.cn/api/telemetry";

export const TELEMETRY_ENABLED_KEY = "hermes.telemetry-enabled";
export const TOKEN_USAGE_LAST_REPORTED_KEY = "hermes.telemetry-token-usage-last-reported-at";
const DEVICE_ID_KEY = "hermes.telemetry-device-id";
const LAST_PING_KEY = "hermes.telemetry-last-ping-at";

export const PING_INTERVAL_MS = 24 * 60 * 60 * 1000;
const MAX_TOKEN_USAGE_MODELS = 50;

export interface TokenUsageTelemetryMetrics {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens: number;
  api_calls: number;
  turns: number;
}

export interface TokenUsageTelemetryModel extends TokenUsageTelemetryMetrics {
  provider: string;
  model: string;
}

interface TelemetryBasePayload {
  device_id: string;
  app_version: string;
  os: string;
  locale: string;
  catalog_version: string;
}

export interface BasicTelemetryPayload extends TelemetryBasePayload {
  event: "ping" | "promo_click";
  provider_id?: string;
}

export interface TokenUsageDailyTelemetryPayload extends TelemetryBasePayload {
  event: "token_usage_daily";
  period_start_ms: number;
  period_end_ms: number;
  totals: TokenUsageTelemetryMetrics;
  models: TokenUsageTelemetryModel[];
}

function telemetryUrl(): string {
  const override = import.meta.env.VITE_HERMES_TELEMETRY_URL;
  return typeof override === "string" && override.trim()
    ? override.trim()
    : DEFAULT_TELEMETRY_URL;
}

export function isTelemetryEnabled(): boolean {
  return readUiValue<unknown>(TELEMETRY_ENABLED_KEY, true) !== false;
}

function telemetryDeviceId(): string {
  const existing = readUiValue<unknown>(DEVICE_ID_KEY, "");
  if (typeof existing === "string" && existing.trim()) return existing;
  const generated = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  writeUiValue(DEVICE_ID_KEY, generated);
  return generated;
}

/** 纯函数：距上次 ping 是否已超过间隔（时间戳非法视为“该发”）。 */
export function isPingDue(lastPingAt: unknown, now: number, interval = PING_INTERVAL_MS): boolean {
  const last = typeof lastPingAt === "number" ? lastPingAt : Number(lastPingAt);
  if (!Number.isFinite(last) || last <= 0) return true;
  return now - last >= interval;
}

export type TelemetryPayload = BasicTelemetryPayload | TokenUsageDailyTelemetryPayload;

export function buildTelemetryPayload(
  event: BasicTelemetryPayload["event"],
  deviceId: string,
  providerId?: string,
): BasicTelemetryPayload {
  return {
    event,
    device_id: deviceId,
    app_version: DESKTOP_VERSION,
    os: detectHostOS(),
    locale: typeof navigator !== "undefined" ? navigator.language : "unknown",
    catalog_version: BUILTIN_PROVIDER_CATALOG_VERSION,
    ...(providerId ? { provider_id: providerId } : {}),
  };
}

function numericTimestamp(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function tokenMetric(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : 0;
}

function emptyTokenUsageMetrics(): TokenUsageTelemetryMetrics {
  return {
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    api_calls: 0,
    turns: 0,
  };
}

function normalizedDimension(value: string | undefined, fallback = "unknown", max = 128): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, max) : fallback;
}

function providerFromStat(stat: UiTurnStats, model: string): string {
  const provider = normalizedDimension(stat.provider, "", 64);
  if (provider) return provider;
  const slashIndex = model.indexOf("/");
  return slashIndex > 0 ? model.slice(0, slashIndex).slice(0, 64) : "unknown";
}

function tokensForStat(stat: UiTurnStats): TokenUsageTelemetryMetrics {
  const input = tokenMetric(stat.tokensInput);
  const total = tokenMetric(stat.tokensTotal) || input + tokenMetric(stat.tokensOutput);
  const output = tokenMetric(stat.tokensOutput) || Math.max(0, total - input);
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: total,
    cache_read_tokens: tokenMetric(stat.cacheRead),
    cache_write_tokens: tokenMetric(stat.cacheWrite),
    reasoning_tokens: tokenMetric(stat.reasoningTokens),
    api_calls: tokenMetric(stat.apiCalls),
    turns: total > 0 ? 1 : 0,
  };
}

function addMetrics(target: TokenUsageTelemetryMetrics, source: TokenUsageTelemetryMetrics): void {
  target.input_tokens += source.input_tokens;
  target.output_tokens += source.output_tokens;
  target.total_tokens += source.total_tokens;
  target.cache_read_tokens += source.cache_read_tokens;
  target.cache_write_tokens += source.cache_write_tokens;
  target.reasoning_tokens += source.reasoning_tokens;
  target.api_calls += source.api_calls;
  target.turns += source.turns;
}

export function buildTokenUsageTelemetryPayload(
  rows: UiTurnStats[],
  input: { deviceId: string; periodStartMs: number; periodEndMs: number },
): TokenUsageDailyTelemetryPayload | null {
  const totals = emptyTokenUsageMetrics();
  const byModel = new Map<string, TokenUsageTelemetryModel>();

  for (const stat of rows) {
    const metrics = tokensForStat(stat);
    if (metrics.total_tokens <= 0) continue;

    const model = normalizedDimension(stat.model, "unknown", 128);
    const provider = providerFromStat(stat, model);
    const key = `${provider}:${model}`;
    const existing = byModel.get(key) ?? { ...emptyTokenUsageMetrics(), provider, model };
    addMetrics(existing, metrics);
    byModel.set(key, existing);
    addMetrics(totals, metrics);
  }

  if (totals.total_tokens <= 0) return null;

  return {
    event: "token_usage_daily",
    device_id: input.deviceId,
    app_version: DESKTOP_VERSION,
    os: detectHostOS(),
    locale: typeof navigator !== "undefined" ? navigator.language : "unknown",
    catalog_version: BUILTIN_PROVIDER_CATALOG_VERSION,
    period_start_ms: input.periodStartMs,
    period_end_ms: input.periodEndMs,
    totals,
    models: [...byModel.values()]
      .sort((a, b) => b.total_tokens - a.total_tokens || b.turns - a.turns)
      .slice(0, MAX_TOKEN_USAGE_MODELS),
  };
}

async function post(payload: TelemetryPayload): Promise<void> {
  await fetchExternalJSON<unknown>(telemetryUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

/** 启动 / 每 24h 一次的匿名 ping。失败静默，绝不影响主流程。 */
export async function sendTelemetryPingIfDue(now = Date.now()): Promise<boolean> {
  if (!isTelemetryEnabled()) return false;
  if (!isPingDue(readUiValue<unknown>(LAST_PING_KEY, 0), now)) return false;
  // 先落时间戳再发送：失败也等下个周期重试，避免异常时高频打点。
  writeUiValue(LAST_PING_KEY, now);
  try {
    await post(buildTelemetryPayload("ping", telemetryDeviceId()));
    return true;
  } catch {
    return false;
  }
}

let tokenUsageTelemetryInFlight: Promise<boolean> | null = null;

async function sendTokenUsageTelemetry(now: number): Promise<boolean> {
  if (!isTelemetryEnabled()) return false;
  const lastReportedAt = numericTimestamp(readUiValue<unknown>(TOKEN_USAGE_LAST_REPORTED_KEY, 0));
  if (!isPingDue(lastReportedAt, now)) return false;

  const periodStartMs = lastReportedAt ?? Math.max(0, now - PING_INTERVAL_MS);
  try {
    const rows = await getUiTurnStatsWindow({ sinceMs: periodStartMs, limit: 20_000 });
    const payload = buildTokenUsageTelemetryPayload(rows, {
      deviceId: telemetryDeviceId(),
      periodStartMs,
      periodEndMs: now,
    });
    if (!payload) return false;
    await post(payload);
    writeUiValue(TOKEN_USAGE_LAST_REPORTED_KEY, now);
    return true;
  } catch {
    return false;
  }
}

/** 每 24h 最多一次的匿名 Token 消耗聚合上报。失败静默，绝不影响主流程。 */
export async function sendTokenUsageTelemetryIfDue(now = Date.now()): Promise<boolean> {
  if (tokenUsageTelemetryInFlight) return tokenUsageTelemetryInFlight;
  tokenUsageTelemetryInFlight = sendTokenUsageTelemetry(now).finally(() => {
    tokenUsageTelemetryInFlight = null;
  });
  return tokenUsageTelemetryInFlight;
}

/** 「前往官网」点击事件（fire-and-forget），用于评估各供应商推广位转化。 */
export function reportPromoClick(providerId: string): void {
  if (!isTelemetryEnabled() || !providerId) return;
  void post(buildTelemetryPayload("promo_click", telemetryDeviceId(), providerId)).catch(() => {});
}
