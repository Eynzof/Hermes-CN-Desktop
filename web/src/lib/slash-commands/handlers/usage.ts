/**
 * Local slash-command handlers for context/usage visibility commands:
 * `/context`, `/status`, `/usage`, `/insights`.
 */

import type { AnalyticsResponse, SessionUsageResult } from "@hermes/protocol";
import type { SessionStore } from "@/lib/session-store/session-store";
import type { UiTurnStats } from "@/lib/ui-store";
import { formatTokens, relativeTime } from "@/lib/format";
import {
  computeContextBreakdown,
  formatContextOutput,
  parseContextArgs,
  type ContextBreakdownSnapshot,
} from "@/lib/context-usage/formatter";
import { buildInsightsLines } from "@/lib/context-usage/insights";
import type { CommandResult } from "../types";

function ok(output: string, extras?: Partial<CommandResult>): CommandResult {
  return { type: "exec", output, ...extras };
}

function err(message: string): CommandResult {
  return { type: "error", message };
}

export interface UsageHandlerContext {
  activeSessionId: string | null;
  store: SessionStore;
  getBuildInfo?: () => { version?: string; backendVersion?: string } | undefined;
  getSessionUsage?: (sessionId: string) => Promise<SessionUsageResult>;
  getAnalytics?: (days: number, source?: string) => Promise<AnalyticsResponse>;
  getTurnStats?: (sessionId: string) => Promise<UiTurnStats[]>;
}

/**
 * `/context [all]` — show a visual breakdown of the current context window.
 */
export async function handleContext(args: string, ctx: UsageHandlerContext): Promise<CommandResult> {
  if (!ctx.activeSessionId) return err("No active session");

  const session = await ctx.store.get(ctx.activeSessionId);
  if (!session) return err("Session not found");

  const messages = await ctx.store.getMessages(ctx.activeSessionId);
  const { all } = parseContextArgs(args);

  const snapshot: ContextBreakdownSnapshot = {
    model: session.model ?? undefined,
    contextMax: undefined,
    systemPrompt: "",
    rules: "",
    skillsText: "",
    memoryText: "",
    conversationMessages: messages,
    tools: [],
    mcpTools: [],
    subagentTools: [],
  };

  const breakdown = computeContextBreakdown(snapshot);
  const output = formatContextOutput(breakdown, { all, grid: true });
  return ok(output, { name: "context" });
}

/**
 * `/status` — show session-level runtime status.
 */
export async function handleStatus(args: string, ctx: UsageHandlerContext): Promise<CommandResult> {
  if (!ctx.activeSessionId) return err("No active session");

  const session = await ctx.store.get(ctx.activeSessionId);
  if (!session) return err("Session not found");

  const messages = await ctx.store.getMessages(ctx.activeSessionId);
  const buildInfo = ctx.getBuildInfo?.();

  const lines: string[] = [];
  lines.push(`Session: ${session.id}`);
  if (session.title) lines.push(`Title: ${session.title}`);
  lines.push(`Model: ${session.model || "default"}`);
  lines.push(`Messages: ${messages.length}`);
  lines.push(`Started: ${relativeTime(session.started_at)}`);
  if (session.last_active && session.last_active !== session.started_at) {
    lines.push(`Updated: ${relativeTime(session.last_active)}`);
  }
  if (session.input_tokens || session.output_tokens) {
    lines.push(`Tokens: ${formatTokens(session.input_tokens + session.output_tokens)} (in ${formatTokens(session.input_tokens)} / out ${formatTokens(session.output_tokens)})`);
  }
  if (buildInfo?.backendVersion) {
    lines.push(`Backend: ${buildInfo.backendVersion}`);
  }
  lines.push("Agent running: not available locally");

  return ok(lines.join("\n"), { name: "status" });
}

