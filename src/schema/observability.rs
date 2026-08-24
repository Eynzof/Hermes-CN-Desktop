//! Serde mirror of `@hermes/protocol/src/observability.ts`.
//!
//! Wire shapes are `camelCase` (`traceId`, `parentSpanId`, `startTime`,
//! `sampleRate`).

use serde::{Deserialize, Serialize};

use crate::schema::util;

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OtelEvent {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timestamp: Option<String>,
    #[serde(default = "util::default_empty_object")]
    pub attributes: serde_json::Value,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OtelSpan {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trace_id: Option<String>,
    pub span_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_span_id: Option<String>,
    pub name: String,
    pub start_time: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_time: Option<String>,
    #[serde(default)]
    pub events: Vec<OtelEvent>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TelemetryConfig {
    #[serde(default = "util::default_false")]
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub endpoint: Option<String>,
    #[serde(default = "util::default_sample_rate_f64")]
    pub sample_rate: f64,
}

/// `observability_set_config` arg: the config is passed as a JSON string.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ObservabilitySetConfigArgs {
    pub config_json: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn telemetry_config_round_trips_camel_case() {
        let v = serde_json::json!({
            "enabled": true,
            "endpoint": "http://localhost:4318",
            "sampleRate": 0.5
        });
        let c: TelemetryConfig = serde_json::from_value(v.clone()).unwrap();
        assert_eq!(c.enabled, true);
        assert_eq!(c.sample_rate, 0.5);
        assert_eq!(serde_json::to_value(&c).unwrap(), v);
    }

    #[test]
    fn telemetry_config_defaults() {
        let c: TelemetryConfig = serde_json::from_value(serde_json::json!({})).unwrap();
        assert_eq!(c.enabled, false);
        assert_eq!(c.endpoint, None);
        assert_eq!(c.sample_rate, 1.0);
        let out = serde_json::to_value(&c).unwrap();
        assert!(out.get("endpoint").is_none());
        assert_eq!(out["sampleRate"], 1.0);
    }

    #[test]
    fn otel_event_defaults_attributes_to_empty_object() {
        let v = serde_json::json!({ "name": "evt" });
        let e: OtelEvent = serde_json::from_value(v).unwrap();
        assert_eq!(e.attributes, serde_json::json!({}));
        let out = serde_json::to_value(&e).unwrap();
        assert_eq!(out["attributes"], serde_json::json!({}));
    }

    #[test]
    fn otel_span_round_trips() {
        let v = serde_json::json!({
            "traceId": "t1",
            "spanId": "s1",
            "parentSpanId": "p1",
            "name": "op",
            "startTime": "2024-01-01T00:00:00Z",
            "endTime": "2024-01-01T00:00:01Z",
            "events": [{"name": "e", "timestamp": "2024-01-01T00:00:00Z", "attributes": {"k": "v"}}]
        });
        let s: OtelSpan = serde_json::from_value(v.clone()).unwrap();
        assert_eq!(s.span_id, "s1");
        assert_eq!(s.events.len(), 1);
        assert_eq!(serde_json::to_value(&s).unwrap(), v);
    }
}
