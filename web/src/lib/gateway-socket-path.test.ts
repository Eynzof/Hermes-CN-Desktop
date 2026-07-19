import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A fake relay socket so the tests never touch @tauri-apps/api.
class FakeRelaySocket {
  static instances: FakeRelaySocket[] = [];
  readyState = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: { reason?: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  constructor(public url: string) {
    FakeRelaySocket.instances.push(this);
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  failBeforeOpen() {
    this.readyState = 3;
    this.onclose?.({ reason: "relay failed" });
  }
  send() {}
  close() {}
}

vi.mock("./gateway-relay-socket", () => ({
  GatewayRelaySocket: FakeRelaySocket,
}));

// addEventListener-capable native WebSocket mock (gateway-socket-path observes
// attempts via addEventListener so it coexists with GatewayClient's on*).
class MockNativeSocket {
  static instances: MockNativeSocket[] = [];
  static throwOnConstruct = false;
  readyState = 0;
  private listeners = new Map<string, Array<() => void>>();
  constructor(public url: string) {
    if (MockNativeSocket.throwOnConstruct) {
      throw new Error("SecurityError: blocked");
    }
    MockNativeSocket.instances.push(this);
  }
  addEventListener(type: string, cb: () => void) {
    const list = this.listeners.get(type) ?? [];
    list.push(cb);
    this.listeners.set(type, list);
  }
  dispatch(type: string) {
    for (const cb of this.listeners.get(type) ?? []) cb();
  }
  open() {
    this.readyState = 1;
    this.dispatch("open");
  }
  failBeforeOpen() {
    this.readyState = 3;
    this.dispatch("error");
    this.dispatch("close");
  }
  closeAfterOpen() {
    this.readyState = 3;
    this.dispatch("close");
  }
  send() {}
  close() {}
}

interface FakeWindow {
  location: { search: string; href: string };
  __TAURI_INTERNALS__?: unknown;
  __HERMES_RUNTIME__?: { connectionMode?: "managed" | "local" | "remote" };
}

let fakeWindow: FakeWindow;

async function loadModule(seed: Record<string, unknown> = {}) {
  vi.resetModules();
  const uiStore = await import("@/lib/ui-store");
  uiStore.__resetUiStoreForTests(seed);
  const mod = await import("./gateway-socket-path");
  mod.__resetSocketPathForTests();
  return { mod, uiStore };
}

beforeEach(() => {
  FakeRelaySocket.instances = [];
  MockNativeSocket.instances = [];
  MockNativeSocket.throwOnConstruct = false;
  fakeWindow = {
    location: { search: "", href: "http://test/" },
    __TAURI_INTERNALS__: {},
  };
  vi.stubGlobal("window", fakeWindow);
  vi.stubGlobal("WebSocket", MockNativeSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const URL = "ws://127.0.0.1:9120/api/ws?token=t";

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("createGatewaySocket path selection", () => {
  it("defaults to the native WebSocket on Tauri", async () => {
    const { mod } = await loadModule();
    const socket = mod.createGatewaySocket(URL);
    expect(socket).toBeInstanceOf(MockNativeSocket);
    expect(mod.getActiveSocketPath()).toBe("native");
  });

  it("always uses native WebSocket off Tauri, even with a learned relay preference", async () => {
    delete fakeWindow.__TAURI_INTERNALS__;
    const { mod } = await loadModule({ HERMES_WS_PATH_LEARNED: "relay" });
    const socket = mod.createGatewaySocket(URL);
    expect(socket).toBeInstanceOf(MockNativeSocket);
  });

  it("starts on relay when a previous probe learned it", async () => {
    const { mod } = await loadModule({ HERMES_WS_PATH_LEARNED: "relay" });
    const socket = mod.createGatewaySocket(URL);
    expect(socket).toBeInstanceOf(FakeRelaySocket);
  });

  it("?wspath=relay forces relay without persisting it", async () => {
    fakeWindow.location.search = "?wspath=relay";
    const { mod, uiStore } = await loadModule();
    const socket = mod.createGatewaySocket(URL) as unknown as FakeRelaySocket;
    expect(socket).toBeInstanceOf(FakeRelaySocket);
    await flushMicrotasks();
    socket.open();
    expect(uiStore.readUiValue("HERMES_WS_PATH_LEARNED", "unset")).toBe("unset");
  });

  it("flips to relay within the same attempt on a synchronous constructor throw", async () => {
    MockNativeSocket.throwOnConstruct = true;
    const { mod, uiStore } = await loadModule();
    const socket = mod.createGatewaySocket(URL);
    expect(socket).toBeInstanceOf(FakeRelaySocket);
    expect(mod.getActiveSocketPath()).toBe("relay");
    expect(uiStore.readUiValue("HERMES_WS_PATH_LEARNED", "unset")).toBe("relay");
  });

  it("flips to relay after two consecutive async pre-open failures", async () => {
    const { mod } = await loadModule();

    const first = mod.createGatewaySocket(URL) as unknown as MockNativeSocket;
    first.failBeforeOpen();
    expect(mod.getActiveSocketPath()).toBe("native");

    const second = mod.createGatewaySocket(URL) as unknown as MockNativeSocket;
    second.failBeforeOpen();
    expect(mod.getActiveSocketPath()).toBe("relay");

    const third = mod.createGatewaySocket(URL);
    expect(third).toBeInstanceOf(FakeRelaySocket);
  });

  it("does not count post-open closes toward the relay flip", async () => {
    const { mod } = await loadModule();
    for (let i = 0; i < 4; i++) {
      const ws = mod.createGatewaySocket(URL) as unknown as MockNativeSocket;
      ws.open();
      ws.closeAfterOpen();
    }
    expect(mod.getActiveSocketPath()).toBe("native");
  });

  it("a successful native open resets the failure streak and learns native", async () => {
    const { mod, uiStore } = await loadModule();
    const first = mod.createGatewaySocket(URL) as unknown as MockNativeSocket;
    first.failBeforeOpen();

    const second = mod.createGatewaySocket(URL) as unknown as MockNativeSocket;
    second.open();
    expect(uiStore.readUiValue("HERMES_WS_PATH_LEARNED", "unset")).toBe("native");

    // The streak restarted: one more failure must NOT flip.
    second.closeAfterOpen();
    const third = mod.createGatewaySocket(URL) as unknown as MockNativeSocket;
    third.failBeforeOpen();
    expect(mod.getActiveSocketPath()).toBe("native");
  });

  it("remote mode always rides the relay and never writes the learned key", async () => {
    fakeWindow.__HERMES_RUNTIME__ = { connectionMode: "remote" };
    const { mod, uiStore } = await loadModule();
    const socket = mod.createGatewaySocket(URL) as unknown as FakeRelaySocket;
    expect(socket).toBeInstanceOf(FakeRelaySocket);
    await flushMicrotasks();
    socket.open();
    // Switching back to local must re-probe native — remote never learns.
    expect(uiStore.readUiValue("HERMES_WS_PATH_LEARNED", "unset")).toBe("unset");
  });

  it("remote mode overrides a learned native preference", async () => {
    fakeWindow.__HERMES_RUNTIME__ = { connectionMode: "remote" };
    const { mod } = await loadModule({ HERMES_WS_PATH_LEARNED: "native" });
    const socket = mod.createGatewaySocket(URL);
    expect(socket).toBeInstanceOf(FakeRelaySocket);
  });

  it("local mode ignores the remote override path", async () => {
    fakeWindow.__HERMES_RUNTIME__ = { connectionMode: "local" };
    const { mod } = await loadModule();
    const socket = mod.createGatewaySocket(URL);
    expect(socket).toBeInstanceOf(MockNativeSocket);
  });

  it("clears the learned value and reverts to native when the relay keeps failing", async () => {
    const { mod, uiStore } = await loadModule({ HERMES_WS_PATH_LEARNED: "relay" });

    const first = mod.createGatewaySocket(URL) as unknown as FakeRelaySocket;
    await flushMicrotasks();
    first.failBeforeOpen();
    expect(mod.getActiveSocketPath()).toBe("relay");

    const second = mod.createGatewaySocket(URL) as unknown as FakeRelaySocket;
    await flushMicrotasks();
    second.failBeforeOpen();

    expect(mod.getActiveSocketPath()).toBe("native");
    expect(uiStore.readUiValue("HERMES_WS_PATH_LEARNED", "unset")).toBe("unset");
  });
});
