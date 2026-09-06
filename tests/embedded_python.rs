//! Real-interpreter integration tests for the embedded runtime.
//!
//! Compiled and run only with the `embedded-python` feature:
//!
//! ```text
//! cargo test --features embedded-python --test embedded_python -- --test-threads=1
//! ```
//!
//! These tests link libpython and initialize a real CPython interpreter, so
//! they are excluded from default CI (which has no Python dev headers).
//! The payload is the REAL backend package — the merged `hermes_embedded`
//! inside the Hermes-CN-Core checkout (env override, ./hermes_backend, or
//! ../Hermes-CN-Core). When no payload is reachable the tests fail loudly.

#![cfg(feature = "embedded-python")]

use hermes_agent_cn::embedded::call::{eval_for_bootstrap, interpreter_alive};
use hermes_agent_cn::embedded::FFI_SURFACE_VERSION;
use hermes_agent_cn::process::python_runtime::{locate_payload, read_ffi_surface_version};

/// Point HERMES_DESKTOP_EMBEDDED_PAYLOAD at a usable real payload if the env
/// var is not set already: this repo's `hermes_backend` Core checkout first,
/// then the sibling `../Hermes-CN-Core`.
fn ensure_payload_env() {
    if std::env::var_os("HERMES_DESKTOP_EMBEDDED_PAYLOAD").is_some() {
        return;
    }
    let mut candidate = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    candidate.push("hermes_backend");
    if !candidate.join("hermes_embedded").join("api.py").is_file() {
        let mut sibling = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        sibling.push("..");
        sibling.push("Hermes-CN-Core");
        sibling = sibling.canonicalize().unwrap_or(sibling);
        if !sibling.join("hermes_embedded").join("api.py").is_file() {
            panic!(
                "no embedded payload found: set HERMES_DESKTOP_EMBEDDED_PAYLOAD to a Core \
                 checkout's hermes_embedded, or check out ./hermes_backend or ../Hermes-CN-Core"
            );
        }
        candidate = sibling;
    }
    std::env::set_var("HERMES_DESKTOP_EMBEDDED_PAYLOAD", candidate);
}

fn payload_root() -> std::path::PathBuf {
    ensure_payload_env();
    locate_payload(None)
        .map(|info| info.root)
        .unwrap_or_else(|| panic!("no embedded payload found (HERMES_DESKTOP_EMBEDDED_PAYLOAD?)"))
}

/// A fresh temp hermes home ctx so the real Core handlers never touch the
/// developer's (or CI runner's) actual ~/.hermes.
fn temp_ctx() -> (tempfile::TempDir, String) {
    let home = tempfile::TempDir::new().unwrap();
    let ctx = serde_json::json!({
        "hermesHome": home.path().to_str().unwrap(),
        "sessionToken": "embedded-test-token",
        "profile": "",
    })
    .to_string();
    (home, ctx)
}

#[cfg(target_os = "linux")]
#[test]
#[serial_test::serial]
fn bundled_sqlite_symbols_are_not_exported() {
    let executable = std::env::current_exe().expect("resolve embedded test executable");
    let output = std::process::Command::new("nm")
        .arg("-D")
        .arg(&executable)
        .output()
        .expect("GNU nm must be available in the Linux embedded test job");
    assert!(
        output.status.success(),
        "nm -D failed for {}: {}",
        executable.display(),
        String::from_utf8_lossy(&output.stderr)
    );

    let exported: Vec<&str> = std::str::from_utf8(&output.stdout)
        .expect("nm output should be UTF-8")
        .lines()
        .filter_map(|line| line.split_whitespace().last())
        .filter(|symbol| symbol.starts_with("sqlite3_"))
        .collect();
    assert!(
        exported.is_empty(),
        "bundled SQLite symbols must stay out of the dynamic symbol table; \
         Python _sqlite3 would otherwise mix bundled and system SQLite ABIs: {exported:?}"
    );
}

#[test]
#[serial_test::serial]
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
#[serial_test::serial]
fn eval_bootstrap_runs_expression() {
    let root = payload_root();
    let interp = hermes_agent_cn::embedded::call::PythonInterpreter::start(&root).unwrap();
    assert_eq!(eval_for_bootstrap("str(2 + 2)").unwrap(), "4");
    interp.shutdown();
}

