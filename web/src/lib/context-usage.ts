export interface ContextUsageLike {
  used?: number;
  max?: number;
  percent?: number;
}

export type ContextRisk = "unknown" | "ok" | "warning" | "danger";

export const CONTEXT_WARNING_PERCENT = 85;
export const CONTEXT_DANGER_PERCENT = 100;

const ESTIMATE_CHARS_PER_TOKEN = 4;
const ESTIMATE_MESSAGE_OVERHEAD_TOKENS = 8;

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function positiveNumber(value: unknown): number | undefined {
  const num = finiteNumber(value);
  return num !== undefined && num > 0 ? num : undefined;
}

function firstPositive(...values: unknown[]): number | undefined {
  for (const value of values) {
    const num = positiveNumber(value);
    if (num !== undefined) return num;
  }
  return undefined;
}

function stringSize(value: unknown): number {
  if (typeof value === "string") return value.length;
  if (value == null) return 0;
  try {
    return JSON.stringify(value).length;
  } catch {
    return String(value).length;
  }
}

export interface ContextEstimateTool {
  name?: string;
  context?: string;
  preview?: string;
  summary?: string;
  error?: string;
  arguments?: unknown;
}

export interface ContextEstimateMessage {
  text?: string;
  tools?: readonly ContextEstimateTool[];
}

export interface ComposerContextUsageLike extends ContextUsageLike {
  model?: string;
  compressions?: number;
  estimated?: boolean;
}

export interface BuildComposerContextUsageParams {
  live?: {
    model?: string;
    context_used?: number;
    context_max?: number;
    context_percent?: number;
    compressions?: number;
  } | null;
  modelInfo?: {
    model?: string;
    effective_context_length?: number;
    auto_context_length?: number;
  } | null;
  session?: {
    model?: string;
    [key: string]: unknown;
  } | null;
  selectedModel?: {
    model?: string;
  } | null;
  selectedContextMax?: number;
  estimatedUsed?: number;
}

export function estimateRenderedContextTokens(
  messages: readonly ContextEstimateMessage[],
): number | undefined {
  if (!messages.length) return undefined;

  let total = 0;
  for (const message of messages) {
    let chars = stringSize(message.text);
    for (const tool of message.tools ?? []) {
      chars += stringSize(tool.name);
      chars += stringSize(tool.context);
      chars += stringSize(tool.preview);
      chars += stringSize(tool.summary);
      chars += stringSize(tool.error);
      chars += stringSize(tool.arguments);
    }
    if (chars > 0) {
      total += Math.ceil(chars / ESTIMATE_CHARS_PER_TOKEN) + ESTIMATE_MESSAGE_OVERHEAD_TOKENS;
    }
  }

  return total > 0 ? total : undefined;
}

export function buildComposerContextUsage({
  live,
  modelInfo,
  session,
  selectedModel,
  selectedContextMax,
  estimatedUsed,
}: BuildComposerContextUsageParams): ComposerContextUsageLike | null {
  const liveUsed = positiveNumber(live?.context_used);
  const fallbackEstimate = liveUsed === undefined ? positiveNumber(estimatedUsed) : undefined;
  const used = liveUsed ?? fallbackEstimate;
  const max = firstPositive(
    selectedContextMax,
    live?.context_max,
    modelInfo?.effective_context_length,
    modelInfo?.auto_context_length,
  );
  const compressions = positiveNumber(live?.compressions);
  const model = selectedModel?.model ?? live?.model ?? session?.model ?? modelInfo?.model;

  if (!live && !modelInfo && !session && !selectedModel && used === undefined && max === undefined) {
    return null;
  }

  return {
    used,
    max,
    percent: liveUsed !== undefined ? finiteNumber(live?.context_percent) : undefined,
    model,
    compressions,
    estimated: liveUsed === undefined && fallbackEstimate !== undefined,
  };
}

// Percentage is capped at 100: a session can exceed its window (used > max),
// but the ring fills at 100% and a ">100%" label reads as a rendering bug. The
// token label (used / max) still conveys the overflow numerically, and the
// danger risk still fires since the cap lands exactly on CONTEXT_DANGER_PERCENT.
export function contextUsagePercent(usage: ContextUsageLike | null | undefined): number | undefined {
  if (!usage) return undefined;

  const explicit = finiteNumber(usage.percent);
  if (explicit !== undefined) {
    return Math.min(100, Math.max(0, explicit));
  }

  const used = finiteNumber(usage.used);
  const max = finiteNumber(usage.max);
  if (used === undefined || max === undefined || max <= 0) return undefined;
  return Math.min(100, Math.max(0, (used / max) * 100));
}

export function contextUsageRisk(usage: ContextUsageLike | null | undefined): ContextRisk {
  const percent = contextUsagePercent(usage);
  if (percent === undefined) return "unknown";
  if (percent >= CONTEXT_DANGER_PERCENT) return "danger";
  if (percent >= CONTEXT_WARNING_PERCENT) return "warning";
  return "ok";
}
