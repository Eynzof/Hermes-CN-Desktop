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

  it("GatewayInProcessTransport opens and dispatches JSON-RPC locally", async () => {
    const transport = new GatewayInProcessTransport();
    const opened = await new Promise<boolean>((resolve) => {
      transport.onopen = () => resolve(true);
    });
    expect(opened).toBe(true);
    expect(transport.readyState).toBe(1);

    const request = (json: string) =>
      new Promise<unknown>((resolve) => {
        transport.onmessage = (ev) => resolve(JSON.parse(ev.data));
        transport.send(json);
      });

    // Known method — local catalog response.
    const ok = (await request('{"jsonrpc":"2.0","id":"w1","method":"model.options","params":{}}')) as {
      id: string;
      result: { providers?: unknown[] };
    };
    expect(ok.id).toBe("w1");
    expect(Array.isArray(ok.result?.providers)).toBe(true);
    expect(ok.result!.providers!.length).toBeGreaterThan(0);

    // Unknown method — JSON-RPC error frame.
    const bad = (await request('{"jsonrpc":"2.0","id":"w2","method":"does.not.exist","params":{}}')) as {
      id: string;
      error?: { code: number; message: string };
    };
    expect(bad.id).toBe("w2");
    expect(bad.error?.code).toBe(-32000);
  });
});
