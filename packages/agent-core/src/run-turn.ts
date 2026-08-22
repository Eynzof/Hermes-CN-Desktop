import type { AgentEvent, AgentEventEmitter } from "./events.js";
import { AgentAbortError } from "./errors.js";
import { executeTurnStep, type TurnStepResult } from "./turn-step.js";
import type { ContextFile, LLM, Message, Tool, TokenUsage, ToolCall } from "./types.js";
import {
  compressSessionContext,
  estimateMessagesTokens,
  planAndApplyCacheControl,
  stripCacheControl,
  type CacheControlOptions,
  type CompactionConfig,
  type CompactionMessage,
  type CompactionResult,
  type CompactionSummarizer,
} from "./compaction/index.js";
import { formatContextBlock, resolveSystemPrompt, type PersonalityOverlayMode } from "./personality/index.js";

export interface RunTurnOptions {
  sessionId: string;
  turnId?: string;
  prompt: string;
  llm: LLM;
  messages: Message[];
  tools: readonly Tool[];
  systemPrompt?: string;
  /** Project context files to inject on the first turn. */
  contextFiles?: ContextFile[];
  /** Active personality name or raw prompt; applied as an ephemeral overlay. */
  personality?: string;
  /** Personality overlay mode (default: append). */
  personalityMode?: PersonalityOverlayMode;
  /** Durable memory files (MEMORY.md / USER.md) to inject into the system prompt. */
  memoryFiles?: ContextFile[];
  maxSteps?: number;
  signal?: AbortSignal;
  emit?: (event: AgentEvent) => void;
  /** Automatic context compaction configuration. */
  compactionConfig?: CompactionConfig | number;
  /** Optional LLM summarizer for structured compaction summaries. */
  compactionSummarizer?: CompactionSummarizer;
  /** Provider-specific prompt-cache marker options. */
  cacheControlOptions?: CacheControlOptions;
}

export interface RunTurnResult {
  assistantMessage: Message;
  steps: TurnStepResult[];
  usage: TokenUsage;
  stopReason: "stop" | "max_steps" | "aborted";
}

const DEFAULT_MAX_STEPS = 32;

function emptyUsage(): TokenUsage {
  return { input: 0, output: 0, total: 0 };
}

function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    total: (a.total ?? 0) + (b.total ?? 0),
    cacheRead: (a.cacheRead ?? 0) + (b.cacheRead ?? 0),
    cacheWrite: (a.cacheWrite ?? 0) + (b.cacheWrite ?? 0),
    reasoning: (a.reasoning ?? 0) + (b.reasoning ?? 0),
  };
}

function randomId(): string {
  return globalThis.crypto.randomUUID();
}

export interface ContextMergeResult {
  systemPrompt: string;
  userContext: string;
}

/**
 * Merge loaded context files into a system-prompt block and a user-context block.
 * SOUL.md-style identity files are placed in the system block; project-context
 * files are placed in the user block so they ride with the current turn.
 *
 * This is the legacy pure-merge entry point. `runTurn` internally uses
 * {@link resolveSystemPrompt} so SOUL.md can replace the default identity and
 * personality overlays can be applied.
 */
export function mergeContextFiles(files: ContextFile[]): ContextMergeResult {
  if (files.length === 0) {
    return { systemPrompt: "", userContext: "" };
  }
  const systemFiles = files.filter((f) => f.source === "soul");
  const contextFiles_ = files.filter((f) => f.source !== "soul");
  return {
    systemPrompt: formatContextBlock(systemFiles),
    userContext: formatContextBlock(contextFiles_),
  };
}

function formatMemoryContext(files: ContextFile[]): string {
  const sections = files.map((f) => `## ${f.provenance ?? basename_(f.path)}\n${f.content}`);
  return `# Memory Context\nThe following durable memory files are loaded and should inform the conversation:\n\n${sections.join("\n\n")}`;
}

function basename_(path: string): string {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return idx < 0 ? path : path.slice(idx + 1);
}

