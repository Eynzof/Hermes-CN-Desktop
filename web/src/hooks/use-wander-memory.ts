// ─────────────────────────────────────────────────────────────────────────────
// use-wander-memory.ts — TanStack Query hooks + the streaming chat controller
// for the WanderMemory surface (merge plan Appendix B.2/B.3/B.6).
//
// Query keys (B.3): namespace ["wander-memory", ...] →
//   health / list / search(query, topK) / memory(id) / models / backends
// Write mutations invalidate list + search on success so the inventory and
// search results stay in sync with server-side changes.
//
// Error surface (B.8): hooks expose typed ApiError on query.error /
// mutation.error / message.error; views render them inline via Alert. There is
// deliberately no global toast system here.
//
// Client access: all hooks use the sync singleton getWanderMemoryClient().
// resolveEndpoints() already applies env → ui-store → defaults and the
// port-shift discovery result is cached in ui-store by the endpoints module;
// getWanderMemoryClientAsync() disposes and recreates the singleton (reopening
// the WS) on every call, so it belongs to the Status view's endpoint-application
// flow, not to per-hook / per-send paths.
// ─────────────────────────────────────────────────────────────────────────────

import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useCallback, useRef, useState } from 'react';
import { useSetAtom } from 'jotai';
import { raceAbort } from '@/lib/transport';
import { getWanderMemoryClient } from '@/lib/wander-memory/client';
import { toApiError, type ApiError } from '@/lib/wander-memory/errors';
import type {
  AddDialogueResponse,
  AddMemoryResponse,
  BackendsResponse,
  ChatResponse,
  ContextResponse,
  HealthResponse,
  MaintenanceResponse,
  ModelsResponse,
  SearchResponse,
} from '@/lib/wander-memory/types';
import {
  addWanderMemoryChatMessageAtom,
  updateWanderMemoryLastMessageAtom,
} from '@/stores/wander-memory-chat';

// ── query keys (plan B.3) ───────────────────────────────────────────────────

export const WANDER_MEMORY_QUERY_KEYS = {
  all: ['wander-memory'] as const,
  health: ['wander-memory', 'health'] as const,
  list: ['wander-memory', 'list'] as const,
  /** Prefix for every search variant — used by invalidateQueries. */
  searchAll: ['wander-memory', 'search'] as const,
  search: (query: string, topK?: number) =>
    topK === undefined
      ? (['wander-memory', 'search', query] as const)
      : (['wander-memory', 'search', query, topK] as const),
  memory: (id: string) => ['wander-memory', 'memory', id] as const,
  models: ['wander-memory', 'models'] as const,
  backends: ['wander-memory', 'backends'] as const,
} as const;

function invalidateWanderMemoryListAndSearch(qc: QueryClient): void {
  qc.invalidateQueries({ queryKey: WANDER_MEMORY_QUERY_KEYS.list });
  qc.invalidateQueries({ queryKey: WANDER_MEMORY_QUERY_KEYS.searchAll });
}

// ── queries ─────────────────────────────────────────────────────────────────

export function useWanderMemoryHealth(options: { refetchInterval?: number } = {}) {
  return useQuery<HealthResponse, ApiError>({
    queryKey: WANDER_MEMORY_QUERY_KEYS.health,
    queryFn: ({ signal }) => raceAbort(getWanderMemoryClient().health(), signal),
    // The reference view re-probes every 30 s (§6.1); surface failures
    // immediately instead of retrying (the interval does the probing).
    refetchInterval: options.refetchInterval ?? 30_000,
    retry: false,
  });
}

export function useWanderMemoryList() {
  return useQuery<SearchResponse, ApiError>({
    queryKey: WANDER_MEMORY_QUERY_KEYS.list,
    queryFn: ({ signal }) => raceAbort(getWanderMemoryClient().list(), signal),
  });
}

export function useWanderMemorySearch(query: string, topK?: number) {
  return useQuery<SearchResponse, ApiError>({
    queryKey: WANDER_MEMORY_QUERY_KEYS.search(query, topK),
    queryFn: ({ signal }) => raceAbort(getWanderMemoryClient().search(query, topK), signal),
    // Empty query is the list view's job (useWanderMemoryList).
    enabled: query.trim().length > 0,
  });
}

export function useWanderMemoryModels() {
  return useQuery<ModelsResponse, ApiError>({
    queryKey: WANDER_MEMORY_QUERY_KEYS.models,
    queryFn: ({ signal }) => raceAbort(getWanderMemoryClient().models(), signal),
  });
}

export function useWanderMemoryBackends() {
  return useQuery<BackendsResponse, ApiError>({
    queryKey: WANDER_MEMORY_QUERY_KEYS.backends,
    queryFn: ({ signal }) => raceAbort(getWanderMemoryClient().backends(), signal),
  });
}

// ── mutations ───────────────────────────────────────────────────────────────

export function useWanderMemoryAdd() {
  const qc = useQueryClient();
  return useMutation<AddMemoryResponse, ApiError, { text: string; metadata?: Record<string, unknown> }>({
    mutationFn: ({ text, metadata }) => getWanderMemoryClient().addMemory(text, metadata),
    onSuccess: () => invalidateWanderMemoryListAndSearch(qc),
  });
}

