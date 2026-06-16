// Shared bootstrap pipeline: bring up the backend the desktop talks to.
//
// Extracted from main.rs so the runtime connection-switch command
// (commands/connection.rs `apply_connection_config`) can reuse the exact same
// local-acquire path (env check → bundled/managed runtime install → resource
// sync → dashboard spawn) when flipping remote → local, including the
// "no managed runtime on disk yet" first-install case.
//
// Three backend shapes come out of here:
//   - managed: a desktop-owned `hermes dashboard` subprocess (acquire_managed_dashboard)
//   - local: an attach-only handle to a loopback Hermes Agent CLI dashboard
//   - remote: an attach-only handle to a remote Hermes Agent

use std::path::{Path, PathBuf};

use tauri::Emitter;

use crate::connection::{ConnectionMode, LocalBackend, RemoteBackend};
use crate::environment;
use crate::process::{dashboard, runtime};
use crate::state::{AppState, DashboardHandle};

/// Emit a "runtime-status" event for the frontend overlay to consume.
/// Phases (in order along the happy path):
///   "installing" — managed runtime is being downloaded
///   "starting-dashboard" — runtime ready, spawning dashboard (or, in remote
///                          mode, attaching to the remote agent)
///   "ready" — full bootstrap complete, frontend can mount the app
///   "error" — fatal; frontend should display message and offer retry
pub fn emit_runtime_status(app: &tauri::AppHandle, phase: &str, message: &str) {
    let _ = app.emit(
        "runtime-status",
        serde_json::json!({ "phase": phase, "message": message }),
    );
}

/// Record a fatal bootstrap error: log it, stash it in AppState for the UI to
/// read, and emit a "runtime-status" error event. Returns the message so
/// callers can write `return Err(record_bootstrap_error(...))`.
pub fn record_bootstrap_error(app: &tauri::AppHandle, message: String) -> String {
    use tauri::Manager;
    log::error!("{}", message);
    let state = app.state::<AppState>();
    if let Ok(mut inner) = state.inner.lock() {
        inner.last_runtime_error = Some(message.clone());
    }
    emit_runtime_status(app, "error", &message);
    message
}

pub async fn install_bundled_runtime_for_bootstrap(
    app: &tauri::AppHandle,
    resource_dir: Option<&Path>,
) -> bool {
    if !runtime::bundled_runtime_available(resource_dir) {
        return true;
    }

    emit_runtime_status(app, "installing", "正在安装内置 hermes-agent-cn runtime...");
    log::info!("Bootstrap: install bundled runtime");
    let install = runtime::install_bundled_runtime_if_needed(resource_dir).await;
    if !install.ok {
        let msg = install
            .error
            .clone()
            .unwrap_or_else(|| "unknown bundled runtime install error".into());
        record_bootstrap_error(app, format!("内置 runtime 安装失败: {}", msg));
        return false;
    }

    if let Some(installed) = &install.installed {
        log::info!(
            "Installed bundled managed runtime v{}",
            installed.runtime_version
        );
    }
    true
}

/// Install the managed runtime if needed, sync bundled resources, and ensure
/// the dashboard process is running. Shared by every (non-external, non-remote)
/// bootstrap path. On failure the error is surfaced via
/// `record_bootstrap_error` and returned as `Err`.
///
/// `install_bundled` controls whether the bundled-runtime install runs here;
/// the synchronous fallback already does it up front and passes `false`.
pub async fn acquire_managed_dashboard(
    app: &tauri::AppHandle,
    options: dashboard::EnsureDashboardOptions,
    resource_dir: Option<PathBuf>,
    install_bundled: bool,
) -> Result<DashboardHandle, String> {
    emit_runtime_status(app, "checking-env", "正在检查本机环境...");
    // Resolve the user's real PATH (login shell / registry) before anything
    // spawns, so the dashboard and its MCP descendants inherit it.
    let _ = tauri::async_runtime::spawn_blocking(|| {
        crate::path_resolver::refresh_blocking(crate::path_resolver::SHELL_PROBE_TIMEOUT, true)
    })
    .await;
    if let Err(err) = environment::check_bootstrap_environment(&options.hermes_home) {
        return Err(record_bootstrap_error(app, err));
    }

    if install_bundled && !install_bundled_runtime_for_bootstrap(app, resource_dir.as_deref()).await
    {
        // install_bundled_runtime_for_bootstrap already recorded the error.
        return Err("bundled runtime install failed".to_string());
    }

    let info = runtime::get_runtime_info(None);
    if info.current.is_none() && info.updates_configured {
        emit_runtime_status(app, "installing", "正在下载 hermes-agent-cn runtime...");
        log::info!("Bootstrap: install_runtime_update");
        let install = runtime::install_runtime_update(None).await;
        if !install.ok {
            let msg = install
                .error
                .unwrap_or_else(|| "unknown install error".into());
            return Err(record_bootstrap_error(
                app,
                format!("runtime 安装失败: {}", msg),
            ));
        }
        if let Some(installed) = &install.installed {
            log::info!("Installed managed runtime v{}", installed.runtime_version);
        }
    } else if info.current.is_none() {
        log::warn!(
            "No managed runtime installed and update channel is not configured. \
             PATH `hermes` fallback is disabled; dashboard startup will fail \
             until a managed runtime is installed."
        );
    }

    if let Err(err) = runtime::sync_runtime_resources_if_available(resource_dir.as_deref()) {
        log::warn!("Failed to sync bundled runtime resources: {}", err);
    }

    emit_runtime_status(app, "starting-dashboard", "正在启动 dashboard...");
    dashboard::ensure_hermes_dashboard(options)
        .await
        .map_err(|e| record_bootstrap_error(app, format!("dashboard 启动失败: {}", e)))
}

