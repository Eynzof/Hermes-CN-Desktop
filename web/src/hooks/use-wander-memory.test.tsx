// @vitest-environment jsdom
// use-wander-memory.test.tsx — hooks contract (merge plan Appendix B.2/B.3/B.6):
// query keys + loading/success, mutations call the client and invalidate
// list+search, and the chat-stream controller appends/finalizes/cancels/errors.
// The client module is mocked; DemoWanderMemoryClient (real in-memory
// implementation) stands in for the live client wherever convenient.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider, type QueryClientConfig } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { getDefaultStore } from 'jotai';
import type { ReactNode } from 'react';
import { DemoWanderMemoryClient } from '@/lib/wander-memory/demo';
import { ApiError } from '@/lib/wander-memory/errors';
import type { WanderMemoryClient } from '@/lib/wander-memory/client';
import type { ChatResponse } from '@/lib/wander-memory/types';
import { clearWanderMemoryChatAtom, wanderMemoryChatMessagesAtom } from '@/stores/wander-memory-chat';
import {
  NO_GROUNDING_MESSAGE,
  WANDER_MEMORY_QUERY_KEYS,
  useWanderMemoryAdd,
  useWanderMemoryBackends,
  useWanderMemoryChat,
  useWanderMemoryChatStream,
  useWanderMemoryDelete,
  useWanderMemoryDialogue,
  useWanderMemoryHealth,
  useWanderMemoryList,
  useWanderMemoryMaintenance,
  useWanderMemoryModels,
  useWanderMemorySearch,
} from './use-wander-memory';

// ── client module mock (hoisted so vi.mock can reference it) ────────────────

const clientState = vi.hoisted(() => {
  let current: WanderMemoryClient | null = null;
  return {
    __setClient(c: WanderMemoryClient | null): void {
      current = c;
    },
    __getClient: vi.fn((): WanderMemoryClient => {
      if (!current) throw new Error('wander-memory test client not set');
      return current;
    }),
  };
});

vi.mock('@/lib/wander-memory/client', () => ({
  getWanderMemoryClient: clientState.__getClient,
  getWanderMemoryClientAsync: clientState.__getClient,
  resetWanderMemoryClient: vi.fn(),
}));

// ── helpers ─────────────────────────────────────────────────────────────────

const chatStore = getDefaultStore();

function createTestQueryClient(): QueryClient {
  const config: QueryClientConfig = {
    defaultOptions: {
      queries: { retry: false, staleTime: 0, gcTime: 0 },
      mutations: { retry: false },
    },
  };
  return new QueryClient(config);
}

