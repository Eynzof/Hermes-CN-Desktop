//! Integration tests for the embedded runtime architecture (refactor_report.md).
//!
//! These tests run without a Python interpreter (default features): they cover
//! the parts of the embedded design that are pure Rust — payload resolution,
//! FFI coverage gate, gateway frame parsing, event bus, and the mode flag
//! plumbing. The real pyo3 interpreter is exercised by tests/embedded_python.rs
//! behind the `embedded-python` feature.

use hermes_agent_cn::embedded::ffi;
use hermes_agent_cn::embedded::transport::{build_response_frame, parse_frame};
use hermes_agent_cn::embedded::{
    resolve_payload_root, EmbeddedPython, EmbeddedStatus, FFI_SURFACE_VERSION,
};
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

#[cfg(not(feature = "embedded-python"))]
#[test]
#[serial_test::serial]
fn embedded_status_is_not_ready_without_interpreter() {
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
