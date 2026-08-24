//! Serde mirror of `@hermes/protocol`'s gateway JSON-RPC event types
//! (`hermes-api.ts` `GatewayKnownEvent` / `RawGatewayEvent` /
//! `parseGatewayEvent`).
//!
//! The gateway wire uses **snake_case** (`type`, `session_id`, `tool_id`,
//! `duration_s`, …), so we keep the default snake_case field names rather than
//! applying the `camelCase` convention used by most IPC-boundary structs.
//!
//! Serde's internally-tagged enum cannot carry the unknown tag value into a
//! catching variant with `#[serde(other)]` (that attribute only allows a unit
//! variant), so to mirror the TS `try-known-then-raw` semantics we use an
//! `#[serde(untagged)]` wrapper: `Known(GatewayKnownEvent)` is tried first and
//! `Raw(RawGatewayEvent)` catches anything the known set rejects (unknown `type`
//! or a malformed known-payload), exactly like `parseGatewayEvent`.

use serde::{Deserialize, Serialize};

use crate::error::AppError;

/// A parsed gateway event: either a known typed event or an opaque raw event.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(untagged)]
pub enum GatewayEvent {
    Known(GatewayKnownEvent),
    Raw(RawGatewayEvent),
}

/// The known gateway event set, discriminated by `type`.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(tag = "type")]
pub enum GatewayKnownEvent {
    #[serde(rename = "gateway.ready")]
    GatewayReady {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        session_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        payload: Option<GatewayReadyPayload>,
    },
    #[serde(rename = "session.info")]
    SessionInfo {
        session_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        payload: Option<serde_json::Value>,
    },
    #[serde(rename = "message.start")]
    MessageStart {
        session_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        payload: Option<serde_json::Value>,
    },
    #[serde(rename = "message.delta")]
    MessageDelta {
        session_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        payload: Option<GatewayTextPayload>,
    },
    #[serde(rename = "message.complete")]
    MessageComplete {
        session_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        payload: Option<GatewayMessageCompletePayload>,
    },
    #[serde(rename = "thinking.delta")]
    ThinkingDelta {
        session_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        payload: Option<GatewayTextPayload>,
    },
    #[serde(rename = "reasoning.delta")]
    ReasoningDelta {
        session_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        payload: Option<GatewayTextPayload>,
    },
    #[serde(rename = "reasoning.available")]
    ReasoningAvailable {
        session_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        payload: Option<GatewayTextPayload>,
    },
    #[serde(rename = "status.update")]
    StatusUpdate {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        session_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        payload: Option<GatewayStatusUpdatePayload>,
    },
    #[serde(rename = "tool.start")]
    ToolStart {
        session_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        payload: Option<GatewayToolStartPayload>,
    },
    #[serde(rename = "tool.generating")]
    ToolGenerating {
        session_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        payload: Option<GatewayToolGeneratingPayload>,
    },
    #[serde(rename = "tool.complete")]
    ToolComplete {
        session_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        payload: Option<GatewayToolCompletePayload>,
    },
    #[serde(rename = "approval.request")]
    ApprovalRequest {
        session_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        payload: Option<GatewayApprovalRequestPayload>,
    },
    #[serde(rename = "error")]
    Error {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        session_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        payload: Option<GatewayErrorPayload>,
    },
    #[serde(rename = "moa.reference")]
    MoaReference {
        session_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        payload: Option<GatewayMoaReferencePayload>,
    },
    #[serde(rename = "moa.aggregating")]
    MoaAggregating {
        session_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        payload: Option<GatewayMoaAggregatingPayload>,
    },
    #[serde(rename = "delegation.cli.started")]
    DelegationCliStarted {
        session_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        payload: Option<GatewayDelegationCliStartedPayload>,
    },
    #[serde(rename = "delegation.cli.output")]
    DelegationCliOutput {
        session_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        payload: Option<GatewayDelegationCliOutputPayload>,
    },
    #[serde(rename = "delegation.cli.completed")]
    DelegationCliCompleted {
        session_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        payload: Option<GatewayDelegationCliCompletedPayload>,
    },
}

/// The passthrough fallback used by `parseGatewayEvent` when no known type matches.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct RawGatewayEvent {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub payload: Option<serde_json::Value>,
}

