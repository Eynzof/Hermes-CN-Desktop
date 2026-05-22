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

#[tauri::command]
pub fn runtime_info(state: State<'_, AppState>) -> Result<runtime::RuntimeInfo, AppError> {
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
                pid: handle.child.as_ref().map(|child| child.id()),
                command_program: handle.command_program.clone(),
                command_args: handle.command_args.clone(),
                command_line,
                gateway_runtime_dir: handle.gateway_runtime_dir.clone(),
                gateway_lock_dir: handle.gateway_lock_dir.clone(),
                ownership_marker_path: handle.ownership_marker_path.clone(),
                ownership_state: handle.ownership_state.clone(),
                session_token_present: inner.session_token.is_some(),
                gateway_sse_proxy_active: inner
                    .gateway_sse_stop
                    .as_ref()
                    .map(|stop| !stop.load(Ordering::Relaxed))
                    .unwrap_or(false),
            }
        });
        (inner.last_runtime_error.clone(), process)
    };
    let mut info = runtime::get_runtime_info(last_error);
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
async fn restart_dashboard(state: &State<'_, AppState>) -> Result<(), AppError> {
    let (host, port, hermes_home) = {
        let mut inner = state.inner.lock()?;
        // Stop existing dashboard and any long-lived SSE proxy before swapping runtime.
        if let Some(stop) = inner.gateway_sse_stop.take() {
            stop.store(true, Ordering::Relaxed);
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
    })
    .await?;

    let env_token = std::env::var("HERMES_DESKTOP_SESSION_TOKEN").ok();
    let token = match env_token {
        Some(t) => Some(t),
        None => dashboard::fetch_session_token(&handle.api_base_url).await,
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
