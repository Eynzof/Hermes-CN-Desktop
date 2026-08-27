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

    // Workbench 发送 flow: session.create must resolve to the Core

    // tui_gateway shape ({session_id, stored_session_id, message_count}) that

    // the frontend SessionCreateResult zod schema parses; session.resume must

    // return session_id as well (SessionResumeResult).

    let created = hermes_agent_cn::embedded::call::call_handle_rpc(

        "session.create",

        r#"{"cwd":"C:/dev","reasoning_effort":"medium"}"#,

        "{}",

    )

    .expect("session.create should dispatch through handle_rpc");

    assert_eq!(created["session_id"], "embedded-session");

    assert_eq!(created["stored_session_id"], "embedded-session");

    assert!(created["message_count"].is_number());

    let resumed = hermes_agent_cn::embedded::call::call_handle_rpc(

        "session.resume",

        r#"{"session_id":"s1"}"#,

        "{}",

    )

    .expect("session.resume should dispatch through handle_rpc");

    assert_eq!(resumed["session_id"], "s1");

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

/// Embedded-mode success for the REAL frontend routes (refactor_plan.md Phase D):
/// every route now has an FFI entry and the live interpreter serves it — no
/// more "no FFI entry" hard failures. Asserts the correct response SHAPE per
/// route (packages/protocol/src/hermes-api.ts), not just a 200 envelope.
/// Flipped from `embedded_mode_rejects_uncovered_frontend_routes`.
#[test]
fn embedded_mode_serves_all_frontend_routes_through_ffi() {
    use hermes_agent_cn::commands::api_proxy::ApiRequestInput;
    use hermes_agent_cn::embedded::EmbeddedPython;

    assert!(
        EmbeddedPython::ensure_started(None),
        "embedded runtime should start with the repo hermes_embedded payload"
    );

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
                "C:/Users/test/.hermes",
                None,
                "default",
                &input,
            ))
            .unwrap_or_else(|err| panic!("route {path} must be served through FFI, got: {err}"));
        assert_eq!(result.status, 200, "route {path} should return a 200 envelope");
        serde_json::from_str(&result.body).expect("valid JSON body")
    };

    // Sessions family (use-sessions.ts).
    let body = get("/api/sessions");
    assert!(body["sessions"].is_array());
    assert!(body["total"].is_number() && body["limit"].is_number() && body["offset"].is_number());
    let body = get("/api/sessions/abc123");
    assert_eq!(body["session"]["id"], "abc123");
    let body = get("/api/sessions/abc123/messages");
    assert_eq!(body["session_id"], "abc123");
    assert!(body["messages"].is_array());
    assert!(get("/api/sessions/search")["results"].is_array());

    // Profiles (use-profiles.ts).
    let body = get("/api/profiles");
    assert!(body["profiles"].is_array());
    assert_eq!(body["profiles"][0]["name"], "default");
    assert_eq!(get("/api/profiles/active")["active"], "default");

    // Env (use-env.ts).
    assert!(get("/api/env").is_object());
    assert!(get("/api/env/reveal")["value"].is_string());

    // FS / logs / media.
    let body = get("/api/fs/list");
    assert!(body["entries"].is_array(), "fs/list entries: {body}");
    let body = get("/api/logs");
    assert_eq!(body["file"], "agent");
    assert!(body["lines"].is_array());
    assert!(get("/api/media")["data_url"].is_string());

    // Memory (use-memory.ts).
    let body = get("/api/memory");
    assert!(body["providers"].is_array());
    assert!(get("/api/memory/provider")["ok"] == true);
    let body = get("/api/memory/providers/openviking/config");
    assert_eq!(body["name"], "openviking");
    assert!(body["fields"].is_array());
    let body = get("/api/memory/providers/openviking/status");
    assert_eq!(body["provider"], "openviking");
    assert!(body["details"].is_null());

    // MCP health summary (use-mcp-servers.ts) — wrong-handler fix verified.
    let body = get("/api/mcp-servers");
    assert!(body["summary"]["total"].is_number());
    assert!(body["servers"].is_array());

    // OAuth providers (use-oauth-providers.ts).
    assert!(get("/api/providers/oauth")["providers"].is_array());
    let body = get("/api/providers/oauth/feishu/start");
    assert_eq!(body["flow"], "device_code", "OAuthStartResponse discriminated union");

    // Audio (lib/voice.ts) — setup-state responses with the exact error strings
    // the frontend maps to friendly setup messages.
    let body = get("/api/audio/transcribe");
    assert_eq!(body["ok"], false);
    assert!(body["transcript"].is_string());
    let body = get("/api/audio/speak");
    assert_eq!(body["ok"], false);
    assert!(body["data_url"].is_string());
    let body = get("/api/audio/elevenlabs/voices");
    assert_eq!(body["available"], false);
    assert!(body["voices"].is_array());

    // Config schema + gateway restart (wrong-handler fixes verified).
    let body = get("/api/config/schema");
    assert!(body["fields"].is_object());
    assert!(body["category_order"].is_array());
    assert_eq!(get("/api/gateway/restart")["ok"], true);
}

