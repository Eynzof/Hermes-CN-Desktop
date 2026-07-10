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
import {
  dedupeImageParts,
  extractImagePartsFromUnknown,
  imagePartFromSource,
} from "@/lib/message-images";
import { stableTextHash, type UiTurnStats } from "@/lib/ui-store";
import type { AssistantTurnBlock } from "@/stores/chat";
import type { AssistantMessageStats, ChatImageItem, ChatMessage, ChatToolItem } from "./chat-types";

type HermesToolPart = Extract<HermesMessagePart, { type: "tool" }>;
type HermesImagePart = Extract<HermesMessagePart, { type: "image" }>;

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

const HERMES_UI_IMAGE_BLOCK_RE = /\[Hermes UI Image\]\nname=([^\n]*)\ndescription:\n([\s\S]*?)\n\[\/Hermes UI Image\]/g;
const IMAGE_FALLBACK_RE = /\[You can examine it with vision_analyze using image_url: ([^\]\n]+)\]/g;

function parseJsonContent(value: string | null | undefined): unknown | undefined {
  const text = value?.trim();
  if (!text || !/^[{[]/.test(text)) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function imagePartToEntry(part: HermesImagePart): ChatImageItem {
  const record = part as Record<string, unknown>;
  const url =
    part.url ||
    part.src ||
    part.path ||
    part.data ||
    (typeof record.image_url === "string" ? record.image_url : undefined) ||
    (record.image_url && typeof record.image_url === "object"
      ? (record.image_url as Record<string, unknown>).url
      : undefined);
  const name = part.name || part.filename || part.file_name || (typeof url === "string" && !url.startsWith("data:")
    ? url.replace(/\\/g, "/").split("/").pop()
    : undefined);
  return {
    ...(typeof url === "string" && url ? { url } : {}),
    ...(part.alt || name ? { alt: part.alt || name } : {}),
    ...(part.title ? { title: part.title } : {}),
    ...(name ? { name } : {}),
    ...(part.mimeType || part.mime_type || part.mediaType || part.contentType || part.content_type
      ? { mimeType: part.mimeType || part.mime_type || part.mediaType || part.contentType || part.content_type }
      : {}),
  };
}

function imagePartsFromMessageImages(images: SessionMessage["images"]): HermesImagePart[] {
  if (!images?.length) return [];
  return dedupeImageParts(images.flatMap((image, index) => {
    const part = imagePartFromSource(image, `image-${index + 1}`);
    return part ? [part] : [];
  }));
}

function imagePartsFromTransportText(text: string | null | undefined): HermesImagePart[] {
  if (!text) return [];
  const parts: HermesImagePart[] = [];

  for (const match of text.matchAll(IMAGE_FALLBACK_RE)) {
    const path = match[1]?.trim();
    if (!path) continue;
    const part = imagePartFromSource(path);
    if (part) parts.push(part);
  }

  for (const match of text.matchAll(HERMES_UI_IMAGE_BLOCK_RE)) {
    const name = match[1]?.trim();
    const description = match[2]?.trim();
    const extracted = extractImagePartsFromUnknown(description);
    if (extracted.length) {
      parts.push(...extracted.map((part) => ({
        ...part,
        ...(name ? { name, alt: part.alt || name } : {}),
      })));
      continue;
    }
    const part = imagePartFromSource({ name, alt: name || "图片附件" });
    if (part) parts.push(part);
  }

  return dedupeImageParts(parts);
}

function textAndImagesFromStructuredContent(content: string | null | undefined): {
  text?: string;
  images: HermesImagePart[];
} {
  const parsed = parseJsonContent(content);
  if (parsed === undefined) {
    return {
      text: content ?? undefined,
      images: imagePartsFromTransportText(content),
    };
  }

  const textParts: string[] = [];
  const imageParts: HermesImagePart[] = [];
  const visit = (value: unknown) => {
    if (typeof value === "string") {
      textParts.push(value);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (typeof record.text === "string") textParts.push(record.text);
    if (typeof record.content === "string" && record.type === "text") textParts.push(record.content);
    const direct = imagePartFromSource(record);
    if (direct && (
      record.type === "image" ||
      record.type === "image_url" ||
      record.type === "input_image" ||
      record.type === "output_image" ||
      record.is_image === true
    )) {
      imageParts.push(direct);
    } else {
      imageParts.push(...extractImagePartsFromUnknown(record));
    }
  };

  visit(parsed);
  const images = dedupeImageParts([
    ...imageParts,
    ...imagePartsFromTransportText(content),
  ]);
  if (!textParts.length && !images.length) return { text: content ?? undefined, images: [] };
  return {
    text: textParts.join("\n").trim() || undefined,
    images,
  };
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

// 服务端会话历史（SessionMessage）只持久化 token_count / finish_reason，
// 没有任何 timing 字段（startedAt / firstTokenAt / model 都没有）——所以
// 纯历史回放的消息最多只能在统计栏显示 tokens，TTFT/耗时只能靠本机
// ui-store 的回合统计补回（attachTurnStatsMetadata）。非本机流式过的会话
// （IM 通道、其他设备、旧版本产生的）这些数据不存在，也无从推算；彻底
// 解决需要 Core 侧把 timing 元数据写进会话历史（候选新 P-NNN 补丁）。
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

const PROCESS_NOTIFICATION_RE = /^\[IMPORTANT: Background process\s+([\s\S]*?)\]$/;
const ANSI_RE = /\x1b\[[0-9;]*m/g;

function normalizeProcessNotificationText(text: string): string | null {
  const clean = text.replace(ANSI_RE, "").trim();
  const match = clean.match(PROCESS_NOTIFICATION_RE);
  if (!match) return null;
  return `后台进程通知：${match[1]}`;
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

  const content = textAndImagesFromStructuredContent(msg.content);
  const text = normalizeContent(content.text);
  const processNotificationText = msg.role === "user"
    ? normalizeProcessNotificationText(text ?? "")
    : null;
  const reasoning = normalizeContent(
    normalizeReasoningText(msg.reasoning_content ?? msg.reasoning ?? undefined),
  );
  const tools = parseToolCalls(msg.tool_calls, createdAt);
  const parts: HermesMessagePart[] = [];
  if (text) parts.push({ type: "text", text });
  parts.push(...dedupeImageParts([
    ...content.images,
    ...imagePartsFromMessageImages(msg.images),
  ]));
  if (reasoning) parts.push({ type: "reasoning", text: reasoning });
  tools.forEach((tool) => parts.push(tool));

  if (!parts.length) return null;

  // role was narrowed by RENDERABLE_LEGACY_ROLES + the "tool" early-return
  // above; the remaining values are exactly user/assistant/system.
  return {
    id: `stored-${msg.id}`,
    sessionId: msg.session_id,
    role: processNotificationText ? "system" : msg.role as "user" | "assistant" | "system",
    createdAt,
    status: msg.finish_reason === "error" ? "error" : "complete",
    parts: processNotificationText ? [{ type: "notice", level: "system", text: processNotificationText }] : parts,
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
    metadata: mergeMessageMetadata(current.metadata, incoming.metadata, {
      persistedId: current.metadata?.persistedId ?? incoming.metadata?.persistedId,
    }),
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
  const images = extractImagePartsFromUnknown(part.output).map(imagePartToEntry);
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
    images: images.length ? images : undefined,
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
    if (part.type === "image") {
      blocks.push({ type: "image", image: imagePartToEntry(part) });
      continue;
    }
    if (part.type === "moa_reference") {
      const text = normalizeContent(part.text);
      if (text) {
        blocks.push({
          type: "moa_reference",
          label: part.label,
          text,
          index: part.index,
          count: part.count,
        });
      }
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

function imagesFromParts(parts: HermesMessagePart[]): ChatImageItem[] | undefined {
  const images = parts
    .filter((part): part is HermesImagePart => part.type === "image")
    .map(imagePartToEntry);
  return images.length ? images : undefined;
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
    imagesFromParts(message.parts)
      ?.map((image) => [image.url, image.name, image.alt].filter(Boolean).join(" "))
      .join("\n"),
    toolText,
  ].filter(Boolean).join("\n"));
}

function metadataFromTurnStats(stat: UiTurnStats): HermesMessageMetadata | undefined {
  const metadata: HermesMessageMetadata = { ...(stat.metadata ?? {}) };
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

  if (Object.keys(usage).length > 0) {
    metadata.usage = { ...metadata.usage, ...usage };
  }
  if (Object.keys(timing).length > 0) {
    metadata.timing = { ...metadata.timing, ...timing };
  }
  if (!metadata.model && stat.model) metadata.model = stat.model;
  if (!metadata.finishReason && stat.finishReason) metadata.finishReason = stat.finishReason;
  if (metadata.costUsd === undefined && typeof stat.costUsd === "number") metadata.costUsd = stat.costUsd;
  if (!metadata.costStatus && stat.costStatus) metadata.costStatus = stat.costStatus;

  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function mergeMessageMetadata(
  base: HermesMessageMetadata | undefined,
  override: HermesMessageMetadata | undefined,
  forced?: Partial<HermesMessageMetadata>,
): HermesMessageMetadata | undefined {
  if (!base && !override && !forced) return undefined;
  const metadata: HermesMessageMetadata = {
    ...(base ?? {}),
    ...(override ?? {}),
    ...(forced ?? {}),
  };
  if (base?.usage || override?.usage) {
    metadata.usage = {
      ...(base?.usage ?? {}),
      ...(override?.usage ?? {}),
    };
  }
  if (base?.timing || override?.timing) {
    metadata.timing = {
      ...(base?.timing ?? {}),
      ...(override?.timing ?? {}),
    };
  }
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

export function attachTurnStatsMetadata(
  messages: HermesUIMessage[],
  stats: UiTurnStats[],
): HermesUIMessage[] {
  if (stats.length === 0) return messages;

  // 两遍匹配：第一遍让所有 contentHash 精确命中先占住统计，第二遍才用
  // turnIndex 给未命中的消息兜底。单遍"逐条 hash→index 回退"会让靠前消息
  // 的 index 兜底抢走本属于靠后消息的 hash 精确命中——历史合并重排后统计
  // 就贴错了消息（用户看到的"TTFT 时有时无"成因之一）。
  const used = new Set<number>();
  const statByMessage = new Map<number, number>();

  messages.forEach((message, messageIndex) => {
    if (message.role !== "assistant") return;
    const hash = statsHashFromMessage(message);
    if (!hash) return;
    const statIndex = stats.findIndex(
      (stat, index) => !used.has(index) && stat.contentHash === hash,
    );
    if (statIndex !== -1) {
      used.add(statIndex);
      statByMessage.set(messageIndex, statIndex);
    }
  });

  // turnIndex 兜底按"回合"计数：一个回合 = 一段连续的 assistant 消息（回合之间
  // 隔着 user 消息）。写入侧 turnIndex 是在 live 空间打的——那里整回合被合并成
  // 一条 assistant 消息——所以当后端把一个回合拆成多条 stored 行（ui_messages
  // 路径不做合并）时，该回合的 TTFT/tokens/成本要落到这段的**最后一条**（最终
  // 答复）行，而不是开场白行；逐条 assistant 序号兜底会把统计贴到开场白上。
  // contentHash 精确命中仍优先（上一遍已占住）。
  let turnOrdinal = 0;
  messages.forEach((message, messageIndex) => {
    if (message.role !== "assistant") return;
    if (messages[messageIndex - 1]?.role !== "assistant") turnOrdinal += 1;
    const endsTurn = messages[messageIndex + 1]?.role !== "assistant";
    if (!endsTurn || statByMessage.has(messageIndex)) return;
    const ordinal = turnOrdinal;
    const statIndex = stats.findIndex(
      (stat, index) => !used.has(index) && stat.turnIndex === ordinal,
    );
    if (statIndex !== -1) {
      used.add(statIndex);
      statByMessage.set(messageIndex, statIndex);
    }
  });

  return messages.map((message, messageIndex) => {
    const statIndex = statByMessage.get(messageIndex);
    if (statIndex === undefined) return message;
    const metadata = metadataFromTurnStats(stats[statIndex]!);
    if (!metadata) return message;
    return {
      ...message,
      metadata: mergeMessageMetadata(message.metadata, metadata, {
        persistedId: message.metadata?.persistedId ?? metadata.persistedId,
      }),
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
  const images = imagesFromParts(msg.parts);
  const blocks = msg.role === "assistant"
    ? partsToBlocks(msg, { includeProgress })
    : undefined;
  const tools = blocks
    ?.filter((block): block is Extract<AssistantTurnBlock, { type: "tool" }> => block.type === "tool")
    .map((block) => block.tool);

  if (!text && !reasoning && !images?.length && !tools?.length && !blocks?.length) return null;

  return {
    id: msg.id,
    role: msg.role,
    createdAt: msg.createdAt,
    text,
    reasoning,
    images,
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
  // `textFromParts` joins them with `""`; the live streaming path can leave
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

function canonicalImages(message: HermesUIMessage): string {
  return comparableText(
    imagesFromParts(message.parts)
      ?.map((image) => [image.url, image.name, image.alt].filter(Boolean).join(" "))
      .join("\n"),
  );
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

function canonicalToolIdentityComparable(message: HermesUIMessage): string {
  return message.parts
    .filter((part): part is HermesToolPart => part.type === "tool")
    .map((tool) => [tool.toolCallId, tool.name].join(":"))
    .join("|");
}

function hasInterruptedCompletion(message: HermesUIMessage, canonicalMessageText: string): boolean {
  if (message.metadata?.finishReason === "interrupted") return true;
  return canonicalMessageText.toLowerCase().includes("operationinterrupted:");
}

function isStaleInterruptedLiveMessage(
  live: HermesUIMessage,
  storedMessages: HermesUIMessage[],
): boolean {
  if (live.role !== "assistant") return false;
  if (!hasInterruptedCompletion(live, canonicalText(live))) return false;
  return storedMessages.some((stored) =>
    stored.role === "assistant" &&
    stored.createdAt >= live.createdAt &&
    !hasInterruptedCompletion(stored, canonicalText(stored)),
  );
}

// A reconnect / session.resume can re-stream a turn whose canonical copy is
// already persisted. Gateway events carry no stable turn id (see
// packages/protocol message.start/complete), so the reducer mints a fresh
// client id and a *duplicate* assistant bubble appears. While that replay is
// mid-stream it often has only tool calls and no text yet, so
// isSameCanonicalMessage (which needs a text match once the stored turn has
// text) can't match it, and isStaleInterruptedLiveMessage ignores it because a
// reconnect replay is not "interrupted" — that is the recurring duplicate.
//
// Drop it by matching tool-call IDENTITY (`toolCallId:name`) against a stored
// COMPLETE assistant turn it is a prefix of. toolCallId is a reliable replay
// discriminator: a replay re-sends the SAME tool ids, whereas a genuinely new
// turn mints new ones — so this won't drop a real follow-up turn. Mirrors how
// the official desktop lets the canonical stored turn win after completion.
function isReplayDuplicateLiveMessage(
  live: HermesUIMessage,
  storedMessages: HermesUIMessage[],
): boolean {
  if (live.role !== "assistant") return false;
  const liveTools = canonicalToolIdentityComparable(live);
  if (!liveTools) return false;
  const liveText = looseComparableText(canonicalText(live));
  return storedMessages.some((stored) => {
    if (stored.role !== "assistant" || stored.status !== "complete") return false;
    const storedTools = canonicalToolIdentityComparable(stored);
    if (!storedTools) return false;
    const toolsArePrefix = storedTools === liveTools || storedTools.startsWith(`${liveTools}|`);
    if (!toolsArePrefix) return false;
    // If the replay has already streamed some text, it must be a faithful
    // prefix of the stored canonical text — otherwise treat it as a genuinely
    // different turn and keep it.
    if (liveText) {
      const storedText = looseComparableText(canonicalText(stored));
      if (!storedText.startsWith(liveText)) return false;
    }
    return true;
  });
}

// A normally-completed agent turn is frequently persisted by the backend as
// SEVERAL assistant rows — leading commentary + a tool call, tool-only middle
// rows, then the final answer — whereas the live runtime consolidates the whole
// turn into ONE assistant message (a single `live-assistant-*` id). That single
// consolidated bubble's canonical text (commentary + final answer, concatenated)
// then exact-matches NEITHER the stored commentary row NOR the stored answer row,
// so isSameCanonicalMessage cannot merge it; it is not interrupted, and its tool
// identity spans the whole turn so it is not a prefix replay of any single stored
// row either. The un-matched live copy is appended, rendering the turn's text —
// including the final answer — a second time next to the stored rows.
//
// Recognize it: a COMPLETE, non-interrupted live assistant whose tool-call
// identity (`toolCallId:name`, backend-unique) is a contiguous run of the stored
// assistant rows' identities, and whose text is contained in those same rows'
// concatenated text, is already fully persisted — drop the live copy and let the
// canonical stored rows render (mirrors how completion lets the stored turn win).
function isSupersededByStoredTurn(
  live: HermesUIMessage,
  storedMessages: HermesUIMessage[],
): boolean {
  if (live.role !== "assistant" || live.status !== "complete") return false;
  // Only multi-step (tool-bearing) turns get split across rows; a plain-text
  // turn is one stored row and already dedupes via isSameCanonicalMessage.
  const liveTools = canonicalToolIdentityComparable(live);
  if (!liveTools) return false;
  // Interrupted replays are handled by isStaleInterruptedLiveMessage / superset.
  if (hasInterruptedCompletion(live, canonicalText(live))) return false;

  const storedAssistants = storedMessages.filter((message) => message.role === "assistant");
  const storedTools = storedAssistants
    .map((message) => canonicalToolIdentityComparable(message))
    .filter(Boolean)
    .join("|");
  // Every live tool call (unique ids) must already be persisted, in order.
  if (!storedTools.includes(liveTools)) return false;

  const liveText = looseComparableText(canonicalText(live));
  if (liveText) {
    const storedText = looseComparableText(
      storedAssistants.map((message) => canonicalText(message)).join(" "),
    );
    if (!storedText.includes(liveText)) return false;
  }
  return true;
}

function isInterruptedLiveSuperset(
  stored: HermesUIMessage,
  live: HermesUIMessage,
  storedText: string,
  liveText: string,
  storedImages: string,
  liveImages: string,
): boolean {
  if (!hasInterruptedCompletion(live, liveText)) return false;
  if ((storedImages || liveImages) && storedImages !== liveImages) return false;

  const storedTools = canonicalToolIdentityComparable(stored);
  const liveTools = canonicalToolIdentityComparable(live);
  if (!storedTools || storedTools !== liveTools) return false;

  if (!storedText) return true;
  return liveText.startsWith(storedText) && liveText.length > storedText.length;
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
  const storedImages = canonicalImages(stored);
  const liveImages = canonicalImages(live);

  if (stored.role === "assistant") {
    if (storedText || liveText) {
      if (storedText === liveText) return true;

      const storedLooseText = looseComparableText(storedText);
      const liveLooseText = looseComparableText(liveText);
      if (storedLooseText && liveLooseText && storedLooseText === liveLooseText) {
        return true;
      }

      if (isInterruptedLiveSuperset(stored, live, storedText, liveText, storedImages, liveImages)) {
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
    if (storedImages || liveImages) return storedImages === liveImages;
    return canonicalToolComparable(stored) !== "" &&
      canonicalToolComparable(stored) === canonicalToolComparable(live);
  }

  return storedText === liveText && storedReasoning === liveReasoning && storedImages === liveImages;
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
        metadata: mergeMessageMetadata(last.metadata, msg.metadata, {
          persistedId: last.metadata?.persistedId ?? msg.metadata?.persistedId,
        }),
      };
    } else {
      result.push(msg);
    }
  }
  return result;
}

function mergeMatchedMessage(storedMessage: HermesUIMessage, liveMessage: HermesUIMessage): HermesUIMessage {
  const liveWins = !(
    storedMessage.role === "assistant" &&
    storedMessage.status === "complete" &&
    liveMessage.status === "streaming"
  );
  const selected = liveWins ? liveMessage : storedMessage;
  const fallback = liveWins ? storedMessage : liveMessage;
  return {
    ...selected,
    metadata: mergeMessageMetadata(fallback.metadata, selected.metadata, {
      persistedId: selected.metadata?.persistedId ?? fallback.metadata?.persistedId,
    }),
  };
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
    merged.push(mergeMatchedMessage(storedMessage, liveMessage));
  }

  consolidatedLive.forEach((liveMessage, index) => {
    if (usedLiveIndexes.has(index)) return;
    if (isStaleInterruptedLiveMessage(liveMessage, stored)) return;
    if (isReplayDuplicateLiveMessage(liveMessage, stored)) return;
    if (isSupersededByStoredTurn(liveMessage, stored)) return;
    merged.push(liveMessage);
  });

  // Issue #98: a live message that fails to match any stored row — typically
  // the current turn's user prompt whose canonical text diverged from the
  // persisted copy — is pushed onto the end above, which lands it *below* the
  // assistant reply once that reply is refetched into `stored`. Re-order the
  // merged turn by createdAt so it keeps its chronological shape after the
  // reply completes. The sort is stable: on an exact createdAt tie (startPrompt
  // stamps the optimistic user + assistant with the same `now`) the user is
  // floated before the assistant, otherwise the original order is preserved.
  return merged
    .map((message, index) => ({ message, index }))
    .sort((a, b) => {
      if (a.message.createdAt !== b.message.createdAt) {
        return a.message.createdAt - b.message.createdAt;
      }
      const rank = (role: HermesUIMessage["role"]) => (role === "user" ? 0 : 1);
      const rankDelta = rank(a.message.role) - rank(b.message.role);
      if (rankDelta !== 0) return rankDelta;
      return a.index - b.index;
    })
    .map((entry) => entry.message);
}

export function storedMessageToChatMessage(msg: SessionMessage): ChatMessage | null {
  const canonical = legacySessionMessageToHermesUIMessage(msg);
  return canonical ? hermesUIMessageToChatMessage(canonical) : null;
}

export function storedMessagesToChatMessages(messages: SessionMessage[]): ChatMessage[] {
  return hermesUIMessagesToChatMessages(legacySessionMessagesToHermesUIMessages(messages));
}
