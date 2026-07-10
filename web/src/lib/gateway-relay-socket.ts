// WebSocket-compatible shim over the Rust /api/ws relay (src/commands/ws_proxy.rs).
//
// Packaged webviews (WKWebView / WebView2) may refuse to open ws://127.0.0.1
// from the tauri:// origin. The Rust process has no such origin restriction, so
// it opens the runtime's OFFICIAL /api/ws JSON-RPC socket and relays text
// frames to/from the webview via Tauri commands + events. This class adapts
// that relay to the subset of the WebSocket interface GatewayClient consumes
// (on* handler properties, readyState, send, close), so the protocol layer is
// byte-identical between the native and relay paths.
//
// Wire contract (must match ws_proxy.rs):
//   invoke gateway_ws_open  { connectionId }  → resolves on WS handshake success
//   event  gateway-ws-message { connectionId, data }   → one inbound text frame
//   event  gateway-ws-closed  { connectionId, message } → close/error/EOF
//   invoke gateway_ws_send  { connectionId, data }
//   invoke gateway_ws_close { connectionId }
// Every event is tagged with connectionId so a stale relay from a previous
// connection can never deliver into this socket.

interface RelayMessagePayload {
  connectionId: string;
  data: string;
}

interface RelayClosedPayload {
  connectionId: string;
  message: string;
  /** WebSocket close code from the peer, when a Close frame was received.
   * 4401 = auth rejected, 4403 = host/origin rejected. */
  code?: number;
}

/** A mint/handshake auth failure is surfaced by Rust as an error string with
 * this prefix (see AppError::AuthSessionExpired). Map it to close code 4401 so
 * the client's reconnect-suppression logic treats it like a 4401 Close. */
const AUTH_EXPIRED_PREFIX = "AUTH_SESSION_EXPIRED";

type UnlistenFn = () => void;

function nextConnectionId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {}
  return `relay-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export class GatewayRelaySocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly url: string;
  readyState: number = GatewayRelaySocket.CONNECTING;

  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;

  private readonly connectionId = nextConnectionId();
  private unlistenMessage: UnlistenFn | null = null;
  private unlistenClosed: UnlistenFn | null = null;
  private closedByUs = false;

  // The factory signature is synchronous (`(url) => WebSocket`), so the async
  // open handshake runs detached; GatewayClient assigns its on* handlers right
  // after construction, well before the first dynamic import resolves.
  constructor(url: string) {
    // The Rust side builds the real URL from AppState (and refreshes the token
    // on auth failure); the argument is kept only for factory compatibility.
    this.url = url;
    void this.open();
  }

  private async open(): Promise<void> {
    try {
      const [{ invoke }, { listen }] = await Promise.all([
        import("@tauri-apps/api/core"),
        import("@tauri-apps/api/event"),
      ]);

      this.unlistenMessage = await listen<RelayMessagePayload>("gateway-ws-message", (event) => {
        if (event.payload.connectionId !== this.connectionId) return;
        if (this.readyState !== GatewayRelaySocket.OPEN) return;
        this.onmessage?.({ data: event.payload.data });
      });
      this.unlistenClosed = await listen<RelayClosedPayload>("gateway-ws-closed", (event) => {
        if (event.payload.connectionId !== this.connectionId) return;
        this.settleClosed(event.payload.message, event.payload.code);
      });

      if (this.closedByUs) {
        // close() raced the handshake — drop the listeners and bail out.
        this.detachListeners();
        return;
      }

      await invoke("gateway_ws_open", { input: { connectionId: this.connectionId } });

      if (this.closedByUs) {
        void invoke("gateway_ws_close", { input: { connectionId: this.connectionId } }).catch(() => {});
        this.detachListeners();
        return;
      }

      this.readyState = GatewayRelaySocket.OPEN;
      this.onopen?.({});
    } catch (error) {
      this.onerror?.(error);
      const message = error instanceof Error ? error.message : String(error);
      // A gateway_ws_open rejection carrying the auth-expired marker is an
      // authentication failure, not a transient drop — synthesize a 4401 so
      // the client stops blindly reconnecting and prompts re-login.
      const code = message.includes(AUTH_EXPIRED_PREFIX) ? 4401 : undefined;
      this.settleClosed(message, code);
    }
  }

  send(data: string): void {
    if (this.readyState !== GatewayRelaySocket.OPEN) {
      // Native WebSocket throws on send-before-open; GatewayClient catches it.
      throw new Error("Relay socket is not open");
    }
    void import("@tauri-apps/api/core")
      .then(({ invoke }) =>
        invoke("gateway_ws_send", { input: { connectionId: this.connectionId, data } }),
      )
      .catch((error) => {
        // An async send failure means the relay died under us — surface it as
        // a connection loss so GatewayClient's reconnect path takes over.
        this.onerror?.(error);
        this.settleClosed(error instanceof Error ? error.message : String(error));
      });
  }

  close(): void {
    if (this.readyState === GatewayRelaySocket.CLOSED) return;
    this.closedByUs = true;
    this.readyState = GatewayRelaySocket.CLOSING;
    void import("@tauri-apps/api/core")
      .then(({ invoke }) => invoke("gateway_ws_close", { input: { connectionId: this.connectionId } }))
      .catch(() => {});
    this.settleClosed("closed");
  }

  private settleClosed(reason: string, code?: number): void {
    if (this.readyState === GatewayRelaySocket.CLOSED) return;
    this.readyState = GatewayRelaySocket.CLOSED;
    this.detachListeners();
    this.onclose?.({ reason, code });
  }

  private detachListeners(): void {
    this.unlistenMessage?.();
    this.unlistenClosed?.();
    this.unlistenMessage = null;
    this.unlistenClosed = null;
  }
}
