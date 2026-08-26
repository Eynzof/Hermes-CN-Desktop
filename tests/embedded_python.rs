//! Real-interpreter integration tests (refactor_report.md Phase 0 spike).
//!
//! Compiled and run only with the `embedded-python` feature:
//!
//! ```text
//! cargo test --features embedded-python --test embedded_python
//! ```
//!
//! These tests link libpython and initialize a real CPython interpreter, so
//! they are excluded from default CI (which has no Python dev headers). When a
//! payload is not reachable the tests fail loudly — the CI embedded job must
//! stage the `hermes_embedded` reference package (repo root already does).

#![cfg(feature = "embedded-python")]

use hermes_agent_cn::embedded::call::{eval_for_bootstrap, interpreter_alive};
use hermes_agent_cn::embedded::FFI_SURFACE_VERSION;
use hermes_agent_cn::process::python_runtime::{locate_payload, read_ffi_surface_version};

fn payload_root() -> std::path::PathBuf {
    locate_payload(None)
        .map(|info| info.root)
        .unwrap_or_else(|| panic!("no embedded payload found (HERMES_DESKTOP_EMBEDDED_PAYLOAD?)"))
}

#[test]
fn interpreter_starts_and_runs_python() {
    let root = payload_root();
    let interp = hermes_agent_cn::embedded::call::PythonInterpreter::start(&root)
        .expect("PythonInterpreter::start should succeed with a valid payload");
    assert!(interpreter_alive());
    assert!(interp.python_version().starts_with("3."));
    assert_eq!(interp.ffi_surface_version(), FFI_SURFACE_VERSION);
    interp.shutdown();
}

#[test]
fn eval_bootstrap_runs_expression() {
    let root = payload_root();
    let interp = hermes_agent_cn::embedded::call::PythonInterpreter::start(&root).unwrap();
    assert_eq!(eval_for_bootstrap("str(2 + 2)").unwrap(), "4");
    interp.shutdown();
}

#[test]
fn ffi_surface_version_matches_python_package() {
    let root = payload_root();
    let pkg = root.join("hermes_embedded");
    let python_version = read_ffi_surface_version(&pkg)
        .expect("hermes_embedded/api.py should define ffi_surface_version");
    assert_eq!(python_version, FFI_SURFACE_VERSION);
}

#[test]
fn call_handle_rpc_drives_the_reference_package() {
    // PythonInterpreter::start sets up sys.path; afterwards the unified FFI
    // entry point must be able to import hermes_embedded.api and dispatch.
    let root = payload_root();
    let interp = hermes_agent_cn::embedded::call::PythonInterpreter::start(&root).unwrap();
    let version = hermes_agent_cn::embedded::call::call_handle_rpc("get_version", "{}", "{}")
        .expect("get_version should dispatch through handle_rpc");
    assert_eq!(version, serde_json::json!("0.8.0-rc4"));
    let status = hermes_agent_cn::embedded::call::call_handle_rpc("get_status", "{}", "{}")
        .expect("get_status should dispatch through handle_rpc");
    assert_eq!(status["mode"], "embedded");
    interp.shutdown();
}

#[test]
fn embedded_runtime_serves_api_request_through_ffi() {
    use hermes_agent_cn::commands::api_proxy::ApiRequestInput;
    use hermes_agent_cn::embedded::EmbeddedPython;

    // Start the process-global embedded runtime (OnceLock) exactly like
    // bootstrap does, then drive the api_request FFI branch end to end.
    assert!(
        EmbeddedPython::ensure_started(None),
        "embedded runtime should start with the repo hermes_embedded payload"
    );

    let rt = tokio::runtime::Runtime::new().unwrap();
    let input = ApiRequestInput {
        path: "/api/version".to_string(),
        method: Some("GET".to_string()),
        headers: None,
        body: None,
    };
    let result = rt
        .block_on(hermes_agent_cn::embedded::api::embedded_rest_request(
            "C:/Users/test/.hermes",
            Some("embedded-session-token"),
            "default",
            &input,
        ))
        .expect("embedded /api/version should dispatch through FFI");
    assert_eq!(result.status, 200);
    assert!(result.body.contains("0.8.0-rc4"));

    // The version gate path (criterion 3): get_backend_version reads Python.
    let version = hermes_agent_cn::embedded::get_backend_version().unwrap();
    assert_eq!(version, "0.8.0-rc4");

    // A route without an FFI entry must fail loudly (no HTTP fallback).
    let missing = ApiRequestInput {
        path: "/api/does-not-exist".to_string(),
        method: Some("GET".to_string()),
        headers: None,
        body: None,
    };
    let err = rt
        .block_on(hermes_agent_cn::embedded::api::embedded_rest_request(
            "C:/Users/test/.hermes",
            None,
            "default",
            &missing,
        ))
        .unwrap_err();
    assert!(err.to_string().contains("no FFI entry"));
}

/// Embedded-mode failure trigger for the REAL frontend routes that still have no
/// FFI entry (refactor_plan.md). With a live interpreter, embedded REST dispatch
/// must hard-fail with "no FFI entry" instead of falling back to HTTP. As each
/// route lands in src/embedded/ffi.rs + hermes_embedded/api.py, remove it from
/// the list (and eventually flip this test to expect Ok).
#[test]
fn embedded_mode_rejects_uncovered_frontend_routes() {
    use hermes_agent_cn::commands::api_proxy::ApiRequestInput;
    use hermes_agent_cn::embedded::EmbeddedPython;

    assert!(
        EmbeddedPython::ensure_started(None),
        "embedded runtime should start with the repo hermes_embedded payload"
    );

    // Mirrors REAL_FRONTEND_API_ROUTES in tests/embedded.rs (minus the
    // wrong-handler prefix cases, which dispatch but return the wrong shape).
    let uncovered = [
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
    let rt = tokio::runtime::Runtime::new().unwrap();
    for path in uncovered {
        let input = ApiRequestInput {
            path: path.to_string(),
            method: Some("GET".to_string()),
            headers: None,
            body: None,
        };
        let err = rt
            .block_on(hermes_agent_cn::embedded::api::embedded_rest_request(
                "C:/Users/test/.hermes",
                None,
                "default",
                &input,
            ))
            .unwrap_err();
        assert!(
            err.to_string().contains("no FFI entry"),
            "route {path} must hard-fail without an FFI entry, got: {err}"
        );
    }
}
