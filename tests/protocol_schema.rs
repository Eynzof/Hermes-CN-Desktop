//! Golden-fixture parity tests for the `src/schema/` protocol modules.
//!
//! Reads the shared `tests/fixtures/protocol/*.json` fixtures and asserts the
//! serde round-trip matches, plus the session-log parser output equals the TS
//! `sessionLogToMessages` snapshot. FS tests use `tempfile::TempDir`.

use hermes_agent_cn::schema;
use pretty_assertions::assert_eq;

fn load(name: &str) -> serde_json::Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("protocol")
        .join(format!("{name}.json"));
    let content = std::fs::read_to_string(&path).expect("fixture file");
    serde_json::from_str(&content).expect("valid fixture JSON")
}

macro_rules! round_trip {
    ($ty:ty, $name:literal) => {{
        let v = load($name);
        let parsed: $ty = serde_json::from_value(v.clone()).unwrap();
        let out = serde_json::to_value(&parsed).unwrap();
        assert_eq!(out, v);
    }};
}

#[test]
fn session_message_round_trips() {
    round_trip!(schema::SessionMessage, "session_message");
}

#[test]
fn messages_response_round_trips() {
    round_trip!(schema::MessagesResponse, "messages_response");
}

#[test]
fn state_db_query_request_round_trips() {
    round_trip!(schema::StateDbQueryRequest, "state_db_query_request");
}

#[test]
fn state_db_search_meta_round_trips() {
    round_trip!(schema::StateDbSearchMeta, "state_db_search_meta");
}

#[test]
fn upstream_credential_round_trips() {
    round_trip!(schema::UpstreamCredential, "upstream_credential");
}

#[test]
fn proxy_status_round_trips() {
    round_trip!(schema::ProxyStatus, "proxy_status");
}

#[test]
fn api_server_status_round_trips() {
    round_trip!(schema::ApiServerStatus, "api_server_status");
}

#[test]
fn chat_completion_request_round_trips() {
    round_trip!(schema::ChatCompletionRequest, "chat_completion_request");
}

#[test]
fn acp_status_round_trips() {
    round_trip!(schema::AcpStatus, "acp_status");
}

#[test]
fn acp_session_state_round_trips() {
    round_trip!(schema::AcpSessionState, "acp_session_state");
}

#[test]
fn lsp_process_status_round_trips() {
    round_trip!(schema::LspProcessStatus, "lsp_process_status");
}

#[test]
fn lsp_spawn_args_round_trips() {
    round_trip!(schema::LspSpawnArgs, "lsp_spawn_args");
}

#[test]
fn mcp_stdio_spawn_args_round_trips() {
    round_trip!(schema::McpStdioSpawnArgs, "mcp_stdio_spawn_args");
}

#[test]
fn mcp_server_config_round_trips() {
    round_trip!(schema::McpServerConfig, "mcp_server_config");
}

#[test]
fn wake_start_input_round_trips() {
    round_trip!(schema::WakeStartInput, "wake_start_input");
}

#[test]
fn wake_feed_input_round_trips() {
    round_trip!(schema::WakeFeedInput, "wake_feed_input");
}

#[test]
fn telemetry_config_round_trips() {
    round_trip!(schema::TelemetryConfig, "telemetry_config");
}

#[test]
fn otel_span_round_trips() {
    round_trip!(schema::OtelSpan, "otel_span");
}

#[test]
fn egress_proxy_status_round_trips() {
    round_trip!(schema::EgressProxyStatus, "egress_proxy_status");
}

#[test]
fn gateway_event_known_round_trips() {
    round_trip!(schema::GatewayEvent, "gateway_event_message_delta");
}

#[test]
fn gateway_event_raw_unknown_round_trips() {
    round_trip!(schema::GatewayEvent, "gateway_event_raw_unknown");
}

#[test]
fn parse_gateway_event_classifies_unknown_as_raw() {
    let known = load("gateway_event_message_delta");
    match schema::parse_gateway_event(&known).unwrap() {
        schema::GatewayEvent::Known(_) => {}
        _ => panic!("expected known event"),
    }

    let unknown = load("gateway_event_raw_unknown");
    match schema::parse_gateway_event(&unknown).unwrap() {
        schema::GatewayEvent::Raw(raw) => assert_eq!(raw.kind, "brand.new.event"),
        _ => panic!("expected raw event"),
    }
}

#[test]
fn session_log_parser_matches_ts_snapshot() {
    let input = load("session_log_input");
    let expected = load("session_log_output");
    let actual = schema::session_log_to_messages("s-1", &input);
    let actual_json = serde_json::to_value(&actual).unwrap();
    assert_eq!(actual_json, expected);
}

#[test]
fn session_log_handle_request_returns_messages_response_shape() {
    use tempfile::TempDir;

    let dir = TempDir::new().unwrap();
    let sessions = dir.path().join("sessions");
    std::fs::create_dir_all(&sessions).unwrap();
    std::fs::write(
        sessions.join("session_abc.json"),
        r#"{"session_start":"2024-01-01T00:00:00Z","messages":[{"role":"user","content":"hi"}]}"#,
    )
    .unwrap();

    let (status, body) = hermes_agent_cn::session_log::handle_session_log_request(
        "abc",
        dir.path().to_str().unwrap(),
    );
    assert_eq!(status, 200);
    assert_eq!(body["session_id"], "abc");
    assert!(body
        .get("messages")
        .is_some_and(serde_json::Value::is_array));
    assert_eq!(body["messages"][0]["role"], "user");
    assert!(body.get("raw_log").is_none());
}
