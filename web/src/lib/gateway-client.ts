import { parseGatewayEvent, type GatewayEvent } from "@hermes/protocol";
import { runtime } from "./runtime";

export type ConnectionState = "idle" | "connecting" | "open" | "closed" | "error";

const DEFAULT_RPC_TIMEOUT_MS = 120_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;

// 对齐官方桌面端(apps/desktop use-gateway-boot.ts):min(15s, 1s·2^min(n,4))。
// 上限压在 15s 还有一个服务端原因:WS 断开后空闲会话只有 20s 回收宽限
// (_WS_ORPHAN_REAP_GRACE_S),首批重试必须落在宽限内。
const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 15_000;
const RECONNECT_EXP_CAP = 4;
const RECONNECT_MAX_ATTEMPTS = Infinity;

const WAKE_WATCHDOG_INTERVAL_MS = 2_000;
// 比 watchdog 间隔大得多——正常 tick 间隔约 2s，超过这个值基本只有
// 进程被冻结过（macOS 睡眠 / OS 节流 / 标签页 background）才会出现。
const WAKE_GAP_THRESHOLD_MS = 5_000;

interface PendingRequest {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface GatewayRequestOptions {
  timeoutMs?: number;
  connectTimeoutMs?: number;
}

export interface GatewayConnectOptions {
  timeoutMs?: number;
}

// 与原生 WebSocket 构造签名一致的工厂。默认直接 new WebSocket;打包态 webview
// 开不了 ws://127.0.0.1 时换成 Rust 中继 socket(gateway-relay-socket.ts),
// 两条路径线协议完全相同,客户端其余逻辑无感。
export type GatewaySocketFactory = (url: string) => WebSocket;

export class GatewayClient {
  private readonly socketFactory: GatewaySocketFactory;

  constructor(socketFactory?: GatewaySocketFactory) {
    this.socketFactory = socketFactory ?? ((url) => new WebSocket(url));
  }

  private ws: WebSocket | null = null;
  private connectPromise: Promise<void> | null = null;
  private _state: ConnectionState = "idle";
  private stateListeners = new Set<(s: ConnectionState) => void>();
  private typedListeners = new Map<string, Set<(ev: GatewayEvent) => void>>();
  private anyListeners = new Set<(ev: GatewayEvent) => void>();
  private pending = new Map<string, PendingRequest>();
  private nextId = 1;
  private abortConnect: (() => void) | null = null;

  private autoReconnect = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalClose = false;

  private wakeWatchdogTimer: ReturnType<typeof setInterval> | null = null;
  private lastWakeTickAt = 0;
  private boundOnlineHandler: (() => void) | null = null;
  private boundVisibilityHandler: (() => void) | null = null;
  private unsubscribeSystemResume: (() => void) | null = null;
  private wakeListenersInstalled = false;

  get state() { return this._state; }

  private setState(s: ConnectionState) {
    if (this._state === s) return;
    this._state = s;
    this.stateListeners.forEach((cb) => cb(s));
  }

  enableAutoReconnect() {
    this.autoReconnect = true;
    this.installWakeListeners();
  }

  disableAutoReconnect() {
    this.autoReconnect = false;
    this.cancelReconnect();
    this.removeWakeListeners();
  }

  connect(options?: GatewayConnectOptions | number): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) return Promise.resolve();
    if (this.connectPromise) return this.connectPromise;

    this.intentionalClose = false;

    const connectTimeoutMs =
      typeof options === "number"
        ? options
        : options?.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;

