//! Serde mirror of the agent-core `Message` / `CompactionMessage` wire shapes.
//!
//! Field names follow `@hermes/protocol` Zod + the TS `packages/agent-core/src/types.ts`
//! `Message` interface. `cache_control` is intentionally kept snake_case because the
//! TS `CompactionMessage` uses the literal property name `cache_control`.

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub role: String,
    #[serde(default)]
    pub content: Option<serde_json::Value>,
    #[serde(default)]
    pub tool_calls: Option<Vec<ToolCall>>,
    #[serde(default)]
    pub tool_call_id: Option<String>,
    #[serde(default)]
    pub tool_name: Option<String>,
    #[serde(default)]
    pub timestamp: Option<i64>,
    #[serde(default)]
    pub token_count: Option<usize>,
    #[serde(default)]
    pub finish_reason: Option<String>,
    #[serde(default)]
    pub reasoning: Option<String>,
    #[serde(default)]
    pub reasoning_content: Option<String>,

    // --- CompactionMessage extras (merged into the same struct for IPC tolerance) ---
    #[serde(default)]
    pub origin: Option<serde_json::Value>,
    #[serde(default)]
    pub summary_message: Option<bool>,
    #[serde(default)]
    pub compaction_id: Option<String>,
    /// TS `CompactionMessage.cache_control` is kept snake_case over IPC.
    #[serde(rename = "cache_control", default)]
    pub cache_control: Option<serde_json::Value>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ToolCall {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub name: String,
    #[serde(default = "default_arguments")]
    pub arguments: serde_json::Value,
    #[serde(default)]
    pub arguments_json: Option<String>,
}

fn default_arguments() -> serde_json::Value {
    serde_json::json!({})
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn message_round_trips_camel_case() {
        let v = serde_json::json!({
            "id": "m1",
            "role": "assistant",
            "content": "hi",
            "toolCalls": [{"id": "tc1", "name": "f", "arguments": {"a": 1}}],
            "toolCallId": null,
            "summaryMessage": true,
            "compactionId": "c-1",
            "cache_control": {"type": "ephemeral"}
        });
        let m: Message = serde_json::from_value(v).unwrap();
        assert_eq!(m.role, "assistant");
        assert_eq!(m.summary_message, Some(true));
        assert_eq!(m.compaction_id.as_deref(), Some("c-1"));
        assert!(m.cache_control.is_some());
        assert_eq!(m.tool_calls.as_ref().unwrap()[0].name, "f");
    }

    #[test]
    fn message_missing_fields_tolerated() {
        let m: Message = serde_json::from_value(serde_json::json!({})).unwrap();
        assert_eq!(m.role, "");
        assert!(m.content.is_none());
        assert!(m.tool_calls.is_none());
    }
}
