// Shared "restart the managed dashboard" primitive.
//
// Both profile switching (`profiles::switch_profile`) and the YOLO toggle
// (`yolo::set_yolo_mode`) stop the desktop-owned dashboard and respawn it
// against a HERMES_HOME so a new runtime config takes effect. They differ only
// in the command-specific state they write afterwards (current_profile + sticky
// file vs. yolo_mode), so the stop -> settle -> spawn -> fetch-token ->
// build-gateway -> adopt-into-AppState dance — including recovery when the
// target fails to boot — lives here once.

use std::sync::atomic::Ordering;
use std::time::Duration;

use tauri::State;

use crate::error::AppError;
use crate::process::dashboard;
use crate::state::AppState;

/// Default host/port the desktop binds its managed dashboard to. Honors the
/// `HERMES_DESKTOP_API_HOST` / `HERMES_DESKTOP_API_PORT` overrides.
pub fn host_and_port() -> (String, u16) {
    let host = std::env::var("HERMES_DESKTOP_API_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let port = std::env::var("HERMES_DESKTOP_API_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(dashboard::DEFAULT_DESKTOP_DASHBOARD_PORT);
    (host, port)
}

/// Atomically claim the dashboard-restart guard. Returns `true` if the caller
/// now owns the restart and must call [`end_restart`] when done; `false` if a
/// restart is already in flight. The check-and-set happens under a single lock,
/// so two concurrent callers cannot both win.
pub fn try_begin_restart(state: &State<'_, AppState>) -> Result<bool, AppError> {
    let mut inner = state.inner.lock()?;
    if inner.dashboard_restart_in_flight {
        return Ok(false);
    }
    inner.dashboard_restart_in_flight = true;
    Ok(true)
}

/// Release the dashboard-restart guard claimed by [`try_begin_restart`].
pub fn end_restart(state: &State<'_, AppState>) {
    if let Ok(mut inner) = state.inner.lock() {
        inner.dashboard_restart_in_flight = false;
    }
}

/// What a respawn ended up doing.
pub enum RespawnOutcome {
    /// `target_home` is now running.
    Spawned,
    /// `target_home` failed to boot; `recovery_home` is running instead.
    Recovered { error: String },
    /// Both `target_home` and `recovery_home` failed — no dashboard is running.
    Down {
        error: String,
        recovery_error: String,
    },
}

/// Result of [`respawn_managed_dashboard`]: the outcome plus the live
/// connection details for whichever dashboard is now running (all `None` when
/// `Down`).
pub struct RespawnResult {
    pub outcome: RespawnOutcome,
    pub api_base_url: Option<String>,
    pub gateway_url: Option<String>,
    pub session_token: Option<String>,
}

/// Stop the desktop-owned dashboard and respawn it.
///
/// Tries `target_home` first; if that fails to boot, falls back to
/// `recovery_home` (pass the same value to simply retry the target). On a
/// successful (re)spawn this updates the shared AppState connection fields —
/// `api_base_url`, `gateway_url`, `session_token`, `hermes_home`,
/// `dashboard_handle` — for whichever home came up. The caller owns any
/// command-specific state (`current_profile`, `yolo_mode`, sticky file) and
/// must hold the [`try_begin_restart`] guard for the duration.
pub async fn respawn_managed_dashboard(
    state: &State<'_, AppState>,
    host: &str,
    port: u16,
    target_home: &str,
    recovery_home: &str,
) -> Result<RespawnResult, AppError> {
    // 1. Stop the running dashboard.
    {
        let mut inner = state.inner.lock()?;
        if let Some(stop) = inner.gateway_sse_stop.take() {
            stop.store(true, Ordering::Relaxed);
        }
        let session_token = inner.session_token.clone();
        if let Some(ref mut handle) = inner.dashboard_handle {
            handle.stop_with_token(session_token.as_deref());
        }
        inner.dashboard_handle = None;
    }

    tokio::time::sleep(Duration::from_millis(800)).await;

    // 2. Spawn the target; on failure fall back to recovery.
    let target_error = match spawn_and_adopt(state, host, port, target_home).await {
        Ok((api_base_url, gateway_url, session_token)) => {
            return Ok(RespawnResult {
                outcome: RespawnOutcome::Spawned,
                api_base_url: Some(api_base_url),
                gateway_url: Some(gateway_url),
                session_token,
            });
        }
        Err(e) => e.to_string(),
    };

    log::error!(
        "Dashboard failed to start for {}: {}; attempting recovery onto {}",
        target_home,
        target_error,
        recovery_home
    );

    match spawn_and_adopt(state, host, port, recovery_home).await {
        Ok((api_base_url, gateway_url, session_token)) => Ok(RespawnResult {
            outcome: RespawnOutcome::Recovered {
                error: target_error,
            },
            api_base_url: Some(api_base_url),
            gateway_url: Some(gateway_url),
            session_token,
        }),
        Err(re) => Ok(RespawnResult {
            outcome: RespawnOutcome::Down {
                error: target_error,
                recovery_error: re.to_string(),
            },
            api_base_url: None,
            gateway_url: None,
            session_token: None,
        }),
    }
}

/// Spawn a dashboard for `hermes_home`, fetch a fresh session token, and adopt
/// the resulting connection into AppState. Returns the connection tuple on
/// success. The session token is process-local and rotates on every restart.
async fn spawn_and_adopt(
    state: &State<'_, AppState>,
    host: &str,
    port: u16,
    hermes_home: &str,
) -> Result<(String, String, Option<String>), AppError> {
    let handle = dashboard::ensure_hermes_dashboard(dashboard::EnsureDashboardOptions {
        host: host.to_string(),
        port,
        hermes_home: hermes_home.to_string(),
        allow_external_agent: dashboard::external_agent_allowed(),
        allow_port_fallback: true,
    })
    .await?;

    let token = match handle.session_token.clone() {
        Some(token) => Some(token),
        None => match std::env::var("HERMES_DESKTOP_SESSION_TOKEN")
            .ok()
            .or_else(|| std::env::var("HERMES_DASHBOARD_SESSION_TOKEN").ok())
        {
            Some(token) => Some(token),
            None => dashboard::fetch_session_token(&handle.api_base_url).await,
        },
    };
    let gateway_url = dashboard::build_gateway_url(&handle.api_base_url, token.as_deref());
    let api_base_url = handle.api_base_url.clone();

    {
        let mut inner = state.inner.lock()?;
        inner.api_base_url = handle.api_base_url.clone();
        inner.gateway_url = gateway_url.clone();
        inner.session_token = token.clone();
        inner.hermes_home = hermes_home.to_string();
        inner.dashboard_handle = Some(handle);
    }

    Ok((api_base_url, gateway_url, token))
}
