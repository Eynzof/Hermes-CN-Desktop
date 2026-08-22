import {
  compressSessionContext,
  estimateMessagesTokens,
  buildManualCompressReport,
  parseCompressArgs,
  type CompactionConfig,
  type CompactionMessage,
  type CompactionSummarizer,
} from "@hermes/agent-core";
import type { SessionMessage } from "@hermes/protocol";
import type { SessionStore } from "@/lib/session-store/session-store";
import type { CommandResult } from "../types";

export interface CompressHandlerContext {
  activeSessionId: string | null;
  store: SessionStore;
  modelName?: string;
  /** Optional LLM summarizer for structured compression summaries. */
  summarizer?: CompactionSummarizer;
  /** Default model context length. */
  contextLength?: number;
  notify?: (message: string) => void;
}

function sessionMessageToCompactionMessage(message: SessionMessage): CompactionMessage {
  return {
    id: String(message.id),
    role: message.role as CompactionMessage["role"],
    content: message.content ?? "",
    toolCallId: message.tool_call_id ?? undefined,
    toolName: message.tool_name ?? undefined,
    toolCalls: Array.isArray(message.tool_calls)
      ? (message.tool_calls as CompactionMessage["toolCalls"])
      : undefined,
    timestamp: message.timestamp,
    tokenCount: message.token_count ?? undefined,
    finishReason: message.finish_reason ?? undefined,
    reasoning: message.reasoning ?? undefined,
    reasoningContent: message.reasoning_content ?? undefined,
  };
}

function buildConfig(contextLength?: number): CompactionConfig {
  const ctx = contextLength && contextLength > 0 ? contextLength : 128_000;
  return {
    enabled: true,
    contextLength: ctx,
    threshold: 0.5,
    targetRatio: 0.2,
    protectFirstN: 3,
    protectLastN: 2,
    minTailUserMessages: 1,
    summaryBudget: Math.min(Math.floor(ctx * 0.05), 12_000),
    timeoutMs: 60_000,
    cooldownMs: 5_000,
  };
}

/**
 * `/compress [topic|here N] [--preview|--dry-run]` — manually compact the
 * active session context. If a summarizer is unavailable, falls back to
 * deterministic truncation.
 */
export async function handleCompress(args: string, ctx: CompressHandlerContext): Promise<CommandResult> {
  if (!ctx.activeSessionId) {
    return { type: "error", message: "No active session" };
  }

  const sessionId = ctx.activeSessionId;
  const messages = await ctx.store.getMessages(sessionId);
  if (messages.length === 0) {
    return { type: "exec", output: "No messages to compress." };
  }

  const parsed = parseCompressArgs(args);
  const compactionMessages = messages.map(sessionMessageToCompactionMessage);

  if (parsed.keepLast && parsed.keepLast > 0) {
    // Protect the last N user-assistant exchanges by temporarily truncating the tail.
    let exchanges = 0;
    let cutoff = compactionMessages.length;
    for (let i = compactionMessages.length - 1; i >= 0; i--) {
      if (compactionMessages[i]?.role === "user") {
        exchanges++;
        if (exchanges >= parsed.keepLast) {
          cutoff = i;
          break;
        }
      }
    }
    compactionMessages.splice(cutoff);
  }

  const beforeTokens = estimateMessagesTokens(compactionMessages);
  const result = await compressSessionContext({
    messages: compactionMessages,
    configOrContextLength: buildConfig(ctx.contextLength),
    summarizer: ctx.summarizer,
    modelName: ctx.modelName ?? "default",
    manual: parsed,
  });

  const report = buildManualCompressReport(result);

  if (parsed.preview || parsed.dryRun) {
    return {
      type: "exec",
      output: `${report.headline}\n${report.tokenLine}\n${report.note ?? ""}`.trim(),
    };
  }

  if (result.status === "noop") {
    return {
      type: "exec",
      output: `${report.headline}\n${report.tokenLine}`,
    };
  }

  // Persist the compaction: soft-archive the compacted range and append summary.
  const range = result.compressedRange;
  if (range && result.removed > 0) {
    const startMessage = messages[range.start];
    const endMessage = messages[range.end - 1];
    if (startMessage && endMessage) {
      await ctx.store.compressMessages(
        sessionId,
        startMessage.id,
        endMessage.id,
        {
          role: result.messages[range.start]?.role ?? "user",
          content: result.summary ?? "",
          token_count: result.afterTokens,
        },
      );
      ctx.notify?.(`Compressed ${result.removed} messages (${beforeTokens} → ${result.afterTokens} tokens)`);
    }
  }

  return {
    type: "exec",
    output: `${report.headline}\n${report.tokenLine}\n${report.note ?? ""}`.trim(),
  };
}
