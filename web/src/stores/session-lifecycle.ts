import { atom } from "jotai";

/**
 * Session lifecycle atoms.
 *
 * These atoms hold the active persistent session id and the busy-mode command
 * queues (`/queue`, `/steer`). They mirror the WS-free in-process command
 * runner; components can subscribe and drive the composer / runtime accordingly.
 */

/** Currently active persistent session id. Set by /new, /resume, /branch, etc. */
export const activeSessionIdAtom = atom<string | null>(null);

/** FIFO prompt queue used by `/queue` while the agent is busy. */
export interface QueuedPrompt {
  id: string;
  sessionId: string;
  text: string;
  queuedAt: number;
}

export const queuedPromptsAtom = atom<QueuedPrompt[]>([]);

/** Pending steer instruction injected by `/steer` after the next tool call. */
export interface SteerPending {
  sessionId: string;
  text: string;
  queuedAt: number;
}

export const steerPendingAtom = atom<SteerPending | null>(null);

// ─────────────────────────────────────────────────────────────────────────────
// Reducers (exported for unit tests)
// ─────────────────────────────────────────────────────────────────────────────

export function enqueuePrompt(
  queue: QueuedPrompt[],
  sessionId: string,
  text: string,
  now: number,
  id?: string,
): QueuedPrompt[] {
  const entry: QueuedPrompt = {
    id: id ?? `queued-${now}-${Math.random().toString(36).slice(2, 8)}`,
    sessionId,
    text,
    queuedAt: now,
  };
  return [...queue, entry];
}

export function dequeuePrompt(queue: QueuedPrompt[]): { queue: QueuedPrompt[]; prompt: QueuedPrompt | null } {
  if (queue.length === 0) return { queue, prompt: null };
  const [first, ...rest] = queue;
  return { queue: rest, prompt: first };
}

export function removePrompt(queue: QueuedPrompt[], id: string): QueuedPrompt[] {
  const next = queue.filter((p) => p.id !== id);
  return next.length === queue.length ? queue : next;
}

export function clearPromptsForSession(queue: QueuedPrompt[], sessionId: string): QueuedPrompt[] {
  return queue.filter((p) => p.sessionId !== sessionId);
}