function wrapperFor(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

/** Wire a fresh DemoWanderMemoryClient as the singleton and return it. */
function setDemoClient(): DemoWanderMemoryClient {
  const client = new DemoWanderMemoryClient();
  clientState.__setClient(client);
  return client;
}

/** Minimal client stub: streaming unavailable, chat resolved via `chatImpl`. */
function restOnlyClient(chatImpl: (query: string) => Promise<ChatResponse>): WanderMemoryClient {
  return {
    mode: 'demo',
    streamingAvailable: () => false,
    chatStream: () => Promise.reject(new Error('chatStream must not be used when streaming is unavailable')),
    chat: chatImpl,
  } as unknown as WanderMemoryClient;
}

beforeEach(() => {
  chatStore.set(clearWanderMemoryChatAtom);
});

// ── queries: keys + loading/success ─────────────────────────────────────────

describe('wander-memory query hooks', () => {
  it('useWanderMemoryList queries ["wander-memory","list"] and resolves', async () => {
    setDemoClient();
    const qc = createTestQueryClient();
    const { result } = renderHook(() => useWanderMemoryList(), { wrapper: wrapperFor(qc) });

    expect(result.current.isLoading).toBe(true);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(qc.getQueryState(WANDER_MEMORY_QUERY_KEYS.list)?.status).toBe('success');
    expect(result.current.data?.results.length).toBeGreaterThan(0);
  });

  it('useWanderMemoryHealth honors the refetchInterval option and resolves', async () => {
    setDemoClient();
    const qc = createTestQueryClient();
    const { result } = renderHook(() => useWanderMemoryHealth({ refetchInterval: 0 }), {
      wrapper: wrapperFor(qc),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.status).toBe('ok');
    expect(qc.getQueryState(WANDER_MEMORY_QUERY_KEYS.health)?.status).toBe('success');
  });

  it('useWanderMemorySearch keys by query+topK and stays disabled for an empty query', async () => {
    setDemoClient();
    const qc = createTestQueryClient();
    const { result, rerender } = renderHook(
      ({ query, topK }: { query: string; topK?: number }) => useWanderMemorySearch(query, topK),
      {
        initialProps: { query: '', topK: undefined } as { query: string; topK?: number },
        wrapper: wrapperFor(qc),
      },
    );

    // Disabled query: status stays pending, never fetches.
    expect(result.current.isPending).toBe(true);
    const disabledState = qc.getQueryState(WANDER_MEMORY_QUERY_KEYS.search(''));
    expect(disabledState?.status).toBe('pending');
    expect(disabledState?.fetchStatus).toBe('idle');

    rerender({ query: '海盐', topK: 3 });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data?.results.length).toBeGreaterThan(0);
    expect(qc.getQueryState(WANDER_MEMORY_QUERY_KEYS.search('海盐', 3))?.status).toBe('success');
    // topK is part of the key — the topK-less variant is a different cache slot.
    expect(qc.getQueryState(WANDER_MEMORY_QUERY_KEYS.search('海盐'))).toBeUndefined();
  });

  it('useWanderMemoryModels and useWanderMemoryBackends use their keys', async () => {
    setDemoClient();
    const qc = createTestQueryClient();

    const models = renderHook(() => useWanderMemoryModels(), { wrapper: wrapperFor(qc) });
    await waitFor(() => expect(models.result.current.isSuccess).toBe(true));
    expect(models.result.current.data?.model).toContain('demo-llm');
    expect(qc.getQueryState(WANDER_MEMORY_QUERY_KEYS.models)?.status).toBe('success');

    const backends = renderHook(() => useWanderMemoryBackends(), { wrapper: wrapperFor(qc) });
    await waitFor(() => expect(backends.result.current.isSuccess).toBe(true));
    expect(backends.result.current.data?.devices.length).toBeGreaterThan(0);
    expect(qc.getQueryState(WANDER_MEMORY_QUERY_KEYS.backends)?.status).toBe('success');
  });
});

// ── mutations: call the client + invalidate list/search ─────────────────────

describe('wander-memory mutation hooks', () => {
  it('useWanderMemoryAdd calls addMemory and invalidates list + search', async () => {
    const client = setDemoClient();
    const addSpy = vi.spyOn(client, 'addMemory');
    const qc = createTestQueryClient();
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useWanderMemoryAdd(), { wrapper: wrapperFor(qc) });

    await act(async () => {
      const res = await result.current.mutateAsync({ text: '海盐咖啡是用户的独特偏好' });
      expect(res.collision.stored_new).toBe(true);
    });

    expect(addSpy).toHaveBeenCalledWith('海盐咖啡是用户的独特偏好', undefined);
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['wander-memory', 'list'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['wander-memory', 'search'] });
  });

  it('useWanderMemoryDelete calls delete and invalidates list + search', async () => {
    const client = setDemoClient();
    const { memory } = await client.addMemory('临时记忆，稍后删除');
    const deleteSpy = vi.spyOn(client, 'delete');
    const qc = createTestQueryClient();
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useWanderMemoryDelete(), { wrapper: wrapperFor(qc) });

    await act(async () => {
      await result.current.mutateAsync({ id: memory.id });
    });

    expect(deleteSpy).toHaveBeenCalledWith(memory.id);
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['wander-memory', 'list'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['wander-memory', 'search'] });
  });

  it('useWanderMemoryDialogue calls addDialogue and invalidates list + search', async () => {
    const client = setDemoClient();
    const dialogueSpy = vi.spyOn(client, 'addDialogue');
    const qc = createTestQueryClient();
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useWanderMemoryDialogue(), { wrapper: wrapperFor(qc) });

    const transcript = 'A: 今天聊点有趣的。\nB: 好呀，说说看。';
    await act(async () => {
      const res = await result.current.mutateAsync({ dialogue: transcript });
      expect(res.total).toBeGreaterThan(0);
    });

    expect(dialogueSpy).toHaveBeenCalledWith(transcript);
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['wander-memory', 'list'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['wander-memory', 'search'] });
  });

  it('useWanderMemoryChat (non-streaming) calls chat and invalidates list + search', async () => {
    const client = setDemoClient();
    const chatSpy = vi.spyOn(client, 'chat');
    const qc = createTestQueryClient();
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useWanderMemoryChat(), { wrapper: wrapperFor(qc) });

    await act(async () => {
      const res = await result.current.mutateAsync({ query: 'peanuts' });
      expect(res.reply.length).toBeGreaterThan(0);
    });

    expect(chatSpy).toHaveBeenCalledWith('peanuts');
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['wander-memory', 'list'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['wander-memory', 'search'] });
  });

  it('useWanderMemoryMaintenance calls maintenance and invalidates list + search', async () => {
    const client = setDemoClient();
    const maintenanceSpy = vi.spyOn(client, 'maintenance');
    const qc = createTestQueryClient();
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useWanderMemoryMaintenance(), { wrapper: wrapperFor(qc) });

    await act(async () => {
      const res = await result.current.mutateAsync();
      expect(res.errors).toEqual([]);
    });

    expect(maintenanceSpy).toHaveBeenCalledOnce();
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['wander-memory', 'list'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['wander-memory', 'search'] });
  });
});

