// Track B UI hot update commands.
//
// Thin wrappers around crate::process::ui_update. Unlike the kernel/runtime
// commands these never restart the dashboard — after a successful install or
// rollback they emit `ui-update-ready` and reload the main webview window, so
// the new React bundle is picked up without touching the Python backend.

use tauri::{AppHandle, Emitter, Manager, State};

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

/// Emit `ui-update-ready` and reload the main window so the new UI bytes take
/// effect immediately. The kernel/dashboard subprocess is deliberately left
/// running — UI and backend are decoupled.
fn notify_and_reload(app: &AppHandle, result: &ui_update::UiInstallUpdateResult) {
    if let Some(installed) = &result.installed {
        let _ = app.emit(
            UI_UPDATE_READY_EVENT,
            ui_update::UiUpdateReadyPayload {
                ui_version: installed.ui_version.clone(),
            },
        );
    }
    if let Some(window) = app.get_webview_window("main") {
        if let Err(e) = window.reload() {
            log::warn!("failed to reload main window after UI update: {e}");
        }
    }
}

#[tauri::command]
pub async fn ui_check_update() -> Result<ui_update::UiUpdateCheckResult, AppError> {
    Ok(ui_update::check_ui_update().await)
}

#[tauri::command]
pub async fn ui_install_update(
    app: AppHandle,
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
    if result.ok {
        notify_and_reload(&app, &result);
    }
    Ok(result)
}

#[tauri::command]
pub async fn ui_rollback(
    app: AppHandle,
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
    if result.ok {
        notify_and_reload(&app, &result);
    }
    Ok(result)
}
