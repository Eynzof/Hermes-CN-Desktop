//! User-configurable update download source (`update-config.json`).
//!
//! One JSON file in the desktop data directory (`runtime_root()`, i.e. the
//! same anchor as the managed runtime tree) controls where the unified
//! self-update flow downloads from:
//!
//! ```json
//! {
//!   "schemaVersion": 1,
//!   "channel": "stable",
//!   "releaseManifestUrl": "https://desktop.hermesagent.org.cn/latest.json",
//!   "runtimeBaseUrl": "https://desktop.hermesagent.org.cn/runtime",
//!   "runtimeManifestUrl": "",
//!   "runtimePublicKeyPem": "",
//!   "timeoutSeconds": 10,
//!   "verifySha256": true,
//!   "verifySignature": true,
//!   "mirrors": []
//! }
//! ```
//!
//! Cascade (highest → lowest):
//!   1. `update-config.json` (file, optional; missing/corrupt → defaults +
//!      `configError` surfaced via `get_update_config`, never blocks startup)
//!   2. Runtime env `HERMES_UPDATE_*` (new, aligned with the existing
//!      `HERMES_RUNTIME_UPDATE_*` overrides)
//!   3. Compile-time baked defaults
//!   4. Hardcoded fallbacks in [`UpdateConfig::default`]

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub const UPDATE_CONFIG_SCHEMA_VERSION: u32 = 1;
pub const DEFAULT_RELEASE_MANIFEST_URL: &str = "https://desktop.hermesagent.org.cn/latest.json";
pub const DEFAULT_RUNTIME_BASE_URL: &str = "https://desktop.hermesagent.org.cn/runtime";
pub const DEFAULT_CHANNEL: &str = "stable";
pub const DEFAULT_TIMEOUT_SECONDS: u64 = 10;
const UPDATE_CONFIG_FILE: &str = "update-config.json";
const ALLOWED_CHANNELS: &[&str] = &["stable", "beta", "canary"];
const MIN_TIMEOUT_SECONDS: u64 = 1;
const MAX_TIMEOUT_SECONDS: u64 = 300;

/// A mirror entry shown in the settings UI. Only the two URL fields are
/// functionally used today; mirrors exist so users can flip the whole source
/// with one click in a later iteration.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateMirror {
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub release_manifest_url: String,
    #[serde(default)]
    pub runtime_base_url: String,
}

/// The persisted, user-editable update source configuration.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct UpdateConfig {
    pub schema_version: u32,
    pub channel: String,
    pub release_manifest_url: String,
    pub runtime_base_url: String,
    pub runtime_manifest_url: String,
    pub runtime_public_key_pem: String,
    pub timeout_seconds: u64,
    pub verify_sha256: bool,
    pub verify_signature: bool,
    pub mirrors: Vec<UpdateMirror>,
}

impl Default for UpdateConfig {
    fn default() -> Self {
        Self {
            schema_version: UPDATE_CONFIG_SCHEMA_VERSION,
            channel: DEFAULT_CHANNEL.to_string(),
            release_manifest_url: DEFAULT_RELEASE_MANIFEST_URL.to_string(),
            runtime_base_url: DEFAULT_RUNTIME_BASE_URL.to_string(),
            runtime_manifest_url: String::new(),
            runtime_public_key_pem: String::new(),
            timeout_seconds: DEFAULT_TIMEOUT_SECONDS,
            verify_sha256: true,
            verify_signature: true,
            mirrors: Vec::new(),
        }
    }
}

/// Result of loading the config file: always yields a usable [`UpdateConfig`]
/// (falling back to defaults), plus an optional human-readable `config_error`
/// when the file was missing/corrupt so the UI can warn without blocking.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateConfigLoad {
    pub config: UpdateConfig,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config_error: Option<String>,
}

impl UpdateConfigLoad {
    pub fn ok(config: UpdateConfig) -> Self {
        Self {
            config,
            config_error: None,
        }
    }

    pub fn with_error(config: UpdateConfig, config_error: String) -> Self {
        Self {
            config,
            config_error: Some(config_error),
        }
    }
}

/// Path of the update config file — anchored inside the desktop data root so
/// it travels with the runtime tree (portable mode included) and is easy to
/// override in tests via `HERMES_DESKTOP_RUNTIME_ROOT`.
pub fn update_config_path() -> PathBuf {
    crate::process::runtime::runtime_root().join(UPDATE_CONFIG_FILE)
}

