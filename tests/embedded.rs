//! Integration tests for the embedded runtime architecture (refactor_report.md).
//!
//! These tests run without a Python interpreter (default features): they cover
//! the parts of the embedded design that are pure Rust — payload resolution,
//! FFI coverage gate, gateway frame parsing, event bus, and the mode flag
//! plumbing. The real pyo3 interpreter is exercised by tests/embedded_python.rs
//! behind the `embedded-python` feature.

use hermes_agent_cn::embedded::ffi;
use hermes_agent_cn::embedded::transport::{
    build_error_frame, build_response_frame, parse_frame, prompt_submit_error,
    prompt_submit_needs_synthetic_turn, synthetic_turn_events,
};
use hermes_agent_cn::embedded::{resolve_payload_root, FFI_SURFACE_VERSION};
use hermes_agent_cn::process::python_runtime::{
    locate_payload, read_ffi_surface_version, validate_payload, EmbeddedPayloadInfo, PayloadKind,
};

/// Real REST routes the frontend calls (web/src hooks / lib) that the api_proxy
/// proxy-pass used to forward over HTTP. Paths are normalized (no query string),
/// matching what `embedded_rest_request` sees after `url_path` stripping.
/// refactor_plan.md Phase A/B grows `REST_FFI_SURFACE` until every entry here is
/// covered by a direct FFI handler; the coverage-gate tests below then flip.
const REAL_FRONTEND_API_ROUTES: &[&str] = &[
    // /api/sessions (plural) family — hooks/use-sessions.ts
    "/api/sessions",
    "/api/sessions/abc123",
    "/api/sessions/abc123/messages",
    "/api/sessions/search",
    // /api/profiles (exact, no trailing slash) — hooks/use-profiles.ts
    "/api/profiles",
    // env — hooks/use-env.ts
    "/api/env",
    "/api/env/reveal",
    // fs — hooks/use-fs-list.ts, command-palette, workspace-picker
    "/api/fs/list",
    // logs — hooks/use-logs.ts, lib/debug-install.ts, lib/logs-viewer.ts
    "/api/logs",
    // media — lib/transport.ts fetchMediaDataUrl fallback
    "/api/media",
    // memory — hooks/use-memory.ts
    "/api/memory",
    "/api/memory/provider",
    "/api/memory/providers/openviking/config",
    "/api/memory/providers/openviking/status",
    // mcp-servers (hyphen variant) — hooks/use-mcp-servers.ts
    // NOTE: currently "covered" by the /api/mcp prefix → dispatches to the WRONG
    // handler (handle_mcp); see wrong_handler_prefix_routes_are_coverage_blind_spots.
    "/api/mcp-servers",
    // oauth providers — hooks/use-oauth-providers.ts
    "/api/providers/oauth",
    "/api/providers/oauth/feishu/start",
    // audio — lib/voice.ts
    "/api/audio/transcribe",
    "/api/audio/speak",
    "/api/audio/elevenlabs/voices",
    // upload — lib/transport.ts uploadAttachmentFile (upload_file command)
    "/api/upload",
];

fn write_dev_package(dir: &std::path::Path, version: &str) {
    let pkg = dir.join("hermes_embedded");
    std::fs::create_dir_all(&pkg).unwrap();
    std::fs::write(pkg.join("__init__.py"), "").unwrap();
    std::fs::write(
        pkg.join("api.py"),
        format!("ffi_surface_version = \"{version}\"\n"),
    )
    .unwrap();
}

#[test]
fn ffi_surface_version_contract_is_stable() {
    assert_eq!(FFI_SURFACE_VERSION, "0.2.0");
}

