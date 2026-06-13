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
use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands::restart::{self, RespawnOutcome};
use crate::error::AppError;
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

        // Profiles are HERMES_HOME-scoped local state; a remote Hermes Agent
        // owns its own home. (The owns_process check below would also catch
        // this, but with a misleading "not the owner" message.)
        if inner.connection_mode == crate::connection::ConnectionMode::Remote {
            return Ok(SwitchProfileResult {
                ok: false,
                error: Some("当前连接的是远程 Hermes Agent，不支持切换 Profile".to_string()),
                ..Default::default()
            });
        }

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

    // Claim the shared dashboard-restart guard (atomic check-and-set) so a
    // profile switch and a YOLO toggle can't race two restarts.
    if !restart::try_begin_restart(&state)? {
        return Ok(SwitchProfileResult {
            ok: false,
            error: Some("运行时正在切换中，请稍后再试".to_string()),
            ..Default::default()
        });
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

    restart::end_restart(&state);

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
    let (host, port) = restart::host_and_port();

    // Stop the current dashboard and respawn against the target profile's home,
    // falling back to the previous profile's home if the target fails to boot.
    let respawn =
        match restart::respawn_managed_dashboard(state, &host, port, new_home, previous_home).await
        {
            Ok(r) => r,
            Err(e) => {
                return SwitchProfileResult {
                    ok: false,
                    error: Some(e.to_string()),
                    ..Default::default()
                }
            }
        };

    match respawn.outcome {
        RespawnOutcome::Spawned => {
            // respawn already adopted the new connection + hermes_home; record
            // the profile-specific state and persist the sticky default.
            if let Ok(mut inner) = state.inner.lock() {
                inner.current_profile = name.to_string();
            }
            write_active_profile_sticky(base, name);
            SwitchProfileResult {
                ok: true,
                profile_name: Some(name.to_string()),
                api_base_url: respawn.api_base_url,
                gateway_url: respawn.gateway_url,
                session_token: respawn.session_token,
                hermes_home: Some(new_home.to_string()),
                error: None,
                recovered_previous_profile: None,
            }
        }
        RespawnOutcome::Recovered { error } => SwitchProfileResult {
            ok: false,
            error: Some(format!("切换到 {name} 失败：{error}")),
            recovered_previous_profile: Some(true),
            ..Default::default()
        },
        RespawnOutcome::Down {
            error,
            recovery_error,
        } => SwitchProfileResult {
            ok: false,
            error: Some(format!(
                "切换失败 ({error})；恢复 {previous_profile} 也失败 ({recovery_error})。重启桌面端。"
            )),
            recovered_previous_profile: Some(false),
            ..Default::default()
        },
    }
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
