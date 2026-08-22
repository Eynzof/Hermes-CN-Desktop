import { useMemo } from "react";
import { useSessionMessages } from "@/hooks/use-sessions";
import { useSessionUsagePolling } from "@/hooks/use-session-usage-polling";
import { computeContextBreakdown, type ContextBreakdownCategory } from "@/lib/context-usage/formatter";
import { estimateRenderedContextTokens } from "@/lib/context-usage";
import type { SessionUsageResult } from "@hermes/protocol";

export interface ContextUsageViewModel {
  model?: string;
  used?: number;
  max?: number;
  percent?: number;
  estimated: boolean;
  compressions?: number;
  categories: ContextBreakdownCategory[];
  sessionUsage?: SessionUsageResult | null;
}

export interface UseContextUsageParams {
  gatewaySessionId?: string;
  restSessionId?: string;
  runtimeIsBusy?: boolean;
  getSessionUsage?: (sessionId: string) => Promise<SessionUsageResult>;
}

function positiveNumber(value: unknown): number | undefined {
  const num = typeof value === "number" && Number.isFinite(value) ? value : undefined;
  return num !== undefined && num > 0 ? num : undefined;
}

function formatPercent(raw: number | undefined): number | undefined {
  if (raw === undefined) return undefined;
  return Math.min(100, Math.max(0, raw));
}

export function useContextUsage(params: UseContextUsageParams): {
  usage: ContextUsageViewModel | null;
  isLoading: boolean;
} {
  const { gatewaySessionId, restSessionId, runtimeIsBusy = false, getSessionUsage } = params;

  const [sessionUsage] = useSessionUsagePolling({
    gatewaySessionId,
    restSessionId,
    runtimeIsBusy,
    getSessionUsage: getSessionUsage ?? (async () => ({})),
  });

  const messagesQuery = useSessionMessages(restSessionId);

  const usage = useMemo((): ContextUsageViewModel | null => {
    const liveUsed = positiveNumber(sessionUsage?.context_used);
    const liveMax = positiveNumber(sessionUsage?.context_max);
    const livePercent = formatPercent(sessionUsage?.context_percent);
    const liveModel = sessionUsage?.model;

    const localEstimate = estimateRenderedContextTokens(
      (messagesQuery.data?.messages ?? []).map((m) => ({
        text: typeof m.content === "string" ? m.content : "",
      })),
    );

    const used = liveUsed ?? localEstimate;
    const max = liveMax ?? 128_000;
    const percent = livePercent ?? (used !== undefined && max > 0 ? Math.min(100, (used / max) * 100) : undefined);
    const estimated = liveUsed === undefined && localEstimate !== undefined;

    const breakdown = computeContextBreakdown({
      model: liveModel,
      contextMax: max,
      conversationMessages: messagesQuery.data?.messages ?? [],
    });

    return {
      model: liveModel,
      used,
      max,
      percent,
      estimated,
      compressions: sessionUsage?.compressions ?? undefined,
      categories: breakdown.categories,
      sessionUsage,
    };
  }, [sessionUsage, messagesQuery.data]);

  const isLoading = messagesQuery.isLoading;

  return { usage, isLoading };
}
