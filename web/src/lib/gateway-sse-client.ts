/**
 * SSE+POST transport for the Hermes gateway dispatcher.
 *
 * Implements the same `GatewayClient` interface that `gateway-client.ts`
 * (WebSocket impl) exposes, so call sites in `use-gateway.ts`, `detail.tsx`,
 * and `debug-install.ts` don't need to change. Selected via
 * `getGatewayClientImpl()` based on the `HERMES_TRANSPORT` env or the
 * `?transport=sse` URL query (see `gateway-factory.ts`).
 *
 * Server side: depends on P-009 (`patches/runtime/P-009-add-sse-post-transport.patch`)
 * which adds `GET /api/v2/events` (SSE) and `POST /api/v2/rpc`.
 *
 * Why this exists
 * ---------------
 * The WebSocket client (`gateway-client.ts`) hand-rolls heartbeat, half-open
 * detection, sleep/wake handling, and a pending-RPC map that has to stay
 * coherent across forced reconnects. SSE+POST sheds all of that:
 *
 * - **Reconnect**: native EventSource handles it. No backoff machinery here.
 * - **Heartbeat**: server emits SSE `: ping` comments; browser holds the
 *   connection open transparently. No timer in client code.
 * - **Half-open TCP after sleep**: each POST is a fresh fetch — failure
 *   shows up immediately on the next call rather than 40 s later via
 *   missed heartbeat. EventSource also notices the drop and reconnects.
 * - **Pending RPCs across reconnect**: there are no long-lived pending
 *   RPCs. POST resolves on the response or rejects on transport error.
 *   A reconnect mid-call simply causes the in-flight fetch to reject
 *   and the caller can retry.
 */

import { parseGatewayEvent, type GatewayEvent } from "@hermes/protocol";
import { runtime } from "./runtime";
import type { GatewayClientLike } from "./gateway-client";

function isTauriProduction(): boolean {
  return (
    typeof window !== "undefined" &&
    !!(window as any).__TAURI_INTERNALS__ &&
    !!window.__HERMES_RUNTIME__?.apiBaseUrl
  );
}

export type ConnectionState = "idle" | "connecting" | "open" | "closed" | "error";

const DEFAULT_RPC_TIMEOUT_MS = 120_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;

// EventSource gives us back-pressure in the form of `readyState`. We layer a
// small client_id rendezvous on top: connect() resolves only after the server
// has assigned a client_id, because the first POST has to carry it.
const CLIENT_ID_RENDEZVOUS_TIMEOUT_MS = DEFAULT_CONNECT_TIMEOUT_MS;

export interface GatewayRequestOptions {
  timeoutMs?: number;
  connectTimeoutMs?: number;
}

export interface GatewayConnectOptions {
  timeoutMs?: number;
}

interface RpcAsyncAck {
  accepted: true;
  async: true;
}

interface PendingRpcResponse {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: number;
}

function isAsyncAck(result: unknown): result is RpcAsyncAck {
  return (
    typeof result === "object" &&
    result !== null &&
    (result as RpcAsyncAck).accepted === true &&
    (result as RpcAsyncAck).async === true
  );
}

const MAX_EARLY_RPC_RESPONSES = 100;

export class GatewaySseClient implements GatewayClientLike {
  private eventSource: EventSource | null = null;
  private clientId: string | null = null;
  private clientIdResolvers: Array<(id: string) => void> = [];
  private connectPromise: Promise<void> | null = null;
  private _state: ConnectionState = "idle";
  private stateListeners = new Set<(s: ConnectionState) => void>();
  private typedListeners = new Map<string, Set<(ev: GatewayEvent) => void>>();
  private anyListeners = new Set<(ev: GatewayEvent) => void>();
  private autoReconnect = false;
  private intentionalClose = false;
  private tauriProxyConnected = false;
  private pendingRpcResponses = new Map<string, PendingRpcResponse>();
  private earlyRpcResponses = new Map<string, any>();

