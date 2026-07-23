// End-to-end WebSocket-leg test for the connection-config commands.
//
// wiremock (used in connection_config.rs) can't serve a WebSocket upgrade, so
// it can only ever leave `ws_ok = false`. This test stands up a real combined
// HTTP `/api/status` + WS `/api/ws` server on one ephemeral port — the exact
// transport shape a remote hermes dashboard presents — and drives the full
// `test_connection_config` command, asserting it reaches `ok: true`. That
// exercises `dashboard::dashboard_supports_ws` (and the rustls-backed
// tokio-tungstenite client added for wss:// remotes) against a live handshake.

use hermes_agent_cn::commands::connection::{test_connection_config, ConnectionConfigInput};
use serial_test::serial;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

/// Accept one connection: route by the request target. `/api/ws` gets a real
/// WebSocket handshake; anything else gets a 200 JSON `/api/status` body.
async fn serve_one(stream: TcpStream) {
    // Peek (don't consume) the request line so a /api/ws connection can be
    // handed to accept_async with its handshake bytes still in the socket.
    let mut peek_buf = [0u8; 512];
    let n = match stream.peek(&mut peek_buf).await {
        Ok(n) => n,
        Err(_) => return,
    };
    let head = String::from_utf8_lossy(&peek_buf[..n]);
    let target = head.lines().next().unwrap_or("");

    if target.contains("/api/ws") {
        // Complete the upgrade, then drop — the client only checks that the
        // handshake succeeds (mirrors dashboard_supports_ws).
        let _ = tokio_tungstenite::accept_async(stream).await;
        return;
    }

    // Plain HTTP: drain the request, then write a 200 /api/status body.
    let mut stream = stream;
    let mut scratch = [0u8; 1024];
    let _ = stream.read(&mut scratch).await;
    let body = br#"{"version":"e2e","auth_required":false}"#;
    let resp = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(resp.as_bytes()).await;
    let _ = stream.write_all(body).await;
    let _ = stream.flush().await;
}

#[tokio::test]
#[serial]
async fn test_connection_succeeds_against_a_live_http_plus_ws_server() {
    // Isolate from a dev machine's saved connection.json / env override.
    let runtime_root = tempfile::tempdir().unwrap();
    std::env::set_var("HERMES_DESKTOP_RUNTIME_ROOT", runtime_root.path());
    std::env::remove_var("HERMES_DESKTOP_REMOTE_URL");
    std::env::remove_var("HERMES_DESKTOP_REMOTE_TOKEN");

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let base_url = format!("http://{}", addr);

    let server = tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            tokio::spawn(serve_one(stream));
        }
    });

    let result = test_connection_config(ConnectionConfigInput {
        mode: Some("remote".to_string()),
        remote_url: Some(base_url.clone()),
        remote_token: Some("e2e-token".to_string()),
        ..Default::default()
    })
    .await
    .unwrap();

    server.abort();

    assert!(result.http_ok, "HTTP step failed: {:?}", result.error);
    assert_eq!(result.http_status, Some(200));
    assert_eq!(result.version.as_deref(), Some("e2e"));
    assert!(
        result.ws_ok,
        "WebSocket handshake against /api/ws failed: {:?}",
        result.error
    );
    assert!(
        result.ok,
        "expected an overall-ok result: {:?}",
        result.error
    );
    assert!(result.error.is_none());
}
