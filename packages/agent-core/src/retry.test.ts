import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  calculateRetryDelay,
  DEFAULT_RETRY_POLICY,
  shouldRetry,
  sleep,
} from "./retry.js";
import { AgentAbortError, AgentError, ProviderError, ToolError } from "./errors.js";

const policy = { maxAttempts: 4, baseDelayMs: 100, maxDelayMs: 1000 };

describe("DEFAULT_RETRY_POLICY", () => {
  it("defines a sensible default", () => {
    expect(DEFAULT_RETRY_POLICY).toEqual({
      maxAttempts: 3,
      baseDelayMs: 500,
      maxDelayMs: 10_000,
    });
  });
});

describe("calculateRetryDelay", () => {
  it("grows exponentially from the base delay", () => {
    expect(calculateRetryDelay(0, policy)).toBe(100);
    expect(calculateRetryDelay(1, policy)).toBe(200);
    expect(calculateRetryDelay(2, policy)).toBe(400);
    expect(calculateRetryDelay(3, policy)).toBe(800);
  });

  it("caps the delay at maxDelayMs", () => {
    expect(calculateRetryDelay(4, policy)).toBe(1000);
    expect(calculateRetryDelay(10, policy)).toBe(1000);
    expect(calculateRetryDelay(100, policy)).toBe(1000);
  });

  it("caps at maxDelayMs even when the cap is below the base", () => {
    const tinyCap = { maxAttempts: 3, baseDelayMs: 5000, maxDelayMs: 100 };
    expect(calculateRetryDelay(0, tinyCap)).toBe(100);
    expect(calculateRetryDelay(1, tinyCap)).toBe(100);
  });

  it("is monotonic for exponential growth below the cap", () => {
    const delays = [0, 1, 2, 3, 4, 5].map((attempt) => calculateRetryDelay(attempt, policy));
    for (let i = 1; i < delays.length; i++) {
      expect(delays[i]!).toBeGreaterThanOrEqual(delays[i - 1]!);
    }
  });
});

describe("shouldRetry", () => {
  it("returns false once the attempt budget is exhausted", () => {
    // maxAttempts=4 → attempts 0,1,2 may retry; attempt 3 is the last chance.
    const error = new Error("boom");
    expect(shouldRetry(error, 0, policy)).toBe(true);
    expect(shouldRetry(error, 1, policy)).toBe(true);
    expect(shouldRetry(error, 2, policy)).toBe(true);
    expect(shouldRetry(error, 3, policy)).toBe(false);
    expect(shouldRetry(error, 100, policy)).toBe(false);
  });

  it("never retries aborts regardless of remaining budget", () => {
    expect(shouldRetry(new AgentAbortError(), 0, policy)).toBe(false);
    expect(shouldRetry(new AgentAbortError(), 1, policy)).toBe(false);
  });

  it("retries only recoverable AgentErrors", () => {
    expect(shouldRetry(new ToolError("tool failed"), 0, policy)).toBe(true);
    expect(shouldRetry(new ProviderError("5xx", "openai", 503), 0, policy)).toBe(true);
    expect(shouldRetry(new ProviderError("4xx", "openai", 400), 0, policy)).toBe(false);
    expect(shouldRetry(new AgentError("permanent", "x", false), 0, policy)).toBe(false);
    expect(shouldRetry(new AgentError("transient", "x", true), 0, policy)).toBe(true);
  });

  it("treats plain Errors as assumed recoverable (unclassified runtime errors)", () => {
    expect(shouldRetry(new Error("network hiccup"), 0, policy)).toBe(true);
    expect(shouldRetry(new TypeError("bad"), 0, policy)).toBe(true);
  });

  it("never retries non-Error values", () => {
    expect(shouldRetry("boom", 0, policy)).toBe(false);
    expect(shouldRetry(undefined, 0, policy)).toBe(false);
    expect(shouldRetry(null, 0, policy)).toBe(false);
    expect(shouldRetry(42, 0, policy)).toBe(false);
    expect(shouldRetry({ message: "boom" }, 0, policy)).toBe(false);
  });
});

describe("sleep", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves after the requested delay", async () => {
    const promise = sleep(100);
    let settled = false;
    promise.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(99);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await promise;
    expect(settled).toBe(true);
  });

  it("resolves immediately for a zero delay", async () => {
    const promise = sleep(0);
    let settled = false;
    promise.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    await promise;
    expect(settled).toBe(true);
  });

  it("rejects with AbortError when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(sleep(1000, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  it("rejects with AbortError when aborted while waiting and clears the timer", async () => {
    const controller = new AbortController();
    const promise = sleep(100_000, controller.signal);

    let rejection: unknown;
    promise.catch((error) => {
      rejection = error;
    });

    controller.abort();
    await promise.catch(() => undefined);

    expect(rejection).toBeInstanceOf(DOMException);
    expect((rejection as DOMException).name).toBe("AbortError");

    // The pending timer must have been cleared: advancing time afterwards must
    // not resolve the promise (it already rejected).
    await vi.advanceTimersByTimeAsync(100_000);
    expect(rejection).toBeInstanceOf(DOMException);
  });

  it("works without a signal", async () => {
    const promise = sleep(50);
    await vi.advanceTimersByTimeAsync(50);
    await expect(promise).resolves.toBeUndefined();
  });
});
