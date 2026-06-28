//! WebView devtools toggle.
//!
//! The desktop ships with the inspector enabled in release builds too (the
//! `devtools` Cargo feature on the `tauri` crate — see Cargo.toml), so it is in
//! "developer mode" by default. The renderer binds a keyboard shortcut that
//! calls this command to open / close the inspector for the main window — see
//! `registerDevtoolsShortcut` in web/src/lib/tauri-bridge.ts and the shortcut
//! hint on the About page (web/src/routes/settings.tsx, AboutSection).

use tauri::{AppHandle, Manager};

use crate::tray::MAIN_WINDOW_LABEL;

/// Toggle the WebView devtools for the main window. No-op if the window is gone.
#[tauri::command]
pub fn toggle_devtools(app: AppHandle) {
    let Some(webview) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        log::warn!("toggle_devtools: main window not found");
        return;
    };

    if webview.is_devtools_open() {
        webview.close_devtools();
    } else {
        webview.open_devtools();
    }
}
