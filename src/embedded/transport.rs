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

/// Emit the `gateway-ws-closed` Tauri event — the exact wire shape the TCP
/// relay reader task (`ws_proxy.rs`) emits when a socket ends
/// (`{connectionId, message}`). The frontend `GatewayRelaySocket` settles
/// CLOSED on this event: pending RPC requests are rejected and
/// `GatewayClient` schedules a reconnect. Without it a replaced/closed
/// embedded session would leave the webview shim OPEN forever (stale
/// "connected" state and requests that only die on the 120s RPC timeout).
pub fn emit_gateway_ws_closed(app: &tauri::AppHandle, connection_id: &str, message: &str) {
    use tauri::Emitter;
    let _ = app.emit(
        "gateway-ws-closed",
        serde_json::json!({
            "connectionId": connection_id,
            "message": message,
        }),
    );
}

/// Open an embedded gateway session. The "handshake" is trivially successful
/// (no socket); the Python interpreter must already be Ready.
///
/// Replacing an existing session aborts it AND emits `gateway-ws-closed` for
/// the old connection id — parity with the TCP reader task, so the replaced
/// webview shim settles and reconnects instead of staying open.
pub fn open_embedded_gateway(
    app: &tauri::AppHandle,
    state: &State<'_, AppState>,
    connection_id: String,
) -> AppResult<()> {
    let _runtime = crate::embedded::ready_runtime()?;
    crate::embedded::bridge::set_app_handle(app.clone());
    let handle = EmbeddedGatewayHandle::new(connection_id.clone());
    let mut replaced: Option<String> = None;
    {
        let mut inner = state.inner.lock()?;
        if let Some(prev) = inner.embedded_gateway.take() {
            prev.abort.store(true, Ordering::Relaxed);
            prev.notify.notify_waiters();
            emit_gateway_ws_closed(
                app,
                &prev.connection_id,
                "replaced by a new embedded gateway session",
            );
            replaced = Some(prev.connection_id);
        }
        inner.embedded_gateway = Some(handle);
    }
    // Tear down the replaced Python-side connection (live transport
    // unregister + session reap) exactly like handle_ws' finally block.
    if let Some(prev_id) = replaced {
        std::thread::spawn(move || {
            let payload = serde_json::json!({ "connectionId": prev_id }).to_string();
            let _ =
                crate::embedded::call::call_handle_rpc("gateway.disconnect", &payload, &payload);
        });
    }
    log::info!("Embedded gateway session open ({connection_id})");

    // Mirror tui_gateway.ws.handle_ws accept: bind the per-connection
    // transport, register it for global broadcasts and emit gateway.ready.
    let connect_id = connection_id.clone();
    std::thread::spawn(move || {
        let payload = serde_json::json!({ "connectionId": connect_id }).to_string();
        let _ = crate::embedded::call::call_handle_rpc("gateway.connect", &payload, &payload);
    });
    Ok(())
}

