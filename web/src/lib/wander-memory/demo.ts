// ─────────────────────────────────────────────────────────────────────────────
// wander-memory/demo.ts — DemoWanderMemoryClient: an in-browser simulation of
// the MemOS memory service, ported from WanderMemory `web/app/src/api/demo.ts`.
// Implements the SAME contract (response envelopes, collision summaries,
// delta/done streaming) so the UI is fully exercisable without the backend.
// All demo data lives in memory only — nothing is persisted (§9 checklist:
// no memory content is cached client-side).
// ─────────────────────────────────────────────────────────────────────────────

import { ApiError } from './errors';
import type { WanderMemoryClient } from './client';
import type {
  AddDialogueResponse,
  AddMemoryResponse,
  BackendsResponse,
  ChatResponse,
  CollisionSummary,
  ContextResponse,
  GetMemoryResponse,
  HealthResponse,
  MaintenanceResponse,
  MemoryItem,
  ModelsResponse,
  SearchResponse,
} from './types';

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function shortId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

const SEED: Array<{ memory: string; metadata: Record<string, unknown> }> = [
  { memory: '用户喜欢在手冲咖啡里加一小撮海盐，说这样能压住浅烘豆的酸味。', metadata: { type: 'preference', updated_at: '2026-07-28T09:14:00Z' } },
  { memory: 'The user is allergic to peanuts (花生) — always check ingredient lists when suggesting recipes.', metadata: { type: 'fact', updated_at: '2026-07-29T15:02:00Z' } },
  { memory: 'Weekly sync with the memory-system team moved to Tuesdays 10:30, effective August.', metadata: { type: 'event', updated_at: '2026-07-30T11:47:00Z' } },
  { memory: '用户正在读《追忆似水年华》第三卷，进度大约在“盖尔芒特家那边”。', metadata: { type: 'note', updated_at: '2026-08-01T21:33:00Z' } },
  { memory: 'Preferred code style: strict TypeScript, no frameworks for small tools, stdlib-first.', metadata: { type: 'preference', updated_at: '2026-08-02T08:05:00Z' } },
  { memory: 'The local memory API binds 127.0.0.1:18400 (REST) and 127.0.0.1:18401 (WebSocket).', metadata: { type: 'fact', updated_at: '2026-08-03T13:58:00Z' } },
];

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    // drop single-char latin tokens (noise); keep single CJK chars (meaningful)
    .filter((t) => t.length > 1 || /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(t));
}

export class DemoWanderMemoryClient implements WanderMemoryClient {
  readonly mode = 'demo' as const;
  private store = new Map<string, MemoryItem>();

  constructor() {
    for (const s of SEED) {
      const id = shortId();
      this.store.set(id, { id, memory: s.memory, metadata: s.metadata });
    }
  }

  streamingAvailable(): boolean {
    return true; // demo simulates the WS stream
  }

  /** No socket in demo mode — subscribe returns a no-op unsubscribe. */
  onWsStateChange(_listener: (s: import('./ws').ConnectionState) => void): () => void {
    return () => {};
  }

  async health(): Promise<HealthResponse> {
    await delay(120);
    return { status: 'ok', backends: { cuda: true, vulkan: true }, model: 'demo-llm-9B (simulated)' };
  }

  async backends(): Promise<BackendsResponse> {
    await delay(80);
    return {
      devices: [
        { backend: 'cuda', index: 0, name: 'Simulated GPU 0', total_mib: 24576 },
        { backend: 'vulkan', index: 0, name: 'Simulated iGPU', total_mib: 8192 },
      ],
    };
  }

  async models(): Promise<ModelsResponse> {
    await delay(80);
    return { model: 'demo-llm-9B (simulated)', reasoning: 'off' };
  }

  private score(query: string, item: MemoryItem): number {
    const qTokens = tokenize(query);
    if (qTokens.length === 0) return 0;
    const hay = item.memory.toLowerCase();
    let hits = 0;
    for (const t of qTokens) if (hay.includes(t)) hits += 1;
    return hits / qTokens.length;
  }

  private simulateCollision(text: string): CollisionSummary {
    // naive duplicate/near-duplicate detection to exercise the collision UI
    const tokens = tokenize(text);
    for (const [id, item] of this.store) {
      const existing = tokenize(item.memory);
      const overlap = tokens.filter((t) => existing.includes(t)).length;
      const ratio = tokens.length ? overlap / tokens.length : 0;
      if (ratio > 0.85) {
        this.store.delete(id); // superseded
        return { deleted: 1, merged: 0, stored_new: false, reason: 'near-duplicate of an existing memory (demo simulation)' };
      }
      if (ratio > 0.6) {
        this.store.delete(id);
        return { deleted: 1, merged: 1, stored_new: true, reason: 'merged with a related memory (demo simulation)' };
      }
    }
    return { deleted: 0, merged: 0, stored_new: true, reason: 'no conflicting memories' };
  }

  async addMemory(text: string, metadata?: Record<string, unknown>): Promise<AddMemoryResponse> {
    if (!text.trim()) throw new ApiError('bad_request', "field 'text' must be a non-empty string", 400);
    await delay(500); // 0–1 LLM calls on the real path
    const collision = this.simulateCollision(text);
    const id = shortId();
    const memory: MemoryItem = {
      id,
      memory: text,
      metadata: { ...(metadata ?? {}), updated_at: new Date().toISOString() },
    };
    if (collision.stored_new) this.store.set(id, memory);
    return { memory, collision };
  }

