import { TTL_401, TTL_429, TTL_DEFAULT, TTL_SOLE } from "./constants.js";
import { selectCredential } from "./strategies.js";
import type { ErrorContext, FailureReason, PooledCredential, RotationStrategy } from "./types.js";

export class CredentialPool {
  private cursor = 0;

  constructor(
    private provider: string,
    private entries: PooledCredential[],
    private strategy: RotationStrategy = "fill_first",
  ) {}

  select(): PooledCredential | null {
    const picked = selectCredential(this.entries, this.strategy, this.cursor);
    if (picked) {
      picked.request_count += 1;
      this.cursor += 1;
    }
    return picked;
  }

  markExhaustedAndRotate(opts: {
    statusCode?: number;
    failureReason?: FailureReason;
    credentialId?: string;
  }): PooledCredential | null {
    const id = opts.credentialId ?? this.entries.find((e) => e.last_status !== "exhausted" && e.last_status !== "dead")?.id;
    if (!id) return null;
    const entry = this.entries.find((e) => e.id === id);
    if (entry) {
      entry.last_status = "exhausted";
      entry.last_status_at = Date.now();
      entry.last_error_code = opts.statusCode;
      entry.last_error_reason = opts.failureReason;
    }
    const ttl = this.computeTtl(opts.statusCode, opts.failureReason);
    if (this.entries.length === 1 && this.entries[0].id === id) {
      this.entries[0].last_error_reset_at = Date.now() + TTL_SOLE;
    }
    const next = this.select();
    if (!next && ttl) {
      // No available entry; keep current exhausted until TTL.
    }
    return next;
  }

  async acquireLease(_credentialId?: string): Promise<string | null> {
    const entry = this.select();
    if (!entry) return null;
    return entry.id;
  }

  async releaseLease(_credentialId: string): Promise<void> {}

  entriesList(): PooledCredential[] {
    return this.entries;
  }

  hasAvailable(): boolean {
    return this.entries.some((e) => e.last_status !== "exhausted" && e.last_status !== "dead");
  }

  nextAvailableAt(): number | null {
    const times = this.entries
      .filter((e) => e.last_error_reset_at)
      .map((e) => e.last_error_reset_at ?? 0);
    return times.length ? Math.min(...times) : null;
  }

  private computeTtl(statusCode?: number, reason?: FailureReason): number {
    if (statusCode === 401 || reason === "auth") return TTL_401;
    if (statusCode === 429 || reason === "rate_limit" || reason === "billing" || reason === "upstream_rate_limit") return TTL_429;
    return TTL_DEFAULT;
  }
}
