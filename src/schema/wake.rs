//! Serde mirror of `@hermes/protocol/src/wake.ts` for the wake-word command
//! boundary.
//!
//! Wire shapes are `camelCase` (`clientCapture`, `sampleRate`, `frameLength`,
//! `confirmationFrames`, `startNewSession`).

use serde::{Deserialize, Serialize};

use crate::schema::util;

/// Wake-word config mirror of `WakeWordConfigSchema` (used by `wake_start`).
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WakeWordConfig {
    #[serde(default = "util::default_false")]
    pub enabled: bool,
    #[serde(default = "util::default_surface")]
    pub surface: String,
    #[serde(default = "util::default_capture")]
    pub capture: String,
    #[serde(default = "util::default_provider")]
    pub provider: String,
    #[serde(default = "util::default_phrase")]
    pub phrase: String,
    #[serde(default = "util::default_sensitivity")]
    pub sensitivity: f64,
    #[serde(default = "util::default_confirmation_frames")]
    pub confirmation_frames: usize,
    #[serde(default = "util::default_true")]
    pub start_new_session: bool,
}

/// Mirror of `WakeDetectedEventSchema`.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WakeDetectedEvent {
    pub phrase: String,
    #[serde(default)]
    pub profile: Option<String>,
    pub start_new_session: bool,
}

/// `wake_start` input.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WakeStartInput {
    pub surface: String,
    #[serde(default)]
    pub client_capture: bool,
    #[serde(default)]
    pub persist: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config: Option<WakeWordConfig>,
}

/// `wake_stop` input.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WakeStopInput {
    #[serde(default)]
    pub persist: bool,
}

/// `wake_feed` input.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WakeFeedInput {
    pub pcm: String,
    #[serde(default = "util::default_sample_rate")]
    pub sample_rate: usize,
}

/// `wake_feed` result.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WakeFeedResult {
    pub fed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detected: Option<WakeDetectedEvent>,
}

/// `wake_frame_info` result.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WakeFrameInfoResult {
    pub sample_rate: usize,
    pub frame_length: usize,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wake_word_config_round_trips_camel_case() {
        let v = serde_json::json!({
            "enabled": true,
            "surface": "gui",
            "capture": "auto",
            "provider": "sherpa",
            "phrase": "hey hermes",
            "sensitivity": 0.7,
            "confirmationFrames": 3,
            "startNewSession": true
        });
        let c: WakeWordConfig = serde_json::from_value(v.clone()).unwrap();
        assert_eq!(c.confirmation_frames, 3);
        assert_eq!(c.sensitivity, 0.7);
        assert_eq!(serde_json::to_value(&c).unwrap(), v);
    }

    #[test]
    fn wake_word_config_defaults() {
        let c: WakeWordConfig = serde_json::from_value(serde_json::json!({})).unwrap();
        assert!(!c.enabled);
        assert_eq!(c.surface, "auto");
        assert_eq!(c.provider, "sherpa");
        assert_eq!(c.phrase, "hey hermes");
        assert_eq!(c.sensitivity, 0.6);
        assert_eq!(c.confirmation_frames, 3);
        assert!(c.start_new_session);
    }

    #[test]
    fn wake_start_input_round_trips_camel_case() {
        let v = serde_json::json!({
            "surface": "gui",
            "clientCapture": true,
            "persist": false,
            "config": {
                "enabled": false,
                "surface": "auto",
                "capture": "auto",
                "provider": "sherpa",
                "phrase": "hey hermes",
                "sensitivity": 0.6,
                "confirmationFrames": 3,
                "startNewSession": true
            }
        });
        let input: WakeStartInput = serde_json::from_value(v.clone()).unwrap();
        assert_eq!(input.surface, "gui");
        assert!(input.client_capture);
        assert!(input.config.is_some());
        assert_eq!(serde_json::to_value(&input).unwrap(), v);
    }

    #[test]
    fn wake_start_input_defaults() {
        let input: WakeStartInput = serde_json::from_value(serde_json::json!({
            "surface": "gui"
        }))
        .unwrap();
        assert!(!input.client_capture);
        assert!(!input.persist);
        assert!(input.config.is_none());
    }

    #[test]
    fn wake_feed_input_defaults_sample_rate() {
        let input: WakeFeedInput =
            serde_json::from_value(serde_json::json!({ "pcm": "AA==" })).unwrap();
        assert_eq!(input.sample_rate, 16000);
        let out = serde_json::to_value(&input).unwrap();
        assert_eq!(out["sampleRate"], 16000);
    }

    #[test]
    fn wake_detected_event_round_trips() {
        let v =
            serde_json::json!({ "phrase": "hey hermes", "profile": null, "startNewSession": true });
        let e: WakeDetectedEvent = serde_json::from_value(v.clone()).unwrap();
        assert_eq!(e.profile, None);
        assert_eq!(serde_json::to_value(&e).unwrap(), v);
    }

    #[test]
    fn wake_feed_result_omits_optional_fields() {
        let r = WakeFeedResult {
            fed: true,
            reason: None,
            detected: None,
        };
        let out = serde_json::to_value(&r).unwrap();
        assert!(out.get("reason").is_none());
        assert!(out.get("detected").is_none());
        assert_eq!(out["fed"], true);
    }

    #[test]
    fn wake_frame_info_result_round_trips() {
        let v = serde_json::json!({ "sampleRate": 16000, "frameLength": 1280 });
        let r: WakeFrameInfoResult = serde_json::from_value(v.clone()).unwrap();
        assert_eq!(r.sample_rate, 16000);
        assert_eq!(serde_json::to_value(&r).unwrap(), v);
    }
}
