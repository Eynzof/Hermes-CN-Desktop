use tauri::Manager;

use crate::api_server::{start_api_server, stop_api_server};
use crate::error::AppError;
use crate::schema::api_server::ApiServerStatus;
use crate::state::AppState;

#[tauri::command]
pub async fn api_server_start(app: tauri::AppHandle) -> Result<ApiServerStatus, AppError> {
    let handle = start_api_server(app).await?;
    Ok(ApiServerStatus {
        running: true,
        port: handle.port,
    })
}

#[tauri::command]
pub async fn api_server_stop(app: tauri::AppHandle) -> Result<(), AppError> {
    let handle = {
        let state = app.state::<AppState>();
        let inner = state
            .inner
            .lock()
            .map_err(|e| AppError::Internal(e.to_string()))?;
        inner.api_server.clone()
    };
    if let Some(h) = handle {
        stop_api_server(&h);
    }
    Ok(())
}

#[tauri::command]
pub async fn api_server_status(app: tauri::AppHandle) -> Result<ApiServerStatus, AppError> {
    let state = app.state::<AppState>();
    let inner = state
        .inner
        .lock()
        .map_err(|e| AppError::Internal(e.to_string()))?;
    let handle = inner.api_server.clone();
    handle
        .map(|h| ApiServerStatus {
            running: true,
            port: h.port,
        })
        .ok_or_else(|| AppError::Internal("api server not running".into()))
}