/// Real-logic semantics through the embedded transport (refactor_plan.md
/// acceptance 5): with a seeded temp hermes home, env/fs/logs/mcp/profiles
/// actually read and mutate real files — not just shape stubs.
#[test]
fn embedded_mode_real_logic_with_temp_hermes_home() {
    use hermes_agent_cn::commands::api_proxy::ApiRequestInput;
    use hermes_agent_cn::embedded::EmbeddedPython;

    assert!(
        EmbeddedPython::ensure_started(None),
        "embedded runtime should start with the repo hermes_embedded payload"
    );

    let home = tempfile::TempDir::new().unwrap();
    std::fs::create_dir_all(home.path().join("logs")).unwrap();
    std::fs::create_dir_all(home.path().join("profiles")).unwrap();
    std::fs::write(home.path().join(".env"), "MY_KEY=secret123\nFOO=bar\n").unwrap();
    std::fs::write(
        home.path().join("config.yaml"),
        "mcp_servers:\n  github:\n    command: npx\n    enabled: true\n  slack:\n    command: x\n    enabled: false\n",
    )
    .unwrap();
    std::fs::write(home.path().join("logs").join("agent.log"), "line1\nline2\nline3\n").unwrap();
    std::fs::create_dir_all(home.path().join("profiles").join("work")).unwrap();
    std::fs::write(home.path().join("profiles").join("work").join(".env"), "WORK=1\n").unwrap();

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
                &home_str,
                None,
                "default",
                &input,
            ))
            .unwrap_or_else(|err| panic!("embedded {method} {path} failed: {err}"));
        assert_eq!(result.status, 200, "{method} {path}");
        serde_json::from_str(&result.body).expect("valid JSON body")
    };

    // env: real .env read → PUT → reveal → DELETE.
    let body = request("/api/env", "GET", None);
    assert_eq!(body["MY_KEY"]["is_set"], true);
    assert_eq!(body["MY_KEY"]["custom"], true);
    let body = request("/api/env", "PUT", Some(r#"{"key":"NEW_KEY","value":"v1"}"#));
    assert_eq!(body["ok"], true);
    let body = request("/api/env/reveal", "POST", Some(r#"{"key":"FOO"}"#));
    assert_eq!(body["value"], "bar");
    let body = request("/api/env/reveal", "POST", Some(r#"{"key":"NEW_KEY"}"#));
    assert_eq!(body["value"], "v1");
    let body = request("/api/env", "DELETE", Some(r#"{"key":"NEW_KEY"}"#));
    assert_eq!(body["ok"], true);
    let body = request("/api/env", "GET", None);
    assert!(body.get("NEW_KEY").is_none(), "deleted key must be gone: {body}");

    // fs/list: real directory scan (hidden entries skipped, dirs sorted first).
    let path_q = format!("/api/fs/list?path={}", urlencoding(&home_str));
    let body = request(&path_q, "GET", None);
    let names: Vec<&str> = body["entries"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|e| e["name"].as_str())
        .collect();
    assert!(names.contains(&"config.yaml") && names.contains(&"logs") && names.contains(&"profiles"));
    assert!(!names.contains(&".env"), "hidden .env must be filtered: {names:?}");

    // logs: real tail.
    let body = request("/api/logs?file=agent&lines=2", "GET", None);
    assert_eq!(body["lines"], serde_json::json!(["line2", "line3"]));

    // mcp-servers: real config.yaml summary.
    let body = request("/api/mcp-servers", "GET", None);
    assert_eq!(body["summary"], serde_json::json!({"total": 2, "enabled": 1}));

    // profiles: real directory scan + POST create.
    let body = request("/api/profiles", "GET", None);
    let names: Vec<&str> = body["profiles"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|p| p["name"].as_str())
        .collect();
    assert!(names.contains(&"default") && names.contains(&"work"), "profiles: {names:?}");
    let body = request("/api/profiles", "POST", Some(r#"{"name":"Team"}"#));
    assert_eq!(body["ok"], true);
    assert!(home.path().join("profiles").join("team").is_dir());
    let body = request("/api/profiles", "GET", None);
    let names: Vec<&str> = body["profiles"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|p| p["name"].as_str())
        .collect();
    assert!(names.contains(&"team"), "created profile must be listed: {names:?}");

    // active profile getter reflects ctx.
    let body = request("/api/profiles/active", "GET", None);
    assert_eq!(body["active"], "default");
}

fn urlencoding(value: &str) -> String {
    // Minimal percent-encoding for test query strings (spaces/backslashes).
    let mut out = String::new();
    for b in value.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b':' | b'/' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

/// Embedded upload success (refactor_plan.md Phase C / acceptance 3): the
/// `upload_file` command dispatches through the FFI branch and the attachment
/// lands under `<hermesHome>/uploads/<session_id>/`.
#[test]
fn embedded_upload_file_writes_attachment_via_ffi() {
    use base64::Engine;
    use hermes_agent_cn::commands::api_proxy::{upload_file_impl, UploadFileInput};
    use hermes_agent_cn::embedded::{EmbeddedPython, EMBEDDED_API_BASE_URL};

    assert!(
        EmbeddedPython::ensure_started(None),
        "embedded runtime should start with the repo hermes_embedded payload"
    );

    let home = tempfile::TempDir::new().unwrap();
    let input = UploadFileInput {
        session_id: "sess-1".to_string(),
        name: "note.txt".to_string(),
        r#type: Some("text/plain".to_string()),
        data: base64::engine::general_purpose::STANDARD.encode("hello embedded"),
    };
    let rt = tokio::runtime::Runtime::new().unwrap();
    let result = rt
        .block_on(upload_file_impl(
            input,
            EMBEDDED_API_BASE_URL,
            None,
            home.path().to_str().unwrap(),
        ))
        .expect("embedded upload should succeed through FFI");
    assert_eq!(result.status, 200);
    let body: serde_json::Value = serde_json::from_str(&result.body).expect("valid JSON body");
    assert_eq!(body["ok"], true, "body: {body}");
    let target = std::path::Path::new(body["path"].as_str().expect("path in body"));
    let expected_root = home.path().join("uploads").join("sess-1");
    assert!(
        target.starts_with(&expected_root),
        "upload must land under {expected_root:?}, got {target:?}"
    );
    assert_eq!(std::fs::read_to_string(target).unwrap(), "hello embedded");
}

/// Real-interpreter regression for the embedded gateway surface the frontend
/// calls (refactor bugs): prompt.abort must abort (never fabricate a turn),
/// input.detect_drop must satisfy InputDetectDropResult (matched required),
/// frames without `params` must not crash the interpreter, and every
/// frontend-called RPC method must resolve through the unified dispatch.
#[test]
fn embedded_gateway_frontend_methods_resolve_through_real_interpreter() {
    use hermes_agent_cn::embedded::EmbeddedPython;

    assert!(
        EmbeddedPython::ensure_started(None),
        "embedded runtime should start with the repo hermes_embedded payload"
    );

    let call = |method: &str, params: &str| -> serde_json::Value {
        hermes_agent_cn::embedded::call::call_handle_rpc(method, params, r#"{"hermesHome":"/x"}"#)
            .unwrap_or_else(|err| panic!("handle_rpc({method}) failed: {err}"))
    };

    // prompt.abort: dedicated handler — aborted, never a complete turn.
    let aborted = call("prompt.abort", r#"{"session_id":"s1"}"#);
    assert_eq!(aborted["aborted"], true);
    assert_ne!(aborted["status"], "complete", "abort must not fabricate a turn");

    // input.detect_drop: zod requires `matched`.
    let drop = call("input.detect_drop", r#"{"session_id":"s1","text":"C:/dev/x"}"#);
    assert_eq!(drop["matched"], false);

    // approval / image.attach_bytes / image.attach / file.attach resolve.
    let approval = call(
        "approval.respond",
        r#"{"session_id":"s1","request_id":"r1","choice":"approve"}"#,
    );
    assert!(approval["ok"] == true);
    let attach = call(
        "image.attach_bytes",
        r#"{"session_id":"s1","content_base64":"AAAA","filename":"p.png"}"#,
    );
    assert!(attach.is_object(), "image.attach_bytes result: {attach}");

    // A frame without params (Rust serializes Value::Null as "null") must not
    // crash the interpreter — handlers coerce non-dict params to {}.
    for method in ["session.list", "model.list", "setup.status"] {
        let value = call(method, "null");
        assert!(value.is_object(), "{method} with null params: {value}");
    }

    // The session-interrupt flow the composer Stop uses.
    let interrupt = call("session.interrupt", r#"{"session_id":"s1"}"#);
    assert!(interrupt["ok"] == true);
}
