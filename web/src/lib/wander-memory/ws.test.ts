import { afterEach, describe, expect, it, vi } from "vitest";
import { MemOsWsClient } from "./ws";

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static readonly instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    queueMicrotask(() => this.onclose?.({} as CloseEvent));
  }

  send(): void {}
}

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  FakeWebSocket.instances.length = 0;
});

describe("MemOsWsClient lifecycle", () => {
  it("does not reconnect after an intentional disconnect", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const client = new MemOsWsClient("ws://127.0.0.1:18401/v1/ws");

    client.connect();
    expect(FakeWebSocket.instances).toHaveLength(1);
    client.disconnect();
    await Promise.resolve();
    await vi.runAllTimersAsync();

    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(client.connectionState).toBe("closed");
  });
});
