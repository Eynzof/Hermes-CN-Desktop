// Runtime management commands exposed to the frontend.
//
// Thin wrappers around crate::process::runtime that handle AppState access
// and dashboard restart logic.

use tauri::State;

use crate::error::AppError;

use crate::process::dashboard;
use crate::process::runtime;
use crate::state::AppState;
use std::sync::atomic::Ordering;
use tokio::task;

#[tauri::command]
pub async fn runtime_info(state: State<'_, AppState>) -> Result<runtime::RuntimeInfo, AppError> {
    let (last_error, process) = {
        let inner = state.inner.lock()?;
        let dashboard = inner.dashboard_handle.as_ref();
        let process = dashboard.map(|handle| {
            let command_line = handle.command_program.as_ref().map(|program| {
                std::iter::once(program.as_str())
                    .chain(handle.command_args.iter().map(|arg| arg.as_str()))
                    .map(shell_quote)
                    .collect::<Vec<_>>()
                    .join(" ")
            });
            runtime::RuntimeProcessInfo {
                api_base_url: inner.api_base_url.clone(),
                gateway_url: inner.gateway_url.clone(),
                hermes_home: inner.hermes_home.clone(),
                hermes_home_base: inner.hermes_home_base.clone(),
                current_profile: inner.current_profile.clone(),
                owns_process: handle.owns_process,
                pid: handle
                    .child
                    .as_ref()
                    .map(|child| child.id())
                    .or(handle.attached_pid),
                command_program: handle.command_program.clone(),
                command_args: handle.command_args.clone(),
                command_line,
                gateway_runtime_dir: handle.gateway_runtime_dir.clone(),
                gateway_lock_dir: handle.gateway_lock_dir.clone(),
                ownership_marker_path: handle.ownership_marker_path.clone(),
                ownership_state: handle.ownership_state.clone(),
                session_token_present: inner.session_token.is_some(),
                gateway_ws_relay_active: inner
                    .gateway_ws
                    .as_ref()
                    .map(|relay| !relay.abort.load(Ordering::Relaxed))
                    .unwrap_or(false),
            }
        });
        (inner.last_runtime_error.clone(), process)
    };

    let mut info = task::spawn_blocking(move || runtime::get_runtime_info(last_error))
        .await
        .map_err(|err| AppError::Internal(format!("runtime info task failed: {}", err)))?;
    info.process = process;
    Ok(info)
}

fn shell_quote(value: &str) -> String {
    if value.is_empty() {
        return "''".to_string();
    }
    if value
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '.' | '_' | '-' | ':' | '='))
    {
        return value.to_string();
    }
    format!("'{}'", value.replace('\'', "'\\''"))
}

#[tauri::command]
pub async fn runtime_check_update() -> Result<runtime::RuntimeUpdateCheckResult, AppError> {
    Ok(runtime::check_runtime_update().await)
}

/// Install a runtime update and restart the dashboard.
#[tauri::command]
pub async fn runtime_install_update(
    state: State<'_, AppState>,
) -> Result<runtime::RuntimeInstallUpdateResult, AppError> {
    let result = runtime::install_runtime_update(None).await;
    if !result.ok {
        let mut inner = state.inner.lock()?;
        inner.last_runtime_error = result.error.clone();
        return Ok(result);
    }

    // Restart dashboard after successful install
    if let Err(e) = restart_dashboard(&state).await {
        let mut inner = state.inner.lock()?;
        inner.last_runtime_error = Some(e.to_string());
        return Ok(runtime::RuntimeInstallUpdateResult {
            ok: false,
            installed: result.installed,
            previous: result.previous,
            error: Some(format!(
                "Runtime installed, but dashboard restart failed: {}",
                e
            )),
        });
    }

    {
        let mut inner = state.inner.lock()?;
        inner.last_runtime_error = None;
    }
    Ok(result)
}

