/**
 * Mixture-of-Agents orchestrator.
 *
 * Runs N reference agents (in parallel with a concurrency cap or sequentially),
 * then calls an aggregator LLM to synthesize their outputs. The design stays
 * close to the Python `MoAChatCompletions` facade but uses the agent-core
 * `LLM` interface so it works with any registered provider adapter.
 */

import type { LLM, LLMChatResponse, Message, TokenUsage } from "../types.js";
import { AgentError } from "../errors.js";
import type {
  MoaAgentRef,
  MoaConfig,
  MoaPreset,
  MoaReferenceResult,
  MoaRunOptions,
  MoaRunResult,
  MoaSlot,
} from "./types.js";

export const DEFAULT_REFERENCE_SYSTEM_PROMPT =
  "You are a helpful advisor. Analyze the user's request carefully and provide " +
  "a concise, independent recommendation. Do not mention that you are part of an ensemble.";

export const DEFAULT_AGGREGATOR_SYSTEM_PROMPT =
  "You are the aggregator for a mixture-of-agents ensemble. Synthesize the reference " +
  "analyses below into a single, coherent answer for the user.";

export const DEFAULT_COUNCIL_CHAIR_PROMPT =
  "You are the chair of a model council. Each reference model has provided an independent " +
  "analysis. Produce a user-facing report that summarizes the consensus, highlights any " +
  "disagreements, and explains how the final answer was reached. Use a clear, structured format.";

export interface MoAOrchestratorOptions {
  config: MoaConfig;
  /** Preset to use; falls back to activePreset then defaultPreset. */
  activePresetName?: string;
  /** Factory used to create an LLM for every reference slot. */
  createReferenceLlm(slot: MoaSlot): LLM | undefined;
  /** Factory used to create the aggregator LLM. */
  createAggregatorLlm(slot: MoaSlot): LLM | undefined;
  /** Override the default reference system prompt. */
  referenceSystemPrompt?: string;
  /** Override the default aggregator system prompt. */
  aggregatorSystemPrompt?: string;
}

function emptyUsage(): TokenUsage {
  return { input: 0, output: 0, total: 0 };
}

function sumUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    total: (a.total ?? 0) + (b.total ?? 0),
    cacheRead: (a.cacheRead ?? 0) + (b.cacheRead ?? 0),
    cacheWrite: (a.cacheWrite ?? 0) + (b.cacheWrite ?? 0),
    reasoning: (a.reasoning ?? 0) + (b.reasoning ?? 0),
  };
}

function buildReferenceMessages(
  ref: MoaAgentRef,
  input: string,
  contextMessages: Message[] = [],
  systemPrompt: string,
): Message[] {
  const messages: Message[] = [];
  if (ref.systemPrompt) {
    messages.push({ role: "system", content: ref.systemPrompt });
  } else if (systemPrompt) {
    messages.push({ role: "system", content: systemPrompt });
  }
  for (const m of contextMessages) {
    messages.push({ role: m.role, content: m.content });
  }
  messages.push({ role: "user", content: input });
  return messages;
}

function buildAggregatorMessages(
  input: string,
  references: MoaReferenceResult[],
  contextMessages: Message[] = [],
  style: "guidance" | "council" = "guidance",
): Message[] {
  const messages: Message[] = [];
  for (const m of contextMessages) {
    messages.push({ role: m.role, content: m.content });
  }

  let guidance = "";
  if (references.length > 0) {
    guidance += "\n\n=== Reference analyses ===\n\n";
    for (const ref of references) {
      guidance += `[${ref.name}]:\n${ref.text}\n\n`;
    }
  }

  const userContent =
    style === "council"
      ? `${input}\n\nPlease chair the following council report.${guidance}`
      : `${input}${guidance}`;

  messages.push({ role: "user", content: userContent });
  return messages;
}

async function runOneReference(
  ref: MoaAgentRef,
  index: number,
  total: number,
  options: {
    input: string;
    contextMessages: Message[];
    systemPrompt: string;
    signal?: AbortSignal;
    createLlm(slot: MoaSlot): LLM | undefined;
    degradedReferencePolicy: "loud" | "silent";
  },
): Promise<MoaReferenceResult> {
  const llm = options.createLlm(ref.slot);
  if (!llm) {
    const error = `No LLM adapter available for ${ref.slot.provider}/${ref.slot.model}`;
    if (options.degradedReferencePolicy === "loud") {
      throw new AgentError(error, "provider_not_available");
    }
    return {
      name: ref.name,
      provider: ref.slot.provider,
      model: ref.slot.model,
      text: "",
      error,
      usage: emptyUsage(),
    };
  }

  try {
    const messages = buildReferenceMessages(ref, options.input, options.contextMessages, options.systemPrompt);
    const signal = options.signal ?? new AbortController().signal;
    let streamedText = "";
    const response: LLMChatResponse = await llm.chat({
      messages,
      tools: [],
      signal,
      onTextDelta(delta) {
        streamedText += delta;
      },
    });
    const text = streamedText || response.text;
    return {
      name: ref.name,
      provider: ref.slot.provider,
      model: ref.slot.model,
      text,
      usage: response.usage ?? emptyUsage(),
    };
  } catch (err) {
    if (options.signal?.aborted) {
      throw new AgentError("MoA turn aborted", "aborted");
    }
    const error = err instanceof Error ? err.message : String(err);
    if (options.degradedReferencePolicy === "loud") {
      throw new AgentError(`Reference ${ref.name} failed: ${error}`, "reference_failed");
    }
    return {
      name: ref.name,
      provider: ref.slot.provider,
      model: ref.slot.model,
      text: "",
      error,
      usage: emptyUsage(),
    };
  }
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (concurrency <= 1) {
    const out: R[] = [];
    for (let i = 0; i < items.length; i++) {
      out.push(await fn(items[i], i));
    }
    return out;
  }

  const results = new Array<R>(items.length);
  const queue = items.map((item, i) => ({ item, i }));
  let nextIndex = 0;

  await new Promise<void>((resolve, reject) => {
    let active = 0;
    let rejected = false;

    function next() {
      if (rejected) return;
      if (nextIndex >= queue.length && active === 0) {
        resolve();
        return;
      }
      while (active < concurrency && nextIndex < queue.length) {
        const { item, i } = queue[nextIndex++]!;
        active++;
        fn(item, i)
          .then((result) => {
            results[i] = result;
          })
          .catch((err) => {
            rejected = true;
            reject(err);
          })
          .finally(() => {
            active--;
            if (!rejected) next();
          });
      }
    }

    next();
  });

  return results;
}

