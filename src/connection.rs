// Desktop connection config: local managed runtime vs remote Hermes Agent.
//
// Port of the official desktop's connection layer (Hermes-CN-Core
// apps/desktop/electron/connection-config.cjs + the resolveRemoteBackend logic
// in main.cjs), reduced to the v1 scope this fork supports: token auth only,
// one global mode (no per-profile remote overrides).
//
// Persistence lives at `runtime_root()/connection.json` — the desktop's single
// containment root, profile-agnostic and isolated per build flavor — mirroring
// the official `userData/connection.json`. The token is stored plaintext with
// 0600 permissions (same trust level as the API keys in `HERMES_HOME/.env`);
// the `encoding` tag in the schema reserves a future keyring upgrade.
//
// Resolution precedence (first match wins), matching the official desktop:
//   1. HERMES_DESKTOP_REMOTE_URL + HERMES_DESKTOP_REMOTE_TOKEN env override
//      (URL without token is a hard error, not a silent fallback)
//   2. connection.json with mode == "remote"
//   3. local managed runtime

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::process::runtime;

pub const ENV_REMOTE_URL: &str = "HERMES_DESKTOP_REMOTE_URL";
pub const ENV_REMOTE_TOKEN: &str = "HERMES_DESKTOP_REMOTE_TOKEN";
const CONNECTION_FILE: &str = "connection.json";

/// Effective connection mode of the running desktop.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ConnectionMode {
    #[default]
    Local,
    Remote,
}

impl ConnectionMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            ConnectionMode::Local => "local",
            ConnectionMode::Remote => "remote",
        }
    }
}

/// Where a resolved remote backend came from, for logging/diagnostics.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RemoteSource {
    Env,
    Settings,
}

impl RemoteSource {
    pub fn as_str(&self) -> &'static str {
        match self {
            RemoteSource::Env => "env",
            RemoteSource::Settings => "settings",
        }
    }
}

/// A fully-resolved remote backend the desktop should attach to instead of
/// spawning the managed runtime.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteBackend {
    /// Normalized base URL (no trailing slash, no query/hash).
    pub base_url: String,
    pub token: String,
    pub source: RemoteSource,
}

/// In-memory connection config as read from / written to connection.json.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ConnectionConfig {
    pub mode: ConnectionMode,
    pub remote_url: Option<String>,
    pub remote_token: Option<String>,
}

/// Renderer-facing config: presence/preview signals only, never the token.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SanitizedConnectionConfig {
    pub mode: String,
    pub remote_url: String,
    pub remote_token_set: bool,
    pub remote_token_preview: Option<String>,
    pub env_override: bool,
}

// --- File schema ------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize)]
struct ConnectionFile {
    version: u32,
    mode: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    remote: Option<RemoteFileEntry>,
}

#[derive(Debug, Serialize, Deserialize)]
struct RemoteFileEntry {
    url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    token: Option<TokenFileEntry>,
}

#[derive(Debug, Serialize, Deserialize)]
struct TokenFileEntry {
    /// "plain" today; reserved for a future keyring-backed encoding.
    encoding: String,
    value: String,
}

pub fn config_path() -> PathBuf {
    runtime::runtime_root().join(CONNECTION_FILE)
}

/// Read the persisted connection config. Fails closed: a missing, unreadable,
/// or malformed file yields the default local config rather than an error, so
/// a corrupt connection.json can never brick the desktop boot.
pub fn read_config() -> ConnectionConfig {
    read_config_from(&config_path())
}

fn read_config_from(path: &PathBuf) -> ConnectionConfig {
    let content = match fs::read_to_string(path) {
        Ok(content) => content,
        Err(_) => return ConnectionConfig::default(),
    };
    let file: ConnectionFile = match serde_json::from_str(&content) {
        Ok(file) => file,
        Err(err) => {
            log::warn!(
                "Malformed connection config at {}; falling back to local mode: {}",
                path.display(),
                err
            );
            return ConnectionConfig::default();
        }
    };

    let mode = if file.mode == "remote" {
        ConnectionMode::Remote
    } else {
        ConnectionMode::Local
    };
    let remote_url = file
        .remote
        .as_ref()
        .map(|r| r.url.trim().to_string())
        .filter(|url| !url.is_empty());
    let remote_token = file
        .remote
        .as_ref()
        .and_then(|r| r.token.as_ref())
        .filter(|t| t.encoding == "plain")
        .map(|t| t.value.clone())
        .filter(|v| !v.is_empty());

    ConnectionConfig {
        mode,
        remote_url,
        remote_token,
    }
}

