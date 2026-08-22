import type { AgentEvent } from "./events.js";
import type { ToolContext, ToolResult, TokenUsage, FinishReason, ToolCall, Tool, LLM, Message } from "./types.js";
import { findToolByName, parseToolCallArguments } from "./tool-args-parse.js";
import { AgentAbortError, ToolError } from "./errors.js";
import { planAndApplyCacheControl, type CacheControlOptions, type CacheControlPlan } from "./compaction/index.js";

export interface ToolResultRecord {
  toolCall: ToolCall;
  result: ToolResult;
  durationMs: number;
}

export interface TurnStepResult {
  assistantText: string;
  toolCalls: ToolCall[];
  toolResults: ToolResultRecord[];
  usage: TokenUsage;
  finishReason?: FinishReason;
}

export interface TurnStepOptions {
  llm: LLM;
  messages: Message[];
  tools: readonly Tool[];
  signal: AbortSignal;
  sessionId: string;
  emit?: (event: AgentEvent) => void;
  toolContext?: ToolContext;
  /** Provider-specific prompt-cache marker options. */
  cacheControlOptions?: CacheControlOptions;
  /** Optional callback receiving the cache plan chosen for this step. */
  onCachePlan?: (plan: CacheControlPlan) => void;
}

function checkAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new AgentAbortError();
  }
}

export async function executeTurnStep(options: TurnStepOptions): Promise<TurnStepResult> {
  const { llm, messages, tools, signal, sessionId, emit, toolContext, cacheControlOptions, onCachePlan } = options;
  checkAborted(signal);

  // Apply request-local cache-control markers before sending to the provider.
  // The canonical `messages`/`tools` arrays are left untouched.
  const effectiveCacheOptions: CacheControlOptions = cacheControlOptions ?? { provider: "generic" };
  const { messages: decoratedMessages, tools: decoratedTools, plan } = planAndApplyCacheControl(
    messages,
    [...tools],
    effectiveCacheOptions,
  );
  onCachePlan?.(plan);

  const response = await llm.chat({
    messages: decoratedMessages as Message[],
    tools: decoratedTools,
    signal,
    onTextDelta(delta) {
      emit?.({
        type: "message.delta",
        session_id: sessionId,
        payload: { text: delta },
      });
    },
    onThinkDelta(delta) {
      emit?.({
        type: "thinking.delta",
        session_id: sessionId,
        payload: { text: delta },
      });
    },
    onToolCallDelta(delta) {
      // Tool-call stream deltas are currently accumulated by the adapter and
      // materialized as complete calls in the response.  We emit no partial
      // event here to keep the coalescer simple.
      void delta;
    },
  });

  checkAborted(signal);

  if (response.text) {
    emit?.({
      type: "message.delta",
      session_id: sessionId,
      payload: { text: response.text },
    });
  }

  const toolResults: ToolResultRecord[] = [];
  for (const toolCall of response.toolCalls) {
    emit?.({
      type: "tool.start",
      session_id: sessionId,
      payload: {
        tool_id: toolCall.id,
        name: toolCall.name,
      },
    });

    const start = performance.now();
    const result = await dispatchToolCall(toolCall, tools, toolContext);
    const durationMs = Math.max(0, performance.now() - start);

    toolResults.push({ toolCall, result, durationMs });

    emit?.({
      type: "tool.complete",
      session_id: sessionId,
      payload: {
        tool_id: toolCall.id,
        name: toolCall.name,
        summary: result.content.slice(0, 500),
        error: result.isError ? result.content : undefined,
        duration_s: Math.round(durationMs / 1000),
      },
    });

    checkAborted(signal);
  }

  return {
    assistantText: response.text,
    toolCalls: response.toolCalls,
    toolResults,
    usage: response.usage,
    finishReason: response.providerFinishReason,
  };
}

async function dispatchToolCall(
  toolCall: ToolCall,
  tools: readonly Tool[],
  context?: ToolContext,
): Promise<ToolResult> {
  const tool = findToolByName(toolCall.name, tools);
  if (!tool) {
    return {
      content: `Tool "${toolCall.name}" is not available.`,
      isError: true,
    };
  }

  let args: unknown;
  try {
    args = parseToolCallArguments(tool, toolCall);
  } catch (error) {
    return {
      content: `Failed to parse arguments for "${tool.name}": ${error instanceof Error ? error.message : String(error)}`,
      isError: true,
    };
  }

  try {
    return await tool.execute(args, context ?? { sessionId: "unknown" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: `Tool "${tool.name}" failed: ${message}`,
      isError: true,
    };
  }
}

export { ToolError };