  get state(): ConnectionState {
    return this._state;
  }

  private setState(s: ConnectionState): void {
    if (this._state === s) return;
    this._state = s;
    this.stateListeners.forEach((cb) => {
      try {
        cb(s);
      } catch (err) {
        console.error("[gateway-sse] stateListener threw:", err);
      }
    });
  }

  // --- connection lifecycle ---

  connect(options?: GatewayConnectOptions | number): Promise<void> {
    const tauriProduction = isTauriProduction();
    if (
      (tauriProduction && this.tauriProxyConnected && this.clientId && this._state === "open") ||
      (!tauriProduction &&
        this.eventSource &&
        this.eventSource.readyState === EventSource.OPEN &&
        this.clientId)
    ) {
      return Promise.resolve();
    }
    if (this.connectPromise) return this.connectPromise;

    this.intentionalClose = false;

    const connectTimeoutMs =
      typeof options === "number"
        ? options
        : options?.timeoutMs ?? CLIENT_ID_RENDEZVOUS_TIMEOUT_MS;

    this.setState("connecting");

    const promise = new Promise<void>((resolve, reject) => {
      let settled = false;

      // Tauri production: EventSource can't cross-origin from tauri:// to
      // http://127.0.0.1. Use the Rust SSE proxy instead.
      if (tauriProduction) {
        this.connectViaTauriProxy(connectTimeoutMs, resolve, reject);
        return;
      }

      const url = this.buildEventsUrl();

      let es: EventSource;
      try {
        es = new EventSource(url, { withCredentials: false });
      } catch (err) {
        this.setState("error");
        this.connectPromise = null;
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      this.eventSource = es;

      const timer = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          es.close();
        } catch {}
        this.eventSource = null;
        this.setState("error");
        this.connectPromise = null;
        reject(new Error("SSE connect timeout (no client_id)"));
      }, connectTimeoutMs);

      const finishConnect = () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        this.connectPromise = null;
        this.setState("open");
        resolve();
      };

      // Server emits `event: client_id` as the very first frame. Once we
      // have that, treat the connection as live.
      es.addEventListener("client_id", (raw) => {
        try {
          const data = JSON.parse((raw as MessageEvent).data) as { client_id?: string };
          if (data.client_id) {
            this.clientId = data.client_id;
            // drain anyone waiting for the id (for in-flight requests)
            const waiters = this.clientIdResolvers;
            this.clientIdResolvers = [];
            waiters.forEach((r) => r(data.client_id!));
            finishConnect();
          }
        } catch {
          // ignore
        }
      });

      // Default `message` event: every gateway event arrives here.
      es.onmessage = (raw) => {
        try {
          const frame = JSON.parse(raw.data);
          this.handleFrame(frame);
        } catch {
          this.emit({
            type: "gateway.protocol_error",
            payload: { message: "Malformed SSE frame" },
          });
        }
      };

