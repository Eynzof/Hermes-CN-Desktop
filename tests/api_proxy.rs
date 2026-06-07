// HTTP-boundary tests for api_request / external_request / upload_file.
//
// Uses wiremock to stand in for a live hermes dashboard. Exercises the
// _impl entry points so we don't need to construct a Tauri State here.
//
// Covers:
//   - Origin validation: absolute URL outside the dashboard origin is rejected
//   - Token injection: Bearer + X-Hermes-Session-Token are added on every request
//   - Caller cannot override auth headers
//   - Other caller headers are forwarded
//   - Local intercepts (session log, session archive, cron runs) do NOT hit the dashboard
//   - POST body is forwarded verbatim
//   - Archive filter post-processing removes archived sessions
//   - external_request: timeout → 408, unreachable → 0
//   - upload_file: success path, base64 decode failure, multipart shape

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use hermes_agent_cn::commands::api_proxy::{
    api_request_impl, api_request_impl_with_home_base, external_request, external_request_impl,
    upload_file_impl, ApiRequestInput, UploadFileInput,
};
use hermes_agent_cn::error::AppError;
use hermes_agent_cn::ui_store;
use wiremock::matchers::{header, method, path};
use wiremock::{Mock, MockServer, Request, Respond, ResponseTemplate};

fn input_get(p: &str) -> ApiRequestInput {
    ApiRequestInput {
        path: p.to_string(),
        method: Some("GET".to_string()),
        headers: None,
        body: None,
    }
}

fn tempdir() -> tempfile::TempDir {
    tempfile::tempdir().expect("create tempdir")
}

// --- Origin validation -----------------------------------------------------

#[tokio::test]
async fn absolute_url_outside_origin_is_rejected() {
    let server = MockServer::start().await;
    // Should NEVER hit the dashboard.
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(500))
        .expect(0)
        .mount(&server)
        .await;

    let home = tempdir();
    let result = api_request_impl(
        ApiRequestInput {
            path: "https://evil.example.com/api/data".to_string(),
            method: Some("GET".to_string()),
            headers: None,
            body: None,
        },
        &server.uri(),
        None,
        home.path().to_str().unwrap(),
    )
    .await;

    let err = result.expect_err("cross-origin request must be rejected");
    assert!(matches!(err, AppError::OriginViolation(_)), "got {:?}", err);
}

#[tokio::test]
async fn absolute_url_same_origin_is_allowed() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/echo"))
        .respond_with(ResponseTemplate::new(200).set_body_string(r#"{"ok":true}"#))
        .expect(1)
        .mount(&server)
        .await;

    let home = tempdir();
    let absolute = format!("{}/api/echo", server.uri());
    let result = api_request_impl(
        ApiRequestInput {
            path: absolute,
            method: Some("GET".to_string()),
            headers: None,
            body: None,
        },
        &server.uri(),
        None,
        home.path().to_str().unwrap(),
    )
    .await
    .expect("should succeed");

    assert_eq!(result.status, 200);
    assert!(result.ok);
}

// --- Token injection -------------------------------------------------------

#[tokio::test]
async fn injects_bearer_and_session_token_headers_when_token_present() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/whoami"))
        .and(header("authorization", "Bearer s3cret"))
        .and(header("x-hermes-session-token", "s3cret"))
        .respond_with(ResponseTemplate::new(200).set_body_string("{}"))
        .expect(1)
        .mount(&server)
        .await;

    let home = tempdir();
    let result = api_request_impl(
        input_get("/api/whoami"),
        &server.uri(),
        Some("s3cret"),
        home.path().to_str().unwrap(),
    )
    .await
    .expect("ok");
    assert_eq!(result.status, 200);
}

#[tokio::test]
async fn does_not_send_auth_headers_when_token_absent() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/anon"))
        .respond_with(ResponseTemplate::new(200).set_body_string("{}"))
        .expect(1)
        .mount(&server)
        .await;

    let home = tempdir();
    let result = api_request_impl(
        input_get("/api/anon"),
        &server.uri(),
        None,
        home.path().to_str().unwrap(),
    )
    .await
    .expect("ok");
    assert_eq!(result.status, 200);

    // Verify no auth header was sent.
    let req = &server.received_requests().await.unwrap()[0];
    assert!(req.headers.get("authorization").is_none());
    assert!(req.headers.get("x-hermes-session-token").is_none());
}