#[test]
#[serial_test::serial]
fn payload_resolution_finds_dev_package_and_validates() {
    let dir = tempfile::TempDir::new().unwrap();
    write_dev_package(dir.path(), "0.1.0");

    std::env::set_var("HERMES_DESKTOP_EMBEDDED_PAYLOAD", dir.path());
    assert_eq!(resolve_payload_root(None).unwrap(), dir.path());

    let info = locate_payload(None).expect("payload should be located");
    assert_eq!(info.root, dir.path());
    assert_eq!(info.kind, PayloadKind::DevPackage);
    assert!(validate_payload(&info).is_ok());
    assert_eq!(
        read_ffi_surface_version(&info.root.join("hermes_embedded")).as_deref(),
        Some("0.1.0")
    );
    std::env::remove_var("HERMES_DESKTOP_EMBEDDED_PAYLOAD");
}

#[test]
fn payload_validation_rejects_missing_ffi_version() {
    let dir = tempfile::TempDir::new().unwrap();
    let pkg = dir.path().join("hermes_embedded");
    std::fs::create_dir_all(&pkg).unwrap();
    std::fs::write(pkg.join("__init__.py"), "").unwrap();
    std::fs::write(pkg.join("api.py"), "# no version here\n").unwrap();
    let info = EmbeddedPayloadInfo {
        root: dir.path().to_path_buf(),
        kind: PayloadKind::DevPackage,
    };
    assert!(validate_payload(&info).is_err());
}

#[test]
fn ffi_coverage_gate_covers_the_registered_surface() {
    let routes: Vec<String> = ffi::REST_FFI_SURFACE
        .iter()
        .map(|e| {
            if e.pattern.ends_with('/') {
                format!("{}x", e.pattern)
            } else {
                e.pattern.to_string()
            }
        })
        .collect();
    let routes: Vec<&str> = routes.iter().map(|s| s.as_str()).collect();
    assert_eq!(ffi::uncovered_routes(&routes), Vec::<&str>::new());
    assert!(ffi::assert_full_coverage(&routes).is_ok());
}

#[test]
fn gateway_frame_roundtrip_preserves_id() {
    let frame = r#"{"jsonrpc":"2.0","id":"abc","method":"prompt.submit","params":{}}"#;
    let parsed = parse_frame(frame).unwrap();
    assert_eq!(parsed.id, Some(serde_json::Value::String("abc".into())));
    let response = build_response_frame(parsed.id.unwrap(), serde_json::json!({ "ok": true }));
    assert_eq!(response["id"], "abc");
    assert_eq!(response["result"]["ok"], true);
}

/// Regression for the workbench (工作台) 发送 hang in embedded mode.
///
/// The embedded transport used to emit RPC responses as `{method:"event",
/// params:{type:"response",payload:{frame:...}}}` wrappers. The frontend's
/// GatewayClient (`handleFrame`) resolves a pending request ONLY when the relay
/// data is a raw `{jsonrpc,id,result}` frame with a top-level `id` — the
/// wrapped shape was routed to the event listeners instead, so pressing 发送
/// (which sends `session.create` through the gateway) left the request pending
/// until the 120s RPC timeout: the UI appeared frozen until then.
///
/// This test pins the production path (`dispatch_frame` calls
/// `response_event` for id-bearing requests) to the same raw-frame wire shape
/// the TCP relay (`ws_proxy.rs`) forwards, end to end: id present at the top
/// level, no `method:"event"` wrapper, and the exact result echoed back.
#[test]
fn embedded_rpc_response_wire_is_raw_frame_for_gateway_client() {
    use hermes_agent_cn::embedded::events::EmbeddedEvent;
    use hermes_agent_cn::embedded::transport::response_event;

    let id = serde_json::Value::String("w1".into());
    let result = serde_json::json!({ "session_id": "s1" });
    let event: EmbeddedEvent = response_event("conn-1", Some(id), result.clone())
        .expect("an id-bearing request must produce a response event");

    // The relay `data` payload must be the raw frame — exactly what
    // GatewayClient.handleFrame parses to match `frame.id` against the pending
    // map (`gateway-client.ts`).
    let wire: serde_json::Value = serde_json::from_str(&event.wire_data()).unwrap();
    assert_eq!(wire["id"], "w1");
    assert_eq!(wire["result"], result);
    assert_eq!(wire["jsonrpc"], "2.0");
    assert!(
        wire.get("method").is_none(),
        "response must not be wrapped as an event: {wire}"
    );
    assert_eq!(event.connection_id, "conn-1");

    // Notifications (no id) must NOT produce a response event.
    assert!(response_event("conn-1", None, serde_json::json!({ "ok": true })).is_none());
}

