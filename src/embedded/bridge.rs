//! Python → Rust event bridge for the embedded gateway.
//!
//! The real Core gateway (``tui_gateway.server``) emits JSON-RPC event frames
//! through its transport. In embedded mode that transport is the Python
//! ``RustBridgeTransport`` (``hermes_embedded/rust_transport.py`` in the Core
//! checkout), whose sink is the ``_hermes_desktop_bridge.publish_event``
//! function this module installs into ``sys.modules`` at interpreter start
//! (see ``call.rs``). Frames flow straight into the event bus and the WebView
//! as ``gateway-ws-message`` payloads — the exact contract the TCP relay used
//! to serve, minus the socket.
//!
//! Frame routing (mirrors ``events.rs``):
//! - frames carrying an ``id`` are raw JSON-RPC responses → delivered
//!   verbatim so ``GatewayClient.handleFrame`` resolves the pending request;
//! - every other frame is Core's ``_event_frame`` shape
//!   (``{method:"event", params:{type, session_id, payload}}``) → delivered
//!   structured, bound to its session id so the frontend chat store applies it.

use std::sync::OnceLock;

use serde_json::Value;

/// The running app handle, captured when the first embedded gateway session
/// opens (or any embedded dispatch runs) so Python-pushed frames can reach the
/// WebView from any thread the GIL happens to be held on.
static APP: OnceLock<tauri::AppHandle> = OnceLock::new();

/// Record the app handle for the bridge. Idempotent; later calls are no-ops.
pub fn set_app_handle(app: tauri::AppHandle) {
    let _ = APP.set(app);
}

/// Route one frame from Python into the bus + WebView. Returns whether the
/// frame was emitted (false when no app handle is registered yet).
pub fn route_frame(connection_id: &str, frame: &Value) -> bool {
    let Some(app) = APP.get() else {
        log::debug!("embedded bridge frame dropped (no app handle): {connection_id}");
        return false;
    };
    if frame.get("id").is_some() {
        // Deferred long-handler response: raw frame, resolved by id.
        crate::embedded::events::publish_and_emit_raw(app, connection_id, frame.clone())
    } else {
        let params = frame.get("params").cloned().unwrap_or(Value::Null);
        let event_type = params
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("event")
            .to_string();
        let session_id = params
            .get("session_id")
            .and_then(Value::as_str)
            .map(String::from);
        let payload = params.get("payload").cloned().unwrap_or(Value::Null);
        let event = crate::embedded::events::EmbeddedEvent {
            event_type,
            payload,
            connection_id: connection_id.to_string(),
            session_id,
            raw_frame: None,
        };
        crate::embedded::events::publish_and_emit_event(app, &event)
    }
}

/// The function table Python calls into. Installed as a real module in
/// ``sys.modules`` so the Core-side transport needs no optional dependencies:
/// ``import _hermes_desktop_bridge`` simply succeeds inside the interpreter.
#[cfg(feature = "embedded-python")]
mod pymodule {
    use pyo3::prelude::*;
    use serde_json::Value;

    /// Push one JSON-serialized frame from the embedded Python runtime into
    /// the Rust event bridge. Mirrors the write() return convention of the
    /// WebSocket transport: True when a consumer accepted the frame.
    #[pyfunction]
    pub fn publish_event(connection_id: String, frame_json: &str) -> bool {
        match serde_json::from_str::<Value>(frame_json) {
            Ok(frame) => super::route_frame(&connection_id, &frame),
            Err(_) => false,
        }
    }

    /// Install ``_hermes_desktop_bridge`` into ``sys.modules``.
    pub fn install(py: Python<'_>) -> PyResult<()> {
        let module = pyo3::types::PyModule::new(py, "_hermes_desktop_bridge")?;
        module.add_function(pyo3::wrap_pyfunction!(publish_event, &module)?)?;
        let sys = py.import("sys")?;
        sys.getattr("modules")?
            .set_item("_hermes_desktop_bridge", &module)?;
        Ok(())
    }
}

/// Install the Python-side bridge module. Real implementation above (feature
/// embedded-python).
#[cfg(feature = "embedded-python")]
pub fn install(py: pyo3::Python<'_>) -> pyo3::PyResult<()> {
    pymodule::install(py)
}

/// Install the Python-side bridge module (no-op without the pyo3 backend —
/// the stub interpreter never starts, so there is nothing to install).
#[cfg(not(feature = "embedded-python"))]
pub fn install() {}

#[cfg(all(test, feature = "embedded-python"))]
mod tests {
    use super::*;

    #[test]
    fn route_frame_without_app_handle_reports_not_delivered() {
        // No app handle in unit tests → frames drop, never panic.
        let frame = serde_json::json!({
            "jsonrpc": "2.0",
            "method": "event",
            "params": {"type": "message", "session_id": "s1", "payload": {}}
        });
        assert!(!route_frame("c1", &frame));
    }
}
