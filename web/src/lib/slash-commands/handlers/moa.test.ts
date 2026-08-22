import { describe, expect, it } from "vitest";
import type { LLM, LLMChatParams, MoaConfig, MoaSlot, TokenUsage } from "@hermes/agent-core";
import { handleCouncil, handleMoa, type MoaHandlerContext } from "./moa";

const FAKE_USAGE: TokenUsage = { input: 3, output: 2, total: 5 };

function makeFakeLlm(responseText: string): LLM {
  return {
    modelName: "fake",
    async chat(params: LLMChatParams) {
      params.onTextDelta?.(responseText);
      return { text: responseText, toolCalls: [], usage: FAKE_USAGE };
    },
  };
}

function makeConfig(): MoaConfig {
  return {
    defaultPreset: "default",
    presets: {
      default: {
        referenceModels: [
          { provider: "openai", model: "gpt-4o-mini" },
          { provider: "anthropic", model: "claude-3-haiku" },
        ],
        aggregator: { provider: "openai", model: "gpt-4o" },
        enabled: true,
      },
    },
  };
}

function makeContext(overrides?: Partial<MoaHandlerContext>): MoaHandlerContext {
  return {
    activeSessionId: "session-1",
    moaConfig: makeConfig(),
    createMoaLlm: (slot: MoaSlot) =>
      makeFakeLlm(slot.model.includes("aggregator") || slot.model === "gpt-4o" ? "Aggregated" : `${slot.provider} advice`),
    ...overrides,
  };
}

describe("handleMoa", () => {
  it("returns error when prompt is missing", async () => {
    const result = await handleMoa("  ", makeContext());
    expect(result.type).toBe("error");
    expect(result.message).toContain("requires a prompt");
  });

  it("returns error when there is no active session", async () => {
    const result = await handleMoa("hello", makeContext({ activeSessionId: null }));
    expect(result.type).toBe("error");
    expect(result.message).toContain("active session");
  });

  it("returns error when MoA config is missing", async () => {
    const result = await handleMoa("hello", makeContext({ moaConfig: undefined }));
    expect(result.type).toBe("error");
    expect(result.message).toContain("No MoA configuration");
  });

  it("returns error when LLM factory is unavailable", async () => {
    const result = await handleMoa("hello", makeContext({ createMoaLlm: undefined }));
    expect(result.type).toBe("error");
    expect(result.message).toContain("runtime is not available");
  });

  it("runs a one-shot MoA ensemble and returns exec output", async () => {
    const result = await handleMoa("explain quantum computing", makeContext());
    expect(result.type).toBe("exec");
    expect(result.output).toContain("Aggregated");
    expect(result.display).toContain("Mixture of Agents");
    expect(result.display).toContain("openai advice");
  });
});

describe("handleCouncil", () => {
  it("returns error when prompt is missing", async () => {
    const result = await handleCouncil("", makeContext());
    expect(result.type).toBe("error");
    expect(result.message).toContain("requires a prompt");
  });

  it("runs a council and returns a report", async () => {
    const result = await handleCouncil("which stack?", makeContext());
    expect(result.type).toBe("exec");
    expect(result.output).toContain("Aggregated");
    expect(result.display).toContain("Model Council");
  });
});
