use serde::{Deserialize, Serialize};
use tauri::Manager;

use crate::error::AppError;
use crate::state::AppState;
use crate::subscription_proxy::{start_subscription_proxy, stop_subscription_proxy};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionProxyStatus {
    pub running: bool,
    pub port: u16,
    pub provider: String,
    pub authenticated: bool,
}

#[derive(Deserialize)]
pub struct SubscriptionProxyStartArgs {
    pub provider: String,
}

#[tauri::command]
pub async fn subscription_proxy_start(
    app: tauri::AppHandle,
    args: SubscriptionProxyStartArgs,
) -> Result<SubscriptionProxyStatus, AppError> {
    let handle = start_subscription_proxy(app, args.provider).await?;
    Ok(SubscriptionProxyStatus {
        running: true,
        port: handle.port,
        provider: handle.provider,
        authenticated: true,
    })
}

#[tauri::command]
pub async fn subscription_proxy_stop(app: tauri::AppHandle) -> Result<(), AppError> {
    let handle = {
        let state = app.state::<AppState>();
        let inner = state.inner.lock().map_err(|e| AppError::Internal(e.to_string()))?;
        inner.subscription_proxy.clone()
    };
    if let Some(h) = handle {
        stop_subscription_proxy(&h);
    }
    Ok(())
}

#[tauri::command]
pub async fn subscription_proxy_status(app: tauri::AppHandle) -> Result<SubscriptionProxyStatus, AppError> {
    let state = app.state::<AppState>();
    let inner = state.inner.lock().map_err(|e| AppError::Internal(e.to_string()))?;
    let handle = inner.subscription_proxy.clone();
    handle
        .map(|h| SubscriptionProxyStatus {
            running: true,
            port: h.port,
            provider: h.provider,
            authenticated: true,
        })
        .ok_or_else(|| AppError::Internal("subscription proxy not running".into()))
}

#[tauri::command]
pub async fn subscription_proxy_providers() -> Result<Vec<String>, AppError> {
    Ok(vec!["nous".into(), "xai".into()])
}
