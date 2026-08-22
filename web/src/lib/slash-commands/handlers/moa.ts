/**
 * Local slash-command handlers for `/moa` and `/council`.
 *
 * These build on the `@hermes/agent-core` MoA orchestrator and run a one-shot
 * ensemble in-process. Hosts must supply a factory that creates an `LLM`
 * adapter for each MoA slot.
 */

import {
  CouncilOrchestrator,
  MoAOrchestrator,
  type MoaConfig,
  type MoaReferenceResult,
  type MoaSlot,
  type TokenUsage,
} from "@hermes/agent-core";
import type { LLM } from "@hermes/agent-core";
import type { CommandResult } from "../types";

export interface MoaHandlerContext {
  activeSessionId: string | null;
  /** Optional MoA configuration. If omitted, the handler reports an error. */
  moaConfig?: MoaConfig;
  /** Factory that turns a MoA slot into a runnable LLM adapter. */
  createMoaLlm?: (slot: MoaSlot) => LLM | undefined;
}

function formatUsage(usage: TokenUsage): string {
  return `tokens: ${usage.input ?? 0} in / ${usage.output ?? 0} out`;
}

function formatReferences(references: MoaReferenceResult[]): string {
  return references
    .map((ref) => `**${ref.name}**: ${ref.text.slice(0, 200)}${ref.text.length > 200 ? "…" : ""}`)
    .join("\n\n");
}

async function runMoa(
  prompt: string,
  ctx: MoaHandlerContext,
  style: "guidance" | "council",
): Promise<CommandResult> {
  if (!ctx.activeSessionId) {
    return { type: "error", message: "/moa requires an active session" };
  }
  if (!ctx.moaConfig) {
    return { type: "error", message: "No MoA configuration available" };
  }
  if (!ctx.createMoaLlm) {
    return { type: "error", message: "MoA runtime is not available in this surface" };
  }

  try {
    if (style === "council") {
      const orchestrator = new CouncilOrchestrator({
        config: ctx.moaConfig,
        createReferenceLlm: ctx.createMoaLlm,
        createAggregatorLlm: ctx.createMoaLlm,
      });
      const result = await orchestrator.run({ input: prompt });
      return {
        type: "exec",
        output: result.text,
        display: `# Model Council\n\n${formatReferences(result.references)}\n\n## Chair Report\n\n${result.text}\n\n*${formatUsage(result.usage)}*`,
      };
    }

    const orchestrator = new MoAOrchestrator({
      config: ctx.moaConfig,
      createReferenceLlm: ctx.createMoaLlm,
      createAggregatorLlm: ctx.createMoaLlm,
    });
    const result = await orchestrator.run({ input: prompt, style: "guidance" });
    return {
      type: "exec",
      output: result.text,
      display: `# Mixture of Agents\n\n${formatReferences(result.references)}\n\n## Aggregator (${result.aggregatorModel})\n\n${result.text}\n\n*${formatUsage(result.usage)}*`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { type: "error", message: `MoA failed: ${message}` };
  }
}

/** `/moa <prompt>` — run a one-shot mixture-of-agents ensemble. */
export async function handleMoa(args: string, ctx: MoaHandlerContext): Promise<CommandResult> {
  const prompt = args.trim();
  if (!prompt) {
    return { type: "error", message: "/moa requires a prompt, e.g. /moa explain quantum computing" };
  }
  return runMoa(prompt, ctx, "guidance");
}

/** `/council <prompt>` — run a one-shot model council and report consensus/disagreement. */
export async function handleCouncil(args: string, ctx: MoaHandlerContext): Promise<CommandResult> {
  const prompt = args.trim();
  if (!prompt) {
    return { type: "error", message: "/council requires a prompt, e.g. /council which stack should we use?" };
  }
  return runMoa(prompt, ctx, "council");
}
