import { describe, expect, it } from "vitest";
import {
  applyCacheControl,
  buildCacheKey,
  buildPromptCachePlan,
  createStablePrefixRegistry,
  DEFAULT_CACHE_TTL,
  MAX_BREAKPOINTS,
  planAndApplyCacheControl,
  stripCacheControl,
} from "./prompt-cache.js";
import type { CacheControlPlan, CompactionMessage } from "./types.js";

function makeMessages(count: number): CompactionMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `m${i}`,
    role: i % 2 === 0 ? "user" : "assistant",
    content: `Message ${i}`,
    timestamp: Date.now(),
  }));
}

describe("buildPromptCachePlan", () => {
  it("returns empty plan for generic provider", () => {
    const messages = makeMessages(6);
    const plan = buildPromptCachePlan(messages, { provider: "generic" });
    expect(plan.messageBreakpoints).toEqual([]);
    expect(plan.toolBreakpoints).toEqual([]);
    expect(plan.breakpointCount).toBe(0);
  });

  it("returns empty plan for openai provider", () => {
    const messages = makeMessages(6);
    const plan = buildPromptCachePlan(messages, { provider: "openai" });
    expect(plan.breakpointCount).toBe(0);
  });

  it("marks system and last 2 messages for anthropic", () => {
    const messages: CompactionMessage[] = [
      { role: "system", content: "You are helpful." },
      ...makeMessages(4),
    ];
    const plan = buildPromptCachePlan(messages, { provider: "anthropic" });
    expect(plan.messageBreakpoints).toContain(0);
    expect(plan.messageBreakpoints).toContain(messages.length - 1);
    expect(plan.messageBreakpoints).toContain(messages.length - 2);
    expect(plan.breakpointCount).toBeLessThanOrEqual(MAX_BREAKPOINTS);
  });

  it("adds static prefix marker when provided", () => {
    const messages: CompactionMessage[] = [
      { role: "system", content: "STATIC_PREFIX\nYou are helpful." },
      ...makeMessages(4),
    ];
    const plan = buildPromptCachePlan(messages, {
      provider: "anthropic",
      staticSystemPrefix: "STATIC_PREFIX",
    });
    expect(plan.messageBreakpoints).toContain(0);
    expect(plan.breakpointCount).toBeLessThanOrEqual(MAX_BREAKPOINTS);
  });

  it("uses default 1h TTL", () => {
    const plan = buildPromptCachePlan(makeMessages(2), { provider: "anthropic" });
    expect(plan.ttlMs).toBe(60 * 60 * 1000);
  });

  it("respects 5m TTL option", () => {
    const plan = buildPromptCachePlan(makeMessages(2), { provider: "anthropic", cacheTtl: "5m" });
    expect(plan.ttlMs).toBe(5 * 60 * 1000);
  });

  it("never exceeds MAX_BREAKPOINTS", () => {
    const messages: CompactionMessage[] = [
      { role: "system", content: "prefix" },
      { role: "system", content: "prompt" },
      ...makeMessages(10),
    ];
    const plan = buildPromptCachePlan(messages, {
      provider: "anthropic",
      staticSystemPrefix: "prefix",
    });
    expect(plan.breakpointCount).toBeLessThanOrEqual(MAX_BREAKPOINTS);
  });
});

describe("planAndApplyCacheControl", () => {
  it("decorates anthropic messages with cache_control", () => {
    const messages = makeMessages(4);
    const tools = [
      { name: "get_weather", description: "Weather", parameters: { type: "object", properties: {} }, execute: async () => ({ content: "" }) },
    ];
    const { messages: decorated, tools: decoratedTools, plan } = planAndApplyCacheControl(
      messages,
      tools,
      { provider: "anthropic" },
    );
    expect(plan.breakpointCount).toBeGreaterThan(0);
    const marked = decorated.filter((m) => (m as CompactionMessage).cache_control);
    expect(marked.length).toBe(plan.messageBreakpoints.length);
    expect(decoratedTools.length).toBe(tools.length);
  });

  it("leaves generic provider messages untouched", () => {
    const messages = makeMessages(4);
    const { messages: decorated, plan } = planAndApplyCacheControl(messages, [], { provider: "generic" });
    expect(plan.breakpointCount).toBe(0);
    expect(decorated.every((m) => !(m as CompactionMessage).cache_control)).toBe(true);
  });

  it("does not mutate original messages", () => {
    const messages = makeMessages(4);
    const original = messages.map((m) => ({ ...m }));
    planAndApplyCacheControl(messages, [], { provider: "anthropic" });
    expect(messages).toEqual(original);
  });
});

