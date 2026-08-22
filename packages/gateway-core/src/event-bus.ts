/**
 * Simple Emitter-based event bus for gateway events.
 *
 * v1 uses an in-memory EventEmitter-style bus. Events are fire-and-forget;
 * errors in listeners never block the pipeline.
 */

export type GatewayEvent =
  | { type: "inbound"; event: import("./adapter.js").InboundMessageEvent }
  | { type: "outbound"; platform: string; chatId: string; content: string }
  | { type: "typing"; platform: string; chatId: string }
  | { type: "session.start"; sessionId: string }
  | { type: "session.end"; sessionId: string }
  | { type: "error"; platform: string; error: string };

export type Listener = (event: GatewayEvent) => void;

export class EventBus {
  private listeners = new Set<Listener>();

  onDidPublish(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  publish(event: GatewayEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        // Errors never block the pipeline.
        console.error("Gateway event listener failed:", err);
      }
    }
  }

  listenerCount(): number {
    return this.listeners.size;
  }
}
