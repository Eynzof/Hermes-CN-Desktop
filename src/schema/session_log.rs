//! Rust port of `packages/protocol/src/session-log.ts` `sessionLogToMessages`.
//!
//! The TS transform is currently orphaned (zero consumers outside its own test)
//! and the Rust `/__hermes_session_log/` route returns `{ session_id, raw_log }`
//! while the UI parses a `MessagesResponse`. This module produces the
//! `MessagesResponse` shape directly so the Tauri shell matches browser-dev.
//!
//! Semantics are kept byte-for-byte identical to the TS function:
//! - iterate `log.messages` (non-array → empty)
//! - skip non-object entries and unknown `role`s
//! - loose `role` (user/assistant/system/tool only at the transform boundary)
//! - `content` stringify fallback; nullable passthrough fields
//! - `timestamp = session_start + index`, `id = index + 1`

use serde_json::Value;

use crate::schema::session::{MessagesResponse, SessionMessage};

/// Parse a raw session-log JSON object into a `MessagesResponse`.
pub fn session_log_to_messages(session_id: &str, log: &Value) -> MessagesResponse {
    let raw_messages: &[serde_json::Value] = match log.get("messages") {
        Some(Value::Array(items)) => items,
        _ => &[],
    };
    let start = start_timestamp_seconds(log.get("session_start"));

    let mut messages = Vec::new();
    for (index, raw) in raw_messages.iter().enumerate() {
        let Some(obj) = raw.as_object() else {
            continue;
        };
        let role = match obj.get("role") {
            Some(Value::String(s)) => normalize_role(s.as_str()),
            _ => None,
        };
        let Some(role) = role else {
            continue;
        };

        let msg = Value::Object(obj.clone());
        messages.push(SessionMessage {
            id: (index + 1) as i64,
            session_id: session_id.to_string(),
            role,
            content: as_string(msg.get("content")),
            images: match msg.get("images") {
                Some(Value::Array(_)) => Some(msg.get("images").cloned().unwrap_or(Value::Null)),
                _ => None,
            },
            tool_call_id: as_nullable_string(msg.get("tool_call_id")),
            tool_calls: nullish_value(msg.get("tool_calls")),
            tool_name: as_nullable_string(msg.get("tool_name")),
            timestamp: start + index as f64,
            token_count: None,
            finish_reason: as_nullable_string(msg.get("finish_reason")),
            reasoning: as_nullable_string(msg.get("reasoning")),
            reasoning_details: nullish_value(msg.get("reasoning_details")),
            codex_reasoning_items: nullish_value(msg.get("codex_reasoning_items")),
            reasoning_content: as_nullable_string(msg.get("reasoning_content")),
        });
    }

    MessagesResponse {
        session_id: session_id.to_string(),
        messages,
        ui_messages: None,
    }
}

/// `asString` in the TS transform.
fn as_string(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::String(s)) => Some(s.clone()),
        Some(Value::Null) | None => None,
        Some(other) => Some(serde_json::to_string(other).unwrap_or_else(|_| other.to_string())),
    }
}

/// `asNullableString` in the TS transform.
fn as_nullable_string(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::String(s)) => Some(s.clone()),
        _ => None,
    }
}

/// `msg.tool_calls ?? null`, `msg.reasoning_details ?? null`, etc. — `Some(v)`
/// when the key holds a non-null value, `None` (serialised as `null`) otherwise.
fn nullish_value(value: Option<&Value>) -> Option<Value> {
    match value {
        Some(v) if !v.is_null() => Some(v.clone()),
        _ => None,
    }
}

/// `normalizeRole` in the TS transform.
fn normalize_role(role: &str) -> Option<String> {
    match role {
        "user" | "assistant" | "system" | "tool" => Some(role.to_string()),
        _ => None,
    }
}

/// `startTimestampSeconds` in the TS transform.
fn start_timestamp_seconds(value: Option<&Value>) -> f64 {
    match value {
        Some(Value::String(s)) => match chrono::DateTime::parse_from_rfc3339(s) {
            Ok(dt) => dt.timestamp() as f64 + dt.timestamp_subsec_millis() as f64 / 1000.0,
            Err(_) => now_seconds(),
        },
        _ => now_seconds(),
    }
}

