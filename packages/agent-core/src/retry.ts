import { AgentError, isAbortError } from "./errors.js";

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 10_000,
};

export function calculateRetryDelay(attempt: number, policy: RetryPolicy): number {
  const exponential = policy.baseDelayMs * 2 ** attempt;
  return Math.min(exponential, policy.maxDelayMs);
}

export function shouldRetry(error: unknown, attempt: number, policy: RetryPolicy): boolean {
  if (attempt >= policy.maxAttempts - 1) return false;
  if (isAbortError(error)) return false;
  if (error instanceof AgentError) return error.recoverable;
  // Network-ish runtime errors are assumed recoverable until classified.
  return error instanceof Error;
}

export async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    });
  });
}

export interface RetryState {
  attempt: number;
  lastError?: unknown;
}
