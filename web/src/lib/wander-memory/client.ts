// ─────────────────────────────────────────────────────────────────────────────
// wander-memory/client.ts — the unified WanderMemoryClient interface used by
// every view, plus the singleton accessors. Two implementations:
//   MemOsLiveClient — MemOsRestClient + MemOsWsClient against the real MemOS
//                     server (REST 18400 / WS 18401 / FS 18402, port-shift
//                     aware via the endpoints module)
//   DemoWanderMemoryClient — in-browser simulation (./demo.ts)
// The interface is backend-agnostic; a future Hermes-native adapter can
// implement it without touching any view.
// ─────────────────────────────────────────────────────────────────────────────

import type {
  AddDialogueResponse,
  AddMemoryResponse,
  BackendsResponse,
  ChatResponse,
  ContextResponse,
  GetMemoryResponse,
  HealthResponse,
  MaintenanceResponse,
  ModelsResponse,
  SearchResponse,
} from './types';
import { MemOsRestClient } from './rest';
import { MemOsWsClient, type ConnectionState } from './ws';
import { resolveEndpoints, resolveEndpointsAsync, type WanderMemoryEndpoints } from './endpoints';

export interface WanderMemoryClient {
  readonly mode: 'live' | 'demo';
  health(): Promise<HealthResponse>;
  backends(): Promise<BackendsResponse>;
  models(): Promise<ModelsResponse>;
  addDialogue(dialogue: string): Promise<AddDialogueResponse>;
  addMemory(text: string, metadata?: Record<string, unknown>): Promise<AddMemoryResponse>;
  search(query: string, topK?: number): Promise<SearchResponse>;
  list(): Promise<SearchResponse>;
  get(id: string): Promise<GetMemoryResponse>;
  delete(id: string): Promise<void>;
  context(query: string, topK?: number): Promise<ContextResponse>;
  chat(query: string): Promise<ChatResponse>;
  maintenance(): Promise<MaintenanceResponse>;
  /** Streaming chat. Implementations without a socket simulate deltas. */
  chatStream(query: string, onDelta: (delta: string) => void): Promise<ChatResponse>;
  /** Whether WS streaming is available right now. */
  streamingAvailable(): boolean;
  onWsStateChange?(listener: (s: ConnectionState) => void): () => void;
  dispose?(): void;
}

export class MemOsLiveClient implements WanderMemoryClient {
  readonly mode = 'live' as const;
  readonly rest: MemOsRestClient;
  readonly ws: MemOsWsClient;

  constructor(rest: MemOsRestClient, ws: MemOsWsClient) {
    this.rest = rest;
    this.ws = ws;
    this.ws.connect();
  }

  streamingAvailable(): boolean {
    return this.ws.connectionState === 'open';
  }

  onWsStateChange(listener: (s: ConnectionState) => void): () => void {
    return this.ws.onStateChange(listener);
  }

  dispose(): void {
    this.ws.disconnect();
  }

  health() {
    return this.rest.health();
  }
  backends() {
    return this.rest.backends();
  }
  models() {
    return this.rest.models();
  }
  addDialogue(dialogue: string) {
    return this.rest.addDialogue(dialogue);
  }
  addMemory(text: string, metadata?: Record<string, unknown>) {
    return this.rest.addMemory(text, metadata);
  }
  search(query: string, topK?: number) {
    return this.rest.search(query, topK);
  }
  list() {
    return this.rest.list();
  }
  get(id: string) {
    return this.rest.get(id);
  }
  delete(id: string) {
    return this.rest.delete(id);
  }
  context(query: string, topK?: number) {
    return this.rest.context(query, topK);
  }
  chat(query: string) {
    return this.rest.chat(query);
  }
  maintenance() {
    return this.rest.maintenance();
  }

  /** WS streaming chat with automatic REST fallback (§6.4). */
  async chatStream(query: string, onDelta: (delta: string) => void): Promise<ChatResponse> {
    if (this.ws.connectionState === 'open') {
      return this.ws.chatStream(query, onDelta);
    }
    return this.rest.chat(query);
  }
}

/**
 * Factory: build a live MemOS client (rest + ws, ws.connect()) from explicit
 * endpoints or the sync resolution (env → ui-store → defaults).
 */
export function createMemOsClient(eps?: WanderMemoryEndpoints): WanderMemoryClient {
  const resolved = eps ?? resolveEndpoints();
  return new MemOsLiveClient(
    new MemOsRestClient(resolved.apiOrigin),
    new MemOsWsClient(resolved.wsUrl),
  );
}

let singleton: WanderMemoryClient | null = null;

/** Sync singleton accessor — endpoints from env/ui-store/defaults. */
export function getWanderMemoryClient(): WanderMemoryClient {
  if (!singleton) singleton = createMemOsClient();
  return singleton;
}

/** Async singleton accessor — applies port-shift discovery first. */
export async function getWanderMemoryClientAsync(): Promise<WanderMemoryClient> {
  const eps = await resolveEndpointsAsync();
  singleton?.dispose?.();
  singleton = createMemOsClient(eps);
  return singleton;
}

/** Dispose the current singleton and replace it (or create a fresh default). */
export function resetWanderMemoryClient(next?: WanderMemoryClient | null): WanderMemoryClient {
  singleton?.dispose?.();
  singleton = next ?? createMemOsClient();
  return singleton;
}

/** Test hook: drop the singleton without disposing (e.g. after a disposed stub). */
export function __resetWanderMemoryClientForTests(): void {
  singleton = null;
}
