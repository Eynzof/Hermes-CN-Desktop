import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tauriMocks = vi.hoisted(() => ({
  emit: vi.fn(),
  invoke: vi.fn(),
  listen: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: tauriMocks.invoke,
}));

vi.mock("@tauri-apps/api/event", () => ({
  emit: tauriMocks.emit,
  listen: tauriMocks.listen,
}));

import { GatewaySseClient } from "./gateway-sse-client";

// Minimal EventSource mock that lets us drive open/error/messages
// from the test instead of going to the network.
class MockEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  static instances: MockEventSource[] = [];

  readyState = MockEventSource.CONNECTING;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  private listeners = new Map<string, Set<(ev: { data: string }) => void>>();

  constructor(public url: string) {
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, cb: (ev: { data: string }) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(cb);
  }

  close(): void {
    this.readyState = MockEventSource.CLOSED;
    this.closed = true;
  }

  // --- test driver helpers ---

  emitNamed(type: string, data: object): void {
    this.readyState = MockEventSource.OPEN;
    const set = this.listeners.get(type);
    set?.forEach((cb) => cb({ data: JSON.stringify(data) }));
  }

  emitMessage(data: object): void {
    this.readyState = MockEventSource.OPEN;
    this.onmessage?.({ data: JSON.stringify(data) });
  }

  emitError(): void {
    this.readyState = MockEventSource.CLOSED;
    this.onerror?.();
  }
}

const ORIGINAL_ES = (globalThis as any).EventSource;
const ORIGINAL_FETCH = globalThis.fetch;

function installRuntimeStub(token = "test-token", apiBase = "http://127.0.0.1:9120"): void {
  (globalThis as any).window = (globalThis as any).window ?? globalThis;
  (window as any).__HERMES_RUNTIME__ = {
    platform: "web",
    apiBaseUrl: apiBase,
    sessionToken: token,
  };
  (window as any).__HERMES_SESSION_TOKEN__ = token;
  (window as any).location = { href: `${apiBase}/`, search: "" };
}

async function flushMicrotasks(times = 4): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

beforeEach(() => {
  MockEventSource.instances = [];
  (globalThis as any).EventSource = MockEventSource;
  (globalThis as any).EventSource.OPEN = MockEventSource.OPEN;
  (globalThis as any).EventSource.CLOSED = MockEventSource.CLOSED;
  installRuntimeStub();
  delete (window as any).__TAURI_INTERNALS__;
  delete (window as any).hermesDesktop;
  tauriMocks.emit.mockReset();
  tauriMocks.invoke.mockReset();
  tauriMocks.listen.mockReset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  (globalThis as any).EventSource = ORIGINAL_ES;
  globalThis.fetch = ORIGINAL_FETCH;
});

