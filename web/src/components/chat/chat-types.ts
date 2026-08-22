import type { AssistantTurnBlock, ImageEntry, ToolEntry } from "@/stores/chat";

export type ChatRole = "user" | "assistant" | "system" | "tool";

export interface ChatToolItem extends ToolEntry {
  arguments?: Record<string, unknown>;
  images?: ChatImageItem[];
  videos?: ChatVideoItem[];
}

export type ChatImageItem = ImageEntry;

export interface ChatVideoItem extends ImageEntry {
  poster?: string;
}

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
  videos?: ChatVideoItem[];
  tools?: ChatToolItem[];
  blocks?: AssistantTurnBlock[];
  status?: "streaming" | "complete" | "error";
  title?: string;
  error?: boolean;
  stats?: AssistantMessageStats;
}