    let promise: Promise<void>;
    let syncConnectFailed = false;
    promise = new Promise<void>((resolve, reject) => {
      let settled = false;
      let connectTimer: ReturnType<typeof setTimeout> | null = null;
      let ws: WebSocket;
      const isCurrentSocket = () => this.ws === ws;
      const clearConnectTimer = () => {
        if (!connectTimer) return;
        clearTimeout(connectTimer);
        connectTimer = null;
      };
      const clearConnectState = () => {
        clearConnectTimer();
        if (this.connectPromise === promise) {
          this.connectPromise = null;
        }
        this.abortConnect = null;
      };
      const settleOpen = () => {
        if (!isCurrentSocket()) return;
        if (settled) return;
        settled = true;
        clearConnectState();
        this.reconnectAttempts = 0;
        this.setState("open");
        resolve();
      };
      const settleConnectError = (err: Error, state: ConnectionState) => {
        if (settled) return;
        settled = true;
        clearConnectState();
        this.setState(state);
        reject(err);
      };
      const abortConnect = () => {
        settleConnectError(new Error("WebSocket closed"), "idle");
      };
      const rejectPending = (message: string) => {
        this.pending.forEach(({ reject: rej, timer }) => {
          clearTimeout(timer);
          rej(new Error(message));
        });
        this.pending.clear();
      };

      this.setState("connecting");

      try {
        ws = this.socketFactory(runtime.getGatewayUrl());
      } catch (e) {
        syncConnectFailed = true;
        this.connectPromise = null;
        this.setState("error");
        reject(e instanceof Error ? e : new Error(String(e)));
        return;
      }
      this.ws = ws;
      this.abortConnect = abortConnect;

      connectTimer = setTimeout(() => {
        if (!isCurrentSocket()) return;
        if (settled) return;
        this.ws = null;
        try { ws.close(); } catch {}
        settleConnectError(new Error("WebSocket connection timeout"), "error");
        this.scheduleReconnect();
      }, connectTimeoutMs);

      ws.onopen = settleOpen;

      ws.onclose = () => {
        if (!isCurrentSocket()) return;

        this.ws = null;

        if (!settled) {
          settleConnectError(new Error("WebSocket closed"), "closed");
        } else {
          this.setState("closed");
        }

        rejectPending("WebSocket closed");

        if (!this.intentionalClose) {
          this.emitDisconnect();
          this.scheduleReconnect();
        }
      };

      ws.onerror = () => {
        if (!isCurrentSocket()) return;
        this.ws = null;
        if (!settled) {
          settleConnectError(new Error("WebSocket connection failed"), "error");
        } else {
          this.setState("error");
        }
        rejectPending("WebSocket connection failed");
        try { ws.close(); } catch {}
        if (!this.intentionalClose) {
          this.emitDisconnect();
          this.scheduleReconnect();
        }
      };

      ws.onmessage = (ev) => {
        if (!isCurrentSocket()) return;
        try {
          this.handleFrame(JSON.parse(ev.data));
        } catch {
          this.emit({
            type: "gateway.protocol_error",
            payload: { message: "Malformed gateway frame" },
          });
        }
      };
    });

