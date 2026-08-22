import type { CronJob, CronRun } from "./types.js";

export interface CronStore {
  list(): CronJob[];
  get(id: string): CronJob | undefined;
  put(job: CronJob): void;
  remove(id: string): boolean;
  recordRun(run: CronRun): void;
}

export class InMemoryCronStore implements CronStore {
  private jobs = new Map<string, CronJob>();
  private runs = new Map<string, CronRun[]>();

  list(): CronJob[] {
    return Array.from(this.jobs.values()).sort((a, b) => a.createdAt - b.createdAt);
  }

  get(id: string): CronJob | undefined {
    return this.jobs.get(id);
  }

  put(job: CronJob): void {
    this.jobs.set(job.id, job);
  }

  remove(id: string): boolean {
    return this.jobs.delete(id);
  }

  recordRun(run: CronRun): void {
    const list = this.runs.get(run.jobId) ?? [];
    list.push(run);
    this.runs.set(run.jobId, list);
  }

  runsFor(id: string): CronRun[] {
    return this.runs.get(id)?.slice() ?? [];
  }
}