describe("GatewaySseClient", () => {
  it("opens an EventSource with token in query and resolves connect() on client_id frame", async () => {
    const client = new GatewaySseClient();
    const connectP = client.connect();

    // EventSource constructed
    expect(MockEventSource.instances).toHaveLength(1);
    const es = MockEventSource.instances[0];
    expect(es.url).toContain("/api/v2/events");
    expect(es.url).toContain("token=test-token");

    // Server emits client_id
    es.emitNamed("client_id", { client_id: "cid-abc" });
    await connectP;

    expect(client.state).toBe("open");
  });

  it("connect() rejects on timeout if no client_id arrives", async () => {
    const client = new GatewaySseClient();
    const connectP = client.connect({ timeoutMs: 5_000 });

    vi.advanceTimersByTime(5_001);

    await expect(connectP).rejects.toThrow(/timeout/i);
    expect(client.state).toBe("error");
  });

  it("forwards typed events to on()/onAny() listeners", async () => {
    const client = new GatewaySseClient();
    const typed: any[] = [];
    const any: any[] = [];
    client.on("message.delta", (ev) => typed.push(ev));
    client.onAny((ev) => any.push(ev));

    const connectP = client.connect();
    const es = MockEventSource.instances[0];
    es.emitNamed("client_id", { client_id: "cid-1" });
    await connectP;

    es.emitMessage({
      jsonrpc: "2.0",
      method: "event",
      params: { type: "message.delta", session_id: "s1", payload: { text: "hi" } },
    });
    es.emitMessage({
      jsonrpc: "2.0",
      method: "event",
      params: { type: "tool.start", session_id: "s1", payload: { name: "Read" } },
    });

    expect(typed).toHaveLength(1);
    expect(typed[0].type).toBe("message.delta");
    expect(any).toHaveLength(2);
  });

  it("notifies state listeners with current state on subscribe", async () => {
    const client = new GatewaySseClient();
    const states: string[] = [];
    const unsub = client.onState((s) => states.push(s));
    expect(states).toEqual(["idle"]);

    const connectP = client.connect();
    expect(states.at(-1)).toBe("connecting");
    const es = MockEventSource.instances[0];
    es.emitNamed("client_id", { client_id: "x" });
    await connectP;
    expect(states.at(-1)).toBe("open");

    unsub();
  });

  it("request() POSTs the right URL/body and resolves with result", async () => {
    const client = new GatewaySseClient();
    const connectP = client.connect();
    const es = MockEventSource.instances[0];
    es.emitNamed("client_id", { client_id: "cid-9" });
    await connectP;

    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ jsonrpc: "2.0", id: "ignored", result: { foo: "bar" } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    globalThis.fetch = fetchMock as any;

    const result = await client.request<{ foo: string }>("model.options", { hint: 1 });
    expect(result).toEqual({ foo: "bar" });

    expect(fetchMock).toHaveBeenCalledOnce();
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const [url, init] = call;
    expect(url).toContain("/api/v2/rpc");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer test-token");
    expect(headers["X-Hermes-Client-Id"]).toBe("cid-9");
    const body = JSON.parse(String(init.body));
    expect(body.method).toBe("model.options");
    expect(body.params).toEqual({ hint: 1 });
    expect(body.jsonrpc).toBe("2.0");
  });

  it("request() rejects with the JSON-RPC error message", async () => {
    const client = new GatewaySseClient();
    const connectP = client.connect();
    MockEventSource.instances[0].emitNamed("client_id", { client_id: "c" });
    await connectP;

    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "x",
          error: { code: -32601, message: "unknown method: foo" },
        }),
        { status: 200 },
      ),
    ) as any;

    await expect(client.request("foo")).rejects.toThrow(/unknown method: foo/);
  });

  it("waits for the matching SSE response when RPC returns an async ack", async () => {
    const client = new GatewaySseClient();
    const connectP = client.connect();
    const es = MockEventSource.instances[0];
    es.emitNamed("client_id", { client_id: "cid-async" });
    await connectP;

    globalThis.fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: { accepted: true, async: true },
        }),
        { status: 200 },
      );
    }) as any;

    const request = client.request<{ session_id: string; resumed: string }>(
      "session.resume",
      { session_id: "persist-1" },
    );
    await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalledOnce());
    const posted = JSON.parse(String((globalThis.fetch as any).mock.calls[0][1].body));

    es.emitMessage({
      jsonrpc: "2.0",
      id: posted.id,
      result: { session_id: "gw-1", resumed: "persist-1" },
    });

    await expect(request).resolves.toEqual({ session_id: "gw-1", resumed: "persist-1" });
  });

  it("uses an early SSE response if it arrives before the async ack is parsed", async () => {
    const client = new GatewaySseClient();
    const connectP = client.connect();
    const es = MockEventSource.instances[0];
    es.emitNamed("client_id", { client_id: "cid-race" });
    await connectP;

    globalThis.fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      es.emitMessage({
        jsonrpc: "2.0",
        id: body.id,
        result: { session_id: "gw-race", resumed: "persist-race" },
      });
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: { accepted: true, async: true },
        }),
        { status: 200 },
      );
    }) as any;

    await expect(
      client.request("session.resume", { session_id: "persist-race" }),
    ).resolves.toEqual({ session_id: "gw-race", resumed: "persist-race" });
  });

  it("rejects async RPC requests when the SSE response is an error", async () => {
    const client = new GatewaySseClient();
    const connectP = client.connect();
    const es = MockEventSource.instances[0];
    es.emitNamed("client_id", { client_id: "cid-error" });
    await connectP;

    globalThis.fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: { accepted: true, async: true },
        }),
        { status: 200 },
      );
    }) as any;

    const request = client.request("session.resume", { session_id: "missing" });
    await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalledOnce());
    const posted = JSON.parse(String((globalThis.fetch as any).mock.calls[0][1].body));

    es.emitMessage({
      jsonrpc: "2.0",
      id: posted.id,
      error: { code: 4007, message: "session not found" },
    });

    await expect(request).rejects.toThrow(/session not found/);
  });

  it("rejects async RPC requests when the native SSE stream closes", async () => {
    const client = new GatewaySseClient();
    const connectP = client.connect();
    const es = MockEventSource.instances[0];
    es.emitNamed("client_id", { client_id: "cid-close" });
    await connectP;

    globalThis.fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: { accepted: true, async: true },
        }),
        { status: 200 },
      );
    }) as any;

    let observed = "pending";
    const request = client.request("session.resume", { session_id: "persist-close" });
    request.then(
      () => { observed = "resolved"; },
      (error) => { observed = `rejected:${error.message}`; },
    );
    await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalledOnce());
    await flushMicrotasks();

    es.emitError();
    await flushMicrotasks();

    expect(observed).toBe("rejected:SSE connection closed");
  });

  it("rejects async RPC requests when the Tauri SSE proxy closes", async () => {
    vi.useRealTimers();
    const listeners = new Map<string, (event: { payload: string }) => void>();
    const refreshGatewayUrl = vi.fn(async () => ({
      gatewayUrl: "ws://127.0.0.1:9119/api/ws?token=fresh-token",
      sessionToken: "fresh-token",
    }));
    const requestProxy = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: {},
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "ignored",
        result: { accepted: true, async: true },
      }),
    }));

    (window as any).__TAURI_INTERNALS__ = {};
    window.__HERMES_RUNTIME__ = {
      platform: "tauri",
      apiBaseUrl: "http://127.0.0.1:9119",
      gatewayUrl: "ws://127.0.0.1:9119/api/ws?token=stale-token",
      sessionToken: "stale-token",
      transport: "sse",
    };
    window.__HERMES_SESSION_TOKEN__ = "stale-token";
    window.hermesDesktop = {
      windowType: "tauri",
      refreshGatewayUrl,
      request: requestProxy,
    };

    tauriMocks.listen.mockImplementation(
      async (eventName: string, cb: (event: { payload: string }) => void) => {
        listeners.set(eventName, cb);
        return vi.fn();
      },
    );
    tauriMocks.invoke.mockResolvedValue(undefined);

    const client = new GatewaySseClient();
    const connectP = client.connect({ timeoutMs: 5_000 });
    await vi.waitFor(() => expect(tauriMocks.invoke).toHaveBeenCalledOnce());
    listeners.get("gateway-sse-event")?.({
      payload: JSON.stringify({ client_id: "cid-tauri-close" }),
    });
    await connectP;

    let observed = "pending";
    const request = client.request("session.resume", { session_id: "persist-tauri-close" });
    request.then(
      () => { observed = "resolved"; },
      (error) => { observed = `rejected:${error.message}`; },
    );
    await vi.waitFor(() => expect(requestProxy).toHaveBeenCalledOnce());
    await flushMicrotasks();

    listeners.get("gateway-sse-error")?.({ payload: "SSE stream ended" });
    await flushMicrotasks();

    expect(observed).toBe("rejected:SSE connection closed");
  });

  it("uses one Tauri SSE proxy connection across repeated RPC requests", async () => {
    vi.useRealTimers();
    const listeners = new Map<string, (event: { payload: string }) => void>();
    const refreshGatewayUrl = vi.fn(async () => ({
      gatewayUrl: "ws://127.0.0.1:9119/api/ws?token=fresh-token",
      sessionToken: "fresh-token",
    }));
    const request = vi.fn(async (_input: { headers?: Record<string, string> }) => ({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: {},
      body: JSON.stringify({ jsonrpc: "2.0", id: "ignored", result: { ok: true } }),
    }));

    (window as any).__TAURI_INTERNALS__ = {};
    window.__HERMES_RUNTIME__ = {
      platform: "tauri",
      apiBaseUrl: "http://127.0.0.1:9119",
      gatewayUrl: "ws://127.0.0.1:9119/api/ws?token=stale-token",
      sessionToken: "stale-token",
      transport: "sse",
    };
    window.__HERMES_SESSION_TOKEN__ = "stale-token";
    window.hermesDesktop = {
      windowType: "tauri",
      refreshGatewayUrl,
      request,
    };

    tauriMocks.listen.mockImplementation(
      async (eventName: string, cb: (event: { payload: string }) => void) => {
        listeners.set(eventName, cb);
        return vi.fn();
      },
    );
    tauriMocks.invoke.mockResolvedValue(undefined);

    const client = new GatewaySseClient();
    const connectP = client.connect({ timeoutMs: 5_000 });

    await vi.waitFor(() => expect(tauriMocks.invoke).toHaveBeenCalledOnce());
    expect(refreshGatewayUrl).toHaveBeenCalledOnce();
    expect(refreshGatewayUrl.mock.invocationCallOrder[0]).toBeLessThan(
      tauriMocks.invoke.mock.invocationCallOrder[0],
    );

    listeners.get("gateway-sse-event")?.({ payload: JSON.stringify({ client_id: "cid-tauri" }) });
    await connectP;

    await expect(client.request("model.options", {})).resolves.toEqual({ ok: true });
    expect(tauriMocks.invoke).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]?.[0].headers?.Authorization).toBe("Bearer fresh-token");
    expect(request.mock.calls[0]?.[0].headers?.["X-Hermes-Client-Id"]).toBe("cid-tauri");
  });

  it("close() tears down EventSource and resets state to idle", async () => {
    const client = new GatewaySseClient();
    const p = client.connect();
    const es = MockEventSource.instances[0];
    es.emitNamed("client_id", { client_id: "c" });
    await p;

    client.close();
    expect(es.closed).toBe(true);
    expect(client.state).toBe("idle");
  });

  it("emits gateway.disconnected when EventSource closes unexpectedly", async () => {
    const client = new GatewaySseClient();
    client.enableAutoReconnect();
    const p = client.connect();
    const es = MockEventSource.instances[0];
    es.emitNamed("client_id", { client_id: "c" });
    await p;

    const events: any[] = [];
    client.on("gateway.disconnected", (ev) => events.push(ev));

    es.emitError(); // CLOSED
    expect(events).toHaveLength(1);
    expect(client.state).toBe("closed");
  });

  it("forceReconnect() drops current ES and opens a new one when autoReconnect=true", async () => {
    const client = new GatewaySseClient();
    client.enableAutoReconnect();
    const p = client.connect();
    const es1 = MockEventSource.instances[0];
    es1.emitNamed("client_id", { client_id: "c1" });
    await p;

    client.forceReconnect("test");
    expect(es1.closed).toBe(true);
    expect(MockEventSource.instances).toHaveLength(2);
    const es2 = MockEventSource.instances[1];
    expect(es2.closed).toBe(false);
  });
});
