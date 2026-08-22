import { describe, expect, it } from "vitest";
import type { LLM, LLMChatParams, TokenUsage } from "../types.js";
import { CouncilOrchestrator } from "./council.js";
import type { MoaConfig, MoaSlot } from "./types.js";

const FAKE_USAGE: TokenUsage = { input: 5, output: 3, total: 8 };

function makeFakeLlm(responseText: string): LLM {
  return {
    modelName: "fake",
    async chat(params: LLMChatParams) {
      params.onTextDelta?.(responseText);
      return { text: responseText, toolCalls: [], usage: FAKE_USAGE };
    },
  };
}

function slot(provider: string, model: string): MoaSlot {
  return { provider, model };
}

describe("CouncilOrchestrator", () => {
  it("produces a council report and parses explicit votes", async () => {
    const config: MoaConfig = {
      defaultPreset: "council",
      presets: {
        council: {
          referenceModels: [slot("a", "a-1"), slot("b", "b-1")],
          aggregator: slot("chair", "chair-1"),
          enabled: true,
          synthesisStyle: "council",
        },
      },
    };
    const createLlm = (s: MoaSlot) =>
      makeFakeLlm(s.provider === "chair" ? "Consensus: go. [Vote: yes]" : `${s.provider} advice`);

    const orchestrator = new CouncilOrchestrator({
      config,
      createReferenceLlm: createLlm,
      createAggregatorLlm: createLlm,
    });

    const result = await orchestrator.run({ input: "Should we ship?" });

    expect(result.references).toHaveLength(2);
    expect(result.text).toContain("Consensus");
    expect(result.votes.some((v) => v.option === "yes")).toBe(true);
    expect(result.consensus?.toLowerCase()).toContain("go");
    expect(result.usage.input).toBe(15); // 2 refs (5 each) + aggregator (5)
  });

  it("falls back to consensus vote when no markers exist", async () => {
    const config: MoaConfig = {
      defaultPreset: "council",
      presets: {
        council: {
          referenceModels: [slot("a", "a-1")],
          aggregator: slot("chair", "chair-1"),
          enabled: true,
        },
      },
    };
    const createLlm = () => makeFakeLlm("We all agree");

    const orchestrator = new CouncilOrchestrator({
      config,
      createReferenceLlm: createLlm,
      createAggregatorLlm: createLlm,
    });

    const result = await orchestrator.run({ input: "ok?" });
    expect(result.votes.length).toBeGreaterThan(0);
    expect(result.votes[0]?.voter).toBe("consensus");
  });
});