#[tauri::command]
pub async fn uninstall_bundled_runtime() -> Result<(), AppError> {
    let root = runtime::runtime_root();
    let current = runtime::read_current_record();
    if let Some(record) = current {
        let version_dir = root.join("versions").join(&record.runtime_version);
        if version_dir.exists() {
            log::info!(
                "Uninstalling bundled runtime from {}",
                version_dir.display()
            );
            if let Err(e) = std::fs::remove_dir_all(&version_dir) {
                log::warn!(
                    "Failed to remove runtime directory {}: {}",
                    version_dir.display(),
                    e
                );
            }
        }
        // Clear the current record so the dashboard won't try to use this runtime.
        // Keep the versions directory intact so a reinstall can reuse the manifest.
        let versions_file = root.join("current.json");
        if versions_file.exists() {
            if let Err(e) = std::fs::remove_file(&versions_file) {
                log::warn!("Failed to remove current.json: {}", e);
            }
        }
        log::info!("Bundled runtime uninstalled successfully");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;
    use tempfile::TempDir;

    fn with_runtime_root<T>(f: impl FnOnce(&std::path::Path) -> T) -> T {
        let dir = TempDir::new().expect("tempdir");
        std::env::set_var("HERMES_DESKTOP_RUNTIME_ROOT", dir.path());
        let out = f(dir.path());
        std::env::remove_var("HERMES_DESKTOP_RUNTIME_ROOT");
        out
    }

    /// Write a minimal current.json so read_current_record() returns Some.
    fn write_current_record(root: &std::path::Path, version: &str, exe: &std::path::Path) {
        let versions_dir = root.join("versions").join(version);
        std::fs::create_dir_all(&versions_dir).unwrap();
        // Touch the executable file so version_dir.exists() is true.
        std::fs::write(exe, "fake").unwrap();
        // read_current_record validates platform/arch match current_platform() /
        // current_arch() (private fns). current_platform() returns "win32" on
        // Windows, "darwin" on macOS, "linux" on Linux.
        let platform = if cfg!(target_os = "windows") {
            "win32"
        } else if cfg!(target_os = "macos") {
            "darwin"
        } else {
            "linux"
        };
        let arch = if cfg!(target_arch = "aarch64") {
            "arm64"
        } else {
            "x64"
        };
        let record = serde_json::json!({
            "schemaVersion": 2,
            "runtimeVersion": version,
            "kernelVersion": "1.0.0",
            "runtimeFlavor": "standard",
            "runtimeRevision": 1,
            "platform": platform,
            "arch": arch,
            "path": versions_dir.to_string_lossy(),
            "executablePath": exe.to_string_lossy(),
            "source": "bundled",
            "installedAt": "2026-01-01T00:00:00.000Z",
            "sourceRepo": "/repo/hermes-agent-cn",
            "sourceCommit": "abc123",
            "localDirtyHash": null,
            "artifactSha256": null,
            "previousRuntimeVersion": null,
        });
        let current_json = root.join("current.json");
        std::fs::write(&current_json, serde_json::to_string(&record).unwrap()).unwrap();
    }

    #[test]
    #[serial]
    fn uninstall_removes_version_dir_and_current_json() {
        with_runtime_root(|root| {
            let exe_path = root.join("versions").join("1.0.0").join(if cfg!(windows) {
                "hermes.exe"
            } else {
                "hermes"
            });
            write_current_record(root, "1.0.0", &exe_path);

            // Pre-conditions
            assert!(exe_path.exists());
            assert!(root.join("current.json").exists());

            // Verify read_current_record returns Some
            let record = runtime::read_current_record();
            assert!(record.is_some(), "read_current_record must return Some");

            let rt = tokio::runtime::Runtime::new().unwrap();
            rt.block_on(uninstall_bundled_runtime()).unwrap();

            // Post-conditions: version dir gone, current.json gone
            assert!(!exe_path.exists(), "version executable should be removed");
            assert!(
                !root.join("current.json").exists(),
                "current.json should be removed"
            );
            assert!(
                !root.join("versions").join("1.0.0").exists(),
                "1.0.0 subdirectory should be removed"
            );
        });
    }

    #[test]
    #[serial]
    fn uninstall_noop_when_no_current_record() {
        with_runtime_root(|root| {
            std::fs::create_dir_all(root).unwrap();
            // No current.json — should succeed silently.
            let rt = tokio::runtime::Runtime::new().unwrap();
            rt.block_on(uninstall_bundled_runtime()).unwrap();
        });
    }

    #[test]
    #[serial]
    fn uninstall_noop_when_version_dir_missing() {
        with_runtime_root(|root| {
            // current.json exists but the version directory doesn't
            let platform = if cfg!(target_os = "windows") {
                "win32"
            } else if cfg!(target_os = "macos") {
                "darwin"
            } else {
                "linux"
            };
            let arch = if cfg!(target_arch = "aarch64") {
                "arm64"
            } else {
                "x64"
            };
            let record = serde_json::json!({
                "schemaVersion": 2,
                "runtimeVersion": "2.0.0",
                "kernelVersion": "2.0.0",
                "runtimeFlavor": "standard",
                "runtimeRevision": 1,
                "platform": platform,
                "arch": arch,
                "path": root.join("versions").join("2.0.0").to_string_lossy(),
                "executablePath": "",
                "source": "bundled",
                "installedAt": "2026-01-01T00:00:00.000Z",
                "sourceRepo": "/repo/hermes-agent-cn",
                "sourceCommit": "abc123",
                "localDirtyHash": null,
                "artifactSha256": null,
                "previousRuntimeVersion": null,
            });
            std::fs::write(
                root.join("current.json"),
                serde_json::to_string(&record).unwrap(),
            )
            .unwrap();

            let rt = tokio::runtime::Runtime::new().unwrap();
            rt.block_on(uninstall_bundled_runtime()).unwrap();

            // read_current_record returns None when the executable doesn't
            // exist, so uninstall is a no-op and current.json is untouched.
            assert!(root.join("current.json").exists());
        });
    }
}

/// Rollback runtime and restart the dashboard.
#[tauri::command]
pub async fn runtime_rollback(
    state: State<'_, AppState>,
) -> Result<runtime::RuntimeInstallUpdateResult, AppError> {
    let result = runtime::rollback_runtime();
    if !result.ok {
        let mut inner = state.inner.lock()?;
        inner.last_runtime_error = result.error.clone();
        return Ok(result);
    }

    if let Err(e) = restart_dashboard(&state).await {
        let mut inner = state.inner.lock()?;
        inner.last_runtime_error = Some(e.to_string());
        return Ok(runtime::RuntimeInstallUpdateResult {
            ok: false,
            installed: result.installed,
            previous: result.previous,
            error: Some(format!(
                "Runtime rolled back, but dashboard restart failed: {}",
                e
            )),
        });
    }

    {
        let mut inner = state.inner.lock()?;
        inner.last_runtime_error = None;
    }
    Ok(result)
}

/// Stop the current dashboard and spawn a new one.
pub(crate) async fn restart_dashboard(state: &State<'_, AppState>) -> Result<(), AppError> {
    let (host, port, hermes_home) = {
        let mut inner = state.inner.lock()?;
        // Stop existing dashboard and any live WS relay before swapping runtime.
        if let Some(relay) = inner.gateway_ws.take() {
            relay.abort.store(true, Ordering::Relaxed);
            relay.notify.notify_waiters();
        }
        let session_token = inner.session_token.clone();
        if let Some(ref mut handle) = inner.dashboard_handle {
            handle.stop_with_token(session_token.as_deref());
        }
        inner.dashboard_handle = None;

        let host =
            std::env::var("HERMES_DESKTOP_API_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
        let port = std::env::var("HERMES_DESKTOP_API_PORT")
            .ok()
            .and_then(|p| p.parse().ok())
            .unwrap_or(dashboard::DEFAULT_DESKTOP_DASHBOARD_PORT);
        (host, port, inner.hermes_home.clone())
    };

    tokio::time::sleep(std::time::Duration::from_millis(800)).await;

    let handle = dashboard::ensure_hermes_dashboard(dashboard::EnsureDashboardOptions {
        host,
        port,
        hermes_home,
        allow_external_agent: dashboard::external_agent_allowed(),
        allow_port_fallback: true,
        connection_mode: crate::connection::ConnectionMode::Managed,
        remote_base_url: None,
    })
    .await?;

    let token = match handle.session_token.clone() {
        Some(token) => Some(token),
        None => match std::env::var("HERMES_DESKTOP_SESSION_TOKEN")
            .ok()
            .or_else(|| std::env::var("HERMES_DASHBOARD_SESSION_TOKEN").ok())
        {
            Some(token) => Some(token),
            None => dashboard::fetch_session_token(&handle.api_base_url).await,
        },
    };

    let gateway_url = dashboard::build_gateway_url(&handle.api_base_url, token.as_deref());

    {
        let mut inner = state.inner.lock()?;
        inner.api_base_url = handle.api_base_url.clone();
        inner.gateway_url = gateway_url;
        inner.session_token = token;
        inner.dashboard_handle = Some(handle);
    }

    Ok(())
}
