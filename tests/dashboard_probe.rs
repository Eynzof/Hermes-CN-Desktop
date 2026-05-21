// HTTP-boundary tests for dashboard probing.
//
// Uses wiremock to stand in for a live hermes dashboard. Asserts that
// probe_dashboard correctly classifies HTTP responses (2xx, 401, errors,
// timeouts).

use std::{net::TcpListener, time::Duration};

use hermes_agent_cn::process::dashboard::probe_dashboard;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

#[tokio::test]
async fn returns_true_for_2xx_status() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/status"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;

    assert!(probe_dashboard(&server.uri()).await);
}

#[tokio::test]
async fn returns_true_for_401_unauthorized() {
    // 401 means the dashboard is up but rejects our credentials — still
    // "reachable" for the purposes of process management.
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/status"))
        .respond_with(ResponseTemplate::new(401))
        .mount(&server)
        .await;

    assert!(probe_dashboard(&server.uri()).await);
}

#[tokio::test]
async fn returns_false_for_5xx_status() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/status"))
        .respond_with(ResponseTemplate::new(503))
        .mount(&server)
        .await;

    assert!(!probe_dashboard(&server.uri()).await);
}

#[tokio::test]
async fn returns_false_when_response_exceeds_timeout() {
    // PROBE_TIMEOUT is 900ms — respond with a 2-second delay.
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/status"))
        .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_secs(2)))
        .mount(&server)
        .await;

    assert!(!probe_dashboard(&server.uri()).await);
}

#[tokio::test]
async fn returns_false_when_server_unreachable() {
    // Bind an ephemeral local port without serving HTTP. This avoids the
    // race where a dropped mock server's port can be immediately reused by
    // another parallel test on CI.
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind inert local listener");
    let uri = format!(
        "http://{}",
        listener.local_addr().expect("listener address")
    );

    assert!(!probe_dashboard(&uri).await);
}
