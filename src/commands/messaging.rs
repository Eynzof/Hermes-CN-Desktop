//! Tauri commands for messaging gateway platform management.
//!
//! v1 exposes config/status/start/stop surfaces. Live bot connections remain in
//! the Core managed runtime; the desktop only mirrors configuration and lifecycle.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::LazyLock;
use std::sync::Mutex;
use tauri::State;

use crate::error::AppError;
use crate::state::AppState;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessagingPlatformConfig {
    pub platform: String,
    pub enabled: bool,
    pub credentials: HashMap<String, String>,
    pub webhook_url: Option<String>,
    pub webhook_secret: Option<String>,
    pub allowed_users: Vec<String>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessagingPlatformEntry {
    pub platform: String,
    pub display_name: String,
    pub enabled: bool,
    pub required_env: Vec<String>,
    pub status: String,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessagingStatus {
    pub running: bool,
    pub platforms: Vec<MessagingPlatformEntry>,
}

static MESSAGING_STATE: LazyLock<Mutex<MessagingState>> =
    LazyLock::new(|| Mutex::new(MessagingState::new()));

struct MessagingState {
    configs: HashMap<String, MessagingPlatformConfig>,
    running: bool,
}

impl MessagingState {
    fn new() -> Self {
        Self {
            configs: HashMap::new(),
            running: false,
        }
    }
}

fn platform_definitions() -> Vec<MessagingPlatformEntry> {
    vec![
        ("telegram", "Telegram", vec!["TELEGRAM_BOT_TOKEN"]),
        ("discord", "Discord", vec!["DISCORD_BOT_TOKEN"]),
        ("slack", "Slack", vec!["SLACK_BOT_TOKEN"]),
        ("whatsapp", "WhatsApp", vec!["WHATSAPP_API_TOKEN"]),
        ("signal", "Signal", vec!["SIGNAL_ACCOUNT"]),
        (
            "sms",
            "SMS (Twilio)",
            vec!["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN"],
        ),
        ("email", "Email", vec!["EMAIL_SMTP_HOST"]),
        ("matrix", "Matrix", vec!["MATRIX_ACCESS_TOKEN"]),
        ("mattermost", "Mattermost", vec!["MATTERMOST_TOKEN"]),
        ("irc", "IRC", vec!["IRC_SERVER"]),
        ("line", "LINE", vec!["LINE_CHANNEL_ACCESS_TOKEN"]),
        (
            "dingtalk",
            "DingTalk",
            vec!["DINGTALK_APP_KEY", "DINGTALK_APP_SECRET"],
        ),
        (
            "feishu",
            "Feishu / Lark",
            vec!["FEISHU_APP_ID", "FEISHU_APP_SECRET"],
        ),
        ("wecom", "WeCom", vec!["WECOM_CORP_ID", "WECOM_SECRET"]),
    ]
    .into_iter()
    .map(|(platform, display_name, required_env)| {
        let enabled = {
            let state = MESSAGING_STATE.lock();
            match state {
                Ok(s) => s.configs.get(platform).map(|c| c.enabled).unwrap_or(false),
                Err(_) => false,
            }
        };
        MessagingPlatformEntry {
            platform: platform.to_string(),
            display_name: display_name.to_string(),
            enabled,
            required_env: required_env.iter().map(|s| s.to_string()).collect(),
            status: "idle".to_string(),
        }
    })
    .collect()
}

#[tauri::command]
pub fn get_messaging_platforms(
    _state: State<'_, AppState>,
) -> Result<Vec<MessagingPlatformEntry>, AppError> {
    Ok(platform_definitions())
}

#[tauri::command]
pub fn get_messaging_status(_state: State<'_, AppState>) -> Result<MessagingStatus, AppError> {
    let running = MESSAGING_STATE
        .lock()
        .map_err(|_| AppError::StateLockPoisoned)
        .map(|s| s.running)?;
    Ok(MessagingStatus {
        running,
        platforms: platform_definitions(),
    })
}

#[tauri::command]
pub fn set_messaging_platform_config(
    config: MessagingPlatformConfig,
) -> Result<MessagingPlatformConfig, AppError> {
    let mut state = MESSAGING_STATE
        .lock()
        .map_err(|_| AppError::StateLockPoisoned)?;
    state
        .configs
        .insert(config.platform.clone(), config.clone());
    Ok(config)
}

#[tauri::command]
pub fn start_messaging_platform(platform: Option<String>) -> Result<MessagingStatus, AppError> {
    let running = {
        let mut state = MESSAGING_STATE
            .lock()
            .map_err(|_| AppError::StateLockPoisoned)?;
        if let Some(p) = platform {
            if let Some(cfg) = state.configs.get_mut(&p) {
                cfg.enabled = true;
            }
        } else {
            state.running = true;
        }
        state.running
    };
    Ok(MessagingStatus {
        running,
        platforms: platform_definitions(),
    })
}

#[tauri::command]
pub fn stop_messaging_platform(platform: Option<String>) -> Result<MessagingStatus, AppError> {
    let running = {
        let mut state = MESSAGING_STATE
            .lock()
            .map_err(|_| AppError::StateLockPoisoned)?;
        if let Some(p) = platform {
            if let Some(cfg) = state.configs.get_mut(&p) {
                cfg.enabled = false;
            }
        } else {
            state.running = false;
        }
        state.running
    };
    Ok(MessagingStatus {
        running,
        platforms: platform_definitions(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reset_state() {
        let mut state = MESSAGING_STATE.lock().expect("lock");
        state.configs.clear();
        state.running = false;
    }

    #[test]
    fn lists_all_platforms() {
        reset_state();
        let platforms = platform_definitions();
        assert!(platforms.len() >= 14);
        let names: Vec<_> = platforms.iter().map(|p| p.platform.clone()).collect();
        assert!(names.contains(&"telegram".to_string()));
        assert!(names.contains(&"wecom".to_string()));
    }

    #[test]
    fn config_roundtrip() {
        reset_state();
        let cfg = MessagingPlatformConfig {
            platform: "telegram".to_string(),
            enabled: true,
            credentials: [("token".to_string(), "secret".to_string())]
                .into_iter()
                .collect(),
            ..Default::default()
        };
        let returned = set_messaging_platform_config(cfg.clone()).unwrap();
        assert_eq!(returned.platform, "telegram");
        let state = MESSAGING_STATE.lock().expect("lock");
        assert!(state.configs.get("telegram").unwrap().enabled);
    }

    #[test]
    fn start_stop_toggles_state() {
        reset_state();
        let status = start_messaging_platform(None).unwrap();
        assert!(status.running);
        let status = stop_messaging_platform(None).unwrap();
        assert!(!status.running);
    }
}
