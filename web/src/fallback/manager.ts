import { classifyApiError } from "./error-classifier.js";
import { getFallbackChain, sameDeployment } from "./chain.js";
import { computeRateLimitBackoff } from "./backoff.js";
import type { ClassifiedError, FallbackChainConfig, FallbackEntry, FailoverReason, FallbackStatusEvent } from "./types.js";

export interface RuntimeIdentity {
  provider: string;
  model: string;
  baseUrl?: string;
}

export class FallbackManager {
  private chain: FallbackEntry[] = [];
  private index = 0;
  private activated = false;
  private rateLimitedUntil = 0;
  private unavailableKeys = new Set<string>();
  private pendingNotice: FallbackStatusEvent | null = null;

  onChainChanged(cfg: FallbackChainConfig): void {
    this.chain = getFallbackChain(cfg);
    this.index = 0;
  }

  restorePrimaryRuntime(now: number): boolean {
    if (this.activated && now < this.rateLimitedUntil) return false;
    this.activated = false;
    this.index = 0;
    return true;
  }

  tryActivateFallback(reason: FailoverReason, current: RuntimeIdentity): boolean {
    if (this.activated) return false;
    const next = this.findNextCandidate(current);
    if (!next) {
      this.rateLimitedUntil = Date.now() + computeRateLimitBackoff(this.index);
      return false;
    }
    this.activated = true;
    this.pendingNotice = { activated: true, provider: next.provider, model: next.model, reason };
    return true;
  }

  classify(error: unknown): ClassifiedError {
    return classifyApiError(error);
  }

  getPendingNotice(): FallbackStatusEvent | null {
    const n = this.pendingNotice;
    this.pendingNotice = null;
    return n;
  }

  private findNextCandidate(current: RuntimeIdentity): FallbackEntry | undefined {
    while (this.index < this.chain.length) {
      const candidate = this.chain[this.index++];
      if (sameDeployment(candidate, current as FallbackEntry)) continue;
      return candidate;
    }
    return undefined;
  }
}
