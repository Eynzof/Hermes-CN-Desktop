// Track B UI hot update commands.
//
// Thin wrappers around crate::process::ui_update. Unlike the kernel/runtime
// commands these never restart the dashboard — after a successful install or
// rollback the caller reloads after receiving the IPC response, so
// the new React bundle is picked up without touching the Python backend.

use tauri::{AppHandle, State};

use crate::connection;
use crate::error::AppError;
use crate::process::ui_update;
use crate::state::AppState;

/// Event emitted after a UI package install/rollback so the renderer can
/// `location.reload()` as a belt-and-suspenders fallback (the Rust side also
/// reloads the window itself).
pub const UI_UPDATE_READY_EVENT: &str = "ui-update-ready";

/// Raised while `ui_install_update` / `ui_rollback` is running so a second
/// invocation (double-click, two windows) cannot race on the same staging dir
/// or current.json.
fn try_begin_ui_update(state: &State<'_, AppState>) -> Result<bool, AppError> {
    let mut inner = state.inner.lock()?;
    if inner.ui_update_in_flight {
        return Ok(false);
    }
    inner.ui_update_in_flight = true;
    Ok(true)
}

fn end_ui_update(state: &State<'_, AppState>) {
    if let Ok(mut inner) = state.inner.lock() {
        inner.ui_update_in_flight = false;
    }
}

#[tauri::command]
pub async fn ui_check_update() -> Result<ui_update::UiUpdateCheckResult, AppError> {
    Ok(ui_update::check_ui_update().await)
}

#[tauri::command]
pub async fn ui_install_update(
    _app: AppHandle,
    state: State<'_, AppState>,
) -> Result<ui_update::UiInstallUpdateResult, AppError> {
    {
        let inner = state.inner.lock()?;
        connection::require_managed_mode(inner.connection_mode, "界面热更新")?;
    }
    if !try_begin_ui_update(&state)? {
        return Ok(ui_update::UiInstallUpdateResult {
            ok: false,
            installed: None,
            previous: None,
            error: Some("界面更新已在进行中，请稍候".to_string()),
        });
    }
    let result = ui_update::install_ui_update().await;
    end_ui_update(&state);
    Ok(result)
}

#[tauri::command]
pub async fn ui_rollback(
    _app: AppHandle,
    state: State<'_, AppState>,
) -> Result<ui_update::UiInstallUpdateResult, AppError> {
    {
        let inner = state.inner.lock()?;
        connection::require_managed_mode(inner.connection_mode, "界面回退")?;
    }
    if !try_begin_ui_update(&state)? {
        return Ok(ui_update::UiInstallUpdateResult {
            ok: false,
            installed: None,
            previous: None,
            error: Some("界面更新已在进行中，请稍候".to_string()),
        });
    }
    let result = ui_update::rollback_ui_update();
    end_ui_update(&state);
    Ok(result)
}
