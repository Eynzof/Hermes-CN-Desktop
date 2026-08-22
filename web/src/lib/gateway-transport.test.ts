/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from "vitest";
import { GatewayInProcessTransport } from "./gateway-inprocess";
import { GatewayRelaySocket } from "./gateway-relay-socket";
import type { GatewayTransport } from "./gateway-transport";

describe("GatewayTransport contract", () => {
  it("GatewayRelaySocket structurally satisfies GatewayTransport", () => {
    // Compile-time structural check. GatewayRelaySocket is WebSocket-like but
    // not a subclass; the protocol layer only needs these four properties.
    const socket: GatewayTransport = new GatewayRelaySocket("ws://localhost/api/ws");
    expect(socket.readyState).toBe(0);
    expect(typeof socket.send).toBe("function");
    expect(typeof socket.close).toBe("function");
    socket.close();
  });

  it("browser WebSocket structurally satisfies GatewayTransport", () => {
    if (typeof WebSocket === "undefined") {
      // jsdom does not implement WebSocket, but the TypeScript type check below
      // still proves native WebSocket matches GatewayTransport at compile time.
      return;
    }
    const ws: GatewayTransport = new WebSocket("ws://localhost/api/ws");
    expect(typeof ws.send).toBe("function");
    expect(typeof ws.close).toBe("function");
    ws.close();
  });

  it("GatewayInProcessTransport opens and reports not-implemented on send", async () => {
    const transport = new GatewayInProcessTransport();
    const opened = await new Promise<boolean>((resolve) => {
      transport.onopen = () => resolve(true);
    });
    expect(opened).toBe(true);
    expect(transport.readyState).toBe(1);

    const error = await new Promise<unknown>((resolve) => {
      transport.onerror = (ev) => resolve(ev);
      transport.send('{"jsonrpc":"2.0"}');
    });
    if (typeof ErrorEvent !== "undefined" && error instanceof ErrorEvent) {
      expect((error as ErrorEvent).error).toBeInstanceOf(Error);
    } else {
      expect(error).toBeInstanceOf(Event);
    }
  });
});