function finite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function formatSessionUsageResult(usage: SessionUsageResult): string {
  const lines: string[] = [];
  const model = usage.model || "unknown";
  lines.push(`Model: ${model}`);
  lines.push("");
  lines.push("Session tokens:");
  lines.push(`  Input:  ${formatTokens(finite(usage.input))}`);
  lines.push(`  Output: ${formatTokens(finite(usage.output))}`);
  lines.push(`  Cache read:  ${formatTokens(finite(usage.cache_read))}`);
  lines.push(`  Cache write: ${formatTokens(finite(usage.cache_write))}`);
  lines.push(`  Total:  ${formatTokens(finite(usage.total))}`);
  lines.push(`  Calls:  ${finite(usage.calls)}`);
  lines.push("");
  lines.push("Context window:");
  const used = finite(usage.context_used);
  const max = finite(usage.context_max);
  const pct = finite(usage.context_percent);
  lines.push(`  Used: ${formatTokens(used)} / ${formatTokens(max)} (${pct.toFixed(1)}%)`);
  if (typeof usage.compressions === "number" && usage.compressions > 0) {
    lines.push(`  Compressions: ${usage.compressions}`);
  }
  lines.push("");
  lines.push("Cost:");
  lines.push(`  USD: $${(finite(usage.cost_usd)).toFixed(4)}`);
  lines.push(`  Status: ${usage.cost_status || "unknown"}`);
  return lines.join("\n");
}

function aggregateTurnStats(stats: UiTurnStats[]): SessionUsageResult {
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let reasoning = 0;
  let total = 0;
  let calls = 0;
  let contextUsed = 0;
  let contextMax = 0;
  let compressions = 0;
  let costUsd = 0;
  const models = new Set<string>();

  for (const stat of stats) {
    input += finite(stat.tokensInput);
    output += finite(stat.tokensOutput);
    cacheRead += finite(stat.cacheRead);
    cacheWrite += finite(stat.cacheWrite);
    reasoning += finite(stat.reasoningTokens);
    total += finite(stat.tokensTotal);
    calls += finite(stat.apiCalls);
    contextUsed = Math.max(contextUsed, finite(stat.contextUsed));
    contextMax = Math.max(contextMax, finite(stat.contextMax));
    compressions = Math.max(compressions, 0);
    costUsd += finite(stat.costUsd);
    if (stat.model) models.add(stat.model);
  }

  return {
    model: Array.from(models).join(", ") || undefined,
    input,
    output,
    cache_read: cacheRead,
    cache_write: cacheWrite,
    total,
    calls,
    context_used: contextUsed,
    context_max: contextMax,
    context_percent: contextMax > 0 ? Math.min(100, (contextUsed / contextMax) * 100) : 0,
    compressions,
    cost_usd: costUsd,
    cost_status: "estimated",
  };
}

/**
 * `/usage [session]` — show token/cost usage for the active session.
 */
export async function handleUsage(args: string, ctx: UsageHandlerContext): Promise<CommandResult> {
  if (!ctx.activeSessionId) return err("No active session");

  let usage: SessionUsageResult | undefined;

  if (ctx.getSessionUsage) {
    try {
      usage = await ctx.getSessionUsage(ctx.activeSessionId);
    } catch {
      // fail open and try local turn stats below
    }
  }

  if (!usage && ctx.getTurnStats) {
    const stats = await ctx.getTurnStats(ctx.activeSessionId);
    usage = aggregateTurnStats(stats);
  }

  if (!usage) {
    return ok("Usage data is not available for this session.");
  }

  return ok(formatSessionUsageResult(usage), { name: "usage" });
}

function parseInsightsArgs(args: string): { days: number; source?: string } {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const firstNumber = tokens.find((t) => /^\d+$/.test(t));
  const days = firstNumber ? Number(firstNumber) : 30;
  const sourceMatch = args.match(/--source\s+(\S+)/);
  return { days, source: sourceMatch?.[1] };
}

/**
 * `/insights [days] [--source X]` — show analytics summary.
 */
export async function handleInsights(args: string, ctx: UsageHandlerContext): Promise<CommandResult> {
  const { days, source } = parseInsightsArgs(args);

  let analytics: AnalyticsResponse | undefined;
  if (ctx.getAnalytics) {
    try {
      analytics = await ctx.getAnalytics(days, source);
    } catch {
      // fail open
    }
  }

  const turnStats = ctx.getTurnStats ? await ctx.getTurnStats(ctx.activeSessionId ?? "") : [];
  const output = buildInsightsLines({ days, source, analytics, turnStats });
  return ok(output.join("\n"), { name: "insights" });
}
