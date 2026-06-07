import { describe, expect, it } from "vitest";
import { CronJob, CronJobsResponse, CronRunDetail, CronRunsResponse } from "./hermes-api";

describe("CronJobsResponse", () => {
  it("parses current dashboard cron jobs with structured schedules", () => {
    const jobs = CronJobsResponse.parse([
      {
        id: "38003fd5cfdd",
        name: "Aa",
        prompt: "aa",
        schedule: { kind: "cron", expr: "0 9 * * *", display: "0 9 * * *" },
        schedule_display: "0 9 * * *",
        enabled: true,
        state: "scheduled",
        next_run_at: "2026-06-06T09:00:00+08:00",
        last_run_at: null,
        deliver: "local",
        profile: "default",
      },
    ]);

    expect(jobs[0]?.schedule).toEqual({ kind: "cron", expr: "0 9 * * *", display: "0 9 * * *" });
    expect(jobs[0]?.next_run_at).toBe("2026-06-06T09:00:00+08:00");
  });

  it("keeps accepting legacy cron jobs with string schedules", () => {
    const jobs = CronJobsResponse.parse([
      {
        id: "legacy",
        schedule: "0 9 * * *",
        enabled: false,
        next_run: null,
        last_run: null,
      },
    ]);

    expect(jobs[0]?.schedule).toBe("0 9 * * *");
    expect(jobs[0]?.enabled).toBe(false);
  });
});


describe("Cron run history schemas", () => {
  it("parses desktop cron run list responses", () => {
    const response = CronRunsResponse.parse({
      job_id: "job1",
      profile: "default",
      runs: [
        {
          job_id: "job1",
          profile: "default",
          filename: "2026-06-07_09-00-00.md",
          started_at: "2026-06-07T09:00:00",
          status: "success",
          summary: "完成",
          size_bytes: 123,
        },
      ],
    });

    expect(response.runs[0]?.status).toBe("success");
    expect(response.runs[0]?.filename).toBe("2026-06-07_09-00-00.md");
  });

  it("parses run detail responses with content and truncation state", () => {
    const detail = CronRunDetail.parse({
      job_id: "job1",
      profile: "alpha",
      filename: "2026-06-07_09-00-00.md",
      started_at: "2026-06-07T09:00:00",
      status: "blocked",
      summary: "执行被阻断",
      size_bytes: 2048,
      content: "# Cron Job",
      truncated: true,
    });

    expect(detail.profile).toBe("alpha");
    expect(detail.status).toBe("blocked");
    expect(detail.truncated).toBe(true);
  });

  it("rejects unexpected cron run statuses", () => {
    expect(() =>
      CronRunsResponse.parse({
        job_id: "job1",
        profile: "default",
        runs: [
          {
            job_id: "job1",
            profile: "default",
            filename: "2026-06-07_09-00-00.md",
            started_at: "2026-06-07T09:00:00",
            status: "running",
            summary: "still running",
            size_bytes: 1,
          },
        ],
      }),
    ).toThrow();
  });

  it("keeps accepting passthrough fields on cron jobs", () => {
    const job = CronJob.parse({
      id: "job1",
      schedule: "0 9 * * *",
      enabled: true,
      last_run_at: null,
      next_run_at: null,
      custom_field: "kept",
    });

    expect((job as any).custom_field).toBe("kept");
  });
});
