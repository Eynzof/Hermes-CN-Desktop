//! Rust side of the RustBridgeTransport (report §3.3 / Phase 3, §4 Phase 4
//! 延伸).
//!
//! In embedded mode the gateway has **no WebSocket at all**. The webview keeps
//! its exact relay contract (`gateway_ws_open/send/close` +
//! `gateway-ws-message` events, consumed by `gateway-relay-socket.ts`), but the
//! Rust side replaces the TCP WebSocket session with an in-memory
//! session:
//!
//! ```text
//! webview --gateway_ws_send--> JSON-RPC frame -> hermes_embedded.api.handle_rpc
//! hermes_embedded RustBridgeTransport.write -> events::publish_and_emit -> webview
//! ```
//!
//! Session.resume semantics are preserved because the protocol layer is
//! untouched — a reconnect is just a new in-memory session. There is no 10s
//! keepalive ping (no network half-open), no token scraping, no `/api/ws`.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde_json::Value;
use tauri::State;
use tokio::sync::Notify;

use crate::error::{AppError, AppResult};
use crate::state::AppState;

/// Handle to the live embedded gateway session. Mirrors the TCP relay's
/// abort/notify pattern so `gateway_ws_close` tears it down identically.
pub struct EmbeddedGatewayHandle {
    pub connection_id: String,
    pub abort: Arc<AtomicBool>,
    pub notify: Arc<Notify>,
}

impl EmbeddedGatewayHandle {
    pub fn new(connection_id: String) -> Self {
        Self {
            connection_id,
            abort: Arc::new(AtomicBool::new(false)),
            notify: Arc::new(Notify::new()),
        }
    }
}

/// Open an embedded gateway session. The "handshake" is trivially successful
/// (no socket); the Python interpreter must already be Ready.
pub fn open_embedded_gateway(state: &State<'_, AppState>, connection_id: String) -> AppResult<()> {
    let _runtime = crate::embedded::ready_runtime()?;
    let handle = EmbeddedGatewayHandle::new(connection_id.clone());
    let mut inner = state.inner.lock()?;
    if let Some(prev) = inner.embedded_gateway.take() {
        prev.abort.store(true, Ordering::Relaxed);
        prev.notify.notify_waiters();
    }
    inner.embedded_gateway = Some(handle);
    log::info!("Embedded gateway session open ({connection_id})");
    Ok(())
}

/// Close the embedded gateway session for `connection_id`.
pub fn close_embedded_gateway(state: &State<'_, AppState>, connection_id: &str) -> AppResult<()> {
    let mut inner = state.inner.lock()?;
    if let Some(handle) = inner.embedded_gateway.as_ref() {
        if handle.connection_id == connection_id {
            handle.abort.store(true, Ordering::Relaxed);
            handle.notify.notify_waiters();
            inner.embedded_gateway = None;
        }
    }
    Ok(())
}

/// Send one JSON-RPC frame from the webview into the embedded gateway.
/// The frame is dispatched to `hermes_embedded.api.handle_rpc`; the response
/// (if the frame carries an `id`) is emitted back as a `gateway-ws-message`.
pub async fn dispatch_frame(
    app: &tauri::AppHandle,
    state: &State<'_, AppState>,
    connection_id: &str,
    data: String,
) -> AppResult<()> {
    let _runtime = crate::embedded::ready_runtime()?;
    {
        let inner = state.inner.lock()?;
        let active = inner
            .embedded_gateway
            .as_ref()
            .is_some_and(|h| h.connection_id == connection_id);
        if !active {
            return Err(AppError::GatewayWs(
                "no active embedded gateway connection".to_string(),
            ));
        }
    }

    let parsed = parse_frame(&data)?;
    let (Some(method), params) = (parsed.method, parsed.params) else {
        // Notification frames without a method are dropped silently.
        return Ok(());
    };

    let params_json = params.to_string();
    let ctx_json = serde_json::json!({
        "connectionId": connection_id,
        "hermesHome": state.inner.lock().map(|i| i.hermes_home.clone()).unwrap_or_default(),
    })
    .to_string();

    // Long agent turns must not hold the tokio worker; run detached with the
    // GIL released while waiting (report §10.5). Method dispatch goes through
    // the typed rpc layer so unknown methods are rejected by the FFI registry.
    let method_owned = method.to_string();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let params = serde_json::from_str::<Value>(&params_json).unwrap_or(Value::Null);
        let ctx = serde_json::from_str::<Value>(&ctx_json).unwrap_or(Value::Null);
        crate::embedded::rpc::dispatch_gateway_method(&method_owned, params, ctx)
    })
    .await
    .map_err(|e| AppError::EmbeddedPython {
        msg: format!("dispatch task panicked: {e}"),
        traceback: None,
    })??;

    if let Some(id) = parsed.id {
        let response = build_response_frame(id, result);
        crate::embedded::events::publish_and_emit(
            app,
            connection_id,
            "response",
            serde_json::json!({ "frame": response }),
        );
    }
    Ok(())
}

/// Parsed view of an inbound JSON-RPC frame.
pub struct ParsedFrame {
    pub id: Option<Value>,
    pub method: Option<String>,
    pub params: Value,
}

/// Parse a JSON-RPC 2.0 frame without losing `id` (must echo back exactly).
pub fn parse_frame(data: &str) -> AppResult<ParsedFrame> {
    let v: Value = serde_json::from_str(data)
        .map_err(|e| AppError::InvalidRequest(format!("gateway frame is not valid JSON: {e}")))?;
    let obj = v.as_object().ok_or_else(|| {
        AppError::InvalidRequest("gateway frame must be a JSON object".to_string())
    })?;
    Ok(ParsedFrame {
        id: obj.get("id").cloned(),
        method: obj.get("method").and_then(Value::as_str).map(String::from),
        params: obj.get("params").cloned().unwrap_or(Value::Null),
    })
}

/// Build the JSON-RPC response frame for a completed FFI call.
pub fn build_response_frame(id: Value, result: Value) -> Value {
    serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    #[test]
    fn parse_frame_extracts_method_params_id() {
        let frame = r#"{"jsonrpc":"2.0","id":42,"method":"prompt.submit","params":{"text":"hi"}}"#;
        let parsed = parse_frame(frame).unwrap();
        assert_eq!(parsed.method.as_deref(), Some("prompt.submit"));
        assert_eq!(parsed.id, Some(Value::from(42)));
        assert_eq!(parsed.params["text"], "hi");
    }

    #[test]
    fn parse_frame_allows_missing_id_and_params() {
        let parsed = parse_frame(r#"{"jsonrpc":"2.0","method":"session.resume"}"#).unwrap();
        assert!(parsed.id.is_none());
        assert_eq!(parsed.method.as_deref(), Some("session.resume"));
        assert_eq!(parsed.params, Value::Null);
    }

    #[test]
    fn parse_frame_rejects_non_json() {
        assert!(parse_frame("not json").is_err());
        assert!(parse_frame(r#"[1,2,3]"#).is_err());
    }

    #[test]
    fn response_frame_echoes_id_and_result() {
        let frame = build_response_frame(Value::from(7), serde_json::json!({ "ok": true }));
        assert_eq!(frame["jsonrpc"], "2.0");
        assert_eq!(frame["id"], 7);
        assert_eq!(frame["result"]["ok"], true);
    }
}
