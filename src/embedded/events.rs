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

/// Bus/relay event type used for JSON-RPC responses to requests that carried an
/// `id`. These events carry the RAW frame as their payload and are delivered on
/// the wire verbatim (no `{method:"event"}` wrapper) — `GatewayClient`
/// (`gateway-client.ts` `handleFrame`) resolves pending requests only when it
/// sees a top-level `id`, exactly like the frames the TCP relay
/// (`ws_proxy.rs`) forwards. Wrapping a response as an event leaves every
/// request (e.g. `session.create` when pressing 发送 on the workbench) pending
/// until the 120s RPC timeout.
pub const RPC_RESPONSE_EVENT: &str = "response";

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
    /// Gateway session id (`params.session_id`), the same field Core's
    /// `tui_gateway.server._event_frame` puts on every event frame. The
    /// frontend `applyGatewayEventAtom` drops events without a session id, so
    /// this must be set for turn/status events or the chat store never applies
    /// them (the optimistic "正在唤醒Hermes..." progress hangs forever).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// Raw JSON-RPC frame (a response to a request that carried an `id`). When
    /// set, `wire_data()` returns this frame verbatim; otherwise the event is
    /// wrapped as `{method:"event", params:{type, payload}}`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw_frame: Option<String>,
}

impl EmbeddedEvent {
    /// RPC response event: the payload IS the raw `{jsonrpc,id,result}` frame
    /// and the relay line delivers it as-is so the pending request resolves.
    pub fn response(connection_id: &str, frame: Value) -> Self {
        Self {
            event_type: RPC_RESPONSE_EVENT.to_string(),
            payload: frame.clone(),
            connection_id: connection_id.to_string(),
            session_id: None,
            raw_frame: Some(frame.to_string()),
        }
    }

    /// Build a gateway event bound to a session — the exact frame Core's
    /// `tui_gateway.server._emit` produces (`_event_frame`), so the frontend
    /// `GatewayClient`/`applyGatewayEventAtom` applies it to the right session.
    pub fn gateway_event(
        connection_id: &str,
        session_id: &str,
        event_type: &str,
        payload: Value,
    ) -> Self {
        Self {
            event_type: event_type.to_string(),
            payload,
            connection_id: connection_id.to_string(),
            session_id: Some(session_id.to_string()),
            raw_frame: None,
        }
    }

    /// Render the legacy wire shape the webview relay shim expects — matching
    /// Core `tui_gateway/server.py::_event_frame`:
    /// `{ jsonrpc: "2.0", method: "event", params: { type, session_id, payload } }`.
    pub fn as_gateway_ws_message(&self) -> Value {
        let mut params = serde_json::Map::new();
        params.insert("type".to_string(), Value::String(self.event_type.clone()));
        if let Some(session_id) = &self.session_id {
            params.insert("session_id".to_string(), Value::String(session_id.clone()));
        }
        params.insert("payload".to_string(), self.payload.clone());
        serde_json::json!({
            "jsonrpc": "2.0",
            "method": "event",
            "params": params,
        })
    }

