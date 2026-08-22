/**
 * Simple usage insights heuristics for `/insights`.
 *
 * This is a lightweight, in-process fallback that summarises the analytics
 * response or local turn stats. A full SQL `InsightsEngine` can replace this
 * module once the in-process session database is wired.
 */

import type { AnalyticsModelBreakdown, AnalyticsResponse, AnalyticsTopSession } from "@hermes/protocol";
import type { UiTurnStats } from "@/lib/ui-store";

export interface InsightsInput {
  days?: number;
  source?: string;
  analytics?: AnalyticsResponse;
  turnStats?: UiTurnStats[];
}

function finite(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 }).format(Math.round(value));
}

function modelTotalTokens(row: AnalyticsModelBreakdown): number {
  return finite(row.input_tokens) + finite(row.output_tokens);
}

function topSessionsFromAnalytics(rows: readonly AnalyticsTopSession[]): string[] {
  const sorted = [...rows]
    .map((s) => ({ ...s, total: finite(s.input_tokens) + finite(s.output_tokens) }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 5);
  return sorted.map((s) => `  ${(s.title || s.session_id).padEnd(24)} ${formatNumber(s.total).padStart(8)} tokens`);
}

export function buildInsightsLines(input: InsightsInput): string[] {
  const days = input.days ?? 30;
  const sourceSuffix = input.source ? ` · source ${input.source}` : "";
  const lines: string[] = [];
  lines.push(`📊 Usage Insights — last ${days} days${sourceSuffix}`);
  lines.push("");

  if (input.analytics) {
    const totals = input.analytics.totals;
    const totalTokens = finite(totals.total_tokens);
    const sessions = finite(totals.total_sessions);
    const calls = finite(totals.total_api_calls);

    lines.push(`总 Tokens: ${formatNumber(totalTokens)}`);
    lines.push(`会话数: ${formatNumber(sessions)}`);
    lines.push(`API 调用: ${formatNumber(calls)}`);
    lines.push("");

    const models = [...input.analytics.by_model]
      .map((m) => ({ ...m, total: modelTotalTokens(m) }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 5);
    if (models.length > 0) {
      lines.push("Top Models:");
      for (const m of models) {
        lines.push(`  ${(m.provider ? `${m.provider} · ${m.model}` : m.model).padEnd(24)} ${formatNumber(m.total).padStart(8)} tokens`);
      }
      lines.push("");
    }

    const skillSummary = input.analytics.skills?.summary;
    if (skillSummary) {
      const distinct = finite(skillSummary.distinct_skills_used);
      const loads = finite(skillSummary.total_skill_loads);
      if (distinct > 0 || loads > 0) {
        lines.push("Skills:");
        lines.push(`  使用过的 skills: ${formatNumber(distinct)}`);
        lines.push(`  skill 调用: ${formatNumber(loads)}`);
        lines.push("");
      }
    }

    if (input.analytics.top_sessions.length > 0) {
      lines.push("Top Sessions:");
      lines.push(...topSessionsFromAnalytics(input.analytics.top_sessions));
    }

    return lines;
  }

  if (input.turnStats && input.turnStats.length > 0) {
    let total = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    const byModel = new Map<string, number>();
    for (const stat of input.turnStats) {
      const inTokens = finite(stat.tokensInput);
      const outTokens = finite(stat.tokensOutput);
      total += inTokens + outTokens;
      inputTokens += inTokens;
      outputTokens += outTokens;
      const model = stat.model?.trim() || "unknown";
      byModel.set(model, (byModel.get(model) ?? 0) + inTokens + outTokens);
    }
    lines.push(`总 Tokens: ${formatNumber(total)} (in ${formatNumber(inputTokens)} / out ${formatNumber(outputTokens)})`);
    lines.push(`本地回合统计: ${formatNumber(input.turnStats.length)}`);
    lines.push("");
    const topModels = Array.from(byModel.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);
    if (topModels.length > 0) {
      lines.push("Top Models:");
      for (const [model, tokens] of topModels) {
        lines.push(`  ${model.padEnd(24)} ${formatNumber(tokens).padStart(8)} tokens`);
      }
    }
    return lines;
  }

  lines.push("No analytics or turn stats available.");
  return lines;
}

export function formatInsightsMarkdown(input: InsightsInput): string {
  return buildInsightsLines(input).join("\n");
}
