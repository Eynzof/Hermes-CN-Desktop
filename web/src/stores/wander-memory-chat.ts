// ─────────────────────────────────────────────────────────────────────────────
// wander-memory-chat.ts — Jotai atoms for the WanderMemory chat transcript
// (merge plan Appendix B.7). The streaming chat view renders directly from
// wanderMemoryChatMessagesAtom; the chat-stream controller in
// use-wander-memory.ts appends/updates through the helper atoms below so every
// write goes through one path (append / update-last / clear).
// ─────────────────────────────────────────────────────────────────────────────

import { atom } from 'jotai';
import type { ApiError } from '@/lib/wander-memory/errors';

/** One turn in the WanderMemory chat transcript (§6.4 / B.7). */
export interface WanderMemoryChatMessage {
  role: 'user' | 'assistant';
  text: string;
  /** True while the assistant message is being streamed (deltas pending). */
  streaming?: boolean;
  /** Keyword trace from the merged chat step (ChatResponse.dreamed_keywords). */
  dreamed?: string[];
  /** Number of memories the reply was grounded on. */
  groundedCount?: number;
  /** Grounded memory texts (ChatResponse.grounded_memories). */
  groundedSnippets?: string[];
  /** Typed error surfaced inline by views when the turn failed (B.8). */
  error?: ApiError;
}

/** The full transcript — append-only via addWanderMemoryChatMessageAtom. */
export const wanderMemoryChatMessagesAtom = atom<WanderMemoryChatMessage[]>([]);

/** Append a message to the end of the transcript. */
export const addWanderMemoryChatMessageAtom = atom(
  null,
  (_get, set, message: WanderMemoryChatMessage) => {
    set(wanderMemoryChatMessagesAtom, (prev) => [...prev, message]);
  },
);

/**
 * Update the last message via an updater fn. No-op when the transcript is
 * empty (the streaming controller appends the assistant message before any
 * delta/finalize write lands).
 */
export const updateWanderMemoryLastMessageAtom = atom(
  null,
  (_get, set, updater: (message: WanderMemoryChatMessage) => WanderMemoryChatMessage) => {
    set(wanderMemoryChatMessagesAtom, (prev) => {
      if (prev.length === 0) return prev;
      const last = prev[prev.length - 1];
      const next = updater(last);
      // Keep the identity check so a no-change updater doesn't notify.
      if (next === last) return prev;
      return [...prev.slice(0, prev.length - 1), next];
    });
  },
);

/** Reset the transcript to an empty list. */
export const clearWanderMemoryChatAtom = atom(null, (_get, set) => {
  set(wanderMemoryChatMessagesAtom, []);
});
