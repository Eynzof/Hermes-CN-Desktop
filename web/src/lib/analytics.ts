import type {
  AnalyticsDay,
  AnalyticsModelBreakdown,
  AnalyticsResponse,
  AnalyticsTopSession,
  AnalyticsTotals,
} from "@hermes/protocol";
import type { UiTurnStats } from "@/lib/ui-store";

export interface AnalyticsDailyPoint {
  day: string;
  label: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  sessions: number;
  apiCalls: number;
}

export interface AnalyticsModelView {
  id: string;
  model: string;
  provider: string;
  label: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  sessions: number;
  apiCalls: number;
  share: number;
}

export interface AnalyticsTopSessionView {
  sessionId: string;
  title: string;
  model: string;
  provider: string;
  startedAt: number;
  endedAt: number | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  apiCalls: number;
}

export interface AnalyticsKpiView {
  key: "tokens" | "apiCalls" | "sessions" | "avgTokens";
  label: string;
  value: number;
  previous: number;
  changePercent: number | null;
}

export interface AnalyticsPerformanceDailyPoint {
  day: string;
  label: string;
  cacheHitRate: number | null;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  promptTokens: number;
}

export interface AnalyticsPerformanceModelView {
  id: string;
  model: string;
  provider: string;
  samples: number;
  avgTtftMs: number | null;
  p50TtftMs: number | null;
  p95TtftMs: number | null;
  avgTokPerSec: number | null;
  p50TokPerSec: number | null;
  p95TokPerSec: number | null;
}

export interface AnalyticsPerformanceSessionView {
  sessionId: string;
  model: string;
  provider: string;
  completedAt: number | null;
  ttftMs: number | null;
  durationMs: number | null;
  outputTokens: number;
  tokPerSec: number | null;
}

export interface AnalyticsPerformanceViewModel {
  cacheHitRate: number | null;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  promptTokens: number;
  ttftSamples: number;
  speedSamples: number;
  avgTtftMs: number | null;
  p50TtftMs: number | null;
  p95TtftMs: number | null;
  avgTokPerSec: number | null;
  p50TokPerSec: number | null;
  p95TokPerSec: number | null;
  daily: AnalyticsPerformanceDailyPoint[];
  models: AnalyticsPerformanceModelView[];
  sessions: AnalyticsPerformanceSessionView[];
}

export interface AnalyticsViewModel {
  periodDays: number;
  totals: AnalyticsTotals;
  previousTotals: AnalyticsTotals;
  daily: AnalyticsDailyPoint[];
  models: AnalyticsModelView[];
  topSessions: AnalyticsTopSessionView[];
  kpis: AnalyticsKpiView[];
  isEmpty: boolean;
}

function finite(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function totalTokens(row: { input_tokens: number; output_tokens: number }): number {
  return finite(row.input_tokens) + finite(row.output_tokens);
}

function avgTokensPerSession(totals: AnalyticsTotals): number {
  const sessions = finite(totals.total_sessions);
  if (sessions <= 0) return 0;
  return finite(totals.total_tokens) / sessions;
}

function changePercent(current: number, previous: number): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return null;
  if (previous === 0) return current === 0 ? 0 : null;
  return ((current - previous) / previous) * 100;
}

