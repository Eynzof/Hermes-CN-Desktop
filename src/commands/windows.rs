use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenSessionWindowInput {
    pub session_id: String,
    pub watch: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowCommandResult {
    pub ok: bool,
    pub error: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PetOverlayBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PetOverlayOpenInput {
    pub bounds: Option<PetOverlayBounds>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PetOverlayOpenResult {
    pub ok: bool,
    pub error: Option<String>,
    pub bounds: Option<PetOverlayBounds>,
}

#[derive(Debug, Deserialize, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PetOverlayControlInput {
    #[serde(flatten)]
    pub payload: serde_json::Value,
}

fn sanitize_label_part(value: &str) -> String {
    let out: String = value
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' { ch } else { '-' })
        .collect();
    out.trim_matches('-').chars().take(80).collect::<String>()
}

pub fn session_window_label(session_id: &str) -> String {
    format!("session-{}", sanitize_label_part(session_id))
}

pub fn session_window_url(session_id: &str, watch: bool) -> String {
    let mut url = format!("index.html#/tasks/{}", urlencoding::encode(session_id));
    if watch {
        url.push_str("?window=session&watch=1");
    } else {
        url.push_str("?window=session");
    }
    url
}

pub fn new_session_window_url() -> &'static str {
    "index.html#/?window=session&new=1"
}

fn open_window(app: &AppHandle, label: String, url: String, title: &str) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window(&label) {
        let _ = existing.unminimize();
        let _ = existing.set_focus();
        return Ok(());
    }

    WebviewWindowBuilder::new(app, label, WebviewUrl::App(url.into()))
        .title(title)
        .inner_size(980.0, 720.0)
        .min_inner_size(720.0, 520.0)
        .build()
        .map_err(|err| err.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn open_session_window(app: AppHandle, input: OpenSessionWindowInput) -> WindowCommandResult {
    let session_id = input.session_id.trim();
    if session_id.is_empty() {
        return WindowCommandResult { ok: false, error: Some("missing session id".into()) };
    }
    match open_window(
        &app,
        session_window_label(session_id),
        session_window_url(session_id, input.watch.unwrap_or(false)),
        "Hermes Session",
    ) {
        Ok(()) => WindowCommandResult { ok: true, error: None },
        Err(error) => WindowCommandResult { ok: false, error: Some(error) },
    }
}

#[tauri::command]
pub async fn open_new_session_window(app: AppHandle) -> WindowCommandResult {
    match open_window(
        &app,
        "session-new".into(),
        new_session_window_url().into(),
        "Hermes New Session",
    ) {
        Ok(()) => WindowCommandResult { ok: true, error: None },
        Err(error) => WindowCommandResult { ok: false, error: Some(error) },
    }
}

#[tauri::command]
pub async fn pet_overlay_open(app: AppHandle, input: Option<PetOverlayOpenInput>) -> PetOverlayOpenResult {
    const LABEL: &str = "pet-overlay";
    let bounds = input.and_then(|i| i.bounds).unwrap_or(PetOverlayBounds {
        x: 80.0,
        y: 80.0,
        width: 260.0,
        height: 300.0,
    });

    if let Some(existing) = app.get_webview_window(LABEL) {
        let _ = existing.unminimize();
        let _ = existing.set_focus();
        return PetOverlayOpenResult { ok: true, error: None, bounds: Some(bounds) };
    }

    let result = WebviewWindowBuilder::new(
        &app,
        LABEL,
        WebviewUrl::App("index.html#/pet-overlay".into()),
    )
    .title("Hermes Pet")
    .inner_size(bounds.width, bounds.height)
    .position(bounds.x, bounds.y)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .resizable(false)
    .skip_taskbar(true)
    .build();

    match result {
        Ok(_) => PetOverlayOpenResult { ok: true, error: None, bounds: Some(bounds) },
        Err(err) => PetOverlayOpenResult { ok: false, error: Some(err.to_string()), bounds: None },
    }
}

#[tauri::command]
pub async fn pet_overlay_close(app: AppHandle) -> WindowCommandResult {
    if let Some(window) = app.get_webview_window("pet-overlay") {
        let _ = window.close();
    }
    WindowCommandResult { ok: true, error: None }
}

#[tauri::command]
pub async fn pet_overlay_push_state(app: AppHandle, payload: serde_json::Value) -> WindowCommandResult {
    if let Some(window) = app.get_webview_window("pet-overlay") {
        if let Err(err) = window.emit("pet-overlay-state", payload) {
            return WindowCommandResult { ok: false, error: Some(err.to_string()) };
        }
    }
    WindowCommandResult { ok: true, error: None }
}

#[tauri::command]
pub async fn pet_overlay_control(app: AppHandle, input: PetOverlayControlInput) -> WindowCommandResult {
    if let Some(window) = app.get_webview_window("main") {
        if let Err(err) = window.emit("pet-overlay-control", input.payload) {
            return WindowCommandResult { ok: false, error: Some(err.to_string()) };
        }
    }
    WindowCommandResult { ok: true, error: None }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_hash_router_session_urls() {
        assert_eq!(
            session_window_url("abc 123", true),
            "index.html#/tasks/abc%20123?window=session&watch=1"
        );
        assert_eq!(new_session_window_url(), "index.html#/?window=session&new=1");
    }

    #[test]
    fn sanitizes_session_window_label() {
        assert_eq!(session_window_label("abc 123:/x"), "session-abc-123--x");
    }
}