/// Regression for the GUI being stuck at the optimistic "正在唤醒Hermes..."
/// progress in embedded mode (python run.py).
///
/// The real Core `prompt.submit` returns `{"status":"streaming"}` and then
/// emits `message.start` / `message.complete` events through the transport, so
/// the desktop's optimistic progress is replaced by a real turn. A synchronous
/// stub payload accepts the prompt but never streams, so the desktop must
/// synthesize a complete turn itself as a fallback.
/// Without this, `sendPrompt` resolves while the chat store keeps the
/// optimistic assistant message in `streaming` with the progress part forever.
///
/// Additionally every synthesized/relayed event must carry `session_id` in the
/// wire frame (`{method:"event",params:{type,session_id,payload}}`, the exact
/// shape Core's `tui_gateway.server._event_frame` produces): the frontend
/// `applyGatewayEventAtom` drops events without a session id, so a missing
/// session_id alone would leave the GUI stuck on the same progress.
#[test]
fn embedded_prompt_submit_synthesizes_complete_turn_with_session_id() {
    use hermes_agent_cn::embedded::events::EmbeddedEvent;
    use serde_json::json;

    // A synchronous stub payload returns an accept with no
    // `status: "streaming"` promise — the desktop must synthesize the turn.
    let stub_result = json!({
        "ok": true,
        "accepted": true,
        "embedded": true,
        "status": "complete",
        "reply": "（嵌入式演示模式）已收到：你好",
    });
    assert!(
        prompt_submit_needs_synthetic_turn(&stub_result),
        "stub prompt.submit result must be treated as needing a synthetic turn"
    );

    // The real Core result promises streaming and emits its own events; the
    // desktop must NOT synthesize a second turn on top of them.
    let core_result = json!({"ok": true, "status": "streaming"});
    assert!(
        !prompt_submit_needs_synthetic_turn(&core_result),
        "real Core streaming result must not trigger a synthetic turn"
    );

    // Build the events the way dispatch_frame would for session "embedded-session".
    let events: Vec<EmbeddedEvent> =
        synthetic_turn_events("conn-1", "embedded-session", &stub_result);
    assert_eq!(events.len(), 2, "expected message.start + message.complete");
    assert_eq!(events[0].event_type, "message.start");
    assert_eq!(events[1].event_type, "message.complete");

    // The wire shape must match Core's _event_frame: jsonrpc + method + params
    // with type/session_id/payload — the frontend GatewayClient parses
    // session_id from params and applyGatewayEventAtom drops events without it.
    let start_wire: serde_json::Value = serde_json::from_str(&events[0].wire_data()).unwrap();
    assert_eq!(start_wire["jsonrpc"], "2.0");
    assert_eq!(start_wire["method"], "event");
    assert_eq!(start_wire["params"]["type"], "message.start");
    assert_eq!(start_wire["params"]["session_id"], "embedded-session");

    let complete_wire: serde_json::Value = serde_json::from_str(&events[1].wire_data()).unwrap();
    assert_eq!(complete_wire["params"]["type"], "message.complete");
    assert_eq!(complete_wire["params"]["session_id"], "embedded-session");
    assert_eq!(
        complete_wire["params"]["payload"]["text"],
        "（嵌入式演示模式）已收到：你好"
    );

    // Events must be tagged with the relay connection so the webview/browser
    // relay shim accepts them.
    assert_eq!(events[0].connection_id, "conn-1");
    assert_eq!(events[1].connection_id, "conn-1");
}

