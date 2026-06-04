use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock};

use futures_util::StreamExt;
use reqwest::StatusCode;
use serde::Deserialize;
use tauri::{Emitter, Listener, State};

use crate::error::AppError;
use crate::process::dashboard::{build_gateway_url, fetch_session_token};
use crate::state::AppState;

static SSE_HTTP_CLIENT: LazyLock<reqwest::Client> = LazyLock::new(reqwest::Client::new);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectGatewayInput {
    #[serde(default)]
    pub client_id: Option<String>,
}

/// Build the SSE endpoint URL with the `client_id` query param only.
///
/// The session token is intentionally NOT placed in the query string for the
/// Tauri proxy path: `open_sse_response` authenticates via the `Authorization`
/// header instead, so a token in the URL would be redundant and only risk
/// leaking into logs. (The browser-native EventSource path in
/// `web/src/lib/gateway-sse-client.ts` still passes the token via query because
/// EventSource cannot set request headers — that is a separate, documented
/// case.) Pure function so it can be unit tested without spinning up reqwest.
pub fn build_sse_url(api_base_url: &str, client_id: Option<&str>) -> String {
    let mut url = format!("{}/api/v2/events", api_base_url.trim_end_matches('/'));
    if let Some(cid) = client_id {
        url.push_str(&format!("?client_id={}", urlencoding::encode(cid)));
    }
    url
}

/// Accumulate an SSE byte chunk into `buffer` and return the payloads of any
/// complete `data: <payload>` lines.
///
/// Uses a byte buffer (not a String) so multibyte UTF-8 characters (e.g.
/// CJK) split across chunk boundaries do not get corrupted into U+FFFD.
/// Non-UTF8 line bytes fall back to lossy decoding for individual lines.
pub fn parse_sse_chunk(buffer: &mut Vec<u8>, chunk: &[u8]) -> Vec<String> {
    buffer.extend_from_slice(chunk);
    let mut events = Vec::new();
    while let Some(pos) = buffer.iter().position(|b| *b == b'\n') {
        // Drain the line including the terminating \n.
        let line_bytes: Vec<u8> = buffer.drain(..=pos).collect();
        // Strip the trailing \n we just consumed, then a possible \r.
        let without_lf = &line_bytes[..line_bytes.len() - 1];
        let without_crlf = without_lf.strip_suffix(b"\r").unwrap_or(without_lf);
        // Try strict UTF-8 first to avoid replacement chars; fall back to lossy.
        let line = match std::str::from_utf8(without_crlf) {
            Ok(s) => s.to_string(),
            Err(_) => String::from_utf8_lossy(without_crlf).into_owned(),
        };
        if let Some(data) = line.strip_prefix("data: ") {
            events.push(data.to_string());
        }
    }
    events
}

async fn open_sse_response(
    api_base_url: &str,
    session_token: Option<&str>,
    client_id: Option<&str>,
) -> Result<reqwest::Response, AppError> {
    let url = build_sse_url(api_base_url, client_id);
    let mut req = SSE_HTTP_CLIENT
        .get(&url)
        .header("Accept", "text/event-stream");
    if let Some(token) = session_token {
        req = req.header("Authorization", format!("Bearer {}", token));
    }

    req.send()
        .await
        .map_err(|e| AppError::SseConnect(e.to_string()))
}