/// Close the embedded gateway session for `connection_id`. Emits
/// `gateway-ws-closed` (same parity argument as `open_embedded_gateway`) and
/// runs the Python-side teardown for the connection's transport.
pub fn close_embedded_gateway(
    app: &tauri::AppHandle,
    state: &State<'_, AppState>,
    connection_id: &str,
) -> AppResult<()> {
    let mut torn_down = false;
    {
        let mut inner = state.inner.lock()?;
        if let Some(handle) = inner.embedded_gateway.as_ref() {
            if handle.connection_id == connection_id {
                handle.abort.store(true, Ordering::Relaxed);
                handle.notify.notify_waiters();
                inner.embedded_gateway = None;
                torn_down = true;
            }
        }
    }
    if torn_down {
        emit_gateway_ws_closed(app, connection_id, "closed");
        let closed_id = connection_id.to_string();
        std::thread::spawn(move || {
            let payload = serde_json::json!({ "connectionId": closed_id }).to_string();
            let _ =
                crate::embedded::call::call_handle_rpc("gateway.disconnect", &payload, &payload);
        });
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
    crate::embedded::bridge::set_app_handle(app.clone());
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
    let (method, params) = (parsed.method, parsed.params);
    let Some(method) = method.as_deref() else {
        // A JSON-RPC *request* (has an id) with no method is a protocol error.
        // Answer it in-band so the pending request rejects promptly instead of
        // hanging until the 120s RPC timeout (same class as the workbench 发送
        // bug). Pure notifications without a method are dropped silently.
        if parsed.id.is_some() {
            if let Some(event) = error_response_event(
                connection_id,
                parsed.id,
                -32600,
                "invalid request: missing method",
            ) {
                crate::embedded::events::publish_and_emit_raw(app, connection_id, event.payload);
            }
        }
        return Ok(());
    };

    let params_json = params.to_string();
    let ctx_json = serde_json::json!({
        "connectionId": connection_id,
        "hermesHome": state.inner.lock().map(|i| i.hermes_home.clone()).unwrap_or_default(),
    })
    .to_string();
    // Read the session id before the params value moves into the blocking
    // dispatch task — the synthetic-turn events need it to route to the frontend
    // session (applyGatewayEventAtom drops events without session_id).
    let session_id_hint = params
        .get("session_id")
        .and_then(Value::as_str)
        .map(String::from);

    // Long agent turns must not hold the tokio worker; run detached with the
    // GIL released while waiting (report §10.5). Method dispatch goes through
    // the typed rpc layer so unknown methods are rejected by the FFI registry.
    let method_owned = method.to_string();
    let dispatch = tauri::async_runtime::spawn_blocking(move || {
        let params = serde_json::from_str::<Value>(&params_json).unwrap_or(Value::Null);
        let ctx = serde_json::from_str::<Value>(&ctx_json).unwrap_or(Value::Null);
        crate::embedded::rpc::dispatch_gateway_method(&method_owned, params, ctx)
    })
    .await;

    let result = match dispatch {
        Ok(Ok(value)) => value,
        Ok(Err(err)) => {
            // A registry miss or a Python exception must NOT tear the gateway
            // session down (that was the refactor bug: the invoke error made
            // the relay socket close, GatewayClient rejected every pending
            // request as "WebSocket closed" and reconnected, and in the
            // browser companion the relay loop died). Answer with a raw
            // JSON-RPC error frame echoing the id — exactly what Core's
            // `_err(rid, ...)` does — and keep the session alive.
            log::warn!("Embedded gateway dispatch error for {method}: {err}");
            if let Some(event) = error_response_event(
                connection_id,
                parsed.id.clone(),
                dispatch_error_code(&err),
                &dispatch_error_message(&err),
            ) {
                crate::embedded::events::publish_and_emit_raw(app, connection_id, event.payload);
            }
            return Ok(());
        }
        Err(join_err) => {
            log::error!("Embedded gateway dispatch task panicked for {method}: {join_err}");
            if let Some(event) = error_response_event(
                connection_id,
                parsed.id.clone(),
                -32000,
                &format!("dispatch task panicked: {join_err}"),
            ) {
                crate::embedded::events::publish_and_emit_raw(app, connection_id, event.payload);
            }
            return Ok(());
        }
    };

    // A synchronous prompt handler (no `status:"streaming"` promise and no
    // self-emitted turn events — only possible with a stub payload, the real
    // Core dispatcher streams) needs the desktop to synthesize a complete
    // turn (message.start + message.complete) so the GUI's optimistic
    // "正在唤醒Hermes..." progress resolves instead of hanging forever.
    //
    // An error-ish result (`ok:false` / `status:"error"`) is answered as a
    // JSON-RPC *error* frame (below) so the frontend request rejects and
    // `setSessionError` resolves the optimistic progress to error — the same
    // path Core's `_err(rid, ...)` triggers, including the "session busy"
    // retry branch.
    if method == "prompt.submit" {
        if let Some((code, message)) = prompt_submit_error(&result) {
            if let Some(event) =
                error_response_event(connection_id, parsed.id.clone(), code, &message)
            {
                crate::embedded::events::publish_and_emit_raw(app, connection_id, event.payload);
            }
            return Ok(());
        }
        if prompt_submit_needs_synthetic_turn(&result) {
            let session_id = session_id_hint.as_deref().unwrap_or("embedded-session");
            for event in synthetic_turn_events(connection_id, session_id, &result) {
                crate::embedded::events::publish_and_emit(
                    app,
                    connection_id,
                    Some(session_id),
                    &event.event_type,
                    event.payload,
                );
            }
        }
    }

    if let Some(event) = response_event(connection_id, parsed.id, result) {
        crate::embedded::events::publish_and_emit_raw(app, connection_id, event.payload);
    }
    Ok(())
}

/// Whether a `prompt.submit` result is an explicit failure that must be
/// answered as a JSON-RPC error (never synthesized into a fake complete turn
/// and never delivered as a successful `result`).
///
/// Real Core signals prompt failures via `_err(rid, ...)` (a JSON-RPC error
/// frame); the reference package returns the failure in-band as `ok:false`
/// or `status:"error"`. Normalize both to the Core wire shape so the
/// frontend's request rejects and its "session busy" retry / error paths work
/// identically in embedded mode.
pub fn prompt_submit_error(result: &Value) -> Option<(i64, String)> {
    let failed = result.get("error").is_some()
        || result.get("ok").and_then(Value::as_bool) == Some(false)
        || result.get("status").and_then(Value::as_str) == Some("error");
    if !failed {
        return None;
    }
    let message = ["message", "error", "detail"]
        .iter()
        .find_map(|key| result.get(*key).and_then(Value::as_str))
        .filter(|s| !s.trim().is_empty())
        .map(String::from)
        .unwrap_or_else(|| "prompt submit failed".to_string());
    Some((-32000, message))
}

/// Map an FFI dispatch error to a JSON-RPC error code.
fn dispatch_error_code(err: &AppError) -> i64 {
    if err.to_string().contains("no FFI entry") {
        -32601 // method not found
    } else {
        -32000 // server error
    }
}

/// Map an FFI dispatch error to a bounded JSON-RPC error message (Python
/// tracebacks can be huge; cap what crosses the relay).
fn dispatch_error_message(err: &AppError) -> String {
    let msg = err.to_string();
    let mut chars = msg.chars();
    let capped: String = chars.by_ref().take(500).collect();
    if chars.next().is_some() {
        format!("{capped}…")
    } else {
        capped
    }
}

/// Whether a successful embedded `prompt.submit` result needs the desktop to
/// synthesize the assistant turn.
///
/// The real Core handler (`tui_gateway/methods_prompt.py`) returns
/// `{"status":"streaming"}` and emits `message.start` / `message.delta` /
/// `message.complete` events through the transport asynchronously, so the
/// real package never lands here. Only a synchronous stub payload accepts
/// (`ok`/`accepted`) without streaming; without a synthesized turn the GUI
/// would stay on the optimistic "正在唤醒Hermes..." progress forever.
pub fn prompt_submit_needs_synthetic_turn(result: &Value) -> bool {
    // Never synthesize for explicit failures: an RPC error result or an
    // error-status payload must surface as an error, not a fake complete turn.
    if result.get("error").is_some() || result.get("ok").and_then(Value::as_bool) == Some(false) {
        return false;
    }
    if result.get("status").and_then(Value::as_str) == Some("error") {
        return false;
    }
    result.get("status").and_then(Value::as_str) != Some("streaming")
}

/// Build the two gateway events (`message.start` + `message.complete`) that
/// resolve a synchronous stub turn. The assistant reply text comes from the
/// Python `handle_prompt` result (`reply`), with a neutral fallback.
pub fn synthetic_turn_events(
    connection_id: &str,
    session_id: &str,
    result: &Value,
) -> Vec<crate::embedded::events::EmbeddedEvent> {
    let reply = result
        .get("reply")
        .and_then(Value::as_str)
        .map(String::from)
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "（嵌入式演示模式）已收到你的消息。".to_string());
    vec![
        crate::embedded::events::EmbeddedEvent::gateway_event(
            connection_id,
            session_id,
            "message.start",
            serde_json::json!({}),
        ),
        crate::embedded::events::EmbeddedEvent::gateway_event(
            connection_id,
            session_id,
            "message.complete",
            serde_json::json!({ "text": reply, "status": "complete" }),
        ),
    ]
}

