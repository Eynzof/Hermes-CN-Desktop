/**
 * Usage types shared by the in-process agent core.
 *
 * Mirrors the Python `agent/account_usage.py` and `agent/usage_pricing.py`
 * contracts in a transport-agnostic form.
 */

export interface UsageTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  total: number;
  calls: number;
}

export interface UsageContext {
  used: number;
  max: number;
  percent: number;
  compressions: number;
  estimated: boolean;
}

export interface UsageCost {
  costUsd: number;
  status: string;
}

export interface TurnUsage {
  turnIndex: number;
  timestamp: number;
  model?: string;
  provider?: string;
  tokens: UsageTokens;
  context?: UsageContext;
  cost?: UsageCost;
  durationMs?: number;
}

export interface SessionUsageAggregate {
  sessionId: string;
  model?: string;
  provider?: string;
  tokens: UsageTokens;
  context: UsageContext;
  cost: UsageCost;
  turns: TurnUsage[];
}

export function emptyUsageTokens(): UsageTokens {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    total: 0,
    calls: 0,
  };
}

export function emptyUsageContext(): UsageContext {
  return {
    used: 0,
    max: 0,
    percent: 0,
    compressions: 0,
    estimated: true,
  };
}

export function emptyUsageCost(): UsageCost {
  return {
    costUsd: 0,
    status: "unknown",
  };
}
