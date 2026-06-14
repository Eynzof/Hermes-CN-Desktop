import { describe, expect, it } from "vitest";
import {
  AnalyticsResponse,
  AudioSpeakResponse,
  AudioTranscriptionResponse,
  CronJob,
  CronJobsResponse,
  CronRunDetail,
  CronRunsResponse,
  ElevenLabsVoicesResponse,
  SessionsResponse,
  SessionCompressResult,
  SessionSummary,
} from "./hermes-api";


describe("Audio API schemas", () => {
  it("parses desktop transcription responses", () => {
    const parsed = AudioTranscriptionResponse.parse({
      ok: true,
      transcript: "你好 Hermes",
      provider: "openai",
    });

    expect(parsed.transcript).toBe("你好 Hermes");
    expect(parsed.provider).toBe("openai");
  });

  it("parses desktop speech responses with nullable provider", () => {
    const parsed = AudioSpeakResponse.parse({
      ok: true,
      data_url: "data:audio/mpeg;base64,AAAA",
      mime_type: "audio/mpeg",
      provider: null,
    });

    expect(parsed.data_url).toContain("data:audio/mpeg");
    expect(parsed.provider).toBeNull();
  });

  it("parses ElevenLabs voice list responses", () => {
    const parsed = ElevenLabsVoicesResponse.parse({
      available: true,
      voices: [
        {
          voice_id: "voice-1",
          name: "Rachel",
          label: "Rachel (premade)",
        },
      ],
    });

    expect(parsed.available).toBe(true);
    expect(parsed.voices[0]?.voice_id).toBe("voice-1");
  });
});

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

describe("AnalyticsResponse", () => {
  const totals = {
    total_input: 10,
    total_output: 5,
    total_tokens: 15,
    total_cache_read: 1,
    total_cache_write: 0,
    total_reasoning: 2,
    total_sessions: 1,
    total_api_calls: 3,
    avg_tokens_per_session: 15,
  };

  it("parses the enhanced analytics contract", () => {
    const parsed = AnalyticsResponse.parse({
      daily: [
        {
          day: "2026-06-07",
          input_tokens: 10,
          output_tokens: 5,
          cache_read_tokens: 1,
          cache_write_tokens: 0,
          reasoning_tokens: 2,
          sessions: 1,
          api_calls: 3,
        },
      ],
      by_model: [
        {
          model: "model-a",
          provider: "provider-a",
          input_tokens: 10,
          output_tokens: 5,
          cache_read_tokens: 1,
          cache_write_tokens: 0,
          reasoning_tokens: 2,
          sessions: 1,
          api_calls: 3,
        },
      ],
      top_sessions: [
        {
          session_id: "s1",
          title: "Session",
          model: "model-a",
          provider: "provider-a",
          started_at: 1,
          ended_at: null,
          input_tokens: 10,
          output_tokens: 5,
          cache_read_tokens: 1,
          cache_write_tokens: 0,
          reasoning_tokens: 2,
          api_calls: 3,
        },
      ],
      totals,
      comparison: { previous_totals: { ...totals, total_tokens: 5 } },
      period_days: 7,
      skills: {
        summary: {
          total_skill_loads: 0,
          total_skill_edits: 0,
          total_skill_actions: 0,
          distinct_skills_used: 0,
        },
        top_skills: [],
      },
    });

    expect(parsed.top_sessions[0]?.session_id).toBe("s1");
    expect(parsed.comparison.previous_totals.total_tokens).toBe(5);
  });

  it("rejects the old analytics contract without top_sessions and comparison", () => {
    expect(() =>
      AnalyticsResponse.parse({
        daily: [],
        by_model: [],
        totals: {},
        period_days: 7,
        skills: {
          summary: {
            total_skill_loads: 0,
            total_skill_edits: 0,
            total_skill_actions: 0,
            distinct_skills_used: 0,
          },
          top_skills: [],
        },
      }),
    ).toThrow();
  });
});

describe("SessionCompressResult", () => {
  it("accepts current backend structured manual compression summaries", () => {
    const parsed = SessionCompressResult.parse({
      status: "compressed",
      removed: 0,
      before_messages: 0,
      after_messages: 0,
      before_tokens: 0,
      after_tokens: 0,
      summary: {
        noop: true,
        headline: "No changes from compression: 0 messages",
        token_line: "Approx request size: ~0 tokens (unchanged)",
        note: null,
      },
      usage: { total: 0, compressions: 0 },
    });

    expect(parsed.summary).toMatchObject({ noop: true });
  });

  it("keeps accepting older string summaries", () => {
    const parsed = SessionCompressResult.parse({
      status: "compressed",
      summary: "Compressed: 20 → 8 messages",
    });

    expect(parsed.summary).toBe("Compressed: 20 → 8 messages");
  });
});

describe("SessionSummary cwd (#216)", () => {
  const baseSession = {
    id: "20260613_000000_abcd",
    model: "claude-opus-4-8",
    title: "Demo",
    started_at: 1,
    ended_at: null,
    message_count: 2,
    input_tokens: 10,
    output_tokens: 20,
    estimated_cost_usd: null,
  };

  it("carries the backend per-session cwd", () => {
    const parsed = SessionSummary.parse({ ...baseSession, cwd: "/Users/claw/project-a" });
    expect(parsed.cwd).toBe("/Users/claw/project-a");
  });

  it("accepts a null cwd for sessions with no explicit workspace", () => {
    const parsed = SessionSummary.parse({ ...baseSession, cwd: null });
    expect(parsed.cwd).toBeNull();
  });

  it("treats cwd as optional for older payloads", () => {
    const parsed = SessionSummary.parse(baseSession);
    expect(parsed.cwd).toBeUndefined();
  });

  it("preserves cwd through the /api/sessions list response", () => {
    const parsed = SessionsResponse.parse({
      sessions: [{ ...baseSession, cwd: "/Users/claw/project-b" }],
      total: 1,
      limit: 50,
      offset: 0,
    });
    expect(parsed.sessions[0]?.cwd).toBe("/Users/claw/project-b");
  });
});
