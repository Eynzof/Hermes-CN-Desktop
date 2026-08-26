//! Structured Python → Rust event dispatch (report §4 Phase 4 延伸, §10.4).
//!
//! The Python side `RustBridgeTransport.write(obj)` pushes frames into this
//! bus. Frames are upgraded from "string JSON frames" to structured
//! `EmbeddedEvent { event_type, payload }` values; the bus fans them out to:
//! - a `tokio::sync::broadcast` channel (in-process consumers), and
//! - the Tauri emitter as `gateway-ws-message` payloads (the exact contract
//!   `gateway-relay-socket.ts` already consumes — frontend unchanged).
//!
//! The event bus is transport-agnostic: it never opens a socket.

use serde::Serialize;
use serde_json::Value;
use tokio::sync::broadcast;

/// One structured event from Python → Rust → WebView.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedEvent {
    /// JSON-RPC `params.type` (e.g. `message`, `approval`, `session`, ...).
    pub event_type: String,
    /// Structured payload (PyDict → serde on the Python side).
    pub payload: Value,
    /// Connection/session id so stale relays cannot deliver into a fresh shim.
    pub connection_id: String,
}

impl EmbeddedEvent {
    /// Render the legacy wire shape the webview relay shim expects:
    /// `{ method: "event", params: { type, payload } }`.
    pub fn as_gateway_ws_message(&self) -> Value {
        serde_json::json!({
            "method": "event",
            "params": {
                "type": self.event_type,
                "payload": self.payload,
            }
        })
    }
}

/// Process-global event bus. `broadcast` capacity is generous: agent events
/// can burst, and a slow webview must not stall the Python loop.
const BUS_CAPACITY: usize = 1024;

static BUS: std::sync::OnceLock<broadcast::Sender<EmbeddedEvent>> = std::sync::OnceLock::new();

fn sender() -> broadcast::Sender<EmbeddedEvent> {
    BUS.get_or_init(|| {
        let (tx, _rx) = broadcast::channel(BUS_CAPACITY);
        tx
    })
    .clone()
}

/// Subscribe to embedded gateway events.
pub fn subscribe() -> broadcast::Receiver<EmbeddedEvent> {
    sender().subscribe()
}

/// Push an event onto the bus. The returned bool reports whether at least one
/// subscriber received it (for test/observability use).
pub fn publish(event: EmbeddedEvent) -> bool {
    let tx = sender();
    match tx.send(event) {
        Ok(receiver_count) => receiver_count > 0,
        Err(_) => false,
    }
}

/// Publish and also emit to the Tauri webview as a `gateway-ws-message` (the
/// contract `gateway-relay-socket.ts` listens for).
pub fn publish_and_emit(
    app: &tauri::AppHandle,
    connection_id: &str,
    event_type: &str,
    payload: Value,
) -> bool {
    use tauri::Emitter;
    let event = EmbeddedEvent {
        event_type: event_type.to_string(),
        payload,
        connection_id: connection_id.to_string(),
    };
    let delivered = publish(event.clone());
    // Same wire shape as the TCP relay: gateway-ws-message { connectionId, data }
    // (the private WsMessagePayload in commands/ws_proxy.rs serializes to this).
    let _ = app.emit(
        "gateway-ws-message",
        serde_json::json!({
            "connectionId": connection_id,
            "data": event.as_gateway_ws_message().to_string(),
        }),
    );
    delivered
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;
    use serde_json::json;

    #[test]
    fn publish_reaches_subscribers() {
        let mut rx = subscribe();
        let delivered = publish(EmbeddedEvent {
            event_type: "message".into(),
            payload: json!({ "content": "hi" }),
            connection_id: "c1".into(),
        });
        assert!(delivered);
        let got = rx.try_recv().unwrap();
        assert_eq!(got.event_type, "message");
        assert_eq!(got.payload["content"], "hi");
        assert_eq!(got.connection_id, "c1");
    }

    #[test]
    fn event_renders_legacy_ws_shape() {
        let event = EmbeddedEvent {
            event_type: "approval".into(),
            payload: json!({ "id": 7 }),
            connection_id: "c2".into(),
        };
        let msg = event.as_gateway_ws_message();
        assert_eq!(msg["method"], "event");
        assert_eq!(msg["params"]["type"], "approval");
        assert_eq!(msg["params"]["payload"]["id"], 7);
    }

    #[test]
    fn multiple_subscribers_all_receive() {
        let mut rx1 = subscribe();
        let mut rx2 = subscribe();
        publish(EmbeddedEvent {
            event_type: "session".into(),
            payload: json!({}),
            connection_id: "c3".into(),
        });
        assert!(rx1.try_recv().is_ok());
        assert!(rx2.try_recv().is_ok());
    }
}
