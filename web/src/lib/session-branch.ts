import type {
  HermesUIMessage,
  MessagesResponse,
  SessionSummary,
  SessionsResponse,
} from "@hermes/protocol";
import {
  hermesUIMessageToChatMessage,
  messagesResponseToHermesUIMessages,
} from "@/components/chat/message-adapter";

export interface SessionBranchMessage {
  role: "user" | "assistant";
  content: string;
  source: HermesUIMessage;
}

export interface SessionBranchCreateParams extends Record<string, unknown> {
  cols: 96;
  source: "desktop";
  parent_session_id: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  cwd?: string;
}

export function sessionBranchCreateParams(
  parentSessionId: string,
  cwd: string | null | undefined,
  messages: readonly SessionBranchMessage[],
): SessionBranchCreateParams {
  const cleanCwd = cwd?.trim();
  return {
    cols: 96,
    source: "desktop",
    parent_session_id: parentSessionId.trim(),
    messages: messages.map(({ content, role }) => ({ content, role })),
    ...(cleanCwd ? { cwd: cleanCwd } : {}),
  };
}

/**
 * Build the same copyable conversation spine as Core's official desktop:
 * visible user/assistant turns with text, excluding injected system records,
 * tool-only rows and empty messages.
 */
export function sessionBranchMessages(response: MessagesResponse): SessionBranchMessage[] {
  return messagesResponseToHermesUIMessages(response).flatMap((source) => {
    const message = hermesUIMessageToChatMessage(source);
    const content = message?.text?.trim();
    if (!message || !content || (message.role !== "user" && message.role !== "assistant")) {
      return [];
    }
    return [{ role: message.role, content, source }];
  });
}

/** Re-key the copied transcript into the new live Gateway runtime bucket. */
export function branchRuntimeMessages(
  messages: readonly SessionBranchMessage[],
  sessionId: string,
): HermesUIMessage[] {
  return messages.map(({ source }, index) => ({
    ...source,
    id: `branch-${index + 1}-${source.id}`,
    sessionId,
    status: "complete",
  }));
}

/** Keep a not-yet-persisted branch visible until its first real prompt lands. */
export function withOptimisticBranch(
  response: SessionsResponse | undefined,
  branch: SessionSummary,
): SessionsResponse | undefined {
  if (!response) return response;
  const existingIndex = response.sessions.findIndex((session) => session.id === branch.id);
  if (existingIndex >= 0) {
    const sessions = [...response.sessions];
    sessions[existingIndex] = { ...branch, ...sessions[existingIndex] };
    return { ...response, sessions };
  }
  return {
    ...response,
    sessions: [branch, ...response.sessions],
    total: response.total + 1,
  };
}