/// Mirror of `parseGatewayEvent`: try the known typed set, fall back to raw.
pub fn parse_gateway_event(value: &serde_json::Value) -> Result<GatewayEvent, AppError> {
    serde_json::from_value::<GatewayEvent>(value.clone())
        .map_err(|e| AppError::Internal(format!("invalid gateway event: {}", e)))
}

// ── Typed payload sub-structs ────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct GatewayReadyPayload {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skin: Option<serde_json::Value>,
}

/// `GatewayTextPayload`.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct GatewayTextPayload {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rendered: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct GatewayMessageCompletePayload {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rendered: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct GatewayStatusUpdatePayload {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct GatewayToolStartPayload {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_id: Option<String>,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct GatewayToolGeneratingPayload {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct GatewayToolCompletePayload {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_s: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inline_diff: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct GatewayApprovalRequestPayload {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct GatewayErrorPayload {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct GatewayMoaReferencePayload {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub index: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub count: Option<i64>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct GatewayMoaAggregatingPayload {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub aggregator: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct GatewayDelegationCliStartedPayload {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delegation_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command_redacted: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt_excerpt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workdir: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub flags: Option<serde_json::Value>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct GatewayDelegationCliOutputPayload {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delegation_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub process_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chunk: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub truncated: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub events: Option<Vec<serde_json::Value>>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct GatewayDelegationCliCompletedPayload {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delegation_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_s: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_tail: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_known_message_delta() {
        let v = serde_json::json!({
            "type": "message.delta",
            "session_id": "s-1",
            "payload": {"text": "hello"},
            "extra": "passthrough"
        });
        let ev = parse_gateway_event(&v).unwrap();
        assert!(matches!(
            ev,
            GatewayEvent::Known(GatewayKnownEvent::MessageDelta { .. })
        ));
    }

    #[test]
    fn parses_known_tool_complete() {
        let v = serde_json::json!({
            "type": "tool.complete",
            "session_id": "s-1",
            "payload": {"tool_id": "t1", "duration_s": 2.5}
        });
        let ev = parse_gateway_event(&v).unwrap();
        match ev {
            GatewayEvent::Known(GatewayKnownEvent::ToolComplete { payload, .. }) => {
                let p = payload.unwrap();
                assert_eq!(p.tool_id.as_deref(), Some("t1"));
                assert_eq!(p.duration_s, Some(2.5));
            }
            _ => panic!("expected tool.complete"),
        }
    }

    #[test]
    fn parses_unknown_type_as_raw() {
        let v = serde_json::json!({
            "type": "brand.new.event",
            "session_id": "s-1",
            "payload": {"foo": 1}
        });
        let ev = parse_gateway_event(&v).unwrap();
        match ev {
            GatewayEvent::Raw(raw) => {
                assert_eq!(raw.kind, "brand.new.event");
                assert_eq!(raw.session_id.as_deref(), Some("s-1"));
                assert_eq!(raw.payload, Some(serde_json::json!({"foo": 1})));
            }
            _ => panic!("expected raw"),
        }
    }

    #[test]
    fn malformed_known_payload_falls_back_to_raw() {
        // message.delta's text must be a string; a number makes the known parse
        // fail and the raw fallback win, matching parseGatewayEvent.
        let v = serde_json::json!({
            "type": "message.delta",
            "session_id": "s-1",
            "payload": {"text": 123}
        });
        let ev = parse_gateway_event(&v).unwrap();
        assert!(matches!(ev, GatewayEvent::Raw(_)));
    }

    #[test]
    fn missing_type_errors() {
        let v = serde_json::json!({"session_id": "s-1", "payload": {}});
        assert!(parse_gateway_event(&v).is_err());
    }

    #[test]
    fn round_trips_known_event() {
        let v = serde_json::json!({
            "type": "message.complete",
            "session_id": "s-1",
            "payload": {"text": "done", "status": "complete"}
        });
        let ev: GatewayEvent = serde_json::from_value(v).unwrap();
        let out = serde_json::to_value(&ev).unwrap();
        assert_eq!(out["type"], "message.complete");
        assert_eq!(out["session_id"], "s-1");
        assert_eq!(out["payload"]["text"], "done");
    }
}