export class MoAOrchestrator {
  private readonly config: MoaConfig;
  private readonly activePresetName: string;
  private readonly preset: MoaPreset;
  private readonly createReferenceLlm: (slot: MoaSlot) => LLM | undefined;
  private readonly createAggregatorLlm: (slot: MoaSlot) => LLM | undefined;
  private readonly referenceSystemPrompt: string;
  private readonly aggregatorSystemPrompt: string;

  constructor(options: MoAOrchestratorOptions) {
    this.config = options.config;
    this.activePresetName =
      options.activePresetName ?? options.config.activePreset ?? options.config.defaultPreset;
    const preset = this.config.presets[this.activePresetName];
    if (!preset) {
      throw new AgentError(`MoA preset "${this.activePresetName}" not found`, "moa_preset_not_found");
    }
    if (preset.enabled === false) {
      throw new AgentError(`MoA preset "${this.activePresetName}" is disabled`, "moa_preset_disabled");
    }
    this.preset = preset;
    this.createReferenceLlm = options.createReferenceLlm;
    this.createAggregatorLlm = options.createAggregatorLlm;
    this.referenceSystemPrompt = options.referenceSystemPrompt ?? DEFAULT_REFERENCE_SYSTEM_PROMPT;
    this.aggregatorSystemPrompt = options.aggregatorSystemPrompt ?? DEFAULT_AGGREGATOR_SYSTEM_PROMPT;
  }

  get activePreset(): MoaPreset {
    return this.preset;
  }

  async run(options: MoaRunOptions): Promise<MoaRunResult> {
    if (options.signal?.aborted) {
      throw new AgentError("MoA turn aborted", "aborted");
    }

    const refs = this.buildReferences();
    const degradedPolicy = this.preset.degradedReferencePolicy ?? "silent";
    const concurrency =
      options.mode === "sequential" ? 1 : (this.config.maxParallel ?? 8);

    const runOptions = {
      input: options.input,
      contextMessages: options.contextMessages ?? [],
      systemPrompt: this.referenceSystemPrompt,
      signal: options.signal,
      createLlm: this.createReferenceLlm,
      degradedReferencePolicy: degradedPolicy,
    };

    const referenceResults = await mapWithConcurrency(refs, concurrency, (ref, index) =>
      runOneReference(ref, index, refs.length, runOptions).then((result) => {
        options.onReference?.(result, index, refs.length);
        return result;
      }),
    );

    options.onAggregating?.();

    const aggregatorLlm = this.createAggregatorLlm(this.preset.aggregator);
    if (!aggregatorLlm) {
      throw new AgentError(
        `No LLM adapter available for aggregator ${this.preset.aggregator.provider}/${this.preset.aggregator.model}`,
        "provider_not_available",
      );
    }

    const aggregatorMessages = buildAggregatorMessages(
      options.input,
      referenceResults,
      options.contextMessages ?? [],
      options.style ?? "guidance",
    );

    let aggregatorText = "";
    const aggregatorSignal = options.signal ?? new AbortController().signal;
    const aggregatorResponse = await aggregatorLlm.chat({
      messages: aggregatorMessages,
      tools: [],
      signal: aggregatorSignal,
      onTextDelta(delta) {
        aggregatorText += delta;
      },
    });

    const text = aggregatorText || aggregatorResponse.text;
    const usage = referenceResults.reduce(
      (acc, ref) => sumUsage(acc, ref.usage),
      aggregatorResponse.usage ?? emptyUsage(),
    );

    return {
      text,
      references: referenceResults,
      aggregatorModel: `${this.preset.aggregator.provider}/${this.preset.aggregator.model}`,
      usage,
    };
  }

  private buildReferences(): MoaAgentRef[] {
    const referenceModels = this.preset.referenceModels ?? [];
    return referenceModels
      .filter((slot) => slot.enabled !== false)
      .map((slot, index) => ({
        name: `${slot.provider}/${slot.model}`,
        slot,
        systemPrompt: undefined,
        temperature: this.preset.referenceTemperature ?? undefined,
      }));
  }
}
