/**
 * Council variant of Mixture-of-Agents.
 *
 * `/council` runs the reference models as independent voters and asks the
 * aggregator to act as a chair: summarize positions, expose disagreements,
 * and report the effective consensus.
 */

import type { LLM, TokenUsage } from "../types.js";
import { MoAOrchestrator, DEFAULT_COUNCIL_CHAIR_PROMPT } from "./orchestrator.js";
import type {
  MoaConfig,
  MoaReferenceResult,
  MoaRunOptions,
  MoaSlot,
  MoaVote,
} from "./types.js";

export interface CouncilRunResult {
  text: string;
  references: MoaReferenceResult[];
  aggregatorModel: string;
  usage: TokenUsage;
  votes: MoaVote[];
  consensus?: string;
}

export interface CouncilOrchestratorOptions {
  config: MoaConfig;
  activePresetName?: string;
  createReferenceLlm(slot: MoaSlot): LLM | undefined;
  createAggregatorLlm(slot: MoaSlot): LLM | undefined;
  chairPrompt?: string;
}

const VOTE_REGEX = /\[Vote:\s*([^\]]+)\]/gi;

function parseVotes(text: string, references: MoaReferenceResult[]): MoaVote[] {
  const votes: MoaVote[] = [];
  let match: RegExpExecArray | null;

  // Look for explicit [Vote: ...] markers anywhere in the report.
  VOTE_REGEX.lastIndex = 0;
  while ((match = VOTE_REGEX.exec(text)) !== null) {
    const option = match[1]?.trim();
    if (option) {
      votes.push({ voter: "chair", option });
    }
  }

  // If no explicit votes were found, derive a single consensus vote from the
  // aggregator output and tag each reference as agreeing unless it signalled a
  // dissent in its text.
  if (votes.length === 0 && references.length > 0) {
    const summary = text.split("\n")[0] ?? text;
    votes.push({ voter: "consensus", option: summary.slice(0, 200) });
    for (const ref of references) {
      const dissent = /\b(dissent|disagree|oppose|against)\b/i.test(ref.text);
      votes.push({
        voter: ref.name,
        option: dissent ? "dissent" : "agree",
        reasoning: dissent ? undefined : "Supports consensus",
      });
    }
  }

  return votes;
}

function extractConsensus(text: string): string | undefined {
  const match = text.match(/\bconsensus\b[^.\n]*(?:\.\n?)?/i);
  return match ? match[0].trim() : undefined;
}

export class CouncilOrchestrator {
  private readonly orchestrator: MoAOrchestrator;

  constructor(options: CouncilOrchestratorOptions) {
    this.orchestrator = new MoAOrchestrator({
      config: options.config,
      activePresetName: options.activePresetName,
      createReferenceLlm: options.createReferenceLlm,
      createAggregatorLlm: options.createAggregatorLlm,
      aggregatorSystemPrompt: options.chairPrompt ?? DEFAULT_COUNCIL_CHAIR_PROMPT,
    });
  }

  async run(options: Omit<MoaRunOptions, "style">): Promise<CouncilRunResult> {
    const result = await this.orchestrator.run({ ...options, style: "council" });
    const votes = parseVotes(result.text, result.references);
    return {
      text: result.text,
      references: result.references,
      aggregatorModel: result.aggregatorModel,
      usage: result.usage,
      votes,
      consensus: extractConsensus(result.text),
    };
  }
}
