import type { CodexItemEvent } from "./types.js";

export interface ProjectedMessage {
  role: "assistant" | "tool";
  content?: string;
  tool_calls?: unknown[];
  tool_call_id?: string;
}

export function projectItemEvent(event: CodexItemEvent): ProjectedMessage[] {
  const msgs: ProjectedMessage[] = [];
  if (event.type === "item/agentMessage") {
    msgs.push({ role: "assistant", content: String(event.delta ?? "") });
  } else if (event.type === "item/completed") {
    const item = event.item as { type?: string; content?: unknown } | undefined;
    if (item?.type === "message") {
      msgs.push({ role: "assistant", content: String(item.content ?? "") });
    }
  }
  return msgs;
}

export function deterministicCallId(serverName: string, toolName: string, index: number): string {
  return `${serverName}_${toolName}_${index}`;
}
