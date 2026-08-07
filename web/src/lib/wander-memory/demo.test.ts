// demo.test.ts — DemoWanderMemoryClient contract (memory_web_plan.md §6.4).
// The in-browser simulator must expose the same additive trace fields as the
// backend: dreamed_keywords + grounded_memories, ALWAYS present on chat() and
// chatStream() — empty arrays when the keyword generation found nothing. Plus
// the add/search/delete CRUD contract.
import { describe, expect, it } from 'vitest';
import { ApiError } from './errors';
import { DemoWanderMemoryClient } from './demo';

describe('DemoWanderMemoryClient chat keyword simulation', () => {
  it('generates keywords when no lexical match exists and grounds on re-scored memories', async () => {
    const client = new DemoWanderMemoryClient();
    const res = await client.chat('quantum entanglement');
    expect(res.reply).toContain('search keywords');
    expect(res.dreamed_keywords).toBeDefined();
    expect(res.dreamed_keywords!.length).toBeGreaterThan(0);
    expect(Array.isArray(res.grounded_memories)).toBe(true);
  });

  it('returns empty trace fields when a lexical match exists', async () => {
    const client = new DemoWanderMemoryClient();
    const res = await client.chat('peanuts');
    expect(res.reply).toContain('Based on what I remember');
    expect(res.dreamed_keywords).toEqual([]);
    expect(res.grounded_memories!.length).toBeGreaterThan(0);
  });

  it('keeps the nothing-relevant message when the store is empty', async () => {
    const client = new DemoWanderMemoryClient();
    for (const m of (await client.list()).results) await client.delete(m.id);
    const res = await client.chat('anything');
    expect(res.reply).toContain('nothing relevant');
    expect(res.dreamed_keywords).toEqual([]);
    expect(res.grounded_memories).toEqual([]);
  });

  it('chatStream returns the same contract object while streaming deltas', async () => {
    const client = new DemoWanderMemoryClient();
    const deltas: string[] = [];
    const res = await client.chatStream('quantum entanglement', (d) => deltas.push(d));
    expect(deltas.length).toBeGreaterThan(0);
    expect(deltas.join('')).toContain(res.reply.slice(0, 10));
    expect(res.reply).toBeDefined();
    expect(Array.isArray(res.dreamed_keywords)).toBe(true);
    expect(Array.isArray(res.grounded_memories)).toBe(true);
  });
});

describe('DemoWanderMemoryClient CRUD contract', () => {
  it('addMemory stores a new memory and search finds it', async () => {
    const client = new DemoWanderMemoryClient();
    const before = (await client.list()).results.length;
    const { memory, collision } = await client.addMemory('海盐咖啡是用户的独特偏好', { type: 'preference' });
    expect(collision.stored_new).toBe(true);
    expect(memory.memory).toBe('海盐咖啡是用户的独特偏好');
    expect(memory.metadata.updated_at).toBeTypeOf('string');

    const { results } = await client.search('海盐咖啡', 5);
    expect(results.map((r) => r.id)).toContain(memory.id);

    const { memory: fetched } = await client.get(memory.id);
    expect(fetched.id).toBe(memory.id);

    const after = (await client.list()).results.length;
    expect(after).toBe(before + 1);
  });

  it('addMemory rejects an empty text with bad_request', async () => {
    const client = new DemoWanderMemoryClient();
    const err = await client.addMemory('   ').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('bad_request');
    expect(err.status).toBe(400);
  });

  it('simulates a collision: a near-duplicate supersedes the existing memory', async () => {
    const client = new DemoWanderMemoryClient();
    const { collision } = await client.addMemory('The user is allergic to peanuts — always check ingredients.');
    expect(collision.deleted).toBeGreaterThan(0);
    expect(collision.stored_new).toBe(false);
  });

  it('delete removes the memory; deleting it again raises not_found', async () => {
    const client = new DemoWanderMemoryClient();
    const { memory } = await client.addMemory('临时记忆，稍后删除');
    await client.delete(memory.id);
    const err = await client.get(memory.id).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('not_found');
    expect(err.status).toBe(404);
    await expect(client.delete(memory.id)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('chat validates the query and maintenance reports the store size', async () => {
    const client = new DemoWanderMemoryClient();
    const err = await client.chat('').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('bad_request');
    const { total } = await client.maintenance();
    expect(total).toBe((await client.list()).results.length);
  });

  it('reports the demo mode and streaming availability', () => {
    const client = new DemoWanderMemoryClient();
    expect(client.mode).toBe('demo');
    expect(client.streamingAvailable()).toBe(true);
    const unsub = client.onWsStateChange!(() => {});
    expect(typeof unsub).toBe('function');
  });
});
