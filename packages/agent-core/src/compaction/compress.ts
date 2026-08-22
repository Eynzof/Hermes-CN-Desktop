/**
 * Context compression orchestration.
 *
 * Implements a deterministic fallback (`truncate oldest`) plus an optional
 * LLM summarizer adapter. When a summarizer is supplied and the budget allows,
 * the oldest eligible messages are replaced by a structured summary message.
 *
 * Gaps vs the Python backend (documented in tests / README):
 *   - Full iterative `_previous_summary` update is stubbed: only the immediate
 *     predecessor summary is reused.
 *   - Token estimator is a heuristic; real provider tokenizers are not wired.
 */

import type { Message } from "../types.js";
import type {
  CompactionConfig,
  CompactionMessage,
  CompactionResult,
  CompactionSummarizer,
  ManualCompressOptions,
  ManualCompressReport,
} from "./types.js";

const SUMMARY_PREFIX = "[CONTEXT COMPACTION — REFERENCE ONLY]";

function randomId(): string {
  return globalThis.crypto.randomUUID();
}

/**
 * Rough token estimator: ASCII ≈ 4 chars/token, CJK/non-Latin ≈ 1 char/token.
 * Matches the heuristic already used in `web/src/lib/context-usage.ts`.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  let nonAscii = 0;
  for (const ch of text) {
    if (ch.charCodeAt(0) > 127) nonAscii++;
  }
  const ascii = text.length - nonAscii;
  return Math.max(1, Math.ceil(ascii / 4) + nonAscii);
}

export function estimateMessageTokens(message: Message): number {
  const base = 3; // per-message overhead
  const content = typeof message.content === "string" ? message.content : "";
  let tokens = base + estimateTokens(content);
  if (message.toolCalls && message.toolCalls.length > 0) {
    for (const tc of message.toolCalls) {
      tokens += estimateTokens(tc.name);
      tokens += estimateTokens(JSON.stringify(tc.arguments));
    }
  }
  return tokens;
}

export function estimateMessagesTokens(messages: Message[]): number {
  return messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
}

/** Resolve effective config, applying model/provider substring overrides. */
export function resolveCompactionConfig(
  base: CompactionConfig,
  modelName: string,
  overrides?: Record<string, Partial<Omit<CompactionConfig, "contextLength" | "enabled">>>,
): CompactionConfig {
  let match = "";
  let matched: Partial<Omit<CompactionConfig, "contextLength" | "enabled">> = {};
  if (overrides) {
    for (const [key, value] of Object.entries(overrides)) {
      if (modelName.includes(key) && key.length > match.length) {
        match = key;
        matched = value;
      }
    }
  }
  return { ...base, ...matched };
}

function buildConfig(configOrContextLength: CompactionConfig | number): CompactionConfig {
  const defaults = {
    enabled: true,
    threshold: 0.5,
    targetRatio: 0.2,
    protectFirstN: 3,
    protectLastN: 2,
    minTailUserMessages: 1,
    summaryBudget: 12_000,
    timeoutMs: 60_000,
    cooldownMs: 5_000,
  };
  if (typeof configOrContextLength === "number") {
    return {
      ...defaults,
      contextLength: configOrContextLength,
      summaryBudget: Math.min(Math.floor(configOrContextLength * 0.05), defaults.summaryBudget),
    };
  }
  return {
    ...defaults,
    ...configOrContextLength,
    summaryBudget:
      configOrContextLength.summaryBudget ??
      Math.min(Math.floor(configOrContextLength.contextLength * 0.05), defaults.summaryBudget),
  };
}

export function shouldCompress(messages: Message[], configOrContextLength: CompactionConfig | number): boolean {
  const config = buildConfig(configOrContextLength);
  if (!config.enabled) return false;
  const thresholdTokens = Math.floor(config.threshold * config.contextLength);
  const tokens = estimateMessagesTokens(messages);
  return tokens > thresholdTokens;
}

/** Protect head, then select the oldest compressible slice after `protectFirstN`. */
function selectCompressibleRange(
  messages: CompactionMessage[],
  config: CompactionConfig,
): { start: number; end: number; protectedHead: CompactionMessage[] } {
  const nonSystemIndexes: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]?.role !== "system") {
      nonSystemIndexes.push(i);
    }
  }

  const protectedCount = Math.min(config.protectFirstN, nonSystemIndexes.length);
  const protectedHeadIndexes = new Set(nonSystemIndexes.slice(0, protectedCount));
  const protectedHead = messages.filter((_, idx) => protectedHeadIndexes.has(idx));

  // Remaining messages after protected head.
  const remainingStart =
    protectedCount === 0 ? 0 : (nonSystemIndexes[protectedCount - 1] ?? -1) + 1;

  // Tail protection: keep last N non-system messages (or at least minTailUserMessages).
  let tailStart = messages.length;
  let kept = 0;
  let userKept = 0;
  for (let i = messages.length - 1; i >= remainingStart; i--) {
    const m = messages[i];
    if (!m || m.role === "system") continue;
    if (kept >= config.protectLastN && userKept >= config.minTailUserMessages) {
      tailStart = i + 1;
      break;
    }
    kept++;
    if (m.role === "user") userKept++;
  }

  return {
    start: remainingStart,
    end: tailStart,
    protectedHead,
  };
}

