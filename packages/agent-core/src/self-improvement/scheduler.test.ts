import { describe, expect, it, vi } from "vitest";
import { BackgroundReviewScheduler } from "./scheduler.js";
import type { ReviewRequest } from "./types.js";

describe("BackgroundReviewScheduler", () => {
  it("starts and stops a setInterval timer", () => {
    vi.useFakeTimers();
    const onReview = vi.fn();
    const scheduler = new BackgroundReviewScheduler({
      intervalMs: 1_000,
      onTick: () => null,
      onReview,
    });

    expect(scheduler.isRunning).toBe(false);
    scheduler.start();
    expect(scheduler.isRunning).toBe(true);
    scheduler.stop();
    expect(scheduler.isRunning).toBe(false);
    vi.useRealTimers();
  });

  it("is idempotent when started multiple times", () => {
    vi.useFakeTimers();
    const scheduler = new BackgroundReviewScheduler({
      intervalMs: 100,
      onTick: () => null,
      onReview: vi.fn(),
    });
    scheduler.start();
    scheduler.start();
    expect(scheduler.isRunning).toBe(true);
    scheduler.stop();
    vi.useRealTimers();
  });

  it("emits a review when the tick returns a request", async () => {
    const request: ReviewRequest = {
      id: "r1",
      sessionId: "s1",
      kind: "memory",
      messages: [],
    };
    const onReview = vi.fn();
    const scheduler = new BackgroundReviewScheduler({
      intervalMs: 60_000,
      onTick: () => request,
      onReview,
    });

    await scheduler.tick({ sessionId: "s1", messages: [] });
    expect(onReview).toHaveBeenCalledWith(request);
  });

  it("skips overlapping ticks", async () => {
    let calls = 0;
    const scheduler = new BackgroundReviewScheduler({
      intervalMs: 60_000,
      onTick: async () => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return null;
      },
      onReview: vi.fn(),
    });

    const p1 = scheduler.tick();
    const p2 = scheduler.tick();
    await Promise.all([p1, p2]);

    expect(calls).toBe(1);
  });
});
