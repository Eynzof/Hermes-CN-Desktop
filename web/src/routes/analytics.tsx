import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Bar,
  CartesianGrid,
  Cell,
  ComposedChart,
  Legend,
  Line,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { BarChart3, RefreshCw } from "lucide-react";
import { SectionShell } from "./section-shell";
import { TopBarActionButton } from "@/components/top-bar/top-bar";
import { useAnalytics } from "@/hooks/use-analytics";
import {
  analyticsContractErrorMessage,
  buildAnalyticsPerformanceViewModel,
  buildAnalyticsViewModel,
  type AnalyticsDailyPoint,
  type AnalyticsKpiView,
  type AnalyticsModelView,
  type AnalyticsPerformanceDailyPoint,
  type AnalyticsPerformanceModelView,
  type AnalyticsPerformanceSessionView,
  type AnalyticsPerformanceViewModel,
  type AnalyticsTopSessionView,
} from "@/lib/analytics";
import { formatDurationMs, formatTokPerSec, formatTokens, relativeTime } from "@/lib/format";
import { getUiTurnStatsWindow, type UiTurnStats } from "@/lib/ui-store";
import s from "./analytics.module.css";

const PERIODS = [
  { value: 7, label: "7 天" },
  { value: 30, label: "30 天" },
  { value: 90, label: "90 天" },
] as const;

const MODEL_COLORS = [
  "var(--h-accent)",
  "var(--sky)",
  "var(--h-ok)",
  "var(--h-warn)",
  "var(--plum)",
  "var(--h-err)",
  "var(--h-text-3)",
];

const TOP_SESSIONS_PAGE_SIZE = 8;
const DAILY_PAGE_SIZE = 10;
const PERFORMANCE_SAMPLE_PAGE_SIZE = 10;

type PageItem = number | "ellipsis-left" | "ellipsis-right";
type AnalyticsTab = "overview" | "performance";

function visiblePageItems(page: number, totalPages: number): PageItem[] {
  if (totalPages <= 7) return Array.from({ length: totalPages }, (_, index) => index + 1);

  const pages = new Set<number>([1, totalPages]);
  const start = Math.max(2, page - 1);
  const end = Math.min(totalPages - 1, page + 1);

  if (page <= 3) {
    for (let next = 2; next <= 4; next += 1) pages.add(next);
  } else if (page >= totalPages - 2) {
    for (let next = totalPages - 3; next <= totalPages - 1; next += 1) pages.add(next);
  } else {
    for (let next = start; next <= end; next += 1) pages.add(next);
  }

  const sorted = [...pages].filter((item) => item >= 1 && item <= totalPages).sort((a, b) => a - b);
  const items: PageItem[] = [];
  sorted.forEach((item, index) => {
    const previous = sorted[index - 1];
    if (previous && item - previous > 1) items.push(previous === 1 ? "ellipsis-left" : "ellipsis-right");
    items.push(item);
  });
  return items;
}

function formatPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "上期为 0";
  const abs = Math.abs(value);
  if (abs < 0.1) return "持平";
  return `${value > 0 ? "+" : ""}${abs >= 100 ? value.toFixed(0) : value.toFixed(1)}%`;
}

