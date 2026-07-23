//! Desktop-wide bootstrap and managed-runtime intent.
//!
//! This state deliberately lives beside `connection.json`, not inside
//! HERMES_HOME. It controls the desktop shell itself and must survive profile
//! switches as well as managed-runtime uninstall/reinstall cycles.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::connection;
use crate::error::{AppError, AppResult};
use crate::process::runtime;

const CONTROL_FILE: &str = "desktop-control.json";
const CONTROL_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GuideState {
    Pending,
    Deferred,
    Completed,
}

impl GuideState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Deferred => "deferred",
            Self::Completed => "completed",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ManagedRuntimeDesiredState {
    Running,
    Stopped,
    Uninstalled,
}

impl ManagedRuntimeDesiredState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Stopped => "stopped",
            Self::Uninstalled => "uninstalled",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopControlState {
    pub schema_version: u32,
    pub guide_state: GuideState,
    pub managed_runtime_desired_state: ManagedRuntimeDesiredState,
}

impl DesktopControlState {
    fn fresh_install() -> Self {
        Self {
            schema_version: CONTROL_SCHEMA_VERSION,
            guide_state: GuideState::Pending,
            // A clean install must let /guide choose the backend before the
            // bundled runtime is extracted or launched.
            managed_runtime_desired_state: if crate::build_flavor::is_shell() {
                ManagedRuntimeDesiredState::Uninstalled
            } else {
                ManagedRuntimeDesiredState::Stopped
            },
        }
    }

    fn migrated_existing_install() -> Self {
        Self {
            schema_version: CONTROL_SCHEMA_VERSION,
            guide_state: GuideState::Completed,
            managed_runtime_desired_state: if crate::build_flavor::is_shell() {
                ManagedRuntimeDesiredState::Uninstalled
            } else {
                ManagedRuntimeDesiredState::Running
            },
        }
    }

    fn for_build(mut self) -> Self {
        if crate::build_flavor::is_shell() {
            self.managed_runtime_desired_state = ManagedRuntimeDesiredState::Uninstalled;
        }
        self
    }
}

pub fn control_path() -> PathBuf {
    runtime::runtime_root().join(CONTROL_FILE)
}

fn read_from(path: &Path) -> Option<DesktopControlState> {
    let raw = fs::read_to_string(path).ok()?;
    let state = serde_json::from_str::<DesktopControlState>(&raw).ok()?;
    (state.schema_version == CONTROL_SCHEMA_VERSION).then_some(state)
}

fn write_to(path: &Path, state: &DesktopControlState) -> AppResult<()> {
    let parent = path
        .parent()
        .ok_or_else(|| AppError::FileError(format!("no parent dir for {}", path.display())))?;
    fs::create_dir_all(parent)?;
    let json = serde_json::to_string_pretty(state)
        .map_err(|e| AppError::Internal(format!("serialize desktop control: {}", e)))?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, format!("{}\n", json))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600))?;
    }
    fs::rename(tmp, path)?;
    Ok(())
}

/// Initialize the v1 control file without interrupting existing users. A
/// pre-existing runtime, saved connection config, or remote env override is an
/// established installation and therefore skips the first-install guide.
pub fn initialize() -> AppResult<DesktopControlState> {
    let path = control_path();
    if let Some(state) = read_from(&path) {
        return Ok(state.for_build());
    }
    let established = runtime::read_current_record().is_some()
        || connection::config_path().is_file()
        || connection::env_override_active();
    let state = if established {
        DesktopControlState::migrated_existing_install()
    } else {
        DesktopControlState::fresh_install()
    };
    write_to(&path, &state)?;
    Ok(state)
}

pub fn read() -> DesktopControlState {
    read_from(&control_path())
        .map(DesktopControlState::for_build)
        .unwrap_or_else(|| {
            if runtime::read_current_record().is_some()
                || connection::config_path().is_file()
                || connection::env_override_active()
            {
                DesktopControlState::migrated_existing_install()
            } else {
                DesktopControlState::fresh_install()
            }
        })
}

pub fn write(state: &DesktopControlState) -> AppResult<()> {
    write_to(&control_path(), state)
}

pub fn set_guide_state(guide_state: GuideState) -> AppResult<DesktopControlState> {
    let mut state = read();
    state.guide_state = guide_state;
    write(&state)?;
    Ok(state)
}

