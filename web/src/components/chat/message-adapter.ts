import type {
  GatewayEvent,
  HermesMessageMetadata,
  HermesMessagePart,
  HermesUIMessage,
  MessagesResponse,
  SessionMessage,
} from "@hermes/protocol";
import {
  normalizeCliThinkingProgress,
  normalizeReasoningText,
} from "@/lib/reasoning-filter";
import { stripHermesUiWorkspaceContext } from "@/lib/composer-prompt";
import { stableTextHash, type UiTurnStats } from "@/lib/ui-store";
import type { AssistantTurnBlock } from "@/stores/chat";
import type { AssistantMessageStats, ChatMessage, ChatToolItem } from "./chat-types";

type HermesToolPart = Extract<HermesMessagePart, { type: "tool" }>;

export interface HermesUIMessageUpdate {
  sessionId: string;
  eventType: GatewayEvent["type"];
  messageId?: string;
  toolCallId?: string;
}

export function gatewayEventToHermesUIMessageUpdate(event: GatewayEvent): HermesUIMessageUpdate | null {
  if (!event.session_id) return null;
  const payload = event.payload && typeof event.payload === "object"
    ? event.payload as Record<string, unknown>
    : {};
  const messageId = typeof payload.message_id === "string" ? payload.message_id : undefined;
  const toolCallId = typeof payload.tool_id === "string" ? payload.tool_id : undefined;
  return {
    sessionId: event.session_id,
    eventType: event.type,
    messageId,
    toolCallId,
  };
}

function normalizeContent(value: string | null | undefined): string | undefined {
  const text = stripHermesUiWorkspaceContext(value);
  return text ? text : undefined;
}

function displayUnknown(value: unknown): string | undefined {
  if (typeof value === "string") return normalizeContent(value);
  if (value == null) return undefined;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function normalizeAssistantBlocks(
  blocks: AssistantTurnBlock[] | undefined,
  options: { includeProgress?: boolean } = {},
): AssistantTurnBlock[] | undefined {
  if (!blocks?.length) return undefined;

  const normalized: AssistantTurnBlock[] = [];
  for (const block of blocks) {
    if (block.type === "progress") {
      if (options.includeProgress) normalized.push(block);
      continue;
    }

    if (block.type !== "reasoning") {
      normalized.push(block);
      continue;
    }

    const progress = normalizeContent(normalizeCliThinkingProgress(block.text));
    if (progress && options.includeProgress) {
      normalized.push({ type: "progress", text: progress });
      continue;
    }

    const text = normalizeContent(normalizeReasoningText(block.text));
    if (text) normalized.push({ type: "reasoning", text });
  }

  return normalized.length ? normalized : undefined;
}

function summarizeArgs(args: Record<string, unknown>): string | undefined {
  const preferredKeys = ["context", "command", "cmd", "path", "file", "query", "url"];
  for (const key of preferredKeys) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }

  const first = Object.entries(args).find(([, value]) => {
    return typeof value === "string" || typeof value === "number";
  });
  if (!first) return undefined;
  return `${first[0]}=${String(first[1])}`;
}

function parseToolInput(value: unknown): {
  context?: string;
  arguments?: Record<string, unknown>;
} {
  if (typeof value === "string") return { context: value };
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const args = value as Record<string, unknown>;
  return {
    context: summarizeArgs(args),
    arguments: args,
  };
}

function parseToolCalls(value: unknown, startedAt: number): HermesToolPart[] {
  if (!Array.isArray(value)) return [];

  return value.map((call, index) => {
    const fn = call?.function ?? {};
    let args: Record<string, unknown> | undefined;
    if (typeof fn.arguments === "string") {
      try {
        const parsed = JSON.parse(fn.arguments);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          args = parsed as Record<string, unknown>;
        }
      } catch {
        args = { raw: fn.arguments };
      }
    } else if (fn.arguments && typeof fn.arguments === "object") {
      args = fn.arguments as Record<string, unknown>;
    }

    return {
      type: "tool",
      toolCallId: String(call?.id ?? `tool-call-${index}`),
      name: String(fn.name ?? call?.name ?? "tool"),
      state: "running",
      input: args,
      startedAt,
    };
  });
}

