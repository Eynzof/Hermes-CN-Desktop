import { atom } from "jotai";
import type {
  GatewayEvent,
  GatewayMessageUsageT,
  HermesMessageMetadata,
  HermesMessagePart,
  HermesUIMessage,
} from "@hermes/protocol";
import type { ConnectionState } from "@/lib/gateway-client";
import {
  normalizeCliThinkingProgress,
  normalizeReasoningText,
} from "@/lib/reasoning-filter";
import {
  dedupeImageParts,
  imagePartFromSource,
} from "@/lib/message-images";
import { notifyFromGatewayEvent } from "@/lib/notifications";
import { resolvePersistentSessionId } from "@/lib/session-map";
import { recordUiTurnStats, stableTextHash } from "@/lib/ui-store";
import { routeSubagentGatewayEventAtom } from "@/stores/subagents";

export interface ToolEntry {
  tool_id: string;
  name: string;
  context?: string;
  preview?: string;
  summary?: string;
  error?: string;
  status: "running" | "done" | "error";
  startedAt: number;
  completedAt?: number;
}

export interface ImageEntry {
  url?: string;
  alt?: string;
  title?: string;
  name?: string;
  mimeType?: string;
}

export type AssistantTurnBlock =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "progress"; text: string }
  | { type: "image"; image: ImageEntry }
  | { type: "tool"; tool: ToolEntry }
  | { type: "moa_reference"; label: string; text: string; index?: number; count?: number };

export interface PendingApproval {
  requestId: string;
  sessionId: string;
  command: string;
  reason?: string;
}

export type StreamStatus = "idle" | "connecting" | "streaming" | "complete" | "error";

export interface ChatSessionRuntime {
  messages: HermesUIMessage[];
  streamStatus: StreamStatus;
  pendingApprovals: PendingApproval[];
  statusMessage: string;
  statusKind?: string;
  statusUpdatedAt?: number;
  updatedAt: number;
  /**
   * Wall-clock ms of the last *backend* event reduced for this session. Unlike
   * {@link updatedAt} (also bumped by local atom mutations like manual
   * interrupt / reset), this only advances when the gateway actually sends
   * something, so the stall watchdog can tell a live turn apart from a wedged
   * one where the backend has gone completely silent. See `session-activity.ts`.
   */
  lastActivityAt?: number;
  turnStartedAt?: number;
  turnFirstTokenAt?: number;
  activeAssistantId?: string;
  interrupted?: boolean;
}

export type ChatRuntimeBySession = Record<string, ChatSessionRuntime>;

type HermesToolPart = Extract<HermesMessagePart, { type: "tool" }>;

export const gwConnectionAtom = atom<ConnectionState>("idle");
export const gwSessionIdAtom = atom<string | null>(null);
export const chatRuntimeBySessionAtom = atom<ChatRuntimeBySession>({});

const GENERIC_TURN_FAILURE_TEXT =
  "模型服务调用未成功。常见原因：API Key 失效或不在模型权限范围、网络/服务不可达。请到 设置 → 模型 检查后重试。";
const PROVIDER_STATUS_KINDS = new Set([
  "provider_wait",
  "provider_retry",
  "provider_stalled",
  "tool_generating",
  "moa_reference",
  "moa_aggregating",
]);
const OPTIMISTIC_ASSISTANT_PROGRESS = "正在唤醒Hermes...";

export function createEmptyChatRuntime(now = Date.now()): ChatSessionRuntime {
  return {
    messages: [],
    streamStatus: "idle",
    pendingApprovals: [],
    statusMessage: "",
    updatedAt: now,
  };
}

function assistantClientId(now: number): string {
  return `live-assistant-${now}`;
}

function userClientId(now: number): string {
  return `live-user-${now}`;
}

function systemClientId(now: number): string {
  return `live-system-${now}`;
}

function payloadOf(event: GatewayEvent): Record<string, any> {
  return event.payload && typeof event.payload === "object"
    ? event.payload as Record<string, any>
    : {};
}

