import { describe, expect, it } from "vitest";
import { MemorySqlAdapter } from "@/lib/session-store/sql";
import { SessionStore } from "@/lib/session-store/session-store";
import { handleContext, handleInsights, handleStatus, handleUsage } from "./usage";
import type { SessionUsageResult, AnalyticsResponse } from "@hermes/protocol";

function makeCtx(overrides: { activeSessionId?: string | null } = {}) {
  const adapter = new MemorySqlAdapter();
  const store = new SessionStore({ adapter });
  return {
    store,
    activeSessionId: overrides.activeSessionId ?? null,
  };
}

async function createSession(store: SessionStore, title?: string) {
  return store.create({ source: "test", title });
}

describe("handleContext", () => {
  it("requires an active session", async () => {
    const result = await handleContext("", makeCtx());
    expect(result.type).toBe("error");
    expect(result.message).toContain("active session");
  });

  it("returns a context breakdown", async () => {
    const ctx = makeCtx();
    const session = await createSession(ctx.store, "Test");
    await ctx.store.appendMessages(session.id, [
      { role: "user", content: "Hello world this is a test message" },
      { role: "assistant", content: "Hello!" },
    ]);

    const result = await handleContext("all", { ...ctx, activeSessionId: session.id });
    expect(result.type).toBe("exec");
    expect(result.output).toContain("Context Usage");
    expect(result.output).toContain("Conversation");
  });
});

describe("handleStatus", () => {
  it("requires an active session", async () => {
    const result = await handleStatus("", makeCtx());
    expect(result.type).toBe("error");
  });

  it("returns session metadata", async () => {
    const ctx = makeCtx();
    const session = await createSession(ctx.store, "Status Test");
    await ctx.store.appendMessages(session.id, [
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello" },
    ]);

    const result = await handleStatus("", { ...ctx, activeSessionId: session.id });
    expect(result.type).toBe("exec");
    expect(result.output).toContain(session.id);
    expect(result.output).toContain("Status Test");
    expect(result.output).toContain("Messages: 2");
  });
});

describe("handleUsage", () => {
  it("uses getSessionUsage when available", async () => {
    const ctx = makeCtx();
    const session = await createSession(ctx.store);
    const usage: SessionUsageResult = {
      model: "claude-sonnet",
      input: 1000,
      output: 500,
      total: 1500,
      calls: 3,
      context_used: 2000,
      context_max: 4000,
      context_percent: 50,
      cost_usd: 0.01,
      cost_status: "ok",
    };

    const result = await handleUsage("", {
      ...ctx,
      activeSessionId: session.id,
      getSessionUsage: async () => usage,
    });
    expect(result.type).toBe("exec");
    expect(result.output).toContain("claude-sonnet");
    expect(result.output).toContain("1.5k");
    expect(result.output).toContain("50.0%");
  });

  it("falls back to turn stats", async () => {
    const ctx = makeCtx();
    const session = await createSession(ctx.store);

    const result = await handleUsage("", {
      ...ctx,
      activeSessionId: session.id,
      getTurnStats: async () => [
        {
          id: "t1",
          sessionId: session.id,
          tokensInput: 100,
          tokensOutput: 50,
          tokensTotal: 150,
          contextUsed: 200,
          contextMax: 1000,
          apiCalls: 1,
          costUsd: 0.001,
          model: "gpt-4o",
        },
      ],
    });
    expect(result.type).toBe("exec");
    expect(result.output).toContain("gpt-4o");
    expect(result.output).toContain("150");
  });

  it("returns a message when no usage source is available", async () => {
    const ctx = makeCtx();
    const session = await createSession(ctx.store);
    const result = await handleUsage("", { ...ctx, activeSessionId: session.id });
    expect(result.type).toBe("exec");
    expect(result.output).toContain("not available");
  });
});

describe("handleInsights", () => {
  it("uses getAnalytics when available", async () => {
    const ctx = makeCtx();
    const analytics: AnalyticsResponse = {
      daily: [],
      by_model: [
        { model: "gpt-4o", provider: "openai", input_tokens: 1000, output_tokens: 500, cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0, sessions: 1, api_calls: 2 },
      ],
      top_sessions: [],
      totals: {
        total_tokens: 1500,
        total_input: 1000,
        total_output: 500,
        total_cache_read: 0,
        total_cache_write: 0,
        total_reasoning: 0,
        total_sessions: 1,
        total_api_calls: 2,
        avg_tokens_per_session: 1500,
      },
      comparison: { previous_totals: { total_tokens: 0, total_input: 0, total_output: 0, total_cache_read: 0, total_cache_write: 0, total_reasoning: 0, total_sessions: 0, total_api_calls: 0, avg_tokens_per_session: 0 } },
      period_days: 7,
      skills: { summary: { total_skill_loads: 0, total_skill_edits: 0, total_skill_actions: 0, distinct_skills_used: 0 }, top_skills: [] },
    };

    const result = await handleInsights("7", { ...ctx, getAnalytics: async () => analytics });
    expect(result.type).toBe("exec");
    expect(result.output).toContain("Usage Insights");
    expect(result.output).toContain("gpt-4o");
  });

  it("falls back to local turn stats", async () => {
    const ctx = makeCtx();
    const session = await createSession(ctx.store);
    const result = await handleInsights("", {
      ...ctx,
      activeSessionId: session.id,
      getTurnStats: async () => [
        {
          id: "t1",
          sessionId: session.id,
          tokensInput: 100,
          tokensOutput: 50,
          tokensTotal: 150,
          model: "gpt-4o",
        },
      ],
    });
    expect(result.type).toBe("exec");
    expect(result.output).toContain("本地回合统计");
  });
});
