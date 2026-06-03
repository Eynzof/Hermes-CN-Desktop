// YOLO-mode commands.
//
// "YOLO mode" maps to the backend `HERMES_YOLO_MODE=1` environment variable
// (equivalent to the `--yolo` CLI flag), which makes the agent auto-approve
// dangerous-command prompts. The backend freezes this value at import time, so
// the only way to toggle it is to (re)launch the managed runtime.
//
// `get_yolo_mode` reports both the persisted desktop preference and the
// effective state of the running dashboard. `set_yolo_mode` persists the
// preference and — when the desktop owns the dashboard process — restarts it so
// the change takes effect immediately, mirroring the stop+respawn flow used by
// `switch_profile`.

use std::sync::atomic::Ordering;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::error::AppError;
use crate::process::dashboard;
use crate::state::AppState;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct YoloModeStatus {
    /// Persisted desktop preference for the active profile's HERMES_HOME.
    pub enabled: bool,
    /// What the currently-running managed dashboard was actually started with.
    /// Differs from `enabled` only between a toggle and the runtime restart
    /// that applies it.
    pub effective: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetYoloModeInput {
    pub enabled: bool,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetYoloModeResult {
    pub ok: bool,
    /// Persisted preference after this call.
    pub enabled: bool,
    /// Effective runtime state after this call.
    pub effective: bool,
    /// Whether the managed runtime was restarted live (vs. applying on the next
    /// desktop launch).
    pub restarted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_base_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gateway_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

fn host_and_port() -> (String, u16) {
    let host = std::env::var("HERMES_DESKTOP_API_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let port = std::env::var("HERMES_DESKTOP_API_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(dashboard::DEFAULT_DESKTOP_DASHBOARD_PORT);
    (host, port)
}

#[tauri::command]
pub fn get_yolo_mode(state: State<'_, AppState>) -> Result<YoloModeStatus, AppError> {
    let inner = state.inner.lock()?;
    Ok(YoloModeStatus {
        enabled: crate::ui_store::yolo_mode_enabled(&inner.hermes_home),
        effective: inner.yolo_mode,
    })
}

#[tauri::command]
pub async fn set_yolo_mode(
    input: SetYoloModeInput,
    state: State<'_, AppState>,
) -> Result<SetYoloModeResult, AppError> {
    let enabled = input.enabled;

    // Snapshot preconditions and persist the preference up front so it survives
    // a restart regardless of what happens to the live process.
    let (hermes_home, owns_process) = {
        let inner = state.inner.lock()?;
        if inner.switch_profile_in_flight {
            return Ok(SetYoloModeResult {
                ok: false,
                enabled: crate::ui_store::yolo_mode_enabled(&inner.hermes_home),
                effective: inner.yolo_mode,
                error: Some("运行时正在切换中，请稍后再试".to_string()),
                ..Default::default()
            });
        }
        let owns = inner
            .dashboard_handle
            .as_ref()
            .map(|h| h.owns_process)
            .unwrap_or(false);
        (inner.hermes_home.clone(), owns)
    };

    crate::ui_store::set_yolo_mode(&hermes_home, enabled)?;

    // If we don't own the dashboard process (e.g. dev mode attached to an
    // external dashboard), we can't restart it — the toggle applies on the next
    // desktop launch.
    if !owns_process {
        let inner = state.inner.lock()?;
        return Ok(SetYoloModeResult {
            ok: true,
            enabled,
            effective: inner.yolo_mode,
            restarted: false,
            ..Default::default()
        });
    }

    {
        let mut inner = state.inner.lock()?;
        inner.switch_profile_in_flight = true;
    }

    let result = restart_for_yolo(&state, &hermes_home, enabled).await;

    {
        let mut inner = state.inner.lock()?;
        inner.switch_profile_in_flight = false;
    }

    Ok(result)
}

/// Stop the desktop-owned dashboard and respawn it against the same
/// HERMES_HOME so the freshly-persisted YOLO preference is picked up by
/// `spawn_dashboard`.
async fn restart_for_yolo(
    state: &State<'_, AppState>,
    hermes_home: &str,
    enabled: bool,
) -> SetYoloModeResult {
    let (host, port) = host_and_port();

    // 1. Stop the running dashboard.
    {
        let mut inner = match state.inner.lock() {
            Ok(i) => i,
            Err(e) => {
                return SetYoloModeResult {
                    ok: false,
                    enabled,
                    error: Some(e.to_string()),
                    ..Default::default()
                }
            }
        };
        if let Some(stop) = inner.gateway_sse_stop.take() {
            stop.store(true, Ordering::Relaxed);
        }
        let session_token = inner.session_token.clone();
        if let Some(ref mut handle) = inner.dashboard_handle {
            handle.stop_with_token(session_token.as_deref());
        }
        inner.dashboard_handle = None;
    }

    tokio::time::sleep(std::time::Duration::from_millis(800)).await;

    // 2. Respawn against the same HERMES_HOME.
    let handle = match dashboard::ensure_hermes_dashboard(dashboard::EnsureDashboardOptions {
        host: host.clone(),
        port,
        hermes_home: hermes_home.to_string(),
        allow_external_agent: dashboard::external_agent_allowed(),
        allow_port_fallback: true,
    })
    .await
    {
        Ok(h) => h,
        Err(e) => {
            log::error!("Failed to restart dashboard after YOLO toggle: {}", e);
            let effective = state.inner.lock().map(|i| i.yolo_mode).unwrap_or(false);
            return SetYoloModeResult {
                ok: false,
                enabled,
                effective,
                restarted: false,
                error: Some(format!(
                    "已保存 YOLO 设置，但重启内核失败：{}。重启桌面端后生效。",
                    e
                )),
                ..Default::default()
            };
        }
    };

    // 3. Fetch a fresh token (process-local, rotates on restart) and update
    //    state so the renderer can reconnect.
    let env_token = std::env::var("HERMES_DESKTOP_SESSION_TOKEN").ok();
    let token = match env_token {
        Some(t) => Some(t),
        None => dashboard::fetch_session_token(&handle.api_base_url).await,
    };
    let gateway_url = dashboard::build_gateway_url(&handle.api_base_url, token.as_deref());
    let api_base_url = handle.api_base_url.clone();
    let effective = dashboard::yolo_mode_effective(hermes_home);

    {
        let mut inner = match state.inner.lock() {
            Ok(i) => i,
            Err(e) => {
                return SetYoloModeResult {
                    ok: false,
                    enabled,
                    error: Some(e.to_string()),
                    ..Default::default()
                }
            }
        };
        inner.api_base_url = handle.api_base_url.clone();
        inner.gateway_url = gateway_url.clone();
        inner.session_token = token.clone();
        inner.yolo_mode = effective;
        inner.dashboard_handle = Some(handle);
    }

    SetYoloModeResult {
        ok: true,
        enabled,
        effective,
        restarted: true,
        api_base_url: Some(api_base_url),
        gateway_url: Some(gateway_url),
        session_token: token,
        error: None,
    }
}