/// Attach to a remote Hermes Agent: no runtime install, no spawn, no ownership
/// marker — just a reachability probe and an attach-only handle.
///
/// An unreachable remote is deliberately NOT a bootstrap error (unlike the
/// official Electron desktop, which hard-fails): an "error" runtime-status
/// would stop the React app from ever mounting, locking the user out of the
/// Settings page where a bad saved URL gets fixed. The gateway client's
/// reconnect UI surfaces unreachability once the app is up.
pub async fn connect_remote_backend(
    app: &tauri::AppHandle,
    remote: &RemoteBackend,
) -> DashboardHandle {
    emit_runtime_status(app, "starting-dashboard", "正在连接远程 Hermes Agent...");
    log::info!(
        "Remote mode ({}): attaching to {}",
        remote.source.as_str(),
        remote.base_url
    );
    if !dashboard::probe_dashboard(&remote.base_url).await {
        log::warn!(
            "Remote Hermes Agent not reachable at {} during bootstrap; continuing — \
             the gateway client retries and Settings → 连接 can fix the URL",
            remote.base_url
        );
    }
    DashboardHandle::remote(remote.base_url.clone(), remote.token.clone())
}

/// Attach to a local Hermes Agent CLI dashboard. The URL is already validated
/// as loopback by connection.rs; we best-effort fetch the current session token
/// from the served HTML so users do not have to paste it manually.
pub async fn connect_local_backend(
    app: &tauri::AppHandle,
    local: &LocalBackend,
) -> DashboardHandle {
    emit_runtime_status(
        app,
        "starting-dashboard",
        "正在连接本地 Hermes Agent CLI...",
    );
    log::info!("Local connection mode: attaching to {}", local.base_url);
    if !dashboard::probe_attached_dashboard(&local.base_url).await {
        log::warn!(
            "Local Hermes Agent CLI dashboard not reachable at {} during bootstrap; continuing — \
             Settings → 连接 can fix the URL or switch back to managed runtime",
            local.base_url
        );
    }
    let token = dashboard::fetch_session_token(&local.base_url).await;
    if token.is_none() {
        log::warn!(
            "Local Hermes Agent CLI dashboard at {} did not expose a session token",
            local.base_url
        );
    }
    DashboardHandle::local(local.base_url.clone(), token)
}

/// Finish bootstrap once a dashboard handle is available: fetch the session
/// token, build the gateway URL, populate AppState, and emit the "ready"
/// event the frontend waits on.
pub async fn finalize_bootstrap(
    app: &tauri::AppHandle,
    handle: DashboardHandle,
    hermes_home: String,
    hermes_home_base: String,
    profile: String,
    mode: ConnectionMode,
) {
    use tauri::Manager;

    let session_token = match handle.session_token.clone() {
        Some(token) => Some(token),
        // Remote handles always carry their token, so this dashboard scrape
        // fallback is only for managed or loopback-local dashboards.
        None => match std::env::var("HERMES_DESKTOP_SESSION_TOKEN")
            .ok()
            .or_else(|| std::env::var("HERMES_DASHBOARD_SESSION_TOKEN").ok())
        {
            Some(token) => Some(token),
            None => dashboard::fetch_session_token(&handle.api_base_url).await,
        },
    };
    let gateway_url = dashboard::build_gateway_url(&handle.api_base_url, session_token.as_deref());
    let (effective_home, effective_home_base, effective_profile) = if mode == ConnectionMode::Local
    {
        match dashboard::fetch_attached_dashboard_hermes_home(&handle.api_base_url)
            .await
            .filter(|h| !h.trim().is_empty())
        {
            Some(home) => (home.clone(), home, "default".to_string()),
            None => {
                log::warn!(
                    "Local dashboard at {} did not return hermes_home; keeping bootstrap home until Settings reconnect succeeds",
                    handle.api_base_url
                );
                (hermes_home, hermes_home_base, "default".to_string())
            }
        }
    } else {
        (hermes_home, hermes_home_base, profile)
    };

    {
        let state = app.state::<AppState>();
        let mut inner = state.inner.lock().unwrap();
        inner.api_base_url = handle.api_base_url.clone();
        inner.gateway_url = gateway_url;
        inner.hermes_home = effective_home;
        inner.hermes_home_base = effective_home_base;
        inner.session_token = session_token;
        inner.current_profile = effective_profile;
        inner.yolo_mode = match mode {
            ConnectionMode::Managed => dashboard::yolo_mode_effective(&inner.hermes_home),
            // YOLO is a managed-runtime launch flag; it has no meaning for a
            // backend this desktop doesn't own.
            ConnectionMode::Local | ConnectionMode::Remote => false,
        };
        inner.connection_mode = mode;
        inner.dashboard_handle = Some(handle);
    }

    emit_runtime_status(app, "ready", "");
    log::info!("Hermes Agent 中文社区桌面版 ready");
}
