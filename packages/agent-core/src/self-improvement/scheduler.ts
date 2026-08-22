/**
 * Background review scheduler stub.
 *
 * Gates periodic review scans with a configurable interval and a single active
 * review guard so multiple setInterval ticks cannot pile up.
 */

import type { Message } from "../types.js";
import type { ReviewRequest } from "./types.js";

export interface BackgroundSchedulerOptions {
  /** Interval in milliseconds (default 60_000). */
  intervalMs?: number;
  /** Called on each tick; should return a request or null to skip. */
  onTick: (
    ctx: { sessionId: string; messages: readonly Message[] },
  ) => ReviewRequest | null | Promise<ReviewRequest | null>;
  /** Called when a review request is produced. */
  onReview: (request: ReviewRequest) => void;
}

/** Simple setInterval-based scheduler with a one-at-a-time guard. */
export class BackgroundReviewScheduler {
  private readonly intervalMs: number;
  private readonly onTick: BackgroundSchedulerOptions["onTick"];
  private readonly onReview: BackgroundSchedulerOptions["onReview"];
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(options: BackgroundSchedulerOptions) {
    this.intervalMs = options.intervalMs ?? 60_000;
    this.onTick = options.onTick;
    this.onReview = options.onReview;
  }

  /** Whether the scheduler is currently active. */
  get isRunning(): boolean {
    return this.timer !== null;
  }

  /** Start the scheduler; safe to call multiple times (idempotent). */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
  }

  /** Stop the scheduler. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Run a single review tick, gated so overlapping ticks are skipped.
   * Exposed publicly so tests can drive ticks deterministically.
   */
  async tick(
    ctx: { sessionId: string; messages: readonly Message[] } = { sessionId: "background", messages: [] },
  ): Promise<ReviewRequest | null> {
    if (this.running) return null;
    this.running = true;
    try {
      const request = await this.onTick(ctx);
      if (request) {
        this.onReview(request);
      }
      return request;
    } finally {
      this.running = false;
    }
  }
}
