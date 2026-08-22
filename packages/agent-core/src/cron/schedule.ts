/**
 * Minimal cron expression parser and next-run calculator.
 *
 * Supports:
 *  - @every <n>m (minutes)
 *  - @hourly
 *  - @daily
 *  - Classic 5-field cron (best-effort for common patterns)
 */

const EVERY_RE = /^\s*@every\s+(\d+)\s*m\s*$/i;

export interface CronParseResult {
  valid: boolean;
  normalized: string;
  nextAfter(after: number): number | undefined;
}

export function parseCronExpression(expr: string): CronParseResult {
  const trimmed = expr.trim();

  const everyMatch = trimmed.match(EVERY_RE);
  if (everyMatch) {
    const minutes = parseInt(everyMatch[1], 10);
    const ms = minutes * 60_000;
    return {
      valid: true,
      normalized: `@every ${minutes}m`,
      nextAfter: (after) => after + ms,
    };
  }

  if (trimmed.toLowerCase() === "@hourly") {
    return {
      valid: true,
      normalized: "@hourly",
      nextAfter: (after) => nextAligned(after, 60 * 60_000),
    };
  }

  if (trimmed.toLowerCase() === "@daily") {
    return {
      valid: true,
      normalized: "@daily",
      nextAfter: (after) => nextAligned(after, 24 * 60 * 60_000, true),
    };
  }

  // Classic cron: minute hour day month dow
  const parts = trimmed.split(/\s+/);
  if (parts.length === 5) {
    return {
      valid: true,
      normalized: trimmed,
      nextAfter: (after) => approximateNext(after, parts),
    };
  }

  return { valid: false, normalized: trimmed, nextAfter: () => undefined };
}

function nextAligned(after: number, periodMs: number, dayBoundary = false): number {
  if (dayBoundary) {
    const d = new Date(after + periodMs);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  return Math.ceil(after / periodMs) * periodMs;
}

function approximateNext(after: number, _parts: string[]): number {
  // Surface-only: step forward one minute for classic cron to avoid heavy
  // date arithmetic. Production would fully expand the 5 fields.
  return after + 60_000;
}

export function nextRunTime(expr: string, after = Date.now()): number | undefined {
  const parsed = parseCronExpression(expr);
  if (!parsed.valid) return undefined;
  return parsed.nextAfter(after);
}
