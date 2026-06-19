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

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands::restart::{self, RespawnOutcome};
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

#[tauri::command]
pub fn get_yolo_mode(state: State<'_, AppState>) -> Result<YoloModeStatus, AppError> {
    let inner = state.inner.lock()?;
    // YOLO is a launch flag of the desktop-owned managed runtime; attached
    // local/remote agents decide their own approval policy.
    if inner.connection_mode != crate::connection::ConnectionMode::Managed {
        return Ok(YoloModeStatus {
            enabled: false,
            effective: false,
        });
    }
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
        // Don't persist a preference while attached to another agent — it
        // wouldn't affect that process, and would surprise the user on the
        // next managed-runtime boot.
        if inner.connection_mode != crate::connection::ConnectionMode::Managed {
            return Ok(SetYoloModeResult {
                ok: false,
                enabled: false,
                effective: false,
                error: Some("当前连接的不是本机内核，YOLO 模式由当前后端自行配置".to_string()),
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

    // Claim the shared restart guard so a profile switch and a YOLO toggle can't
    // race two stop+respawn sequences on the same dashboard handle.
    if !restart::try_begin_restart(&state)? {
        let inner = state.inner.lock()?;
        return Ok(SetYoloModeResult {
            ok: false,
            enabled: crate::ui_store::yolo_mode_enabled(&inner.hermes_home),
            effective: inner.yolo_mode,
            error: Some("运行时正在切换中，请稍后再试".to_string()),
            ..Default::default()
        });
    }

    let result = restart_for_yolo(&state, &hermes_home, enabled).await;

    restart::end_restart(&state);

    Ok(result)
}

/// Respawn the desktop-owned dashboard so the freshly-persisted YOLO preference
/// is picked up by `spawn_dashboard`. Delegates the stop+spawn+recovery dance to
/// the shared [`restart::respawn_managed_dashboard`] primitive; the recovery
/// home is the same HERMES_HOME, so a transient first-spawn failure that
/// recovers still ends up running with the new preference.
async fn restart_for_yolo(
    state: &State<'_, AppState>,
    hermes_home: &str,
    enabled: bool,
) -> SetYoloModeResult {
    let (host, port) = restart::host_and_port();

    let respawn = match restart::respawn_managed_dashboard(
        state,
        &host,
        port,
        hermes_home,
        hermes_home,
    )
    .await
    {
        Ok(r) => r,
        Err(e) => {
            return SetYoloModeResult {
                ok: false,
                enabled,
                error: Some(e.to_string()),
                ..Default::default()
            }
        }
    };

    match respawn.outcome {
        // For YOLO the recovery home is the same home, so a recovered spawn also
        // booted with the new preference — treat both as success.
        RespawnOutcome::Spawned | RespawnOutcome::Recovered { .. } => {
            let effective = dashboard::yolo_mode_effective(hermes_home);
            if let Ok(mut inner) = state.inner.lock() {
                inner.yolo_mode = effective;
            }
            SetYoloModeResult {
                ok: true,
                enabled,
                effective,
                restarted: true,
                api_base_url: respawn.api_base_url,
                gateway_url: respawn.gateway_url,
                session_token: respawn.session_token,
                error: None,
            }
        }
        RespawnOutcome::Down {
            error,
            recovery_error,
        } => {
            // No runtime is running, so nothing is enforcing (or bypassing)
            // approvals — report effective=false rather than the stale value.
            if let Ok(mut inner) = state.inner.lock() {
                inner.yolo_mode = false;
            }
            SetYoloModeResult {
                ok: false,
                enabled,
                effective: false,
                restarted: false,
                error: Some(format!(
                    "已保存 YOLO 设置，但重启内核失败：{error}（恢复也失败：{recovery_error}）。重启桌面端后生效。"
                )),
                ..Default::default()
            }
        }
    }
}
