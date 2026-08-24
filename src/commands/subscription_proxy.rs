use serde::Deserialize;
use tauri::Manager;

use crate::error::AppError;
use crate::schema::subscription::{ProxyProvider, ProxyStatus};
use crate::state::AppState;
use crate::subscription_proxy::{start_subscription_proxy, stop_subscription_proxy};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionProxyStartArgs {
    pub provider: ProxyProvider,
}

fn status_from_handle(handle: &crate::state::SubscriptionProxyHandle) -> ProxyStatus {
    ProxyStatus {
        running: true,
        port: handle.port,
        provider: ProxyProvider::parse(&handle.provider).unwrap_or(ProxyProvider::Nous),
        authenticated: true,
    }
}

#[tauri::command]
pub async fn subscription_proxy_start(
    app: tauri::AppHandle,
    args: SubscriptionProxyStartArgs,
) -> Result<ProxyStatus, AppError> {
    let handle = start_subscription_proxy(app, args.provider.as_str().to_string()).await?;
    Ok(status_from_handle(&handle))
}

#[tauri::command]
pub async fn subscription_proxy_stop(app: tauri::AppHandle) -> Result<(), AppError> {
    let handle = {
        let state = app.state::<AppState>();
        let inner = state
            .inner
            .lock()
            .map_err(|e| AppError::Internal(e.to_string()))?;
        inner.subscription_proxy.clone()
    };
    if let Some(h) = handle {
        stop_subscription_proxy(&h);
    }
    Ok(())
}

#[tauri::command]
pub async fn subscription_proxy_status(app: tauri::AppHandle) -> Result<ProxyStatus, AppError> {
    let state = app.state::<AppState>();
    let inner = state
        .inner
        .lock()
        .map_err(|e| AppError::Internal(e.to_string()))?;
    let handle = inner.subscription_proxy.clone();
    handle
        .map(|h| status_from_handle(&h))
        .ok_or_else(|| AppError::Internal("subscription proxy not running".into()))
}

#[tauri::command]
pub async fn subscription_proxy_providers() -> Result<Vec<String>, AppError> {
    Ok(vec!["nous".into(), "xai".into()])
}
