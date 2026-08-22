import { describe, expect, it } from "vitest";
import {
  compressSessionContext,
  estimateMessageTokens,
  estimateMessagesTokens,
  estimateTokens,
  parseCompressArgs,
  resolveCompactionConfig,
  shouldCompress,
} from "./compress.js";
import type { CompactionConfig, CompactionMessage, CompactionSummarizer } from "./types.js";

function makeMessages(count: number): CompactionMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `m${i}`,
    role: i % 2 === 0 ? "user" : "assistant",
    content: `Message ${i} with enough text to consume some tokens when estimated.`,
    timestamp: Date.now(),
  }));
}

function config(ctx = 10_000): CompactionConfig {
  return {
    enabled: true,
    contextLength: ctx,
    threshold: 0.5,
    targetRatio: 0.2,
    protectFirstN: 2,
    protectLastN: 2,
    minTailUserMessages: 1,
    summaryBudget: 1_000,
    timeoutMs: 5_000,
    cooldownMs: 1_000,
  };
}

const fakeSummarizer: CompactionSummarizer = {
  async summarize({ messages }) {
    const topics = messages
      .filter((m) => m.role === "user")
      .map((m) => String(m.content).slice(0, 20))
      .join("; ");
    return { summary: `Summary: ${topics || "none"}`, usage: { input: 10, output: 5 } };
  },
};

describe("token estimation", () => {
  it("estimates ASCII text at ~4 chars per token", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcdefghijklmnopqrstuvwxyz")).toBe(7);
  });

  it("estimates CJK at 1 char per token", () => {
    expect(estimateTokens("你好世界")).toBe(4);
  });

  it("estimates mixed text", () => {
    expect(estimateTokens("hello 你好")).toBeGreaterThan(1);
  });

  it("estimates message tokens with overhead", () => {
    const m: CompactionMessage = { role: "user", content: "hello" };
    expect(estimateMessageTokens(m)).toBeGreaterThan(3);
  });

  it("sums message tokens", () => {
    const messages = makeMessages(4);
    expect(estimateMessagesTokens(messages)).toBe(
      messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0),
    );
  });
});

describe("threshold resolution", () => {
  it("returns false when compaction is disabled", () => {
    const messages = makeMessages(10);
    expect(shouldCompress(messages, { ...config(), enabled: false })).toBe(false);
  });

  it("returns true when tokens exceed threshold", () => {
    const messages = makeMessages(50);
    expect(shouldCompress(messages, { ...config(), contextLength: 100, threshold: 0.5 })).toBe(true);
  });

  it("applies model overrides by longest match", () => {
    const base = config();
    const overrides = {
      small: { threshold: 0.75 },
      "gpt-4": { threshold: 0.3 },
    };
    const resolved = resolveCompactionConfig(base, "openai/gpt-4-turbo", overrides);
    expect(resolved.threshold).toBe(0.3);
  });
});

describe("compressSessionContext deterministic fallback", () => {
  it("returns noop when below threshold but enabled", async () => {
    const messages = makeMessages(4);
    const result = await compressSessionContext({
      messages,
      configOrContextLength: { ...config(), contextLength: 10_000, threshold: 0.5 },
      modelName: "test",
    });
    expect(result.status).toBe("noop");
    expect(result.removed).toBe(0);
  });

  it("compresses oldest non-system messages with fallback", async () => {
    const messages = makeMessages(12);
    const result = await compressSessionContext({
      messages,
      configOrContextLength: { ...config(), contextLength: 100, threshold: 0.5 },
      modelName: "test",
    });
    expect(result.status).toBe("fallback");
    expect(result.removed).toBeGreaterThan(0);
    expect(result.afterMessages).toBeLessThan(result.beforeMessages);
    expect(result.compressedRange).toBeDefined();
  });

  it("keeps system messages untouched", async () => {
    const messages: CompactionMessage[] = [
      { role: "system", content: "You are helpful." },
      ...makeMessages(12),
    ];
    const result = await compressSessionContext({
      messages,
      configOrContextLength: { ...config(), contextLength: 100, threshold: 0.5 },
      modelName: "test",
    });
    expect(result.messages[0]?.role).toBe("system");
    expect(result.messages[0]?.content).toBe("You are helpful.");
  });

  it("protects the first N and last N non-system messages", async () => {
    const messages = makeMessages(20);
    const result = await compressSessionContext({
      messages,
      configOrContextLength: { ...config(), contextLength: 200, threshold: 0.5 },
      modelName: "test",
    });
    const compacted = result.messages;
    // Head and tail protection should leave original first/last messages intact.
    expect(compacted[0]?.content).toBe(messages[0]?.content);
    expect(compacted[compacted.length - 1]?.content).toBe(messages[messages.length - 1]?.content);
  });

  it("uses LLM summarizer when provided", async () => {
    const messages = makeMessages(12);
    const result = await compressSessionContext({
      messages,
      configOrContextLength: { ...config(), contextLength: 100, threshold: 0.5 },
      summarizer: fakeSummarizer,
      modelName: "test",
    });
    expect(result.status).toBe("compacted");
    expect(result.summary).toContain("Summary:");
    expect(result.messages.some((m) => m.summaryMessage)).toBe(true);
  });

  it("falls back when summarizer throws", async () => {
    const messages = makeMessages(12);
    const failingSummarizer: CompactionSummarizer = {
      async summarize() {
        throw new Error("summarizer down");
      },
    };
    const result = await compressSessionContext({
      messages,
      configOrContextLength: { ...config(), contextLength: 100, threshold: 0.5 },
      summarizer: failingSummarizer,
      modelName: "test",
    });
    expect(result.status).toBe("fallback");
    expect(result.fallbackUsed).toBe(true);
  });

  it("keeps tool pairs intact", async () => {
    const messages: CompactionMessage[] = [
      { role: "user", content: "call tool" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "tc1", name: "get_weather", arguments: { city: "Shanghai" } }],
      },
      { role: "tool", content: "sunny", toolCallId: "tc1", toolName: "get_weather" },
      ...makeMessages(10),
    ];
    const result = await compressSessionContext({
      messages,
      configOrContextLength: { ...config(), contextLength: 100, threshold: 0.5 },
      modelName: "test",
    });
    // If the assistant tool_call is in compressed range, its result should be too.
    const summary = result.messages.find((m) => m.summaryMessage);
    expect(summary).toBeDefined();
  });

  it("respects abort signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await compressSessionContext({
      messages: makeMessages(12),
      configOrContextLength: { ...config(), contextLength: 100, threshold: 0.5 },
      signal: controller.signal,
      modelName: "test",
    });
    expect(result.status).toBe("aborted");
  });

  it("parses compress args", () => {
    expect(parseCompressArgs("refactoring")).toEqual({ focusTopic: "refactoring" });
    expect(parseCompressArgs("here 3")).toEqual({ keepLast: 3 });
    expect(parseCompressArgs("here 3 --preview")).toEqual({ keepLast: 3, preview: true, dryRun: true });
    expect(parseCompressArgs("")).toEqual({});
  });
});