#[tokio::test]
async fn caller_cannot_override_auth_header() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/secure"))
        .and(header("authorization", "Bearer real-token"))
        .respond_with(ResponseTemplate::new(200).set_body_string("{}"))
        .expect(1)
        .mount(&server)
        .await;

    let home = tempdir();
    let mut h = HashMap::new();
    // Case-insensitive attempt to override.
    h.insert("Authorization".to_string(), "Bearer ATTACKER".to_string());
    h.insert("X-Hermes-Session-Token".to_string(), "ATTACKER".to_string());

    let _ = api_request_impl(
        ApiRequestInput {
            path: "/api/secure".to_string(),
            method: Some("GET".to_string()),
            headers: Some(h),
            body: None,
        },
        &server.uri(),
        Some("real-token"),
        home.path().to_str().unwrap(),
    )
    .await
    .expect("ok");

    // wiremock asserts the expected header was real-token, not ATTACKER.
    // It would not have matched if the caller's value won.
}

#[tokio::test]
async fn forwards_non_auth_caller_headers() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/ping"))
        .and(header("x-trace-id", "trace-123"))
        .and(header("accept-language", "zh-CN"))
        .respond_with(ResponseTemplate::new(200).set_body_string("{}"))
        .expect(1)
        .mount(&server)
        .await;

    let home = tempdir();
    let mut h = HashMap::new();
    h.insert("X-Trace-Id".to_string(), "trace-123".to_string());
    h.insert("Accept-Language".to_string(), "zh-CN".to_string());

    let r = api_request_impl(
        ApiRequestInput {
            path: "/api/ping".to_string(),
            method: Some("GET".to_string()),
            headers: Some(h),
            body: None,
        },
        &server.uri(),
        None,
        home.path().to_str().unwrap(),
    )
    .await
    .expect("ok");
    assert_eq!(r.status, 200);
}

// --- POST body forwarding --------------------------------------------------

#[tokio::test]
async fn post_body_is_forwarded_verbatim() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/sessions"))
        .respond_with(ResponseTemplate::new(201).set_body_string(r#"{"id":"x"}"#))
        .expect(1)
        .mount(&server)
        .await;

    let home = tempdir();
    let result = api_request_impl(
        ApiRequestInput {
            path: "/api/sessions".to_string(),
            method: Some("POST".to_string()),
            headers: None,
            body: Some(r#"{"prompt":"hello"}"#.to_string()),
        },
        &server.uri(),
        None,
        home.path().to_str().unwrap(),
    )
    .await
    .expect("ok");
    assert_eq!(result.status, 201);

    let req = &server.received_requests().await.unwrap()[0];
    assert_eq!(req.body, br#"{"prompt":"hello"}"#);
}

// --- Local intercepts ------------------------------------------------------

#[tokio::test]
async fn cron_runs_intercept_reads_profile_output_without_hitting_dashboard() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(500))
        .expect(0)
        .mount(&server)
        .await;

    let base = tempdir();
    let output_dir = base
        .path()
        .join("profiles")
        .join("alpha")
        .join("cron")
        .join("output")
        .join("job1");
    std::fs::create_dir_all(&output_dir).unwrap();
    std::fs::write(
        output_dir.join("2026-06-07_09-00-00.md"),
        "# Cron Job: A\n\n## Response\n\nok",
    )
    .unwrap();

    let result = api_request_impl_with_home_base(
        input_get("/__hermes_cron_runs/alpha/job1?limit=30"),
        &server.uri(),
        None,
        base.path().join("profiles").join("alpha").to_str().unwrap(),
        base.path().to_str().unwrap(),
    )
    .await
    .expect("cron local route should succeed");

    assert_eq!(result.status, 200);
    assert!(result.ok);
    assert!(result.body.contains("2026-06-07_09-00-00.md"));
    assert!(result.body.contains("success"));
}

#[tokio::test]
async fn session_log_intercept_does_not_hit_dashboard() {
    let server = MockServer::start().await;
    // 0 matches expected — any hit means we bled through.
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(500))
        .expect(0)
        .mount(&server)
        .await;

    let home = tempdir();
    // Don't bother creating the file — we just want to confirm we reach the
    // local handler (which will 404) and never touch the upstream server.
    let r = api_request_impl(
        input_get("/__hermes_session_log/nonexistent"),
        &server.uri(),
        None,
        home.path().to_str().unwrap(),
    )
    .await
    .expect("ok");
    assert_eq!(r.status, 404);
}

