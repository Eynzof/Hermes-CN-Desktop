/**
 * In-process usage tracker.
 *
 * Aggregates token usage per session and per turn. The tracker is intentionally
 * stateful but isolated: each runtime/session context owns its own instance.
 */

import {
  type UsageContext,
  type UsageCost,
  emptyUsageContext,
  emptyUsageCost,
  emptyUsageTokens,
  type SessionUsageAggregate,
  type UsageTokens,
  type TurnUsage,
} from "./types.js";

function sumUsageTokens(a: UsageTokens, b: UsageTokens): UsageTokens {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    reasoning: a.reasoning + b.reasoning,
    total: a.total + b.total,
    calls: a.calls + b.calls,
  };
}

function mergeUsageContext(a: UsageContext, b: UsageContext): UsageContext {
  const used = Math.max(a.used, b.used);
  const max = Math.max(a.max, b.max);
  const compressions = Math.max(a.compressions, b.compressions);
  return {
    used,
    max,
    percent: max > 0 ? Math.min(100, Math.max(0, (used / max) * 100)) : 0,
    compressions,
    estimated: a.estimated && b.estimated,
  };
}

function mergeUsageCost(a: UsageCost, b: UsageCost): UsageCost {
  return {
    costUsd: a.costUsd + b.costUsd,
    status: a.status === b.status ? a.status : "mixed",
  };
}

function makeSessionAggregate(sessionId: string): SessionUsageAggregate {
  return {
    sessionId,
    tokens: emptyUsageTokens(),
    context: emptyUsageContext(),
    cost: emptyUsageCost(),
    turns: [],
  };
}

export class UsageTracker {
  private readonly sessions = new Map<string, SessionUsageAggregate>();

  /**
   * Record a single turn for a session. The same turn index is idempotent:
   * calling it twice overwrites the previous turn's contribution.
   */
  addTurn(sessionId: string, turn: TurnUsage): void {
    const existing = this.sessions.get(sessionId) ?? makeSessionAggregate(sessionId);

    // Remove the old contribution for this turn index, if any.
    const oldTurn = existing.turns.find((t) => t.turnIndex === turn.turnIndex);
    if (oldTurn) {
      existing.tokens = subtractUsageTokens(existing.tokens, oldTurn.tokens);
      if (oldTurn.context) {
        // We cannot precisely subtract context; keep the latest context window.
        existing.context = oldTurn.context;
      }
      if (oldTurn.cost) {
        existing.cost.costUsd = Math.max(0, existing.cost.costUsd - oldTurn.cost.costUsd);
      }
    }

    existing.model = turn.model ?? existing.model;
    existing.provider = turn.provider ?? existing.provider;
    existing.tokens = sumUsageTokens(existing.tokens, turn.tokens);
    existing.context = turn.context
      ? mergeUsageContext(existing.context, turn.context)
      : existing.context;
    existing.cost = turn.cost ? mergeUsageCost(existing.cost, turn.cost) : existing.cost;

    const turns = existing.turns.filter((t) => t.turnIndex !== turn.turnIndex);
    turns.push(turn);
    turns.sort((a, b) => a.turnIndex - b.turnIndex);
    existing.turns = turns;

    this.sessions.set(sessionId, existing);
  }

  getSessionUsage(sessionId: string): SessionUsageAggregate | undefined {
    const aggregate = this.sessions.get(sessionId);
    if (!aggregate) return undefined;
    return {
      ...aggregate,
      tokens: { ...aggregate.tokens },
      context: { ...aggregate.context },
      cost: { ...aggregate.cost },
      turns: aggregate.turns.map((t) => ({ ...t })),
    };
  }

  listSessions(): string[] {
    return Array.from(this.sessions.keys());
  }

  resetSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  resetAll(): void {
    this.sessions.clear();
  }
}

function subtractUsageTokens(a: UsageTokens, b: UsageTokens): UsageTokens {
  return {
    input: Math.max(0, a.input - b.input),
    output: Math.max(0, a.output - b.output),
    cacheRead: Math.max(0, a.cacheRead - b.cacheRead),
    cacheWrite: Math.max(0, a.cacheWrite - b.cacheWrite),
    reasoning: Math.max(0, a.reasoning - b.reasoning),
    total: Math.max(0, a.total - b.total),
    calls: Math.max(0, a.calls - b.calls),
  };
}