#[cfg(not(feature = "embedded-python"))]
#[test]
#[serial_test::serial]
fn embedded_status_is_not_ready_without_interpreter() {
    use hermes_agent_cn::embedded::{EmbeddedPython, EmbeddedStatus};

    // Without the embedded-python feature the interpreter is never started;
    // the status must report something other than Ready so callers fall back
    // to subprocess. With the feature enabled this behavior is intentionally
    // reversed (the real interpreter starts), so the test is feature-gated.
    let dir = tempfile::TempDir::new().unwrap();
    write_dev_package(dir.path(), "0.1.0");
    std::env::set_var("HERMES_DESKTOP_EMBEDDED_PAYLOAD", dir.path());
    assert!(!EmbeddedPython::ensure_started(None));
    let runtime = EmbeddedPython::get().expect("ensure_started should have initialized the handle");
    assert!(
        !matches!(runtime.status(), EmbeddedStatus::Ready { .. }),
        "default (non-feature) builds must not report Ready"
    );
    std::env::remove_var("HERMES_DESKTOP_EMBEDDED_PAYLOAD");
}

/// The FFI coverage gate now takes the REAL frontend API surface as its input:
/// every route the frontend actually calls must have a direct FFI entry
/// (refactor_plan.md Phase A). This is the flipped assertion — previously it
/// documented the 20-path missing list.
#[test]
fn real_frontend_routes_all_have_ffi_entries() {
    assert_eq!(
        ffi::uncovered_routes(REAL_FRONTEND_API_ROUTES),
        Vec::<&str>::new(),
        "every real frontend route must resolve to an FFI entry"
    );
}

/// The exact (longest-match) entries fixed the wrong-handler prefix blind
/// spots: /api/mcp-servers, /api/config/schema and /api/gateway/restart now
/// dispatch to their own handlers instead of the short-prefix defaults.
#[test]
fn wrong_handler_prefix_routes_now_dispatch_to_exact_handlers() {
    assert_eq!(
        ffi::entry_for_route("/api/mcp-servers").map(|e| e.python_func),
        Some("handle_mcp_servers"),
    );
    assert_eq!(
        ffi::entry_for_route("/api/config/schema").map(|e| e.python_func),
        Some("handle_config_schema"),
    );
    assert_eq!(
        ffi::entry_for_route("/api/gateway/restart").map(|e| e.python_func),
        Some("handle_gateway_restart"),
    );
}

/// The `upload_file` command now has an embedded FFI branch (refactor_plan.md
/// Phase C): with EMBEDDED_API_BASE_URL it dispatches through
/// embedded_rest_request instead of building a reqwest multipart POST. This
/// pure-Rust test proves the branch is taken (the old reqwest scheme error is
/// gone; the failure is now "runtime not initialized" because the interpreter
/// feature is off). The real-interpreter success case lives in
/// tests/embedded_python.rs.
#[test]
fn upload_file_embedded_mode_dispatches_through_ffi_without_reqwest() {
    use base64::Engine;
    use hermes_agent_cn::commands::api_proxy::{upload_file_impl, UploadFileInput};
    use hermes_agent_cn::embedded::EMBEDDED_API_BASE_URL;

    let input = UploadFileInput {
        session_id: "s1".to_string(),
        name: "note.txt".to_string(),
        r#type: Some("text/plain".to_string()),
        data: base64::engine::general_purpose::STANDARD.encode("hello"),
    };
    let rt = tokio::runtime::Runtime::new().unwrap();
    let err = rt
        .block_on(upload_file_impl(
            input,
            EMBEDDED_API_BASE_URL,
            None,
            "C:/Users/test/.hermes",
        ))
        .expect_err("embedded upload must not fall back to reqwest");
    // The embedded branch never builds a multipart POST, so the previous
    // failure (reqwest rejecting the embedded:// scheme) must be gone.
    assert!(
        !err.to_string().contains("scheme")
            && !err.to_string().contains("builder")
            && !err.to_string().contains("http"),
        "embedded upload must dispatch through FFI, got: {err}"
    );
}