/**
 * Keep tool_call / tool_result pairs intact: if a tool_call is inside the
 * compression range, its matching tool_result must be compressed with it, and
 * vice versa. This expands the range backward/forward to align boundaries.
 */
function alignBoundaryToToolPairs(
  messages: CompactionMessage[],
  start: number,
  end: number,
): { start: number; end: number } {
  const toolCallIds = new Set<string>();
  for (let i = start; i < end; i++) {
    const m = messages[i];
    if (!m) continue;
    if (m.role === "assistant" && m.toolCalls) {
      for (const tc of m.toolCalls) {
        if (tc.id) toolCallIds.add(tc.id);
      }
    }
  }

  // Expand backward to include any tool_results belonging to included tool_calls.
  let alignedStart = start;
  for (let i = start - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "tool" && m.toolCallId && toolCallIds.has(m.toolCallId)) {
      alignedStart = i;
    } else {
      break;
    }
  }

  // Expand forward to include tool_results for included tool_calls.
  let alignedEnd = end;
  for (let i = end; i < messages.length; i++) {
    const m = messages[i];
    if (m?.role === "tool" && m.toolCallId && toolCallIds.has(m.toolCallId)) {
      alignedEnd = i + 1;
    } else {
      break;
    }
  }

  return { start: alignedStart, end: alignedEnd };
}

function sanitizeToolPairs(messages: CompactionMessage[]): CompactionMessage[] {
  const toolCallIds = new Set<string>();
  for (const m of messages) {
    if (m.role === "assistant" && m.toolCalls) {
      for (const tc of m.toolCalls) {
        if (tc.id) toolCallIds.add(tc.id);
      }
    }
  }
  return messages.filter((m) => {
    if (m.role !== "tool") return true;
    if (!m.toolCallId) return true;
    return toolCallIds.has(m.toolCallId);
  });
}

function roleAlternationRole(messages: CompactionMessage[]): "user" | "assistant" {
  // Prefer the role of the first compressed message, falling back to user.
  const first = messages.find((m) => m.role === "user" || m.role === "assistant");
  return first?.role === "assistant" ? "assistant" : "user";
}

function buildSummaryContent(
  compacted: CompactionMessage[],
  previousSummary?: string,
): string {
  const parts: string[] = [SUMMARY_PREFIX, "", "## Historical Task Snapshot", ""];

  if (previousSummary) {
    parts.push("### Previous Summary");
    parts.push(previousSummary);
    parts.push("");
  }

  const goals = compacted.filter((m) => m.role === "user").map((m) => m.content);
  const decisions = compacted.filter((m) => m.role === "assistant").map((m) => m.content);
  const files = compacted
    .filter((m) => m.role === "tool")
    .map((m) => `[${m.toolName ?? "tool"}] ${String(m.content).slice(0, 200)}`);

  if (goals.length) {
    parts.push("### Goals / Requests");
    goals.forEach((g) => parts.push(`- ${String(g).slice(0, 500)}`));
    parts.push("");
  }
  if (decisions.length) {
    parts.push("### Progress / Decisions");
    decisions.forEach((d) => parts.push(`- ${String(d).slice(0, 500)}`));
    parts.push("");
  }
  if (files.length) {
    parts.push("### Files / Tool Outputs");
    files.forEach((f) => parts.push(`- ${f}`));
    parts.push("");
  }

  parts.push("### Next Steps");
  parts.push("- Continue from the current state.");
  return parts.join("\n");
}

export interface CompressSessionContextOptions {
  messages: CompactionMessage[];
  systemPrompt?: string;
  configOrContextLength: CompactionConfig | number;
  summarizer?: CompactionSummarizer;
  signal?: AbortSignal;
  manual?: ManualCompressOptions;
  modelName?: string;
  overrides?: Record<string, Partial<Omit<CompactionConfig, "contextLength" | "enabled">>>;
}

/**
 * Compress a session context.
 *
 * 1. Select the oldest non-system messages after protecting head/tail.
 * 2. Align the boundary to keep tool pairs intact.
 * 3. If a summarizer is available and budget allows, call it; otherwise fall
 *    back to truncating the selected range.
 * 4. Insert a structured summary (or an elision marker in fallback) and return
 *    the new message list.
 */
