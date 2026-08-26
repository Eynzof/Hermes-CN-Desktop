//! Dev-source backend hot update — one click pulls the latest Hermes-CN-Core
//! source, re-installs it into the desktop dev-runtime, and restarts the
//! managed dashboard.
//!
//! This is the retained dev-only path from the original hot-update plan
//! (`.kimix_cache/plan_d0283135dc3a0644.md`): it is gated to `local-source`
//! dev runtimes and is NOT part of the unified download-based self-update flow
//! (`commands/app_update.rs`). The button only shows for local-source kernels.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

use crate::error::AppError;
use crate::process::runtime;
use crate::state::{AppState, AppStateInner};

pub const HOT_UPDATE_PROGRESS_EVENT: &str = "hot-update-progress";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HotUpdateBackendInput {
    pub source_root: Option<String>,
    pub skip_git: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HotUpdateBackendResult {
    pub ok: bool,
    pub source_root: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub commit: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HotUpdateProgressPayload {
    pub phase: String,
    pub message: String,
}

fn emit_progress(app: &AppHandle, phase: &str, message: impl Into<String>) {
    let _ = app.emit(
        HOT_UPDATE_PROGRESS_EVENT,
        HotUpdateProgressPayload {
            phase: phase.to_string(),
            message: message.into(),
        },
    );
}

/// Locate the desktop repo root (where `scripts/install-local-runtime.mjs`
/// lives). In dev the cwd IS the repo; in packaged builds this returns `None`
/// and the command fails cleanly (the feature is dev-only anyway).
fn repo_root() -> Option<PathBuf> {
    if let Ok(root) = std::env::var("HERMES_DESKTOP_REPO_ROOT") {
        let trimmed = root.trim();
        if !trimmed.is_empty() {
            let p = PathBuf::from(trimmed);
            if p.join("scripts")
                .join("install-local-runtime.mjs")
                .is_file()
            {
                return Some(p);
            }
        }
    }
    let cwd = std::env::current_dir().ok()?;
    for ancestor in cwd.ancestors() {
        if ancestor
            .join("scripts")
            .join("install-local-runtime.mjs")
            .is_file()
        {
            return Some(ancestor.to_path_buf());
        }
    }
    None
}

/// Mirror of the script's `defaultSourceRoot()`: `../Hermes-CN-Core` then
/// `../hermes-agent-cn` relative to the repo root.
fn default_source_root() -> Option<PathBuf> {
    let repo = repo_root()?;
    for candidate in [
        repo.join("..").join("Hermes-CN-Core"),
        repo.join("..").join("hermes-agent-cn"),
    ] {
        let p = candidate.canonicalize().unwrap_or(candidate);
        if p.join("pyproject.toml").is_file() {
            return Some(p);
        }
    }
    None
}

/// Source-root resolution priority: `input` > current record's `source_repo`
/// (local-source only) > `HERMES_AGENT_CN_SOURCE` env > script default.
fn resolve_source_root(input: Option<String>) -> Option<String> {
    if let Some(p) = input
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
    {
        return Some(p);
    }
    if let Some(record) = runtime::read_current_record() {
        if record.source == "local-source" {
            if let Some(repo) = record
                .source_repo
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                return Some(repo.to_string());
            }
        }
    }
    if let Ok(p) = std::env::var("HERMES_AGENT_CN_SOURCE") {
        let trimmed = p.trim().to_string();
        if !trimmed.is_empty() {
            return Some(trimmed);
        }
    }
    default_source_root().map(|p| p.to_string_lossy().to_string())
}

/// Pure guard checks shared by the command and its tests. Returns an error
/// message when the hot update must not proceed.
fn guard_error(inner: &AppStateInner) -> Option<String> {
    if let Err(e) = crate::connection::require_managed_mode(inner.connection_mode, "后端热更新")
    {
        return Some(e.to_string());
    }
    match runtime::read_current_record() {
        None => Some("当前没有 managed runtime 记录".to_string()),
        Some(record) if record.source != "local-source" => {
            Some("当前内核不是本地源码安装（local-source），热更新仅限开发环境".to_string())
        }
        _ => None,
    }
}

#[tauri::command]
pub async fn hot_update_backend(
    app: AppHandle,
    state: State<'_, AppState>,
    input: HotUpdateBackendInput,
) -> Result<HotUpdateBackendResult, AppError> {
    // Guard 1 — managed mode + local-source runtime.
    {
        let inner = state.inner.lock()?;
        if let Some(error) = guard_error(&inner) {
            return Ok(HotUpdateBackendResult {
                ok: false,
                source_root: String::new(),
                commit: None,
                error: Some(error),
            });
        }
    }
    // Guard 2 — no concurrent dashboard restart.
    let held = crate::commands::restart::try_begin_restart(&state)?;
    if !held {
        return Ok(HotUpdateBackendResult {
            ok: false,
            source_root: String::new(),
            commit: None,
            error: Some("已有内核重启操作正在进行".to_string()),
        });
    }

    let result = run_hot_update(&app, &state, input).await;

    crate::commands::restart::end_restart(&state);
    Ok(result)
}

async fn run_hot_update(
    app: &AppHandle,
    state: &State<'_, AppState>,
    input: HotUpdateBackendInput,
) -> HotUpdateBackendResult {
    let repo = match repo_root() {
        Some(repo) => repo,
        None => {
            return HotUpdateBackendResult {
                ok: false,
                source_root: String::new(),
                commit: None,
                error: Some("未找到桌面端仓库（dev-only 功能，打包版不可用）".to_string()),
            }
        }
    };
    let source_root = match resolve_source_root(input.source_root.clone()) {
        Some(p) => p,
        None => {
            return HotUpdateBackendResult {
                ok: false,
                source_root: String::new(),
                commit: None,
                error: Some("无法解析 Hermes-CN-Core 源码路径".to_string()),
            }
        }
    };
    let script = repo.join("scripts").join("hot-update-backend.mjs");

    emit_progress(app, "prepare", format!("源码目录：{}", source_root));

    let mut cmd = Command::new("node");
    cmd.arg(&script);
    cmd.arg("--source").arg(&source_root);
    if input.skip_git.unwrap_or(false) {
        cmd.arg("--skip-git");
    }
    cmd.current_dir(&repo);
    cmd.stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(e) => {
            return HotUpdateBackendResult {
                ok: false,
                source_root,
                commit: None,
                error: Some(format!("无法启动热更新脚本：{}", e)),
            }
        }
    };

    // Stream stdout as progress; keep the last `commit: <sha>` line.
    let stdout = child.stdout.take().expect("stdout piped");
    let mut lines = BufReader::new(stdout).lines();
    let mut commit: Option<String> = None;
    while let Ok(Some(line)) = lines.next_line().await {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("commit:") {
            commit = Some(rest.trim().to_string());
        }
        let phase = if trimmed.starts_with("[git]") {
            "git"
        } else if trimmed.starts_with("[install]") {
            "install"
        } else if trimmed.starts_with("[frontend]") {
            "frontend"
        } else {
            "hot-update"
        };
        emit_progress(app, phase, trimmed.to_string());
    }

    // Drain stderr so the child never blocks on a full pipe.
    if let Some(stderr) = child.stderr.take() {
        tokio::spawn(async move {
            let mut reader = BufReader::new(stderr).lines();
            while let Ok(Some(_line)) = reader.next_line().await {}
        });
    }

    let status = match child.wait().await {
        Ok(status) => status,
        Err(e) => {
            return HotUpdateBackendResult {
                ok: false,
                source_root,
                commit,
                error: Some(format!("热更新进程等待失败：{}", e)),
            }
        }
    };
    if !status.success() {
        return HotUpdateBackendResult {
            ok: false,
            source_root,
            commit,
            error: Some(format!("热更新脚本失败：{}", status)),
        };
    }

    // Restart the managed dashboard so the new kernel goes live.
    emit_progress(app, "restart", "正在重启内核…");
    let (host, port) = crate::commands::restart::host_and_port();
    let (hermes_home, recovery_home) = {
        let inner = match state.inner.lock() {
            Ok(inner) => inner,
            Err(_) => {
                return HotUpdateBackendResult {
                    ok: false,
                    source_root,
                    commit,
                    error: Some("应用状态锁不可用".to_string()),
                }
            }
        };
        (inner.hermes_home.clone(), inner.hermes_home_base.clone())
    };
    match crate::commands::restart::respawn_managed_dashboard(
        state,
        &host,
        port,
        &hermes_home,
        &recovery_home,
    )
    .await
    {
        Ok(_) => HotUpdateBackendResult {
            ok: true,
            source_root,
            commit,
            error: None,
        },
        Err(e) => HotUpdateBackendResult {
            ok: false,
            source_root,
            commit,
            error: Some(format!("后端安装成功，但内核重启失败：{}", e)),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;
    use serial_test::serial;
    use tempfile::TempDir;

    /// Point the runtime root at an empty temp dir so `read_current_record()`
    /// returns `None` and env-based resolution is deterministic.
    fn isolate_runtime_root() -> TempDir {
        let dir = TempDir::new().unwrap();
        std::env::set_var("HERMES_DESKTOP_RUNTIME_ROOT", dir.path());
        dir
    }

    #[test]
    fn resolve_source_priority_input_beats_record_and_env() {
        std::env::remove_var("HERMES_AGENT_CN_SOURCE");
        // Input must win regardless of any local-source record.
        let resolved = resolve_source_root(Some("D:/custom-core".to_string()));
        assert_eq!(resolved.as_deref(), Some("D:/custom-core"));
    }

    #[test]
    #[serial]
    fn resolve_source_falls_back_to_env() {
        let _guard = isolate_runtime_root();
        std::env::set_var("HERMES_AGENT_CN_SOURCE", "D:/env-core");
        let resolved = resolve_source_root(None);
        std::env::remove_var("HERMES_AGENT_CN_SOURCE");
        std::env::remove_var("HERMES_DESKTOP_RUNTIME_ROOT");
        assert_eq!(resolved.as_deref(), Some("D:/env-core"));
    }

    #[test]
    #[serial]
    fn resolve_source_ignores_blank_input() {
        let _guard = isolate_runtime_root();
        std::env::set_var("HERMES_AGENT_CN_SOURCE", "D:/env-core");
        let resolved = resolve_source_root(Some("   ".to_string()));
        std::env::remove_var("HERMES_AGENT_CN_SOURCE");
        std::env::remove_var("HERMES_DESKTOP_RUNTIME_ROOT");
        assert_eq!(resolved.as_deref(), Some("D:/env-core"));
    }

    #[test]
    #[serial]
    fn guard_rejects_attached_local_mode() {
        // Attached local backend: not managed — hot update must be refused.
        let _guard = isolate_runtime_root();
        let inner = AppStateInner {
            connection_mode: crate::connection::ConnectionMode::Local,
            ..test_inner()
        };
        let error = guard_error(&inner).unwrap();
        assert!(error.contains("外部 Hermes"), "{}", error);
        std::env::remove_var("HERMES_DESKTOP_RUNTIME_ROOT");
    }

    #[test]
    #[serial]
    fn guard_rejects_remote_mode() {
        let _guard = isolate_runtime_root();
        let inner = AppStateInner {
            connection_mode: crate::connection::ConnectionMode::Remote,
            ..test_inner()
        };
        let error = guard_error(&inner).unwrap();
        assert!(error.contains("外部 Hermes"), "{}", error);
        std::env::remove_var("HERMES_DESKTOP_RUNTIME_ROOT");
    }

    fn test_inner() -> AppStateInner {
        AppStateInner {
            api_base_url: String::new(),
            gateway_url: String::new(),
            hermes_home: String::new(),
            hermes_home_base: String::new(),
            session_token: None,
            current_profile: "default".to_string(),
            dashboard_handle: None,
            gateway_ws: None,
            embedded_gateway: None,
            embedded: false,
            embedded_payload: None,
            browser_companion: None,
            dashboard_restart_in_flight: false,
            last_runtime_error: None,
            yolo_mode: false,
            connection_mode: crate::connection::ConnectionMode::Managed,
            oauth_session: None,
            last_auth_expired_emit: None,
            app_update_in_flight: false,
            ui_update_in_flight: false,
        }
    }
}
