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
    assert_eq!(FFI_SURFACE_VERSION, "0.1.0");
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

/// The current FFI coverage gate only checks its own `PROXY_PASS_ROUTES` subset,
/// so it passes while the REAL frontend API surface still has routes with no FFI
/// entry. This test triggers that gap: `uncovered_routes` over the routes the
/// frontend actually calls must return exactly the known-missing set.
///
/// refactor_plan.md Phase D: as each route gets an FFI entry, remove it from the
/// expected list; when every route is covered, this test asserts `Vec::new()`.
#[test]
fn real_frontend_routes_missing_ffi_entries_are_documented() {
    let expected_missing: Vec<&str> = vec![
        "/api/sessions",
        "/api/sessions/abc123",
        "/api/sessions/abc123/messages",
        "/api/sessions/search",
        "/api/profiles",
        "/api/env",
        "/api/env/reveal",
        "/api/fs/list",
        "/api/logs",
        "/api/media",
        "/api/memory",
        "/api/memory/provider",
        "/api/memory/providers/openviking/config",
        "/api/memory/providers/openviking/status",
        "/api/providers/oauth",
        "/api/providers/oauth/feishu/start",
        "/api/audio/transcribe",
        "/api/audio/speak",
        "/api/audio/elevenlabs/voices",
        "/api/upload",
    ];
    assert_eq!(ffi::uncovered_routes(REAL_FRONTEND_API_ROUTES), expected_missing);
    assert_eq!(ffi::uncovered_routes(&["/api/mcp-servers"]), Vec::<&str>::new());
}

/// Prefix "coverage" blind spots: these routes pass `covered_route` because a
/// shorter pattern is a prefix, but they dispatch to the WRONG FFI function.
/// The registry needs exact (longest-match) entries so e.g. `/api/mcp-servers`
/// no longer routes into `handle_mcp`. Document the current wrong mapping;
/// refactor_plan.md Phase B changes the `python_func` values below.
#[test]
fn wrong_handler_prefix_routes_are_coverage_blind_spots() {
    assert_eq!(
        ffi::entry_for_route("/api/mcp-servers").map(|e| e.python_func),
        Some("handle_mcp"),
    );
    assert_eq!(
        ffi::entry_for_route("/api/config/schema").map(|e| e.python_func),
        Some("get_config"),
    );
    assert_eq!(
        ffi::entry_for_route("/api/gateway/restart").map(|e| e.python_func),
        Some("get_gateway_config"),
    );
}

/// The `upload_file` command is the one REST path with NO embedded branch at all:
/// `upload_file_impl` still builds a `reqwest` multipart POST against
/// `{api_base_url}/api/upload` — in embedded mode that URL is
/// `embedded://local/api/upload`, which reqwest rejects. This test triggers that
/// failure (refactor_plan.md Phase C adds the embedded FFI branch).
#[test]
fn upload_file_embedded_mode_has_no_ffi_branch() {
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
        .block_on(upload_file_impl(input, EMBEDDED_API_BASE_URL, None))
        .expect_err("upload_file must fail in embedded mode (no FFI branch yet)");
    // The failure is the reqwest scheme rejection of `embedded://…`; once the
    // embedded branch lands this test flips to expect Ok(…).
    assert!(
        err.to_string().contains("http")
            || err.to_string().contains("scheme")
            || err.to_string().contains("builder"),
        "unexpected upload_file error: {err}"
    );
}