    /// Exact relay `data` payload delivered to the webview (and to in-process
    /// consumers like the browser-companion relay). Raw RPC responses are
    /// delivered verbatim; all other events keep the `{method:"event"}`
    /// wrapper the protocol layer expects.
    pub fn wire_data(&self) -> String {
        match &self.raw_frame {
            Some(frame) => frame.clone(),
            None => self.as_gateway_ws_message().to_string(),
        }
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
    session_id: Option<&str>,
    event_type: &str,
    payload: Value,
) -> bool {
    let event = EmbeddedEvent {
        event_type: event_type.to_string(),
        payload,
        connection_id: connection_id.to_string(),
        session_id: session_id.map(String::from),
        raw_frame: None,
    };
    emit_gateway_ws_message(app, &event)
}

/// Publish and emit a raw JSON-RPC response frame (result of a request that
/// carried an `id`). The `data` delivered to the webview is the frame itself,
/// byte-identical to what the TCP relay (`ws_proxy.rs`) forwards, so
/// `GatewayClient.handleFrame` matches the pending request by id and resolves
/// it. Must NOT be wrapped as `{method:"event"}` — that would hang the caller
/// until the RPC timeout (the workbench 发送 bug).
pub fn publish_and_emit_raw(app: &tauri::AppHandle, connection_id: &str, frame: Value) -> bool {
    emit_gateway_ws_message(app, &EmbeddedEvent::response(connection_id, frame))
}

fn emit_gateway_ws_message(app: &tauri::AppHandle, event: &EmbeddedEvent) -> bool {
    use tauri::Emitter;
    let delivered = publish(event.clone());
    // Same wire shape as the TCP relay: gateway-ws-message { connectionId, data }
    // (the private WsMessagePayload in commands/ws_proxy.rs serializes to this).
    let _ = app.emit(
        "gateway-ws-message",
        serde_json::json!({
            "connectionId": event.connection_id,
            "data": event.wire_data(),
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
            session_id: Some("s1".into()),
            raw_frame: None,
        });
        assert!(delivered);
        let got = rx.try_recv().unwrap();
        assert_eq!(got.event_type, "message");
        assert_eq!(got.payload["content"], "hi");
        assert_eq!(got.connection_id, "c1");
        assert_eq!(got.session_id.as_deref(), Some("s1"));
    }

    #[test]
    fn event_renders_legacy_ws_shape() {
        let event = EmbeddedEvent {
            event_type: "approval".into(),
            payload: json!({ "id": 7 }),
            connection_id: "c2".into(),
            session_id: None,
            raw_frame: None,
        };
        let msg = event.as_gateway_ws_message();
        assert_eq!(msg["jsonrpc"], "2.0");
        assert_eq!(msg["method"], "event");
        assert_eq!(msg["params"]["type"], "approval");
        assert_eq!(msg["params"]["payload"]["id"], 7);
        assert!(msg["params"].get("session_id").is_none());
    }

    #[test]
    fn multiple_subscribers_all_receive() {
        let mut rx1 = subscribe();
        let mut rx2 = subscribe();
        publish(EmbeddedEvent {
            event_type: "session".into(),
            payload: json!({}),
            connection_id: "c3".into(),
            session_id: None,
            raw_frame: None,
        });
        assert!(rx1.try_recv().is_ok());
        assert!(rx2.try_recv().is_ok());
    }

    #[test]
    fn rpc_response_wire_is_raw_frame_not_event_wrapper() {
        // Regression for the workbench 发送 hang: an RPC response must be
        // delivered as the raw `{jsonrpc,id,result}` frame so
        // GatewayClient.handleFrame can resolve the pending request by id.
        let frame = json!({ "jsonrpc": "2.0", "id": "w1", "result": { "session_id": "s1" } });
        let event = EmbeddedEvent::response("c1", frame.clone());
        assert_eq!(event.event_type, RPC_RESPONSE_EVENT);
        let wire: Value = serde_json::from_str(&event.wire_data()).unwrap();
        assert_eq!(wire, frame);
        assert!(
            wire.get("method").is_none(),
            "response must not be event-wrapped"
        );
        assert_eq!(wire["id"], "w1");
        assert_eq!(wire["result"]["session_id"], "s1");
    }

    #[test]
    fn gateway_event_wire_stays_wrapped() {
        let event = EmbeddedEvent {
            event_type: "message".into(),
            payload: json!({ "content": "hi" }),
            connection_id: "c1".into(),
            session_id: Some("gw-1".into()),
            raw_frame: None,
        };
        let wire: Value = serde_json::from_str(&event.wire_data()).unwrap();
        assert_eq!(wire["jsonrpc"], "2.0");
        assert_eq!(wire["method"], "event");
        assert_eq!(wire["params"]["type"], "message");
        assert_eq!(wire["params"]["session_id"], "gw-1");
        assert_eq!(wire["params"]["payload"]["content"], "hi");
        assert!(wire.get("id").is_none());
    }

    #[test]
    fn gateway_event_wire_carries_session_id_for_frontend_routing() {
        // Regression for the embedded conversation hang: the frontend
        // `applyGatewayEventAtom` drops events without `params.session_id`, so
        // a `message.start` / `message.complete` event that omits it leaves the
        // optimistic "正在唤醒Hermes..." progress stuck forever.
        let event = EmbeddedEvent::gateway_event("conn-1", "embedded-session", "message.complete", json!({ "text": "ok" }));
        let wire: Value = serde_json::from_str(&event.wire_data()).unwrap();
        assert_eq!(wire["params"]["type"], "message.complete");
        assert_eq!(wire["params"]["session_id"], "embedded-session");
        assert_eq!(wire["params"]["payload"]["text"], "ok");
        assert_eq!(event.session_id.as_deref(), Some("embedded-session"));
    }
}
