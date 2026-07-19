// HTTP-boundary tests for the connection-config commands.
//
// Uses wiremock to stand in for a remote hermes dashboard. Exercises the
// `probe_connection_config` and `test_connection_config` command entry points
// (neither takes Tauri State) against `/api/status`, covering:
//   - reachability classification (2xx / 401 / unreachable)
//   - auth_required (OAuth gate) detection and the token-only rejection
//   - version passthrough
//   - authenticated requests carry Bearer + X-Hermes-Session-Token
//
// The WebSocket leg of `test_connection_config` cannot complete against a
// plain wiremock (no WS upgrade), so these assert on the HTTP step and on the
// auth_required short-circuit that returns before the WS probe.
//
// Tests that read process env / the on-disk connection.json are #[serial] and
// pin HERMES_DESKTOP_RUNTIME_ROOT to a temp dir so a dev machine's saved
// config can't leak in.

use std::sync::{Arc, Mutex};

use hermes_agent_cn::commands::connection::{
    probe_connection_config, test_connection_config, ConnectionConfigInput,
};
use serial_test::serial;
use wiremock::matchers::{header, method, path};
use wiremock::{Mock, MockServer, Request, Respond, ResponseTemplate};

/// Records whether any request carried the desktop auth headers, so we can
/// assert the token was injected without depending on response ordering.
struct AuthHeaderRecorder {
    saw_bearer: Arc<Mutex<bool>>,
    saw_session_header: Arc<Mutex<bool>>,
    body: serde_json::Value,
}

impl Respond for AuthHeaderRecorder {
    fn respond(&self, req: &Request) -> ResponseTemplate {
        if req
            .headers
            .get("authorization")
            .map(|v| v.to_str().unwrap_or("").starts_with("Bearer "))
            .unwrap_or(false)
        {
            *self.saw_bearer.lock().unwrap() = true;
        }
        if req.headers.contains_key("x-hermes-session-token") {
            *self.saw_session_header.lock().unwrap() = true;
        }
        ResponseTemplate::new(200).set_body_json(self.body.clone())
    }
}

fn isolate_runtime_root() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    std::env::set_var("HERMES_DESKTOP_RUNTIME_ROOT", dir.path());
    std::env::remove_var("HERMES_DESKTOP_REMOTE_URL");
    std::env::remove_var("HERMES_DESKTOP_REMOTE_TOKEN");
    dir
}

#[tokio::test]
async fn probe_reports_reachable_with_version() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/status"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(serde_json::json!({ "version": "1.2.3", "auth_required": false })),
        )
        .mount(&server)
        .await;

    let result = probe_connection_config(server.uri()).await.unwrap();
    assert!(result.reachable);
    assert!(!result.auth_required);
    assert_eq!(result.version.as_deref(), Some("1.2.3"));
}

#[tokio::test]
async fn probe_treats_401_as_reachable() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/status"))
        .respond_with(ResponseTemplate::new(401))
        .mount(&server)
        .await;

    let result = probe_connection_config(server.uri()).await.unwrap();
    assert!(result.reachable);
}

#[tokio::test]
async fn probe_reports_auth_required_gateway() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/status"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(serde_json::json!({ "auth_required": true })),
        )
        .mount(&server)
        .await;

    let result = probe_connection_config(server.uri()).await.unwrap();
    assert!(result.reachable);
    assert!(result.auth_required);
}

#[tokio::test]
async fn probe_unreachable_host_is_not_reachable() {
    // Reserved TEST-NET-1 address; nothing listens, connect fails fast enough.
    let result = probe_connection_config("http://192.0.2.1:9".to_string())
        .await
        .unwrap();
    assert!(!result.reachable);
}

#[tokio::test]
async fn probe_rejects_invalid_url() {
    assert!(probe_connection_config("not a url".to_string())
        .await
        .is_err());
    assert!(probe_connection_config("ftp://host".to_string())
        .await
        .is_err());
}

#[tokio::test]
#[serial]
async fn test_connection_sends_auth_headers_and_reports_http_ok() {
    let _root = isolate_runtime_root();
    let server = MockServer::start().await;
    let saw_bearer = Arc::new(Mutex::new(false));
    let saw_session_header = Arc::new(Mutex::new(false));
    Mock::given(method("GET"))
        .and(path("/api/status"))
        .and(header("authorization", "Bearer secret-token"))
        .respond_with(AuthHeaderRecorder {
            saw_bearer: saw_bearer.clone(),
            saw_session_header: saw_session_header.clone(),
            body: serde_json::json!({ "version": "9.9.9" }),
        })
        .mount(&server)
        .await;

    let result = test_connection_config(ConnectionConfigInput {
        remote_url: Some(server.uri()),
        remote_token: Some("secret-token".to_string()),
        ..Default::default()
    })
    .await
    .unwrap();

    assert!(
        result.http_ok,
        "expected HTTP step to pass: {:?}",
        result.error
    );
    assert_eq!(result.http_status, Some(200));
    assert_eq!(result.version.as_deref(), Some("9.9.9"));
    assert!(*saw_bearer.lock().unwrap(), "Bearer header was not sent");
    assert!(
        *saw_session_header.lock().unwrap(),
        "X-Hermes-Session-Token header was not sent"
    );
    // The WS leg can't complete against wiremock, so the overall test is not ok.
    assert!(!result.ws_ok);
    assert!(!result.ok);
}

#[tokio::test]
#[serial]
async fn test_connection_rejects_oauth_gateway() {
    let _root = isolate_runtime_root();
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/status"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(serde_json::json!({ "auth_required": true })),
        )
        .mount(&server)
        .await;

    let result = test_connection_config(ConnectionConfigInput {
        remote_url: Some(server.uri()),
        remote_token: Some("tok".to_string()),
        ..Default::default()
    })
    .await
    .unwrap();

    assert!(result.http_ok);
    assert!(result.auth_required);
    assert!(!result.ok);
    let err = result.error.expect("expected an OAuth rejection message");
    assert!(err.contains("OAuth") || err.contains("session token"));
}

#[tokio::test]
#[serial]
async fn test_connection_reports_401_token_error() {
    let _root = isolate_runtime_root();
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/status"))
        .respond_with(ResponseTemplate::new(401))
        .mount(&server)
        .await;

    let result = test_connection_config(ConnectionConfigInput {
        remote_url: Some(server.uri()),
        remote_token: Some("bad-token".to_string()),
        ..Default::default()
    })
    .await
    .unwrap();

    assert!(!result.http_ok);
    assert_eq!(result.http_status, Some(401));
    assert!(!result.ok);
    assert!(result.error.unwrap().contains("401"));
}

#[tokio::test]
#[serial]
async fn test_connection_without_url_is_an_error() {
    let _root = isolate_runtime_root();
    // No saved config, no env, no input URL → nothing to test against.
    let result = test_connection_config(ConnectionConfigInput::default()).await;
    assert!(result.is_err());
}