#[tauri::command]
pub async fn connect_gateway_sse(
    input: ConnectGatewayInput,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<(), AppError> {
    let stop = Arc::new(AtomicBool::new(false));
    let (api_base_url, session_token) = {
        let mut inner = state.inner.lock()?;
        if let Some(previous) = inner.gateway_sse_stop.replace(stop.clone()) {
            previous.store(true, Ordering::Relaxed);
        }
        (inner.api_base_url.clone(), inner.session_token.clone())
    };

    let mut response = open_sse_response(
        &api_base_url,
        session_token.as_deref(),
        input.client_id.as_deref(),
    )
    .await?;

    if response.status() == StatusCode::UNAUTHORIZED {
        if let Some(fresh_token) = fetch_session_token(&api_base_url).await {
            let fresh_gateway_url = build_gateway_url(&api_base_url, Some(&fresh_token));
            {
                let mut inner = state.inner.lock()?;
                inner.session_token = Some(fresh_token.clone());
                inner.gateway_url = fresh_gateway_url;
            }
            response = open_sse_response(
                &api_base_url,
                Some(&fresh_token),
                input.client_id.as_deref(),
            )
            .await?;
        }
    }

    if !response.status().is_success() {
        return Err(AppError::SseConnect(format!("HTTP {}", response.status())));
    }

    let stop_clone = stop.clone();

    let unlisten_id = app.listen("gateway-sse-disconnect", move |_| {
        stop_clone.store(true, Ordering::Relaxed);
    });

    let app_clone = app.clone();
    let app_unlisten = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut stream = response.bytes_stream();
        let mut buffer: Vec<u8> = Vec::new();

        while let Some(chunk_result) = stream.next().await {
            if stop.load(Ordering::Relaxed) {
                break;
            }

            let chunk = match chunk_result {
                Ok(c) => c,
                Err(e) => {
                    log::error!("SSE stream read error: {}", e);
                    let _ = app_clone.emit("gateway-sse-error", e.to_string());
                    break;
                }
            };

            for data in parse_sse_chunk(&mut buffer, &chunk) {
                let _ = app_clone.emit("gateway-sse-event", data);
            }
        }

        log::info!("SSE stream ended");
        app_unlisten.unlisten(unlisten_id);
        let _ = app_clone.emit("gateway-sse-error", "SSE stream ended".to_string());
    });

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    // --- build_sse_url ----------------------------------------------------

    #[test]
    fn build_sse_url_without_client_id() {
        let url = build_sse_url("http://127.0.0.1:9119", None);
        assert_eq!(url, "http://127.0.0.1:9119/api/v2/events");
    }

    #[test]
    fn build_sse_url_strips_trailing_slash_from_base() {
        let url = build_sse_url("http://127.0.0.1:9119/", None);
        assert_eq!(url, "http://127.0.0.1:9119/api/v2/events");
    }

    #[test]
    fn build_sse_url_with_client_id_only() {
        let url = build_sse_url("http://x", Some("cid-1"));
        assert_eq!(url, "http://x/api/v2/events?client_id=cid-1");
    }

    #[test]
    fn build_sse_url_never_includes_token_query() {
        // #46: the Tauri proxy authenticates via the Authorization header, so the
        // session token must never appear in the URL (it would leak into logs).
        let url = build_sse_url("http://x", Some("cid-1"));
        assert!(!url.contains("token"), "token must not be in URL: {url}");
    }

    #[test]
    fn build_sse_url_encodes_client_id() {
        let url = build_sse_url("http://x", Some("cid/1?x=2"));
        assert_eq!(url, "http://x/api/v2/events?client_id=cid%2F1%3Fx%3D2");
    }

    // --- parse_sse_chunk --------------------------------------------------

    #[test]
    fn parses_single_data_line_in_one_chunk() {
        let mut buf = Vec::new();
        let events = parse_sse_chunk(&mut buf, b"data: hello\n");
        assert_eq!(events, vec!["hello".to_string()]);
        assert!(
            buf.is_empty(),
            "buffer must be drained when line is complete"
        );
    }

    #[test]
    fn handles_crlf_line_endings() {
        let mut buf = Vec::new();
        let events = parse_sse_chunk(&mut buf, b"data: hello\r\n");
        assert_eq!(events, vec!["hello".to_string()]);
    }

    #[test]
    fn handles_multiple_data_lines_in_one_chunk() {
        let mut buf = Vec::new();
        let events = parse_sse_chunk(&mut buf, b"data: one\ndata: two\ndata: three\n");
        assert_eq!(events, vec!["one", "two", "three"]);
    }

    #[test]
    fn skips_non_data_lines() {
        let mut buf = Vec::new();
        let events = parse_sse_chunk(
            &mut buf,
            b": comment line\nevent: ping\ndata: payload\nretry: 5000\n",
        );
        assert_eq!(events, vec!["payload"]);
    }

    #[test]
    fn buffers_incomplete_line_across_chunks() {
        let mut buf = Vec::new();
        let first = parse_sse_chunk(&mut buf, b"data: hel");
        assert!(first.is_empty());
        let second = parse_sse_chunk(&mut buf, b"lo\n");
        assert_eq!(second, vec!["hello".to_string()]);
    }

    #[test]
    fn empty_data_line_yields_empty_string() {
        let mut buf = Vec::new();
        let events = parse_sse_chunk(&mut buf, b"data: \n");
        assert_eq!(events, vec![String::new()]);
    }

    #[test]
    fn blank_line_alone_yields_no_event() {
        // SSE uses blank lines as event delimiters but our parser only emits
        // on data: lines — blank lines should produce nothing.
        let mut buf = Vec::new();
        let events = parse_sse_chunk(&mut buf, b"\n\n");
        assert!(events.is_empty());
    }

    #[test]
    fn handles_utf8_chinese_character_split_across_chunks() {
        // "你" is 0xE4 0xBD 0xA0 in UTF-8. Split between byte 1 and 2.
        let mut buf = Vec::new();
        let first = parse_sse_chunk(&mut buf, b"data: prefix \xe4");
        assert!(first.is_empty(), "incomplete UTF-8, no events yet");

        let mut payload = vec![];
        payload.extend_from_slice(b"\xbd\xa0 suffix\n");
        let second = parse_sse_chunk(&mut buf, &payload);
        // Must produce a single complete event with the intact "你" character
        // — NOT a U+FFFD replacement.
        assert_eq!(second.len(), 1);
        assert_eq!(second[0], "prefix 你 suffix");
        assert!(!second[0].contains('\u{FFFD}'), "lossy decoding regression");
    }

    #[test]
    fn handles_utf8_emoji_split_across_three_chunks() {
        // "🎉" is 0xF0 0x9F 0x8E 0x89 in UTF-8 (4 bytes).
        let mut buf = Vec::new();
        assert!(parse_sse_chunk(&mut buf, b"data: \xf0").is_empty());
        assert!(parse_sse_chunk(&mut buf, b"\x9f\x8e").is_empty());
        let events = parse_sse_chunk(&mut buf, b"\x89\n");
        assert_eq!(events, vec!["🎉".to_string()]);
    }

    #[test]
    fn data_prefix_requires_exact_match_with_space() {
        let mut buf = Vec::new();
        // "data:hello" (no space) is technically valid SSE but our parser
        // requires "data: " with the space — pin this convention with a test.
        let events = parse_sse_chunk(&mut buf, b"data:no-space\n");
        assert!(events.is_empty());
    }

    #[test]
    fn json_payload_passes_through_intact() {
        let mut buf = Vec::new();
        let events = parse_sse_chunk(&mut buf, b"data: {\"type\":\"msg\",\"text\":\"hello\"}\n");
        assert_eq!(events, vec![r#"{"type":"msg","text":"hello"}"#]);
    }

    #[test]
    fn chunks_with_only_partial_line_carry_buffer_forward() {
        let mut buf = Vec::new();
        parse_sse_chunk(&mut buf, b"data: par");
        assert_eq!(buf, b"data: par");
        parse_sse_chunk(&mut buf, b"tial-");
        assert_eq!(buf, b"data: partial-");
        let events = parse_sse_chunk(&mut buf, b"done\n");
        assert_eq!(events, vec!["partial-done".to_string()]);
        assert!(buf.is_empty());
    }
}