function legacyMetadata(msg: SessionMessage): HermesMessageMetadata | undefined {
  const metadata: HermesMessageMetadata = {
    persistedId: msg.id,
  };
  if (typeof msg.finish_reason === "string" && msg.finish_reason) {
    metadata.finishReason = msg.finish_reason;
  }
  if (typeof msg.token_count === "number") {
    metadata.usage = { tokensTotal: msg.token_count };
  }
  return metadata;
}

// Roles we know how to render. Hermes integrations (Feishu bridge etc.)
// emit extra marker roles like "session_meta" into the persisted log —
// the response schema accepts arbitrary strings so the row doesn't
// blank the whole history, but we drop them here cleanly.
const RENDERABLE_LEGACY_ROLES = new Set(["user", "assistant", "system", "tool"]);

export function legacySessionMessageToHermesUIMessage(msg: SessionMessage): HermesUIMessage | null {
  const createdAt = msg.timestamp ? msg.timestamp * 1000 : Date.now();

  if (!RENDERABLE_LEGACY_ROLES.has(msg.role)) return null;

  if (msg.role === "tool") {
    return {
      id: `stored-tool-${msg.id}`,
      sessionId: msg.session_id,
      role: "assistant",
      createdAt,
      status: msg.finish_reason === "error" ? "error" : "complete",
      parts: [
        {
          type: "tool",
          toolCallId: msg.tool_call_id ?? `stored-tool-${msg.id}`,
          name: msg.tool_name ?? "tool",
          state: msg.finish_reason === "error" ? "error" : "done",
          output: normalizeContent(msg.content),
          startedAt: createdAt,
          completedAt: createdAt,
        },
      ],
      metadata: legacyMetadata(msg),
    };
  }

  const text = normalizeContent(msg.content);
  const reasoning = normalizeContent(
    normalizeReasoningText(msg.reasoning_content ?? msg.reasoning ?? undefined),
  );
  const tools = parseToolCalls(msg.tool_calls, createdAt);
  const parts: HermesMessagePart[] = [];
  if (text) parts.push({ type: "text", text });
  if (reasoning) parts.push({ type: "reasoning", text: reasoning });
  tools.forEach((tool) => parts.push(tool));

  if (!parts.length) return null;

  // role was narrowed by RENDERABLE_LEGACY_ROLES + the "tool" early-return
  // above; the remaining values are exactly user/assistant/system.
  return {
    id: `stored-${msg.id}`,
    sessionId: msg.session_id,
    role: msg.role as "user" | "assistant" | "system",
    createdAt,
    status: msg.finish_reason === "error" ? "error" : "complete",
    parts,
    metadata: legacyMetadata(msg),
  };
}

function mergeParts(currentParts: HermesMessagePart[], incomingParts: HermesMessagePart[]): HermesMessagePart[] {
  const parts = [...currentParts];

  for (const part of incomingParts) {
    const last = parts[parts.length - 1];
    if (part.type === "text" && last?.type === "text") {
      parts[parts.length - 1] = { ...last, text: `${last.text}\n\n${part.text}` };
      continue;
    }
    if (part.type === "reasoning" && last?.type === "reasoning") {
      parts[parts.length - 1] = { ...last, text: `${last.text}\n\n${part.text}` };
      continue;
    }
    parts.push(part);
  }

  return parts;
}

function mergeAssistantMessages(current: HermesUIMessage, incoming: HermesUIMessage): HermesUIMessage {
  return {
    ...current,
    status: current.status === "error" || incoming.status === "error" ? "error" : current.status,
    parts: mergeParts(current.parts, incoming.parts),
    metadata: {
      ...current.metadata,
      ...incoming.metadata,
      persistedId: current.metadata?.persistedId ?? incoming.metadata?.persistedId,
    },
  };
}

function mergeToolResult(messages: HermesUIMessage[], msg: SessionMessage): boolean {
  const completedAt = msg.timestamp ? msg.timestamp * 1000 : Date.now();
  const output = normalizeContent(msg.content);

  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex];
    if (message.role !== "assistant" || !message.parts.length) continue;

    const toolIndex = message.parts.findIndex((part) => {
      if (part.type !== "tool") return false;
      if (msg.tool_call_id) return part.toolCallId === msg.tool_call_id;
      if (msg.tool_name) return part.state === "running" && part.name === msg.tool_name;
      return part.state === "running";
    });
    if (toolIndex === -1) continue;

    const parts = [...message.parts];
    const part = parts[toolIndex];
    if (part.type !== "tool") return false;
    const safeCompletedAt = Math.max(completedAt, part.startedAt ?? completedAt);
    parts[toolIndex] = {
      ...part,
      name: msg.tool_name ?? part.name,
      state: msg.finish_reason === "error" ? "error" : "done",
      output: output ?? part.output,
      completedAt: safeCompletedAt,
    };
    messages[messageIndex] = {
      ...message,
      parts,
      status: msg.finish_reason === "error" ? "error" : message.status,
    };
    return true;
  }

  return false;
}