export function useWanderMemoryDelete() {
  const qc = useQueryClient();
  return useMutation<void, ApiError, { id: string }>({
    mutationFn: ({ id }) => getWanderMemoryClient().delete(id),
    onSuccess: () => invalidateWanderMemoryListAndSearch(qc),
  });
}

export function useWanderMemoryDialogue() {
  const qc = useQueryClient();
  return useMutation<AddDialogueResponse, ApiError, { dialogue: string }>({
    mutationFn: ({ dialogue }) => getWanderMemoryClient().addDialogue(dialogue),
    onSuccess: () => invalidateWanderMemoryListAndSearch(qc),
  });
}

export function useWanderMemoryContext() {
  // Read-only mutation (prompt preview) — triggered by a button, not a query.
  return useMutation<ContextResponse, ApiError, { query: string; topK?: number }>({
    mutationFn: ({ query, topK }) => getWanderMemoryClient().context(query, topK),
  });
}

export function useWanderMemoryChat() {
  const qc = useQueryClient();
  return useMutation<ChatResponse, ApiError, { query: string }>({
    mutationFn: ({ query }) => getWanderMemoryClient().chat(query),
    // The merged chat step can write memories server-side — keep list/search fresh.
    onSuccess: () => invalidateWanderMemoryListAndSearch(qc),
  });
}

export function useWanderMemoryMaintenance() {
  const qc = useQueryClient();
  return useMutation<MaintenanceResponse, ApiError, void>({
    mutationFn: () => getWanderMemoryClient().maintenance(),
    onSuccess: () => invalidateWanderMemoryListAndSearch(qc),
  });
}

// ── streaming chat controller (plan B.6) ────────────────────────────────────

const CANCELLED_SUFFIX = ' [cancelled]';

export interface WanderMemoryChatStreamHandle {
  /** Start a turn: appends the user message + an empty streaming assistant
   *  message, then streams deltas into it. No-op while a stream is running. */
  send: (query: string) => void;
  /** Stop streaming client-side: marks the last message `[cancelled]` and
   *  drops any further deltas. Server generation is NOT cancellable. */
  cancel: () => void;
  /** True while a stream is in flight (send() has been called, cancel() not). */
  isStreaming: boolean;
}

export function useWanderMemoryChatStream(): WanderMemoryChatStreamHandle {
  const addMessage = useSetAtom(addWanderMemoryChatMessageAtom);
  const updateLast = useSetAtom(updateWanderMemoryLastMessageAtom);
  const [isStreaming, setIsStreaming] = useState(false);
  const streamingRef = useRef(false);
  // Monotonic per-send epoch: cancel() (or a new send) bumps it so a
  // still-generating in-flight promise can never touch the transcript again.
  const sendSeqRef = useRef(0);

  const send = useCallback(
    (query: string) => {
      const text = query.trim();
      if (!text || streamingRef.current) return;
      const seq = ++sendSeqRef.current;
      streamingRef.current = true;
      setIsStreaming(true);

      addMessage({ role: 'user', text });
      addMessage({ role: 'assistant', text: '', streaming: true });

      let cancelled = false;
      const isCurrent = () => seq === sendSeqRef.current && !cancelled;
      const onDelta = (delta: string) => {
        if (!isCurrent()) return;
        updateLast((m) => (m.streaming ? { ...m, text: m.text + delta } : m));
      };

      void (async () => {
        const client = getWanderMemoryClient();
        try {
          let result: ChatResponse;
          if (client.streamingAvailable()) {
            result = await client.chatStream(text, onDelta);
          } else {
            // WS not open right now — fall back to the non-streaming REST chat
            // so the turn still completes (the client's own chatStream would
            // do the same, but we keep the streaming flag honest).
            result = await client.chat(text);
          }
          if (!isCurrent()) return;
          updateLast((m) => ({
            ...m,
            text: result.reply,
            streaming: false,
            dreamed: result.dreamed_keywords,
            groundedCount: result.grounded_memories?.length,
            groundedSnippets: result.grounded_memories?.map((g) => g.memory),
          }));
        } catch (err) {
          if (!isCurrent()) return;
          updateLast((m) => ({
            ...m,
            streaming: false,
            error: toApiError(err),
          }));
        } finally {
          if (seq === sendSeqRef.current) {
            streamingRef.current = false;
            setIsStreaming(false);
          }
        }
      })();
    },
    [addMessage, updateLast],
  );

  const cancel = useCallback(() => {
    if (!streamingRef.current) return;
    // Invalidate the in-flight send: its deltas/finalize must no longer land.
    sendSeqRef.current += 1;
    streamingRef.current = false;
    setIsStreaming(false);
    updateLast((m) => {
      if (!m.streaming) return m;
      return {
        ...m,
        text: m.text.endsWith(CANCELLED_SUFFIX) ? m.text : `${m.text}${CANCELLED_SUFFIX}`,
        streaming: false,
      };
    });
  }, [updateLast]);

  return { send, cancel, isStreaming };
}
