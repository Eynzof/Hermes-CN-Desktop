import { describe, expect, it } from "vitest";
import type { LLM, LLMChatParams, Message, TokenUsage } from "../types.js";
import {
  DEFAULT_AGGREGATOR_SYSTEM_PROMPT,
  DEFAULT_COUNCIL_CHAIR_PROMPT,
  DEFAULT_REFERENCE_SYSTEM_PROMPT,
  MoAOrchestrator,
} from "./orchestrator.js";
import type { MoaConfig, MoaSlot } from "./types.js";

const FAKE_USAGE: TokenUsage = { input: 10, output: 5, total: 15 };

function makeFakeLlm(responseText: string): LLM {
  return {
    modelName: "fake-model",
    async chat(params: LLMChatParams): Promise<{
      text: string;
      toolCalls: [];
      usage: TokenUsage;
    }> {
      params.onTextDelta?.(responseText);
      return { text: responseText, toolCalls: [], usage: FAKE_USAGE };
    },
  };
}

function slot(provider: string, model: string): MoaSlot {
  return { provider, model };
}

function makeConfig(): MoaConfig {
  return {
    defaultPreset: "default",
    presets: {
      default: {
        referenceModels: [slot("openai", "gpt-4o-mini"), slot("anthropic", "claude-3-haiku")],
        aggregator: slot("openai", "gpt-4o"),
        enabled: true,
      },
    },
  };
}

describe("MoAOrchestrator", () => {
  it("runs references in parallel and aggregates their outputs", async () => {
    const config = makeConfig();
    const createLlm = (_s: MoaSlot) => makeFakeLlm(`${_s.provider} says ok`);
    const orchestrator = new MoAOrchestrator({
      config,
      createReferenceLlm: createLlm,
      createAggregatorLlm: createLlm,
    });

    const result = await orchestrator.run({ input: "hello" });

    expect(result.references).toHaveLength(2);
    expect(result.references.map((r) => r.text)).toContain("openai says ok");
    expect(result.references.map((r) => r.text)).toContain("anthropic says ok");
    expect(result.text).toContain("openai says ok");
    expect(result.aggregatorModel).toBe("openai/gpt-4o");
    expect(result.usage.input).toBe(30); // 2 refs + aggregator
    expect(result.usage.output).toBe(15);
  });

  it("supports sequential reference execution", async () => {
    const config = makeConfig();
    const order: string[] = [];
    const createLlm = (s: MoaSlot) =>
      ({
        modelName: "fake",
        async chat() {
          // Track only reference agents, not the aggregator.
          if (s.model !== config.presets.default?.aggregator?.model) {
            order.push(s.provider);
          }
          return { text: `${s.provider} done`, toolCalls: [], usage: FAKE_USAGE };
        },
      } satisfies LLM);

    const orchestrator = new MoAOrchestrator({
      config,
      createReferenceLlm: createLlm,
      createAggregatorLlm: createLlm,
    });

    await orchestrator.run({ input: "hello", mode: "sequential" });
    expect(order).toEqual(["openai", "anthropic"]);
  });

  it("emits reference and aggregating callbacks", async () => {
    const config = makeConfig();
    const createLlm = (s: MoaSlot) => makeFakeLlm(`${s.provider} advice`);
    const orchestrator = new MoAOrchestrator({
      config,
      createReferenceLlm: createLlm,
      createAggregatorLlm: createLlm,
    });

    const refs: MoaSlot[] = [];
    let aggregating = false;
    const result = await orchestrator.run({
      input: "hi",
      onReference: (ref) => refs.push({ provider: ref.provider, model: ref.model }),
      onAggregating: () => {
        aggregating = true;
      },
    });

    expect(refs).toHaveLength(2);
    expect(aggregating).toBe(true);
    expect(result.text).toContain("openai advice");
  });

  it("respects abort signal", async () => {
    const config = makeConfig();
    const createLlm = () =>
      ({
        modelName: "slow",
        async chat(params: LLMChatParams) {
          if (params.signal?.aborted) {
            throw new Error("already aborted");
          }
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("test timeout")), 100);
            params.signal?.addEventListener("abort", () => {
              clearTimeout(timer);
              reject(new Error("aborted"));
            }, { once: true });
          });
          return { text: "never", toolCalls: [], usage: FAKE_USAGE };
        },
      } satisfies LLM);

    const orchestrator = new MoAOrchestrator({
      config,
      createReferenceLlm: createLlm,
      createAggregatorLlm: createLlm,
    });

    const controller = new AbortController();
    const runPromise = orchestrator.run({ input: "hi", signal: controller.signal });
    controller.abort();

    await expect(runPromise).rejects.toThrow(/aborted|already aborted/i);
  });

  it("reports an error when the preset is missing", () => {
    const config: MoaConfig = {
      defaultPreset: "missing",
      presets: {},
    };
    expect(
      () =>
        new MoAOrchestrator({
          config,
          createReferenceLlm: () => makeFakeLlm("ref"),
          createAggregatorLlm: () => makeFakeLlm("agg"),
        }),
    ).toThrow(/missing/);
  });

  it("can override the active preset", async () => {
    const config: MoaConfig = {
      defaultPreset: "default",
      presets: {
        default: {
          referenceModels: [slot("openai", "gpt-4o-mini")],
          aggregator: slot("openai", "gpt-4o"),
          enabled: true,
        },
        other: {
          referenceModels: [slot("google", "gemini-flash")],
          aggregator: slot("google", "gemini-pro"),
          enabled: true,
        },
      },
    };
    const createLlm = (s: MoaSlot) => makeFakeLlm(s.provider);
    const orchestrator = new MoAOrchestrator({
      config,
      activePresetName: "other",
      createReferenceLlm: createLlm,
      createAggregatorLlm: createLlm,
    });

    const result = await orchestrator.run({ input: "hi" });
    expect(result.aggregatorModel).toBe("google/gemini-pro");
  });

  it("includes context messages in reference and aggregator calls", async () => {
    const config = makeConfig();
    let seenMessages: Message[] = [];
    const createLlm = (s: MoaSlot) =>
      ({
        modelName: s.model,
        async chat(params: LLMChatParams) {
          if (s.model === "gpt-4o-mini") {
            seenMessages = params.messages;
          }
          return { text: "ok", toolCalls: [], usage: FAKE_USAGE };
        },
      } satisfies LLM);

    const orchestrator = new MoAOrchestrator({
      config,
      createReferenceLlm: createLlm,
      createAggregatorLlm: createLlm,
    });

    await orchestrator.run({
      input: "now?",
      contextMessages: [
        { role: "user", content: "earlier" },
        { role: "assistant", content: "yes" },
      ],
    });

    expect(seenMessages.some((m) => m.role === "user" && m.content === "earlier")).toBe(true);
    expect(seenMessages.some((m) => m.role === "user" && m.content === "now?")).toBe(true);
  });
});

