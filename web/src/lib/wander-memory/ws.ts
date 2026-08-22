// ─────────────────────────────────────────────────────────────────────────────
// wander-memory/ws.ts — MemOsWsClient: the MemOS §4.2 WebSocket protocol,
// ported from WanderMemory `web/app/src/api/ws.ts`. The op vocabulary
// (dialogues.add / memories.* / context.build / chat / maintenance.run /
// backends.list / health / models) is WanderMemory's OWN protocol over
// /v1/ws — deliberately kept separate from the Hermes gateway-client
// (JSON-RPC over /api/ws). Uses the browser WebSocket directly; no extra
// dependency.
//   • request/response correlation via monotonically increasing ids
//   • one async method per op; memories.get/delete take { id } in the payload
//   • streaming chat: delta frames → onDelta, done frame resolves authoritatively
//   • keepalive ping every 25 s; 60 s dead-socket detection
//   • exponential-backoff reconnect (250 ms → 8 s, jittered); pending requests
//     are FAILED, never replayed (writes are not idempotent — §5.3)
// ─────────────────────────────────────────────────────────────────────────────

import { ApiError } from './errors';
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
  WsFrame,
} from './types';

const DEFAULT_WS_URL = 'ws://127.0.0.1:18401/v1/ws';
const PING_INTERVAL_MS = 25_000;
const DEAD_SOCKET_MS = 60_000;
const BACKOFF_MIN_MS = 250;
const BACKOFF_MAX_MS = 8_000;

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (err: ApiError) => void;
  onDelta?: (delta: string) => void;
}

export type ConnectionState = 'connecting' | 'open' | 'closed';

export class MemOsWsClient {
  private socket: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private lastFrameAt = 0;
  private deadTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private state: ConnectionState = 'closed';
  private stateListeners = new Set<(s: ConnectionState) => void>();
  readonly url: string;

  constructor(url: string = DEFAULT_WS_URL) {
    this.url = url;
  }

  get connectionState(): ConnectionState {
    return this.state;
  }

  onStateChange(listener: (s: ConnectionState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  private setState(s: ConnectionState): void {
    this.state = s;
    this.stateListeners.forEach((l) => l(s));
  }

  connect(): void {
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) return;
    this.setState('connecting');
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = ws;

    ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.lastFrameAt = Date.now();
      this.setState('open');
      this.startKeepalive();
    };

    ws.onmessage = (ev: MessageEvent) => {
      this.lastFrameAt = Date.now();
      let frame: WsFrame;
      try {
        frame = JSON.parse(String(ev.data)) as WsFrame;
      } catch {
        console.error('[ws] malformed JSON frame from server:', ev.data);
        return;
      }
      this.handleFrame(frame);
    };

    ws.onclose = () => {
      this.handleSocketDown();
      this.scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose follows onerror in browsers; nothing extra to do here
    };
  }

  disconnect(): void {
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.stopKeepalive();
    this.socket?.close();
    this.handleSocketDown();
  }

