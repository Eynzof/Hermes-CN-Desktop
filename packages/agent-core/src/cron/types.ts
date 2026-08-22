/**
 * Cron scheduled task data models.
 */

export type CronRunStatus = "pending" | "success" | "error" | "blocked" | "silent";

export interface CronJob {
  id: string;
  schedule: string;
  prompt: string;
  enabled: boolean;
  createdAt: number;
  nextRunAt?: number;
  lastRunAt?: number;
  runCount: number;
  lastStatus?: CronRunStatus;
  lastError?: string;
}

export interface CronRun {
  jobId: string;
  startedAt: number;
  status: CronRunStatus;
  output: string;
}
