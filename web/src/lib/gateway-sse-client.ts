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
 * - **Reconnect**: native EventSource handles browser-side retries; the
 *   Tauri proxy path adds explicit backoff, wake recovery, and a short grace
 *   window so transient stream drops do not immediately fail an active turn.
 * - **Heartbeat**: server emits SSE `: ping` comments; browser holds the
 *   connection open transparently. No timer in client code.
 * - **Half-open TCP after sleep**: each POST is a fresh fetch — failure
 *   shows up immediately on the next call rather than 40 s later via
 *   missed heartbeat. EventSource also notices the drop and reconnects.
 * - **Pending RPCs across reconnect**: async RPC responses still arrive over
 *   SSE. A brief proxy drop keeps them pending through a short reconnect
 *   grace window; a sustained outage rejects them so the UI can fail clearly.
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

const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 30_000;
const DISCONNECT_GRACE_MS = 12_000;

const WAKE_WATCHDOG_INTERVAL_MS = 2_000;
const WAKE_GAP_THRESHOLD_MS = 15_000;

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

interface TauriSseDataPayload {
  connectionId?: string;
  data: string;
}

interface TauriSseErrorPayload {
  connectionId?: string;
  message: string;
}

function isAsyncAck(result: unknown): result is RpcAsyncAck {
  return (
    typeof result === "object" &&
    result !== null &&
    (result as RpcAsyncAck).accepted === true &&
    (result as RpcAsyncAck).async === true
  );
}

function createTauriConnectionId(): string {
  return `sse-${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffffff).toString(16)}`;
}

function unwrapTauriSseDataPayload(payload: unknown): TauriSseDataPayload | null {
  if (typeof payload === "string") {
    try {
      const parsed = JSON.parse(payload);
      if (
        parsed &&
        typeof parsed === "object" &&
        typeof parsed.data === "string"
      ) {
        return {
          connectionId:
            typeof parsed.connectionId === "string" ? parsed.connectionId : undefined,
          data: parsed.data,
        };
      }
    } catch {}
    return { data: payload };
  }
  if (
    payload &&
    typeof payload === "object" &&
    typeof (payload as { data?: unknown }).data === "string"
  ) {
    const typed = payload as { connectionId?: unknown; data: string };
    return {
      connectionId: typeof typed.connectionId === "string" ? typed.connectionId : undefined,
      data: typed.data,
    };
  }
  return null;
}

