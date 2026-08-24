//! Serde types for the deterministic compaction + prompt-cache planning IPC.

use crate::schema::message::Message;
use serde::{Deserialize, Serialize};

/// Effective compaction configuration (mirror of TS `CompactionConfig`).
///
/// `Default` mirrors the TS `buildConfig` defaults. The struct carries
/// `#[serde(default)]` so missing fields are filled from this `Default`.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct CompactionConfig {
    pub enabled: bool,
    pub context_length: usize,
    pub threshold: f64,
    pub target_ratio: f64,
    pub protect_first_n: usize,
    pub protect_last_n: usize,
    pub min_tail_user_messages: usize,
    pub summary_budget: usize,
    pub timeout_ms: usize,
    pub cooldown_ms: usize,
}

impl Default for CompactionConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            context_length: 0,
            threshold: 0.5,
            target_ratio: 0.2,
            protect_first_n: 3,
            protect_last_n: 2,
            min_tail_user_messages: 1,
            summary_budget: 12_000,
            timeout_ms: 60_000,
            cooldown_ms: 5_000,
        }
    }
}

impl CompactionConfig {
    /// Overlay a partial config (from a model/provider override) onto `self`.
    pub fn apply_partial(&mut self, partial: &serde_json::Value) {
        if let Some(obj) = partial.as_object() {
            if let Some(v) = obj.get("enabled").and_then(|v| v.as_bool()) {
                self.enabled = v;
            }
            if let Some(v) = obj.get("contextLength").and_then(|v| v.as_u64()) {
                self.context_length = v as usize;
            }
            if let Some(v) = obj.get("threshold").and_then(|v| v.as_f64()) {
                self.threshold = v;
            }
            if let Some(v) = obj.get("targetRatio").and_then(|v| v.as_f64()) {
                self.target_ratio = v;
            }
            if let Some(v) = obj.get("protectFirstN").and_then(|v| v.as_u64()) {
                self.protect_first_n = v as usize;
            }
            if let Some(v) = obj.get("protectLastN").and_then(|v| v.as_u64()) {
                self.protect_last_n = v as usize;
            }
            if let Some(v) = obj.get("minTailUserMessages").and_then(|v| v.as_u64()) {
                self.min_tail_user_messages = v as usize;
            }
            if let Some(v) = obj.get("summaryBudget").and_then(|v| v.as_u64()) {
                self.summary_budget = v as usize;
            }
            if let Some(v) = obj.get("timeoutMs").and_then(|v| v.as_u64()) {
                self.timeout_ms = v as usize;
            }
            if let Some(v) = obj.get("cooldownMs").and_then(|v| v.as_u64()) {
                self.cooldown_ms = v as usize;
            }
        }
    }
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CompactionRequest {
    #[serde(default)]
    pub messages: Vec<Message>,
    pub config: CompactionConfig,
    #[serde(default)]
    pub model_name: Option<String>,
    #[serde(default)]
    pub overrides: Option<serde_json::Value>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CompactionPlan {
    /// `"noop"` when compaction is disabled / below threshold / empty slice,
    /// `"compressible"` when a deterministic range is ready to summarise/truncate.
    pub status: String,
    pub before_tokens: usize,
    pub threshold_tokens: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub range: Option<CompactionRange>,
    pub compact_slice_tokens: usize,
    pub budget_tokens: usize,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CompactionRange {
    pub start: usize,
    pub end: usize,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CachePlanRequest {
    #[serde(default)]
    pub messages: Vec<Message>,
    #[serde(default)]
    pub tools: Option<Vec<serde_json::Value>>,
    pub provider: String,
    #[serde(default)]
    pub cache_ttl: Option<String>,
    #[serde(default)]
    pub static_system_prefix: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CachePlan {
    pub message_breakpoints: Vec<usize>,
    pub tool_breakpoints: Vec<usize>,
    pub breakpoint_count: usize,
    pub ttl_ms: i64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_defaults() {
        let cfg = CompactionConfig::default();
        assert!(cfg.enabled);
        assert_eq!(cfg.threshold, 0.5);
        assert_eq!(cfg.protect_first_n, 3);
        assert_eq!(cfg.summary_budget, 12_000);
    }

    #[test]
    fn config_deserializes_with_defaults_for_missing() {
        let cfg: CompactionConfig =
            serde_json::from_value(serde_json::json!({ "contextLength": 100 })).unwrap();
        assert!(cfg.enabled);
        assert_eq!(cfg.context_length, 100);
        assert_eq!(cfg.protect_last_n, 2);
    }

    #[test]
    fn request_round_trips() {
        let req: CompactionRequest = serde_json::from_value(serde_json::json!({
            "messages": [],
            "config": { "contextLength": 200, "threshold": 0.5 },
            "modelName": "test",
            "overrides": { "small": { "threshold": 0.75 } }
        }))
        .unwrap();
        assert_eq!(req.config.context_length, 200);
        assert_eq!(req.model_name.as_deref(), Some("test"));
        assert!(req.overrides.is_some());
    }
}