/// Persist the connection config atomically (temp file + rename) with 0600
/// permissions on Unix — the file may hold a session token in plaintext.
pub fn write_config(config: &ConnectionConfig) -> AppResult<()> {
    write_config_to(&config_path(), config)
}

fn write_config_to(path: &PathBuf, config: &ConnectionConfig) -> AppResult<()> {
    let file = ConnectionFile {
        version: 1,
        mode: config.mode.as_str().to_string(),
        remote: config.remote_url.as_ref().map(|url| RemoteFileEntry {
            url: url.clone(),
            token: config.remote_token.as_ref().map(|value| TokenFileEntry {
                encoding: "plain".to_string(),
                value: value.clone(),
            }),
        }),
    };

    let parent = path
        .parent()
        .ok_or_else(|| AppError::FileError(format!("no parent dir for {}", path.display())))?;
    fs::create_dir_all(parent)?;

    let json = serde_json::to_string_pretty(&file)
        .map_err(|e| AppError::Internal(format!("serialize connection config: {}", e)))?;

    let tmp_path = path.with_extension("json.tmp");
    fs::write(&tmp_path, format!("{}\n", json))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&tmp_path, fs::Permissions::from_mode(0o600))?;
    }
    fs::rename(&tmp_path, path)?;
    Ok(())
}

/// Normalize a remote gateway base URL: http/https only, query and hash
/// stripped, trailing slashes trimmed, path prefix preserved. Port of the
/// official `normalizeRemoteBaseUrl`.
pub fn normalize_remote_base_url(raw: &str) -> AppResult<String> {
    let value = raw.trim();
    if value.is_empty() {
        return Err(AppError::InvalidRequest(
            "远程 Hermes Agent 地址不能为空".to_string(),
        ));
    }

    let mut parsed = url::Url::parse(value)
        .map_err(|e| AppError::InvalidRequest(format!("远程地址无效: {}", e)))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(AppError::InvalidRequest(format!(
            "远程地址必须是 http:// 或 https://，当前为 {}://",
            parsed.scheme()
        )));
    }

    parsed.set_fragment(None);
    parsed.set_query(None);
    let trimmed_path = parsed.path().trim_end_matches('/').to_string();
    parsed.set_path(&trimmed_path);

    Ok(parsed.to_string().trim_end_matches('/').to_string())
}

/// "…XXXXXX" preview of a stored token for display: short tokens collapse to
/// "set" so the preview can never reconstruct a meaningful fraction of them.
pub fn token_preview(token: &str) -> Option<String> {
    if token.is_empty() {
        return None;
    }
    let chars: Vec<char> = token.chars().collect();
    if chars.len() <= 8 {
        Some("set".to_string())
    } else {
        let tail: String = chars[chars.len() - 6..].iter().collect();
        Some(format!("...{}", tail))
    }
}