#[test]
#[serial_test::serial]
fn ffi_surface_version_matches_python_package() {
    let root = payload_root();
    let pkg = root.join("hermes_embedded");
    let python_version = read_ffi_surface_version(&pkg)
        .expect("hermes_embedded/api.py should define ffi_surface_version");
    assert_eq!(python_version, FFI_SURFACE_VERSION);
}

#[test]
#[serial_test::serial]
fn call_handle_rpc_drives_the_real_backend_package() {
    // PythonInterpreter::start sets up sys.path; afterwards the unified FFI
    // entry point must import hermes_embedded.api and dispatch into the REAL
    // Core implementation (version from hermes_cli, status overrides for the
    // in-process gateway).
    let root = payload_root();
    let interp = hermes_agent_cn::embedded::call::PythonInterpreter::start(&root).unwrap();
    let (_home, ctx) = temp_ctx();

    let version = hermes_agent_cn::embedded::call::call_handle_rpc("get_version", "{}", "{}")
        .expect("get_version should dispatch through handle_rpc");
    let version_str = version.as_str().expect("get_version must return a string");
    assert!(
        !version_str.is_empty() && version_str != "unknown",
        "real package must report hermes_cli.__version__, got {version_str:?}"
    );

    let status = hermes_agent_cn::embedded::call::call_handle_rpc("get_status", "{}", &ctx)
        .expect("get_status should dispatch through handle_rpc");
    assert_eq!(
        status["mode"], "embedded",
        "in-process gateway overrides: {status}"
    );
    assert_eq!(status["gateway_running"], true);
    assert_eq!(status["runtime"], "in-process");

    interp.shutdown();
}

#[test]
#[serial_test::serial]
fn concurrent_callers_share_the_process_python_worker() {
    let root = payload_root();
    let interp = hermes_agent_cn::embedded::call::PythonInterpreter::start(&root).unwrap();
    let expected = hermes_agent_cn::embedded::call::call_handle_rpc("get_version", "{}", "{}")
        .expect("baseline get_version should succeed");

    std::thread::scope(|scope| {
        let calls: Vec<_> = (0..8)
            .map(|_| {
                scope.spawn(|| {
                    hermes_agent_cn::embedded::call::call_handle_rpc("get_version", "{}", "{}")
                        .expect("concurrent get_version should succeed")
                })
            })
            .collect();
        for call in calls {
            assert_eq!(call.join().unwrap(), expected);
        }
    });

    interp.shutdown();
}

#[test]
#[serial_test::serial]
fn real_gateway_session_lifecycle_through_ffi() {
    let root = payload_root();
    let interp = hermes_agent_cn::embedded::call::PythonInterpreter::start(&root).unwrap();
    let (home, ctx) = temp_ctx();

    // session.create runs the real tui_gateway dispatcher: the response must
    // carry the Core session shape the frontend zod schema parses.
    let created = hermes_agent_cn::embedded::call::call_handle_rpc(
        "session.create",
        &serde_json::json!({ "cwd": home.path().to_str().unwrap() }).to_string(),
        &ctx,
    )
    .expect("session.create should dispatch through handle_rpc");
    let session_id = created["session_id"]
        .as_str()
        .expect("real session.create must return a session_id string")
        .to_string();
    assert!(
        !session_id.is_empty(),
        "session_id must be non-empty: {created}"
    );

    // session.list is a Core LONG handler: the response is written through the
    // transport from Core's own pool (not returned inline), which exercises the
    // embedded response-slot path end to end.
    let listing = hermes_agent_cn::embedded::call::call_handle_rpc("session.list", "{}", &ctx)
        .expect("session.list (long handler) should resolve through the transport slot");
    assert!(listing.is_object(), "session.list must return an object");

    // An unknown session is a REAL JSON-RPC error frame ("session not found")
    // — surfaced as an FFI error, never fabricated into a stub response. (A
    // freshly created draft has no state.db row yet until its first turn is
    // flushed, which is why resume of a brand-new id errors identically over
    // the dashboard WebSocket.)
    let missing = hermes_agent_cn::embedded::call::call_handle_rpc(
        "session.resume",
        r#"{"session_id":"definitely-not-a-session"}"#,
        &ctx,
    );
    let err_text = missing.err().map(|e| e.to_string()).unwrap_or_default();
    assert!(
        err_text.to_lowercase().contains("session"),
        "unknown session resume must surface the gateway error, got: {err_text}"
    );

    interp.shutdown();
    drop(home);
}

