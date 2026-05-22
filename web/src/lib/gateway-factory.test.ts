import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Reload the factory module each test so the singleton cache resets.
async function loadFactory(seed: Record<string, unknown> = {}) {
  vi.resetModules();
  const uiStore = await import("@/lib/ui-store");
  uiStore.__resetUiStoreForTests(seed);
  return await import("./gateway-client");
}

interface FakeWindow {
  location: { search: string; href: string };
  __HERMES_RUNTIME__?: { transport?: "ws" | "sse" };
}

let fakeWindow: FakeWindow;

function setQuery(search: string): void {
  fakeWindow.location.search = search ? `?${search}` : "";
  fakeWindow.location.href = `http://test/${fakeWindow.location.search}`;
}

beforeEach(() => {
  fakeWindow = {
    location: { search: "", href: "http://test/" },
  };
  (globalThis as any).window = fakeWindow;
  // Stub EventSource so any module init that touches it doesn't crash.
  (globalThis as any).EventSource = class FakeES {
    static OPEN = 1;
    static CLOSED = 2;
    readyState = 0;
    addEventListener() {}
    close() {}
    onmessage: any = null;
    onerror: any = null;
    constructor(public url: string) {}
  };
});

afterEach(() => {
  delete (globalThis as any).window;
});

describe("getGatewayClient transport selection", () => {
  it("defaults to WebSocket transport when no flag is set", async () => {
    const mod = await loadFactory();
    const client = mod.getGatewayClient();
    expect(mod.getActiveTransport()).toBe("ws");
    expect(client.constructor.name).toBe("GatewayClient");
  });

  it("picks SSE transport when ?transport=sse is in URL", async () => {
    setQuery("transport=sse");
    const mod = await loadFactory();
    const client = mod.getGatewayClient();
    expect(mod.getActiveTransport()).toBe("sse");
    expect(client.constructor.name).toBe("GatewaySseClient");
  });

  it("picks SSE transport when UI store HERMES_TRANSPORT=sse", async () => {
    const mod = await loadFactory({ HERMES_TRANSPORT: "sse" });
    const client = mod.getGatewayClient();
    expect(mod.getActiveTransport()).toBe("sse");
    expect(client.constructor.name).toBe("GatewaySseClient");
  });

  it("URL query takes precedence over UI store", async () => {
    setQuery("transport=ws");
    const mod = await loadFactory({ HERMES_TRANSPORT: "sse" });
    const client = mod.getGatewayClient();
    expect(mod.getActiveTransport()).toBe("ws");
    expect(client.constructor.name).toBe("GatewayClient");
  });

  it("returns the same instance on repeat calls (singleton)", async () => {
    const mod = await loadFactory();
    expect(mod.getGatewayClient()).toBe(mod.getGatewayClient());
  });

  it("honors __HERMES_RUNTIME__.transport injected by Electron preload", async () => {
    fakeWindow.__HERMES_RUNTIME__ = { transport: "sse" };
    const mod = await loadFactory();
    const client = mod.getGatewayClient();
    expect(mod.getActiveTransport()).toBe("sse");
    expect(client.constructor.name).toBe("GatewaySseClient");
  });

  it("URL query and UI store trump __HERMES_RUNTIME__.transport", async () => {
    fakeWindow.__HERMES_RUNTIME__ = { transport: "sse" };
    const mod = await loadFactory({ HERMES_TRANSPORT: "ws" });
    const client = mod.getGatewayClient();
    expect(mod.getActiveTransport()).toBe("ws");
    expect(client.constructor.name).toBe("GatewayClient");
  });
});
