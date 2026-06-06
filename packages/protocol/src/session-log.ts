import type { SessionMessage } from "./hermes-api";

type RawSessionLogMessage = Record<string, unknown>;

function asString(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value == null) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function normalizeRole(value: unknown): SessionMessage["role"] | null {
  if (
    value === "user" ||
    value === "assistant" ||
    value === "system" ||
    value === "tool"
  ) {
    return value;
  }
  return null;
}

function startTimestampSeconds(value: unknown): number {
  if (typeof value !== "string") return Date.now() / 1000;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed / 1000 : Date.now() / 1000;
}

export function sessionLogToMessages(
  sessionId: string,
  log: Record<string, unknown>,
): SessionMessage[] {
  const rawMessages = Array.isArray(log.messages) ? log.messages : [];
  const start = startTimestampSeconds(log.session_start);

  return rawMessages.flatMap((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const msg = raw as RawSessionLogMessage;
    const role = normalizeRole(msg.role);
    if (!role) return [];

    return [{
      id: index + 1,
      session_id: sessionId,
      role,
      content: asString(msg.content),
      images: Array.isArray(msg.images) ? msg.images as SessionMessage["images"] : undefined,
      tool_call_id: asNullableString(msg.tool_call_id),
      tool_calls: msg.tool_calls ?? null,
      tool_name: asNullableString(msg.tool_name),
      timestamp: start + index,
      token_count: null,
      finish_reason: asNullableString(msg.finish_reason),
      reasoning: asNullableString(msg.reasoning),
      reasoning_details: msg.reasoning_details ?? null,
      codex_reasoning_items: msg.codex_reasoning_items ?? null,
      reasoning_content: asNullableString(msg.reasoning_content),
    }];
  });
}