export async function compressSessionContext(
  options: CompressSessionContextOptions,
): Promise<CompactionResult> {
  const {
    messages,
    systemPrompt,
    configOrContextLength,
    summarizer,
    signal,
    manual,
    modelName = "default",
    overrides,
  } = options;

  const baseConfig = buildConfig(configOrContextLength);
  const config = resolveCompactionConfig(baseConfig, modelName, overrides);

  if (!config.enabled) {
    return {
      status: "noop",
      messages,
      removed: 0,
      beforeMessages: messages.length,
      afterMessages: messages.length,
      beforeTokens: estimateMessagesTokens(messages),
      afterTokens: estimateMessagesTokens(messages),
      summary: undefined,
      compactionId: randomId(),
    };
  }

  const beforeTokens = estimateMessagesTokens(messages);
  const compactionId = randomId();
  const thresholdTokens = Math.floor(config.threshold * config.contextLength);

  if (beforeTokens <= thresholdTokens) {
    return {
      status: "noop",
      messages,
      removed: 0,
      beforeMessages: messages.length,
      afterMessages: messages.length,
      beforeTokens,
      afterTokens: beforeTokens,
      summary: undefined,
      compactionId,
    };
  }

  if (signal?.aborted) {
    return {
      status: "aborted",
      messages,
      removed: 0,
      beforeMessages: messages.length,
      afterMessages: messages.length,
      beforeTokens,
      afterTokens: beforeTokens,
      compactionId,
    };
  }

  const range = selectCompressibleRange(messages, config);
  const aligned = alignBoundaryToToolPairs(messages, range.start, range.end);
  const compactSlice = messages.slice(aligned.start, aligned.end);
  const compressedRange = { start: aligned.start, end: aligned.end };

  if (compactSlice.length === 0) {
    return {
      status: "noop",
      messages,
      removed: 0,
      beforeMessages: messages.length,
      afterMessages: messages.length,
      beforeTokens,
      afterTokens: beforeTokens,
      compactionId,
    };
  }

  const previousSummary = messages
    .slice(0, aligned.start)
    .filter((m) => m.summaryMessage)
    .pop()?.content;

  let summaryText: string | undefined;
  let fallbackUsed = false;

  const budgetTokens = Math.max(
    2_000,
    Math.min(config.summaryBudget, Math.floor(estimateMessagesTokens(compactSlice) * 0.2)),
  );

  if (summarizer && !manual?.dryRun) {
    try {
      const { summary } = await summarizer.summarize({
        messages: compactSlice,
        systemPrompt,
        previousSummary,
        budgetTokens,
        signal,
      });
      summaryText = summary;
    } catch {
      // Fall back to deterministic truncation on summarizer failure.
      fallbackUsed = true;
    }
  } else {
    fallbackUsed = true;
  }

  if (!summaryText) {
    fallbackUsed = true;
    summaryText = buildSummaryContent(compactSlice, previousSummary);
  }

  const summaryMessage: CompactionMessage = {
    id: randomId(),
    role: roleAlternationRole(compactSlice),
    content: summaryText,
    origin: { kind: "compaction_summary", compactionId },
    summaryMessage: true,
    compactionId,
    timestamp: Date.now(),
  };

  const keptHead = messages.slice(0, aligned.start);
  const keptTail = messages.slice(aligned.end);
  const sanitizedTail = sanitizeToolPairs(keptTail);
  const newMessages = [...keptHead, summaryMessage, ...sanitizedTail];
  const afterTokens = estimateMessagesTokens(newMessages);

  return {
    status: fallbackUsed ? "fallback" : "compacted",
    messages: newMessages,
    removed: compactSlice.length,
    beforeMessages: messages.length,
    afterMessages: newMessages.length,
    beforeTokens,
    afterTokens,
    summary: summaryText,
    compactionId,
    fallbackUsed,
    compressedRange,
  };
}

export function buildManualCompressReport(result: CompactionResult): ManualCompressReport {
  return {
    status: result.status,
    removed: result.removed,
    beforeMessages: result.beforeMessages,
    afterMessages: result.afterMessages,
    beforeTokens: result.beforeTokens,
    afterTokens: result.afterTokens,
    headline:
      result.status === "noop"
        ? "No compression needed."
        : `Compressed ${result.removed} messages`,
    tokenLine: `${result.beforeTokens} → ${result.afterTokens} tokens`,
    note: result.fallbackUsed ? "Used deterministic fallback (truncation)." : undefined,
    fallbackUsed: result.fallbackUsed,
  };
}

/**
 * Parse `/compress` arguments.
 *
 * Supported forms:
 * - `here N` / `last N` -> keep last N exchanges
 * - `<topic>` -> topical compression hint (focusTopic)
 * - `--preview` / `--dry-run`
 */
export function parseCompressArgs(args: string): ManualCompressOptions {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const result: ManualCompressOptions = {};

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!.toLowerCase();
    if (token === "--preview" || token === "--dry-run" || token === "-n") {
      result.preview = true;
      result.dryRun = true;
    } else if ((token === "here" || token === "last") && tokens[i + 1]) {
      const n = Number(tokens[i + 1]);
      if (Number.isInteger(n) && n > 0) {
        result.keepLast = n;
        i++;
      }
    } else if (!result.focusTopic) {
      result.focusTopic = tokens[i];
    }
  }

  return result;
}

