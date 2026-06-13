import { useSyncExternalStore } from "react";
import type { ComposerAttachment } from "@/components/chat/composer-types";

// Per-session send queue. When the agent is busy, composer submissions are
// parked here and drained (automatically on turn-settle, or manually) when it
// frees up. Pure client state, persisted to localStorage; no backend.

export interface QueuedPromptEntry {
  id: string;
  text: string;
  attachments: ComposerAttachment[];
  queuedAt: number;
}

export type QueueState = Record<string, QueuedPromptEntry[]>;

const STORAGE_KEY = "hermes.desktop.composerQueue.v1";
const EMPTY: readonly QueuedPromptEntry[] = [];

// ---- Pure reducers (unit-tested) -------------------------------------------

export function entriesFor(
  state: QueueState,
  key: string | null | undefined,
): QueuedPromptEntry[] {
  return (key && state[key]) || (EMPTY as QueuedPromptEntry[]);
}

export function enqueue(state: QueueState, key: string, entry: QueuedPromptEntry): QueueState {
  return { ...state, [key]: [...(state[key] ?? []), entry] };
}

export function removeEntry(state: QueueState, key: string, id: string): QueueState {
  const queue = state[key];
  if (!queue) return state;
  const next = queue.filter((entry) => entry.id !== id);
  if (next.length === queue.length) return state;
  if (next.length === 0) {
    const { [key]: _drop, ...rest } = state;
    return rest;
  }
  return { ...state, [key]: next };
}

export function updateEntry(
  state: QueueState,
  key: string,
  id: string,
  patch: Partial<Pick<QueuedPromptEntry, "text" | "attachments">>,
): QueueState {
  const queue = state[key];
  if (!queue) return state;
  return {
    ...state,
    [key]: queue.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)),
  };
}

export interface AutoDrainSettleInput {
  isBusy: boolean;
  wasBusy: boolean;
  queueLength: number;
  userInterrupted: boolean;
}

/**
 * Decide whether to auto-send the next queued prompt now. Only fires on a
 * busy→idle transition, never when an explicit Stop just interrupted the turn
 * (that suppresses exactly one drain), and only when something is queued.
 */
export function shouldAutoDrainOnSettle(params: AutoDrainSettleInput): boolean {
  if (params.isBusy || !params.wasBusy) return false;
  if (params.userInterrupted) return false;
  return params.queueLength > 0;
}

// ---- Persistence -----------------------------------------------------------

/** Strip transient (non-serializable) attachment fields before persisting. */
function attachmentForStorage(attachment: ComposerAttachment): ComposerAttachment {
  const { file: _file, previewUrl: _previewUrl, ...rest } = attachment;
  return rest;
}

export function serializeQueue(state: QueueState): string {
  const cleaned: QueueState = {};
  for (const [key, entries] of Object.entries(state)) {
    cleaned[key] = entries.map((entry) => ({
      ...entry,
      attachments: entry.attachments.map(attachmentForStorage),
    }));
  }
  return JSON.stringify(cleaned);
}

export function deserializeQueue(raw: string | null): QueueState {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as QueueState;
    if (!parsed || typeof parsed !== "object") return {};
    // Drop attachments that can't survive a reload (browser File objects lose
    // their data); path-based attachments keep working.
    for (const entries of Object.values(parsed)) {
      for (const entry of entries) {
        entry.attachments = (entry.attachments ?? []).filter((a) => a.source === "path" && a.path);
      }
    }
    return parsed;
  } catch {
    return {};
  }
}

// ---- Live store (useSyncExternalStore) -------------------------------------

function readStorage(): QueueState {
  if (typeof window === "undefined") return {};
  try {
    return deserializeQueue(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return {};
  }
}

let liveState: QueueState = readStorage();
let idCounter = 0;
const listeners = new Set<() => void>();

function commit(next: QueueState) {
  liveState = next;
  if (typeof window !== "undefined") {
    try {
      if (Object.keys(next).length === 0) window.localStorage.removeItem(STORAGE_KEY);
      else window.localStorage.setItem(STORAGE_KEY, serializeQueue(next));
    } catch {
      // best-effort; queue still works in-memory
    }
  }
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): QueueState {
  return liveState;
}

export function enqueueQueuedPrompt(
  key: string | null | undefined,
  input: { text: string; attachments: ComposerAttachment[] },
  now: number,
): QueuedPromptEntry | null {
  if (!key) return null;
  if (!input.text.trim() && input.attachments.length === 0) return null;
  const entry: QueuedPromptEntry = {
    id: `queued-${now}-${(idCounter += 1)}`,
    text: input.text,
    attachments: input.attachments,
    queuedAt: now,
  };
  commit(enqueue(liveState, key, entry));
  return entry;
}

export function removeQueuedPrompt(key: string | null | undefined, id: string): void {
  if (!key) return;
  commit(removeEntry(liveState, key, id));
}

export function updateQueuedPrompt(
  key: string | null | undefined,
  id: string,
  patch: Partial<Pick<QueuedPromptEntry, "text" | "attachments">>,
): void {
  if (!key) return;
  commit(updateEntry(liveState, key, id, patch));
}

/** Subscribe a component to the queued entries for one session. */
export function useQueuedPrompts(key: string | null | undefined): QueuedPromptEntry[] {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return entriesFor(snapshot, key);
}
