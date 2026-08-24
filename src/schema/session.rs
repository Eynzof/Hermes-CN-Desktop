//! Serde mirror of the `@hermes/protocol` `SessionMessage` / `MessagesResponse`
//! wire shapes (`hermes-api.ts` lines ~252-458) plus the session-log parser output.
//!
//! The wire shape uses **snake_case** (it mirrors the backend `messages` table
//! columns), so unlike most IPC-boundary schema modules we do **not** apply
//! `#[serde(rename_all = "camelCase")]` here. `role` is intentionally a plain
//! `String` — a strict enum would blank the whole history on an unknown marker
//! role such as the Feishu bridge's `session_meta`.

use serde::{Deserialize, Serialize};

/// A single session-log / history message.
///
/// Nullable metadata columns are `Option<T>` + `#[serde(default)]` so an explicit
/// `null` and a missing key both collapse to `None`. The `Option` fields that the
/// session-log transform always emits (as `null`) intentionally do **not** use
/// `skip_serializing_if` so the Rust output carries `null` exactly like the TS
/// `sessionLogToMessages` transform. Only `images` is omitted when absent (the TS
/// transform yields `undefined` there).
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct SessionMessage {
    pub id: i64,
    pub session_id: String,
    pub role: String,
    #[serde(default)]
    pub content: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub images: Option<serde_json::Value>,
    #[serde(default)]
    pub tool_call_id: Option<String>,
    #[serde(default)]
    pub tool_calls: Option<serde_json::Value>,
    #[serde(default)]
    pub tool_name: Option<String>,
    /// Seconds since epoch (the TS `timestamp` is a float `number`).
    pub timestamp: f64,
    #[serde(default)]
    pub token_count: Option<serde_json::Value>,
    #[serde(default)]
    pub finish_reason: Option<String>,
    #[serde(default)]
    pub reasoning: Option<String>,
    #[serde(default)]
    pub reasoning_details: Option<serde_json::Value>,
    #[serde(default)]
    pub codex_reasoning_items: Option<serde_json::Value>,
    #[serde(default)]
    pub reasoning_content: Option<String>,
}

/// `MessagesResponse`: the shape the dashboard REST/session-log path returns and
/// the shape the UI's `fetchSessionLogMessages` validates against.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct MessagesResponse {
    pub session_id: String,
    #[serde(default)]
    pub messages: Vec<SessionMessage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ui_messages: Option<serde_json::Value>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_message_round_trips_nullable_fields_as_null() {
        let v = serde_json::json!({
            "id": 1,
            "session_id": "s-1",
            "role": "user",
            "content": "hi",
            "images": ["https://example.com/a.png"],
            "tool_call_id": null,
            "tool_calls": null,
            "tool_name": null,
            "timestamp": 1710000000.0,
            "token_count": null,
            "finish_reason": null,
            "reasoning": null,
            "reasoning_details": null,
            "codex_reasoning_items": null,
            "reasoning_content": null
        });
        let m: SessionMessage = serde_json::from_value(v.clone()).unwrap();
        assert_eq!(m.id, 1);
        assert_eq!(m.session_id, "s-1");
        assert_eq!(m.role, "user");
        assert_eq!(m.content.as_deref(), Some("hi"));
        assert!(m.images.is_some());
        assert!(m.tool_call_id.is_none());
        let out = serde_json::to_value(&m).unwrap();
        // Nullable fields serialize back as explicit `null` (matching the TS transform).
        assert_eq!(out["tool_call_id"], serde_json::Value::Null);
        assert_eq!(out["token_count"], serde_json::Value::Null);
        assert_eq!(out["images"], v["images"]);
    }

    #[test]
    fn session_message_null_equals_missing_for_tolerant_fields() {
        let with_null: SessionMessage = serde_json::from_value(serde_json::json!({
            "id": 1, "session_id": "s", "role": "user", "content": "x",
            "tool_call_id": null, "timestamp": 1.0
        }))
        .unwrap();
        let with_missing: SessionMessage = serde_json::from_value(serde_json::json!({
            "id": 1, "session_id": "s", "role": "user", "content": "x",
            "timestamp": 1.0
        }))
        .unwrap();
        assert_eq!(with_null.tool_call_id, with_missing.tool_call_id);
        assert_eq!(with_null.tool_call_id, None);
    }

    #[test]
    fn messages_response_defaults_messages_empty_and_omits_ui_messages() {
        let r: MessagesResponse =
            serde_json::from_value(serde_json::json!({ "session_id": "s" })).unwrap();
        assert_eq!(r.session_id, "s");
        assert_eq!(r.messages.len(), 0);
        assert!(r.ui_messages.is_none());
        let out = serde_json::to_value(&r).unwrap();
        assert_eq!(out["messages"], serde_json::json!([]));
        assert!(out.get("ui_messages").is_none());
    }

    #[test]
    fn messages_response_round_trips_full_message() {
        let v = serde_json::json!({
            "session_id": "s-1",
            "messages": [{
                "id": 1, "session_id": "s-1", "role": "assistant",
                "content": "hi", "timestamp": 1.0,
                "tool_call_id": null, "token_count": null
            }]
        });
        let r: MessagesResponse = serde_json::from_value(v.clone()).unwrap();
        assert_eq!(r.session_id, "s-1");
        assert_eq!(r.messages.len(), 1);
        // The SessionMessage intentionally serializes the nullable columns as
        // explicit `null` (matching the TS sessionLogToMessages transform), so
        // compare field-by-field rather than exact JSON equality.
        let out = serde_json::to_value(&r).unwrap();
        let msg = &out["messages"][0];
        assert_eq!(msg["id"], 1);
        assert_eq!(msg["session_id"], "s-1");
        assert_eq!(msg["role"], "assistant");
        assert_eq!(msg["content"], "hi");
        assert_eq!(msg["timestamp"], 1.0);
        assert_eq!(msg["tool_call_id"], serde_json::Value::Null);
        assert_eq!(msg["token_count"], serde_json::Value::Null);
    }
}