fn read_env_trimmed(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

/// Apply the `HERMES_UPDATE_*` env overrides on top of a base config. The file
/// value always wins over baked defaults, and env over the file — matching the
/// documented cascade.
pub fn apply_env_overrides(base: &UpdateConfig) -> UpdateConfig {
    let mut cfg = base.clone();
    if let Some(v) = read_env_trimmed("HERMES_UPDATE_CHANNEL") {
        cfg.channel = v;
    }
    if let Some(v) = read_env_trimmed("HERMES_UPDATE_RELEASE_MANIFEST_URL") {
        cfg.release_manifest_url = v;
    }
    if let Some(v) = read_env_trimmed("HERMES_UPDATE_RUNTIME_BASE_URL") {
        cfg.runtime_base_url = v;
    }
    if let Some(v) = read_env_trimmed("HERMES_UPDATE_RUNTIME_MANIFEST_URL") {
        cfg.runtime_manifest_url = v;
    }
    if let Some(v) = read_env_trimmed("HERMES_UPDATE_RUNTIME_PUBLIC_KEY_PEM") {
        cfg.runtime_public_key_pem = v;
    }
    if let Some(v) = read_env_trimmed("HERMES_UPDATE_TIMEOUT_SECONDS") {
        if let Ok(secs) = v.parse::<u64>() {
            cfg.timeout_seconds = secs.clamp(MIN_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS);
        }
    }
    if let Some(v) = read_env_trimmed("HERMES_UPDATE_VERIFY_SHA256") {
        cfg.verify_sha256 = v == "1" || v.eq_ignore_ascii_case("true");
    }
    if let Some(v) = read_env_trimmed("HERMES_UPDATE_VERIFY_SIGNATURE") {
        cfg.verify_signature = v == "1" || v.eq_ignore_ascii_case("true");
    }
    cfg
}

/// Load the config file (defaults on missing/corrupt) and apply env overrides.
pub fn load() -> UpdateConfigLoad {
    load_from(&update_config_path())
}

/// Testable core of [`load`]: parse `path`, fall back to defaults, then apply
/// env overrides.
pub fn load_from(path: &Path) -> UpdateConfigLoad {
    let (config, config_error) = match fs::read_to_string(path) {
        Ok(text) => match serde_json::from_str::<UpdateConfig>(&text) {
            Ok(config) => (config, None),
            Err(e) => (
                UpdateConfig::default(),
                Some(format!("update-config.json 解析失败，已回退默认值：{}", e)),
            ),
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => (UpdateConfig::default(), None),
        Err(e) => (
            UpdateConfig::default(),
            Some(format!("update-config.json 读取失败，已回退默认值：{}", e)),
        ),
    };
    let config = apply_env_overrides(&config);
    UpdateConfigLoad {
        config,
        config_error,
    }
}

/// Load the config for *consumers* (e.g. [`crate::process::runtime`]):
/// `None` when the file is missing or unparsable, so callers fall through to
/// the legacy env/baked cascade unchanged. `Some(config)` (with `HERMES_UPDATE_*`
/// env overrides applied) otherwise. This keeps the whole codebase non-breaking:
/// until a user actually writes `update-config.json`, every existing source
/// resolution behaves exactly as before.
pub fn load_optional() -> Option<UpdateConfig> {
    let path = update_config_path();
    let text = fs::read_to_string(&path).ok()?;
    let config = serde_json::from_str::<UpdateConfig>(&text).ok()?;
    Some(apply_env_overrides(&config))
}

/// Validate a config before persisting it. Returns a human-readable error when
/// any field violates the security/format rules (https URLs, channel
/// whitelist, timeout bounds).
pub fn validate(config: &UpdateConfig) -> Result<(), String> {
    if !ALLOWED_CHANNELS.contains(&config.channel.as_str()) {
        return Err(format!(
            "channel 必须是 {} 之一，当前是 {}",
            ALLOWED_CHANNELS.join(" / "),
            config.channel
        ));
    }
    validate_https_optional(&config.release_manifest_url, "releaseManifestUrl")?;
    validate_https_optional(&config.runtime_base_url, "runtimeBaseUrl")?;
    validate_https_optional(&config.runtime_manifest_url, "runtimeManifestUrl")?;
    if !(MIN_TIMEOUT_SECONDS..=MAX_TIMEOUT_SECONDS).contains(&config.timeout_seconds) {
        return Err(format!(
            "timeoutSeconds 必须在 {MIN_TIMEOUT_SECONDS}–{MAX_TIMEOUT_SECONDS} 秒之间，当前是 {}",
            config.timeout_seconds
        ));
    }
    for (idx, mirror) in config.mirrors.iter().enumerate() {
        validate_https_optional(
            &mirror.release_manifest_url,
            &format!("mirrors[{}].releaseManifestUrl", idx),
        )?;
        validate_https_optional(
            &mirror.runtime_base_url,
            &format!("mirrors[{}].runtimeBaseUrl", idx),
        )?;
    }
    Ok(())
}

fn validate_https_optional(value: &str, label: &str) -> Result<(), String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Ok(());
    }
    match url::Url::parse(trimmed) {
        Ok(u) if u.scheme() == "https" => Ok(()),
        Ok(u) => Err(format!("{label} 必须是 https 地址，当前是 {}", u.scheme())),
        Err(e) => Err(format!("{label} 不是有效 URL：{}", e)),
    }
}

