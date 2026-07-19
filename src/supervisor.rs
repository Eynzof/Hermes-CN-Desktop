//! Background supervisor for the desktop-managed dashboard (and the gateway it
//! serves). Without it, a crashed managed runtime stays down until the user
//! notices and manually restarts — and historically the restart button itself
//! was broken (Eynzof/Hermes-CN-Desktop#224), so a crash meant a dead gateway
//! with no in-app recovery. This polls the owned child process and respawns it
//! when it dies unexpectedly.
//!
//! Scope guards (it must never fight the user or storm-restart):
//! - Only acts in `ConnectionMode::Managed` on a desktop-owned child. Attached
//!   local/remote dashboards are the user's to manage.
//! - Respects `dashboard_restart_in_flight`, so a manual restart / profile
//!   switch / YOLO toggle / runtime update is never raced.
//! - Caps consecutive crash-loop restarts; a runtime that keeps dying on boot
//!   (bad config, antivirus kill) is left down with a surfaced error instead of
//!   being hammered forever.

use std::time::{Duration, Instant};

use tauri::Manager;

use crate::commands::restart;
use crate::connection::ConnectionMode;
use crate::state::AppState;

fn release_dashboard_port_locks(state: &AppState) {
    if let Ok(mut inner) = state.inner.lock() {
        if let Some(handle) = inner.dashboard_handle.as_mut() {
            if let Some(locks) = handle.port_locks.take() {
                for lock in locks {
                    lock.release();
                }
            }
        }
    }
}

const POLL_INTERVAL: Duration = Duration::from_secs(5);
/// A respawn is "consecutive" (part of a crash loop) when the previous one was
/// more recent than this. A dashboard that stays up longer resets the counter.
const HEALTHY_WINDOW: Duration = Duration::from_secs(60);
/// Give up auto-restarting after this many back-to-back crash-loop restarts.
const MAX_CONSECUTIVE_RESTARTS: u32 = 5;

pub async fn supervise_managed_dashboard(app: tauri::AppHandle) {
    let (host, port) = restart::host_and_port();
    let mut ticker = tokio::time::interval(POLL_INTERVAL);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    let mut consecutive: u32 = 0;
    let mut last_restart: Option<Instant> = None;

    loop {
        ticker.tick().await;
        let state = app.state::<AppState>();

        // Decide under the lock, then drop it before the async respawn. On a
        // detected unexpected death we claim the restart guard here so a manual
        // restart / profile switch can't race us on `dashboard_handle`.
        let target_home = {
            let mut inner = match state.inner.lock() {
                Ok(guard) => guard,
                Err(_) => continue,
            };
            if inner.connection_mode != ConnectionMode::Managed {
                continue;
            }
            if crate::desktop_control::read().managed_runtime_desired_state
                != crate::desktop_control::ManagedRuntimeDesiredState::Running
            {
                continue;
            }
            if inner.dashboard_restart_in_flight {
                continue;
            }
            let exited = match inner.dashboard_handle.as_mut() {
                Some(handle) if handle.owns_process => match handle.child.as_mut() {
                    // `Ok(Some(_))` means the process has already exited. A live
                    // (or still-booting) child returns `Ok(None)`, so this never
                    // false-positives during startup.
                    Some(child) => matches!(child.try_wait(), Ok(Some(_))),
                    None => false,
                },
                _ => false,
            };
            if !exited {
                // Healthy. The crash-loop counter is reset by the HEALTHY_WINDOW
                // check below whenever the next real restart is far enough out.
                continue;
            }
            inner.dashboard_restart_in_flight = true;
            // Release port locks held by the dying handle before respawn so
            // ensure_hermes_dashboard can reclaim the same port set.
            if let Some(handle) = inner.dashboard_handle.as_mut() {
                if let Some(locks) = handle.port_locks.take() {
                    for lock in locks {
                        lock.release();
                    }
                }
            }
            inner.hermes_home.clone()
        };

        let now = Instant::now();
        consecutive = match last_restart {
            Some(prev) if now.duration_since(prev) < HEALTHY_WINDOW => consecutive + 1,
            _ => 1,
        };

        if consecutive > MAX_CONSECUTIVE_RESTARTS {
            log::error!(
                "Managed dashboard crashed {} times in a row; pausing auto-restart.",
                consecutive - 1
            );
            if let Ok(mut inner) = state.inner.lock() {
                inner.dashboard_restart_in_flight = false;
                inner.last_runtime_error = Some(
                    "网关多次启动失败，已暂停自动重启。请手动重启，或检查配置 / 杀毒软件是否拦截。"
                        .to_string(),
                );
            }
            // Crash-loop abort: release port locks so a manual restart can
            // reclaim the ports without waiting for the desktop to exit.
            release_dashboard_port_locks(&state);
            return;
        }

        log::warn!(
            "Managed dashboard exited unexpectedly; auto-restarting (attempt {}/{}).",
            consecutive,
            MAX_CONSECUTIVE_RESTARTS
        );
        last_restart = Some(now);

        let result =
            restart::respawn_managed_dashboard(&state, &host, port, &target_home, &target_home)
                .await;
        restart::end_restart(&state);

        match result {
            Ok(res) => match res.outcome {
                restart::RespawnOutcome::Spawned => {
                    log::info!("Managed dashboard auto-restarted.");
                }
                restart::RespawnOutcome::Recovered { error } => {
                    log::warn!(
                        "Managed dashboard auto-restart recovered after error: {}",
                        error
                    );
                }
                restart::RespawnOutcome::Down {
                    error,
                    recovery_error,
                } => {
                    log::error!(
                        "Managed dashboard auto-restart failed: {} / {}",
                        error,
                        recovery_error
                    );
                }
            },
            Err(e) => log::error!("Managed dashboard auto-restart errored: {}", e),
        }
    }
}