#[test]
#[serial_test::serial]
fn embedded_runtime_serves_api_request_through_ffi() {
    use hermes_agent_cn::commands::api_proxy::ApiRequestInput;
    use hermes_agent_cn::embedded::EmbeddedPython;

    // Start the process-global embedded runtime (OnceLock) exactly like
    // bootstrap does, then drive the api_request FFI branch end to end.
    ensure_payload_env();
    assert!(
        EmbeddedPython::ensure_started(None),
        "embedded runtime should start with the real Core payload"
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
    let backend_version = hermes_agent_cn::embedded::get_backend_version().unwrap();
    assert!(
        result.body.contains(&backend_version),
        "version body {} must carry the FFI-reported version {backend_version}",
        result.body
    );

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

/// Embedded-mode success for the REAL frontend routes: every route resolves
/// through FFI into the real Core app and returns its REAL response shape.
/// Detailed shape assertions live in the temp-home test below; this one pins
/// the route family coverage end to end.
#[test]
#[serial_test::serial]
fn embedded_mode_serves_all_frontend_routes_through_ffi() {
    use hermes_agent_cn::commands::api_proxy::ApiRequestInput;
    use hermes_agent_cn::embedded::EmbeddedPython;

    ensure_payload_env();
    assert!(
        EmbeddedPython::ensure_started(None),
        "embedded runtime should start with the real Core payload"
    );

    let home = tempfile::TempDir::new().unwrap();
    let home_str = home.path().to_str().unwrap().to_string();
    let rt = tokio::runtime::Runtime::new().unwrap();
    let get = |path: &str| -> serde_json::Value {
        let input = ApiRequestInput {
            path: path.to_string(),
            method: Some("GET".to_string()),
            headers: None,
            body: None,
        };
        let result = rt
            .block_on(hermes_agent_cn::embedded::api::embedded_rest_request(
                &home_str, None, "default", &input,
            ))
            .unwrap_or_else(|err| panic!("route {path} must be served through FFI, got: {err}"));
        assert_eq!(
            result.status, 200,
            "route {path} should return a 200 envelope"
        );
        serde_json::from_str(&result.body).expect("valid JSON body")
    };

    // Sessions family (use-sessions.ts) — real handler, empty fresh home.
    let body = get("/api/sessions");
    assert!(
        body["sessions"].is_array(),
        "/api/sessions unexpected body: {body}"
    );
    assert!(body["total"].is_number() && body["limit"].is_number() && body["offset"].is_number());
    assert!(get("/api/sessions/search")["results"].is_array());

    // Profiles (use-profiles.ts) — real listing includes the default profile.
    let body = get("/api/profiles");
    assert!(body["profiles"].is_array());
    assert_eq!(body["profiles"][0]["name"], "default");
    let body = get("/api/profiles/active");
    assert_eq!(body["active"], "default");

    // Env (use-env.ts) — the full catalog, keyed by var name.
    assert!(get("/api/env").is_object());

    // FS / logs / media.
    let body = get(&format!("/api/fs/list?path={}", urlencoding(&home_str)));
    assert!(body["entries"].is_array(), "fs/list entries: {body}");
    let body = get("/api/logs");
    assert_eq!(body["file"], "agent");
    assert!(body["lines"].is_array());

    // Memory (use-memory.ts) — real provider catalog.
    let body = get("/api/memory");
    assert!(body["providers"].is_array());

    // MCP health summary (use-mcp-servers.ts).
    let body = get("/api/mcp-servers");
    assert!(body["summary"]["total"].is_number());
    assert!(body["servers"].is_array());

    // OAuth providers (use-oauth-providers.ts).
    assert!(get("/api/providers/oauth")["providers"].is_array());

    // Audio routes resolve through the real app (setup-state JSON, not a
    // 404/405 envelope shape change).
    assert!(get("/api/audio/elevenlabs/voices").is_object());

    // Config schema + gateway restart.
    let body = get("/api/config/schema");
    assert!(body["fields"].is_object());
    assert!(body["category_order"].is_array());
    assert_eq!(get("/api/gateway/restart")["ok"], true);
}

/// Real-logic semantics through the embedded transport: with a seeded temp
/// hermes home, env/fs/logs/upload actually read and mutate REAL files via the
/// REAL Core handlers — not just shape stubs.
#[test]
#[serial_test::serial]
fn embedded_mode_real_logic_with_temp_hermes_home() {
    use hermes_agent_cn::commands::api_proxy::ApiRequestInput;
    use hermes_agent_cn::embedded::EmbeddedPython;

    ensure_payload_env();
    assert!(
        EmbeddedPython::ensure_started(None),
        "embedded runtime should start with the real Core payload"
    );

    let home = tempfile::TempDir::new().unwrap();
    std::fs::create_dir_all(home.path().join("logs")).unwrap();
    std::fs::create_dir_all(home.path().join("profiles")).unwrap();
    std::fs::write(home.path().join(".env"), "MY_KEY=secret123\nFOO=bar\n").unwrap();
    std::fs::write(
        home.path().join("logs").join("agent.log"),
        "line1\nline2\nline3\n",
    )
    .unwrap();
    std::fs::create_dir_all(home.path().join("profiles").join("work")).unwrap();
    std::fs::write(
        home.path().join("profiles").join("work").join(".env"),
        "WORK=1\n",
    )
    .unwrap();

    let rt = tokio::runtime::Runtime::new().unwrap();
    let home_str = home.path().to_str().unwrap().to_string();
    let request = |path: &str, method: &str, body: Option<&str>| -> serde_json::Value {
        let input = ApiRequestInput {
            path: path.to_string(),
            method: Some(method.to_string()),
            headers: None,
            body: body.map(|s| s.to_string()),
        };
        let result = rt
            .block_on(hermes_agent_cn::embedded::api::embedded_rest_request(
                &home_str, None, "default", &input,
            ))
            .unwrap_or_else(|err| panic!("embedded {method} {path} failed: {err}"));
        assert_eq!(result.status, 200, "{method} {path}");
        serde_json::from_str(&result.body).expect("valid JSON body")
    };

    // env: real .env read → PUT → reveal → DELETE (all against the temp home).
    let body = request("/api/env", "GET", None);
    assert_eq!(body["MY_KEY"]["is_set"], true);
    assert_eq!(body["MY_KEY"]["custom"], true);
    let body = request("/api/env", "PUT", Some(r#"{"key":"NEW_KEY","value":"v1"}"#));
    assert_eq!(body["ok"], true, "env PUT body: {body}");
    let body = request("/api/env/reveal", "POST", Some(r#"{"key":"FOO"}"#));
    assert_eq!(body["value"], "bar");
    let body = request("/api/env/reveal", "POST", Some(r#"{"key":"NEW_KEY"}"#));
    assert_eq!(body["value"], "v1");
    let body = request("/api/env", "DELETE", Some(r#"{"key":"NEW_KEY"}"#));
    assert_eq!(body["ok"], true);
    let body = request("/api/env", "GET", None);
    assert!(
        body.get("NEW_KEY").is_none(),
        "deleted key must be gone: {body}"
    );

    // fs/list: real directory scan.
    let path_q = format!("/api/fs/list?path={}", urlencoding(&home_str));
    let body = request(&path_q, "GET", None);
    let names: Vec<String> = body["entries"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|e| e["name"].as_str().map(String::from))
        .collect();
    assert!(
        names.iter().any(|n| n == "logs"),
        "fs/list must see the seeded home: {names:?}"
    );

    // logs: real tail.
    let body = request("/api/logs?file=agent&lines=2", "GET", None);
    let lines: Vec<String> = body["lines"]
        .as_array()
        .unwrap()
        .iter()
        .map(|l| l.as_str().unwrap_or("").trim_end().to_string())
        .collect();
    assert_eq!(lines, vec!["line2", "line3"]);

    // upload: the FFI JSON attachment bridges into the real multipart handler
    // and lands in <home>/uploads/<session_id>/.
    use base64::Engine;
    let payload_b64 = base64::engine::general_purpose::STANDARD.encode("hi there");
    let body = request(
        "/api/upload",
        "POST",
        Some(
            &serde_json::json!({
                "filename": "hello.txt",
                "content_base64": payload_b64,
                "session_id": "sess1",
            })
            .to_string(),
        ),
    );
    assert_eq!(body["ok"], true, "upload body: {body}");
    assert_eq!(body["filename"], "hello.txt");
    assert_eq!(body["size"], 8);
    assert!(home
        .path()
        .join("uploads")
        .join("sess1")
        .join("hello.txt")
        .exists());
}

fn urlencoding(value: &str) -> String {
    // Minimal percent-encoding for the path query param ( tempfile homes are
    // ASCII on CI; encode anything outside the unreserved set).
    let mut out = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}
