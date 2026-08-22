import { describe, it, expect } from "vitest";
import { CronScheduler } from "./scheduler.js";
import { InMemoryCronStore } from "./store.js";
import type { CronRunStatus } from "./types.js";

describe("cron/scheduler", () => {
  it("adds, lists, cancels and ticks jobs", async () => {
    const store = new InMemoryCronStore();
    let delivered = 0;
    const scheduler = new CronScheduler(store, {
      onPrompt: async () => {
        delivered++;
        return { status: "success" as CronRunStatus, output: "ok" };
      },
    });

    const id = scheduler.add("@every 1m", "say hi");
    expect(scheduler.list()).toHaveLength(1);
    expect(scheduler.cancel(id)).toBe(true);

    const now = Date.now();
    // re-enable and force tick
    const job = store.get(id)!;
    job.enabled = true;
    job.nextRunAt = now - 1;
    store.put(job);

    const fired = await scheduler.tick(now);
    expect(fired).toContain(id);
    expect(delivered).toBe(1);
    expect(store.runsFor(id)).toHaveLength(1);
  });
});