      es.onerror = () => {
        // EventSource reconnects on its own when readyState !== CLOSED.
        // We only treat CLOSED as terminal here, otherwise transition to
        // "connecting" and let the browser retry.
        if (es.readyState === EventSource.CLOSED) {
          if (!settled) {
            settled = true;
            window.clearTimeout(timer);
            this.eventSource = null;
            this.connectPromise = null;
            this.setState("error");
            reject(new Error("SSE closed during connect"));
            return;
          }
          this.eventSource = null;
          this.clientId = null;
          this.rejectPendingRpcResponses("SSE connection closed");
          this.emitDisconnect();
          this.setState("closed");
          // Browser native reconnect already gave up. If autoReconnect is on,
          // open a new EventSource so we don't sit in "closed" forever.
          if (this.autoReconnect && !this.intentionalClose) {
            // Small delay to avoid busy loop on a hard outage.
            window.setTimeout(() => {
              if (this.intentionalClose || this.eventSource) return;
              this.connect().catch(() => {});
            }, 1_000);
          }
          return;
        }
        // Transient — browser is reconnecting on its own.
        if (this._state === "open") this.setState("connecting");
      };
    });

    this.connectPromise = promise;
    return promise;
  }

  forceReconnect(_reason?: string): void {
    if (this.intentionalClose) return;
    this.tearDownEventSource();
    this.setState("closed");
    this.emitDisconnect();
    if (this.autoReconnect) {
      this.connect().catch(() => {});
    }
  }

  enableAutoReconnect(): void {
    this.autoReconnect = true;
  }

  disableAutoReconnect(): void {
    this.autoReconnect = false;
  }

  close(): void {
    this.intentionalClose = true;
    this.tearDownEventSource();
    this.setState("idle");
  }

  private tearDownEventSource(): void {
    const es = this.eventSource;
    const tauriUnlisten = this.tauriUnlisten;
    const tauriErrorUnlisten = this.tauriErrorUnlisten;
    this.eventSource = null;
    this.clientId = null;
    this.tauriProxyConnected = false;
    this.tauriUnlisten = null;
    this.tauriErrorUnlisten = null;
    if (es) {
      try {
        es.close();
      } catch {}
    }
    if (tauriUnlisten || tauriErrorUnlisten) {
      import("@tauri-apps/api/event")
        .then(({ emit }) => emit("gateway-sse-disconnect"))
        .catch(() => {});
    }
    try {
      tauriUnlisten?.();
    } catch {}
    try {
      tauriErrorUnlisten?.();
    } catch {}
    this.rejectPendingRpcResponses("SSE connection closed");
  }

  // --- events ---

  on(type: string, cb: (ev: GatewayEvent) => void): () => void {
    if (!this.typedListeners.has(type)) this.typedListeners.set(type, new Set());
    const set = this.typedListeners.get(type)!;
    set.add(cb);
    return () => set.delete(cb);
  }

  onAny(cb: (ev: GatewayEvent) => void): () => void {
    this.anyListeners.add(cb);
    return () => this.anyListeners.delete(cb);
  }

  onState(cb: (s: ConnectionState) => void): () => void {
    this.stateListeners.add(cb);
    cb(this._state);
    return () => this.stateListeners.delete(cb);
  }

  private emit(ev: GatewayEvent): void {
    const typed = this.typedListeners.get(ev.type);
    if (typed) {
      typed.forEach((cb) => {
        try {
          cb(ev);
        } catch (err) {
          console.error("[gateway-sse] typed listener threw:", err);
        }
      });
    }
    this.anyListeners.forEach((cb) => {
      try {
        cb(ev);
      } catch (err) {
        console.error("[gateway-sse] any-listener threw:", err);
      }
    });
  }

  private emitDisconnect(): void {
    this.emit({
      type: "gateway.disconnected",
      payload: { message: "SSE connection lost" },
    });
  }

  private handleFrame(frame: any): void {
    const rpcId = this.rpcResponseId(frame);
    if (rpcId) {
      this.handleRpcResponse(rpcId, frame);
      return;
    }

    if (frame?.method === "event" && frame.params) {
      const ev = parseGatewayEvent({
        type: frame.params.type,
        session_id: frame.params.session_id,
        payload: frame.params.payload,
      });
      this.emit(ev);
    }
  }

  private rpcResponseId(frame: any): string | null {
    if (!frame || typeof frame !== "object") return null;
    const id = frame.id;
    if (typeof id !== "string" && typeof id !== "number") return null;
    if (!Object.prototype.hasOwnProperty.call(frame, "result") &&
      !Object.prototype.hasOwnProperty.call(frame, "error")) {
      return null;
    }
    return String(id);
  }

  private handleRpcResponse(id: string, frame: any): void {
    const pending = this.pendingRpcResponses.get(id);
    if (!pending) {
      this.earlyRpcResponses.set(id, frame);
      while (this.earlyRpcResponses.size > MAX_EARLY_RPC_RESPONSES) {
        const oldest = this.earlyRpcResponses.keys().next().value;
        if (!oldest) break;
        this.earlyRpcResponses.delete(oldest);
      }
      return;
    }

    this.pendingRpcResponses.delete(id);
    clearTimeout(pending.timer);
    this.resolveRpcResponseFrame(frame, pending.resolve, pending.reject);
  }

  private resolveRpcResponseFrame(
    frame: any,
    resolve: (value: unknown) => void,
    reject: (error: Error) => void,
  ): void {
    if (frame?.error) {
      const msg = frame.error.message ?? `RPC error ${frame.error.code}`;
      reject(new Error(msg));
      return;
    }
    resolve(frame?.result);
  }

  private waitForAsyncRpcResponse<T>(
    id: string,
    method: string,
    timeoutMs: number,
  ): Promise<T> {
    const early = this.earlyRpcResponses.get(id);
    if (early) {
      this.earlyRpcResponses.delete(id);
      return new Promise<T>((resolve, reject) => {
        this.resolveRpcResponseFrame(early, resolve as (value: unknown) => void, reject);
      });
    }

    if (!this.hasOpenAsyncRpcStream()) {
      return Promise.reject(new Error("SSE connection closed"));
    }

    return new Promise<T>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pendingRpcResponses.delete(id);
        reject(new Error(`RPC timeout waiting for async response: ${method}`));
      }, timeoutMs);
      this.pendingRpcResponses.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
    });
  }

  private rejectPendingRpcResponses(message: string): void {
    for (const [, pending] of this.pendingRpcResponses) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
    }
    this.pendingRpcResponses.clear();
  }

  private hasOpenAsyncRpcStream(): boolean {
    if (!this.clientId) return false;
    if (isTauriProduction()) return this.tauriProxyConnected;
    return !!this.eventSource && this.eventSource.readyState !== EventSource.CLOSED;
  }

  // --- RPC ---

  async request<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    options?: GatewayRequestOptions | number,
  ): Promise<T> {
    const timeoutMs =
      typeof options === "number"
        ? options
        : options?.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
    const connectTimeoutMs =
      typeof options === "number" ? undefined : options?.connectTimeoutMs;

    await this.connect(connectTimeoutMs === undefined ? undefined : { timeoutMs: connectTimeoutMs });

    const id = `s${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffffff).toString(16)}`;
    const body = JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} });

    const controller = new AbortController();
    const abortTimer = window.setTimeout(() => controller.abort(), timeoutMs);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    const token = runtime.getSessionToken();
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
      headers["X-Hermes-Session-Token"] = token;
    }
    if (this.clientId) headers["X-Hermes-Client-Id"] = this.clientId;

    let parsed: any;

    if (isTauriProduction() && window.hermesDesktop?.request) {
      // Route RPC through the Rust IPC proxy (avoids CORS)
      const result = await window.hermesDesktop.request({
        path: "/api/v2/rpc",
        method: "POST",
        headers,
        body,
      });
      window.clearTimeout(abortTimer);
      try {
        parsed = JSON.parse(result.body);
      } catch {
        throw new Error(`RPC ${method} returned non-JSON body (HTTP ${result.status})`);
      }
      if (!result.ok && !parsed?.error) {
        throw new Error(`RPC ${method} HTTP ${result.status}`);
      }
    } else {
      let res: Response;
      try {
        res = await fetch(runtime.getApiUrl("/api/v2/rpc"), {
          method: "POST",
          headers,
          body,
          signal: controller.signal,
        });
      } catch (err) {
        window.clearTimeout(abortTimer);
        if (err instanceof Error && err.name === "AbortError") {
          throw new Error(`RPC timeout: ${method}`);
        }
        throw err instanceof Error ? err : new Error(String(err));
      }
      window.clearTimeout(abortTimer);

      try {
        parsed = await res.json();
      } catch {
        throw new Error(`RPC ${method} returned non-JSON body (HTTP ${res.status})`);
      }
      if (!res.ok && !parsed?.error) {
        throw new Error(`RPC ${method} HTTP ${res.status}`);
      }
    }

    if (parsed?.error) {
      const msg = parsed.error.message ?? `RPC error ${parsed.error.code}`;
      throw new Error(msg);
    }
    if (isAsyncAck(parsed?.result)) {
      return await this.waitForAsyncRpcResponse<T>(id, method, timeoutMs);
    }
    return parsed.result as T;
  }

  // --- helpers ---

  private tauriUnlisten: (() => void) | null = null;
  private tauriErrorUnlisten: (() => void) | null = null;

  private connectViaTauriProxy(
    timeoutMs: number,
    resolve: () => void,
    reject: (err: Error) => void,
  ): void {
    let settled = false;
    const timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      this.connectPromise = null;
      this.setState("error");
      reject(new Error("Tauri SSE proxy connect timeout"));
    }, timeoutMs);

    const settle = (ok: boolean, err?: Error) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      this.connectPromise = null;
      this.tauriProxyConnected = ok;
      if (ok) {
        this.setState("open");
        resolve();
      } else {
        this.setState("error");
        reject(err ?? new Error("SSE proxy failed"));
      }
    };

    Promise.all([
      import("@tauri-apps/api/core"),
      import("@tauri-apps/api/event"),
    ]).then(async ([{ invoke }, { listen }]) => {
      // Listen for SSE events forwarded by the Rust proxy
      this.tauriUnlisten = await listen<string>("gateway-sse-event", (event) => {
        try {
          const parsed = JSON.parse(event.payload);
          if (parsed.client_id && !this.clientId) {
            this.clientId = parsed.client_id;
            const waiters = this.clientIdResolvers;
            this.clientIdResolvers = [];
            waiters.forEach((r) => r(parsed.client_id));
            settle(true);
            return;
          }
          this.handleFrame(parsed);
        } catch {}
      });

      this.tauriErrorUnlisten = await listen<string>("gateway-sse-error", (event) => {
        if (!settled) {
          settle(false, new Error(event.payload));
        } else {
          this.tauriProxyConnected = false;
          this.clientId = null;
          this.rejectPendingRpcResponses("SSE connection closed");
          try {
            this.tauriUnlisten?.();
          } catch {}
          try {
            this.tauriErrorUnlisten?.();
          } catch {}
          this.tauriUnlisten = null;
          this.tauriErrorUnlisten = null;
          this.setState("closed");
          this.emitDisconnect();
          if (this.autoReconnect && !this.intentionalClose) {
            window.setTimeout(() => this.connect().catch(() => {}), 1000);
          }
        }
      });

      await runtime.refreshGatewayUrl();
      if (settled || this.intentionalClose) return;

      // Start the Rust SSE proxy (returns immediately, streams in background)
      invoke("connect_gateway_sse", {
        input: { clientId: this.clientId },
      }).catch((err) => {
        settle(false, new Error(String(err)));
      });
    }).catch((err) => {
      settle(false, err instanceof Error ? err : new Error(String(err)));
    });
  }

  private buildEventsUrl(): string {
    // EventSource can't add custom headers, so the token rides the query
    // string (server: P-009 added /api/v2/events to _PUBLIC_API_PATHS for
    // exactly this reason; the route handler does its own HMAC check).
    const base = runtime.getApiUrl("/api/v2/events");
    const url = new URL(base, window.location.href);
    const token = runtime.getSessionToken();
    if (token) url.searchParams.set("token", token);
    if (this.clientId) url.searchParams.set("client_id", this.clientId);
    return url.toString();
  }
}

let instance: GatewaySseClient | null = null;
export function getGatewaySseClient(): GatewaySseClient {
  if (!instance) instance = new GatewaySseClient();
  return instance;
}