#[tokio::test]
async fn archive_intercept_writes_local_state_and_does_not_hit_dashboard() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(500))
        .expect(0)
        .mount(&server)
        .await;

    let home = tempdir();
    let r = api_request_impl(
        ApiRequestInput {
            path: "/api/sessions/sess-1/archive".to_string(),
            method: Some("POST".to_string()),
            headers: None,
            body: None,
        },
        &server.uri(),
        None,
        home.path().to_str().unwrap(),
    )
    .await
    .expect("ok");
    assert_eq!(r.status, 200);
    let archived = ui_store::read_archived_session_ids(home.path().to_str().unwrap());
    assert!(home.path().join("desktop-ui.sqlite").exists());
    assert!(archived.contains("sess-1"));
}

// --- Archive filter post-processing ----------------------------------------

#[tokio::test]
async fn archived_sessions_are_filtered_from_list_response() {
    let server = MockServer::start().await;
    let body = serde_json::json!({
        "sessions": [
            {"id": "keep-1", "title": "alive"},
            {"id": "archived-2", "title": "gone"},
            {"id": "keep-3", "title": "also alive"},
        ],
        "total": 3,
    });
    Mock::given(method("GET"))
        .and(path("/api/sessions"))
        .respond_with(ResponseTemplate::new(200).set_body_json(body))
        .mount(&server)
        .await;

    let home = tempdir();
    // Pre-populate archive state in the UI SQLite store.
    ui_store::set_session_archived(home.path().to_str().unwrap(), "archived-2", true).unwrap();

    let r = api_request_impl(
        input_get("/api/sessions"),
        &server.uri(),
        None,
        home.path().to_str().unwrap(),
    )
    .await
    .expect("ok");

    let parsed: serde_json::Value = serde_json::from_str(&r.body).unwrap();
    let sessions = parsed["sessions"].as_array().unwrap();
    assert_eq!(sessions.len(), 2);
    assert_eq!(parsed["total"], 2);
    assert!(sessions.iter().all(|s| s["id"] != "archived-2"));
}

// --- external_request ------------------------------------------------------

// Note: external_request has a hardcoded 15s timeout that we cannot inject,
// so reliably exercising the 408 branch in a unit test would either time out
// the test or require code changes. The branch logic itself (mapping
// reqwest::Error::is_timeout() → status 408) is straightforward; the
// unreachable test below covers the symmetric is_connect / network-error
// branch.

#[tokio::test]
async fn external_request_returns_zero_status_on_unreachable() {
    // Bind a TcpListener to claim a free port from the OS, then drop it.
    // Anyone trying to connect to that port within the test window will
    // get ECONNREFUSED — the most reliable way to provoke the network-
    // error branch without depending on external infrastructure.
    let port = {
        let l = std::net::TcpListener::bind(("127.0.0.1", 0)).expect("bind ephemeral port");
        let p = l.local_addr().unwrap().port();
        drop(l);
        p
    };

    let target_url: url::Url = format!("http://127.0.0.1:{}/anything", port)
        .parse()
        .expect("valid mock URL");
    let result = external_request_impl(
        ApiRequestInput {
            path: target_url.to_string(),
            method: Some("GET".to_string()),
            headers: None,
            body: None,
        },
        target_url,
    )
    .await
    .expect("function returns Ok with status=0 on network error");

    assert!(!result.ok, "expected non-ok, got status={}", result.status);
    assert_eq!(result.status, 0);
    assert_eq!(result.status_text, "Network Error");

    // Silence unused-import lint for Duration when this is the only consumer.
    let _ = Duration::from_secs(0);
}

#[tokio::test]
async fn external_request_succeeds_against_mock_server() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/ok"))
        .respond_with(ResponseTemplate::new(200).set_body_string("hello"))
        .mount(&server)
        .await;

    let target_url: url::Url = format!("{}/ok", server.uri())
        .parse()
        .expect("valid mock URL");
    let result = external_request_impl(
        ApiRequestInput {
            path: target_url.to_string(),
            method: Some("GET".to_string()),
            headers: None,
            body: None,
        },
        target_url,
    )
    .await
    .expect("ok");
    assert_eq!(result.status, 200);
    assert_eq!(result.body, "hello");
    assert!(result.ok);
}