fn now_seconds() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_and_non_array_messages_yield_empty() {
        let r = session_log_to_messages("s", &serde_json::json!({}));
        assert_eq!(r.messages.len(), 0);
        let r = session_log_to_messages("s", &serde_json::json!({ "messages": "nope" }));
        assert_eq!(r.messages.len(), 0);
    }

    #[test]
    fn skips_non_objects_and_unknown_roles() {
        let log = serde_json::json!({
            "session_start": "2024-01-01T00:00:00Z",
            "messages": [
                null,
                "string",
                [1, 2],
                {"role": "unknown", "content": "x"},
                {"role": "user", "content": "hi"},
                {"role": "system", "content": "sys"},
                {"role": "assistant", "content": "a"},
                {"role": "tool", "content": "t"}
            ]
        });
        let r = session_log_to_messages("s-1", &log);
        assert_eq!(r.messages.len(), 4);
        assert_eq!(r.messages[0].role, "user");
        assert_eq!(r.messages[2].role, "assistant");
        assert_eq!(r.messages[3].role, "tool");
        // id/timestamp use the *original* raw-message index (TS flatMap index),
        // so skipped entries still advance the counter.
        assert_eq!(r.messages[0].id, 5);
        assert_eq!(r.messages[3].id, 8);
        assert_eq!(r.messages[0].timestamp, 1704067200.0 + 4.0);
        assert_eq!(r.messages[3].timestamp, 1704067200.0 + 7.0);
    }

    #[test]
    fn stringify_fallback_for_non_string_content() {
        let log = serde_json::json!({
            "messages": [
                {"role": "user", "content": {"a": 1}},
                {"role": "user", "content": 123},
                {"role": "user", "content": null}
            ]
        });
        let r = session_log_to_messages("s", &log);
        assert_eq!(r.messages[0].content.as_deref(), Some("{\"a\":1}"));
        assert_eq!(r.messages[1].content.as_deref(), Some("123"));
        assert_eq!(r.messages[2].content, None);
    }

    #[test]
    fn timestamps_and_null_passthrough_fields() {
        let log = serde_json::json!({
            "session_start": "2024-01-01T00:00:00Z",
            "messages": [
                {"role": "assistant", "content": "hi", "tool_call_id": "tc1", "tool_name": "f"}
            ]
        });
        let r = session_log_to_messages("s", &log);
        let m = &r.messages[0];
        assert_eq!(m.tool_call_id.as_deref(), Some("tc1"));
        assert_eq!(m.tool_name.as_deref(), Some("f"));
        assert_eq!(m.tool_calls, None);
        assert_eq!(m.token_count, None);
        assert_eq!(m.timestamp, 1704067200.0);
        assert!(m.images.is_none());
        let out = serde_json::to_value(m).unwrap();
        // Nullable passthrough fields serialise as explicit null like TS.
        assert_eq!(out["tool_calls"], serde_json::Value::Null);
        assert_eq!(out["token_count"], serde_json::Value::Null);
        assert!(out.get("images").is_none());
    }

    #[test]
    fn missing_session_start_uses_now_and_keeps_offsets() {
        let log = serde_json::json!({
            "messages": [
                {"role": "user", "content": "a"},
                {"role": "assistant", "content": "b"}
            ]
        });
        let r = session_log_to_messages("s", &log);
        assert_eq!(r.messages.len(), 2);
        assert!(r.messages[1].timestamp > r.messages[0].timestamp);
        assert_eq!(r.messages[0].timestamp + 1.0, r.messages[1].timestamp);
    }

    #[test]
    fn images_array_passthrough() {
        let log = serde_json::json!({
            "messages": [
                {"role": "user", "content": "x", "images": ["a", {"url": "b"}]}
            ]
        });
        let r = session_log_to_messages("s", &log);
        assert_eq!(
            r.messages[0].images.as_ref().unwrap(),
            &serde_json::json!(["a", {"url": "b"}])
        );
    }
}