// ── chat stream controller (plan B.6) ───────────────────────────────────────

describe('useWanderMemoryChatStream', () => {
  it('streams deltas into the assistant message and finalizes with reply + grounding', async () => {
    setDemoClient();
    const { result } = renderHook(() => useWanderMemoryChatStream(), {
      wrapper: wrapperFor(createTestQueryClient()),
    });

    act(() => result.current.send('peanuts'));
    expect(result.current.isStreaming).toBe(true);

    await waitFor(
      () => {
        const messages = chatStore.get(wanderMemoryChatMessagesAtom);
        expect(messages.length).toBe(2);
        expect(messages[0]).toMatchObject({ role: 'user', text: 'peanuts' });
        expect(messages[1]?.streaming).toBe(false);
        expect(messages[1]?.error).toBeUndefined();
      },
      { timeout: 8000 },
    );

    const [user, assistant] = chatStore.get(wanderMemoryChatMessagesAtom);
    expect(user.role).toBe('user');
    expect(assistant.role).toBe('assistant');
    expect(assistant.text.length).toBeGreaterThan(0);
    expect(assistant.groundedCount).toBeGreaterThan(0);
    expect(assistant.groundedSnippets?.length).toBe(assistant.groundedCount);
    expect(Array.isArray(assistant.dreamed)).toBe(true);
    expect(result.current.isStreaming).toBe(false);
  });

  it('cancel() marks the last message [cancelled] and later deltas are dropped', async () => {
    setDemoClient();
    const { result } = renderHook(() => useWanderMemoryChatStream(), {
      wrapper: wrapperFor(createTestQueryClient()),
    });

    act(() => result.current.send('peanuts'));

    // Wait until at least a few deltas arrived (demo emits words every 24 ms).
    await waitFor(
      () => {
        const messages = chatStore.get(wanderMemoryChatMessagesAtom);
        expect(messages.length).toBe(2);
        expect(messages[1]?.text.length).toBeGreaterThan(5);
      },
      { timeout: 8000 },
    );

    act(() => result.current.cancel());

    let messages = chatStore.get(wanderMemoryChatMessagesAtom);
    expect(messages[1]?.streaming).toBe(false);
    expect(messages[1]?.text.endsWith(' [cancelled]')).toBe(true);
    expect(result.current.isStreaming).toBe(false);
    const textAfterCancel = messages[1]?.text;

    // The server generation keeps running (not cancellable), but its deltas /
    // finalize must never touch the transcript again.
    await new Promise((resolve) => setTimeout(resolve, 1600));
    messages = chatStore.get(wanderMemoryChatMessagesAtom);
    expect(messages[1]?.text).toBe(textAfterCancel);
    expect(messages[1]?.streaming).toBe(false);
    expect(messages[1]?.error).toBeUndefined();
  });

  it('sets the typed ApiError on the last message when the stream fails', async () => {
    clientState.__setClient({
      mode: 'demo',
      streamingAvailable: () => true,
      chatStream: () =>
        Promise.reject(new ApiError('llm_unavailable', 'LLM server unavailable', null)),
      chat: () => Promise.reject(new ApiError('llm_unavailable', 'LLM server unavailable', null)),
    } as unknown as WanderMemoryClient);
    const { result } = renderHook(() => useWanderMemoryChatStream(), {
      wrapper: wrapperFor(createTestQueryClient()),
    });

    act(() => result.current.send('peanuts'));

    await waitFor(
      () => {
        const messages = chatStore.get(wanderMemoryChatMessagesAtom);
        expect(messages[1]?.streaming).toBe(false);
        expect(messages[1]?.error).toBeInstanceOf(ApiError);
      },
      { timeout: 5000 },
    );

    const [, assistant] = chatStore.get(wanderMemoryChatMessagesAtom);
    expect(assistant.error?.code).toBe('llm_unavailable');
    expect(assistant.error?.message).toBe('LLM server unavailable');
    expect(result.current.isStreaming).toBe(false);
  });

  it('shows the friendly no-grounding message when the reply is empty (server cancel)', async () => {
    // Simulate the real backend's chat_cancel_on_no_grounding behaviour: the
    // done frame carries an empty reply + empty grounding (no_grounding).
    clientState.__setClient({
      mode: 'demo',
      streamingAvailable: () => true,
      chatStream: (_query: string, onDelta?: (d: string) => void) => {
        onDelta?.('');
        return Promise.resolve<ChatResponse>({
          reply: '',
          dreamed_keywords: ['无关', '关键词'],
          grounded_memories: [],
        });
      },
      chat: async () => ({ reply: '', dreamed_keywords: [], grounded_memories: [] }),
    } as unknown as WanderMemoryClient);
    const { result } = renderHook(() => useWanderMemoryChatStream(), {
      wrapper: wrapperFor(createTestQueryClient()),
    });

    act(() => result.current.send('peanuts'));

    await waitFor(
      () => {
        const messages = chatStore.get(wanderMemoryChatMessagesAtom);
        expect(messages[1]?.streaming).toBe(false);
        expect(messages[1]?.error).toBeUndefined();
      },
      { timeout: 5000 },
    );

    const [, assistant] = chatStore.get(wanderMemoryChatMessagesAtom);
    expect(assistant.text).toBe(NO_GROUNDING_MESSAGE);
    expect(assistant.groundedCount).toBe(0);
    expect(assistant.dreamed).toEqual(['无关', '关键词']);
    expect(result.current.isStreaming).toBe(false);
  });

  it('falls back to non-streaming chat() when streaming is unavailable', async () => {
    const chat = vi.fn(async (query: string): Promise<ChatResponse> => ({
      reply: `fallback reply for ${query}`,
      dreamed_keywords: [],
      grounded_memories: [],
    }));
    clientState.__setClient(restOnlyClient(chat));
    const { result } = renderHook(() => useWanderMemoryChatStream(), {
      wrapper: wrapperFor(createTestQueryClient()),
    });

    act(() => result.current.send('peanuts'));

    await waitFor(
      () => {
        const messages = chatStore.get(wanderMemoryChatMessagesAtom);
        expect(messages[1]?.streaming).toBe(false);
        expect(messages[1]?.text).toBe('fallback reply for peanuts');
      },
      { timeout: 5000 },
    );

    expect(chat).toHaveBeenCalledWith('peanuts');
    const [, assistant] = chatStore.get(wanderMemoryChatMessagesAtom);
    expect(assistant.groundedCount).toBe(0);
    expect(assistant.error).toBeUndefined();
  });

  it('send() is a no-op while a stream is already running', async () => {
    setDemoClient();
    const { result } = renderHook(() => useWanderMemoryChatStream(), {
      wrapper: wrapperFor(createTestQueryClient()),
    });

    act(() => result.current.send('peanuts'));
    act(() => result.current.send('quantum entanglement'));

    // The second send was dropped — only one user message.
    const messages = chatStore.get(wanderMemoryChatMessagesAtom);
    expect(messages.filter((m) => m.role === 'user').map((m) => m.text)).toEqual(['peanuts']);
    await waitFor(
      () => expect(result.current.isStreaming).toBe(false),
      { timeout: 8000 },
    );
  });
});