#[tokio::test]
async fn external_request_command_allows_loopback_http() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/v1/models"))
        .respond_with(ResponseTemplate::new(200).set_body_string(r#"{"data":[{"id":"local"}]}"#))
        .mount(&server)
        .await;

    let result = external_request(ApiRequestInput {
        path: format!("{}/v1/models", server.uri()),
        method: Some("GET".to_string()),
        headers: None,
        body: None,
    })
    .await
    .expect("loopback HTTP should be valid for local model providers");

    assert_eq!(result.status, 200);
    assert_eq!(result.body, r#"{"data":[{"id":"local"}]}"#);
    assert!(result.ok);
}

// --- upload_file -----------------------------------------------------------

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

#[tokio::test]
async fn upload_file_rejects_invalid_base64() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(500))
        .expect(0)
        .mount(&server)
        .await;

    let err = upload_file_impl(
        UploadFileInput {
            session_id: "s1".to_string(),
            name: "a.txt".to_string(),
            r#type: Some("text/plain".to_string()),
            data: "!!!not base64$$$".to_string(),
        },
        &server.uri(),
        None,
    )
    .await
    .expect_err("base64 decode must fail");

    assert!(
        matches!(err, AppError::InvalidRequest(ref msg) if msg.contains("base64")),
        "got {:?}",
        err
    );
}

/// Records whether the captured request contains a multipart `file` field
/// and the auth headers.
struct CaptureUpload {
    saw_session_id: Arc<AtomicBool>,
    saw_file_part: Arc<AtomicBool>,
    auth_header: Arc<std::sync::Mutex<Option<String>>>,
}

impl Respond for CaptureUpload {
    fn respond(&self, request: &Request) -> ResponseTemplate {
        let body = String::from_utf8_lossy(&request.body).to_string();
        if body.contains("name=\"session_id\"") && body.contains("upload-session") {
            self.saw_session_id.store(true, Ordering::SeqCst);
        }
        if body.contains("name=\"file\"") && body.contains("filename=\"a.txt\"") {
            self.saw_file_part.store(true, Ordering::SeqCst);
        }
        if let Some(v) = request.headers.get("authorization") {
            *self.auth_header.lock().unwrap() = Some(v.to_str().unwrap_or("").to_string());
        }
        ResponseTemplate::new(200).set_body_string(r#"{"ok":true}"#)
    }
}

#[tokio::test]
async fn upload_file_posts_multipart_with_auth_header() {
    let server = MockServer::start().await;
    let saw_sess = Arc::new(AtomicBool::new(false));
    let saw_file = Arc::new(AtomicBool::new(false));
    let auth = Arc::new(std::sync::Mutex::new(None));
    Mock::given(method("POST"))
        .and(path("/api/upload"))
        .respond_with(CaptureUpload {
            saw_session_id: saw_sess.clone(),
            saw_file_part: saw_file.clone(),
            auth_header: auth.clone(),
        })
        .expect(1)
        .mount(&server)
        .await;

    let result = upload_file_impl(
        UploadFileInput {
            session_id: "upload-session".to_string(),
            name: "a.txt".to_string(),
            r#type: Some("text/plain".to_string()),
            data: b64(b"hello world"),
        },
        &server.uri(),
        Some("my-token"),
    )
    .await
    .expect("ok");

    assert_eq!(result.status, 200);
    assert!(
        saw_sess.load(Ordering::SeqCst),
        "session_id form field missing"
    );
    assert!(saw_file.load(Ordering::SeqCst), "file part missing");
    assert_eq!(
        auth.lock().unwrap().as_deref(),
        Some("Bearer my-token"),
        "auth header missing or wrong"
    );
}

// --- Counter mock for sanity ----------------------------------------------

#[tokio::test]
async fn proxy_invokes_dashboard_exactly_once_per_call() {
    let server = MockServer::start().await;
    let counter = Arc::new(AtomicUsize::new(0));
    let c2 = counter.clone();
    Mock::given(method("GET"))
        .and(path("/api/status"))
        .respond_with(move |_: &Request| {
            c2.fetch_add(1, Ordering::SeqCst);
            ResponseTemplate::new(200).set_body_string("{}")
        })
        .mount(&server)
        .await;

    let home = tempdir();
    for _ in 0..3 {
        let _ = api_request_impl(
            input_get("/api/status"),
            &server.uri(),
            None,
            home.path().to_str().unwrap(),
        )
        .await
        .expect("ok");
    }
    // Need to consume the value via load after issuing requests; wiremock
    // will also have recorded `received_requests` length but the AtomicUsize
    // is a stronger assertion that the closure ran exactly N times.
    assert_eq!(counter.load(Ordering::SeqCst), 3);
}
