// Native-vs-relay socket path selection for the gateway WebSocket.
//
// Both paths speak the IDENTICAL official /api/ws JSON-RPC protocol through
// the same GatewayClient — only the byte carrier differs:
//   - "native": the webview opens ws://127.0.0.1 itself (official desktop
//     architecture; zero proxy hops)
//   - "relay":  Rust opens the socket and forwards frames over Tauri IPC
//     (fallback for packaged webviews that refuse ws:// from tauri://)
//
// Selection precedence (highest first):
//   1. URL query ?wspath=native|relay — ad-hoc QA override, not persisted
//   2. learned value (HERMES_WS_PATH_LEARNED in the UI store) — sticky result
//      of a previous probe, skips re-probing on every launch
//   3. default "native", with automatic runtime fallback (below)
//
// Fallback policy: a webview that blocks ws://127.0.0.1 fails in one of two
// ways. A synchronous SecurityError from `new WebSocket(...)` flips to relay
// IMMEDIATELY (same connect attempt, zero added latency). An async pre-open
// failure increments a streak; the flip happens on the 2nd consecutive one —
// the retry in between goes through GatewayClient.scheduleReconnect, which
// refreshes the gateway URL first, ruling out token rotation masquerading as
// a blocked socket. Post-open closes never count: an established-then-dropped
// connection is a reconnect concern, not a path concern. If the relay itself
// then fails pre-open repeatedly, the learned value is cleared and the path
// reverts to native so the next attempts/launches re-probe (a down dashboard
// fails both paths alike; whichever works first sticks).
import { GatewayRelaySocket } from "./gateway-relay-socket";
import { runtime } from "./runtime";
import { readUiValue, removeUiValue, writeUiValue } from "./ui-store";

export type GatewaySocketPath = "native" | "relay";

const LEARNED_KEY = "HERMES_WS_PATH_LEARNED";
const NATIVE_FAILURE_FLIP_THRESHOLD = 2;
const RELAY_FAILURE_RESET_THRESHOLD = 2;

let currentPath: GatewaySocketPath | null = null;
let queryOverride: GatewaySocketPath | null | undefined;
let nativeFailureStreak = 0;
let relayFailureStreak = 0;

function readQueryOverride(): GatewaySocketPath | null {
  if (queryOverride !== undefined) return queryOverride;
  queryOverride = null;
  try {
    if (typeof window !== "undefined") {
      const value = new URLSearchParams(window.location.search).get("wspath");
      if (value === "native" || value === "relay") queryOverride = value;
    }
  } catch {}
  return queryOverride;
}

function readLearnedPath(): GatewaySocketPath | null {
  try {
    const value = readUiValue<string | undefined>(LEARNED_KEY, undefined);
    if (value === "native" || value === "relay") return value;
  } catch {}
  return null;
}

function learn(path: GatewaySocketPath | null): void {
  // QA overrides must not poison the learned preference.
  if (readQueryOverride()) return;
  try {
    if (readLearnedPath() === path) return;
    if (path === null) removeUiValue(LEARNED_KEY);
    else writeUiValue(LEARNED_KEY, path);
  } catch {}
}

export function getActiveSocketPath(): GatewaySocketPath {
  if (currentPath) return currentPath;
  currentPath = readQueryOverride() ?? readLearnedPath() ?? "native";
  return currentPath;
}

function flipToRelay(reason: string): void {
  // Surfaced in the webview console / debug bundle so the field can tell a
  // genuinely blocked webview from a misconfigured native path.
  console.warn(`[gateway-socket-path] native WS unavailable (${reason}) — switching to Rust relay`);
  currentPath = "relay";
  relayFailureStreak = 0;
  learn("relay");
}

function resetToNative(): void {
  console.warn("[gateway-socket-path] relay keeps failing pre-open — clearing learned path, re-probing native");
  currentPath = "native";
  nativeFailureStreak = 0;
  learn(null);
}

// Observe one native connection attempt. Uses addEventListener so it coexists
// with the on* handlers GatewayClient assigns after the factory returns.
function watchNativeAttempt(ws: WebSocket): void {
  let opened = false;
  let counted = false;
  const onOpen = () => {
    opened = true;
    nativeFailureStreak = 0;
    learn("native");
  };
  const onPreOpenFailure = () => {
    if (opened || counted) return;
    counted = true;
    nativeFailureStreak += 1;
    if (nativeFailureStreak >= NATIVE_FAILURE_FLIP_THRESHOLD) {
      flipToRelay(`${nativeFailureStreak} consecutive pre-open failures`);
    }
  };
  ws.addEventListener("open", onOpen, { once: true });
  ws.addEventListener("error", onPreOpenFailure, { once: true });
  ws.addEventListener("close", onPreOpenFailure, { once: true });
}

function watchRelayAttempt(socket: GatewayRelaySocket): void {
  // GatewayClient owns socket.on* — observe via a chained wrapper instead.
  let opened = false;
  const prevOnOpen = socket.onopen;
  const prevOnClose = socket.onclose;
  socket.onopen = (ev) => {
    opened = true;
    relayFailureStreak = 0;
    prevOnOpen?.(ev);
  };
  socket.onclose = (ev) => {
    if (!opened) {
      relayFailureStreak += 1;
      if (relayFailureStreak >= RELAY_FAILURE_RESET_THRESHOLD) resetToNative();
    }
    prevOnClose?.(ev);
  };
}

// GatewaySocketFactory passed to the GatewayClient singleton. Non-Tauri
// platforms always use the native WebSocket (the relay commands only exist in
// the Tauri shell).
export function createGatewaySocket(url: string): WebSocket {
  if (runtime.platform !== "tauri") {
    return new WebSocket(url);
  }

  if (getActiveSocketPath() === "relay") {
    const socket = new GatewayRelaySocket(url);
    queueMicrotask(() => watchRelayAttempt(socket));
    return socket as unknown as WebSocket;
  }

  let ws: WebSocket;
  try {
    ws = new WebSocket(url);
  } catch (error) {
    // Synchronous SecurityError — the webview refuses ws:// from this origin.
    // Fall back within the SAME connect attempt so the user never waits.
    flipToRelay(`constructor threw: ${error instanceof Error ? error.message : String(error)}`);
    const socket = new GatewayRelaySocket(url);
    queueMicrotask(() => watchRelayAttempt(socket));
    return socket as unknown as WebSocket;
  }
  watchNativeAttempt(ws);
  return ws;
}

// Test hook: reset module-level state so vitest cases are independent.
export function __resetSocketPathForTests(): void {
  currentPath = null;
  queryOverride = undefined;
  nativeFailureStreak = 0;
  relayFailureStreak = 0;
}
