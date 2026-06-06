import { describe, expect, it } from "vitest";
import { CronJobsResponse } from "./hermes-api";

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
