//! Windows environment commands.
//!
//! Exposes registry-PATH refresh (P-042) so the webview can keep the
//! effective PATH up to date before spawning PowerShell / dashboard / MCP
//! children without restarting the desktop process.

use crate::path_resolver;
use crate::state::AppState;
use serde::Serialize;
use tauri::State;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowsPathRefreshResult {
    pub path: String,
    pub pathext: Option<String>,
    pub refreshed: bool,
}

/// Re-read the Windows registry PATH/PATHEXT when the last-write signature
/// changed or the 30 s signature cache expired. `force=true` ignores the cache.
#[tauri::command]
pub fn refresh_windows_path(
    force: bool,
    _state: State<'_, AppState>,
) -> Result<WindowsPathRefreshResult, String> {
    let (effective, refreshed) = path_resolver::refresh_windows_path(force);
    let path = path_resolver::effective_path_os()
        .to_string_lossy()
        .to_string();
    let pathext = path_resolver::effective_pathext();
    // Silence unused warning on non-Windows; the cache value is already reflected
    // in effective_path_os/effective_pathext.
    let _ = effective;
    Ok(WindowsPathRefreshResult {
        path,
        pathext,
        refreshed,
    })
}