function utcDayString(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function addUtcDays(date: Date, days: number): Date {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function formatDayLabel(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return day;
  return `${date.getUTCMonth() + 1}/${date.getUTCDate()}`;
}

function fillDaily(daily: AnalyticsDay[], periodDays: number, now: Date): AnalyticsDailyPoint[] {
  const byDay = new Map(daily.map((item) => [item.day, item]));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const start = addUtcDays(end, -(Math.max(1, periodDays) - 1));
  const points: AnalyticsDailyPoint[] = [];
  for (let i = 0; i < Math.max(1, periodDays); i += 1) {
    const day = utcDayString(addUtcDays(start, i));
    const row = byDay.get(day);
    points.push({
      day,
      label: formatDayLabel(day),
      inputTokens: finite(row?.input_tokens),
      outputTokens: finite(row?.output_tokens),
      cacheReadTokens: finite(row?.cache_read_tokens),
      cacheWriteTokens: finite(row?.cache_write_tokens),
      reasoningTokens: finite(row?.reasoning_tokens),
      totalTokens: row ? totalTokens(row) : 0,
      sessions: finite(row?.sessions),
      apiCalls: finite(row?.api_calls),
    });
  }
  return points;
}

function modelView(row: AnalyticsModelBreakdown, totalTokenCount: number): AnalyticsModelView {
  const tokens = totalTokens(row);
  return {
    id: `${row.provider || "unknown"}:${row.model}`,
    model: row.model,
    provider: row.provider || "unknown",
    label: row.provider ? `${row.provider} · ${row.model}` : row.model,
    inputTokens: finite(row.input_tokens),
    outputTokens: finite(row.output_tokens),
    totalTokens: tokens,
    cacheReadTokens: finite(row.cache_read_tokens),
    cacheWriteTokens: finite(row.cache_write_tokens),
    reasoningTokens: finite(row.reasoning_tokens),
    sessions: finite(row.sessions),
    apiCalls: finite(row.api_calls),
    share: totalTokenCount > 0 ? tokens / totalTokenCount : 0,
  };
}

function topSessionView(row: AnalyticsTopSession): AnalyticsTopSessionView {
  const tokens = totalTokens(row);
  return {
    sessionId: row.session_id,
    title: row.title?.trim() || row.session_id,
    model: row.model?.trim() || "—",
    provider: row.provider || "unknown",
    startedAt: row.started_at,
    endedAt: row.ended_at,
    inputTokens: finite(row.input_tokens),
    outputTokens: finite(row.output_tokens),
    cacheReadTokens: finite(row.cache_read_tokens),
    cacheWriteTokens: finite(row.cache_write_tokens),
    reasoningTokens: finite(row.reasoning_tokens),
    totalTokens: tokens,
    apiCalls: finite(row.api_calls),
  };
}

function percentile(values: number[], p: number): number | null {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? null;
}

function average(values: number[]): number | null {
  const clean = values.filter((value) => Number.isFinite(value));
  if (clean.length === 0) return null;
  return clean.reduce((sum, value) => sum + value, 0) / clean.length;
}

function statNumber(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function statCompletedAt(stat: UiTurnStats): number | null {
  return statNumber(stat.completedAt) ?? statNumber(stat.createdAt);
}

function statOutputTokens(stat: UiTurnStats): number {
  const direct = finite(stat.tokensOutput);
  if (direct > 0) return direct;
  return Math.max(0, finite(stat.tokensTotal) - finite(stat.tokensInput));
}

function statTokPerSec(stat: UiTurnStats): number | null {
  const output = statOutputTokens(stat);
  const durationMs = statNumber(stat.durationMs);
  if (!durationMs || durationMs <= 0 || output <= 0) return null;
  return output / (durationMs / 1000);
}

function cacheHitRate(read: number, write: number, prompt: number): number | null {
  const denominator = read + write + prompt;
  if (denominator <= 0) return null;
  return read / denominator;
}

function performanceModelView(id: string, rows: UiTurnStats[]): AnalyticsPerformanceModelView {
  const [provider, ...modelParts] = id.split(":");
  const ttft = rows.map((row) => statNumber(row.ttftMs)).filter((value): value is number => value != null && value >= 0);
  const speed = rows.map(statTokPerSec).filter((value): value is number => value != null && value >= 0);
  return {
    id,
    provider: provider || "unknown",
    model: modelParts.join(":") || "unknown",
    samples: rows.length,
    avgTtftMs: average(ttft),
    p50TtftMs: percentile(ttft, 50),
    p95TtftMs: percentile(ttft, 95),
    avgTokPerSec: average(speed),
    p50TokPerSec: percentile(speed, 50),
    p95TokPerSec: percentile(speed, 95),
  };
}

export function buildAnalyticsPerformanceViewModel(
  vm: AnalyticsViewModel,
  turnStats: UiTurnStats[] = [],
): AnalyticsPerformanceViewModel {
  const cacheReadTokens = finite(vm.totals.total_cache_read);
  const cacheWriteTokens = finite(vm.totals.total_cache_write);
  const promptTokens = finite(vm.totals.total_input);
  const ttftValues = turnStats
    .map((row) => statNumber(row.ttftMs))
    .filter((value): value is number => value != null && value >= 0);
  const speedValues = turnStats
    .map(statTokPerSec)
    .filter((value): value is number => value != null && value >= 0);

  const daily = vm.daily.map((day) => ({
    day: day.day,
    label: day.label,
    cacheHitRate: cacheHitRate(day.cacheReadTokens, day.cacheWriteTokens, day.inputTokens),
    cacheReadTokens: day.cacheReadTokens,
    cacheWriteTokens: day.cacheWriteTokens,
    promptTokens: day.inputTokens,
  }));

  const byModel = new Map<string, UiTurnStats[]>();
  for (const stat of turnStats) {
    const model = stat.model?.trim();
    if (!model) continue;
    const provider = stat.provider?.trim() || "unknown";
    const key = `${provider}:${model}`;
    const rows = byModel.get(key) ?? [];
    rows.push(stat);
    byModel.set(key, rows);
  }

  const sessions = turnStats
    .map((stat) => ({
      sessionId: stat.sessionId,
      model: stat.model?.trim() || "unknown",
      provider: stat.provider?.trim() || "unknown",
      completedAt: statCompletedAt(stat),
      ttftMs: statNumber(stat.ttftMs),
      durationMs: statNumber(stat.durationMs),
      outputTokens: statOutputTokens(stat),
      tokPerSec: statTokPerSec(stat),
    }))
    .sort((a, b) => (b.tokPerSec ?? -1) - (a.tokPerSec ?? -1) || (b.completedAt ?? 0) - (a.completedAt ?? 0));

  return {
    cacheHitRate: cacheHitRate(cacheReadTokens, cacheWriteTokens, promptTokens),
    cacheReadTokens,
    cacheWriteTokens,
    promptTokens,
    ttftSamples: ttftValues.length,
    speedSamples: speedValues.length,
    avgTtftMs: average(ttftValues),
    p50TtftMs: percentile(ttftValues, 50),
    p95TtftMs: percentile(ttftValues, 95),
    avgTokPerSec: average(speedValues),
    p50TokPerSec: percentile(speedValues, 50),
    p95TokPerSec: percentile(speedValues, 95),
    daily,
    models: [...byModel.entries()]
      .map(([id, rows]) => performanceModelView(id, rows))
      .sort((a, b) => (b.avgTokPerSec ?? -1) - (a.avgTokPerSec ?? -1) || b.samples - a.samples),
    sessions,
  };
}

function buildKpis(totals: AnalyticsTotals, previous: AnalyticsTotals): AnalyticsKpiView[] {
  const currentAvgTokens = avgTokensPerSession(totals);
  const previousAvgTokens = avgTokensPerSession(previous);
  return [
    {
      key: "tokens",
      label: "总 Tokens",
      value: finite(totals.total_tokens),
      previous: finite(previous.total_tokens),
      changePercent: changePercent(finite(totals.total_tokens), finite(previous.total_tokens)),
    },
    {
      key: "apiCalls",
      label: "API 调用",
      value: finite(totals.total_api_calls),
      previous: finite(previous.total_api_calls),
      changePercent: changePercent(finite(totals.total_api_calls), finite(previous.total_api_calls)),
    },
    {
      key: "sessions",
      label: "会话数",
      value: finite(totals.total_sessions),
      previous: finite(previous.total_sessions),
      changePercent: changePercent(finite(totals.total_sessions), finite(previous.total_sessions)),
    },
    {
      key: "avgTokens",
      label: "平均 Token / 会话",
      value: currentAvgTokens,
      previous: previousAvgTokens,
      changePercent: changePercent(currentAvgTokens, previousAvgTokens),
    },
  ];
}

export function buildAnalyticsViewModel(data: AnalyticsResponse, now = new Date()): AnalyticsViewModel {
  const totalTokenCount = finite(data.totals.total_tokens);
  const models = data.by_model
    .map((item) => modelView(item, totalTokenCount))
    .sort((a, b) => b.totalTokens - a.totalTokens || b.apiCalls - a.apiCalls || a.label.localeCompare(b.label));
  const topSessions = data.top_sessions
    .map(topSessionView)
    .sort((a, b) => b.totalTokens - a.totalTokens || b.apiCalls - a.apiCalls || b.startedAt - a.startedAt);
  const daily = fillDaily(data.daily, data.period_days, now);
  return {
    periodDays: data.period_days,
    totals: data.totals,
    previousTotals: data.comparison.previous_totals,
    daily,
    models,
    topSessions,
    kpis: buildKpis(data.totals, data.comparison.previous_totals),
    isEmpty: totalTokenCount === 0 && finite(data.totals.total_sessions) === 0 && models.length === 0,
  };
}

export function analyticsContractErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  if (/invalid_type|Required|Zod|top_sessions|comparison|total_tokens/.test(raw)) {
    return "Analytics 后端合约不匹配，请更新 hermes-agent-cn runtime 后重试。";
  }
  return raw || "无法加载 Analytics 数据。";
}