  private handleSocketDown(): void {
    this.stopKeepalive();
    this.setState('closed');
    this.socket = null;
    // fail (never replay) pending requests — §5.3
    const err = new ApiError('llm_unavailable', 'websocket connection lost', null);
    this.pending.forEach((p) => p.reject(err));
    this.pending.clear();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;
    const exp = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** this.reconnectAttempts);
    const jittered = exp * (0.75 + Math.random() * 0.5);
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, jittered);
  }

  private startKeepalive(): void {
    this.stopKeepalive();
    this.pingTimer = setInterval(() => {
      if (this.socket?.readyState === WebSocket.OPEN) {
        this.socket.send(JSON.stringify({ type: 'ping' }));
      }
    }, PING_INTERVAL_MS);
    this.deadTimer = setInterval(() => {
      if (this.pending.size > 0 && Date.now() - this.lastFrameAt > DEAD_SOCKET_MS) {
        // dead socket → reconnect + fail pending (§5.3)
        this.socket?.close();
      }
    }, 5_000);
  }

  private stopKeepalive(): void {
    if (this.pingTimer !== null) clearInterval(this.pingTimer);
    if (this.deadTimer !== null) clearInterval(this.deadTimer);
    this.pingTimer = null;
    this.deadTimer = null;
  }

  private handleFrame(frame: WsFrame): void {
    // server-control frames (id: null) — keepalive only
    if ('type' in frame && frame.type === 'pong') return;

    if (frame.id === null) {
      // error frame not correlated to a request — surface verbatim (§5.3)
      if ('ok' in frame && frame.ok === false) {
        console.error('[ws] server error frame:', frame.error);
      }
      return;
    }

    const pendingReq = this.pending.get(frame.id);
    if (!pendingReq) return; // late frame for a cancelled/failed request — discard

    if ('ok' in frame && frame.ok === false) {
      this.pending.delete(frame.id);
      pendingReq.reject(new ApiError(frame.error.code, frame.error.message, null));
      return;
    }

    if ('type' in frame && frame.type === 'delta') {
      // append deltas verbatim for display; the DONE reply is authoritative (§5.3 whitespace caveat)
      pendingReq.onDelta?.(frame.delta);
      return;
    }

    if ('type' in frame && frame.type === 'done') {
      this.pending.delete(frame.id);
      pendingReq.resolve(frame.result);
      return;
    }

    // plain result frame
    this.pending.delete(frame.id);
    pendingReq.resolve((frame as { result: unknown }).result);
  }

  private call<T>(op: string, payload: Record<string, unknown>, onDelta?: (d: string) => void): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
        reject(new ApiError('llm_unavailable', 'websocket not connected', null));
        return;
      }
      const id = this.nextId++;
      this.pending.set(id, {
        resolve: (r) => resolve(r as T),
        reject,
        onDelta,
      });
      this.socket.send(JSON.stringify({ id, op, payload }));
    });
  }

  /** Cancel a pending request client-side (§6.4 — server generation is not cancellable). */
  cancel(id: number): void {
    const p = this.pending.get(id);
    if (p) {
      this.pending.delete(id);
      p.reject(new ApiError('cancelled', 'cancelled client-side', null));
    }
  }

  // ── §4.2 ops — one async method per op ────────────────────────────────────
  health(): Promise<HealthResponse> {
    return this.call('health', {});
  }

  models(): Promise<ModelsResponse> {
    return this.call('models', {});
  }

  backendsList(): Promise<BackendsResponse> {
    return this.call('backends.list', {});
  }

  memoriesAdd(text: string, metadata?: Record<string, unknown>): Promise<AddMemoryResponse> {
    return this.call('memories.add', { text, ...(metadata ? { metadata } : {}) });
  }

  memoriesSearch(query: string, topK?: number): Promise<SearchResponse> {
    return this.call('memories.search', { query, ...(topK !== undefined ? { top_k: topK } : {}) });
  }

  memoriesList(): Promise<SearchResponse> {
    return this.call('memories.list', {});
  }

  /** §4.2 quirk: the id is a PAYLOAD field, not a path segment. */
  memoriesGet(id: string): Promise<GetMemoryResponse> {
    return this.call('memories.get', { id });
  }

  memoriesDelete(id: string): Promise<void> {
    return this.call('memories.delete', { id });
  }

  dialoguesAdd(dialogue: string): Promise<AddDialogueResponse> {
    return this.call('dialogues.add', { dialogue });
  }

  contextBuild(query: string, topK?: number): Promise<ContextResponse> {
    return this.call('context.build', { query, ...(topK !== undefined ? { top_k: topK } : {}) });
  }

  maintenanceRun(): Promise<MaintenanceResponse> {
    return this.call('maintenance.run', {});
  }

  /** Streaming chat — deltas via onDelta; resolves with the done frame's
   *  result (reply + optional keyword/search trace: dreamed_keywords /
   *  grounded_memories). */
  async chatStream(query: string, onDelta: (delta: string) => void): Promise<ChatResponse> {
    return this.call<ChatResponse>('chat', { query, stream: true }, onDelta);
  }
}