  async addDialogue(dialogue: string): Promise<AddDialogueResponse> {
    if (!dialogue.trim()) throw new ApiError('bad_request', "field 'dialogue' must be a non-empty string", 400);
    await delay(1400); // longest path: extraction + N collision calls
    // demo extraction: split into utterances, keep the "memorable" ones
    let lines: string[];
    try {
      const parsed = JSON.parse(dialogue) as Array<{ role: string; content: string }>;
      lines = Array.isArray(parsed) ? parsed.map((m) => `${m.role}: ${m.content}`) : [dialogue];
    } catch {
      lines = dialogue.split(/\n+/).map((l) => l.trim()).filter(Boolean);
    }
    const extracted = lines.filter((l) => l.length > 12).slice(0, 4);
    const stored: MemoryItem[] = [];
    const collisions: CollisionSummary[] = [];
    for (const line of extracted) {
      const collision = this.simulateCollision(line);
      const id = shortId();
      const item: MemoryItem = {
        id,
        memory: line,
        metadata: { type: 'dialogue', updated_at: new Date().toISOString() },
      };
      if (collision.stored_new) this.store.set(id, item);
      stored.push(item);
      collisions.push(collision);
    }
    return { stored, collisions, total: this.store.size };
  }

  async search(query: string, topK?: number): Promise<SearchResponse> {
    await delay(150);
    const k = topK ?? 5;
    const scored = [...this.store.values()]
      .map((item) => ({ item, s: this.score(query, item) }))
      .filter((r) => r.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, k);
    return { results: scored.map((r) => r.item) };
  }

  async list(): Promise<SearchResponse> {
    await delay(120);
    return { results: [...this.store.values()].reverse() };
  }

  async get(id: string): Promise<GetMemoryResponse> {
    await delay(80);
    const memory = this.store.get(id);
    if (!memory) throw new ApiError('not_found', `no memory with id '${id}'`, 404);
    return { memory };
  }

  async delete(id: string): Promise<void> {
    await delay(100);
    if (!this.store.delete(id)) throw new ApiError('not_found', `no memory with id '${id}'`, 404);
  }

  async context(query: string, topK?: number): Promise<ContextResponse> {
    const { results } = await this.search(query, topK);
    if (results.length === 0) return { context: '' };
    const date = new Date().toISOString().slice(0, 10);
    const lines = results.map((r) => `- ${r.memory}`);
    return { context: `[memory recall — ${date}]\n${lines.join('\n')}` };
  }

  /** Deterministic demo keyword generation: the store's most common tokens
   *  across a few seed memories (4 keywords) — an in-browser stand-in for
   *  the merged chat keyword step (backend: CHAT_KEYWORDS_PROMPT). */
  private dreamKeywords(): string[] {
    const freq = new Map<string, number>();
    for (const item of [...this.store.values()].slice(0, 4)) {
      for (const t of tokenize(item.memory)) {
        freq.set(t, (freq.get(t) ?? 0) + 1);
      }
    }
    return [...freq.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 4)
      .map(([t]) => t);
  }

  private composeReply(query: string): ChatResponse {
    const k = 3;
    const scored = [...this.store.values()]
      .map((item) => ({ item, s: this.score(query, item) }))
      .filter((r) => r.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, k);
    if (scored.length === 0) {
      const dreamed = this.dreamKeywords();
      if (dreamed.length === 0) {
        // store is empty — keep the "nothing relevant" message
        return {
          reply: `I searched the memory store for “${query}” but nothing relevant came up. Add a few memories first (or import a dialogue) and ask again — the recall path is lexical, so exact words matter.`,
          dreamed_keywords: [],
          grounded_memories: [],
        };
      }
      // simulate keyword recall: re-score the store against the keywords
      const reScored = [...this.store.values()]
        .map((item) => ({
          item,
          s: dreamed.reduce((acc, kw) => acc + (item.memory.toLowerCase().includes(kw) ? 1 : 0), 0) / dreamed.length,
        }))
        .filter((r) => r.s > 0)
        .sort((a, b) => b.s - a.s)
        .slice(0, k);
      const bullets = reScored.map((r) => `• ${r.item.memory}`).join('\n');
      return {
        reply: `Based on what I remember (search keywords: ${dreamed.join(' · ')}):\n${bullets}`,
        dreamed_keywords: dreamed,
        grounded_memories: reScored.map((r) => r.item),
      };
    }
    const bullets = scored.map((r) => `• ${r.item.memory}`).join('\n');
    return {
      reply: `Based on what I remember:\n${bullets}\n\nSo, regarding “${query}” — the entries above are the most relevant ones in the store right now.`,
      dreamed_keywords: [],
      grounded_memories: scored.map((r) => r.item),
    };
  }

  async chat(query: string): Promise<ChatResponse> {
    if (!query.trim()) throw new ApiError('bad_request', "field 'query' must be a non-empty string", 400);
    await delay(900);
    return this.composeReply(query);
  }

  /** Simulated delta/done streaming — the done reply is authoritative (§5.3). */
  async chatStream(query: string, onDelta: (delta: string) => void): Promise<ChatResponse> {
    if (!query.trim()) throw new ApiError('bad_request', "field 'query' must be a non-empty string", 400);
    await delay(400);
    const result = this.composeReply(query);
    const words = result.reply.split(/(?<=\s)/); // keep whitespace attached
    for (const w of words) {
      await delay(24);
      onDelta(w);
    }
    return result;
  }

  async maintenance(): Promise<MaintenanceResponse> {
    await delay(600);
    return { total: this.store.size, errors: [] };
  }
}