pub fn set_managed_runtime_desired_state(
    desired: ManagedRuntimeDesiredState,
) -> AppResult<DesktopControlState> {
    if crate::build_flavor::is_shell() && desired != ManagedRuntimeDesiredState::Uninstalled {
        crate::build_flavor::require_managed_runtime("修改内置内核状态")?;
    }
    let mut state = read();
    state.managed_runtime_desired_state = desired;
    write(&state)?;
    Ok(state)
}

/// Decide whether bootstrap may install/start the managed runtime. Dev mode's
/// explicit external-dashboard escape hatch keeps its existing behavior; a
/// real first install stays offline until the guide records `running` intent.
pub fn should_start_managed_runtime(
    state: &DesktopControlState,
    external_dev_dashboard: bool,
) -> bool {
    !crate::build_flavor::is_shell()
        && (external_dev_dashboard
            || state.managed_runtime_desired_state == ManagedRuntimeDesiredState::Running)
}

/// Report the actual managed-runtime lifecycle from files/process state.
/// Desired state is intent only: when no valid runtime record exists, the
/// runtime is uninstalled even if a previous control file still says stopped
/// or running.
pub fn managed_runtime_lifecycle_state(installed: bool, running: bool) -> &'static str {
    if running {
        "running"
    } else if installed {
        "stopped"
    } else {
        "uninstalled"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;
    use tempfile::TempDir;

    #[test]
    #[serial]
    fn clean_install_starts_in_pending_stopped_state() {
        let root = TempDir::new().expect("tempdir");
        std::env::set_var("HERMES_DESKTOP_RUNTIME_ROOT", root.path());
        let state = initialize().expect("initialize");
        assert_eq!(state.guide_state, GuideState::Pending);
        let expected = if crate::build_flavor::is_shell() {
            ManagedRuntimeDesiredState::Uninstalled
        } else {
            ManagedRuntimeDesiredState::Stopped
        };
        assert_eq!(state.managed_runtime_desired_state, expected);
        assert!(control_path().is_file());
        assert!(!should_start_managed_runtime(&state, false));
        assert_eq!(
            should_start_managed_runtime(&state, true),
            !crate::build_flavor::is_shell()
        );
        std::env::remove_var("HERMES_DESKTOP_RUNTIME_ROOT");
    }

    #[test]
    #[serial]
    fn saved_connection_migrates_existing_user_without_forced_guide() {
        let root = TempDir::new().expect("tempdir");
        std::env::set_var("HERMES_DESKTOP_RUNTIME_ROOT", root.path());
        connection::write_config(&connection::ConnectionConfig::default())
            .expect("write connection config");
        let state = initialize().expect("initialize");
        assert_eq!(state.guide_state, GuideState::Completed);
        let expected = if crate::build_flavor::is_shell() {
            ManagedRuntimeDesiredState::Uninstalled
        } else {
            ManagedRuntimeDesiredState::Running
        };
        assert_eq!(state.managed_runtime_desired_state, expected);
        assert_eq!(
            should_start_managed_runtime(&state, false),
            !crate::build_flavor::is_shell()
        );
        std::env::remove_var("HERMES_DESKTOP_RUNTIME_ROOT");
    }

    #[test]
    #[serial]
    fn guide_and_runtime_intent_round_trip() {
        let root = TempDir::new().expect("tempdir");
        std::env::set_var("HERMES_DESKTOP_RUNTIME_ROOT", root.path());
        initialize().expect("initialize");
        set_guide_state(GuideState::Deferred).expect("defer guide");
        set_managed_runtime_desired_state(ManagedRuntimeDesiredState::Uninstalled)
            .expect("set desired state");
        let state = read();
        assert_eq!(state.guide_state, GuideState::Deferred);
        assert_eq!(
            state.managed_runtime_desired_state,
            ManagedRuntimeDesiredState::Uninstalled
        );
        std::env::remove_var("HERMES_DESKTOP_RUNTIME_ROOT");
    }

    #[test]
    fn lifecycle_uses_actual_installation_before_desired_intent() {
        assert_eq!(managed_runtime_lifecycle_state(false, false), "uninstalled");
        assert_eq!(managed_runtime_lifecycle_state(true, false), "stopped");
        assert_eq!(managed_runtime_lifecycle_state(true, true), "running");
    }
}