describe("stripCacheControl", () => {
  it("removes cache_control from messages and tools", () => {
    const messages: CompactionMessage[] = makeMessages(2).map((m, i) =>
      i === 0 ? { ...m, cache_control: { type: "ephemeral" } } : m,
    );
    const tools = [
      {
        name: "t1",
        description: "d",
        parameters: { type: "object", properties: {} },
        cache_control: { type: "ephemeral" },
      },
    ] as unknown as Parameters<typeof stripCacheControl>[1];
    const { messages: cleanedMessages, tools: cleanedTools } = stripCacheControl(messages, tools);
    expect((cleanedMessages[0] as CompactionMessage).cache_control).toBeUndefined();
    expect((cleanedTools?.[0] as unknown as { cache_control?: unknown }).cache_control).toBeUndefined();
  });
});

describe("buildCacheKey", () => {
  it("is stable for identical inputs", () => {
    const messages = makeMessages(3);
    expect(buildCacheKey(messages)).toBe(buildCacheKey(messages));
  });

  it("changes when content changes", () => {
    const a = makeMessages(3);
    const b = makeMessages(3);
    b[0] = { ...b[0], content: "changed" };
    expect(buildCacheKey(a)).not.toBe(buildCacheKey(b));
  });
});

describe("createStablePrefixRegistry", () => {
  it("finds a registered prefix", () => {
    const registry = createStablePrefixRegistry();
    registry.register("You are Hermes");
    const messages: CompactionMessage[] = [{ role: "system", content: "You are Hermes, helpful." }];
    expect(registry.find(messages)).toBeDefined();
  });

  it("returns undefined when first message is not system", () => {
    const registry = createStablePrefixRegistry();
    registry.register("You are Hermes");
    const messages: CompactionMessage[] = [{ role: "user", content: "You are Hermes, helpful." }];
    expect(registry.find(messages)).toBeUndefined();
  });

  it("evicts oldest entries when max entries exceeded", () => {
    const registry = createStablePrefixRegistry(2);
    registry.register("A");
    registry.register("B");
    registry.register("C");
    expect(registry.find([{ role: "system", content: "A" }] as CompactionMessage[])).toBeUndefined();
    expect(registry.find([{ role: "system", content: "B" }] as CompactionMessage[])).toBeDefined();
  });

  it("clears all entries", () => {
    const registry = createStablePrefixRegistry();
    registry.register("X");
    registry.clear();
    expect(registry.find([{ role: "system", content: "X" }] as CompactionMessage[])).toBeUndefined();
  });
});

describe("applyCacheControl", () => {
  const plan: CacheControlPlan = {
    messageBreakpoints: [0, 3],
    toolBreakpoints: [1],
    breakpointCount: 3,
    ttlMs: 60 * 60 * 1000,
  };

  function makeTools() {
    return [
      {
        name: "t1",
        description: "Tool 1",
        parameters: { type: "object", properties: {} },
        execute: async () => ({ content: "" }),
      },
      {
        name: "t2",
        description: "Tool 2",
        parameters: { type: "object", properties: {} },
        execute: async () => ({ content: "" }),
      },
    ];
  }

  it("returns copies without markers for generic providers even with a plan", () => {
    const messages = makeMessages(4);
    const tools = makeTools();
    const { messages: out, tools: outTools } = applyCacheControl(messages, tools, plan, {
      provider: "generic",
    });
    expect(out).toEqual(messages);
    expect(outTools).toEqual(tools);
    expect(out).not.toBe(messages);
    expect(outTools).not.toBe(tools);
    expect((out[0] as CompactionMessage).cache_control).toBeUndefined();
  });

  it("applies message breakpoints for anthropic providers", () => {
    const messages = makeMessages(4);
    const { messages: out } = applyCacheControl(messages, [], plan, { provider: "anthropic" });
    expect((out[0] as CompactionMessage).cache_control).toBeDefined();
    expect((out[3] as CompactionMessage).cache_control).toBeDefined();
    expect((out[1] as CompactionMessage).cache_control).toBeUndefined();
    expect((out[2] as CompactionMessage).cache_control).toBeUndefined();
  });

  it("applies tool breakpoints and leaves other tools untouched", () => {
    const tools = makeTools();
    const { tools: out } = applyCacheControl([], tools, plan, { provider: "anthropic" });
    expect((out[1] as unknown as { cache_control?: unknown }).cache_control).toBeDefined();
    expect((out[0] as unknown as { cache_control?: unknown }).cache_control).toBeUndefined();
  });

  it("does not mutate the original messages", () => {
    const messages = makeMessages(4);
    const original = messages.map((m) => ({ ...m }));
    applyCacheControl(messages, [], plan, { provider: "anthropic" });
    expect(messages).toEqual(original);
  });

  it("returns copies for anthropic when the plan is empty", () => {
    const emptyPlan: CacheControlPlan = {
      messageBreakpoints: [],
      toolBreakpoints: [],
      breakpointCount: 0,
      ttlMs: 1000,
    };
    const { messages: out, tools: outTools } = applyCacheControl(makeMessages(2), makeTools(), emptyPlan, {
      provider: "anthropic",
    });
    expect(out).toHaveLength(2);
    expect(outTools).toHaveLength(2);
    expect((out[0] as CompactionMessage).cache_control).toBeUndefined();
  });
});
