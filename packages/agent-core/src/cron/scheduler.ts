import { nextRunTime, parseCronExpression } from "./schedule.js";
import type { CronJob, CronRun, CronRunStatus } from "./types.js";
import type { CronStore } from "./store.js";

export interface CronDelivery {
  onPrompt(job: CronJob): Promise<{ status: CronRunStatus; output: string }>;
}

export class CronScheduler {
  private store: CronStore;
  private delivery: CronDelivery;

  constructor(store: CronStore, delivery: CronDelivery) {
    this.store = store;
    this.delivery = delivery;
  }

  add(schedule: string, prompt: string): string {
    const parsed = parseCronExpression(schedule);
    if (!parsed.valid) {
      throw new Error(`Invalid cron expression: ${schedule}`);
    }
    const now = Date.now();
    const job: CronJob = {
      id: `cron-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      schedule: parsed.normalized,
      prompt,
      enabled: true,
      createdAt: now,
      nextRunAt: parsed.nextAfter(now),
      runCount: 0,
    };
    this.store.put(job);
    return job.id;
  }

  cancel(id: string): boolean {
    const job = this.store.get(id);
    if (!job) return false;
    job.enabled = false;
    this.store.put(job);
    return true;
  }

  remove(id: string): boolean {
    return this.store.remove(id);
  }

  list(): CronJob[] {
    return this.store.list();
  }

  async tick(now = Date.now()): Promise<string[]> {
    const fired: string[] = [];
    for (const job of this.store.list()) {
      if (!job.enabled || !job.nextRunAt) continue;
      if (now >= job.nextRunAt) {
        fired.push(job.id);
        const result = await this.delivery.onPrompt(job);
        const run: CronRun = {
          jobId: job.id,
          startedAt: now,
          status: result.status,
          output: result.output,
        };
        this.store.recordRun(run);
        job.lastRunAt = now;
        job.lastStatus = result.status;
        job.runCount += 1;
        const parsed = parseCronExpression(job.schedule);
        job.nextRunAt = parsed.valid ? parsed.nextAfter(now) : undefined;
        this.store.put(job);
      }
    }
    return fired;
  }
}