export async function runTurn(options: RunTurnOptions): Promise<RunTurnResult> {
  const {
    sessionId,
    turnId = randomId(),
    prompt,
    llm,
    messages: history,
    tools,
    systemPrompt,
    contextFiles,
    memoryFiles,
    personality,
    personalityMode,
    maxSteps = DEFAULT_MAX_STEPS,
    signal = new AbortController().signal,
    emit,
  } = options;

  const isFirstTurn = history.length === 0;

  const resolution = isFirstTurn
    ? resolveSystemPrompt({
        baseSystemPrompt: systemPrompt,
        contextFiles,
        personality,
        personalityMode,
      })
    : resolveSystemPrompt({});

  const memoryContext = isFirstTurn && memoryFiles && memoryFiles.length > 0
    ? formatMemoryContext(memoryFiles)
    : undefined;

  const effectiveSystemPrompt = [resolution.systemPrompt, memoryContext]
    .filter((s) => s && s.trim().length > 0)
    .join("\n\n") || undefined;

  const userContext = isFirstTurn ? formatContextBlock(resolution.contextFiles) : "";
  const effectivePrompt = userContext ? `${userContext}\n\n${prompt}` : prompt;

  const messages: CompactionMessage[] = effectiveSystemPrompt
    ? [{ role: "system", content: effectiveSystemPrompt }, ...history]
    : [...history];

  messages.push({ role: "user", content: effectivePrompt, timestamp: Date.now() });

  // Automatic context compaction before the turn begins.
  if (options.compactionConfig !== undefined) {
    const tokenCount = estimateMessagesTokens(messages);
    if (tokenCount > 0) {
      const compaction = await compressSessionContext({
        messages,
        systemPrompt: effectiveSystemPrompt,
        configOrContextLength: options.compactionConfig,
        summarizer: options.compactionSummarizer,
        signal,
        modelName: llm.modelName,
      });
      if (compaction.status !== "noop") {
        emitCompactionEvents(emit, sessionId, compaction);
        messages.splice(0, messages.length, ...compaction.messages);
      }
    }
  }

  emit?.({
    type: "agent.turn.start",
    session_id: sessionId,
    payload: { turn_id: turnId, prompt },
  });

  emit?.({
    type: "message.start",
    session_id: sessionId,
    payload: { turn_id: turnId },
  });

  let usage = emptyUsage();
  const steps: TurnStepResult[] = [];
  let stopReason: RunTurnResult["stopReason"] = "stop";
  let cacheBreakpointCount = 0;

  try {
    for (let step = 0; step < maxSteps; step++) {
      if (signal.aborted) {
        throw new AgentAbortError();
      }

      const stepResult = await executeTurnStep({
        llm,
        messages,
        tools,
        signal,
        sessionId,
        emit,
        toolContext: { sessionId, signal },
        cacheControlOptions: options.cacheControlOptions,
        onCachePlan: (plan) => {
          cacheBreakpointCount = plan.breakpointCount;
        },
      });

      steps.push(stepResult);
      usage = addUsage(usage, stepResult.usage);

      const assistantMessage: Message = {
        id: randomId(),
        role: "assistant",
        content: stepResult.assistantText,
        toolCalls: stepResult.toolCalls.length > 0 ? stepResult.toolCalls : undefined,
        timestamp: Date.now(),
        finishReason: stepResult.finishReason,
      };
      messages.push(assistantMessage);

      if (stepResult.toolResults.length === 0) {
        // Model produced a final answer (or no tool calls).
        break;
      }

      for (const record of stepResult.toolResults) {
        messages.push({
          id: randomId(),
          role: "tool",
          content: record.result.content,
          toolCallId: record.toolCall.id,
          toolName: record.toolCall.name,
          timestamp: Date.now(),
        });
      }

      if (step === maxSteps - 1) {
        stopReason = "max_steps";
      }
    }
  } catch (error) {
    if (signal.aborted || error instanceof AgentAbortError) {
      stopReason = "aborted";
    } else {
      emit?.({
        type: "error",
        session_id: sessionId,
        payload: { message: error instanceof Error ? error.message : String(error) },
      });
      throw error;
    }
  } finally {
    const lastStep = steps[steps.length - 1];
    const finalAssistant = messages[messages.length - 1];

    emit?.({
      type: "message.complete",
      session_id: sessionId,
      payload: {
        text: finalAssistant?.role === "assistant" ? finalAssistant.content : undefined,
        reasoning: finalAssistant?.reasoning,
        usage,
        status: stopReason,
      },
    });

    emit?.({
      type: "agent.turn.complete",
      session_id: sessionId,
      payload: {
        turn_id: turnId,
        text: finalAssistant?.role === "assistant" ? finalAssistant.content : undefined,
        usage: {
          model: llm.modelName,
          input: usage.input,
          output: usage.output,
          total: usage.total,
          cache_read: usage.cacheRead,
          cache_write: usage.cacheWrite,
          cache_breakpoints: cacheBreakpointCount,
          context_used: undefined,
          context_max: undefined,
        },
        finish_reason: lastStep?.finishReason,
      },
    });
  }

  const assistantMessage = messages.reduceRight<Message | undefined>((found, message) => {
    return found ?? (message.role === "assistant" ? message : undefined);
  }, undefined) ?? {
    id: randomId(),
    role: "assistant",
    content: "",
    timestamp: Date.now(),
  };

  return {
    assistantMessage,
    steps,
    usage,
    stopReason,
  };
}

function emitCompactionEvents(
  emit: ((event: AgentEvent) => void) | undefined,
  sessionId: string,
  result: CompactionResult,
): void {
  if (!emit) return;

  emit({
    type: "agent.status",
    session_id: sessionId,
    payload: { kind: "compacting", text: "Compacting context" },
  });

  emit({
    type: "session.compress",
    session_id: sessionId,
    payload: {
      status: result.status,
      removed: result.removed,
      before_messages: result.beforeMessages,
      after_messages: result.afterMessages,
      before_tokens: result.beforeTokens,
      after_tokens: result.afterTokens,
      in_place: true,
      old_session_id: sessionId,
    },
  });
}
