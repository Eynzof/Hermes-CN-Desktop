// Profile switching command.
//
// Replaces the switchProfile IPC handler at
// hermes-cn-ui-v1/apps/desktop/src/main/main.ts lines 669-794.
//
// Stops the current dashboard, spawns a new one pointing at the target
// profile's HERMES_HOME, and handles failure recovery (fall back to the
// previous profile if the new one fails to boot).

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::error::AppError;

use crate::process::dashboard;
use crate::state::AppState;

static PROFILE_NAME_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$").expect("valid profile name regex")
});

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SwitchProfileInput {
    pub name: String,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SwitchProfileResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_base_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gateway_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hermes_home: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recovered_previous_profile: Option<bool>,
}

fn profile_hermes_home(base: &str, profile: &str) -> PathBuf {
    if profile == "default" {
        PathBuf::from(base)
    } else {
        Path::new(base).join("profiles").join(profile)
    }
}

fn active_profile_sticky_path(base: &str) -> PathBuf {
    Path::new(base).join("active_profile")
}

fn write_active_profile_sticky(base: &str, profile: &str) {
    let path = active_profile_sticky_path(base);
    if profile == "default" {
        let _ = fs::remove_file(&path);
    } else {
        let _ = fs::write(&path, profile);
    }
}

pub fn read_active_profile_sticky(base: &str) -> String {
    let path = active_profile_sticky_path(base);
    match fs::read_to_string(&path) {
        Ok(content) => {
            let trimmed = content.trim().to_string();
            if trimmed.is_empty() {
                "default".to_string()
            } else {
                trimmed
            }
        }
        Err(_) => "default".to_string(),
    }
}

