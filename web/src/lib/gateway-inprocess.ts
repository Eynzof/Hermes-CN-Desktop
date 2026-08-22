/**
 * In-process gateway transport stub.
 *
 * Phase B of `plans/sse-post-gateway-transport.md`: when the managed runtime is
 * fully in-process, this carrier will route JSON-RPC directly to a TypeScript
 * dispatch table instead of opening a WebSocket. Today it is a design-only
 * placeholder; the live paths remain native WebSocket or the Rust relay.
 *
 * TODO: implement dispatch({ method: "model.options" | "provider.probe" | ... })
 *        once the in-process agent runtime lands.
 */
import type { GatewayTransport } from "./gateway-transport";

export class GatewayInProcessTransport implements GatewayTransport {
  readyState = 0;
  onopen: GatewayTransport["onopen"] = null;
  onclose: GatewayTransport["onclose"] = null;
  onerror: GatewayTransport["onerror"] = null;
  onmessage: GatewayTransport["onmessage"] = null;

  constructor() {
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.(new Event("open"));
    });
  }

  private emitError(message: string): void {
    if (typeof ErrorEvent !== "undefined") {
      this.onerror?.(new ErrorEvent("error", { error: new Error(message) }));
    } else {
      this.onerror?.(new Event("error"));
    }
  }

  send(_data: string): void {
    // Placeholder: real implementation will dispatch to the in-process RPC table.
    this.emitError("GatewayInProcessTransport is not yet implemented");
  }

  close(): void {
    this.readyState = 3;
    // Cast to CloseEvent because jsdom/test runtimes may not expose the
    // constructor, but handlers only read `code`/`reason`.
    this.onclose?.({ reason: "not implemented", code: 1000 } as CloseEvent);
  }
}