export function legacySessionMessagesToHermesUIMessages(messages: SessionMessage[]): HermesUIMessage[] {
  const result: HermesUIMessage[] = [];

  for (const msg of messages) {
    if (msg.role === "tool") {
      if (mergeToolResult(result, msg)) continue;
      const fallback = legacySessionMessageToHermesUIMessage(msg);
      if (fallback) result.push(fallback);
      continue;
    }

    const next = legacySessionMessageToHermesUIMessage(msg);
    if (!next) continue;

    const last = result[result.length - 1];
    if (next.role === "assistant" && last?.role === "assistant") {
      result[result.length - 1] = mergeAssistantMessages(last, next);
    } else {
      result.push(next);
    }
  }

  return result;
}

export function messagesResponseToHermesUIMessages(response: MessagesResponse | undefined): HermesUIMessage[] {
  if (!response) return [];
  if (response.ui_messages) return response.ui_messages;
  return legacySessionMessagesToHermesUIMessages(response.messages);
}

function toolPartToToolEntry(part: HermesToolPart, message: HermesUIMessage): ChatToolItem {
  const input = parseToolInput(part.input);
  return {
    tool_id: part.toolCallId,
    name: part.name,
    status: part.state,
    context: input.context,
    preview: part.preview,
    summary: displayUnknown(part.output),
    error: part.errorText,
    startedAt: part.startedAt ?? message.createdAt,
    completedAt: part.completedAt,
    arguments: input.arguments,
  };
}

function partsToBlocks(
  message: HermesUIMessage,
  options: { includeProgress?: boolean } = {},
): AssistantTurnBlock[] | undefined {
  const blocks: AssistantTurnBlock[] = [];
  for (const part of message.parts) {
    if (part.type === "text") {
      const text = normalizeContent(part.text);
      if (text) blocks.push({ type: "text", text });
      continue;
    }
    if (part.type === "reasoning") {
      const text = normalizeContent(part.text);
      if (text) blocks.push({ type: "reasoning", text });
      continue;
    }
    if (part.type === "progress") {
      if (options.includeProgress) blocks.push({ type: "progress", text: part.text });
      continue;
    }
    if (part.type === "tool") {
      blocks.push({ type: "tool", tool: toolPartToToolEntry(part, message) });
    }
  }

  return normalizeAssistantBlocks(blocks, options);
}