function pickErrorText(payload: Record<string, any>, fallback = GENERIC_TURN_FAILURE_TEXT): string {
  for (const key of ["error", "message", "warning", "detail"] as const) {
    const value = payload[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return fallback;
}

function resetStream(runtime: ChatSessionRuntime, now: number): ChatSessionRuntime {
  return {
    ...runtime,
    statusMessage: "",
    statusKind: undefined,
    statusUpdatedAt: undefined,
    activeAssistantId: undefined,
    turnStartedAt: undefined,
    turnFirstTokenAt: undefined,
    updatedAt: now,
  };
}

function isProviderStatusKind(kind: string | undefined): boolean {
  return kind !== undefined && PROVIDER_STATUS_KINDS.has(kind);
}

function clearProviderStatus(runtime: ChatSessionRuntime): ChatSessionRuntime {
  if (!isProviderStatusKind(runtime.statusKind)) return runtime;
  return {
    ...runtime,
    statusMessage: "",
    statusKind: undefined,
    statusUpdatedAt: undefined,
  };
}

function sessionIdFor(runtime: ChatSessionRuntime, event: GatewayEvent): string {
  return event.session_id ?? runtime.messages[0]?.sessionId ?? "";
}

function isStreamingStatus(status: StreamStatus): boolean {
  return status === "streaming" || status === "connecting";
}

function textFromParts(parts: HermesMessagePart[]): string {
  return parts
    .filter((part): part is Extract<HermesMessagePart, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function reasoningFromParts(parts: HermesMessagePart[]): string {
  return parts
    .filter((part): part is Extract<HermesMessagePart, { type: "reasoning" }> => part.type === "reasoning")
    .map((part) => part.text)
    .join("");
}

function looseComparableText(value: string | undefined): string {
  return (value ?? "")
    .replace(/\s+/g, "")
    .replace(/[*_`~]/g, "")
    .replace(/[，。！？、：；,.!?:;"'“”‘’（）()[\]{}<>《》\-—–]/g, "")
    .toLowerCase();
}

function withoutProgressParts(parts: HermesMessagePart[]): HermesMessagePart[] {
  return parts.filter((part) => part.type !== "progress");
}

function imagePartsFromPayload(payload: Record<string, any>): HermesMessagePart[] {
  const sources = Array.isArray(payload.images)
    ? payload.images
    : payload.image !== undefined
      ? [payload.image]
      : payload.image_url !== undefined
        ? [payload.image_url]
        : [];

  return dedupeImageParts(
    sources.flatMap((source: unknown, index: number) => {
      const part = imagePartFromSource(source, `image-${index + 1}`);
      return part ? [part] : [];
    }),
  );
}

function appendImageParts(parts: HermesMessagePart[], images: HermesMessagePart[]): HermesMessagePart[] {
  if (!images.length) return parts;
  const progressIndex = parts.findIndex((part) => part.type === "progress");
  const base = progressIndex === -1
    ? parts
    : [...parts.slice(0, progressIndex), ...parts.slice(progressIndex + 1)];
  const currentImages = base.filter((part): part is Extract<HermesMessagePart, { type: "image" }> =>
    part.type === "image"
  );
  const nextImages = dedupeImageParts([
    ...currentImages,
    ...images.filter((part): part is Extract<HermesMessagePart, { type: "image" }> => part.type === "image"),
  ]);
  const imageKeys = new Set(nextImages.map((part) => part.url || part.path || part.name || part.alt).filter(Boolean));
  const withoutDuplicateImages = base.filter((part) => {
    if (part.type !== "image") return true;
    const key = part.url || part.path || part.name || part.alt;
    return !key || !imageKeys.has(key);
  });
  const merged = [...withoutDuplicateImages, ...nextImages];
  return progressIndex === -1
    ? merged
    : [
      ...merged.slice(0, progressIndex),
      parts[progressIndex]!,
      ...merged.slice(progressIndex),
    ];
}

function terminateRunningTools(parts: HermesMessagePart[]): HermesMessagePart[] {
  let changed = false;
  const next = parts.map((part) => {
    if (part.type === "tool" && part.state === "running") {
      changed = true;
      return { ...part, state: "error" as const };
    }
    return part;
  });
  return changed ? next : parts;
}

function appendTextPart(parts: HermesMessagePart[], text: string): HermesMessagePart[] {
  if (!text) return parts;
  const next = withoutProgressParts(parts);
  const last = next[next.length - 1];
  if (last?.type === "text") {
    next[next.length - 1] = { ...last, text: last.text + text };
  } else {
    next.push({ type: "text", text });
  }
  return next;
}

function appendReasoningPart(parts: HermesMessagePart[], text: string): HermesMessagePart[] {
  if (!text) return parts;
  const next = withoutProgressParts(parts);
  const last = next[next.length - 1];
  if (last?.type === "reasoning") {
    next[next.length - 1] = { ...last, text: last.text + text };
  } else {
    next.push({ type: "reasoning", text });
  }
  return next;
}

function upsertReasoningPart(parts: HermesMessagePart[], text: string): HermesMessagePart[] {
  if (!text) return parts;
  const next = withoutProgressParts(parts);
  const index = next.findIndex((part) => part.type === "reasoning");
  if (index === -1) return [...next, { type: "reasoning", text }];
  next[index] = { ...next[index], type: "reasoning", text };
  return next;
}

function upsertProgressPart(parts: HermesMessagePart[], text: string): HermesMessagePart[] {
  if (!text) return parts;
  const index = parts.findIndex((part) => part.type === "progress");
  if (index === -1) return [...parts, { type: "progress", text }];
  return parts.map((part, idx) =>
    idx === index && part.type === "progress" ? { ...part, text } : part,
  );
}

function appendToolPart(parts: HermesMessagePart[], tool: HermesToolPart): HermesMessagePart[] {
  const progressIndex = parts.findIndex((part) => part.type === "progress");
  if (progressIndex === -1) return [...parts, tool];
  return [
    ...parts.slice(0, progressIndex),
    tool,
    ...parts.slice(progressIndex),
  ];
}

function mergeFinalTextPart(parts: HermesMessagePart[], finalText: string): HermesMessagePart[] {
  if (!finalText) return parts;
  const next = withoutProgressParts(parts);
  let lastToolIndex = -1;
  next.forEach((part, index) => {
    if (part.type === "tool") lastToolIndex = index;
  });
  const finalSegmentStart = lastToolIndex + 1;
  const existingFinalSegment = textFromParts(next.slice(finalSegmentStart));

  if (existingFinalSegment === finalText) return next;

  // message.complete.text is the authoritative final assistant response. In a
  // tool-bearing turn it represents only the text after the final tool call;
  // earlier commentary must remain intact. Replace that trailing text segment
  // instead of appending when streamed deltas diverge: an out-of-order WS batch
  // can otherwise produce "corrupt partial + complete final" in one live row.
  let inserted = false;
  const reconciled = next.flatMap((part, index) => {
    if (index < finalSegmentStart || part.type !== "text") return [part];
    if (inserted) return [];
    inserted = true;
    return [{ ...part, text: finalText }];
  });

  return inserted ? reconciled : [...reconciled, { type: "text", text: finalText }];
}

function findToolMatch(tool: HermesToolPart, payload: Record<string, any>): boolean {
  if (payload.tool_id) return tool.toolCallId === payload.tool_id;
  if (!payload.name) return false;
  return tool.state === "running" && tool.name === payload.name;
}

function updateToolParts(
  parts: HermesMessagePart[],
  payload: Record<string, any>,
  updater: (tool: HermesToolPart) => HermesToolPart,
): HermesMessagePart[] {
  return parts.map((part) => {
    if (part.type !== "tool" || !findToolMatch(part, payload)) return part;
    return updater(part);
  });
}

function completeToolPart(tool: HermesToolPart, payload: Record<string, any>, now: number): HermesToolPart {
  const duration = payload.duration_s;
  const completedAt =
    typeof duration === "number" && Number.isFinite(duration) && duration >= 0 && tool.startedAt
      ? tool.startedAt + duration * 1000
      : now;
  const output =
    typeof payload.inline_diff === "string"
      ? payload.inline_diff
      : typeof payload.summary === "string"
        ? payload.summary
        : tool.output;

  return {
    ...tool,
    state: payload.error ? "error" : "done",
    output,
    errorText: typeof payload.error === "string" ? payload.error : undefined,
    completedAt,
  };
}

function updateMessage(
  runtime: ChatSessionRuntime,
  id: string,
  updater: (message: HermesUIMessage) => HermesUIMessage | null,
): ChatSessionRuntime {
  let changed = false;
  const messages = runtime.messages.flatMap((message) => {
    if (message.id !== id) return [message];
    changed = true;
    const next = updater(message);
    return next ? [next] : [];
  });
  return changed ? { ...runtime, messages } : runtime;
}

function ensureAssistantMessage(
  runtime: ChatSessionRuntime,
  sessionId: string,
  id: string,
  now: number,
): ChatSessionRuntime {
  if (runtime.messages.some((message) => message.id === id)) {
    return updateMessage(runtime, id, (message) => ({
      ...message,
      status: message.status === "error" ? "error" : "streaming",
    }));
  }

  const createdAt = runtime.turnStartedAt ?? now;
  return {
    ...runtime,
    messages: [
      ...runtime.messages,
      {
        id,
        sessionId,
        role: "assistant",
        createdAt,
        status: "streaming",
        parts: [],
      },
    ],
  };
}

function activeAssistantId(runtime: ChatSessionRuntime, now: number): string {
  return runtime.activeAssistantId ?? assistantClientId(now);
}

function updateActiveAssistant(
  runtime: ChatSessionRuntime,
  sessionId: string,
  now: number,
  updater: (message: HermesUIMessage) => HermesUIMessage | null,
): ChatSessionRuntime {
  const id = activeAssistantId(runtime, now);
  const ensured = ensureAssistantMessage(
    { ...runtime, activeAssistantId: id },
    sessionId,
    id,
    now,
  );
  return updateMessage(ensured, id, updater);
}

function appendNoticeMessage(
  runtime: ChatSessionRuntime,
  sessionId: string,
  now: number,
  text: string,
  level: "info" | "warning" | "error" | "system",
): ChatSessionRuntime {
  const trimmed = text.trim();
  if (!trimmed) return runtime;
  return {
    ...runtime,
    messages: [
      ...runtime.messages,
      {
        id: systemClientId(now),
        sessionId,
        role: "system",
        createdAt: now,
        status: level === "error" ? "error" : "complete",
        parts: [{ type: "notice", level, text: trimmed }],
      },
    ],
  };
}

// Map backend status.update lifecycle signals to localized, user-facing text.
// Returns "" to clear the status line, undefined to leave it unchanged.
function localizeStatusUpdate(kind: string, text: string): string | undefined {
  if (kind === "compressing") return "正在压缩上下文…";
  // session.compress pins a neutral "ready" status when compaction settles —
  // surface nothing rather than a raw English "ready" string in the timeline.
  if (kind === "ready" || text === "ready") return "";
  return text || undefined;
}

function gatewayUsageMetadata(usage: GatewayMessageUsageT | undefined): HermesMessageMetadata["usage"] | undefined {
  if (!usage) return undefined;
  const next: NonNullable<HermesMessageMetadata["usage"]> = {};
  if (typeof usage.input === "number") next.tokensInput = usage.input;
  if (typeof usage.output === "number") next.tokensOutput = usage.output;
  if (typeof usage.prompt === "number") next.tokensPrompt = usage.prompt;
  if (typeof usage.completion === "number") next.tokensCompletion = usage.completion;
  if (typeof usage.total === "number") next.tokensTotal = usage.total;
  if (typeof usage.cache_read === "number") next.cacheRead = usage.cache_read;
  if (typeof usage.cache_write === "number") next.cacheWrite = usage.cache_write;
  if (typeof usage.calls === "number") next.apiCalls = usage.calls;
  if (typeof usage.context_used === "number") next.contextUsed = usage.context_used;
  if (typeof usage.context_max === "number") next.contextMax = usage.context_max;
  if (typeof usage.context_percent === "number") next.contextPercent = usage.context_percent;
  return Object.keys(next).length > 0 ? next : undefined;
}

function completionMetadata(
  payload: Record<string, any>,
  runtime: ChatSessionRuntime,
  now: number,
): HermesMessageMetadata | undefined {
  const usage =
    payload.usage && typeof payload.usage === "object"
      ? (payload.usage as GatewayMessageUsageT)
      : undefined;
  const startedAt = runtime.turnStartedAt;
  const firstTokenAt = runtime.turnFirstTokenAt;
  const timing: NonNullable<HermesMessageMetadata["timing"]> = {};
  if (typeof startedAt === "number") timing.startedAt = startedAt;
  if (typeof firstTokenAt === "number") timing.firstTokenAt = firstTokenAt;
  timing.completedAt = now;
  if (typeof startedAt === "number" && typeof firstTokenAt === "number" && firstTokenAt >= startedAt) {
    timing.ttftMs = firstTokenAt - startedAt;
  }
  if (typeof startedAt === "number" && now >= startedAt) {
    timing.durationMs = now - startedAt;
  }

  const metadata: HermesMessageMetadata = {};
  const usageMetadata = gatewayUsageMetadata(usage);
  if (usageMetadata) metadata.usage = usageMetadata;
  if (Object.keys(timing).length > 0) metadata.timing = timing;
  if (typeof usage?.model === "string" && usage.model) metadata.model = usage.model;
  const finishReason =
    typeof usage?.finish_reason === "string"
      ? usage.finish_reason
      : typeof payload.finish_reason === "string"
        ? payload.finish_reason
        : typeof payload.status === "string" && payload.status !== "complete"
          ? payload.status
          : undefined;
  if (finishReason) metadata.finishReason = finishReason;
  if (typeof usage?.cost_usd === "number" || usage?.cost_usd === null) {
    metadata.costUsd = usage.cost_usd;
  }
  if (typeof usage?.cost_status === "string") metadata.costStatus = usage.cost_status;

  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function finalizeAssistantParts(
  message: HermesUIMessage,
  payload: Record<string, any>,
): HermesMessagePart[] {
  let parts = withoutProgressParts(message.parts);
  const finalText = typeof payload.text === "string" ? payload.text : "";
  const finalReasoning = normalizeReasoningText(
    typeof payload.reasoning === "string" ? payload.reasoning : reasoningFromParts(parts),
  );

  parts = mergeFinalTextPart(parts, finalText);
  if (finalReasoning) {
    parts = upsertReasoningPart(parts, finalReasoning);
  }
  parts = appendImageParts(parts, imagePartsFromPayload(payload));

  return parts;
}

export function reduceGatewayEvent(
  runtime: ChatSessionRuntime,
  event: GatewayEvent,
  now = Date.now(),
): ChatSessionRuntime {
  const next = reduceGatewayEventInner(runtime, event, now);
  // Stamp the last time we heard from the backend. `next === runtime` means
  // the event was a no-op (e.g. a late event from an interrupted turn that was
  // dropped) — don't count those as activity. Everything the gateway actually
  // applies resets the stall watchdog's silence timer.
  if (next === runtime) return next;
  return { ...next, lastActivityAt: now };
}

function reduceGatewayEventInner(
  runtime: ChatSessionRuntime,
  event: GatewayEvent,
  now = Date.now(),
): ChatSessionRuntime {
  const payload = payloadOf(event);
  const sessionId = sessionIdFor(runtime, event);

  if (runtime.interrupted) {
    if (event.type === "message.start") {
      // 新回合开始即解除屏蔽，远程发起的回合和 busy 重试都依赖这里恢复渲染
      return reduceGatewayEvent({ ...runtime, interrupted: undefined }, event, now);
    }
    if (event.type !== "message.complete" && event.type !== "error") {
      // 丢弃被中断回合迟到的流式事件；终态事件放行，让半截消息正常收尾
      return runtime;
    }
  }

  switch (event.type) {
    case "message.start": {
      const id =
        isStreamingStatus(runtime.streamStatus) && runtime.activeAssistantId
          ? runtime.activeAssistantId
          : assistantClientId(now);
      return ensureAssistantMessage(
        {
          ...runtime,
          streamStatus: "streaming",
          statusMessage: "",
          statusKind: undefined,
          statusUpdatedAt: undefined,
          activeAssistantId: id,
          turnStartedAt: runtime.turnStartedAt ?? now,
          turnFirstTokenAt: undefined,
          updatedAt: now,
        },
        sessionId,
        id,
        now,
      );
    }

    case "message.delta": {
      const text = typeof payload.text === "string" ? payload.text : "";
      const images = imagePartsFromPayload(payload);
      const id = activeAssistantId(runtime, now);
      const next = updateActiveAssistant(
        clearProviderStatus({
          ...runtime,
          streamStatus: "streaming",
          activeAssistantId: id,
          turnStartedAt: runtime.turnStartedAt ?? now,
          turnFirstTokenAt: runtime.turnFirstTokenAt ?? (text ? now : runtime.turnFirstTokenAt),
          updatedAt: now,
        }),
        sessionId,
        now,
        (message) => ({
          ...message,
          status: "streaming",
          parts: appendImageParts(appendTextPart(message.parts, text), images),
        }),
      );
      return next;
    }

    case "moa.reference": {
      // 一个 reference 模型的完整输出块（label + 全文），在聚合器回答之前
      // 逐个到达。追加为独立的 moa_reference part；同时用 provider-status
      // 通道提示进度（message.delta 到达时自动清除）。
      const label = typeof payload.label === "string" ? payload.label : "";
      const text = typeof payload.text === "string" ? payload.text : "";
      const index = typeof payload.index === "number" ? payload.index : undefined;
      const count = typeof payload.count === "number" ? payload.count : undefined;
      if (!label && !text) return runtime;
      const id = activeAssistantId(runtime, now);
      const progressLabel =
        index !== undefined && count !== undefined
          ? `参考模型 ${label || "?"} 已完成（${index + 1}/${count}）…`
          : `参考模型 ${label || "?"} 已完成…`;
      return updateActiveAssistant(
        {
          ...runtime,
          streamStatus: "streaming",
          activeAssistantId: id,
          turnStartedAt: runtime.turnStartedAt ?? now,
          statusMessage: progressLabel,
          statusKind: "moa_reference",
          statusUpdatedAt: now,
          updatedAt: now,
        },
        sessionId,
        now,
        (message) => ({
          ...message,
          status: "streaming",
          parts: [
            ...message.parts,
            { type: "moa_reference", label: label || "reference", text, index, count },
          ],
        }),
      );
    }

    case "moa.aggregating": {
      // references 齐了，聚合器开始综合；它的回答走普通 message.delta 流，
      // 到达时 clearProviderStatus 会清掉这条状态。
      const aggregator = typeof payload.aggregator === "string" ? payload.aggregator : "";
      return {
        ...runtime,
        statusMessage: aggregator
          ? `聚合器 ${aggregator} 正在综合各模型观点…`
          : "聚合器正在综合各模型观点…",
        statusKind: "moa_aggregating",
        statusUpdatedAt: now,
        updatedAt: now,
      };
    }

    case "thinking.delta":
    case "reasoning.delta": {
      const progress = normalizeCliThinkingProgress(payload.text);
      const id = activeAssistantId(runtime, now);
      if (progress) {
        return updateActiveAssistant(
          clearProviderStatus({
            ...runtime,
            streamStatus: "streaming",
            activeAssistantId: id,
            turnStartedAt: runtime.turnStartedAt ?? now,
            updatedAt: now,
          }),
          sessionId,
          now,
          (message) => ({
            ...message,
            status: "streaming",
            parts: upsertProgressPart(message.parts, progress),
          }),
        );
      }

      const text = normalizeReasoningText(payload.text);
      return updateActiveAssistant(
        clearProviderStatus({
          ...runtime,
          streamStatus: "streaming",
          activeAssistantId: id,
          turnStartedAt: runtime.turnStartedAt ?? now,
          turnFirstTokenAt: runtime.turnFirstTokenAt ?? (text ? now : runtime.turnFirstTokenAt),
          updatedAt: now,
        }),
        sessionId,
        now,
        (message) => ({
          ...message,
          status: "streaming",
          parts: appendReasoningPart(message.parts, text),
        }),
      );
    }

    case "reasoning.available": {
      const progress = normalizeCliThinkingProgress(payload.text);
      const id = activeAssistantId(runtime, now);
      if (progress) {
        return updateActiveAssistant(
          clearProviderStatus({
            ...runtime,
            activeAssistantId: id,
            updatedAt: now,
          }),
          sessionId,
          now,
          (message) => ({
            ...message,
            parts: upsertProgressPart(message.parts, progress),
          }),
        );
      }

      const text = normalizeReasoningText(payload.text);
      return updateActiveAssistant(
        clearProviderStatus({
          ...runtime,
          activeAssistantId: id,
          updatedAt: now,
        }),
        sessionId,
        now,
        (message) => ({
          ...message,
          parts: upsertReasoningPart(message.parts, text),
        }),
      );
    }

    case "message.complete": {
      const id = activeAssistantId(runtime, now);
      const metadata = completionMetadata(payload, runtime, now);
      const isErrorCompletion = payload.status === "error";
      let next = updateActiveAssistant(
        {
          ...runtime,
          activeAssistantId: id,
          updatedAt: now,
        },
        sessionId,
        now,
        (message) => {
          const finalizedParts = finalizeAssistantParts(message, payload);
          const parts = isErrorCompletion ? terminateRunningTools(finalizedParts) : finalizedParts;
          if (parts.length === 0) return null;
          return {
            ...message,
            status: isErrorCompletion ? "error" : "complete",
            parts,
            metadata: metadata ? { ...message.metadata, ...metadata } : message.metadata,
          };
        },
      );

      const warningText =
        typeof payload.warning === "string" && payload.warning.trim()
          ? payload.warning
          : undefined;
      if (warningText) {
        next = appendNoticeMessage(next, sessionId, now + 1, warningText, "warning");
      }
      if (isErrorCompletion) {
        next = appendNoticeMessage(next, sessionId, now + 2, pickErrorText(payload), "error");
      }

      return {
        ...next,
        streamStatus: isErrorCompletion ? "error" : "complete",
        statusMessage: warningText ?? "",
        statusKind: warningText ? "warn" : undefined,
        statusUpdatedAt: warningText ? now : undefined,
        turnStartedAt: undefined,
        turnFirstTokenAt: undefined,
        activeAssistantId: undefined,
        interrupted: undefined,
        updatedAt: now,
      };
    }

    case "tool.start": {
      const id = activeAssistantId(runtime, now);
      const tool: HermesToolPart = {
        type: "tool",
        toolCallId: String(payload.tool_id ?? `tool-${now}`),
        name: String(payload.name ?? "tool"),
        state: "running",
        input: typeof payload.context === "string" ? { context: payload.context } : undefined,
        startedAt: now,
      };
      return updateActiveAssistant(
        clearProviderStatus({
          ...runtime,
          streamStatus: "streaming",
          activeAssistantId: id,
          turnStartedAt: runtime.turnStartedAt ?? now,
          updatedAt: now,
        }),
        sessionId,
        now,
        (message) => ({
          ...message,
          status: "streaming",
          parts: appendToolPart(message.parts, tool),
        }),
      );
    }

    case "tool.generating": {
      // 模型正在流式生成工具调用参数（先于 tool.start，此刻还没有 tool part）。
      // 走 provider-status 通道展示轻量提示；tool.start/内容事件到达时由
      // clearProviderStatus 自然清除。
      const name = typeof payload.name === "string" ? payload.name : "";
      return {
        ...runtime,
        statusMessage: name ? `正在准备 ${name} 工具调用…` : "正在准备工具调用…",
        statusKind: "tool_generating",
        statusUpdatedAt: now,
        updatedAt: now,
      };
    }

    case "tool.complete": {
      const id = activeAssistantId(runtime, now);
      return updateActiveAssistant(
        clearProviderStatus({
          ...runtime,
          activeAssistantId: id,
          updatedAt: now,
        }),
        sessionId,
        now,
        (message) => ({
          ...message,
          parts: updateToolParts(message.parts, payload, (tool) =>
            completeToolPart(tool, payload, now),
          ),
        }),
      );
    }

    case "approval.request": {
      const requestId = String(payload.request_id ?? `approval-${now}`);
      const approval: PendingApproval = {
        requestId,
        sessionId,
        command: String(payload.command ?? payload.description ?? "需要确认操作"),
        reason:
          typeof payload.reason === "string"
            ? payload.reason
            : typeof payload.description === "string"
              ? payload.description
              : undefined,
      };
      return {
        ...runtime,
        streamStatus: "streaming",
        pendingApprovals: [
          ...runtime.pendingApprovals.filter((item) => item.requestId !== requestId),
          approval,
        ],
        updatedAt: now,
      };
    }

    case "status.update": {
      const kind = typeof payload.kind === "string" ? payload.kind : "status";
      const text = typeof payload.text === "string" ? payload.text : "";
      const localized = localizeStatusUpdate(kind, text);
      return {
        ...runtime,
        statusMessage: localized !== undefined ? localized : runtime.statusMessage,
        statusKind: kind,
        statusUpdatedAt: now,
        updatedAt: now,
      };
    }

    case "error": {
      const text = pickErrorText(payload, "发生错误");
      const erroredActive = runtime.activeAssistantId
        ? updateMessage(runtime, runtime.activeAssistantId, (message) => ({
            ...message,
            status: "error",
            parts: terminateRunningTools(withoutProgressParts(message.parts)),
          }))
        : runtime;
      const next = appendNoticeMessage(erroredActive, sessionId, now, text, "error");
      return {
        ...next,
        streamStatus: "error",
        statusMessage: text,
        statusKind: "error",
        statusUpdatedAt: now,
        activeAssistantId: undefined,
        interrupted: undefined,
        updatedAt: now,
      };
    }

    case "gateway.disconnected": {
      if (!isStreamingStatus(runtime.streamStatus)) return runtime;
      const id = runtime.activeAssistantId;
      const next = id
        ? updateMessage(runtime, id, (message) => ({
            ...message,
            status: "error",
            parts: terminateRunningTools(withoutProgressParts(message.parts)),
          }))
        : runtime;
      return {
        ...next,
        streamStatus: "error",
        statusMessage: "连接已断开",
        statusKind: "error",
        statusUpdatedAt: now,
        activeAssistantId: undefined,
        updatedAt: now,
      };
    }

    default:
      return runtime;
  }
}

function updateSessionRuntime(
  state: ChatRuntimeBySession,
  sessionId: string,
  updater: (runtime: ChatSessionRuntime) => ChatSessionRuntime,
): ChatRuntimeBySession {
  const current = state[sessionId] ?? createEmptyChatRuntime();
  return {
    ...state,
    [sessionId]: updater(current),
  };
}

export const ensureChatSessionAtom = atom(null, (_get, set, sessionId: string) => {
  set(chatRuntimeBySessionAtom, (state) =>
    state[sessionId] ? state : { ...state, [sessionId]: createEmptyChatRuntime() },
  );
});

export const resetChatSessionAtom = atom(null, (_get, set, sessionId: string) => {
  set(chatRuntimeBySessionAtom, (state) => ({
    ...state,
    [sessionId]: createEmptyChatRuntime(),
  }));
});

export const resetStreamStateAtom = atom(null, (_get, set, sessionId: string) => {
  const now = Date.now();
  set(chatRuntimeBySessionAtom, (state) =>
    updateSessionRuntime(state, sessionId, (runtime) => ({
      ...resetStream(runtime, now),
      streamStatus: "idle",
    })),
  );
});

// 手动终止：立即把会话标记为非运行态，并屏蔽旧回合迟到的流式事件。
// 故意保留 activeAssistantId / turnStartedAt，迟到的 message.complete 才能收尾正确的消息。
export const markSessionInterruptedAtom = atom(null, (_get, set, sessionId: string) => {
  const now = Date.now();
  set(chatRuntimeBySessionAtom, (state) =>
    updateSessionRuntime(state, sessionId, (runtime) => ({
      ...runtime,
      interrupted: true,
      streamStatus: "idle",
      statusMessage: "",
      statusKind: undefined,
      statusUpdatedAt: undefined,
      updatedAt: now,
    })),
  );
});

function storedAssistantIsAfterTurn(message: HermesUIMessage, turnStartedAt: number | undefined): boolean {
  if (turnStartedAt === undefined) return true;
  return message.createdAt >= turnStartedAt - 1_000;
}

function isRecoverableStoredAssistant(
  liveAssistant: HermesUIMessage,
  storedAssistant: HermesUIMessage,
  turnStartedAt: number | undefined,
): boolean {
  if (liveAssistant.role !== "assistant" || storedAssistant.role !== "assistant") return false;
  if (storedAssistant.status !== "complete") return false;
  if (!storedAssistantIsAfterTurn(storedAssistant, turnStartedAt)) return false;

  const liveText = looseComparableText(textFromParts(withoutProgressParts(liveAssistant.parts)));
  const storedText = looseComparableText(textFromParts(storedAssistant.parts));
  if (liveText && storedText) {
    return liveText === storedText || (liveText.length >= 4 && storedText.includes(liveText));
  }
  if (liveText && !storedText) {
    return false;
  }

  const liveReasoning = looseComparableText(reasoningFromParts(withoutProgressParts(liveAssistant.parts)));
  const storedReasoning = looseComparableText(reasoningFromParts(storedAssistant.parts));
  if (liveReasoning && storedReasoning) {
    return liveReasoning === storedReasoning ||
      (liveReasoning.length >= 4 && storedReasoning.includes(liveReasoning));
  }

  const liveHasOnlyProgress = withoutProgressParts(liveAssistant.parts).length === 0;
  const storedHasContent = storedText.length > 0 ||
    storedReasoning.length > 0 ||
    storedAssistant.parts.some((part) => part.type === "tool");
  return liveHasOnlyProgress && storedHasContent;
}

function recoverableAssistantId(
  runtime: ChatSessionRuntime,
  storedMessages: HermesUIMessage[],
): string | undefined {
  const activeCandidate = runtime.activeAssistantId
    ? runtime.messages.find((message) => message.id === runtime.activeAssistantId)
    : undefined;
  const fallbackCandidate = [...runtime.messages]
    .reverse()
    .find((message) => message.role === "assistant" && message.status === "streaming");
  const liveAssistant = activeCandidate ?? fallbackCandidate;
  if (!liveAssistant) return undefined;

  const matched = storedMessages.some((storedMessage) =>
    isRecoverableStoredAssistant(liveAssistant, storedMessage, runtime.turnStartedAt),
  );
  return matched ? liveAssistant.id : undefined;
}

export const recoverCompletedTurnFromStoredMessagesAtom = atom(
  null,
  (_get, set, params: { sessionId: string; storedMessages: HermesUIMessage[]; now?: number }) => {
    if (params.storedMessages.length === 0) return;
    const now = params.now ?? Date.now();
    set(chatRuntimeBySessionAtom, (state) => {
      const runtime = state[params.sessionId];
      if (!runtime || !isStreamingStatus(runtime.streamStatus)) return state;

      const assistantId = recoverableAssistantId(runtime, params.storedMessages);
      if (!assistantId) return state;

      return {
        ...state,
        [params.sessionId]: {
          ...resetStream(runtime, now),
          messages: runtime.messages.filter((message) => message.id !== assistantId),
          streamStatus: "complete",
          pendingApprovals: [],
          updatedAt: now,
        },
      };
    });
  },
);

export const startPromptAtom = atom(
  null,
  (_get, set, params: { sessionId: string; text: string; images?: ImageEntry[]; now?: number }) => {
    const now = params.now ?? Date.now();
    const assistantId = assistantClientId(now);
    const userParts: HermesMessagePart[] = [];
    if (params.text) userParts.push({ type: "text", text: params.text });
    for (const image of params.images ?? []) {
      const part = imagePartFromSource(image);
      if (part) userParts.push(part);
    }
    set(gwSessionIdAtom, params.sessionId);
    set(chatRuntimeBySessionAtom, (state) =>
      updateSessionRuntime(state, params.sessionId, (runtime) => ({
        ...resetStream(runtime, now),
        interrupted: undefined,
        messages: [
          ...runtime.messages,
          {
            id: userClientId(now),
            sessionId: params.sessionId,
            role: "user",
            createdAt: now,
            status: "complete",
            parts: userParts.length ? userParts : [{ type: "text", text: params.text }],
          },
          {
            id: assistantId,
            sessionId: params.sessionId,
            role: "assistant",
            createdAt: now,
            status: "streaming",
            parts: [{ type: "progress", text: OPTIMISTIC_ASSISTANT_PROGRESS }],
          },
        ],
        streamStatus: "streaming",
        pendingApprovals: [],
        turnStartedAt: now,
        turnFirstTokenAt: undefined,
        activeAssistantId: assistantId,
      })),
    );
  },
);

/** Append a standalone system/notice message to a session — used for client-side
 *  command results (e.g. manual /compress) that aren't part of a model turn. */
export const appendNoticeAtom = atom(
  null,
  (
    _get,
    set,
    params: {
      sessionId: string;
      text: string;
      level?: "info" | "warning" | "error" | "system";
      now?: number;
    },
  ) => {
    const now = params.now ?? Date.now();
    set(chatRuntimeBySessionAtom, (state) =>
      updateSessionRuntime(state, params.sessionId, (runtime) =>
        appendNoticeMessage(runtime, params.sessionId, now, params.text, params.level ?? "system"),
      ),
    );
  },
);

function textForStatsHash(message: HermesUIMessage): string {
  return message.parts
    .flatMap((part) => {
      if (part.type === "text" || part.type === "reasoning") return [part.text];
      if (part.type === "image") return [part.url, part.path, part.name, part.alt].filter(Boolean) as string[];
      if (part.type === "tool") {
        let output = "";
        if (typeof part.output === "string") {
          output = part.output;
        } else if (part.output !== undefined) {
          try {
            output = JSON.stringify(part.output);
          } catch {
            output = String(part.output);
          }
        }
        return [part.name, output];
      }
      return [];
    })
    .join("\n");
}

function latestCompletedAssistant(runtime: ChatSessionRuntime): HermesUIMessage | undefined {
  return [...runtime.messages].reverse().find(
    (message) => message.role === "assistant" && message.status !== "streaming" && message.metadata,
  );
}

function assistantTurnIndex(runtime: ChatSessionRuntime, id: string): number | undefined {
  let index = 0;
  for (const message of runtime.messages) {
    if (message.role !== "assistant") continue;
    index += 1;
    if (message.id === id) return index;
  }
  return undefined;
}

function persistCompletedTurnStats(runtime: ChatSessionRuntime, event: GatewayEvent): void {
  if (event.type !== "message.complete" || !event.session_id) return;
  const message = latestCompletedAssistant(runtime);
  const metadata = message?.metadata;
  if (!message || !metadata) return;

  const persistentSessionId = resolvePersistentSessionId(event.session_id) ?? event.session_id;
  const usage = metadata.usage;
  const timing = metadata.timing;
  const now = Date.now();
  void recordUiTurnStats({
    id: `${persistentSessionId}:${message.id}`,
    sessionId: persistentSessionId,
    gatewaySessionId: event.session_id === persistentSessionId ? undefined : event.session_id,
    clientMessageId: message.id,
    turnIndex: assistantTurnIndex(runtime, message.id),
    contentHash: stableTextHash(textForStatsHash(message)),
    metadata,
    model: metadata.model,
    startedAt: timing?.startedAt,
    firstTokenAt: timing?.firstTokenAt,
    completedAt: timing?.completedAt,
    ttftMs: timing?.ttftMs,
    durationMs: timing?.durationMs,
    tokensInput: usage?.tokensInput,
    tokensOutput: usage?.tokensOutput ?? usage?.tokensCompletion,
    tokensTotal: usage?.tokensTotal,
    cacheRead: usage?.cacheRead,
    cacheWrite: usage?.cacheWrite,
    apiCalls: usage?.apiCalls,
    costUsd: metadata.costUsd ?? undefined,
    costStatus: metadata.costStatus,
    finishReason: metadata.finishReason,
    status: message.status,
    createdAt: now,
  });
}

export const applyGatewayEventAtom = atom(null, (get, set, event: GatewayEvent) => {
  if (!event.session_id) return;
  // 通知决策需要 reduce 前的快照（pendingApprovals / activeAssistantId 是
  // 防重放依据），在 set 之外读取——jotai 不承诺 updater 恰好执行一次。
  // 副作用本身 fire-and-forget，绝不影响 reducer。
  try {
    notifyFromGatewayEvent(event, get(chatRuntimeBySessionAtom)[event.session_id]);
  } catch {}
  set(chatRuntimeBySessionAtom, (state) =>
    updateSessionRuntime(state, event.session_id!, (runtime) => {
      const next = reduceGatewayEvent(runtime, event);
      persistCompletedTurnStats(next, event);
      return next;
    }),
  );
  // Route subagent activity into its own store (issue #238). Self-contained in
  // stores/subagents.ts; chat timeline reduction is untouched.
  set(routeSubagentGatewayEventAtom, event);
});

export const setSessionErrorAtom = atom(
  null,
  (_get, set, params: { sessionId: string; message: string }) => {
    const now = Date.now();
    set(chatRuntimeBySessionAtom, (state) =>
      updateSessionRuntime(state, params.sessionId, (runtime) => {
        const erroredActive = runtime.activeAssistantId
          ? updateMessage(runtime, runtime.activeAssistantId, (message) => ({
              ...message,
              status: "error",
              parts: terminateRunningTools(withoutProgressParts(message.parts)),
            }))
          : runtime;
        return {
          ...erroredActive,
          streamStatus: "error",
          statusMessage: params.message,
          statusKind: "error",
          statusUpdatedAt: now,
          activeAssistantId: undefined,
          turnStartedAt: undefined,
          turnFirstTokenAt: undefined,
          updatedAt: now,
        };
      }),
    );
  },
);

function isPersistentErrorNotice(message: HermesUIMessage): boolean {
  return (
    message.role === "system" &&
    message.status === "error" &&
    message.parts.some((part) => part.type === "notice" && part.level === "error")
  );
}

export const drainLiveMessagesAtom = atom(
  null,
  (_get, set, sessionId: string): HermesUIMessage[] => {
    let drained: HermesUIMessage[] = [];
    set(chatRuntimeBySessionAtom, (state) => {
      const rt = state[sessionId];
      if (!rt || rt.messages.length === 0) return state;
      const keep = rt.messages.filter(isPersistentErrorNotice);
      drained = rt.messages.filter((message) => !isPersistentErrorNotice(message));
      if (keep.length === rt.messages.length) return state;
      return {
        ...state,
        [sessionId]: {
          ...rt,
          messages: keep,
        },
      };
    });
    return drained;
  },
);

export const terminateAllStreamsAtom = atom(null, (_get, set) => {
  const now = Date.now();
  set(chatRuntimeBySessionAtom, (state) => {
    let changed = false;
    const next: ChatRuntimeBySession = {};
    for (const [sessionId, rt] of Object.entries(state)) {
      if (rt.streamStatus === "streaming" || rt.streamStatus === "connecting") {
        changed = true;
        const activeId = rt.activeAssistantId;
        const marked = activeId
          ? updateMessage(rt, activeId, (message) => ({
              ...message,
              status: "error",
              parts: terminateRunningTools(withoutProgressParts(message.parts)),
            }))
          : rt;
        next[sessionId] = {
          ...marked,
          streamStatus: "error",
          statusMessage: "连接已断开",
          statusKind: "error",
          statusUpdatedAt: now,
          activeAssistantId: undefined,
          updatedAt: now,
        };
      } else {
        next[sessionId] = rt;
      }
    }
    return changed ? next : state;
  });
});

// Transient counterpart to terminateAllStreamsAtom for a *recoverable* gateway
// drop (sleep/wake, dashboard restart). The backend session survives the socket
// drop, so we must NOT freeze the in-flight turn as a terminal error or clear
// activeAssistantId — otherwise post-reconnect deltas would start a brand-new
// assistant message and the original reply looks lost. Instead we keep the
// message + activeAssistantId intact and show a transient "reconnecting" status;
// once the socket reconnects, session.resume re-pins the live turn and the
// remaining deltas flow onto the SAME message (message.delta flips the status
// back to "streaming"). If the reconnect ultimately fails, the gateway bridge
// calls terminateAllStreams() to surface a real error. See
// docs/gateway-connection-overhaul.md (P0-2).
export const markStreamsReconnectingAtom = atom(null, (_get, set) => {
  const now = Date.now();
  set(chatRuntimeBySessionAtom, (state) => {
    let changed = false;
    const next: ChatRuntimeBySession = {};
    for (const [sessionId, rt] of Object.entries(state)) {
      if (rt.streamStatus === "streaming") {
        changed = true;
        next[sessionId] = {
          ...rt,
          // keep messages + activeAssistantId untouched so the turn can resume
          streamStatus: "connecting",
          statusMessage: "连接中断，正在重连…",
          statusKind: "info",
          statusUpdatedAt: now,
          updatedAt: now,
        };
      } else {
        next[sessionId] = rt;
      }
    }
    return changed ? next : state;
  });
});

export const removeApprovalAtom = atom(
  null,
  (_get, set, params: { sessionId: string; requestId: string }) => {
    set(chatRuntimeBySessionAtom, (state) =>
      updateSessionRuntime(state, params.sessionId, (runtime) => ({
        ...runtime,
        pendingApprovals: runtime.pendingApprovals.filter(
          (item) => item.requestId !== params.requestId,
        ),
      })),
    );
  },
);
