/**
 * Code-execution daemon pool.
 *
 * Mirrors Python `tools/daemonpool.py`: a bounded pool of concurrent executors
 * with an idle timeout. Jobs are queued when the pool is saturated and executed
 * as slots free up.
 */

import type { CodeExecutorBackend } from "./executor.js";
import type { CodeLanguage, CodeRunStatus } from "./types.js";

export interface DaemonPoolOptions {
  backend: CodeExecutorBackend;
  /** Max concurrent executions. Default 2. */
  concurrency?: number;
  /** Idle milliseconds before an unused slot is considered stale. Default 30s. */
  idleMs?: number;
  now?: () => number;
}

export interface PoolRunResult {
  status: CodeRunStatus;
  stdout: string;
  stderr: string;
  exitCode?: number;
  durationMs: number;
}

export class DaemonPool {
  private readonly backend: CodeExecutorBackend;
  private readonly concurrency: number;
  private readonly idleMs: number;
  private readonly now: () => number;
  private running = 0;
  private queue: Array<() => void> = [];
  private lastActive = 0;

  constructor(options: DaemonPoolOptions) {
    this.backend = options.backend;
    this.concurrency = Math.max(1, options.concurrency ?? 2);
    this.idleMs = options.idleMs ?? 30_000;
    this.now = options.now ?? Date.now;
    this.lastActive = this.now();
  }

  get active(): number {
    return this.running;
  }

  get queued(): number {
    return this.queue.length;
  }

  /** True when the pool has been idle long enough to be torn down. */
  get idleExpired(): boolean {
    return this.running === 0 && this.now() - this.lastActive >= this.idleMs;
  }

  /** Run code through the pool, queuing when saturated. */
  async run(code: string, language: CodeLanguage, timeout: number): Promise<PoolRunResult> {
    // Reserve a slot synchronously (before the first await) so concurrent
    // callers cannot both observe a free slot.
    if (this.running >= this.concurrency) {
      await new Promise<void>((resolve) => {
        this.queue.push(resolve);
      });
    }
    this.running += 1;
    this.lastActive = this.now();
    try {
      return await this.backend.run(code, language, timeout);
    } finally {
      this.running -= 1;
      this.lastActive = this.now();
      const next = this.queue.shift();
      if (next) next();
    }
  }
}