function formatRate(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(value >= 0.1 ? 1 : 2)}%`;
}

function formatInteger(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 }).format(Math.round(value));
}

function formatNullableDuration(value: number | null): string {
  return value == null ? "—" : formatDurationMs(value);
}

function formatNullableSpeed(value: number | null): string {
  return value == null ? "—" : `${formatTokPerSec(value)} tok/s`;
}

function formatKpiValue(kpi: AnalyticsKpiView): string {
  if (kpi.key === "tokens" || kpi.key === "avgTokens") return formatTokens(kpi.value);
  return formatInteger(kpi.value);
}

function kpiSubLabel(kpi: AnalyticsKpiView): string {
  if (kpi.changePercent === 0) return "较上期持平";
  if (kpi.changePercent === null) return kpi.value > 0 ? "上期为 0" : "暂无上期数据";
  return `较上期 ${formatPercent(kpi.changePercent)}`;
}

function KpiCard({ kpi }: { kpi: AnalyticsKpiView }) {
  const tone = kpi.changePercent == null || kpi.changePercent === 0
    ? "flat"
    : kpi.changePercent > 0
      ? "up"
      : "down";
  return (
    <div className={s.kpiCard}>
      <div className={s.kpiLabel}>{kpi.label}</div>
      <div className={s.kpiValue}>{formatKpiValue(kpi)}</div>
      <div className={s.kpiSub} data-tone={tone}>{kpiSubLabel(kpi)}</div>
    </div>
  );
}

function PerformanceKpiCard({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className={s.kpiCard}>
      <div className={s.kpiLabel}>{label}</div>
      <div className={s.kpiValue}>{value}</div>
      <div className={s.kpiSub}>{sub}</div>
    </div>
  );
}

function ChartTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{ name?: string | number; value?: unknown; color?: string; dataKey?: string | number }>;
  label?: string | number;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className={s.tooltip}>
      <div className={s.tooltipTitle}>{label}</div>
      {payload.map((item) => {
        const value = typeof item.value === "number" ? item.value : 0;
        const key = String(item.dataKey ?? item.name ?? "");
        return (
          <div key={`${key}-${String(item.name)}`} className={s.tooltipRow}>
            <span className={s.tooltipDot} style={{ background: item.color }} />
            <span>{item.name}</span>
            <strong>{formatTokens(value)}</strong>
          </div>
        );
      })}
    </div>
  );
}

function CacheTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{ name?: string | number; value?: unknown; color?: string; dataKey?: string | number }>;
  label?: string | number;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className={s.tooltip}>
      <div className={s.tooltipTitle}>{label}</div>
      {payload.map((item) => {
        const value = typeof item.value === "number" ? item.value : 0;
        const isRate = String(item.dataKey ?? "") === "cacheHitRatePercent";
        return (
          <div key={`${String(item.dataKey)}-${String(item.name)}`} className={s.tooltipRow}>
            <span className={s.tooltipDot} style={{ background: item.color }} />
            <span>{item.name}</span>
            <strong>{isRate ? `${value.toFixed(1)}%` : formatTokens(value)}</strong>
          </div>
        );
      })}
    </div>
  );
}

function ModelTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{
    payload?: { name: string; provider: string; tokens: number; share: number; apiCalls: number };
  }>;
}) {
  const item = payload?.[0]?.payload;
  if (!active || !item) return null;
  return (
    <div className={s.tooltip}>
      <div className={s.tooltipTitle}>{item.name}</div>
      <div className={s.tooltipRow}>
        <span className={s.tooltipDot} style={{ background: "var(--h-accent)" }} />
        <span>Provider</span>
        <strong>{item.provider}</strong>
      </div>
      <div className={s.tooltipRow}>
        <span className={s.tooltipDot} style={{ background: "var(--sky)" }} />
        <span>Tokens</span>
        <strong>{formatTokens(item.tokens)}</strong>
      </div>
      <div className={s.tooltipRow}>
        <span className={s.tooltipDot} style={{ background: "var(--h-warn)" }} />
        <span>API</span>
        <strong>{formatInteger(item.apiCalls)}</strong>
      </div>
      <div className={s.tooltipRow}>
        <span className={s.tooltipDot} style={{ background: "var(--h-ok)" }} />
        <span>占比</span>
        <strong>{(item.share * 100).toFixed(1)}%</strong>
      </div>
    </div>
  );
}

function usePagedRows<T>(rows: T[], pageSize: number) {
  const [page, setPage] = useState(1);
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));

  useEffect(() => {
    setPage((current) => Math.min(Math.max(1, current), totalPages));
  }, [totalPages]);

  const start = rows.length === 0 ? 0 : (page - 1) * pageSize;
  const end = Math.min(rows.length, start + pageSize);
  const pageRows = useMemo(() => rows.slice(start, end), [rows, start, end]);

  return {
    page,
    setPage,
    totalPages,
    pageRows,
    from: rows.length === 0 ? 0 : start + 1,
    to: end,
    total: rows.length,
  };
}

function PaginationControls({
  page,
  totalPages,
  from,
  to,
  total,
  onPageChange,
}: {
  page: number;
  totalPages: number;
  from: number;
  to: number;
  total: number;
  onPageChange: (page: number) => void;
}) {
  if (total <= 0) return null;
  const pageItems = visiblePageItems(page, totalPages);
  return (
    <div className={s.pagination}>
      <span>{`显示 ${from}-${to} / ${total} · 第 ${page} / ${totalPages} 页`}</span>
      <div className={s.paginationButtons}>
        <button type="button" disabled={page <= 1} onClick={() => onPageChange(page - 1)}>上一页</button>
        <div className={s.pageNumbers} aria-label="分页页码">
          {pageItems.map((item) => {
            if (typeof item !== "number") return <span key={item} className={s.pageEllipsis}>…</span>;
            return (
              <button
                key={item}
                type="button"
                aria-current={item === page ? "page" : undefined}
                data-active={item === page ? "true" : undefined}
                onClick={() => onPageChange(item)}
              >
                {item}
              </button>
            );
          })}
        </div>
        <button type="button" disabled={page >= totalPages} onClick={() => onPageChange(page + 1)}>下一页</button>
      </div>
    </div>
  );
}

function AnalyticsTabs({ active, onChange }: { active: AnalyticsTab; onChange: (tab: AnalyticsTab) => void }) {
  return (
    <div className={s.tabs} role="tablist" aria-label="数据分析视图">
      <button type="button" role="tab" aria-selected={active === "overview"} data-active={active === "overview" ? "true" : undefined} onClick={() => onChange("overview")}>用量概览</button>
      <button type="button" role="tab" aria-selected={active === "performance"} data-active={active === "performance" ? "true" : undefined} onClick={() => onChange("performance")}>性能指标</button>
    </div>
  );
}

function TokenTrendChart({ daily }: { daily: AnalyticsDailyPoint[] }) {
  return (
    <section className={s.panel}>
      <div className={s.panelHeader}>
        <div>
          <h2>Token 使用趋势</h2>
          <p>按天展示输入、输出与推理 Token，缓存读取以折线辅助观察。</p>
        </div>
      </div>
      <div className={s.chartBox}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={daily} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid stroke="var(--h-line-soft)" vertical={false} />
            <XAxis dataKey="label" stroke="var(--h-text-3)" tickLine={false} axisLine={false} minTickGap={18} />
            <YAxis stroke="var(--h-text-3)" tickLine={false} axisLine={false} tickFormatter={(v) => formatTokens(Number(v))} width={42} />
            <Tooltip content={<ChartTooltip />} />
            <Legend wrapperStyle={{ color: "var(--h-text-2)", fontSize: 11 }} />
            <Bar name="输入 Token" dataKey="inputTokens" stackId="tokens" fill="var(--h-accent)" radius={[0, 0, 3, 3]} />
            <Bar name="输出 Token" dataKey="outputTokens" stackId="tokens" fill="var(--sky)" radius={[3, 3, 0, 0]} />
            <Bar name="推理 Token" dataKey="reasoningTokens" stackId="tokens" fill="var(--plum)" radius={[3, 3, 0, 0]} />
            <Line name="缓存读取" dataKey="cacheReadTokens" type="monotone" stroke="var(--h-ok)" strokeWidth={2} dot={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}

function ModelTokenChart({ models }: { models: AnalyticsModelView[] }) {
  const data = models.slice(0, 7).map((model, index) => ({
    name: model.model,
    provider: model.provider,
    value: model.totalTokens,
    tokens: model.totalTokens,
    share: model.share,
    apiCalls: model.apiCalls,
    color: MODEL_COLORS[index % MODEL_COLORS.length],
  }));

  return (
    <section className={s.panel}>
      <div className={s.panelHeader}>
        <div>
          <h2>模型 Token 占比</h2>
          <p>按 Token 总量展示主要模型分布，帮助判断用量集中在哪些模型。</p>
        </div>
      </div>
      {data.length === 0 ? (
        <div className={s.emptyPanel}>暂无模型用量。</div>
      ) : (
        <div className={s.modelChartLayout}>
          <div className={s.pieBox}>
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={data} dataKey="value" nameKey="name" innerRadius={54} outerRadius={82} paddingAngle={2}>
                  {data.map((entry) => <Cell key={entry.name} fill={entry.color} />)}
                </Pie>
                <Tooltip content={<ModelTooltip />} />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <div className={s.modelLegend}>
            {data.map((item) => (
              <div key={`${item.provider}:${item.name}`} className={s.modelLegendRow}>
                <span className={s.legendDot} style={{ background: item.color }} />
                <span className={s.legendName} title={`${item.provider} · ${item.name}`}>{item.name}</span>
                <span className={s.legendValue}>{(item.share * 100).toFixed(1)}%</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function CachePerformanceChart({ daily }: { daily: AnalyticsPerformanceDailyPoint[] }) {
  const data = daily.map((day) => ({
    ...day,
    cacheHitRatePercent: day.cacheHitRate == null ? null : day.cacheHitRate * 100,
  }));
  return (
    <section className={s.panel}>
      <div className={s.panelHeader}>
        <div>
          <h2>缓存趋势</h2>
          <p>柱形展示缓存读写 Token，折线展示缓存命中率。</p>
        </div>
      </div>
      <div className={s.chartBox}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid stroke="var(--h-line-soft)" vertical={false} />
            <XAxis dataKey="label" stroke="var(--h-text-3)" tickLine={false} axisLine={false} minTickGap={18} />
            <YAxis yAxisId="tokens" stroke="var(--h-text-3)" tickLine={false} axisLine={false} tickFormatter={(v) => formatTokens(Number(v))} width={42} />
            <YAxis yAxisId="rate" orientation="right" domain={[0, 100]} stroke="var(--h-text-3)" tickLine={false} axisLine={false} tickFormatter={(v) => `${Number(v).toFixed(0)}%`} width={42} />
            <Tooltip content={<CacheTooltip />} />
            <Legend wrapperStyle={{ color: "var(--h-text-2)", fontSize: 11 }} />
            <Bar yAxisId="tokens" name="缓存读取" dataKey="cacheReadTokens" fill="var(--h-ok)" radius={[3, 3, 0, 0]} />
            <Bar yAxisId="tokens" name="缓存写入" dataKey="cacheWriteTokens" fill="var(--h-warn)" radius={[3, 3, 0, 0]} />
            <Line yAxisId="rate" name="命中率" dataKey="cacheHitRatePercent" type="monotone" stroke="var(--sky)" strokeWidth={2} dot={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}

function TopSessionsTable({ sessions, onOpen }: { sessions: AnalyticsTopSessionView[]; onOpen: (id: string) => void }) {
  const pager = usePagedRows(sessions, TOP_SESSIONS_PAGE_SIZE);
  return (
    <section className={s.panel}>
      <div className={s.panelHeader}>
        <div>
          <h2>高用量会话</h2>
          <p>按 Token 总量排序，展示当前周期内最值得复盘的会话。</p>
        </div>
      </div>
      {sessions.length === 0 ? (
        <div className={s.emptyPanel}>暂无高用量会话。</div>
      ) : (
        <>
          <div className={s.tableWrap}>
            <table className={s.table}>
              <thead>
                <tr>
                  <th>会话</th>
                  <th>模型</th>
                  <th>时间</th>
                  <th>输入</th>
                  <th>输出</th>
                  <th>总量</th>
                  <th>API</th>
                </tr>
              </thead>
              <tbody>
                {pager.pageRows.map((session) => (
                  <tr key={session.sessionId} onClick={() => onOpen(session.sessionId)}>
                    <td>
                      <div className={s.sessionTitle}>{session.title}</div>
                      <div className={s.sessionId}>{session.sessionId}</div>
                    </td>
                    <td>
                      <div className={s.modelName}>{session.model}</div>
                      <div className={s.muted}>{session.provider}</div>
                    </td>
                    <td>{relativeTime(session.startedAt)}</td>
                    <td>{formatTokens(session.inputTokens)}</td>
                    <td>{formatTokens(session.outputTokens)}</td>
                    <td>{formatTokens(session.totalTokens)}</td>
                    <td>{formatInteger(session.apiCalls)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <PaginationControls {...pager} onPageChange={pager.setPage} />
        </>
      )}
    </section>
  );
}

function DailyTable({ daily }: { daily: AnalyticsDailyPoint[] }) {
  const rows = useMemo(() => [...daily].reverse(), [daily]);
  const pager = usePagedRows(rows, DAILY_PAGE_SIZE);
  return (
    <section className={s.panel}>
      <div className={s.panelHeader}>
        <div>
          <h2>每日明细</h2>
          <p>按日期拆解 Token、缓存读写、推理 Token、会话和 API 调用；默认最新日期在前。</p>
        </div>
      </div>
      <div className={s.tableWrap}>
        <table className={s.table}>
          <thead>
            <tr>
              <th>日期</th>
              <th>输入</th>
              <th>输出</th>
              <th>缓存读</th>
              <th>缓存写</th>
              <th>推理</th>
              <th>总量</th>
              <th>会话</th>
              <th>API</th>
            </tr>
          </thead>
          <tbody>
            {pager.pageRows.map((day) => (
              <tr key={day.day}>
                <td>{day.day}</td>
                <td>{formatTokens(day.inputTokens)}</td>
                <td>{formatTokens(day.outputTokens)}</td>
                <td>{formatTokens(day.cacheReadTokens)}</td>
                <td>{formatTokens(day.cacheWriteTokens)}</td>
                <td>{formatTokens(day.reasoningTokens)}</td>
                <td>{formatTokens(day.totalTokens)}</td>
                <td>{formatInteger(day.sessions)}</td>
                <td>{formatInteger(day.apiCalls)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <PaginationControls {...pager} onPageChange={pager.setPage} />
    </section>
  );
}

function PerformanceModelTable({ models }: { models: AnalyticsPerformanceModelView[] }) {
  return (
    <section className={s.panel}>
      <div className={s.panelHeader}>
        <div>
          <h2>模型性能</h2>
          <p>按桌面端采样聚合各模型 TTFT 和输出速度。</p>
        </div>
      </div>
      {models.length === 0 ? (
        <div className={s.emptyPanel}>暂无可用于模型性能聚合的采样。</div>
      ) : (
        <div className={s.tableWrap}>
          <table className={s.table}>
            <thead>
              <tr>
                <th>模型</th>
                <th>采样</th>
                <th>TTFT P50</th>
                <th>TTFT P95</th>
                <th>速度 P50</th>
                <th>速度 P95</th>
              </tr>
            </thead>
            <tbody>
              {models.slice(0, 12).map((model) => (
                <tr key={model.id}>
                  <td>
                    <div className={s.modelName}>{model.model}</div>
                    <div className={s.muted}>{model.provider}</div>
                  </td>
                  <td>{formatInteger(model.samples)}</td>
                  <td>{formatNullableDuration(model.p50TtftMs)}</td>
                  <td>{formatNullableDuration(model.p95TtftMs)}</td>
                  <td>{formatNullableSpeed(model.p50TokPerSec)}</td>
                  <td>{formatNullableSpeed(model.p95TokPerSec)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function PerformanceSessionTable({ sessions, onOpen }: { sessions: AnalyticsPerformanceSessionView[]; onOpen: (id: string) => void }) {
  const pager = usePagedRows(sessions, PERFORMANCE_SAMPLE_PAGE_SIZE);
  return (
    <section className={s.panel}>
      <div className={s.panelHeader}>
        <div>
          <h2>速度采样</h2>
          <p>展示最近采样的单轮 TTFT、耗时和输出速度。</p>
        </div>
      </div>
      {sessions.length === 0 ? (
        <div className={s.emptyPanel}>暂无 TTFT / Token Speed 采样。</div>
      ) : (
        <>
          <div className={s.tableWrap}>
            <table className={s.table}>
              <thead>
                <tr>
                  <th>会话</th>
                  <th>模型</th>
                  <th>TTFT</th>
                  <th>耗时</th>
                  <th>输出</th>
                  <th>Token Speed</th>
                  <th>时间</th>
                </tr>
              </thead>
              <tbody>
                {pager.pageRows.map((row, index) => (
                  <tr key={`${row.sessionId}-${row.completedAt ?? index}`} onClick={() => onOpen(row.sessionId)}>
                    <td><div className={s.sessionId}>{row.sessionId}</div></td>
                    <td>
                      <div className={s.modelName}>{row.model}</div>
                      <div className={s.muted}>{row.provider}</div>
                    </td>
                    <td>{formatNullableDuration(row.ttftMs)}</td>
                    <td>{formatNullableDuration(row.durationMs)}</td>
                    <td>{formatTokens(row.outputTokens)}</td>
                    <td>{formatNullableSpeed(row.tokPerSec)}</td>
                    <td>{row.completedAt ? relativeTime(row.completedAt / 1000) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <PaginationControls {...pager} onPageChange={pager.setPage} />
        </>
      )}
    </section>
  );
}

function PerformancePanel({ perf, statsLoading, onOpen }: { perf: AnalyticsPerformanceViewModel; statsLoading: boolean; onOpen: (id: string) => void }) {
  return (
    <>
      <div className={s.kpiGrid}>
        <PerformanceKpiCard
          label="缓存命中率"
          value={formatRate(perf.cacheHitRate)}
          sub={`${formatTokens(perf.cacheReadTokens)} 读 / ${formatTokens(perf.cacheWriteTokens)} 写`}
        />
        <PerformanceKpiCard
          label="TTFT P50"
          value={formatNullableDuration(perf.p50TtftMs)}
          sub={perf.ttftSamples > 0 ? `${formatInteger(perf.ttftSamples)} 个首 token 采样` : statsLoading ? "正在读取采样" : "暂无首 token 采样"}
        />
        <PerformanceKpiCard
          label="Token Speed P50"
          value={formatNullableSpeed(perf.p50TokPerSec)}
          sub={perf.speedSamples > 0 ? `${formatInteger(perf.speedSamples)} 个速度采样` : statsLoading ? "正在读取采样" : "暂无速度采样"}
        />
        <PerformanceKpiCard
          label="TTFT P95"
          value={formatNullableDuration(perf.p95TtftMs)}
          sub={`平均 ${formatNullableDuration(perf.avgTtftMs)} · 速度均值 ${formatNullableSpeed(perf.avgTokPerSec)}`}
        />
      </div>

      <CachePerformanceChart daily={perf.daily} />
      <PerformanceModelTable models={perf.models} />
      <PerformanceSessionTable sessions={perf.sessions} onOpen={onOpen} />
    </>
  );
}

function PeriodSwitch({ days, onChange }: { days: number; onChange: (days: number) => void }) {
  return (
    <div className={s.periodSwitch} role="radiogroup" aria-label="统计周期">
      {PERIODS.map((period) => (
        <button
          key={period.value}
          type="button"
          role="radio"
          aria-checked={days === period.value}
          data-active={days === period.value ? "true" : undefined}
          onClick={() => onChange(period.value)}
        >
          {period.label}
        </button>
      ))}
    </div>
  );
}

function AnalyticsLoading() {
  return (
    <div className={s.loadingPage} aria-live="polite" aria-busy="true">
      <div className={s.loadingCard}>
        <div className={s.loadingOrb}>
          <BarChart3 size={28} />
        </div>
        <div>
          <strong>正在生成数据分析</strong>
          <p>正在读取会话、聚合 Token、缓存与性能采样，请稍候。</p>
        </div>
        <div className={s.loadingSkeletonGrid} aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
      </div>
    </div>
  );
}

export function AnalyticsRoute() {
  const [days, setDays] = useState(30);
  const [activeTab, setActiveTab] = useState<AnalyticsTab>("overview");
  const [turnStats, setTurnStats] = useState<UiTurnStats[]>([]);
  const [statsLoading, setStatsLoading] = useState(false);
  const [statsReloadKey, setStatsReloadKey] = useState(0);
  const query = useAnalytics(days);
  const navigate = useNavigate();
  const vm = useMemo(() => query.data ? buildAnalyticsViewModel(query.data) : null, [query.data]);
  const perf = useMemo(() => vm ? buildAnalyticsPerformanceViewModel(vm, turnStats) : null, [vm, turnStats]);
  const subtitle = vm
    ? `${vm.periodDays} 天 · ${formatTokens(vm.totals.total_tokens)} tokens · ${formatInteger(vm.totals.total_api_calls)} 次 API 调用`
    : "查看 Token、会话、API 调用、缓存与模型性能。";

  useEffect(() => {
    if (!query.data) {
      setTurnStats([]);
      return;
    }
    let cancelled = false;
    const sinceMs = Date.now() - days * 86400 * 1000;
    setStatsLoading(true);
    void getUiTurnStatsWindow({ sinceMs, limit: 20_000 })
      .then((rows) => {
        if (!cancelled) setTurnStats(rows);
      })
      .finally(() => {
        if (!cancelled) setStatsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [days, query.data, query.dataUpdatedAt, statsReloadKey]);

  const refreshAll = () => {
    setStatsReloadKey((value) => value + 1);
    void query.refetch();
  };

  return (
    <SectionShell
      title="数据分析"
      sub={subtitle}
      right={(
        <>
          <PeriodSwitch days={days} onChange={setDays} />
          <TopBarActionButton onClick={refreshAll} disabled={query.isFetching || statsLoading}>
            <RefreshCw size={12} />
            {query.isFetching || statsLoading ? "刷新中" : "刷新"}
          </TopBarActionButton>
        </>
      )}
    >
      <div className={s.page}>
        {query.isLoading ? (
          <AnalyticsLoading />
        ) : query.isError ? (
          <div className={s.stateCard} data-tone="error">
            <BarChart3 size={22} />
            <div>
              <strong>无法加载数据分析</strong>
              <p>{analyticsContractErrorMessage(query.error)}</p>
            </div>
          </div>
        ) : vm ? (
          vm.isEmpty ? (
            <>
              <AnalyticsTabs active={activeTab} onChange={setActiveTab} />
              <div className={s.stateCard}>
                <BarChart3 size={24} />
                <div>
                  <strong>这个时间范围内暂无用量数据</strong>
                  <p>开始一次会话后，这里会展示 Token、API 调用、缓存与模型性能。</p>
                </div>
              </div>
            </>
          ) : (
            <>
              <AnalyticsTabs active={activeTab} onChange={setActiveTab} />
              {activeTab === "overview" ? (
                <>
                  <div className={s.kpiGrid}>
                    {vm.kpis.map((kpi) => <KpiCard key={kpi.key} kpi={kpi} />)}
                  </div>

                  <div className={s.mainGrid}>
                    <TokenTrendChart daily={vm.daily} />
                    <ModelTokenChart models={vm.models} />
                  </div>

                  <TopSessionsTable sessions={vm.topSessions} onOpen={(id) => navigate(`/tasks/${encodeURIComponent(id)}`)} />
                  <DailyTable daily={vm.daily} />
                </>
              ) : perf ? (
                <PerformancePanel perf={perf} statsLoading={statsLoading} onOpen={(id) => navigate(`/tasks/${encodeURIComponent(id)}`)} />
              ) : null}
            </>
          )
        ) : null}
      </div>
    </SectionShell>
  );
}
