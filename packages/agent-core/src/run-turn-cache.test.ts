import { describe, expect, it, vi } from "vitest";
import { runTurn } from "./run-turn.js";
import type { LLM, LLMChatParams, LLMChatResponse, Message, Tool, TokenUsage } from "./types.js";

const EMPTY_USAGE: TokenUsage = { input: 0, output: 0, total: 0 };

class SpyLLM implements LLM {
  readonly modelName = "spy";
  receivedMessages: Message[] = [];
  receivedTools: Tool[] = [];
  async chat(params: LLMChatParams): Promise<LLMChatResponse> {
    this.receivedMessages = params.messages as Message[];
    this.receivedTools = params.tools as Tool[];
    return { text: "ok", toolCalls: [], usage: { input: 1, output: 1, total: 2 } };
  }
}

describe("runTurn compaction and cache control", () => {
  it("auto-compacts when token threshold is exceeded", async () => {
    const llm = new SpyLLM();
    const longMessages: Message[] = Array.from({ length: 60 }, (_, i) => ({
      id: `m${i}`,
      role: i % 2 === 0 ? "user" : "assistant",
      content:
        "This is a fairly long message body that should contribute many tokens when the threshold is set low enough to trigger compaction.",
      timestamp: Date.now(),
    }));

    const events: Array<{ type: string }> = [];
    const result = await runTurn({
      sessionId: "s1",
      prompt: "continue",
      llm,
      messages: longMessages,
      tools: [],
      compactionConfig: {
        enabled: true,
        contextLength: 1_000,
        threshold: 0.2,
        targetRatio: 0.2,
        protectFirstN: 3,
        protectLastN: 2,
        minTailUserMessages: 1,
        summaryBudget: 2_000,
        timeoutMs: 60_000,
        cooldownMs: 5_000,
      },
      emit: (event) => events.push(event as { type: string }),
    });

    expect(result.stopReason).toBe("stop");
    expect(llm.receivedMessages.length).toBeLessThan(longMessages.length + 2);
    expect(events.some((e) => e.type === "agent.status")).toBe(true);
    expect(events.some((e) => e.type === "session.compress")).toBe(true);
  });

  it("injects anthropic cache-control markers", async () => {
    const llm = new SpyLLM();
    await runTurn({
      sessionId: "s1",
      prompt: "hi",
      llm,
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "first reply" },
      ],
      tools: [],
      cacheControlOptions: { provider: "anthropic" },
    });

    const marked = llm.receivedMessages.filter((m) => "cache_control" in m);
    expect(marked.length).toBeGreaterThan(0);
  });

  it("does not inject markers for generic provider", async () => {
    const llm = new SpyLLM();
    await runTurn({
      sessionId: "s1",
      prompt: "hi",
      llm,
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "first reply" },
      ],
      tools: [],
      cacheControlOptions: { provider: "generic" },
    });

    const marked = llm.receivedMessages.filter((m) => "cache_control" in m);
    expect(marked.length).toBe(0);
  });

  it("does not mutate stored messages with cache markers", async () => {
    const llm = new SpyLLM();
    const messages: Message[] = [
      { role: "user", content: "first" },
      { role: "assistant", content: "first reply" },
    ];
    await runTurn({
      sessionId: "s1",
      prompt: "hi",
      llm,
      messages,
      tools: [],
      cacheControlOptions: { provider: "anthropic" },
    });

    expect(messages.every((m) => !("cache_control" in m))).toBe(true);
  });
});