    if (!syncConnectFailed) {
      this.connectPromise = promise;
    }
    return promise;
  }

  private emitDisconnect() {
    this.emit({
      type: "gateway.disconnected",
      payload: { message: "WebSocket connection lost" },
    });
  }

  private scheduleReconnect() {
    if (!this.autoReconnect || this.intentionalClose) return;
    if (this.reconnectTimer) return;
    if (this.reconnectAttempts >= RECONNECT_MAX_ATTEMPTS) return;

    const delay = Math.min(
      RECONNECT_BASE_DELAY_MS * Math.pow(2, Math.min(this.reconnectAttempts, RECONNECT_EXP_CAP)),
      RECONNECT_MAX_DELAY_MS,
    );
    const jitter = delay * 0.2 * Math.random();

    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.intentionalClose || this._state === "open") return;
      try {
        await runtime.refreshGatewayUrl();
      } catch {}
      this.connect().catch(() => {});
    }, delay + jitter);
  }

  private cancelReconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private handleFrame(frame: any) {
    if (frame.id != null && this.pending.has(String(frame.id))) {
      const p = this.pending.get(String(frame.id))!;
      this.pending.delete(String(frame.id));
      clearTimeout(p.timer);
      if (frame.error) {
        p.reject(new Error(frame.error.message ?? `RPC error ${frame.error.code}`));
      } else {
        p.resolve(frame.result);
      }
      return;
    }

    if (frame.method === "event" && frame.params) {
      const ev = parseGatewayEvent({
        type: frame.params.type,
        session_id: frame.params.session_id,
        payload: frame.params.payload,
      });
      this.emit(ev);
    }
  }

  private emit(ev: GatewayEvent) {
    this.typedListeners.get(ev.type)?.forEach((cb) => cb(ev));
    this.anyListeners.forEach((cb) => cb(ev));
  }

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
      typeof options === "number"
        ? undefined
        : options?.connectTimeoutMs;

    await this.connect(connectTimeoutMs === undefined ? undefined : { timeoutMs: connectTimeoutMs });

    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error("WebSocket not connected"));
        return;
      }
      const id = `w${this.nextId++}`;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC timeout: ${method}`));
      }, timeoutMs);

      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      try {
        this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

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

  // 主动触发一次"假定连接已死"路径：tear down 当前 ws / 在飞 connect，
  // 重置 backoff，立刻重连。给 powerMonitor.on('resume') 这种外部信号用。
  forceReconnect(reason = "manual"): void {
    this.handleWake(reason, true);
  }

  private installWakeListeners(): void {
    if (this.wakeListenersInstalled) return;
    this.wakeListenersInstalled = true;

    // 桌面端有 Electron powerMonitor.on('resume') 走 IPC（preload 注入的
    // onSystemResume），它是 OS 真实唤醒信号，不会被主线程长任务误触发。
    // JS 侧 setInterval watchdog 在桌面端只会成为噪声源——长 markdown / shiki
    // 渲染 block 主线程几秒就会被当作"睡过觉"，把健康连接 tear down。
    const hasNativeResumeSignal =
      typeof window !== "undefined" && typeof window.hermesDesktop?.onSystemResume === "function";

    if (!hasNativeResumeSignal) {
      this.lastWakeTickAt = Date.now();
      this.wakeWatchdogTimer = setInterval(() => {
        const now = Date.now();
        const gap = now - this.lastWakeTickAt;
        this.lastWakeTickAt = now;
        // 进程被 OS 冻结超过阈值——大概率睡过觉，已有 socket 多半是半开。
        if (gap > WAKE_GAP_THRESHOLD_MS) {
          this.handleWake(`clock-skew ${gap}ms`, true);
        }
      }, WAKE_WATCHDOG_INTERVAL_MS);
    }

    // visibility / online 是"提示"级信号——用户 alt-tab 切回前台或网络恢复
    // 时触发，**OS 没睡过觉**，已有 socket 通常仍然健康。强行 tear down 会
    // 在每次窗口切换都向 UI 砸一发 "连接已断开"。这两条只在 ws 当前不是 OPEN
    // 时才走重连路径（forceful=false）。
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

    // powerMonitor.resume 是 OS 真正从睡眠里醒来——TCP 半开是常态，必须
    // 强行 tear down。
    const desktop = typeof window !== "undefined" ? window.hermesDesktop : undefined;
    if (desktop?.onSystemResume) {
      this.unsubscribeSystemResume = desktop.onSystemResume(() =>
        this.handleWake("powerMonitor", true),
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

    // forceful=false 是 "提示" 路径（visibility/online）——已经 OPEN 的连接
    // 没必要 tear down。对齐官方桌面端，不主动发 synthetic ping；
    // 半开 socket 由下一次 RPC timeout / WebSocket close-error 兜住，
    // 不至于让窗口每次切回前台都闪 "连接已断开"。
    if (!forceful && this.ws?.readyState === WebSocket.OPEN) {
      return;
    }

    // 强行抛弃当前 socket / 在飞的 connect promise——OS 唤醒后它们都不可信。
    this.cancelReconnect();
    this.reconnectAttempts = 0;

    const ws = this.ws;
    const hadSocket = ws !== null;
    const hadInflight = this.connectPromise !== null;

    if (hadSocket || hadInflight) {
      this.ws = null;
      this.connectPromise = null;
      // 拒绝挂在旧 socket 上的 RPC——不然要等 120s RPC timeout，UI 卡住。
      this.pending.forEach(({ reject, timer }) => {
        clearTimeout(timer);
        reject(new Error("WebSocket connection lost"));
      });
      this.pending.clear();
      if (ws) {
        try { ws.close(); } catch {}
      }
      this.setState("closed");
      this.emitDisconnect();
    }

    // 立即重连——不走 scheduleReconnect 的 backoff（已经被重置但还有 1s base
    // delay），因为唤醒事件就是"现在"。
    this.connect().catch(() => {});
  }

  close() {
    this.intentionalClose = true;
    this.cancelReconnect();
    this.removeWakeListeners();
    this.abortConnect?.();
    this.pending.forEach(({ reject, timer }) => {
      clearTimeout(timer);
      reject(new Error("WebSocket closed"));
    });
    this.pending.clear();
    const ws = this.ws;
    this.ws = null;
    this.connectPromise = null;
    if (ws) {
      try { ws.close(); } catch {}
    }
    this.setState("idle");
  }
}

// Public client surface used by call sites (use-gateway.ts / detail.tsx /
// debug-install.ts) and by test doubles. The transport is always JSON-RPC
// over WebSocket against the official /api/ws endpoint — only the socket
// implementation may differ (native WebSocket vs Rust relay), behind
// GatewaySocketFactory.
export interface GatewayClientLike {
  state: ConnectionState;
  connect(options?: GatewayConnectOptions | number): Promise<void>;
  request<T = unknown>(method: string, params?: Record<string, unknown>, options?: GatewayRequestOptions | number): Promise<T>;
  on(type: string, cb: (ev: GatewayEvent) => void): () => void;
  onAny(cb: (ev: GatewayEvent) => void): () => void;
  onState(cb: (s: ConnectionState) => void): () => void;
  enableAutoReconnect(): void;
  disableAutoReconnect(): void;
  forceReconnect(reason?: string): void;
  close(): void;
}

let instance: GatewayClient | null = null;

// The socket factory picks native webview WebSocket vs Rust relay (and flips
// automatically when a packaged webview blocks ws:// from tauri://); the
// protocol layer above is identical either way. See gateway-socket-path.ts.
import { createGatewaySocket } from "./gateway-socket-path";

export function getGatewayClient(): GatewayClientLike {
  if (instance) return instance;
  instance = new GatewayClient(createGatewaySocket);
  return instance;
}

export function forceExistingGatewayReconnect(reason = "runtime-restart"): void {
  instance?.forceReconnect(reason);
}
