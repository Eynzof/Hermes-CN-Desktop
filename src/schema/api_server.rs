//! Serde mirror of `@hermes/protocol/src/api-server.ts`.
//!
//! The api-server wire is `snake_case` (`max_tokens`, `finish_reason`), so we
//! keep the default snake_case field names. `object` is intentionally kept a
//! plain `String` to stay tolerant of the fixed literals.

use serde::{Deserialize, Serialize};

use crate::schema::util;

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct ChatCompletionMessage {
    pub role: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<serde_json::Value>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct ChatCompletionRequest {
    pub model: String,
    pub messages: Vec<ChatCompletionMessage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stream: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<i64>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct ChatCompletionChoice {
    #[serde(default)]
    pub index: u32,
    pub message: ChatCompletionMessage,
    #[serde(default = "util::default_finish_reason")]
    pub finish_reason: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct ChatCompletionResponse {
    pub id: String,
    pub object: String,
    pub created: i64,
    pub model: String,
    pub choices: Vec<ChatCompletionChoice>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct ChatCompletionDelta {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<serde_json::Value>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct ChatCompletionChunkChoice {
    pub index: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delta: Option<ChatCompletionDelta>,
    #[serde(default)]
    pub finish_reason: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct ChatCompletionChunk {
    pub id: String,
    pub object: String,
    pub created: i64,
    pub model: String,
    pub choices: Vec<ChatCompletionChunkChoice>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct ApiServerStatus {
    pub running: bool,
    pub port: u16,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn api_server_status_round_trips() {
        let v = serde_json::json!({ "running": true, "port": 9120 });
        let s: ApiServerStatus = serde_json::from_value(v.clone()).unwrap();
        assert_eq!(s.running, true);
        assert_eq!(s.port, 9120);
        assert_eq!(serde_json::to_value(&s).unwrap(), v);
    }

    #[test]
    fn chat_completion_request_round_trips_snake_case() {
        let v = serde_json::json!({
            "model": "gpt-4o",
            "messages": [{"role": "user", "content": "hi"}],
            "stream": false,
            "temperature": 0.7,
            "max_tokens": 100
        });
        let r: ChatCompletionRequest = serde_json::from_value(v.clone()).unwrap();
        assert_eq!(r.model, "gpt-4o");
        assert_eq!(r.messages.len(), 1);
        assert_eq!(r.temperature, Some(0.7));
        assert_eq!(serde_json::to_value(&r).unwrap(), v);
    }

    #[test]
    fn chat_completion_request_optional_fields_omitted_when_absent() {
        let v = serde_json::json!({
            "model": "gpt-4o",
            "messages": []
        });
        let r: ChatCompletionRequest = serde_json::from_value(v).unwrap();
        assert_eq!(r.stream, None);
        let out = serde_json::to_value(&r).unwrap();
        assert!(out.get("stream").is_none());
    }

    #[test]
    fn chat_completion_response_round_trips() {
        let v = serde_json::json!({
            "id": "chatcmpl-1",
            "object": "chat.completion",
            "created": 1710000000,
            "model": "gpt-4o",
            "choices": [{
                "index": 0,
                "message": {"role": "assistant", "content": "hello"},
                "finish_reason": "stop"
            }]
        });
        let r: ChatCompletionResponse = serde_json::from_value(v.clone()).unwrap();
        assert_eq!(r.choices[0].message.role, "assistant");
        assert_eq!(r.choices[0].finish_reason.as_deref(), Some("stop"));
        assert_eq!(serde_json::to_value(&r).unwrap(), v);
    }

    #[test]
    fn chat_completion_chunk_round_trips() {
        let v = serde_json::json!({
            "id": "chatcmpl-1",
            "object": "chat.completion.chunk",
            "created": 1710000000,
            "model": "gpt-4o",
            "choices": [{"index": 0, "delta": {"role": "assistant", "content": "hi"}, "finish_reason": null}]
        });
        let c: ChatCompletionChunk = serde_json::from_value(v.clone()).unwrap();
        assert!(c.choices[0].delta.is_some());
        assert_eq!(c.choices[0].finish_reason, None);
        assert_eq!(serde_json::to_value(&c).unwrap(), v);
    }
}