/// Atomically persist the config: write a temp sibling then rename over the
/// target so a crash mid-write never leaves a corrupt file.
pub fn save(config: &UpdateConfig) -> Result<PathBuf, String> {
    save_to(&update_config_path(), config)
}

/// Testable core of [`save`].
pub fn save_to(path: &Path, config: &UpdateConfig) -> Result<PathBuf, String> {
    validate(config)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("无法创建配置目录 {}：{}", parent.display(), e))?;
    }
    let tmp = path.with_extension("json.tmp");
    let body =
        serde_json::to_string_pretty(config).map_err(|e| format!("配置序列化失败：{}", e))?;
    fs::write(&tmp, format!("{}\n", body)).map_err(|e| format!("配置写入失败：{}", e))?;
    fs::rename(&tmp, path).map_err(|e| format!("配置原子替换失败：{}", e))?;
    Ok(path.to_path_buf())
}

/// Snapshot returned to the renderer by `get_update_config`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateConfigSnapshot {
    pub ok: bool,
    pub config: UpdateConfig,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config_error: Option<String>,
    pub effective_release_manifest_url: String,
    pub effective_runtime_manifest_url: Option<String>,
    pub effective_runtime_public_key_pem: Option<String>,
}

fn snapshot(load: &UpdateConfigLoad) -> UpdateConfigSnapshot {
    let cfg = &load.config;
    UpdateConfigSnapshot {
        ok: true,
        config: cfg.clone(),
        path: update_config_path().to_string_lossy().to_string(),
        config_error: load.config_error.clone(),
        effective_release_manifest_url: cfg.release_manifest_url.clone(),
        effective_runtime_manifest_url: if cfg.runtime_manifest_url.trim().is_empty() {
            None
        } else {
            Some(cfg.runtime_manifest_url.clone())
        },
        effective_runtime_public_key_pem: if cfg.runtime_public_key_pem.trim().is_empty() {
            None
        } else {
            Some("[configured]".to_string())
        },
    }
}

