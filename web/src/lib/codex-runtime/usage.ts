export interface CanonicalUsage {
  inputTokens: number;
  outputTokens: number;
  cacheWrite: number;
}

export function recordCodexUsage(total: number, last: number): CanonicalUsage {
  return {
    inputTokens: 0,
    outputTokens: last,
    cacheWrite: 0,
  };
}
