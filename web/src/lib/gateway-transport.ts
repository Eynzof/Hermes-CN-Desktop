/**
 * Transport-carrier contract for GatewayClient.
 *
 * The gateway protocol is JSON-RPC over a bidirectional byte stream. This
 * interface is intentionally a subset of the browser WebSocket API so both
 * `WebSocket` and `GatewayRelaySocket` can be used without changing the
 * protocol layer.
 *
 * Note: the SSE+POST fallback carrier described in `plans/sse-post-gateway-
 * transport.md` is intentionally NOT implemented. The Rust relay solves the
 * same problem with one ordered channel and no per-RPC HTTP round-trip.
 */

export interface GatewayTransport {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  // Event-style handler signatures matching native `WebSocket` so both
  // `WebSocket` and our `GatewayRelaySocket` structurally satisfy the contract.
  onopen: ((event: Event) => any) | null;
  onclose: ((event: CloseEvent) => any) | null;
  onerror: ((event: Event) => any) | null;
  onmessage: ((event: MessageEvent) => any) | null;
}

/** Minimal factory signature accepted by GatewayClient. */
export type GatewayTransportFactory = (url: string) => GatewayTransport;
