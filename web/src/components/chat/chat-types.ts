import type { AssistantTurnBlock, ImageEntry, ToolEntry } from "@/stores/chat";

export type ChatRole = "user" | "assistant" | "system" | "tool";

export interface ChatToolItem extends ToolEntry {
  arguments?: Record<string, unknown>;
  images?: ChatImageItem[];
}

export type ChatImageItem = ImageEntry;

export interface AssistantMessageStats {
  ttftMs?: number;
  durationMs?: number;
  tokensTotal?: number;
  tokensInput?: number;
  tokensOutput?: number;
  tokensCompletion?: number;
  tokPerSec?: number;
  cacheRead?: number;
  cacheWrite?: number;
  costUsd?: number;
  model?: string;
  apiCalls?: number;
  finishReason?: string;
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  createdAt: number;
  text?: string;
  reasoning?: string;
  images?: ChatImageItem[];
  tools?: ChatToolItem[];
  blocks?: AssistantTurnBlock[];
  status?: "streaming" | "complete" | "error";
  title?: string;
  error?: boolean;
  stats?: AssistantMessageStats;
  // Group chat (P-048): sender attribution for multi-agent rooms. Undefined
  // for single-agent sessions, which fall back to the global assistant identity.
  senderAgentId?: string;
  senderName?: string;
  senderAvatar?: string;
}
