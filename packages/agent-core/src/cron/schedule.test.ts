import { describe, it, expect } from "vitest";
import { nextRunTime, parseCronExpression } from "./schedule.js";

describe("cron/schedule", () => {
  it("parses @every Nm", () => {
    const p = parseCronExpression("@every 5m");
    expect(p.valid).toBe(true);
    expect(p.normalized).toBe("@every 5m");
    expect(p.nextAfter(0)).toBe(5 * 60_000);
  });

  it("rejects garbage", () => {
    expect(parseCronExpression("not a cron").valid).toBe(false);
  });

  it("computes next run", () => {
    const now = 1_000_000;
    expect(nextRunTime("@hourly", now)).toBeGreaterThanOrEqual(now);
  });
});
