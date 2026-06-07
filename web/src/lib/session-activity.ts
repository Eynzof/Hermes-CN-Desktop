import type { HermesMessagePart, HermesUIMessage, SessionSummary } from "@hermes/protocol";
import { resolvePersistentSessionId, resolveSessionIdAliases } from "@/lib/session-map";
import type { ChatRuntimeBySession, ChatSessionRuntime } from "@/stores/chat";

export function isRuntimeRunning(runtime: ChatSessionRuntime | undefined): boolean {
  if (!runtime) return false;
  if (
    runtime.streamStatus === "error" ||
    runtime.streamStatus === "complete" ||
    runtime.streamStatus === "idle"
  ) {
    return false;
  }
  return (
    runtime.streamStatus === "connecting" ||
    runtime.streamStatus === "streaming" ||
    runtime.pendingApprovals.length > 0 ||
    runtime.messages.some((message) =>
      message.parts.some((part) => part.type === "tool" && part.state === "running"),
    )
  );
}

function findRuntimeForSession(
  sessionId: string,
  runtimeBySession: ChatRuntimeBySession,
): ChatSessionRuntime | undefined {
  for (const [runtimeSessionId, runtime] of Object.entries(runtimeBySession)) {
    if (
      runtimeSessionId === sessionId ||
      resolvePersistentSessionId(runtimeSessionId) === sessionId
    ) {
      return runtime;
    }
  }
  return undefined;
}

export function isSessionRunning(
  session: SessionSummary,
  runtimeBySession: ChatRuntimeBySession = {},
): boolean {
  const runtime = findRuntimeForSession(session.id, runtimeBySession);
  if (runtime) return isRuntimeRunning(runtime);

  return session.is_active === true && session.message_count === 0;
}

function unixSecondsFromRuntimeMs(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return Math.floor(Date.now() / 1000);
  }
  // Runtime timestamps are created from Date.now() in the renderer, while the
  // REST session API reports Unix seconds. Keep small test fixtures untouched.
  return value > 100_000_000_000 ? Math.floor(value / 1000) : value;
}

function textFromPart(part: HermesMessagePart): string {
  if (part.type === "text" || part.type === "reasoning" || part.type === "progress") {
    return part.text;
  }
  if (part.type === "notice") return part.text;
  if (part.type === "image") {
    return part.alt || part.name || part.title || "";
  }
  if (part.type === "tool") return part.name;
  return "";
}

function compactText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function messageText(message: HermesUIMessage): string {
  return compactText(message.parts.map(textFromPart).filter(Boolean).join(" "));
}

function firstUserPreview(runtime: ChatSessionRuntime): string | undefined {
  const user = runtime.messages.find((message) => message.role === "user");
  const preview = user ? messageText(user) : "";
  return preview || undefined;
}

function runtimeStartedAt(runtime: ChatSessionRuntime): number {
  const firstMessageCreatedAt = runtime.messages[0]?.createdAt;
  return unixSecondsFromRuntimeMs(runtime.turnStartedAt ?? firstMessageCreatedAt ?? runtime.updatedAt);
}

function sessionMatchesRuntimeId(session: SessionSummary, runtimeSessionId: string): boolean {
  const persistentSessionId = resolvePersistentSessionId(runtimeSessionId);
  return (
    session.id === runtimeSessionId ||
    session.id === persistentSessionId ||
    resolvePersistentSessionId(session.id) === persistentSessionId
  );
}

export function sessionIdMatches(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  return resolveSessionIdAliases(a, { includeExpired: true }).includes(b);
}

function liveRuntimeSessionSummary(
  sessionId: string,
  runtime: ChatSessionRuntime,
): SessionSummary | null {
  if (!isRuntimeRunning(runtime)) return null;
  const persistentSessionId = resolvePersistentSessionId(sessionId) ?? sessionId;
  const preview = firstUserPreview(runtime);
  const model = runtime.messages.find((message) => message.metadata?.model)?.metadata?.model ?? "";

  return {
    id: persistentSessionId,
    source: "gateway",
    user_id: null,
    model,
    title: null,
    preview,
    started_at: runtimeStartedAt(runtime),
    ended_at: null,
    end_reason: null,
    message_count: runtime.messages.length,
    input_tokens: 0,
    output_tokens: 0,
    estimated_cost_usd: null,
    is_active: true,
  };
}

export function mergeLiveRuntimeSessions(
  sessions: readonly SessionSummary[],
  runtimeBySession: ChatRuntimeBySession = {},
): SessionSummary[] {
  const merged = [...sessions];
  const synthetic: SessionSummary[] = [];

  for (const [runtimeSessionId, runtime] of Object.entries(runtimeBySession)) {
    if (merged.some((session) => sessionMatchesRuntimeId(session, runtimeSessionId))) {
      continue;
    }
    const summary = liveRuntimeSessionSummary(runtimeSessionId, runtime);
    if (summary) synthetic.push(summary);
  }

  synthetic.sort((a, b) => b.started_at - a.started_at);
  return [...synthetic, ...merged];
}
