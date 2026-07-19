import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayClient } from "./gateway-client";

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readyState = MockWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;

  constructor(public url: string) {
    MockWebSocket.instances.push(this);
  }

  open() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  fail() {
    this.onerror?.();
  }

  send(data: string) {
    this.sent.push(data);
  }

  close(code?: number, reason?: string) {
    this.readyState = MockWebSocket.CLOSED;
    (this.onclose as ((ev?: { code?: number; reason?: string }) => void) | null)?.(
      code === undefined ? undefined : { code, reason },
    );
  }
}

describe("GatewayClient", () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.stubGlobal("WebSocket", MockWebSocket);
    vi.stubGlobal("window", {
      location: {
        href: "http://localhost:9545/tasks/s1",
        protocol: "http:",
      },
      __HERMES_SESSION_TOKEN__: "token with space",
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("reuses the in-flight connection promise and encodes the token", async () => {
    const client = new GatewayClient();
    const first = client.connect();
    const second = client.connect();

    expect(first).toBe(second);
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(MockWebSocket.instances[0].url).toContain("token=token+with+space");

    MockWebSocket.instances[0].open();
    await expect(first).resolves.toBeUndefined();
    client.close();
  });

  it("times out a stuck WebSocket handshake", async () => {
    vi.useFakeTimers();
    const client = new GatewayClient();
    const connected = client.connect({ timeoutMs: 25 });

    expect(MockWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(25);

    await expect(connected).rejects.toThrow("WebSocket connection timeout");
    expect(client.state).toBe("error");
    expect(MockWebSocket.instances[0].readyState).toBe(MockWebSocket.CLOSED);
  });

  it("applies request connect timeout before RPC timeout", async () => {
    vi.useFakeTimers();
    const client = new GatewayClient();
    const request = client.request("prompt.submit", { session_id: "s1", text: "hi" }, {
      connectTimeoutMs: 10,
      timeoutMs: 10_000,
    });

    vi.advanceTimersByTime(10);

    await expect(request).rejects.toThrow("WebSocket connection timeout");
    expect(MockWebSocket.instances[0].sent).toHaveLength(0);
  });

  it("rejects all pending requests when the socket closes", async () => {
    const client = new GatewayClient();
    const connected = client.connect();
    MockWebSocket.instances[0].open();
    await connected;

    const request = client.request("prompt.submit", { session_id: "s1", text: "hi" });
    await Promise.resolve();
    expect(MockWebSocket.instances[0].sent).toHaveLength(1);

    client.close();
    await expect(request).rejects.toThrow("WebSocket closed");
  });

  it("moves an established connection to closed when the socket closes", async () => {
    const client = new GatewayClient();
    const connected = client.connect();
    MockWebSocket.instances[0].open();
    await connected;

    MockWebSocket.instances[0].close();

    expect(client.state).toBe("closed");
    client.close();
  });

  it("rejects pending requests and schedules reconnect when an established socket errors", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const client = new GatewayClient();
    client.enableAutoReconnect();
    const events: string[] = [];
    client.on("gateway.disconnected", () => events.push("disconnected"));

    const connected = client.connect();
    MockWebSocket.instances[0].open();
    await connected;

    const request = client.request("some.method", {});
    await Promise.resolve();

    MockWebSocket.instances[0].fail();

    await expect(request).rejects.toThrow("WebSocket connection failed");
    expect(client.state).toBe("error");
    expect(events).toEqual(["disconnected"]);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(MockWebSocket.instances).toHaveLength(2);

    client.close();
  });

  it("parses gateway events before notifying listeners", async () => {
    const client = new GatewayClient();
    const seen: unknown[] = [];
    client.onAny((event) => seen.push(event));

    const connected = client.connect();
    MockWebSocket.instances[0].open();
    await connected;

    MockWebSocket.instances[0].onmessage?.({
      data: JSON.stringify({
        method: "event",
        params: {
          type: "message.complete",
          session_id: "s1",
          payload: { text: "done" },
        },
      }),
    });

    expect(seen).toEqual([
      expect.objectContaining({
        type: "message.complete",
        session_id: "s1",
        payload: { text: "done" },
      }),
    ]);
    client.close();
  });

  it("emits gateway.disconnected on unexpected close", async () => {
    const client = new GatewayClient();
    const events: string[] = [];
    client.on("gateway.disconnected", () => events.push("disconnected"));

    const connected = client.connect();
    MockWebSocket.instances[0].open();
    await connected;

    MockWebSocket.instances[0].close();

    expect(events).toEqual(["disconnected"]);
    expect(client.state).toBe("closed");
  });

  it("suspends reconnect and emits gateway.auth_required on a 4401 close", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const client = new GatewayClient();
    client.enableAutoReconnect();
    const events: string[] = [];
    client.on("gateway.auth_required", () => events.push("auth_required"));

    const connected = client.connect();
    MockWebSocket.instances[0].open();
    await connected;

    MockWebSocket.instances[0].close(4401, "unauthenticated");

    expect(events).toContain("auth_required");
    // No new socket even after well past the backoff — blind reconnect is off.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(MockWebSocket.instances).toHaveLength(1);

    // forceReconnect clears the auth-suspend gate and reconnects.
    client.forceReconnect("relogin");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(MockWebSocket.instances.length).toBeGreaterThan(1);
  });

  it("keeps normal backoff on a non-auth (1006-like) close", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const client = new GatewayClient();
    client.enableAutoReconnect();
    const connected = client.connect();
    MockWebSocket.instances[0].open();
    await connected;

    MockWebSocket.instances[0].close(1006, "abnormal");
    // A transient close schedules a reconnect (new socket after backoff).
    await vi.advanceTimersByTimeAsync(1_000);
    expect(MockWebSocket.instances).toHaveLength(2);
  });

  it("does not emit gateway.disconnected on intentional close", async () => {
    const client = new GatewayClient();
    const events: string[] = [];
    client.on("gateway.disconnected", () => events.push("disconnected"));

    const connected = client.connect();
    MockWebSocket.instances[0].open();
    await connected;

    client.close();

    expect(events).toEqual([]);
    expect(client.state).toBe("idle");
  });

  it("rejects an in-flight connection when closed intentionally", async () => {
    const client = new GatewayClient();
    const events: string[] = [];
    client.on("gateway.disconnected", () => events.push("disconnected"));

    const connecting = client.connect({ timeoutMs: 1_000 });
    expect(client.state).toBe("connecting");

    client.close();

    await expect(connecting).rejects.toThrow("WebSocket closed");
    expect(events).toEqual([]);
    expect(client.state).toBe("idle");
  });

  it("auto-reconnects when enabled", async () => {
    vi.useFakeTimers();
    const client = new GatewayClient();
    client.enableAutoReconnect();

    const connected = client.connect();
    MockWebSocket.instances[0].open();
    await connected;

    expect(MockWebSocket.instances).toHaveLength(1);
    MockWebSocket.instances[0].close();

    await vi.advanceTimersByTimeAsync(2_000);
    expect(MockWebSocket.instances.length).toBeGreaterThanOrEqual(2);

    client.close();
  });

  it("does not auto-reconnect when disabled", async () => {
    vi.useFakeTimers();
    const client = new GatewayClient();

    const connected = client.connect();
    MockWebSocket.instances[0].open();
    await connected;

    MockWebSocket.instances[0].close();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it("resets reconnect attempts after successful connection", async () => {
    vi.useFakeTimers();
    const client = new GatewayClient();
    client.enableAutoReconnect();

    const connected = client.connect();
    MockWebSocket.instances[0].open();
    await connected;

    MockWebSocket.instances[0].close();
    await vi.advanceTimersByTimeAsync(2_000);

    const reconnectWs = MockWebSocket.instances[1];
    expect(reconnectWs).toBeDefined();
    reconnectWs.open();
    await vi.advanceTimersByTimeAsync(0);

    expect(client.state).toBe("open");
    client.close();
  });

  describe("reconnect backoff", () => {
    it("uses exponential backoff: 1s, 2s, 4s", async () => {
      vi.useFakeTimers();
      vi.spyOn(Math, "random").mockReturnValue(0);
      const client = new GatewayClient();
      client.enableAutoReconnect();

      const connected = client.connect();
      MockWebSocket.instances[0].open();
      await connected;

      MockWebSocket.instances[0].close();
      await vi.advanceTimersByTimeAsync(999);
      expect(MockWebSocket.instances).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(MockWebSocket.instances).toHaveLength(2);

      MockWebSocket.instances[1].close();
      await vi.advanceTimersByTimeAsync(1999);
      expect(MockWebSocket.instances).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(MockWebSocket.instances).toHaveLength(3);

      MockWebSocket.instances[2].close();
      await vi.advanceTimersByTimeAsync(3999);
      expect(MockWebSocket.instances).toHaveLength(3);
      await vi.advanceTimersByTimeAsync(1);
      expect(MockWebSocket.instances).toHaveLength(4);

      client.close();
    });

    it("caps backoff delay at 15s (official desktop parity)", async () => {
      vi.useFakeTimers();
      vi.spyOn(Math, "random").mockReturnValue(0);
      const client = new GatewayClient();
      client.enableAutoReconnect();

      const connected = client.connect();
      MockWebSocket.instances[0].open();
      await connected;

      // 1s, 2s, 4s, 8s, then capped: min(1s·2^min(n,4), 15s) = 15s
      for (let i = 0; i < 5; i++) {
        MockWebSocket.instances[i].close();
        await vi.advanceTimersByTimeAsync(Math.min(1000 * Math.pow(2, Math.min(i, 4)), 15_000));
      }
      expect(MockWebSocket.instances).toHaveLength(6);

      MockWebSocket.instances[5].close();
      await vi.advanceTimersByTimeAsync(14_999);
      expect(MockWebSocket.instances).toHaveLength(6);
      await vi.advanceTimersByTimeAsync(1);
      expect(MockWebSocket.instances).toHaveLength(7);

      MockWebSocket.instances[6].close();
      await vi.advanceTimersByTimeAsync(14_999);
      expect(MockWebSocket.instances).toHaveLength(7);
      await vi.advanceTimersByTimeAsync(1);
      expect(MockWebSocket.instances).toHaveLength(8);

      client.close();
    });

    it("close() cancels pending reconnect", async () => {
      vi.useFakeTimers();
      vi.spyOn(Math, "random").mockReturnValue(0);
      const client = new GatewayClient();
      client.enableAutoReconnect();

      const connected = client.connect();
      MockWebSocket.instances[0].open();
      await connected;

      MockWebSocket.instances[0].close();
      client.close();

      await vi.advanceTimersByTimeAsync(5_000);
      expect(MockWebSocket.instances).toHaveLength(1);
    });

    it("disableAutoReconnect cancels pending timer", async () => {
      vi.useFakeTimers();
      vi.spyOn(Math, "random").mockReturnValue(0);
      const client = new GatewayClient();
      client.enableAutoReconnect();

      const connected = client.connect();
      MockWebSocket.instances[0].open();
      await connected;

      MockWebSocket.instances[0].close();
      client.disableAutoReconnect();

      await vi.advanceTimersByTimeAsync(5_000);
      expect(MockWebSocket.instances).toHaveLength(1);
    });

    it("connect timeout triggers reconnect when auto-reconnect enabled", async () => {
      vi.useFakeTimers();
      vi.spyOn(Math, "random").mockReturnValue(0);
      const client = new GatewayClient();
      client.enableAutoReconnect();

      const connected = client.connect({ timeoutMs: 50 });
      vi.advanceTimersByTime(50);
      await expect(connected).rejects.toThrow("WebSocket connection timeout");

      await vi.advanceTimersByTimeAsync(1_000);
      expect(MockWebSocket.instances).toHaveLength(2);

      client.close();
    });

    it("concurrent connect() during reconnect reuses in-flight promise", async () => {
      vi.useFakeTimers();
      vi.spyOn(Math, "random").mockReturnValue(0);
      const client = new GatewayClient();
      client.enableAutoReconnect();

      const connected = client.connect();
      MockWebSocket.instances[0].open();
      await connected;

      MockWebSocket.instances[0].close();
      await vi.advanceTimersByTimeAsync(1_000);

      const p1 = client.connect();
      const p2 = client.connect();
      expect(p1).toBe(p2);

      MockWebSocket.instances[1].open();
      await p1;
      expect(client.state).toBe("open");

      client.close();
    });

    it("successful reconnect resets backoff to 1s", async () => {
      vi.useFakeTimers();
      vi.spyOn(Math, "random").mockReturnValue(0);
      const client = new GatewayClient();
      client.enableAutoReconnect();

      const connected = client.connect();
      MockWebSocket.instances[0].open();
      await connected;

      MockWebSocket.instances[0].close();
      await vi.advanceTimersByTimeAsync(1_000);
      MockWebSocket.instances[1].close();
      await vi.advanceTimersByTimeAsync(2_000);

      MockWebSocket.instances[2].open();
      await vi.advanceTimersByTimeAsync(0);
      expect(client.state).toBe("open");

      MockWebSocket.instances[2].close();
      await vi.advanceTimersByTimeAsync(999);
      expect(MockWebSocket.instances).toHaveLength(3);
      await vi.advanceTimersByTimeAsync(1);
      expect(MockWebSocket.instances).toHaveLength(4);

      client.close();
    });

    it("tracks state transitions through reconnect cycle", async () => {
      vi.useFakeTimers();
      vi.spyOn(Math, "random").mockReturnValue(0);
      const client = new GatewayClient();
      client.enableAutoReconnect();
      const states: string[] = [];
      client.onState((s) => states.push(s));

      expect(states).toEqual(["idle"]);

      const connected = client.connect();
      MockWebSocket.instances[0].open();
      await connected;
      expect(states).toEqual(["idle", "connecting", "open"]);

      MockWebSocket.instances[0].close();
      expect(states).toEqual(["idle", "connecting", "open", "closed"]);

      await vi.advanceTimersByTimeAsync(1_000);
      MockWebSocket.instances[1].open();
      await vi.advanceTimersByTimeAsync(0);
      expect(states).toEqual(["idle", "connecting", "open", "closed", "connecting", "open"]);

      client.close();
      expect(states).toEqual(["idle", "connecting", "open", "closed", "connecting", "open", "idle"]);
    });
  });

  describe("stale socket isolation", () => {
    it("keeps the active connection promise when an old socket closes late", async () => {
      const client = new GatewayClient();

      const failed = client.connect();
      const stale = MockWebSocket.instances[0];
      stale.fail();
      await expect(failed).rejects.toThrow("WebSocket connection failed");

      const reconnecting = client.connect();
      const sameReconnect = client.connect();
      expect(sameReconnect).toBe(reconnecting);

      stale.close();

      expect(client.connect()).toBe(reconnecting);
      expect(MockWebSocket.instances).toHaveLength(2);

      MockWebSocket.instances[1].open();
      await expect(reconnecting).resolves.toBeUndefined();
      client.close();
    });

    it("does not let an old socket close reject pending RPC on the active socket", async () => {
      const client = new GatewayClient();

      const failed = client.connect();
      const stale = MockWebSocket.instances[0];
      stale.fail();
      await expect(failed).rejects.toThrow("WebSocket connection failed");

      const connected = client.connect();
      const active = MockWebSocket.instances[1];
      active.open();
      await connected;

      const request = client.request<{ ok: boolean }>("some.method", {});
      await Promise.resolve();
      expect(active.sent).toHaveLength(1);

      stale.close();
      active.onmessage?.({
        data: JSON.stringify({ jsonrpc: "2.0", id: "w1", result: { ok: true } }),
      });

      await expect(request).resolves.toEqual({ ok: true });
      expect(client.state).toBe("open");
      client.close();
    });

    it("ignores RPC frames delivered by stale sockets", async () => {
      const client = new GatewayClient();

      const failed = client.connect();
      const stale = MockWebSocket.instances[0];
      stale.fail();
      await expect(failed).rejects.toThrow("WebSocket connection failed");

      const connected = client.connect();
      const active = MockWebSocket.instances[1];
      active.open();
      await connected;

      const request = client.request<{ ok: boolean }>("some.method", {});
      await Promise.resolve();

      stale.onmessage?.({
        data: JSON.stringify({ jsonrpc: "2.0", id: "w1", result: { ok: false } }),
      });
      active.onmessage?.({
        data: JSON.stringify({ jsonrpc: "2.0", id: "w1", result: { ok: true } }),
      });

      await expect(request).resolves.toEqual({ ok: true });
      client.close();
    });
  });

  describe("idle connection liveness", () => {
    it("does not send synthetic ping frames during long idle periods", async () => {
      vi.useFakeTimers();
      const client = new GatewayClient();
      const connected = client.connect();
      MockWebSocket.instances[0].open();
      await connected;

      const ws = MockWebSocket.instances[0];
      expect(ws.sent).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(120_000);
      expect(ws.sent).toHaveLength(0);
      expect(client.state).toBe("open");

      client.close();
    });

    it("keeps an idle open socket instead of failing after the old 40s heartbeat window", async () => {
      vi.useFakeTimers();
      const client = new GatewayClient();
      const disconnects: string[] = [];
      client.on("gateway.disconnected", () => disconnects.push("d"));

      const connected = client.connect();
      MockWebSocket.instances[0].open();
      await connected;

      expect(client.state).toBe("open");

      await vi.advanceTimersByTimeAsync(40_000);
      expect(client.state).toBe("open");
      expect(disconnects).toHaveLength(0);

      client.close();
    });

    it("pending requests are rejected by RPC timeout, not heartbeat timeout", async () => {
      vi.useFakeTimers();
      const client = new GatewayClient();

      const connected = client.connect();
      MockWebSocket.instances[0].open();
      await connected;

      let settled = false;
      const result = client.request("some.method", {}, { timeoutMs: 120_000 })
        .then(() => null)
        .finally(() => { settled = true; })
        .catch((err: Error) => err);
      await vi.advanceTimersByTimeAsync(0);

      await vi.advanceTimersByTimeAsync(40_000);
      expect(settled).toBe(false);
      expect(client.state).toBe("open");

      await vi.advanceTimersByTimeAsync(80_000);

      const error = await result;
      expect(error).toBeInstanceOf(Error);
      expect(error!.message).toBe("RPC timeout: some.method");
      client.close();
    });
  });

  describe("wake recovery", () => {
    it("watchdog detects clock skew and force-reconnects", async () => {
      vi.useFakeTimers();
      const baseTime = new Date("2026-05-10T12:00:00Z").getTime();
      vi.setSystemTime(baseTime);

      const client = new GatewayClient();
      client.enableAutoReconnect();

      const connected = client.connect();
      MockWebSocket.instances[0].open();
      await connected;
      expect(client.state).toBe("open");
      expect(MockWebSocket.instances).toHaveLength(1);

      // 正常 watchdog tick——gap ≈ 2000ms，不触发 wake
      await vi.advanceTimersByTimeAsync(2_000);
      expect(MockWebSocket.instances).toHaveLength(1);
      expect(client.state).toBe("open");

      // 模拟 macOS 合盖：墙上时间跳了 60s 但 timer queue 被冻结
      vi.setSystemTime(baseTime + 60_000);
      await vi.advanceTimersByTimeAsync(2_000);

      // watchdog 看到 60s+ 的 gap，强制重连
      expect(MockWebSocket.instances).toHaveLength(2);
      expect(MockWebSocket.instances[0].readyState).toBe(MockWebSocket.CLOSED);

      client.close();
    });

    it("visibilitychange to visible does NOT tear down a healthy WS", async () => {
      // Capture the handler so we can fire the event ourselves regardless of jsdom presence.
      const captured: { handler: (() => void) | null } = { handler: null };
      const fakeDocument = {
        visibilityState: "visible" as DocumentVisibilityState,
        addEventListener: (name: string, handler: () => void) => {
          if (name === "visibilitychange") captured.handler = handler;
        },
        removeEventListener: () => {},
      };
      vi.stubGlobal("document", fakeDocument);
      vi.stubGlobal("window", {
        location: { href: "http://localhost:9545/tasks/s1", protocol: "http:" },
        __HERMES_SESSION_TOKEN__: "token",
        addEventListener: () => {},
        removeEventListener: () => {},
      });

      const client = new GatewayClient();
      client.enableAutoReconnect();

      const connected = client.connect();
      MockWebSocket.instances[0].open();
      await connected;
      expect(client.state).toBe("open");
      expect(MockWebSocket.instances).toHaveLength(1);

      const disconnects: string[] = [];
      client.on("gateway.disconnected", () => disconnects.push("d"));

      // 模拟用户 alt-tab 切回 Electron 窗口——visibilityState 仍是 visible，
      // 健康的 WS 不该被 tear down，UI 不该看到 gateway.disconnected。
      captured.handler?.();
      await Promise.resolve();

      expect(MockWebSocket.instances).toHaveLength(1);
      expect(MockWebSocket.instances[0].readyState).toBe(MockWebSocket.OPEN);
      expect(client.state).toBe("open");
      expect(disconnects).toHaveLength(0);

      client.close();
    });

    it("desktop runtime skips JS watchdog because powerMonitor IPC handles wake", async () => {
      vi.useFakeTimers();
      const baseTime = new Date("2026-05-10T12:00:00Z").getTime();
      vi.setSystemTime(baseTime);

      // Electron preload 注入 hermesDesktop.onSystemResume——表示有真正的
      // OS 唤醒信号源，不需要 setInterval 兜底。
      vi.stubGlobal("window", {
        location: { href: "http://localhost:9545/tasks/s1", protocol: "http:" },
        __HERMES_SESSION_TOKEN__: "token",
        hermesDesktop: { onSystemResume: () => () => {} },
      });

      const client = new GatewayClient();
      client.enableAutoReconnect();

      const connected = client.connect();
      MockWebSocket.instances[0].open();
      await connected;
      expect(MockWebSocket.instances).toHaveLength(1);

      // 即使墙上时间跳了 60s（模拟主线程被长任务/合盖卡住），桌面端也不应
      // 把健康连接 tear down——因为 powerMonitor 才是权威唤醒源。
      vi.setSystemTime(baseTime + 60_000);
      await vi.advanceTimersByTimeAsync(2_000);
      await vi.advanceTimersByTimeAsync(2_000);

      expect(MockWebSocket.instances).toHaveLength(1);
      expect(client.state).toBe("open");

      client.close();
    });

    it("forceReconnect tears down current socket and reconnects immediately", async () => {
      const client = new GatewayClient();
      client.enableAutoReconnect();

      const connected = client.connect();
      MockWebSocket.instances[0].open();
      await connected;
      expect(MockWebSocket.instances).toHaveLength(1);

      client.forceReconnect("test");

      expect(MockWebSocket.instances[0].readyState).toBe(MockWebSocket.CLOSED);
      expect(MockWebSocket.instances).toHaveLength(2);

      client.close();
    });

    it("wake rejects pending RPCs instead of leaving them to RPC timeout", async () => {
      const client = new GatewayClient();
      client.enableAutoReconnect();

      const connected = client.connect();
      MockWebSocket.instances[0].open();
      await connected;

      const rpc = client.request("some.method", {});
      await Promise.resolve();
      expect(MockWebSocket.instances[0].sent).toHaveLength(1);

      client.forceReconnect("test");

      await expect(rpc).rejects.toThrow(/WebSocket connection lost/);
      client.close();
    });

    it("wake resets reconnect backoff so retries don't sit in the 15s ceiling", async () => {
      vi.useFakeTimers();
      vi.spyOn(Math, "random").mockReturnValue(0);
      const baseTime = new Date("2026-05-10T12:00:00Z").getTime();
      vi.setSystemTime(baseTime);

      const client = new GatewayClient();
      client.enableAutoReconnect();

      // 先连开，再让若干次 close 把 backoff 推到 8s+
      const connected = client.connect();
      MockWebSocket.instances[0].open();
      await connected;

      MockWebSocket.instances[0].close();
      await vi.advanceTimersByTimeAsync(1_000);
      MockWebSocket.instances[1].close();
      await vi.advanceTimersByTimeAsync(2_000);
      MockWebSocket.instances[2].close();
      // 此时 reconnectAttempts = 3，下次 backoff 会是 8s
      const beforeWake = MockWebSocket.instances.length;

      // 模拟睡过觉
      vi.setSystemTime(Date.now() + 60_000);
      await vi.advanceTimersByTimeAsync(2_000);

      // wake 立刻拉一个新连接，不等 backoff
      expect(MockWebSocket.instances.length).toBe(beforeWake + 1);
      const wokenWs = MockWebSocket.instances[MockWebSocket.instances.length - 1];
      wokenWs.open();
      await vi.advanceTimersByTimeAsync(0);
      expect(client.state).toBe("open");

      // 唤醒后再次断线，下个 backoff 应该回到 1s（attempts 被重置过）
      wokenWs.close();
      await vi.advanceTimersByTimeAsync(999);
      expect(MockWebSocket.instances.length).toBe(beforeWake + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(MockWebSocket.instances.length).toBe(beforeWake + 2);

      client.close();
    });
  });

  describe("listener broadcast", () => {
    it("all onAny listeners receive the same event", async () => {
      const client = new GatewayClient();
      const a: string[] = [];
      const b: string[] = [];
      client.onAny((ev) => a.push(ev.type));
      client.onAny((ev) => b.push(ev.type));

      const connected = client.connect();
      MockWebSocket.instances[0].open();
      await connected;

      MockWebSocket.instances[0].onmessage?.({
        data: JSON.stringify({
          method: "event",
          params: { type: "message.start", session_id: "s1", payload: {} },
        }),
      });

      expect(a).toEqual(["message.start"]);
      expect(b).toEqual(["message.start"]);
      client.close();
    });

    it("all typed listeners receive matching events", async () => {
      const client = new GatewayClient();
      const a: unknown[] = [];
      const b: unknown[] = [];
      client.on("message.complete", (ev) => a.push(ev));
      client.on("message.complete", (ev) => b.push(ev));

      const connected = client.connect();
      MockWebSocket.instances[0].open();
      await connected;

      MockWebSocket.instances[0].onmessage?.({
        data: JSON.stringify({
          method: "event",
          params: { type: "message.complete", session_id: "s1", payload: { text: "done" } },
        }),
      });

      expect(a).toHaveLength(1);
      expect(b).toHaveLength(1);
      expect(a[0]).toEqual(b[0]);
      client.close();
    });

    it("unsubscribing one listener does not affect others", async () => {
      const client = new GatewayClient();
      const a: string[] = [];
      const b: string[] = [];
      const unsubA = client.onAny((ev) => a.push(ev.type));
      client.onAny((ev) => b.push(ev.type));

      const connected = client.connect();
      MockWebSocket.instances[0].open();
      await connected;

      unsubA();

      MockWebSocket.instances[0].onmessage?.({
        data: JSON.stringify({
          method: "event",
          params: { type: "message.start", session_id: "s1", payload: {} },
        }),
      });

      expect(a).toEqual([]);
      expect(b).toEqual(["message.start"]);
      client.close();
    });

    it("all onState listeners receive transitions", async () => {
      const client = new GatewayClient();
      const a: string[] = [];
      const b: string[] = [];
      client.onState((s) => a.push(s));
      client.onState((s) => b.push(s));

      const connected = client.connect();
      MockWebSocket.instances[0].open();
      await connected;

      expect(a).toEqual(["idle", "connecting", "open"]);
      expect(b).toEqual(["idle", "connecting", "open"]);
      client.close();
    });

    it("onState fires immediately with current state", () => {
      const client = new GatewayClient();
      const states: string[] = [];
      client.onState((s) => states.push(s));
      expect(states).toEqual(["idle"]);
      client.close();
    });
  });
});
