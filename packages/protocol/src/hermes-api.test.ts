import { describe, expect, it } from "vitest";
import {
  ActiveProfileResponse,
  AnalyticsResponse,
  AudioSpeakResponse,
  AudioTranscriptionResponse,
  CronJob,
  CronJobsResponse,
  CronRunDetail,
  CronRunsResponse,
  ElevenLabsVoicesResponse,
  FsListResponse,
  ProviderModelsListResult,
  ProfileCreateResponse,
  ProfileSummary,
  SearchResponse,
  SessionsResponse,
  SkillsHubSearchResponse,
  SessionCompressResult,
  SessionSummary,
  StatusResponse,
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

describe("Profile API schemas", () => {
  it("parses the current upstream {active, current} active-profile shape", () => {
    const parsed = ActiveProfileResponse.parse({ active: "work", current: "default" });
    expect(parsed).toEqual({ active: "work", current: "default" });
  });

  it("normalizes the legacy CN-fork {name} shape to {active, current}", () => {
    // 旧 P-008 runtime 只返回 {name}；新代码统一读 active/current，不能因缺字段而炸。
    const parsed = ActiveProfileResponse.parse({ name: "sandbox" });
    expect(parsed).toEqual({ active: "sandbox", current: "sandbox" });
  });

  it("falls back to default when the active endpoint returns nothing useful", () => {
    const parsed = ActiveProfileResponse.parse({});
    expect(parsed).toEqual({ active: "default", current: "default" });
  });

  it("backfills current from active when only active is present", () => {
    const parsed = ActiveProfileResponse.parse({ active: "research" });
    expect(parsed).toEqual({ active: "research", current: "research" });
  });

  it("defaults the new ProfileSummary fields for an older runtime payload", () => {
    // 老 runtime 只发基础字段；新字段（gateway_running/description/distribution_*/has_alias）
    // 必须有兜底默认值，否则整张档案列表解析失败。
    const parsed = ProfileSummary.parse({
      name: "default",
      path: "/home/u/.hermes",
      is_default: true,
      model: null,
      provider: null,
      has_env: false,
      skill_count: 0,
    });
    expect(parsed.gateway_running).toBe(false);
    expect(parsed.description).toBe("");
    expect(parsed.description_auto).toBe(false);
    expect(parsed.distribution_name).toBeNull();
    expect(parsed.has_alias).toBe(false);
  });

  it("defaults hub_installs to [] when the create response omits it", () => {
    const parsed = ProfileCreateResponse.parse({ ok: true, name: "work", path: "/x" });
    expect(parsed.hub_installs).toEqual([]);
  });

  it("parses a create response with background hub installs (pid may be null)", () => {
    const parsed = ProfileCreateResponse.parse({
      ok: true,
      name: "work",
      path: "/x",
      model_set: true,
      mcp_written: 2,
      skills_disabled: 3,
      hub_installs: [
        { identifier: "owner/linear", pid: 4242 },
        { identifier: "owner/broken", pid: null },
      ],
    });
    expect(parsed.mcp_written).toBe(2);
    expect(parsed.hub_installs).toHaveLength(2);
    expect(parsed.hub_installs[1]?.pid).toBeNull();
  });

  it("parses a skills-hub search response and defaults its optional maps", () => {
    const parsed = SkillsHubSearchResponse.parse({
      results: [{ name: "Linear", source: "hermes-index", identifier: "owner/linear" }],
    });
    expect(parsed.results[0]?.identifier).toBe("owner/linear");
    expect(parsed.results[0]?.description).toBe("");
    expect(parsed.source_counts).toEqual({});
    expect(parsed.timed_out).toEqual([]);
  });

  it("keeps the full ProfileSummary fields from a current runtime payload", () => {
    const parsed = ProfileSummary.parse({
      name: "coder",
      path: "/home/u/.hermes/profiles/coder",
      is_default: false,
      model: "claude-opus-4-8",
      provider: "anthropic",
      has_env: true,
      skill_count: 12,
      gateway_running: true,
      description: "全栈开发档案",
      description_auto: true,
      distribution_name: "coder-pro",
      distribution_version: "1.0.0",
      distribution_source: "https://example.com/coder-pro",
      has_alias: true,
    });
    expect(parsed.gateway_running).toBe(true);
    expect(parsed.description_auto).toBe(true);
    expect(parsed.distribution_name).toBe("coder-pro");
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

describe("OAuth schemas", () => {
  it("accepts loopback providers and start responses", async () => {
    const { OAuthProvider, OAuthStartResponse } = await import("./hermes-api");
    const provider = OAuthProvider.parse({
      id: "xai-oauth",
      name: "xAI Grok OAuth",
      flow: "loopback",
      status: { logged_in: false, source: null },
    });
    expect(provider.flow).toBe("loopback");
    expect(provider.status.source).toBeNull();

    const start = OAuthStartResponse.parse({
      session_id: "sid",
      flow: "loopback",
      auth_url: "https://example.test/authorize",
      expires_in: 900,
    });
    expect(start.flow).toBe("loopback");
  });
});

describe("FsListResponse schema", () => {
  it("parses the upstream /api/fs/list shape (isDirectory, no path/parent/home)", () => {
    const parsed = FsListResponse.parse({
      entries: [
        { name: "src", path: "/proj/src", isDirectory: true },
        { name: "README.md", path: "/proj/README.md", isDirectory: false },
      ],
    });
    // Normalized to the canonical `is_dir` regardless of wire field name.
    expect(parsed.entries[0].is_dir).toBe(true);
    expect(parsed.entries[1].is_dir).toBe(false);
    expect(parsed.path).toBeUndefined();
    expect(parsed.parent).toBeUndefined();
    expect(parsed.home).toBeUndefined();
  });

  it("surfaces upstream's HTTP-200 soft error", () => {
    const parsed = FsListResponse.parse({ entries: [], error: "EACCES" });
    expect(parsed.error).toBe("EACCES");
    expect(parsed.entries).toEqual([]);
  });

  it("still parses the legacy fork shape (is_dir + path/parent/home)", () => {
    const parsed = FsListResponse.parse({
      path: "/proj",
      parent: "/",
      home: "/home/u",
      entries: [{ name: "src", path: "/proj/src", is_dir: true }],
    });
    expect(parsed.entries[0].is_dir).toBe(true);
    expect(parsed.parent).toBe("/");
  });
});

describe("SearchResponse schema", () => {
  it("tolerates null role/model/source/started from the session-id-match branch", () => {
    const parsed = SearchResponse.parse({
      results: [
        {
          session_id: "s1",
          snippet: "Session ID: s1",
          role: null,
          source: null,
          model: null,
          session_started: null,
        },
      ],
    });
    // Null wire values normalize to undefined (Zod v3 `.optional()` would throw on null).
    expect(parsed.results[0].role).toBeUndefined();
    expect(parsed.results[0].model).toBeUndefined();
    expect(parsed.results[0].source).toBeUndefined();
    expect(parsed.results[0].session_started).toBeUndefined();
    expect(parsed.results[0].session_id).toBe("s1");
  });

  it("still accepts populated fields", () => {
    const parsed = SearchResponse.parse({
      results: [{ session_id: "s2", snippet: "hi", role: "user", model: "gpt", session_started: 123 }],
    });
    expect(parsed.results[0].model).toBe("gpt");
    expect(parsed.results[0].session_started).toBe(123);
  });
});

describe("StatusResponse schema", () => {
  it("parses an auth-gated /api/status that omits gateway_pid/gateway_health_url", () => {
    const parsed = StatusResponse.parse({
      version: "0.5.4",
      release_date: "2026-06-28",
      gateway_running: false,
      gateway_exit_reason: null,
      gateway_updated_at: null,
      active_sessions: 0,
    });
    expect(parsed.gateway_pid).toBeUndefined();
    expect(parsed.gateway_health_url).toBeUndefined();
    expect(parsed.gateway_running).toBe(false);
  });

  it("parses a loopback /api/status that includes them", () => {
    const parsed = StatusResponse.parse({
      version: "0.5.4",
      release_date: "2026-06-28",
      gateway_running: true,
      gateway_pid: 4321,
      gateway_health_url: "http://127.0.0.1:9120/health",
      gateway_exit_reason: null,
      gateway_updated_at: null,
      active_sessions: 2,
    });
    expect(parsed.gateway_pid).toBe(4321);
    expect(parsed.gateway_health_url).toContain("9120");
  });
});

describe("ProviderModelsListResult schema", () => {
  it("parses a successful provider.models result", () => {
    const parsed = ProviderModelsListResult.parse({
      ok: true,
      models: ["qwen2.5-coder:7b", "llama3"],
      model_count: 2,
      status_code: 200,
      error: null,
      error_kind: null,
    });
    expect(parsed.ok).toBe(true);
    expect(parsed.models).toEqual(["qwen2.5-coder:7b", "llama3"]);
    expect(parsed.model_count).toBe(2);
  });

  it("defaults optional fields so a bare {ok} envelope still parses", () => {
    const parsed = ProviderModelsListResult.parse({ ok: false });
    expect(parsed.models).toEqual([]);
    expect(parsed.model_count).toBe(0);
    expect(parsed.status_code).toBeNull();
    expect(parsed.error).toBeNull();
    expect(parsed.error_kind).toBeNull();
  });

  it("carries an auth failure as data", () => {
    const parsed = ProviderModelsListResult.parse({
      ok: false,
      models: [],
      status_code: 401,
      error: "API key rejected (HTTP 401)",
      error_kind: "auth",
    });
    expect(parsed.ok).toBe(false);
    expect(parsed.error_kind).toBe("auth");
  });
});
