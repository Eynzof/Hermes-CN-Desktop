//! Tolerant serde helpers mirroring the `@hermes/protocol` Zod nullish/default
//! helpers (`NullishString`, `.nullish()`, `.default()`, `.passthrough()`).
//!
//! `Option<T>` + `#[serde(default)]` already collapses an explicit JSON `null`
//! and a missing key into `None`; the helpers here add the non-zero defaults and
//! the stringify/normalization logic that Zod's `.transform()` layers perform.

use serde_json::Value;

/// A null-ish string: returns `Some(s)` for a JSON string, `None` for
/// `null`/missing/non-string. Mirrors `NullishString` parsing.
pub fn nullish_string(value: &Value) -> Option<String> {
    match value {
        Value::String(s) => Some(s.clone()),
        _ => None,
    }
}

/// A null-ish integer: returns `Some(i)` for a JSON number that fits i64,
/// `None` otherwise.
pub fn nullish_i64(value: &Value) -> Option<i64> {
    value.as_i64()
}

/// Mirror of the TS `asString` helper in `session-log.ts`: a JSON `String` is
/// returned unwrapped; `null`/missing is `None`; any other value is
/// `JSON.stringify`-ed (with a `to_string()` fallback that can never fail for a
/// `serde_json::Value` but keeps the shape of the TS try/catch).
pub fn stringify_value(value: &Value) -> Option<String> {
    match value {
        Value::String(s) => Some(s.clone()),
        Value::Null => None,
        other => Some(serde_json::to_string(other).unwrap_or_else(|_| other.to_string())),
    }
}

/// `{}` for `serde_json::Value` fields whose Zod default is `z.record(z.unknown()).default({})`.
pub fn default_empty_object() -> Value {
    serde_json::json!({})
}

/// `z.boolean().default(true)`.
/// Serde `skip_serializing_if` helper: omit a bool when it equals the `true` default.
pub fn is_default_true(b: &bool) -> bool {
    *b
}

pub fn default_true() -> bool {
    true
}

/// `z.boolean().default(false)`.
pub fn default_false() -> bool {
    false
}

/// `StateDbQueryRequest.readonly` default.
pub fn default_readonly() -> bool {
    true
}

/// `WakeFeedInput.sampleRate` default (16 kHz mono).
pub fn default_sample_rate() -> usize {
    16000
}

/// `WakeWordConfig.sensitivity` default.
pub fn default_sensitivity() -> f64 {
    0.6
}

/// `WakeWordConfig.confirmationFrames` default.
pub fn default_confirmation_frames() -> usize {
    3
}

/// `WakeWordConfig.surface` default.
pub fn default_surface() -> String {
    "auto".to_string()
}

/// `WakeWordConfig.capture` default.
pub fn default_capture() -> String {
    "auto".to_string()
}

/// `WakeWordConfig.provider` default.
pub fn default_provider() -> String {
    "sherpa".to_string()
}

/// `WakeWordConfig.phrase` default.
pub fn default_phrase() -> String {
    "hey hermes".to_string()
}

/// `TelemetryConfig.sampleRate` default.
pub fn default_sample_rate_f64() -> f64 {
    1.0
}

/// `AcpSessionState.mode` default.
pub fn default_acp_mode() -> String {
    "default".to_string()
}

/// `SecretImport.source` default.
pub fn default_secret_source() -> String {
    "env".to_string()
}

/// `McpServerConfig.enabled` default.
pub fn default_enabled() -> bool {
    true
}

/// `ChatCompletionChoice.finish_reason` default.
pub fn default_finish_reason() -> Option<String> {
    Some("stop".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nullish_string_handles_null_missing_and_non_string() {
        assert_eq!(
            nullish_string(&serde_json::json!("hi")),
            Some("hi".to_string())
        );
        assert_eq!(nullish_string(&serde_json::Value::Null), None);
        assert_eq!(nullish_string(&serde_json::json!(123)), None);
    }

    #[test]
    fn stringify_value_matches_ts_as_string() {
        // Strings are returned unwrapped (no JSON quotes).
        assert_eq!(
            stringify_value(&serde_json::json!("hi")),
            Some("hi".to_string())
        );
        // Non-strings are JSON-stringified.
        assert_eq!(
            stringify_value(&serde_json::json!(123)),
            Some("123".to_string())
        );
        assert_eq!(
            stringify_value(&serde_json::json!({"a": 1})),
            Some("{\"a\":1}".to_string())
        );
        assert_eq!(stringify_value(&serde_json::Value::Null), None);
    }

    #[test]
    fn defaults_are_usable() {
        assert!(default_readonly());
        assert_eq!(default_sample_rate(), 16000);
        assert_eq!(default_sample_rate_f64(), 1.0);
        assert_eq!(default_acp_mode(), "default");
        assert_eq!(default_secret_source(), "env");
        assert_eq!(default_finish_reason().as_deref(), Some("stop"));
        assert_eq!(default_empty_object(), serde_json::json!({}));
    }
}