fn host_and_port() -> (String, u16) {
    let host = std::env::var("HERMES_DESKTOP_API_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let port = std::env::var("HERMES_DESKTOP_API_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(dashboard::DEFAULT_DESKTOP_DASHBOARD_PORT);
    (host, port)
}

fn is_valid_profile_name(name: &str) -> bool {
    PROFILE_NAME_RE.is_match(name)
}

#[tauri::command]
pub async fn switch_profile(
    input: SwitchProfileInput,
    state: State<'_, AppState>,
) -> Result<SwitchProfileResult, AppError> {
    let name = input.name.trim().to_string();

    if !is_valid_profile_name(&name) {
        return Ok(SwitchProfileResult {
            ok: false,
            error: Some(format!("Invalid profile name: {}", name)),
            ..Default::default()
        });
    }

    // Check preconditions
    let (base, current_profile, _owns_process, previous_home) = {
        let inner = state.inner.lock()?;

        if !inner
            .dashboard_handle
            .as_ref()
            .map(|h| h.owns_process)
            .unwrap_or(false)
        {
            return Ok(SwitchProfileResult {
                ok: false,
                error: Some("Desktop is not the dashboard owner".to_string()),
                ..Default::default()
            });
        }

        if inner.switch_profile_in_flight {
            return Ok(SwitchProfileResult {
                ok: false,
                error: Some("Another profile switch is in progress".to_string()),
                ..Default::default()
            });
        }

        if name == inner.current_profile {
            return Ok(SwitchProfileResult {
                ok: true,
                profile_name: Some(inner.current_profile.clone()),
                api_base_url: Some(inner.api_base_url.clone()),
                gateway_url: Some(inner.gateway_url.clone()),
                session_token: inner.session_token.clone(),
                hermes_home: Some(inner.hermes_home.clone()),
                ..Default::default()
            });
        }

        (
            inner.hermes_home_base.clone(),
            inner.current_profile.clone(),
            true,
            inner.hermes_home.clone(),
        )
    };

    let new_home = profile_hermes_home(&base, &name);
    if name != "default" && !new_home.exists() {
        return Ok(SwitchProfileResult {
            ok: false,
            error: Some(format!("Profile directory missing: {}", new_home.display())),
            ..Default::default()
        });
    }

    // Set in-flight flag
    {
        let mut inner = state.inner.lock()?;
        inner.switch_profile_in_flight = true;
    }

    let result = do_switch_profile(
        &state,
        &name,
        &new_home.to_string_lossy(),
        &base,
        &current_profile,
        &previous_home,
    )
    .await;

    // Clear in-flight flag
    {
        let mut inner = state.inner.lock()?;
        inner.switch_profile_in_flight = false;
    }

    Ok(result)
}

async fn do_switch_profile(
    state: &State<'_, AppState>,
    name: &str,
    new_home: &str,
    base: &str,
    previous_profile: &str,
    previous_home: &str,
) -> SwitchProfileResult {
    let (host, port) = host_and_port();

    // 1. Stop existing dashboard
    {
        let mut inner = match state.inner.lock() {
            Ok(i) => i,
            Err(e) => {
                return SwitchProfileResult {
                    ok: false,
                    error: Some(e.to_string()),
                    ..Default::default()
                }
            }
        };
        if let Some(stop) = inner.gateway_sse_stop.take() {
            stop.store(true, Ordering::Relaxed);
        }
        let session_token = inner.session_token.clone();
        if let Some(ref mut handle) = inner.dashboard_handle {
            handle.stop_with_token(session_token.as_deref());
        }
        inner.dashboard_handle = None;
    }

    tokio::time::sleep(std::time::Duration::from_millis(800)).await;

    // 2. Spawn new dashboard
    let handle = match dashboard::ensure_hermes_dashboard(dashboard::EnsureDashboardOptions {
        host: host.clone(),
        port,
        hermes_home: new_home.to_string(),
        allow_external_agent: dashboard::external_agent_allowed(),
        allow_port_fallback: true,
    })
    .await
    {
        Ok(h) => h,
        Err(e) => {
            // Recovery: try to respawn previous profile's dashboard
            log::error!("Failed to start dashboard for {}: {}", name, e);
            match try_recover_previous(state, &host, port, previous_home).await {
                Ok(_) => {
                    return SwitchProfileResult {
                        ok: false,
                        error: Some(format!("切换到 {} 失败：{}", name, e)),
                        recovered_previous_profile: Some(true),
                        ..Default::default()
                    };
                }
                Err(re) => {
                    return SwitchProfileResult {
                        ok: false,
                        error: Some(format!(
                            "切换失败 ({})；恢复 {} 也失败 ({})。重启桌面端。",
                            e, previous_profile, re
                        )),
                        recovered_previous_profile: Some(false),
                        ..Default::default()
                    };
                }
            }
        }
    };

    // 3. Fetch fresh token and update state
    let env_token = std::env::var("HERMES_DESKTOP_SESSION_TOKEN").ok();
    let token = match env_token {
        Some(t) => Some(t),
        None => dashboard::fetch_session_token(&handle.api_base_url).await,
    };
    let gateway_url = dashboard::build_gateway_url(&handle.api_base_url, token.as_deref());
    let api_base_url = handle.api_base_url.clone();

    {
        let mut inner = match state.inner.lock() {
            Ok(i) => i,
            Err(e) => {
                return SwitchProfileResult {
                    ok: false,
                    error: Some(e.to_string()),
                    ..Default::default()
                }
            }
        };
        inner.api_base_url = handle.api_base_url.clone();
        inner.gateway_url = gateway_url.clone();
        inner.session_token = token.clone();
        inner.hermes_home = new_home.to_string();
        inner.current_profile = name.to_string();
        inner.dashboard_handle = Some(handle);
    }

    // Write sticky file
    write_active_profile_sticky(base, name);

    SwitchProfileResult {
        ok: true,
        profile_name: Some(name.to_string()),
        api_base_url: Some(api_base_url),
        gateway_url: Some(gateway_url),
        session_token: token,
        hermes_home: Some(new_home.to_string()),
        error: None,
        recovered_previous_profile: None,
    }
}

async fn try_recover_previous(
    state: &State<'_, AppState>,
    host: &str,
    port: u16,
    previous_home: &str,
) -> Result<(), AppError> {
    let handle = dashboard::ensure_hermes_dashboard(dashboard::EnsureDashboardOptions {
        host: host.to_string(),
        port,
        hermes_home: previous_home.to_string(),
        allow_external_agent: dashboard::external_agent_allowed(),
        allow_port_fallback: true,
    })
    .await?;

    let env_token = std::env::var("HERMES_DESKTOP_SESSION_TOKEN").ok();
    let token = match env_token {
        Some(t) => Some(t),
        None => dashboard::fetch_session_token(&handle.api_base_url).await,
    };
    let gateway_url = dashboard::build_gateway_url(&handle.api_base_url, token.as_deref());

    let mut inner = state.inner.lock()?;
    inner.api_base_url = handle.api_base_url.clone();
    inner.gateway_url = gateway_url;
    inner.session_token = token;
    inner.dashboard_handle = Some(handle);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;
    use tempfile::TempDir;

    // -------- profile_hermes_home --------

    #[test]
    fn profile_home_default_returns_base_unchanged() {
        let p = profile_hermes_home("/tmp/base", "default");
        assert_eq!(p, PathBuf::from("/tmp/base"));
    }

    #[test]
    fn profile_home_non_default_nested_under_profiles() {
        let p = profile_hermes_home("/tmp/base", "alpha");
        assert_eq!(p, PathBuf::from("/tmp/base").join("profiles").join("alpha"));
    }

    // -------- is_valid_profile_name --------

    #[test]
    fn valid_profile_names_accepted() {
        assert!(is_valid_profile_name("default"));
        assert!(is_valid_profile_name("my-profile"));
        assert!(is_valid_profile_name("test_2"));
        assert!(is_valid_profile_name("A"));
        assert!(is_valid_profile_name("z9"));
    }

    #[test]
    fn invalid_profile_names_rejected() {
        // Empty
        assert!(!is_valid_profile_name(""));
        // Path separators / traversal
        assert!(!is_valid_profile_name("a/b"));
        assert!(!is_valid_profile_name(".."));
        assert!(!is_valid_profile_name("../etc"));
        // Special chars
        assert!(!is_valid_profile_name("a b"));
        assert!(!is_valid_profile_name("a:b"));
        assert!(!is_valid_profile_name("a.b"));
        // Cannot start with hyphen / underscore
        assert!(!is_valid_profile_name("-leading-hyphen"));
        assert!(!is_valid_profile_name("_leading-underscore"));
        // Too long (>32 chars)
        assert!(!is_valid_profile_name(&"a".repeat(33)));
    }

    #[test]
    fn profile_name_length_boundary() {
        // 32 chars exactly is the max — regex is {0,31} after first char = 32 total
        assert!(is_valid_profile_name(&"a".repeat(32)));
        assert!(!is_valid_profile_name(&"a".repeat(33)));
    }

    // -------- read / write active_profile sticky --------

    #[test]
    fn read_active_profile_defaults_when_file_missing() {
        let dir = TempDir::new().unwrap();
        assert_eq!(
            read_active_profile_sticky(dir.path().to_str().unwrap()),
            "default"
        );
    }

    #[test]
    fn write_then_read_sticky_roundtrip() {
        let dir = TempDir::new().unwrap();
        let base = dir.path().to_str().unwrap();
        write_active_profile_sticky(base, "myprofile");
        assert_eq!(read_active_profile_sticky(base), "myprofile");
    }

    #[test]
    fn write_default_removes_sticky_file() {
        let dir = TempDir::new().unwrap();
        let base = dir.path().to_str().unwrap();
        write_active_profile_sticky(base, "alpha");
        assert!(dir.path().join("active_profile").exists());
        write_active_profile_sticky(base, "default");
        assert!(!dir.path().join("active_profile").exists());
        assert_eq!(read_active_profile_sticky(base), "default");
    }

    #[test]
    fn read_trims_whitespace_in_sticky_file() {
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join("active_profile"), "  beta\n").unwrap();
        assert_eq!(
            read_active_profile_sticky(dir.path().to_str().unwrap()),
            "beta"
        );
    }

    #[test]
    fn read_returns_default_when_sticky_is_blank() {
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join("active_profile"), "   ").unwrap();
        assert_eq!(
            read_active_profile_sticky(dir.path().to_str().unwrap()),
            "default"
        );
    }
}
