//! Serde mirror of `@hermes/protocol/src/acp.ts`.
//!
//! ACP wire shapes are `camelCase` (`sessionId`, `messageCount`, `isRunning`).

use serde::{Deserialize, Serialize};

use crate::schema::util;

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AcpSessionState {
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default = "util::default_acp_mode")]
    pub mode: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub history: Vec<serde_json::Value>,
    #[serde(default)]
    pub queued_prompts: Vec<String>,
    #[serde(default)]
    pub is_running: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_prompt_text: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AcpSessionRow {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
    #[serde(default)]
    pub message_count: usize,
    pub last_active: f64,
    pub started_at: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub history_json: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_reason: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AcpClientInfo {
    pub name: String,
    pub version: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AcpInitializeParams {
    pub protocol_version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<serde_json::Value>,
    pub client_info: AcpClientInfo,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AcpStatus {
    pub running: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn acp_status_round_trips_camel_case() {
        let v = serde_json::json!({ "running": true, "pid": 1234 });
        let s: AcpStatus = serde_json::from_value(v.clone()).unwrap();
        assert_eq!(s.running, true);
        assert_eq!(s.pid, Some(1234));
        assert_eq!(serde_json::to_value(&s).unwrap(), v);
    }

    #[test]
    fn acp_status_pid_omitted_when_none() {
        let s = AcpStatus {
            running: true,
            pid: None,
        };
        let out = serde_json::to_value(&s).unwrap();
        assert!(out.get("pid").is_none());
    }

    #[test]
    fn acp_session_state_null_vs_missing_and_defaults() {
        let v = serde_json::json!({
            "sessionId": "s-1",
            "cwd": "/workspace",
            "mode": "default",
            "queuedPrompts": ["p"],
            "isRunning": true
        });
        let s: AcpSessionState = serde_json::from_value(v.clone()).unwrap();
        assert_eq!(s.session_id, "s-1");
        assert_eq!(s.mode, "default");
        assert!(s.history.is_empty());
        assert_eq!(s.queued_prompts, vec!["p".to_string()]);
        assert_eq!(s.is_running, true);
        assert_eq!(serde_json::to_value(&s).unwrap(), v);
    }

    #[test]
    fn acp_session_row_round_trips() {
        let v = serde_json::json!({
            "id": "s-1",
            "cwd": "/tmp",
            "model": "gpt-4o",
            "title": "title",
            "preview": "prev",
            "messageCount": 3,
            "lastActive": 1710000000.0,
            "startedAt": 1700000000.0,
            "historyJson": "[{}]",
            "parentSessionId": "p-1",
            "endReason": "done"
        });
        let r: AcpSessionRow = serde_json::from_value(v.clone()).unwrap();
        assert_eq!(r.message_count, 3);
        assert_eq!(r.parent_session_id.as_deref(), Some("p-1"));
        assert_eq!(serde_json::to_value(&r).unwrap(), v);
    }

    #[test]
    fn acp_initialize_params_round_trips() {
        let v = serde_json::json!({
            "protocolVersion": "1.0",
            "capabilities": { "x": 1 },
            "clientInfo": { "name": "desktop", "version": "1.0" }
        });
        let p: AcpInitializeParams = serde_json::from_value(v.clone()).unwrap();
        assert_eq!(p.protocol_version, "1.0");
        assert_eq!(p.client_info.name, "desktop");
        assert_eq!(serde_json::to_value(&p).unwrap(), v);
    }
}