function unwrapTauriSseErrorPayload(payload: unknown): TauriSseErrorPayload {
  if (typeof payload === "string") {
    try {
      const parsed = JSON.parse(payload);
      if (parsed && typeof parsed === "object") {
        return {
          connectionId:
            typeof parsed.connectionId === "string" ? parsed.connectionId : undefined,
          message:
            typeof parsed.message === "string" ? parsed.message : String(payload),
        };
      }
    } catch {}
    return { message: payload };
  }
  if (payload && typeof payload === "object") {
    const typed = payload as { connectionId?: unknown; message?: unknown };
    return {
      connectionId: typeof typed.connectionId === "string" ? typed.connectionId : undefined,
      message: typeof typed.message === "string" ? typed.message : String(typed.message ?? ""),
    };
  }
  return { message: String(payload ?? "") };
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
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private disconnectGraceTimer: ReturnType<typeof setTimeout> | null = null;
  private wakeWatchdogTimer: ReturnType<typeof setInterval> | null = null;
  private lastWakeTickAt = 0;
  private boundOnlineHandler: (() => void) | null = null;
  private boundVisibilityHandler: (() => void) | null = null;
  private unsubscribeSystemResume: (() => void) | null = null;
  private wakeListenersInstalled = false;
  private activeTauriConnectionId: string | null = null;
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

    let syncConnectFailed = false;
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
        syncConnectFailed = true;
        this.setState("error");
        this.connectPromise = null;
        const error = err instanceof Error ? err : new Error(String(err));
        reject(error);
        this.scheduleReconnect("eventsource-constructor");
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
        this.scheduleReconnect("connect-timeout");
      }, connectTimeoutMs);

      const finishConnect = () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        this.connectPromise = null;
        this.clearDisconnectGrace();
        this.reconnectAttempts = 0;
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
            this.scheduleReconnect("closed-during-connect");
            return;
          }
          this.handleStreamClosed("SSE connection closed");
          return;
        }
        // Transient — browser is reconnecting on its own.
        if (this._state === "open") this.setState("connecting");
      };
    });

    if (!syncConnectFailed) this.connectPromise = promise;
    return promise;
  }

  forceReconnect(_reason?: string): void {
    if (this.intentionalClose) return;
    this.cancelReconnect();
    this.reconnectAttempts = 0;
    this.tearDownEventSource({ preserveClientId: true });
    this.setState("closed");
    this.emitDisconnect();
    if (this.autoReconnect) {
      this.connect().catch(() => {});
    }
  }

  enableAutoReconnect(): void {
    this.autoReconnect = true;
    this.installWakeListeners();
  }

  disableAutoReconnect(): void {
    this.autoReconnect = false;
    this.cancelReconnect();
    this.clearDisconnectGrace();
    this.removeWakeListeners();
  }

  close(): void {
    this.intentionalClose = true;
    this.cancelReconnect();
    this.clearDisconnectGrace();
    this.removeWakeListeners();
    this.tearDownEventSource();
    this.setState("idle");
  }

  private tearDownEventSource(options?: {
    preserveClientId?: boolean;
    rejectPending?: boolean;
    notifyProxy?: boolean;
  }): void {
    const preserveClientId = options?.preserveClientId === true;
    const rejectPending = options?.rejectPending !== false;
    const notifyProxy = options?.notifyProxy !== false;
    const es = this.eventSource;
    const tauriUnlisten = this.tauriUnlisten;
    const tauriErrorUnlisten = this.tauriErrorUnlisten;
    this.eventSource = null;
    this.connectPromise = null;
    if (!preserveClientId) this.clientId = null;
    this.tauriProxyConnected = false;
    this.tauriUnlisten = null;
    this.tauriErrorUnlisten = null;
    this.activeTauriConnectionId = null;
    if (es) {
      try {
        es.close();
      } catch {}
    }
    if (notifyProxy && (tauriUnlisten || tauriErrorUnlisten)) {
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
    if (rejectPending) this.rejectPendingRpcResponses("SSE connection closed");
  }

  private handleStreamClosed(message: string): void {
    if (this.intentionalClose) return;

    this.tearDownEventSource({
      preserveClientId: true,
      rejectPending: false,
      notifyProxy: false,
    });

    if (!this.autoReconnect) {
      this.rejectPendingRpcResponses(message);
      this.emitDisconnect();
      this.setState("closed");
      return;
    }

    // Do not immediately turn the visible assistant message into
    // "连接已断开". The Tauri proxy can briefly drop during sleep/wake,
    // dashboard restart, or old-stream teardown. Keep pending async RPCs alive
    // for a short grace window; if we reconnect with the same client_id, the
    // final JSON-RPC response can still arrive on the new SSE stream.
    this.setState("connecting");
    this.startDisconnectGrace(message);
    this.scheduleReconnect("stream-closed", { immediate: true });
  }

  private startDisconnectGrace(message: string): void {
    if (this.disconnectGraceTimer) return;
    this.disconnectGraceTimer = setTimeout(() => {
      this.disconnectGraceTimer = null;
      if (this._state === "open" || this.intentionalClose) return;
      this.rejectPendingRpcResponses(message);
      this.emitDisconnect();
      this.setState("closed");
    }, DISCONNECT_GRACE_MS);
  }

  private clearDisconnectGrace(): void {
    if (!this.disconnectGraceTimer) return;
    clearTimeout(this.disconnectGraceTimer);
    this.disconnectGraceTimer = null;
  }

  private scheduleReconnect(
    _reason: string,
    options?: { immediate?: boolean },
  ): void {
    if (!this.autoReconnect || this.intentionalClose) return;
    if (this.reconnectTimer) return;
    if (this._state === "open" && this.hasOpenAsyncRpcStream()) return;

    const delay = options?.immediate
      ? 0
      : Math.min(
          RECONNECT_BASE_DELAY_MS * Math.pow(2, this.reconnectAttempts),
          RECONNECT_MAX_DELAY_MS,
        );
    const jitter = options?.immediate ? 0 : delay * 0.2 * Math.random();
    if (!options?.immediate) this.reconnectAttempts += 1;

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.intentionalClose || this._state === "open") return;
      try {
        await runtime.refreshGatewayUrl();
      } catch {}
      this.connect().catch(() => {});
    }, delay + jitter);
  }

  private cancelReconnect(): void {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private installWakeListeners(): void {
    if (this.wakeListenersInstalled) return;
    this.wakeListenersInstalled = true;

    // Tauri currently exposes onSystemResume for compatibility, but older
    // builds did not emit the event. Keep a conservative JS watchdog for SSE;
    // the higher threshold avoids treating ordinary markdown/render stalls as
    // sleep/wake while still recovering half-open proxy streams after resume.
    this.lastWakeTickAt = Date.now();
    this.wakeWatchdogTimer = setInterval(() => {
      const now = Date.now();
      const gap = now - this.lastWakeTickAt;
      this.lastWakeTickAt = now;
      if (gap > WAKE_GAP_THRESHOLD_MS) {
        this.handleWake(`clock-skew ${gap}ms`, true);
      }
    }, WAKE_WATCHDOG_INTERVAL_MS);

    if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
      this.boundOnlineHandler = () => this.handleWake("online", false);
      window.addEventListener("online", this.boundOnlineHandler);
    }
    if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
      this.boundVisibilityHandler = () => {
        if (document.visibilityState === "visible") this.handleWake("visible", false);
      };
      document.addEventListener("visibilitychange", this.boundVisibilityHandler);
    }

    const desktop = typeof window !== "undefined" ? window.hermesDesktop : undefined;
    if (desktop?.onSystemResume) {
      this.unsubscribeSystemResume = desktop.onSystemResume(() =>
        this.handleWake("system-resume", true),
      );
    }
  }

  private removeWakeListeners(): void {
    if (!this.wakeListenersInstalled) return;
    this.wakeListenersInstalled = false;
    if (this.wakeWatchdogTimer) {
      clearInterval(this.wakeWatchdogTimer);
      this.wakeWatchdogTimer = null;
    }
    if (this.boundOnlineHandler && typeof window !== "undefined") {
      window.removeEventListener("online", this.boundOnlineHandler);
      this.boundOnlineHandler = null;
    }
    if (this.boundVisibilityHandler && typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.boundVisibilityHandler);
      this.boundVisibilityHandler = null;
    }
    if (this.unsubscribeSystemResume) {
      this.unsubscribeSystemResume();
      this.unsubscribeSystemResume = null;
    }
  }

  private handleWake(_reason: string, forceful: boolean): void {
    if (!this.autoReconnect || this.intentionalClose) return;
    if (!forceful && this.hasOpenAsyncRpcStream()) return;

    this.cancelReconnect();
    this.reconnectAttempts = 0;

    const hadConnection =
      this.eventSource !== null ||
      this.tauriProxyConnected ||
      this.connectPromise !== null ||
      this.tauriUnlisten !== null ||
      this.tauriErrorUnlisten !== null;

    if (hadConnection) {
      this.tearDownEventSource({ preserveClientId: true, rejectPending: false });
      this.setState("connecting");
      this.startDisconnectGrace("SSE connection closed");
    }

    this.connect().catch(() => {});
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
    if (this.disconnectGraceTimer) return true;
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
    const connectionId = createTauriConnectionId();
    this.activeTauriConnectionId = connectionId;
    const isCurrentConnection = () => this.activeTauriConnectionId === connectionId;
    const timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      if (!isCurrentConnection()) {
        reject(new Error("Tauri SSE proxy connection superseded"));
        return;
      }
      this.connectPromise = null;
      if (!this.disconnectGraceTimer) this.clientId = null;
      this.tauriProxyConnected = false;
      this.activeTauriConnectionId = null;
      try {
        this.tauriUnlisten?.();
      } catch {}
      try {
        this.tauriErrorUnlisten?.();
      } catch {}
      this.tauriUnlisten = null;
      this.tauriErrorUnlisten = null;
      this.setState("error");
      reject(new Error("Tauri SSE proxy connect timeout"));
      this.scheduleReconnect("tauri-connect-timeout");
    }, timeoutMs);

    const settle = (ok: boolean, err?: Error) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      if (!isCurrentConnection()) {
        reject(new Error("Tauri SSE proxy connection superseded"));
        return;
      }
      this.connectPromise = null;
      this.tauriProxyConnected = ok;
      if (ok) {
        this.clearDisconnectGrace();
        this.reconnectAttempts = 0;
        this.setState("open");
        resolve();
      } else {
        if (!this.disconnectGraceTimer) this.clientId = null;
        this.tauriProxyConnected = false;
        this.activeTauriConnectionId = null;
        try {
          this.tauriUnlisten?.();
        } catch {}
        try {
          this.tauriErrorUnlisten?.();
        } catch {}
        this.tauriUnlisten = null;
        this.tauriErrorUnlisten = null;
        this.setState("error");
        reject(err ?? new Error("SSE proxy failed"));
        this.scheduleReconnect("tauri-connect-failed");
      }
    };

    Promise.all([
      import("@tauri-apps/api/core"),
      import("@tauri-apps/api/event"),
    ]).then(async ([{ invoke }, { listen }]) => {
      // Listen for SSE events forwarded by the Rust proxy
      const unlistenData = await listen<unknown>("gateway-sse-event", (event) => {
        const payload = unwrapTauriSseDataPayload(event.payload);
        if (!payload) return;
        if (payload.connectionId && payload.connectionId !== connectionId) return;
        if (this.activeTauriConnectionId && this.activeTauriConnectionId !== connectionId) return;
        try {
          const parsed = JSON.parse(payload.data);
          if (parsed.client_id) {
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
      if (settled || this.intentionalClose || this.activeTauriConnectionId !== connectionId) {
        try {
          unlistenData();
        } catch {}
        return;
      }
      this.tauriUnlisten = unlistenData;

      const unlistenError = await listen<unknown>("gateway-sse-error", (event) => {
        const payload = unwrapTauriSseErrorPayload(event.payload);
        if (payload.connectionId && payload.connectionId !== connectionId) return;
        if (this.activeTauriConnectionId && this.activeTauriConnectionId !== connectionId) return;
        const message = payload.message || "SSE stream ended";
        if (!settled) {
          settle(false, new Error(message));
        } else {
          this.handleStreamClosed("SSE connection closed");
        }
      });
      if (settled || this.intentionalClose || this.activeTauriConnectionId !== connectionId) {
        try {
          unlistenError();
        } catch {}
        try {
          unlistenData();
        } catch {}
        return;
      }
      this.tauriErrorUnlisten = unlistenError;

      await runtime.refreshGatewayUrl();
      if (settled || this.intentionalClose || this.activeTauriConnectionId !== connectionId) return;

      // Start the Rust SSE proxy (returns immediately, streams in background)
      invoke("connect_gateway_sse", {
        input: { clientId: this.clientId, connectionId },
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