#[tauri::command]
pub fn get_update_config() -> UpdateConfigSnapshot {
    let load = load();
    snapshot(&load)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetUpdateConfigInput {
    pub config: UpdateConfig,
}

#[tauri::command]
pub fn set_update_config(input: SetUpdateConfigInput) -> Result<UpdateConfigSnapshot, String> {
    let mut config = input.config;
    config.schema_version = UPDATE_CONFIG_SCHEMA_VERSION;
    save(&config)?;
    let load = UpdateConfigLoad::ok(apply_env_overrides(&config));
    Ok(snapshot(&load))
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;
    use tempfile::TempDir;

    fn write_config(dir: &TempDir, json: &str) -> PathBuf {
        let path = dir.path().join(UPDATE_CONFIG_FILE);
        std::fs::write(&path, json).unwrap();
        path
    }

    #[test]
    fn defaults_are_cn_server_urls_and_stable_channel() {
        let cfg = UpdateConfig::default();
        assert_eq!(cfg.schema_version, 1);
        assert_eq!(cfg.channel, "stable");
        assert_eq!(cfg.release_manifest_url, DEFAULT_RELEASE_MANIFEST_URL);
        assert_eq!(cfg.runtime_base_url, DEFAULT_RUNTIME_BASE_URL);
        assert_eq!(cfg.timeout_seconds, 10);
        assert!(cfg.verify_sha256);
        assert!(cfg.verify_signature);
    }

    #[serial_test::serial]
    #[test]
    fn missing_file_falls_back_to_defaults_without_error() {
        let dir = TempDir::new().unwrap();
        let load = load_from(&dir.path().join("nope.json"));
        assert!(load.config_error.is_none());
        assert_eq!(load.config, UpdateConfig::default());
    }

    #[serial_test::serial]
    #[test]
    fn corrupt_file_falls_back_with_config_error() {
        let dir = TempDir::new().unwrap();
        let path = write_config(&dir, "{ not json");
        let load = load_from(&path);
        assert!(load.config_error.is_some());
        assert!(load.config_error.as_deref().unwrap().contains("解析失败"));
        assert_eq!(load.config, UpdateConfig::default());
    }

    #[serial_test::serial]
    #[test]
    fn parses_user_config_values() {
        let dir = TempDir::new().unwrap();
        let path = write_config(
            &dir,
            r#"{
              "schemaVersion": 1,
              "channel": "beta",
              "releaseManifestUrl": "https://example.com/latest.json",
              "runtimeBaseUrl": "https://example.com/runtime",
              "runtimeManifestUrl": "https://example.com/runtime/beta-win32-x64.json",
              "timeoutSeconds": 20,
              "verifySignature": false
            }"#,
        );
        let load = load_from(&path);
        assert!(load.config_error.is_none());
        assert_eq!(load.config.channel, "beta");
        assert_eq!(
            load.config.release_manifest_url,
            "https://example.com/latest.json"
        );
        assert_eq!(
            load.config.runtime_manifest_url,
            "https://example.com/runtime/beta-win32-x64.json"
        );
        assert_eq!(load.config.timeout_seconds, 20);
        assert!(!load.config.verify_signature);
    }

    #[test]
    #[serial_test::serial]
    fn env_overrides_file_values() {
        let dir = TempDir::new().unwrap();
        let path = write_config(
            &dir,
            r#"{"channel":"stable","releaseManifestUrl":"https://file.example/latest.json"}"#,
        );
        std::env::set_var(
            "HERMES_UPDATE_RELEASE_MANIFEST_URL",
            "https://env.example/latest.json",
        );
        let load = load_from(&path);
        std::env::remove_var("HERMES_UPDATE_RELEASE_MANIFEST_URL");
        assert_eq!(
            load.config.release_manifest_url,
            "https://env.example/latest.json"
        );
        // Non-env fields still come from the file.
        assert_eq!(load.config.channel, "stable");
    }

    #[test]
    fn validation_rejects_http_urls() {
        let cfg = UpdateConfig {
            release_manifest_url: "http://insecure.example/latest.json".to_string(),
            ..UpdateConfig::default()
        };
        let err = validate(&cfg).unwrap_err();
        assert!(err.contains("https"), "{}", err);
    }

    #[test]
    fn validation_rejects_unknown_channel() {
        let cfg = UpdateConfig {
            channel: "nightly".to_string(),
            ..UpdateConfig::default()
        };
        let err = validate(&cfg).unwrap_err();
        assert!(err.contains("channel"), "{}", err);
    }

    #[test]
    fn validation_rejects_out_of_bounds_timeout() {
        let cfg = UpdateConfig {
            timeout_seconds: 9999,
            ..UpdateConfig::default()
        };
        let err = validate(&cfg).unwrap_err();
        assert!(err.contains("timeoutSeconds"), "{}", err);
        let cfg_zero = UpdateConfig {
            timeout_seconds: 0,
            ..UpdateConfig::default()
        };
        assert!(validate(&cfg_zero).is_err());
    }

    #[serial_test::serial]
    #[test]
    fn save_writes_atomically_and_loads_back() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("sub").join(UPDATE_CONFIG_FILE);
        let cfg = UpdateConfig {
            channel: "canary".to_string(),
            release_manifest_url: "https://mirror.example/latest.json".to_string(),
            ..UpdateConfig::default()
        };
        save_to(&path, &cfg).unwrap();
        assert!(path.is_file());
        // No stray temp file left behind.
        assert!(!path.with_extension("json.tmp").exists());
        let load = load_from(&path);
        assert_eq!(load.config, cfg);
    }

    #[serial_test::serial]
    #[test]
    fn save_rejects_invalid_config_before_writing() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join(UPDATE_CONFIG_FILE);
        let cfg = UpdateConfig {
            channel: "nope".to_string(),
            ..UpdateConfig::default()
        };
        assert!(save_to(&path, &cfg).is_err());
        assert!(!path.exists());
    }
}
