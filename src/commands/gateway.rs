use serde::Serialize;
use tauri::State;

use crate::error::AppError;
use crate::process::dashboard::{build_gateway_url, fetch_session_token};
use crate::state::AppState;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeConfig {
    pub api_base_url: String,
    pub gateway_url: String,
    pub session_token: Option<String>,
    pub current_profile: String,
    /// "managed", "local" or "remote".
    pub connection_mode: String,
    /// Whether REST/Gateway requests can currently reach a configured backend.
    pub backend_ready: bool,
    pub guide_state: String,
    pub managed_runtime_desired_state: String,
    pub managed_runtime_lifecycle_state: String,
    /// Running as the portable (unzip-and-run) distribution — the desktop
    /// update dialog switches to "download the zip and re-extract" guidance.
    pub portable: bool,
    /// True when the managed runtime is running in-process (embedded CPython).
    /// apiBaseUrl is then the `embedded://local` placeholder; REST goes through
    /// native IPC and the gateway rides the in-memory transport (no HTTP/WS).
    pub embedded: bool,
}

#[tauri::command]
pub fn get_runtime_config(state: State<'_, AppState>) -> Result<RuntimeConfig, AppError> {
    let inner = state.inner.lock()?;
    let control = crate::desktop_control::read();
    let installed = crate::process::runtime::read_current_record().is_some();
    let managed_running = inner.connection_mode == crate::connection::ConnectionMode::Managed
        && (inner.embedded
            || inner
                .dashboard_handle
                .as_ref()
                .is_some_and(|handle| handle.owns_process));
    let lifecycle =
        crate::desktop_control::managed_runtime_lifecycle_state(installed, managed_running);
    Ok(RuntimeConfig {
        api_base_url: inner.api_base_url.clone(),
        gateway_url: inner.gateway_url.clone(),
        session_token: inner.session_token.clone(),
        current_profile: inner.current_profile.clone(),
        connection_mode: inner.connection_mode.as_str().to_string(),
        backend_ready: inner.dashboard_handle.is_some() && !inner.api_base_url.trim().is_empty(),
        guide_state: control.guide_state.as_str().to_string(),
        managed_runtime_desired_state: control.managed_runtime_desired_state.as_str().to_string(),
        managed_runtime_lifecycle_state: lifecycle.to_string(),
        portable: crate::process::runtime::portable_mode_active(),
        embedded: inner.embedded,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshGatewayResult {
    pub gateway_url: String,
    pub session_token: Option<String>,
}

#[tauri::command]
pub async fn refresh_gateway_url(
    state: State<'_, AppState>,
) -> Result<RefreshGatewayResult, AppError> {
    let (api_base_url, current_token, mode) = {
        let inner = state.inner.lock()?;
        (
            inner.api_base_url.clone(),
            inner.session_token.clone(),
            inner.connection_mode,
        )
    };

    // Embedded mode has no HTTP/WS URL and no token rotation — return the
    // placeholder unchanged (the frontend forces the in-memory relay).
    if state.inner.lock()?.embedded {
        let inner = state.inner.lock()?;
        return Ok(RefreshGatewayResult {
            gateway_url: inner.gateway_url.clone(),
            session_token: inner.session_token.clone(),
        });
    }

    // Remote tokens are static (Settings or env), never rotated by a local
    // dashboard restart — return the current connection unchanged instead of
    // scraping the remote's HTML for a token it doesn't embed.
    if mode == crate::connection::ConnectionMode::Remote {
        let inner = state.inner.lock()?;
        return Ok(RefreshGatewayResult {
            gateway_url: inner.gateway_url.clone(),
            session_token: inner.session_token.clone(),
        });
    }

    let env_token = std::env::var("HERMES_DESKTOP_SESSION_TOKEN")
        .ok()
        .or_else(|| std::env::var("HERMES_DASHBOARD_SESSION_TOKEN").ok());
    // Dashboard session tokens are process-local and rotate on every restart.
    // A refresh that races the dashboard coming back up (e.g. right after a
    // runtime update) sees `fetch_session_token` fail and return None. Treat
    // that as "token unchanged" and keep the token we already have rather than
    // clobbering a valid token with None — otherwise every subsequent proxied
    // request drops its Authorization header and 401s until the next restart.
    let fresh_token = match env_token {
        Some(t) => Some(t),
        None => fetch_session_token(&api_base_url).await.or(current_token),
    };

    let fresh_url = build_gateway_url(&api_base_url, fresh_token.as_deref());

    {
        let mut inner = state.inner.lock()?;
        inner.gateway_url = fresh_url.clone();
        inner.session_token = fresh_token.clone();
    }

    Ok(RefreshGatewayResult {
        gateway_url: fresh_url,
        session_token: fresh_token,
    })
}

/// Return the Core backend version from the embedded interpreter (embedded
/// mode only). The frontend version gate uses this instead of an HTTP
/// `/api/version` fetch, which does not exist in embedded mode
/// (refactor_report.md §8 success criteria 3). Non-embedded mode returns
/// `None` so the frontend keeps using the HTTP path unchanged.
///
/// The shape mirrors the HTTP `/api/version` response (`{ version: string }`)
/// and the frontend `getBackendVersion(): Promise<{ version: string }>`
/// contract in web/src/lib/tauri-bridge.ts — a bare string would make the
/// gate report "unavailable" and force-quit the app.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendVersionInfo {
    pub version: String,
}

#[tauri::command]
pub fn get_backend_version(
    state: State<'_, AppState>,
) -> Result<Option<BackendVersionInfo>, AppError> {
    if !state.inner.lock()?.embedded {
        return Ok(None);
    }
    Ok(Some(BackendVersionInfo {
        version: crate::embedded::get_backend_version()?,
    }))
}