describe("MoA default prompts", () => {
  it("exposes non-empty default prompt constants", () => {
    expect(DEFAULT_REFERENCE_SYSTEM_PROMPT.length).toBeGreaterThan(0);
    expect(DEFAULT_AGGREGATOR_SYSTEM_PROMPT.length).toBeGreaterThan(0);
    expect(DEFAULT_COUNCIL_CHAIR_PROMPT.length).toBeGreaterThan(0);
    expect(DEFAULT_REFERENCE_SYSTEM_PROMPT).toContain("independent recommendation");
    expect(DEFAULT_AGGREGATOR_SYSTEM_PROMPT).toContain("aggregator");
    expect(DEFAULT_COUNCIL_CHAIR_PROMPT).toContain("council");
  });

  it("uses the default reference system prompt when no override is provided", async () => {
    const config: MoaConfig = {
      defaultPreset: "default",
      presets: {
        default: {
          referenceModels: [slot("openai", "gpt-4o-mini")],
          aggregator: slot("openai", "gpt-4o"),
          enabled: true,
        },
      },
    };
    const seen: Message[] = [];
    const orchestrator = new MoAOrchestrator({
      config,
      createReferenceLlm: () => ({
        modelName: "fake",
        async chat(params: LLMChatParams) {
          seen.push(...params.messages);
          return { text: "ref", toolCalls: [], usage: FAKE_USAGE };
        },
      }),
      createAggregatorLlm: () => ({
        modelName: "fake-agg",
        async chat() {
          return { text: "agg", toolCalls: [], usage: FAKE_USAGE };
        },
      }),
    });

    await orchestrator.run({ input: "hello" });
    expect(seen[0]?.role).toBe("system");
    expect(seen[0]?.content).toBe(DEFAULT_REFERENCE_SYSTEM_PROMPT);
  });

  it("honors custom prompt overrides including the default constants", async () => {
    const config: MoaConfig = {
      defaultPreset: "default",
      presets: {
        default: {
          referenceModels: [slot("openai", "gpt-4o-mini")],
          aggregator: slot("openai", "gpt-4o"),
          enabled: true,
        },
      },
    };
    const seen: Message[] = [];
    const orchestrator = new MoAOrchestrator({
      config,
      referenceSystemPrompt: DEFAULT_REFERENCE_SYSTEM_PROMPT,
      aggregatorSystemPrompt: DEFAULT_AGGREGATOR_SYSTEM_PROMPT,
      createReferenceLlm: () => ({
        modelName: "fake",
        async chat(params: LLMChatParams) {
          seen.push(...params.messages);
          return { text: "ref", toolCalls: [], usage: FAKE_USAGE };
        },
      }),
      createAggregatorLlm: () => ({
        modelName: "fake-agg",
        async chat() {
          return { text: "agg", toolCalls: [], usage: FAKE_USAGE };
        },
      }),
    });

    await orchestrator.run({ input: "hello" });
    expect(seen[0]?.content).toBe(DEFAULT_REFERENCE_SYSTEM_PROMPT);
  });

  it("accepts the council chair prompt as the aggregator override", async () => {
    const config: MoaConfig = {
      defaultPreset: "default",
      presets: {
        default: {
          referenceModels: [slot("openai", "gpt-4o-mini")],
          aggregator: slot("openai", "gpt-4o"),
          enabled: true,
        },
      },
    };
    const orchestrator = new MoAOrchestrator({
      config,
      aggregatorSystemPrompt: DEFAULT_COUNCIL_CHAIR_PROMPT,
      createReferenceLlm: () => makeFakeLlm("ref"),
      createAggregatorLlm: () => makeFakeLlm("agg"),
    });
    const result = await orchestrator.run({ input: "hello", style: "council" });
    expect(result.text).toContain("agg");
  });
});