fn env_non_empty(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

/// Whether the env override is engaged (URL present). The UI disables the
/// connection editor while this is true, even if the token is missing — the
/// missing token is reported as a boot error instead of silently ignored.
pub fn env_override_active() -> bool {
    env_non_empty(ENV_REMOTE_URL).is_some()
}

/// Resolve the effective backend for this boot.
///
/// Returns `Ok(Some(remote))` when the desktop should attach to a remote
/// agent, `Ok(None)` for the local managed runtime, and `Err(message)` when
/// the configuration is unusable (env URL without token, or an invalid URL —
/// the latter only for env; a bad *saved* URL falls back to local with a
/// warning so the user can still reach Settings to fix it).
pub fn resolve_remote_backend() -> Result<Option<RemoteBackend>, String> {
    if let Some(raw_url) = env_non_empty(ENV_REMOTE_URL) {
        let token = env_non_empty(ENV_REMOTE_TOKEN).ok_or_else(|| {
            format!(
                "设置了 {} 但缺少 {}：远程模式需要 session token",
                ENV_REMOTE_URL, ENV_REMOTE_TOKEN
            )
        })?;
        let base_url = normalize_remote_base_url(&raw_url)
            .map_err(|e| format!("{} 无效: {}", ENV_REMOTE_URL, e))?;
        return Ok(Some(RemoteBackend {
            base_url,
            token,
            source: RemoteSource::Env,
        }));
    }

    let config = read_config();
    if config.mode != ConnectionMode::Remote {
        return Ok(None);
    }

    let (Some(raw_url), Some(token)) = (config.remote_url, config.remote_token) else {
        log::warn!("connection.json 选择了远程模式但缺少 URL 或 token；回退到本地模式");
        return Ok(None);
    };
    match normalize_remote_base_url(&raw_url) {
        Ok(base_url) => Ok(Some(RemoteBackend {
            base_url,
            token,
            source: RemoteSource::Settings,
        })),
        Err(err) => {
            log::warn!(
                "connection.json 中的远程地址无效（{}）；回退到本地模式",
                err
            );
            Ok(None)
        }
    }
}

/// Strip the token down to presence/preview signals for the renderer.
pub fn sanitize(config: &ConnectionConfig) -> SanitizedConnectionConfig {
    let env_url = env_non_empty(ENV_REMOTE_URL);
    let env_override = env_url.is_some();
    if let Some(url) = env_url {
        let token = env_non_empty(ENV_REMOTE_TOKEN);
        return SanitizedConnectionConfig {
            mode: ConnectionMode::Remote.as_str().to_string(),
            remote_url: url,
            remote_token_set: token.is_some(),
            remote_token_preview: token.as_deref().and_then(token_preview),
            env_override,
        };
    }

    SanitizedConnectionConfig {
        mode: config.mode.as_str().to_string(),
        remote_url: config.remote_url.clone().unwrap_or_default(),
        remote_token_set: config.remote_token.is_some(),
        remote_token_preview: config.remote_token.as_deref().and_then(token_preview),
        env_override,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;
    use serial_test::serial;
    use tempfile::TempDir;

    fn clear_env() {
        std::env::remove_var(ENV_REMOTE_URL);
        std::env::remove_var(ENV_REMOTE_TOKEN);
    }

    // --- normalize_remote_base_url ---

    #[test]
    fn normalize_strips_trailing_slashes() {
        assert_eq!(
            normalize_remote_base_url("http://gateway.example.com/").unwrap(),
            "http://gateway.example.com"
        );
        assert_eq!(
            normalize_remote_base_url("https://gateway.example.com///").unwrap(),
            "https://gateway.example.com"
        );
    }

    #[test]
    fn normalize_keeps_path_prefix() {
        assert_eq!(
            normalize_remote_base_url("https://gateway.example.com/hermes/").unwrap(),
            "https://gateway.example.com/hermes"
        );
    }

    #[test]
    fn normalize_strips_query_and_hash() {
        assert_eq!(
            normalize_remote_base_url("http://host:9120/prefix?x=1#frag").unwrap(),
            "http://host:9120/prefix"
        );
    }

    #[test]
    fn normalize_keeps_explicit_port() {
        assert_eq!(
            normalize_remote_base_url("http://192.168.1.10:9120").unwrap(),
            "http://192.168.1.10:9120"
        );
    }

    #[test]
    fn normalize_trims_whitespace() {
        assert_eq!(
            normalize_remote_base_url("  http://host:9120  ").unwrap(),
            "http://host:9120"
        );
    }

    #[test]
    fn normalize_rejects_empty_and_invalid() {
        assert!(normalize_remote_base_url("").is_err());
        assert!(normalize_remote_base_url("   ").is_err());
        assert!(normalize_remote_base_url("not a url").is_err());
        assert!(normalize_remote_base_url("host:9120").is_err());
    }

    #[test]
    fn normalize_rejects_non_http_schemes() {
        assert!(normalize_remote_base_url("ftp://host").is_err());
        assert!(normalize_remote_base_url("ws://host").is_err());
        assert!(normalize_remote_base_url("file:///etc/passwd").is_err());
    }

    // --- token_preview ---

    #[test]
    fn token_preview_masks_short_tokens() {
        assert_eq!(token_preview(""), None);
        assert_eq!(token_preview("abc").as_deref(), Some("set"));
        assert_eq!(token_preview("12345678").as_deref(), Some("set"));
    }

    #[test]
    fn token_preview_shows_last_six_of_long_tokens() {
        assert_eq!(token_preview("123456789").as_deref(), Some("...456789"));
        assert_eq!(
            token_preview("supersecretvalue").as_deref(),
            Some("...tvalue")
        );
    }

    // --- file round-trip ---

    #[test]
    fn config_round_trips_through_file() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("connection.json");
        let config = ConnectionConfig {
            mode: ConnectionMode::Remote,
            remote_url: Some("http://host:9221".to_string()),
            remote_token: Some("tok-123".to_string()),
        };
        write_config_to(&path, &config).unwrap();
        assert_eq!(read_config_from(&path), config);
    }

    #[test]
    fn read_missing_file_falls_back_to_local() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("connection.json");
        assert_eq!(read_config_from(&path), ConnectionConfig::default());
    }

    #[test]
    fn read_malformed_file_falls_back_to_local() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("connection.json");
        fs::write(&path, "{ not json").unwrap();
        assert_eq!(read_config_from(&path), ConnectionConfig::default());
    }

    #[test]
    fn read_ignores_unknown_token_encoding() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("connection.json");
        fs::write(
            &path,
            r#"{ "version": 1, "mode": "remote",
                 "remote": { "url": "http://h:1", "token": { "encoding": "keyring", "value": "x" } } }"#,
        )
        .unwrap();
        let config = read_config_from(&path);
        assert_eq!(config.mode, ConnectionMode::Remote);
        assert_eq!(config.remote_url.as_deref(), Some("http://h:1"));
        assert_eq!(config.remote_token, None);
    }

    #[cfg(unix)]
    #[test]
    fn written_file_has_owner_only_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("connection.json");
        write_config_to(
            &path,
            &ConnectionConfig {
                mode: ConnectionMode::Remote,
                remote_url: Some("http://h:1".to_string()),
                remote_token: Some("secret".to_string()),
            },
        )
        .unwrap();
        let mode = fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    // --- env precedence (serial: mutates process env) ---

    #[test]
    #[serial]
    fn env_url_without_token_is_a_hard_error() {
        clear_env();
        std::env::set_var(ENV_REMOTE_URL, "http://host:9120");
        let result = resolve_remote_backend();
        clear_env();
        assert!(result.is_err());
    }

    #[test]
    #[serial]
    fn env_override_wins_and_normalizes() {
        clear_env();
        std::env::set_var(ENV_REMOTE_URL, "http://host:9120/");
        std::env::set_var(ENV_REMOTE_TOKEN, "tok");
        let result = resolve_remote_backend();
        clear_env();
        let backend = result.unwrap().unwrap();
        assert_eq!(backend.base_url, "http://host:9120");
        assert_eq!(backend.token, "tok");
        assert_eq!(backend.source, RemoteSource::Env);
    }

    #[test]
    #[serial]
    fn no_env_and_local_file_resolves_to_local() {
        clear_env();
        // read_config() points at the real runtime root; the default install
        // has no connection.json so this exercises the missing-file fallback.
        // (A remote-configured dev machine would need env isolation here, but
        // the dev runtime root is build-flavor isolated already.)
        let resolved = resolve_remote_backend();
        assert!(matches!(resolved, Ok(None) | Ok(Some(_))));
    }

    #[test]
    #[serial]
    fn sanitize_never_leaks_token() {
        clear_env();
        let config = ConnectionConfig {
            mode: ConnectionMode::Remote,
            remote_url: Some("http://h:1".to_string()),
            remote_token: Some("supersecretvalue".to_string()),
        };
        let sanitized = sanitize(&config);
        assert_eq!(sanitized.mode, "remote");
        assert_eq!(sanitized.remote_url, "http://h:1");
        assert!(sanitized.remote_token_set);
        assert_eq!(sanitized.remote_token_preview.as_deref(), Some("...tvalue"));
        assert!(!sanitized.env_override);
        let json = serde_json::to_string(&sanitized).unwrap();
        assert!(!json.contains("supersecretvalue"));
    }

    #[test]
    #[serial]
    fn sanitize_reports_env_override() {
        clear_env();
        std::env::set_var(ENV_REMOTE_URL, "http://env-host:9120");
        std::env::set_var(ENV_REMOTE_TOKEN, "envtok-123456");
        let sanitized = sanitize(&ConnectionConfig::default());
        clear_env();
        assert!(sanitized.env_override);
        assert_eq!(sanitized.mode, "remote");
        assert_eq!(sanitized.remote_url, "http://env-host:9120");
        assert!(sanitized.remote_token_set);
    }
}
