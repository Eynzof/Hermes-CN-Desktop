// Runtime management commands exposed to the frontend.
//
// Thin wrappers around crate::process::runtime that handle AppState access
// and dashboard restart logic.

use serde::{Deserialize, Serialize};
use tauri::{Manager, State};

use crate::commands::restart;
use crate::connection::ConnectionMode;
use crate::desktop_control::{self, GuideState, ManagedRuntimeDesiredState};
use crate::error::AppError;

use crate::process::dashboard;
use crate::process::runtime;
use crate::state::AppState;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::task;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeControlResult {
    pub ok: bool,
    pub guide_state: String,
    pub desired_state: String,
    pub lifecycle_state: String,
    pub installed: bool,
    pub running: bool,
    pub backend_ready: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetGuideStateInput {
    pub guide_state: String,
}

#[tauri::command]
pub async fn runtime_info(state: State<'_, AppState>) -> Result<runtime::RuntimeInfo, AppError> {
    let (last_error, process, managed_running) = {
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
        let managed_running = inner.connection_mode == ConnectionMode::Managed
            && inner
                .dashboard_handle
                .as_ref()
                .is_some_and(|handle| handle.owns_process);
        (inner.last_runtime_error.clone(), process, managed_running)
    };

    let mut info = task::spawn_blocking(move || runtime::get_runtime_info(last_error))
        .await
        .map_err(|err| AppError::Internal(format!("runtime info task failed: {}", err)))?;
    info.process = process;
    if managed_running {
        info.managed_runtime_lifecycle_state = "running".to_string();
    }
    Ok(info)
}

fn runtime_control_snapshot(
    state: &State<'_, AppState>,
    error: Option<String>,
) -> Result<RuntimeControlResult, AppError> {
    let control = desktop_control::read();
    let installed = runtime::read_current_record().is_some();
    let (running, backend_ready) = {
        let inner = state.inner.lock()?;
        (
            inner.connection_mode == ConnectionMode::Managed
                && inner
                    .dashboard_handle
                    .as_ref()
                    .is_some_and(|handle| handle.owns_process),
            inner.dashboard_handle.is_some() && !inner.api_base_url.trim().is_empty(),
        )
    };
    let lifecycle_state = desktop_control::managed_runtime_lifecycle_state(installed, running);
    Ok(RuntimeControlResult {
        ok: error.is_none(),
        guide_state: control.guide_state.as_str().to_string(),
        desired_state: control.managed_runtime_desired_state.as_str().to_string(),
        lifecycle_state: lifecycle_state.to_string(),
        installed,
        running,
        backend_ready,
        error,
    })
}

#[tauri::command]
pub fn get_desktop_control_state(
    state: State<'_, AppState>,
) -> Result<RuntimeControlResult, AppError> {
    runtime_control_snapshot(&state, None)
}

#[tauri::command]
pub fn set_guide_state(
    input: SetGuideStateInput,
    state: State<'_, AppState>,
) -> Result<RuntimeControlResult, AppError> {
    let guide_state = match input.guide_state.as_str() {
        "pending" => GuideState::Pending,
        "deferred" => GuideState::Deferred,
        "completed" => GuideState::Completed,
        other => {
            return Err(AppError::InvalidRequest(format!(
                "未知的引导状态: {}",
                other
            )))
        }
    };
    desktop_control::set_guide_state(guide_state)?;
    runtime_control_snapshot(&state, None)
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
    {
        let inner = state.inner.lock()?;
        crate::connection::require_managed_mode(inner.connection_mode, "Runtime 更新")?;
    }
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

fn validate_current_runtime_containment(root: &Path) -> Result<(), AppError> {
    let current_path = root.join("current.json");
    if !current_path.exists() {
        return Ok(());
    }
    let record = runtime::read_current_record().ok_or_else(|| {
        AppError::RuntimeUnavailable(
            "current.json 无法解析或指向无效内核，已拒绝自动删除".to_string(),
        )
    })?;
    let versions = root.join("versions");
    let canonical_versions = versions
        .canonicalize()
        .map_err(|e| AppError::FileError(format!("无法校验 runtime versions 目录: {}", e)))?;
    let canonical_runtime = PathBuf::from(&record.path)
        .canonicalize()
        .map_err(|e| AppError::FileError(format!("无法校验当前 runtime 目录: {}", e)))?;
    let canonical_executable = PathBuf::from(&record.executable_path)
        .canonicalize()
        .map_err(|e| AppError::FileError(format!("无法校验 runtime 可执行文件: {}", e)))?;
    if !canonical_runtime.starts_with(&canonical_versions)
        || !canonical_executable.starts_with(&canonical_runtime)
    {
        return Err(AppError::OriginViolation(format!(
            "runtime 路径不在受管目录内: {}",
            canonical_runtime.display()
        )));
    }
    Ok(())
}

#[derive(Debug)]
struct UninstallPayloadOutcome {
    cleanup_error: Option<String>,
}

fn uninstall_runtime_payload(root: &Path) -> Result<UninstallPayloadOutcome, AppError> {
    uninstall_runtime_payload_with(root, |path| std::fs::remove_dir_all(path))
}

fn uninstall_runtime_payload_with(
    root: &Path,
    remove_versions: impl FnOnce(&Path) -> std::io::Result<()>,
) -> Result<UninstallPayloadOutcome, AppError> {
    validate_current_runtime_containment(root)?;
    let versions = root.join("versions");
    let current = root.join("current.json");
    let current_contents = std::fs::read(&current).ok();
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let quarantine = root.join(format!("versions.uninstalling-{}", stamp));

    if versions.exists() {
        std::fs::rename(&versions, &quarantine).map_err(|e| {
            AppError::FileError(format!("无法隔离 runtime 目录（内核可能仍在运行）: {}", e))
        })?;
    }
    if current.exists() {
        if let Err(error) = std::fs::remove_file(&current) {
            if quarantine.exists() {
                let _ = std::fs::rename(&quarantine, &versions);
            }
            return Err(AppError::FileError(format!(
                "无法删除 current.json，已回滚 runtime 目录: {}",
                error
            )));
        }
    }

    if quarantine.exists() {
        if let Err(error) = remove_versions(&quarantine) {
            let rollback_dir = std::fs::rename(&quarantine, &versions);
            let rollback_record = current_contents
                .as_ref()
                .map(|contents| std::fs::write(&current, contents))
                .transpose();
            let rolled_back = rollback_dir.is_ok() && rollback_record.is_ok();
            return Err(AppError::FileError(format!(
                "无法删除 runtime 版本目录: {}；{}",
                error,
                if rolled_back {
                    "已回滚到卸载前状态"
                } else {
                    "回滚未完整，请保留现场并检查文件占用"
                }
            )));
        }
    }

    let mut cleanup_errors = Vec::new();
    for path in [
        root.join("downloads"),
        runtime::gateway_runtime_dir(),
        root.join("gateway-locks"),
    ] {
        if path.exists() {
            if let Err(error) = std::fs::remove_dir_all(&path) {
                cleanup_errors.push(format!("{}: {}", path.display(), error));
            }
        }
    }
    Ok(UninstallPayloadOutcome {
        cleanup_error: (!cleanup_errors.is_empty()).then(|| {
            format!(
                "内核已卸载，但部分缓存未清理：{}",
                cleanup_errors.join("；")
            )
        }),
    })
}

fn stop_managed_backend(state: &State<'_, AppState>) -> Result<(), AppError> {
    let mut inner = state.inner.lock()?;
    if inner.connection_mode != ConnectionMode::Managed {
        return Ok(());
    }
    if let Some(relay) = inner.gateway_ws.take() {
        relay.abort.store(true, Ordering::Relaxed);
        relay.notify.notify_waiters();
    }
    let token = inner.session_token.clone();
    if let Some(handle) = inner.dashboard_handle.as_mut() {
        if handle.owns_process && !handle.stop_with_token(token.as_deref()) {
            return Err(AppError::RuntimeUnavailable(
                "未能确认内置内核进程已经退出".to_string(),
            ));
        }
    }
    inner.dashboard_handle = None;
    inner.api_base_url.clear();
    inner.gateway_url.clear();
    inner.session_token = None;
    inner.oauth_session = None;
    Ok(())
}

async fn install_runtime_payload(app: &tauri::AppHandle) -> runtime::RuntimeInstallUpdateResult {
    let resource_dir = app.path().resource_dir().ok();
    if managed_runtime_install_source(runtime::bundled_runtime_available(resource_dir.as_deref()))
        == ManagedRuntimeInstallSource::Bundled
    {
        runtime::install_bundled_runtime_if_needed(resource_dir.as_deref()).await
    } else {
        runtime::install_runtime_update(None).await
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ManagedRuntimeInstallSource {
    Bundled,
    SignedUpdateChannel,
}

fn managed_runtime_install_source(bundled_available: bool) -> ManagedRuntimeInstallSource {
    if bundled_available {
        ManagedRuntimeInstallSource::Bundled
    } else {
        ManagedRuntimeInstallSource::SignedUpdateChannel
    }
}

#[tauri::command]
pub async fn managed_runtime_install(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<RuntimeControlResult, AppError> {
    if runtime::read_current_record().is_some() {
        desktop_control::set_managed_runtime_desired_state(ManagedRuntimeDesiredState::Stopped)?;
        return runtime_control_snapshot(&state, None);
    }
    if !restart::try_begin_restart(&state)? {
        return runtime_control_snapshot(
            &state,
            Some("内核操作正在进行中，请稍后重试".to_string()),
        );
    }
    let install = install_runtime_payload(&app).await;
    restart::end_restart(&state);
    if !install.ok || runtime::read_current_record().is_none() {
        let error = install
            .error
            .unwrap_or_else(|| "没有可用的内置或在线 runtime 安装源".to_string());
        return runtime_control_snapshot(&state, Some(error));
    }
    desktop_control::set_managed_runtime_desired_state(ManagedRuntimeDesiredState::Stopped)?;
    runtime_control_snapshot(&state, None)
}

#[tauri::command]
pub async fn managed_runtime_stop(
    state: State<'_, AppState>,
) -> Result<RuntimeControlResult, AppError> {
    if !restart::try_begin_restart(&state)? {
        return runtime_control_snapshot(
            &state,
            Some("内核操作正在进行中，请稍后重试".to_string()),
        );
    }
    let result = stop_managed_backend(&state);
    restart::end_restart(&state);
    match result {
        Ok(()) => {
            desktop_control::set_managed_runtime_desired_state(
                ManagedRuntimeDesiredState::Stopped,
            )?;
            runtime_control_snapshot(&state, None)
        }
        Err(error) => runtime_control_snapshot(&state, Some(error.to_string())),
    }
}

#[tauri::command]
pub async fn managed_runtime_start(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<RuntimeControlResult, AppError> {
    let is_managed = {
        let inner = state.inner.lock()?;
        inner.connection_mode == ConnectionMode::Managed
    };
    if !is_managed {
        return runtime_control_snapshot(
            &state,
            Some("当前正在使用外部 Hermes，请使用“启动并切换到内置内核”".to_string()),
        );
    }
    if !restart::try_begin_restart(&state)? {
        return runtime_control_snapshot(
            &state,
            Some("内核操作正在进行中，请稍后重试".to_string()),
        );
    }
    desktop_control::set_managed_runtime_desired_state(ManagedRuntimeDesiredState::Running)?;
    let result = super::connection::apply_managed(&app, &state).await;
    restart::end_restart(&state);
    match result {
        Ok(applied) if applied.ok => runtime_control_snapshot(&state, None),
        Ok(applied) => {
            desktop_control::set_managed_runtime_desired_state(
                ManagedRuntimeDesiredState::Stopped,
            )?;
            runtime_control_snapshot(
                &state,
                Some(
                    applied
                        .error
                        .unwrap_or_else(|| "内置内核启动失败".to_string()),
                ),
            )
        }
        Err(error) => {
            desktop_control::set_managed_runtime_desired_state(
                ManagedRuntimeDesiredState::Stopped,
            )?;
            runtime_control_snapshot(&state, Some(error.to_string()))
        }
    }
}

#[tauri::command]
pub async fn managed_runtime_uninstall(
    state: State<'_, AppState>,
) -> Result<RuntimeControlResult, AppError> {
    if !restart::try_begin_restart(&state)? {
        return runtime_control_snapshot(
            &state,
            Some("内核操作正在进行中，请稍后重试".to_string()),
        );
    }
    if let Err(error) = stop_managed_backend(&state) {
        restart::end_restart(&state);
        return runtime_control_snapshot(&state, Some(error.to_string()));
    }
    let outcome = uninstall_runtime_payload(&runtime::runtime_root());
    restart::end_restart(&state);
    match outcome {
        Ok(outcome) => {
            desktop_control::set_managed_runtime_desired_state(
                ManagedRuntimeDesiredState::Uninstalled,
            )?;
            runtime_control_snapshot(&state, outcome.cleanup_error)
        }
        Err(error) => {
            desktop_control::set_managed_runtime_desired_state(
                ManagedRuntimeDesiredState::Stopped,
            )?;
            runtime_control_snapshot(&state, Some(error.to_string()))
        }
    }
}

#[tauri::command]
pub async fn managed_runtime_reinstall(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<RuntimeControlResult, AppError> {
    if !restart::try_begin_restart(&state)? {
        return runtime_control_snapshot(
            &state,
            Some("内核操作正在进行中，请稍后重试".to_string()),
        );
    }
    let was_managed = {
        let inner = state.inner.lock()?;
        inner.connection_mode == ConnectionMode::Managed
    };
    if let Err(error) = stop_managed_backend(&state) {
        restart::end_restart(&state);
        return runtime_control_snapshot(&state, Some(error.to_string()));
    }
    if let Err(error) = uninstall_runtime_payload(&runtime::runtime_root()) {
        restart::end_restart(&state);
        desktop_control::set_managed_runtime_desired_state(ManagedRuntimeDesiredState::Stopped)?;
        return runtime_control_snapshot(&state, Some(error.to_string()));
    }
    let install = install_runtime_payload(&app).await;
    if !install.ok || runtime::read_current_record().is_none() {
        restart::end_restart(&state);
        desktop_control::set_managed_runtime_desired_state(
            ManagedRuntimeDesiredState::Uninstalled,
        )?;
        return runtime_control_snapshot(
            &state,
            Some(
                install
                    .error
                    .unwrap_or_else(|| "没有可用的 runtime 重装源".to_string()),
            ),
        );
    }
    desktop_control::set_managed_runtime_desired_state(if was_managed {
        ManagedRuntimeDesiredState::Running
    } else {
        ManagedRuntimeDesiredState::Stopped
    })?;
    let start_result = if was_managed {
        Some(super::connection::apply_managed(&app, &state).await)
    } else {
        None
    };
    restart::end_restart(&state);
    match start_result {
        Some(Ok(applied)) if !applied.ok => runtime_control_snapshot(
            &state,
            Some(
                applied
                    .error
                    .unwrap_or_else(|| "重装后启动失败".to_string()),
            ),
        ),
        Some(Err(error)) => runtime_control_snapshot(&state, Some(error.to_string())),
        _ => runtime_control_snapshot(&state, None),
    }
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

            uninstall_runtime_payload(root).unwrap();

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
            std::fs::create_dir_all(root.join("downloads/cache")).unwrap();
            std::fs::write(root.join("downloads/cache/runtime.zip"), "cached").unwrap();
            uninstall_runtime_payload(root).unwrap();
            assert!(!root.join("downloads").exists());
        });
    }

    #[test]
    #[serial]
    fn uninstall_rejects_invalid_current_record() {
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

            let error = uninstall_runtime_payload(root).expect_err("must reject invalid record");
            assert!(error.to_string().contains("current.json"));
            assert!(root.join("current.json").exists());
        });
    }

    #[test]
    #[serial]
    fn uninstall_rejects_runtime_path_outside_versions_root() {
        with_runtime_root(|root| {
            let outside = TempDir::new().expect("outside tempdir");
            let exe = outside.path().join(if cfg!(windows) {
                "hermes.exe"
            } else {
                "hermes"
            });
            std::fs::write(&exe, "fake").unwrap();
            std::fs::create_dir_all(root.join("versions")).unwrap();
            write_current_record(root, "1.0.0", &exe);
            // write_current_record creates the normal version directory but the
            // executable field points outside it, which must fail containment.
            let error = uninstall_runtime_payload(root).expect_err("must reject escape");
            assert!(error.to_string().contains("受管目录"));
            assert!(root.join("current.json").exists());
            assert!(exe.exists());
        });
    }

    #[test]
    #[serial]
    fn uninstall_preserves_hermes_home_and_desktop_control() {
        with_runtime_root(|root| {
            let exe = root.join("versions/1.0.0").join(if cfg!(windows) {
                "hermes.exe"
            } else {
                "hermes"
            });
            write_current_record(root, "1.0.0", &exe);
            std::fs::create_dir_all(root.join("hermes-home")).unwrap();
            std::fs::write(root.join("hermes-home/config.yaml"), "model: test").unwrap();
            std::fs::write(root.join("desktop-control.json"), "{}").unwrap();

            uninstall_runtime_payload(root).unwrap();

            assert!(root.join("hermes-home/config.yaml").exists());
            assert!(root.join("desktop-control.json").exists());
        });
    }

    #[test]
    #[serial]
    fn uninstall_rolls_back_when_version_delete_fails() {
        with_runtime_root(|root| {
            let exe = root.join("versions/1.0.0").join(if cfg!(windows) {
                "hermes.exe"
            } else {
                "hermes"
            });
            write_current_record(root, "1.0.0", &exe);
            let original = std::fs::read(root.join("current.json")).unwrap();

            let error = uninstall_runtime_payload_with(root, |_| {
                Err(std::io::Error::other("simulated file lock"))
            })
            .unwrap_err();

            assert!(error.to_string().contains("已回滚"));
            assert!(root.join("versions/1.0.0").exists());
            assert_eq!(std::fs::read(root.join("current.json")).unwrap(), original);
        });
    }

    #[test]
    fn reinstall_prefers_bundled_runtime_then_falls_back_to_signed_channel() {
        assert_eq!(
            managed_runtime_install_source(true),
            ManagedRuntimeInstallSource::Bundled
        );
        assert_eq!(
            managed_runtime_install_source(false),
            ManagedRuntimeInstallSource::SignedUpdateChannel
        );
    }
}

/// Rollback runtime and restart the dashboard.
#[tauri::command]
pub async fn runtime_rollback(
    state: State<'_, AppState>,
) -> Result<runtime::RuntimeInstallUpdateResult, AppError> {
    {
        let inner = state.inner.lock()?;
        crate::connection::require_managed_mode(inner.connection_mode, "Runtime 回滚")?;
    }
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
        crate::connection::require_managed_mode(inner.connection_mode, "内核重启")?;
        // Stop existing dashboard and any live WS relay before swapping runtime.
        if let Some(relay) = inner.gateway_ws.take() {
            relay.abort.store(true, Ordering::Relaxed);
            relay.notify.notify_waiters();
        }
        let session_token = inner.session_token.clone();
        if let Some(ref mut handle) = inner.dashboard_handle {
            if handle.owns_process && !handle.stop_with_token(session_token.as_deref()) {
                return Err(AppError::RuntimeUnavailable(
                    "未能确认旧内核进程已退出，已取消 Runtime 重启".to_string(),
                ));
            }
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
