// UI hot-update commands (Track B).
//
// Thin wrappers around process/ui_update.rs. Unlike the runtime channel these
// never touch the dashboard subprocess — a UI swap only needs the webview to
// load the new bundle, which `apply_active_ui` does by navigating the main
// window (Rust-side navigate, so the tauri://-to-hermesui cross-scheme hop is
// not subject to webview navigation policy).

use tauri::Manager;

use crate::error::AppError;
use crate::process::ui_update::{self, UiInstallUpdateResult, UiUpdateCheckResult};
use crate::update_stage::UpdateStage;

/// Event fired after a UI install/rollback has been activated.
pub const UI_UPDATE_READY_EVENT: &str = "ui-update-ready";

pub const UI_PROTOCOL_ENTRY_URL: &str = "hermesui://localhost/index.html";

/// Point the main window at the active UI source: the hermesui override when
/// one passes every gate, else the embedded bundle. Reload semantics come for
/// free — navigate always re-requests index.html, and the protocol handler
/// serves it with no-cache.
fn apply_active_ui(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window(crate::tray::MAIN_WINDOW_LABEL) else {
        return;
    };
    let target = if ui_update::active_ui_dir().is_some() {
        UI_PROTOCOL_ENTRY_URL.parse()
    } else {
        "tauri://localhost/index.html".parse()
    };
    match target {
        Ok(url) => {
            if let Err(e) = window.navigate(url) {
                log::warn!("failed to navigate main window to updated UI: {e}");
            }
        }
        Err(e) => log::warn!("invalid UI navigation URL: {e}"),
    }
}

#[tauri::command]
pub async fn ui_check_update() -> Result<UiUpdateCheckResult, AppError> {
    Ok(ui_update::check_ui_update().await)
}

/// Install a UI update and reload the webview onto it. The dashboard/kernel
/// is untouched.
#[tauri::command]
pub async fn ui_install_update(app: tauri::AppHandle) -> Result<UiInstallUpdateResult, AppError> {
    let stage_app = app.clone();
    let sink = move |stage: UpdateStage| stage.emit(&stage_app);
    let result = ui_update::install_ui_update(None, Some(&sink)).await;
    if !result.ok {
        UpdateStage::Failed {
            error: result
                .error
                .clone()
                .unwrap_or_else(|| "UI update failed".to_string()),
            new_version: None,
        }
        .emit(&app);
        return Ok(result);
    }

    let new_version = result
        .installed
        .as_ref()
        .map(|r| r.ui_version.clone())
        .unwrap_or_default();
    use tauri::Emitter;
    let _ = app.emit(UI_UPDATE_READY_EVENT, &new_version);
    apply_active_ui(&app);
    UpdateStage::Complete {
        new_version,
        previous_version: result.previous.as_ref().map(|p| p.ui_version.clone()),
    }
    .emit(&app);
    Ok(result)
}

/// Roll the UI back to the previous installed bundle (pure disk repoint).
#[tauri::command]
pub async fn ui_rollback(app: tauri::AppHandle) -> Result<UiInstallUpdateResult, AppError> {
    UpdateStage::RollingBack.emit(&app);
    let result = ui_update::rollback_ui_update();
    if !result.ok {
        UpdateStage::Failed {
            error: result
                .error
                .clone()
                .unwrap_or_else(|| "UI rollback failed".to_string()),
            new_version: None,
        }
        .emit(&app);
        return Ok(result);
    }
    let restored_version = result
        .installed
        .as_ref()
        .map(|r| r.ui_version.clone())
        .unwrap_or_default();
    use tauri::Emitter;
    let _ = app.emit(UI_UPDATE_READY_EVENT, &restored_version);
    apply_active_ui(&app);
    UpdateStage::RolledBack { restored_version }.emit(&app);
    Ok(result)
}

/// Escape hatch: drop the installed override and return to the embedded UI.
#[tauri::command]
pub async fn ui_reset_to_embedded(app: tauri::AppHandle) -> Result<(), AppError> {
    ui_update::reset_ui_to_embedded().map_err(AppError::FileError)?;
    apply_active_ui(&app);
    Ok(())
}
