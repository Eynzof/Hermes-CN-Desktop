//! System tray integration for the desktop app.
//!
//! Closing the main window should keep the managed runtime alive. The tray is
//! the visible affordance for bringing the UI back or explicitly quitting the
//! whole desktop runtime.

use tauri::menu::MenuBuilder;
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{App, AppHandle, Manager, Runtime, Window};

pub const MAIN_WINDOW_LABEL: &str = "main";

const TRAY_ID: &str = "hermes-main-tray";
const MENU_OPEN_MAIN: &str = "hermes-tray-open-main";
const MENU_QUIT: &str = "hermes-tray-quit";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TrayMenuAction {
    OpenMainWindow,
    Quit,
}

fn action_for_menu_id(id: &str) -> Option<TrayMenuAction> {
    match id {
        MENU_OPEN_MAIN => Some(TrayMenuAction::OpenMainWindow),
        MENU_QUIT => Some(TrayMenuAction::Quit),
        _ => None,
    }
}

fn click_should_open_main(button: MouseButton, button_state: Option<MouseButtonState>) -> bool {
    button == MouseButton::Left
        && button_state
            .map(|state| state == MouseButtonState::Up)
            .unwrap_or(true)
}

fn tray_event_should_open_main(event: &TrayIconEvent) -> bool {
    match event {
        TrayIconEvent::Click {
            button,
            button_state,
            ..
        } => click_should_open_main(*button, Some(*button_state)),
        TrayIconEvent::DoubleClick { button, .. } => click_should_open_main(*button, None),
        _ => false,
    }
}

pub fn install(app: &App) -> tauri::Result<()> {
    let menu = MenuBuilder::new(app)
        .text(MENU_OPEN_MAIN, "打开主窗口")
        .separator()
        .text(MENU_QUIT, "退出 Hermes")
        .build()?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .tooltip("Hermes Agent 中文社区桌面版")
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match action_for_menu_id(event.id().as_ref()) {
            Some(TrayMenuAction::OpenMainWindow) => show_main_window(app),
            Some(TrayMenuAction::Quit) => app.exit(0),
            None => {}
        })
        .on_tray_icon_event(|tray, event| {
            if tray_event_should_open_main(&event) {
                show_main_window(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    } else {
        log::warn!("No default window icon available for system tray");
    }

    builder.build(app)?;
    Ok(())
}

pub fn hide_main_window_to_tray<R: Runtime>(window: &Window<R>) {
    if let Err(err) = window.hide() {
        log::warn!("Failed to hide main window to tray: {}", err);
    } else {
        log::info!("Main window hidden to system tray");
    }
}

pub fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        log::warn!("Main window not found while restoring from tray");
        return;
    };

    if let Err(err) = window.unminimize() {
        log::debug!(
            "Failed to unminimize main window while restoring from tray: {}",
            err
        );
    }
    if let Err(err) = window.show() {
        log::warn!("Failed to show main window from tray: {}", err);
        return;
    }
    if let Err(err) = window.set_focus() {
        log::debug!("Failed to focus main window after tray restore: {}", err);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_known_tray_menu_ids() {
        assert_eq!(
            action_for_menu_id(MENU_OPEN_MAIN),
            Some(TrayMenuAction::OpenMainWindow)
        );
        assert_eq!(action_for_menu_id(MENU_QUIT), Some(TrayMenuAction::Quit));
        assert_eq!(action_for_menu_id("unrelated"), None);
    }

    #[test]
    fn only_left_button_release_opens_main_window() {
        assert!(click_should_open_main(
            MouseButton::Left,
            Some(MouseButtonState::Up)
        ));
        assert!(click_should_open_main(MouseButton::Left, None));
        assert!(!click_should_open_main(
            MouseButton::Left,
            Some(MouseButtonState::Down)
        ));
        assert!(!click_should_open_main(
            MouseButton::Right,
            Some(MouseButtonState::Up)
        ));
        assert!(!click_should_open_main(MouseButton::Middle, None));
    }
}