/// Build the delivery event for a completed gateway dispatch. Requests that
/// carried an `id` produce a RAW JSON-RPC response frame event — the same wire
/// shape the TCP relay (`ws_proxy.rs`) forwards — so `GatewayClient.handleFrame`
/// matches the pending request by id and resolves it. Notifications (no `id`)
/// produce `None` (nothing is delivered back).
pub fn response_event(
    connection_id: &str,
    id: Option<Value>,
    result: Value,
) -> Option<crate::embedded::events::EmbeddedEvent> {
    id.map(|id| {
        crate::embedded::events::EmbeddedEvent::response(
            connection_id,
            build_response_frame(id, result),
        )
    })
}

/// Build the delivery event for a failed gateway dispatch: a RAW JSON-RPC
/// *error* frame `{jsonrpc, id, error:{code, message}}` echoing the request
/// id — exactly what Core's `_err(rid, ...)` answers and what
/// `GatewayClient.handleFrame` rejects with. Notifications (no `id`) produce
/// `None` (the failure is logged by the caller).
///
/// NOTE: this must NOT go through `response_event` — that helper wraps its
/// payload as a successful `result`, which would nest the error frame and let
/// the request resolve instead of reject.
pub fn error_response_event(
    connection_id: &str,
    id: Option<Value>,
    code: i64,
    message: &str,
) -> Option<crate::embedded::events::EmbeddedEvent> {
    id.map(|id| {
        crate::embedded::events::EmbeddedEvent::response(
            connection_id,
            build_error_frame(id, code, message),
        )
    })
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

/// Build a JSON-RPC *error* frame for a failed FFI call — the wire shape
/// Core's `_err(rid, code, message)` produces and `GatewayClient.handleFrame`
/// turns into a rejected `request()` promise.
pub fn build_error_frame(id: Value, code: i64, message: &str) -> Value {
    serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message },
    })
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

    #[test]
    fn prompt_submit_synthetic_decision_matches_backend_contract() {
        // Reference package: synchronous accept, no streaming promise.
        assert!(prompt_submit_needs_synthetic_turn(&serde_json::json!({
            "ok": true,
            "accepted": true,
            "embedded": true,
        })));
        // Real Core: returns {"status":"streaming"} and emits its own events.
        assert!(!prompt_submit_needs_synthetic_turn(&serde_json::json!({
            "ok": true,
            "status": "streaming",
        })));
        // Explicit failures must NOT be turned into a fake complete turn.
        assert!(!prompt_submit_needs_synthetic_turn(&serde_json::json!({
            "ok": false,
            "error": "agent not ready",
        })));
        assert!(!prompt_submit_needs_synthetic_turn(&serde_json::json!({
            "ok": true,
            "status": "error",
            "message": "boom",
        })));
    }

    #[test]
    fn synthetic_turn_events_carry_session_and_reply() {
        let events = synthetic_turn_events(
            "conn-1",
            "embedded-session",
            &serde_json::json!({
                "ok": true,
                "accepted": true,
                "embedded": true,
                "status": "complete",
                "reply": "你好，我是嵌入式演示助手。",
            }),
        );
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].event_type, "message.start");
        assert_eq!(events[1].event_type, "message.complete");
        assert_eq!(events[0].session_id.as_deref(), Some("embedded-session"));
        assert_eq!(events[1].session_id.as_deref(), Some("embedded-session"));
        assert_eq!(events[1].payload["text"], "你好，我是嵌入式演示助手。");
    }

    #[test]
    fn synthetic_turn_events_fall_back_to_neutral_reply() {
        let events = synthetic_turn_events(
            "conn-1",
            "s1",
            &serde_json::json!({ "ok": true, "accepted": true, "embedded": true }),
        );
        assert_eq!(events[1].event_type, "message.complete");
        assert!(!events[1].payload["text"].as_str().unwrap_or("").is_empty());
    }

    #[test]
    fn error_frame_echoes_id_and_error() {
        let frame = build_error_frame(Value::from("w1"), -32601, "no FFI entry for method x");
        assert_eq!(frame["jsonrpc"], "2.0");
        assert_eq!(frame["id"], "w1");
        assert_eq!(frame["error"]["code"], -32601);
        assert_eq!(frame["error"]["message"], "no FFI entry for method x");
        assert!(
            frame.get("result").is_none(),
            "error frame must not carry result"
        );
    }

    #[test]
    fn prompt_submit_error_detects_in_band_failures() {
        // ok:false → JSON-RPC error (the reference package never returns it,
        // but a defensive transport must not deliver it as a success result).
        let (code, message) = prompt_submit_error(&serde_json::json!({
            "ok": false,
            "error": "agent not ready",
        }))
        .expect("ok:false must be an error");
        assert_eq!(code, -32000);
        assert_eq!(message, "agent not ready");

        // status:"error" → error (message field picked up).
        let (code, message) = prompt_submit_error(&serde_json::json!({
            "ok": true,
            "status": "error",
            "message": "boom",
        }))
        .expect("status:error must be an error");
        assert_eq!(code, -32000);
        assert_eq!(message, "boom");

        // Success / streaming results are NOT errors.
        assert!(
            prompt_submit_error(&serde_json::json!({ "ok": true, "status": "streaming" }))
                .is_none()
        );
        assert!(prompt_submit_error(&serde_json::json!({
            "ok": true,
            "accepted": true,
            "status": "complete",
        }))
        .is_none());
    }

    #[test]
    fn prompt_submit_error_falls_back_to_generic_message() {
        let (_, message) = prompt_submit_error(&serde_json::json!({ "ok": false })).unwrap();
        assert!(!message.is_empty());
    }

    #[test]
    fn error_response_event_is_raw_frame_and_none_for_notifications() {
        use crate::embedded::events::EmbeddedEvent;
        let event: EmbeddedEvent =
            error_response_event("conn-1", Some(Value::from("w9")), -32000, "boom")
                .expect("id-bearing request must produce an error response event");
        let wire: Value = serde_json::from_str(&event.wire_data()).unwrap();
        assert_eq!(wire["id"], "w9");
        assert_eq!(wire["error"]["message"], "boom");
        assert!(
            wire.get("method").is_none(),
            "error response must be a raw frame"
        );
        assert!(error_response_event("conn-1", None, -32000, "boom").is_none());
    }

    #[test]
    fn dispatch_error_details_classify_registry_miss() {
        let err = crate::error::AppError::EmbeddedPython {
            msg: "embedded gateway has no FFI entry for method nope".to_string(),
            traceback: None,
        };
        assert_eq!(dispatch_error_code(&err), -32601);
        let msg = dispatch_error_message(&err);
        assert!(msg.contains("no FFI entry"));
    }
}