function textFromParts(parts: HermesMessagePart[]): string | undefined {
  const text = parts
    .filter((part): part is Extract<HermesMessagePart, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("");
  return normalizeContent(text);
}

function reasoningFromParts(parts: HermesMessagePart[]): string | undefined {
  const reasoning = parts
    .filter((part): part is Extract<HermesMessagePart, { type: "reasoning" }> => part.type === "reasoning")
    .map((part) => part.text)
    .join("");
  return normalizeContent(normalizeReasoningText(reasoning));
}

function noticeTextFromParts(parts: HermesMessagePart[]): string | undefined {
  const text = parts
    .filter((part): part is Extract<HermesMessagePart, { type: "notice" }> => part.type === "notice")
    .map((part) => part.text)
    .join("\n\n");
  return normalizeContent(text);
}

function messageHasErrorNotice(message: HermesUIMessage): boolean {
  return message.parts.some((part) => part.type === "notice" && part.level === "error");
}

function statsHashFromMessage(message: HermesUIMessage): string | undefined {
  const toolText = message.parts
    .filter((part): part is HermesToolPart => part.type === "tool")
    .map((tool) => `${tool.name}\n${displayUnknown(tool.output) ?? ""}`)
    .join("\n");
  return stableTextHash([
    textFromParts(message.parts),
    reasoningFromParts(message.parts),
    toolText,
  ].filter(Boolean).join("\n"));
}

function metadataFromTurnStats(stat: UiTurnStats): HermesMessageMetadata | undefined {
  if (stat.metadata) return stat.metadata;
  const metadata: HermesMessageMetadata = {};
  const usage: NonNullable<HermesMessageMetadata["usage"]> = {};
  const timing: NonNullable<HermesMessageMetadata["timing"]> = {};

  if (typeof stat.tokensInput === "number") usage.tokensInput = stat.tokensInput;
  if (typeof stat.tokensOutput === "number") usage.tokensOutput = stat.tokensOutput;
  if (typeof stat.tokensTotal === "number") usage.tokensTotal = stat.tokensTotal;
  if (typeof stat.cacheRead === "number") usage.cacheRead = stat.cacheRead;
  if (typeof stat.cacheWrite === "number") usage.cacheWrite = stat.cacheWrite;
  if (typeof stat.apiCalls === "number") usage.apiCalls = stat.apiCalls;
  if (typeof stat.contextUsed === "number") usage.contextUsed = stat.contextUsed;
  if (typeof stat.contextMax === "number") usage.contextMax = stat.contextMax;

  if (typeof stat.startedAt === "number") timing.startedAt = stat.startedAt;
  if (typeof stat.firstTokenAt === "number") timing.firstTokenAt = stat.firstTokenAt;
  if (typeof stat.completedAt === "number") timing.completedAt = stat.completedAt;
  if (typeof stat.ttftMs === "number") timing.ttftMs = stat.ttftMs;
  if (typeof stat.durationMs === "number") timing.durationMs = stat.durationMs;

  if (Object.keys(usage).length > 0) metadata.usage = usage;
  if (Object.keys(timing).length > 0) metadata.timing = timing;
  if (stat.model) metadata.model = stat.model;
  if (stat.finishReason) metadata.finishReason = stat.finishReason;
  if (typeof stat.costUsd === "number") metadata.costUsd = stat.costUsd;
  if (stat.costStatus) metadata.costStatus = stat.costStatus;

  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

export function attachTurnStatsMetadata(
  messages: HermesUIMessage[],
  stats: UiTurnStats[],
): HermesUIMessage[] {
  if (stats.length === 0) return messages;

  const used = new Set<number>();
  let assistantIndex = 0;
  return messages.map((message) => {
    if (message.role !== "assistant") return message;
    assistantIndex += 1;
    const hash = statsHashFromMessage(message);
    let statIndex = stats.findIndex((stat, index) =>
      !used.has(index) && Boolean(hash) && stat.contentHash === hash,
    );
    if (statIndex === -1) {
      statIndex = stats.findIndex((stat, index) =>
        !used.has(index) && stat.turnIndex === assistantIndex,
      );
    }
    if (statIndex === -1) return message;
    const metadata = metadataFromTurnStats(stats[statIndex]!);
    if (!metadata) return message;
    used.add(statIndex);
    return {
      ...message,
      metadata: {
        ...message.metadata,
        ...metadata,
        persistedId: message.metadata?.persistedId ?? metadata.persistedId,
      },
    };
  });
}

export function deriveAssistantStats(msg: HermesUIMessage): AssistantMessageStats | undefined {
  if (msg.role !== "assistant") return undefined;

  const usage = msg.metadata?.usage;
  const timing = msg.metadata?.timing;
  const stats: AssistantMessageStats = {};

  if (typeof timing?.ttftMs === "number") {
    stats.ttftMs = timing.ttftMs;
  } else if (
    typeof timing?.startedAt === "number" &&
    typeof timing?.firstTokenAt === "number" &&
    timing.firstTokenAt >= timing.startedAt
  ) {
    stats.ttftMs = timing.firstTokenAt - timing.startedAt;
  }

  if (typeof timing?.durationMs === "number") {
    stats.durationMs = timing.durationMs;
  } else if (
    typeof timing?.startedAt === "number" &&
    typeof timing?.completedAt === "number" &&
    timing.completedAt > timing.startedAt
  ) {
    stats.durationMs = timing.completedAt - timing.startedAt;
  }

  if (usage) {
    if (typeof usage.tokensTotal === "number") stats.tokensTotal = usage.tokensTotal;
    if (typeof usage.tokensInput === "number") stats.tokensInput = usage.tokensInput;
    if (typeof usage.tokensOutput === "number") stats.tokensOutput = usage.tokensOutput;
    if (typeof usage.tokensCompletion === "number") stats.tokensCompletion = usage.tokensCompletion;
    if (typeof usage.cacheRead === "number") stats.cacheRead = usage.cacheRead;
    if (typeof usage.cacheWrite === "number") stats.cacheWrite = usage.cacheWrite;
    if (typeof usage.apiCalls === "number") stats.apiCalls = usage.apiCalls;
  }

  if (typeof msg.metadata?.model === "string" && msg.metadata.model) {
    stats.model = msg.metadata.model;
  }
  if (typeof msg.metadata?.finishReason === "string") {
    stats.finishReason = msg.metadata.finishReason;
  }

  const costStatus = typeof msg.metadata?.costStatus === "string"
    ? msg.metadata.costStatus.toLowerCase()
    : undefined;
  if (
    typeof msg.metadata?.costUsd === "number" &&
    Number.isFinite(msg.metadata.costUsd) &&
    costStatus !== "stale_pricing" &&
    costStatus !== "unknown"
  ) {
    stats.costUsd = msg.metadata.costUsd;
  }

  const outputForRate = stats.tokensOutput ?? stats.tokensCompletion ?? undefined;
  if (
    typeof outputForRate === "number" &&
    outputForRate > 0 &&
    typeof stats.durationMs === "number" &&
    stats.durationMs > 0
  ) {
    stats.tokPerSec = outputForRate / (stats.durationMs / 1000);
  }

  const hasAny =
    stats.ttftMs !== undefined ||
    stats.durationMs !== undefined ||
    stats.tokensTotal !== undefined ||
    stats.tokensInput !== undefined ||
    stats.tokensOutput !== undefined ||
    stats.cacheRead !== undefined ||
    stats.apiCalls !== undefined ||
    stats.model !== undefined ||
    stats.costUsd !== undefined;

  return hasAny ? stats : undefined;
}

export function hermesUIMessageToChatMessage(msg: HermesUIMessage): ChatMessage | null {
  const includeProgress = msg.status === "streaming";
  const text = msg.role === "system"
    ? noticeTextFromParts(msg.parts) ?? textFromParts(msg.parts)
    : textFromParts(msg.parts);
  const reasoning = reasoningFromParts(msg.parts);
  const blocks = msg.role === "assistant"
    ? partsToBlocks(msg, { includeProgress })
    : undefined;
  const tools = blocks
    ?.filter((block): block is Extract<AssistantTurnBlock, { type: "tool" }> => block.type === "tool")
    .map((block) => block.tool);

  if (!text && !reasoning && !tools?.length && !blocks?.length) return null;

  return {
    id: msg.id,
    role: msg.role,
    createdAt: msg.createdAt,
    text,
    reasoning,
    tools: tools?.length ? tools : undefined,
    blocks,
    status: msg.status,
    error: msg.status === "error" || messageHasErrorNotice(msg),
    stats: deriveAssistantStats(msg),
  };
}

export function hermesUIMessagesToChatMessages(messages: HermesUIMessage[]): ChatMessage[] {
  return messages
    .map(hermesUIMessageToChatMessage)
    .filter((message): message is ChatMessage => message !== null);
}

function comparableText(value: string | undefined): string {
  // Strip ALL whitespace (not just collapse) for canonical dedup
  // comparison. The two paths that produce assistant message text have
  // subtly different separators: `legacySessionMessagesToHermesUIMessages`
  // builds text parts that are non-adjacent (tools between turns) and
  // `textFromParts` joins them with `""`; the live SSE path can leave
  // adjacent text parts that `mergeParts` folds with `\n\n`. After
  // collapsing `\s+ -> " "` you still have a one-space gap on the live
  // side but a no-space seam on the stored side — `===` fails and the
  // dedup miss renders the same assistant twice. Removing whitespace
  // entirely makes both paths converge. See issue #11.
  return (value ?? "").replace(/\s+/g, "");
}

function looseComparableText(value: string | undefined): string {
  return comparableText(value)
    .replace(/[*_`~]/g, "")
    .replace(/[，。！？、：；,.!?:;"'“”‘’（）()[\]{}<>《》\-—–]/g, "")
    .toLowerCase();
}

function canonicalText(message: HermesUIMessage): string {
  return comparableText(normalizeContent(textFromParts(message.parts) ?? noticeTextFromParts(message.parts)));
}

function canonicalReasoning(message: HermesUIMessage): string {
  return comparableText(reasoningFromParts(message.parts));
}

function canonicalToolComparable(message: HermesUIMessage): string {
  return message.parts
    .filter((part): part is HermesToolPart => part.type === "tool")
    .map((tool) =>
      [
        tool.toolCallId,
        tool.name,
        tool.state,
        comparableText(parseToolInput(tool.input).context),
        comparableText(displayUnknown(tool.output)),
        comparableText(tool.errorText),
      ].join(":"),
    )
    .join("|");
}

function hasSamePersistedId(stored: HermesUIMessage, live: HermesUIMessage): boolean {
  const storedPersisted = stored.metadata?.persistedId;
  const livePersisted = live.metadata?.persistedId;
  return storedPersisted !== undefined && livePersisted !== undefined && storedPersisted === livePersisted;
}

function isSameCanonicalMessage(stored: HermesUIMessage, live: HermesUIMessage): boolean {
  if (stored.id === live.id || hasSamePersistedId(stored, live)) return true;
  if (stored.role !== live.role) return false;

  const storedText = canonicalText(stored);
  const liveText = canonicalText(live);
  const storedReasoning = canonicalReasoning(stored);
  const liveReasoning = canonicalReasoning(live);

  if (stored.role === "assistant") {
    if (storedText || liveText) {
      if (storedText === liveText) return true;

      const storedLooseText = looseComparableText(storedText);
      const liveLooseText = looseComparableText(liveText);
      if (storedLooseText && liveLooseText && storedLooseText === liveLooseText) {
        return true;
      }

      if (
        stored.status === "complete" &&
        live.status === "streaming" &&
        storedLooseText &&
        liveLooseText.length >= 4 &&
        storedLooseText.includes(liveLooseText)
      ) {
        return true;
      }

      return false;
    }
    return canonicalToolComparable(stored) !== "" &&
      canonicalToolComparable(stored) === canonicalToolComparable(live);
  }

  return storedText === liveText && storedReasoning === liveReasoning;
}

function consolidateAssistantMessages(messages: HermesUIMessage[]): HermesUIMessage[] {
  const result: HermesUIMessage[] = [];
  for (const msg of messages) {
    const last = result[result.length - 1];
    if (msg.role === "assistant" && last?.role === "assistant") {
      result[result.length - 1] = {
        ...last,
        status: msg.status === "error" || last.status === "error" ? "error" : msg.status,
        parts: mergeParts(last.parts, msg.parts),
        metadata: {
          ...last.metadata,
          ...msg.metadata,
          persistedId: last.metadata?.persistedId ?? msg.metadata?.persistedId,
        },
      };
    } else {
      result.push(msg);
    }
  }
  return result;
}

export function mergeHermesUIMessages(
  stored: HermesUIMessage[],
  live: HermesUIMessage[],
): HermesUIMessage[] {
  if (live.length === 0) return stored;
  if (stored.length === 0) return live;

  const consolidatedLive = consolidateAssistantMessages(live);

  const usedLiveIndexes = new Set<number>();
  const merged: HermesUIMessage[] = [];

  for (const storedMessage of stored) {
    const liveIndex = consolidatedLive.findIndex(
      (liveMessage, index) =>
        !usedLiveIndexes.has(index) && isSameCanonicalMessage(storedMessage, liveMessage),
    );

    if (liveIndex === -1) {
      merged.push(storedMessage);
      continue;
    }

    usedLiveIndexes.add(liveIndex);
    const liveMessage = consolidatedLive[liveIndex]!;
    merged.push(
      storedMessage.role === "assistant" &&
        storedMessage.status === "complete" &&
        liveMessage.status === "streaming"
        ? storedMessage
        : liveMessage,
    );
  }

  consolidatedLive.forEach((liveMessage, index) => {
    if (!usedLiveIndexes.has(index)) merged.push(liveMessage);
  });

  return merged;
}

export function storedMessageToChatMessage(msg: SessionMessage): ChatMessage | null {
  const canonical = legacySessionMessageToHermesUIMessage(msg);
  return canonical ? hermesUIMessageToChatMessage(canonical) : null;
}

export function storedMessagesToChatMessages(messages: SessionMessage[]): ChatMessage[] {
  return hermesUIMessagesToChatMessages(legacySessionMessagesToHermesUIMessages(messages));
}
