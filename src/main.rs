// Hermes Agent 中文社区桌面版 — Tauri v2 entry point.
//
// Equivalent of hermes-cn-ui-v1/apps/desktop/src/main/bootstrap.ts + main.ts.
// Resolves HERMES_HOME, reads sticky profile, ensures dashboard subprocess,
// fetches session token, registers all IPC commands, opens the main window.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;

use hermes_agent_cn::commands;
use hermes_agent_cn::commands::profiles::read_active_profile_sticky;
use hermes_agent_cn::process::{dashboard, runtime};
use hermes_agent_cn::state::{AppState, DashboardHandle};
use tauri::Emitter;

/// Emit a "runtime-status" event for the frontend overlay to consume.
/// Phases (in order along the happy path):
///   "installing" — managed runtime is being downloaded
///   "starting-dashboard" — runtime ready, spawning dashboard
///   "ready" — full bootstrap complete, frontend can mount the app
///   "error" — fatal; frontend should display message and offer retry
fn emit_runtime_status(app: &tauri::AppHandle, phase: &str, message: &str) {
    let _ = app.emit(
        "runtime-status",
        serde_json::json!({ "phase": phase, "message": message }),
    );
}

async fn install_bundled_runtime_for_bootstrap(
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
        log::error!("Bundled runtime install failed: {}", msg);
        {
            use tauri::Manager;
            let state = app.state::<AppState>();
            if let Ok(mut inner) = state.inner.lock() {
                inner.last_runtime_error = Some(format!("内置 runtime 安装失败: {}", msg));
            };
        }
        emit_runtime_status(app, "error", &format!("内置 runtime 安装失败: {}", msg));
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

fn shutdown_owned_runtime(app: &tauri::AppHandle, reason: &str) {
    use tauri::Manager;

    let state = app.state::<AppState>();
    let (sse_stop, mut dashboard_handle, session_token) = match state.inner.lock() {
        Ok(mut inner) => (
            inner.gateway_sse_stop.take(),
            inner.dashboard_handle.take(),
            inner.session_token.clone(),
        ),
        Err(err) => {
            log::warn!(
                "Failed to lock app state during {} shutdown: {}",
                reason,
                err
            );
            return;
        }
    };

    if let Some(stop) = sse_stop {
        stop.store(true, Ordering::Relaxed);
    }

    if let Some(ref mut handle) = dashboard_handle {
        log::info!(
            "Stopping desktop-owned dashboard during {} (api={}, owns_process={}, marker={:?})",
            reason,
            handle.api_base_url,
            handle.owns_process,
            handle.ownership_marker_path
        );
        handle.stop_with_token(session_token.as_deref());
    }
}

fn create_and_return(path: PathBuf) -> PathBuf {
    let _ = fs::create_dir_all(&path);
    path
}

fn resolve_hermes_home() -> PathBuf {
    if std::env::var_os("HERMES_DESKTOP_HERMES_HOME").is_some()
        || std::env::var_os("HERMES_HOME").is_some()
    {
        log::warn!(
            "Ignoring external HERMES_HOME overrides; desktop uses isolated managed runtime home"
        );
    }

    create_and_return(runtime::hermes_home_dir())
}

fn profile_hermes_home(base: &Path, profile: &str) -> PathBuf {
    if profile == "default" {
        base.to_path_buf()
    } else {
        base.join("profiles").join(profile)
    }
}

fn main() {
    env_logger::init();

    let app_state = AppState::new();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .manage(app_state)
        .setup(|app| {
            use tauri::Manager;
            let state = app.state::<AppState>();
            let bundled_resource_dir = app.path().resource_dir().ok();

            // 1. Resolve HERMES_HOME
            let hermes_home_base = resolve_hermes_home();
            let base_str = hermes_home_base.to_string_lossy().to_string();

            // 2. Read sticky active profile
            let mut current_profile = read_active_profile_sticky(&base_str);
            let mut boot_home = profile_hermes_home(&hermes_home_base, &current_profile);

            if current_profile != "default" && !boot_home.exists() {
                log::warn!(
                    "active_profile points to missing {}; falling back to default",
                    current_profile
                );
                current_profile = "default".to_string();
                boot_home = hermes_home_base.clone();
                let _ = fs::remove_file(hermes_home_base.join("active_profile"));
            }

            let boot_home_str = boot_home.to_string_lossy().to_string();

            // 3. Resolve host/port
            let host = std::env::var("HERMES_DESKTOP_API_HOST")
                .unwrap_or_else(|_| "127.0.0.1".to_string());
            let port: u16 = std::env::var("HERMES_DESKTOP_API_PORT")
                .ok()
                .and_then(|p| p.parse().ok())
                .unwrap_or(dashboard::DEFAULT_DESKTOP_DASHBOARD_PORT);

            // 4. Bootstrap dashboard outside setup's critical path so the
            // window can appear immediately. Set HERMES_DESKTOP_SYNC_BOOTSTRAP
            // only as an emergency fallback to the old blocking path.
            let is_dev = std::env::var("HERMES_DESKTOP_DEV_URL").is_ok() || cfg!(debug_assertions);
            let async_bootstrap = std::env::var("HERMES_DESKTOP_SYNC_BOOTSTRAP").is_err();
            let external_dev_dashboard = is_dev && dashboard::dev_external_dashboard_enabled();
            let allow_external_agent = dashboard::external_agent_allowed();
            let allow_port_fallback = !is_dev;

            if async_bootstrap {
                {
                    let mut inner = state.inner.lock().unwrap();
                    inner.hermes_home = boot_home_str.clone();
                    inner.hermes_home_base = base_str.clone();
                    inner.current_profile = current_profile.clone();
                }

                let app_handle = app.handle().clone();
                let host_for_task = host.clone();
                let boot_home_for_task = boot_home_str.clone();
                let base_for_task = base_str.clone();
                let profile_for_task = current_profile.clone();
                let resource_dir_for_task = bundled_resource_dir.clone();

                tauri::async_runtime::spawn(async move {
                    let handle = if external_dev_dashboard {
                        let api_base_url = dashboard::dashboard_base_url(&host_for_task, port);
                        if !dashboard::probe_dashboard(&api_base_url).await {
                            log::warn!(
                                "External dev dashboard mode: dashboard not reachable at {}",
                                api_base_url
                            );
                        }
                        DashboardHandle {
                            api_base_url,
                            owns_process: false,
                            command_program: None,
                            command_args: vec![],
                            gateway_runtime_dir: None,
                            gateway_lock_dir: None,
                            ownership_marker_path: None,
                            ownership_state: Some("external-dev".to_string()),
                            job_handle: None,
                            child: None,
                        }
                    } else {
                        if !install_bundled_runtime_for_bootstrap(
                            &app_handle,
                            resource_dir_for_task.as_deref(),
                        )
                        .await
                        {
                            return;
                        }

                        let info = runtime::get_runtime_info(None);
                        let needs_install = info.current.is_none() && info.updates_configured;

                        if needs_install {
                            emit_runtime_status(
                                &app_handle,
                                "installing",
                                "正在下载 hermes-agent-cn runtime...",
                            );
                            log::info!("Background bootstrap: install_runtime_update");
                            let install = runtime::install_runtime_update(None).await;
                            if !install.ok {
                                let msg = install
                                    .error
                                    .clone()
                                    .unwrap_or_else(|| "unknown install error".into());
                                log::error!("Bootstrap install failed: {}", msg);
                                {
                                    use tauri::Manager;
                                    let state = app_handle.state::<AppState>();
                                    if let Ok(mut inner) = state.inner.lock() {
                                        inner.last_runtime_error =
                                            Some(format!("runtime 安装失败: {}", msg));
                                    };
                                }
                                emit_runtime_status(
                                    &app_handle,
                                    "error",
                                    &format!("runtime 安装失败: {}", msg),
                                );
                                return;
                            }
                            if let Some(installed) = &install.installed {
                                log::info!(
                                    "Installed managed runtime v{}",
                                    installed.runtime_version
                                );
                            }
                        } else if info.current.is_none() {
                            log::warn!(
                                "No managed runtime installed and update channel \
                                 is not configured. PATH `hermes` fallback is disabled; \
                                 dashboard startup will fail until a managed runtime is installed."
                            );
                        }
                        if let Err(err) = runtime::sync_runtime_resources_if_available(
                            resource_dir_for_task.as_deref(),
                        ) {
                            log::warn!("Failed to sync bundled runtime resources: {}", err);
                        }

                        emit_runtime_status(
                            &app_handle,
                            "starting-dashboard",
                            "正在启动 dashboard...",
                        );
                        match dashboard::ensure_hermes_dashboard(
                            dashboard::EnsureDashboardOptions {
                                host: host_for_task,
                                port,
                                hermes_home: boot_home_for_task.clone(),
                                allow_external_agent,
                                allow_port_fallback,
                            },
                        )
                        .await
                        {
                            Ok(h) => h,
                            Err(e) => {
                                log::error!("Bootstrap dashboard ensure failed: {}", e);
                                let msg = format!("dashboard 启动失败: {}", e);
                                {
                                    use tauri::Manager;
                                    let state = app_handle.state::<AppState>();
                                    if let Ok(mut inner) = state.inner.lock() {
                                        inner.last_runtime_error = Some(msg.clone());
                                    };
                                }
                                emit_runtime_status(&app_handle, "error", &msg);
                                return;
                            }
                        }
                    };

                    if !dashboard::dashboard_supports_sse(&handle.api_base_url).await {
                        log::error!(
                            "Dashboard at {} lacks /api/v2/events (P-009 patch missing). \
                             SSE transport will fail; set HERMES_TRANSPORT=ws in the \
                             UI store as a workaround, or upgrade the agent \
                             to a hermes-agent-cn build with the P-009 patch applied. \
                             See https://github.com/Eynzof/hermes-agent-cn-desktop/blob/main/docs/managed-runtime.md",
                            handle.api_base_url
                        );
                    }

                    let env_token = std::env::var("HERMES_DESKTOP_SESSION_TOKEN").ok();
                    let session_token = match env_token {
                        Some(t) => Some(t),
                        None => dashboard::fetch_session_token(&handle.api_base_url).await,
                    };
                    let gateway_url = dashboard::build_gateway_url(
                        &handle.api_base_url,
                        session_token.as_deref(),
                    );

                    {
                        use tauri::Manager;
                        let state = app_handle.state::<AppState>();
                        let mut inner = state.inner.lock().unwrap();
                        inner.api_base_url = handle.api_base_url.clone();
                        inner.gateway_url = gateway_url;
                        inner.hermes_home = boot_home_for_task;
                        inner.hermes_home_base = base_for_task;
                        inner.session_token = session_token;
                        inner.current_profile = profile_for_task;
                        inner.dashboard_handle = Some(handle);
                    }

                    emit_runtime_status(&app_handle, "ready", "");
                    log::info!("Hermes Agent 中文社区桌面版 ready");
                });

                log::info!("Hermes Agent 中文社区桌面版 bootstrapping in background");
                Ok(())
            } else {
                let handle = if external_dev_dashboard {
                    let api_base_url = dashboard::dashboard_base_url(&host, port);
                    let alive =
                        tauri::async_runtime::block_on(dashboard::probe_dashboard(&api_base_url));
                    if !alive {
                        log::warn!(
                            "External dev dashboard mode: dashboard not reachable at {}",
                            api_base_url
                        );
                    }
                    DashboardHandle {
                        api_base_url,
                        owns_process: false,
                        command_program: None,
                        command_args: vec![],
                        gateway_runtime_dir: None,
                        gateway_lock_dir: None,
                        ownership_marker_path: None,
                        ownership_state: Some("external-dev".to_string()),
                        job_handle: None,
                        child: None,
                    }
                } else {
                    if !tauri::async_runtime::block_on(install_bundled_runtime_for_bootstrap(
                        app.handle(),
                        bundled_resource_dir.as_deref(),
                    )) {
                        return Ok(());
                    }

                    let info = runtime::get_runtime_info(None);
                    let needs_install = info.current.is_none() && info.updates_configured;

                    if needs_install {
                        // First-run with the update channel configured but no
                        // managed runtime on disk yet. The honest UX is "open the
                        // window now, show progress, finish boot in the background"
                        // rather than freezing for 10-30s on the first launch.
                        //
                        // We seed AppState with only the static fields the UI
                        // needs while it waits (HERMES_HOME, profile name), spawn
                        // a task to do install → ensure → token → state update,
                        // and emit `runtime-status` events the frontend's overlay
                        // listens for. The webview shows a Chinese-language
                        // status screen until the task emits phase="ready".
                        // See web/src/lib/tauri-bridge.ts.
                        let app_handle = app.handle().clone();
                        let host_for_task = host.clone();
                        let boot_home_for_task = boot_home_str.clone();
                        let base_for_task = base_str.clone();
                        let profile_for_task = current_profile.clone();
                        let resource_dir_for_task = bundled_resource_dir.clone();

                        tauri::async_runtime::spawn(async move {
                            emit_runtime_status(
                                &app_handle,
                                "installing",
                                "正在下载 hermes-agent-cn runtime...",
                            );
                            log::info!("Background bootstrap: install_runtime_update");
                            let install = runtime::install_runtime_update(None).await;
                            if !install.ok {
                                let msg = install
                                    .error
                                    .clone()
                                    .unwrap_or_else(|| "unknown install error".into());
                                log::error!("Bootstrap install failed: {}", msg);
                                {
                                    use tauri::Manager;
                                    let state = app_handle.state::<AppState>();
                                    if let Ok(mut inner) = state.inner.lock() {
                                        inner.last_runtime_error =
                                            Some(format!("runtime 安装失败: {}", msg));
                                    };
                                }
                                emit_runtime_status(
                                    &app_handle,
                                    "error",
                                    &format!("runtime 安装失败: {}", msg),
                                );
                                return;
                            }
                            if let Some(installed) = &install.installed {
                                log::info!(
                                    "Installed managed runtime v{}",
                                    installed.runtime_version
                                );
                            }
                            if let Err(err) = runtime::sync_runtime_resources_if_available(
                                resource_dir_for_task.as_deref(),
                            ) {
                                log::warn!("Failed to sync bundled runtime resources: {}", err);
                            }

                            emit_runtime_status(
                                &app_handle,
                                "starting-dashboard",
                                "正在启动 dashboard...",
                            );
                            let handle = match dashboard::ensure_hermes_dashboard(
                                dashboard::EnsureDashboardOptions {
                                    host: host_for_task,
                                    port,
                                    hermes_home: boot_home_for_task.clone(),
                                    allow_external_agent,
                                    allow_port_fallback,
                                },
                            )
                            .await
                            {
                                Ok(h) => h,
                                Err(e) => {
                                    log::error!("Bootstrap dashboard ensure failed: {}", e);
                                    let msg = format!("dashboard 启动失败: {}", e);
                                    {
                                        use tauri::Manager;
                                        let state = app_handle.state::<AppState>();
                                        if let Ok(mut inner) = state.inner.lock() {
                                            inner.last_runtime_error = Some(msg.clone());
                                        };
                                    }
                                    emit_runtime_status(&app_handle, "error", &msg);
                                    return;
                                }
                            };

                            if !dashboard::dashboard_supports_sse(&handle.api_base_url).await {
                                log::error!(
                                    "Bootstrap installed runtime at {} but it lacks \
                                 /api/v2/events — likely a packaging bug in the \
                                 release manifest.",
                                    handle.api_base_url
                                );
                            }

                            let env_token = std::env::var("HERMES_DESKTOP_SESSION_TOKEN").ok();
                            let session_token = match env_token {
                                Some(t) => Some(t),
                                None => dashboard::fetch_session_token(&handle.api_base_url).await,
                            };
                            let gateway_url = dashboard::build_gateway_url(
                                &handle.api_base_url,
                                session_token.as_deref(),
                            );

                            {
                                use tauri::Manager;
                                let state = app_handle.state::<AppState>();
                                let mut inner = state.inner.lock().unwrap();
                                inner.api_base_url = handle.api_base_url.clone();
                                inner.gateway_url = gateway_url;
                                inner.hermes_home = boot_home_for_task;
                                inner.hermes_home_base = base_for_task;
                                inner.session_token = session_token;
                                inner.current_profile = profile_for_task;
                                inner.dashboard_handle = Some(handle);
                            }

                            emit_runtime_status(&app_handle, "ready", "");
                            log::info!(
                                "Hermes Agent 中文社区桌面版 ready (after background install)"
                            );
                        });

                        // Seed AppState with what the UI needs while it waits. The
                        // bridge's `get_runtime_config` will return empty
                        // apiBaseUrl/gatewayUrl until the background task fills
                        // them in; the bridge waits on `runtime-status` ready
                        // before mounting the React app.
                        {
                            let mut inner = state.inner.lock().unwrap();
                            inner.hermes_home = boot_home_str;
                            inner.hermes_home_base = base_str;
                            inner.current_profile = current_profile;
                        }
                        log::info!("Hermes Agent 中文社区桌面版 bootstrapping in background");
                        return Ok(());
                    }

                    // No install needed (managed runtime already present, or
                    // update channel not configured). Fall through to the
                    // blocking happy path — fast on a normal launch.
                    if info.current.is_none() {
                        log::warn!(
                            "No managed runtime installed and update channel \
                         is not configured. PATH `hermes` fallback is disabled; \
                         dashboard startup will fail until a managed runtime is installed."
                        );
                    }
                    if let Err(err) =
                        runtime::sync_runtime_resources_if_available(bundled_resource_dir.as_deref())
                    {
                        log::warn!("Failed to sync bundled runtime resources: {}", err);
                    }

                    match tauri::async_runtime::block_on(dashboard::ensure_hermes_dashboard(
                        dashboard::EnsureDashboardOptions {
                            host: host.clone(),
                            port,
                            hermes_home: boot_home_str.clone(),
                            allow_external_agent,
                            allow_port_fallback,
                        },
                    )) {
                        Ok(h) => h,
                        Err(e) => {
                            log::error!("Failed to start dashboard: {}", e);
                            return Err(
                                Box::new(std::io::Error::other(e)) as Box<dyn std::error::Error>
                            );
                        }
                    }
                };

                // 4b. P-009 probe: the desktop's default transport is SSE
                // (gateway-client.ts:572). If the dashboard lacks `/api/v2/events`
                // the UI will hit "SSE closed during connect" the moment it tries
                // to send a message. Surface a clear warning at startup so users
                // and bug reports know the root cause rather than chasing the
                // opaque error. See managed runtime compatibility notes.
                let supports_sse = tauri::async_runtime::block_on(
                    dashboard::dashboard_supports_sse(&handle.api_base_url),
                );
                if !supports_sse {
                    log::error!(
                        "Dashboard at {} lacks /api/v2/events (P-009 patch missing). \
                     SSE transport will fail; set HERMES_TRANSPORT=ws in the \
                     UI store as a workaround, or upgrade the agent \
                     to a hermes-agent-cn build with the P-009 patch applied. \
                     See https://github.com/Eynzof/hermes-agent-cn-desktop/blob/main/docs/managed-runtime.md",
                        handle.api_base_url
                    );
                }

                // 5. Fetch session token
                let env_token = std::env::var("HERMES_DESKTOP_SESSION_TOKEN").ok();
                let session_token = match env_token {
                    Some(t) => Some(t),
                    None => tauri::async_runtime::block_on(dashboard::fetch_session_token(
                        &handle.api_base_url,
                    )),
                };

                let gateway_url =
                    dashboard::build_gateway_url(&handle.api_base_url, session_token.as_deref());

                // 6. Populate state
                {
                    let mut inner = state.inner.lock().unwrap();
                    inner.api_base_url = handle.api_base_url.clone();
                    inner.gateway_url = gateway_url;
                    inner.hermes_home = boot_home_str;
                    inner.hermes_home_base = base_str;
                    inner.session_token = session_token;
                    inner.current_profile = current_profile;
                    inner.dashboard_handle = Some(handle);
                }

                // Emit "ready" immediately on the happy path so the bridge's
                // event listener (which is unconditional in tauri-bridge.ts)
                // can also unblock here — even though we never went through
                // the "installing" phase.
                emit_runtime_status(app.handle(), "ready", "");

                log::info!("Hermes Agent 中文社区桌面版 ready");
                Ok(())
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::gateway::get_runtime_config,
            commands::gateway::refresh_gateway_url,
            commands::im_onboarding::im_onboarding_state,
            commands::im_onboarding::im_onboarding_begin,
            commands::im_onboarding::im_onboarding_poll,
            commands::im_onboarding::im_onboarding_apply,
            commands::file_dialogs::pick_files,
            commands::file_dialogs::pick_directory,
            commands::file_dialogs::create_workspace_project,
            commands::file_dialogs::open_workspace_path,
            commands::api_proxy::api_request,
            commands::api_proxy::external_request,
            commands::api_proxy::upload_file,
            commands::runtime_manager::runtime_info,
            commands::runtime_manager::runtime_check_update,
            commands::runtime_manager::runtime_install_update,
            commands::runtime_manager::runtime_rollback,
            commands::profiles::switch_profile,
            commands::skills::read_skill_markdown,
            commands::memory::read_memory,
            commands::memory::add_memory_entry,
            commands::memory::update_memory_entry,
            commands::memory::remove_memory_entry,
            commands::memory::write_user_profile,
            commands::sse_proxy::connect_gateway_sse,
            commands::ui_store::ui_store_snapshot,
            commands::ui_store::ui_store_set_kv,
            commands::ui_store::ui_store_remove_kv,
            commands::ui_store::ui_store_record_turn_stats,
            commands::ui_store::ui_store_get_turn_stats,
            commands::ui_store::ui_store_record_event,
            commands::terminal::terminal_start,
            commands::terminal::terminal_write,
            commands::terminal::terminal_resize,
            commands::terminal::terminal_close,
        ])
        .on_window_event(|_window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                log::info!("Main window destroyed");
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building Hermes Agent 中文社区桌面版");

    app.run(|app_handle, event| {
        if let tauri::RunEvent::Exit = event {
            shutdown_owned_runtime(app_handle, "app exit");
        }
    });
}
