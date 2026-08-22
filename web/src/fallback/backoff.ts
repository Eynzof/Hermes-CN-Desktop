const MIN_BACKOFF = 60_000;
const MAX_BACKOFF = 4 * 60 * 60 * 1_000;

export function computeRateLimitBackoff(attempt: number, retryAfter?: number): number {
  if (retryAfter && retryAfter > 0) return Math.min(retryAfter * 1_000, MAX_BACKOFF);
  const delay = Math.min(MIN_BACKOFF * Math.pow(2, attempt), MAX_BACKOFF);
  return delay;
}
