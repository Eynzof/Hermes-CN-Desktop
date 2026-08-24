//! Serde mirrors of the `@hermes/browser` schema types.
//!
//! These mirror `packages/browser/src/schemas.ts` (zod). They are the IPC-boundary
//! types only; zod remains the TS runtime authority for tool-arg validation. The
//! existing `commands/browser.rs::BrowserToolResult` is the production IPC result
//! type and is re-exported here rather than duplicated.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

/// Browser backend kinds (mirrors `schemas.ts::BrowserBackendKind`).
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum BrowserBackendKind {
    #[default]
    Local,
    Cdp,
    Browserbase,
    BrowserUse,
    Firecrawl,
    Camofox,
    Lightpanda,
    AgentBrowser,
}

/// Browser engine (mirrors `schemas.ts::BrowserConfig.engine`).
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum BrowserEngine {
    #[default]
    Chromium,
    Lightpanda,
}

/// Dialog policy (mirrors `schemas.ts::BrowserConfig.dialogPolicy`).
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum DialogPolicy {
    #[default]
    AutoDismiss,
    MustRespond,
    AutoAccept,
}

/// Camofox options (mirrors `schemas.ts::BrowserConfig.camofox`).
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct BrowserCamofoxConfig {
    pub url: Option<String>,
    pub managed_persistence: bool,
}

fn default_command_timeout() -> u32 {
    30
}

fn default_inactivity_timeout() -> u32 {
    300
}

fn default_dialog_timeout_s() -> u32 {
    30
}

fn default_auto_local_for_private_urls() -> bool {
    true
}

fn default_last_active_at() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Browser configuration (mirrors `schemas.ts::BrowserConfig`).
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct BrowserConfig {
    #[serde(default)]
    pub backend: BrowserBackendKind,
    #[serde(default)]
    pub cloud_provider: Option<String>,
    #[serde(default)]
    pub cdp_url: Option<String>,
    #[serde(default = "default_command_timeout")]
    pub command_timeout: u32,
    #[serde(default)]
    pub headed: bool,
    #[serde(default)]
    pub record_sessions: bool,
    #[serde(default = "default_inactivity_timeout")]
    pub inactivity_timeout: u32,
    #[serde(default)]
    pub engine: BrowserEngine,
    #[serde(default = "default_auto_local_for_private_urls")]
    pub auto_local_for_private_urls: bool,
    #[serde(default)]
    pub allow_private_urls: bool,
    #[serde(default)]
    pub dialog_policy: DialogPolicy,
    #[serde(default = "default_dialog_timeout_s")]
    pub dialog_timeout_s: u32,
    #[serde(default)]
    pub camofox: BrowserCamofoxConfig,
}

/// Browser session record (mirrors `schemas.ts::BrowserSessionRecord`).
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct BrowserSessionRecord {
    #[serde(default)]
    pub task_id: String,
    #[serde(default)]
    pub backend: BrowserBackendKind,
    #[serde(default)]
    pub session_name: Option<String>,
    #[serde(default)]
    pub bb_session_id: Option<String>,
    #[serde(default)]
    pub cdp_url: Option<String>,
    #[serde(default)]
    pub expires_at: Option<String>,
    #[serde(default)]
    pub features: HashMap<String, serde_json::Value>,
    #[serde(default)]
    pub external_call_id: Option<String>,
    #[serde(default = "default_last_active_at")]
    pub last_active_at: i64,
}

/// Reuse the production IPC result type from `commands/browser.rs`.
pub use crate::commands::browser::BrowserToolResult;

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    #[test]
    fn browser_config_uses_ts_defaults_when_fields_missing() {
        let config: BrowserConfig = serde_json::from_value(serde_json::json!({})).unwrap();
        assert_eq!(config.backend, BrowserBackendKind::Local);
        assert_eq!(config.command_timeout, 30);
        assert_eq!(config.inactivity_timeout, 300);
        assert_eq!(config.engine, BrowserEngine::Chromium);
        assert!(config.auto_local_for_private_urls);
        assert!(!config.allow_private_urls);
        assert_eq!(config.dialog_policy, DialogPolicy::AutoDismiss);
        assert_eq!(config.dialog_timeout_s, 30);
    }

    #[test]
    fn browser_config_camel_case_round_trips() {
        let json = serde_json::json!({
            "backend": "browser-use",
            "cdpUrl": "ws://127.0.0.1:9222",
            "commandTimeout": 60,
            "headed": true,
            "recordSessions": true,
            "inactivityTimeout": 10,
            "engine": "lightpanda",
            "autoLocalForPrivateUrls": false,
            "allowPrivateUrls": true,
            "dialogPolicy": "must-respond",
            "dialogTimeoutS": 5,
            "camofox": { "url": "https://camofox", "managedPersistence": true }
        });
        let config: BrowserConfig = serde_json::from_value(json).unwrap();
        assert_eq!(config.backend, BrowserBackendKind::BrowserUse);
        assert_eq!(config.cdp_url.as_deref(), Some("ws://127.0.0.1:9222"));
        assert_eq!(config.command_timeout, 60);
        assert!(config.headed);
        assert!(config.record_sessions);
        assert_eq!(config.inactivity_timeout, 10);
        assert_eq!(config.engine, BrowserEngine::Lightpanda);
        assert!(!config.auto_local_for_private_urls);
        assert!(config.allow_private_urls);
        assert_eq!(config.dialog_policy, DialogPolicy::MustRespond);
        assert_eq!(config.dialog_timeout_s, 5);
        assert_eq!(config.camofox.url.as_deref(), Some("https://camofox"));
        assert!(config.camofox.managed_persistence);
    }

    #[test]
    fn browser_session_record_round_trips() {
        let json = serde_json::json!({
            "taskId": "t1",
            "backend": "cdp",
            "sessionName": "s1",
            "bbSessionId": "bb1",
            "cdpUrl": "ws://127.0.0.1:9222",
            "features": { "k": 1 },
            "externalCallId": "ext",
            "lastActiveAt": 1700000000000i64
        });
        let record: BrowserSessionRecord = serde_json::from_value(json).unwrap();
        assert_eq!(record.task_id, "t1");
        assert_eq!(record.backend, BrowserBackendKind::Cdp);
        assert_eq!(record.session_name.as_deref(), Some("s1"));
        assert_eq!(record.bb_session_id.as_deref(), Some("bb1"));
        assert_eq!(record.cdp_url.as_deref(), Some("ws://127.0.0.1:9222"));
        assert_eq!(record.features.get("k"), Some(&serde_json::json!(1)));
        assert_eq!(record.external_call_id.as_deref(), Some("ext"));
        assert_eq!(record.last_active_at, 1700000000000);
    }
}
