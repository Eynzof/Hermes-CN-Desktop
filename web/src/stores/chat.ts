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
import { resolvePersistentSessionId } from "@/lib/session-map";
import { recordUiTurnStats, stableTextHash } from "@/lib/ui-store";

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

export type AssistantTurnBlock =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "progress"; text: string }
  | { type: "tool"; tool: ToolEntry };

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
  turnStartedAt?: number;
  turnFirstTokenAt?: number;
  activeAssistantId?: string;
}

export type ChatRuntimeBySession = Record<string, ChatSessionRuntime>;

type HermesToolPart = Extract<HermesMessagePart, { type: "tool" }>;

export const gwConnectionAtom = atom<ConnectionState>("idle");
export const gwSessionIdAtom = atom<string | null>(null);
export const chatRuntimeBySessionAtom = atom<ChatRuntimeBySession>({});

const GENERIC_TURN_FAILURE_TEXT =
  "模型服务调用未成功。常见原因：API Key 失效或不在模型权限范围、网络/服务不可达。请到 设置 → 模型 检查后重试。";
const PROVIDER_STATUS_KINDS = new Set(["provider_wait", "provider_retry", "provider_stalled"]);
const OPTIMISTIC_ASSISTANT_PROGRESS = "正在启动Hermes Agent内核...";

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
  const existingText = textFromParts(parts);
  const last = parts[parts.length - 1];

  if (!existingText) return appendTextPart(parts, finalText);
  if (existingText === finalText) return parts;
  if (finalText.startsWith(existingText)) {
    return appendTextPart(parts, finalText.slice(existingText.length));
  }
  if (last?.type === "text" && last.text.endsWith(finalText)) return parts;
  return appendTextPart(parts, finalText);
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
  const finalText = typeof payload.text === "string" ? payload.text : textFromParts(parts);
  const finalReasoning = normalizeReasoningText(
    typeof payload.reasoning === "string" ? payload.reasoning : reasoningFromParts(parts),
  );

  parts = mergeFinalTextPart(parts, finalText);
  if (finalReasoning) {
    parts = upsertReasoningPart(parts, finalReasoning);
  }

  return parts;
}

export function reduceGatewayEvent(
  runtime: ChatSessionRuntime,
  event: GatewayEvent,
  now = Date.now(),
): ChatSessionRuntime {
  const payload = payloadOf(event);
  const sessionId = sessionIdFor(runtime, event);

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
          parts: appendTextPart(message.parts, text),
        }),
      );
      return next;
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

    case "tool.progress": {
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
          parts: updateToolParts(message.parts, payload, (tool) => ({
            ...tool,
            preview: typeof payload.preview === "string" ? payload.preview : tool.preview,
          })),
        }),
      );
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
      return {
        ...runtime,
        statusMessage: typeof payload.text === "string" ? payload.text : runtime.statusMessage,
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
  (_get, set, params: { sessionId: string; text: string; now?: number }) => {
    const now = params.now ?? Date.now();
    const assistantId = assistantClientId(now);
    set(gwSessionIdAtom, params.sessionId);
    set(chatRuntimeBySessionAtom, (state) =>
      updateSessionRuntime(state, params.sessionId, (runtime) => ({
        ...resetStream(runtime, now),
        messages: [
          ...runtime.messages,
          {
            id: userClientId(now),
            sessionId: params.sessionId,
            role: "user",
            createdAt: now,
            status: "complete",
            parts: [{ type: "text", text: params.text }],
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

function textForStatsHash(message: HermesUIMessage): string {
  return message.parts
    .flatMap((part) => {
      if (part.type === "text" || part.type === "reasoning") return [part.text];
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

export const applyGatewayEventAtom = atom(null, (_get, set, event: GatewayEvent) => {
  if (!event.session_id) return;
  set(chatRuntimeBySessionAtom, (state) =>
    updateSessionRuntime(state, event.session_id!, (runtime) => {
      const next = reduceGatewayEvent(runtime, event);
      persistCompletedTurnStats(next, event);
      return next;
    }),
  );
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
