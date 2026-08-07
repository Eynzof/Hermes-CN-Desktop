// wander-memory-chat.test.ts — atom reducer contract (merge plan Appendix B.7):
// append, update-last, clear, update-last no-op on empty, optional fields.
import { createStore } from 'jotai/vanilla';
import { describe, expect, it } from 'vitest';
import { ApiError } from '@/lib/wander-memory/errors';
import {
  addWanderMemoryChatMessageAtom,
  clearWanderMemoryChatAtom,
  updateWanderMemoryLastMessageAtom,
  wanderMemoryChatMessagesAtom,
  type WanderMemoryChatMessage,
} from './wander-memory-chat';

function message(overrides: Partial<WanderMemoryChatMessage> = {}): WanderMemoryChatMessage {
  return { role: 'assistant', text: 'hi', ...overrides };
}

describe('wanderMemoryChat atoms', () => {
  it('addWanderMemoryChatMessageAtom appends messages in order', () => {
    const store = createStore();
    store.set(addWanderMemoryChatMessageAtom, { role: 'user', text: 'hello' });
    store.set(addWanderMemoryChatMessageAtom, message({ text: 'hi there' }));

    expect(store.get(wanderMemoryChatMessagesAtom)).toEqual([
      { role: 'user', text: 'hello' },
      { role: 'assistant', text: 'hi there' },
    ]);
  });

  it('updateWanderMemoryLastMessageAtom updates only the last message', () => {
    const store = createStore();
    store.set(addWanderMemoryChatMessageAtom, { role: 'user', text: 'hello' });
    store.set(addWanderMemoryChatMessageAtom, message({ text: 'old', streaming: true }));

    store.set(updateWanderMemoryLastMessageAtom, (m) => ({
      ...m,
      text: `${m.text} world`,
      streaming: false,
    }));

    const messages = store.get(wanderMemoryChatMessagesAtom);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({ role: 'user', text: 'hello' });
    expect(messages[1]).toEqual({ role: 'assistant', text: 'old world', streaming: false });
  });

  it('updateWanderMemoryLastMessageAtom is a no-op when the transcript is empty', () => {
    const store = createStore();
    expect(() =>
      store.set(updateWanderMemoryLastMessageAtom, (m) => ({ ...m, text: `${m.text}!` })),
    ).not.toThrow();
    expect(store.get(wanderMemoryChatMessagesAtom)).toEqual([]);
  });

  it('clearWanderMemoryChatAtom resets the transcript', () => {
    const store = createStore();
    store.set(addWanderMemoryChatMessageAtom, { role: 'user', text: 'a' });
    store.set(addWanderMemoryChatMessageAtom, message({ text: 'b' }));
    store.set(clearWanderMemoryChatAtom);

    expect(store.get(wanderMemoryChatMessagesAtom)).toEqual([]);
  });

  it('messages carry the dreamed/grounded/error optional fields', () => {
    const store = createStore();
    store.set(addWanderMemoryChatMessageAtom, {
      role: 'assistant',
      text: 'reply',
      dreamed: ['kw1', 'kw2'],
      groundedCount: 2,
      groundedSnippets: ['snippet a', 'snippet b'],
    });
    store.set(
      addWanderMemoryChatMessageAtom,
      message({ text: 'failed', error: new ApiError('llm_unavailable', 'LLM server unavailable', null) }),
    );

    const messages = store.get(wanderMemoryChatMessagesAtom);
    expect(messages[0].dreamed).toEqual(['kw1', 'kw2']);
    expect(messages[0].groundedCount).toBe(2);
    expect(messages[0].groundedSnippets).toEqual(['snippet a', 'snippet b']);
    expect(messages[1].error).toBeInstanceOf(ApiError);
    expect(messages[1].error?.code).toBe('llm_unavailable');
    expect(messages[1].error?.message).toBe('LLM server unavailable');
  });
});