/// Regression for the *second* class of embedded gateway hang: RPC failures
/// must be answered as raw JSON-RPC error frames so the pending request
/// rejects promptly and the connection STAYS ALIVE.
///
/// Before the fix, `dispatch_frame` propagated the error out of
/// `gateway_ws_send`; `GatewayRelaySocket.send` treated any invoke rejection as
/// a dead relay, closed the socket locally and triggered a full reconnect —
/// every pending request died with "WebSocket closed" and the browser
/// companion relay loop broke on the first error. Core answers failures
/// in-band with `_err(rid, ...)`, so embedded mode must too.
#[test]
fn embedded_rpc_errors_are_delivered_as_raw_error_frames() {
    use hermes_agent_cn::embedded::events::EmbeddedEvent;
    use hermes_agent_cn::embedded::transport::error_response_event;

    // A registry miss / Python exception path builds an error frame echoing id.
    let error = build_error_frame(
        serde_json::Value::String("w2".into()),
        -32601,
        "no FFI entry",
    );
    assert_eq!(error["id"], "w2");
    assert_eq!(error["error"]["code"], -32601);
    assert!(error.get("result").is_none());

    // Delivered via the error response channel (NOT response_event, which would
    // wrap the frame as a successful `result`), so GatewayClient.handleFrame
    // resolves the pending map with a rejection.
    let event: EmbeddedEvent = error_response_event(
        "conn-1",
        Some(serde_json::Value::String("w2".into())),
        -32601,
        "no FFI entry",
    )
    .expect("id-bearing request must produce a response event");
    let wire: serde_json::Value = serde_json::from_str(&event.wire_data()).unwrap();
    assert_eq!(wire["id"], "w2");
    assert_eq!(wire["error"]["code"], -32601);
    assert!(
        wire.get("result").is_none(),
        "error frame must not carry result: {wire}"
    );
    assert!(
        wire.get("method").is_none(),
        "error frame must be raw: {wire}"
    );

    // Notifications (no id) get no error response — the failure is logged.
    assert!(error_response_event("conn-1", None, -32601, "x").is_none());
}

/// An in-band `prompt.submit` failure (`ok:false` / `status:"error"`) must be
/// answered as a JSON-RPC error, NOT a successful result with no events —
/// otherwise `sendPrompt` resolves while the optimistic "正在唤醒Hermes..."
/// progress stays forever (the exact original symptom, just via the error
/// path). Core signals prompt failures via `_err(rid, ...)`; this pins the
/// embedded transport to the same contract, including the "session busy"
/// retry branch which matches on the RPC error message.
#[test]
fn embedded_prompt_submit_failure_is_jsonrpc_error_not_silent_success() {
    use serde_json::json;

    let (code, message) = prompt_submit_error(&json!({ "ok": false, "error": "session busy" }))
        .expect("ok:false must be an error");
    assert_eq!(code, -32000);
    assert_eq!(message, "session busy");

    let (_, message) =
        prompt_submit_error(&json!({ "ok": true, "status": "error", "message": "boom" }))
            .expect("status:error must be an error");
    assert_eq!(message, "boom");

    // Streaming / complete results are not errors.
    assert!(prompt_submit_error(&json!({ "ok": true, "status": "streaming" })).is_none());
    assert!(
        prompt_submit_error(&json!({ "ok": true, "status": "complete", "reply": "hi" })).is_none()
    );
}

/// The FFI gateway registry must cover every JSON-RPC method the current
/// frontend actually sends (web/src hooks/use-gateway.ts + routes/detail.tsx):
/// `approval.respond`, `image.attach_bytes` and `input.detect_drop` were
/// missing, so embedded mode hard-failed those flows with "no FFI entry" (and,
/// before the error-frame fix, tore the gateway session down).
#[test]
fn gateway_registry_covers_frontend_request_methods() {
    for method in [
        "approval.respond",
        "image.attach",
        "image.attach_bytes",
        "input.detect_drop",
        "file.attach",
        "prompt.submit",
        "session.create",
        "session.resume",
        "session.close",
        "session.interrupt",
        "session.compress",
        "session.title",
        "session.usage",
        "complete.path",
        "complete.slash",
        "config.set",
        "command.dispatch",
        "provider.models",
        "provider.probe",
    ] {
        assert!(
            ffi::covered_gateway_method(method),
            "frontend gateway method {method} must have an FFI entry"
        );
    }
}
