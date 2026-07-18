// Hermes Agent 中文社区桌面版 — Tauri v2 entry point.
//
// Equivalent of hermes-cn-ui-v1/apps/desktop/src/main/bootstrap.ts + main.ts.
// Resolves HERMES_HOME, reads sticky profile, ensures dashboard subprocess,
// fetches session token, registers all IPC commands, opens the main window.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use hermes_agent_cn::bootstrap::{
    acquire_managed_dashboard, connect_local_backend, connect_remote_backend, finalize_bootstrap,
    finalize_offline_bootstrap, install_bundled_runtime_for_bootstrap, record_bootstrap_error,
};
use hermes_agent_cn::commands;
use hermes_agent_cn::commands::profiles::read_active_profile_sticky;
use hermes_agent_cn::connection::{self, ConnectionBackend, ConnectionMode};
use hermes_agent_cn::desktop_control;
use hermes_agent_cn::process::{dashboard, instance, runtime, ui_update};
use hermes_agent_cn::state::{AppState, DashboardHandle};
use hermes_agent_cn::tray;

/// Build a `DashboardHandle` describing an externally-managed dev dashboard we
/// merely attach to (and never spawn or own).
fn external_dev_handle(api_base_url: String) -> DashboardHandle {
    DashboardHandle {
        api_base_url,
        session_token: None,
        owns_process: false,
        command_program: None,
        command_args: vec![],
        gateway_runtime_dir: None,
        gateway_lock_dir: None,
        ownership_marker_path: None,
        ownership_state: Some("external-dev".to_string()),
        job_handle: None,
        attached_pid: None,
        child: None,
        port_locks: None,
    }
}

fn shutdown_owned_runtime(app: &tauri::AppHandle, reason: &str) {
    use tauri::Manager;

    let state = app.state::<AppState>();
    let (gateway_ws, mut dashboard_handle, session_token) = match state.inner.lock() {
        Ok(mut inner) => (
            inner.gateway_ws.take(),
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

    if let Some(relay) = gateway_ws {
        relay.abort.store(true, Ordering::Relaxed);
        relay.notify.notify_waiters();
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

    // Windows: keep the WebView2 user-data folder (network cache, IndexedDB,
    // service workers, GPU cache — all of which grow over time) under the same
    // converged runtime root as everything else, instead of letting it default
    // to %LOCALAPPDATA%\cn.org.hermesagent.desktop\EBWebView on C:. WebView2
    // honors WEBVIEW2_USER_DATA_FOLDER; it must be set before the webview
    // environment is created, so do it first thing in main().
    #[cfg(windows)]
    {
        let webview_dir = runtime::runtime_root().join("webview2");
        let _ = fs::create_dir_all(&webview_dir);
        std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", &webview_dir);
    }

    // Single-instance guard per runtime root (issue #366): a second launch
    // against the SAME data root focuses the incumbent window and exits;
    // distinct roots (portable copies side by side) keep coexisting. The
    // guard lives on main's stack so the lock is held until process exit.
    let _instance_guard = match instance::try_acquire() {
        instance::SingleInstance::Acquired(guard) => Some(guard),
        instance::SingleInstance::AlreadyRunning => {
            log::info!(
                "another desktop instance owns {}; requesting focus and exiting",
                runtime::runtime_root().display()
            );
            instance::notify_running_instance();
            return;
        }
        instance::SingleInstance::Unavailable(reason) => {
            // Fail open: the guard must never lock users out of their app.
            log::warn!("single-instance lock unavailable ({reason}); continuing");
            None
        }
    };

    let app_state = AppState::new();
    let quit_requested = Arc::new(AtomicBool::new(false));
    let close_quit_requested = Arc::clone(&quit_requested);
    let tray_available = Arc::new(AtomicBool::new(false));
    let setup_tray_available = Arc::clone(&tray_available);
    let close_tray_available = Arc::clone(&tray_available);

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        // UI hot-update channel (Track B): `hermesui://` serves the signed,
        // gated UI override from the writable tree, falling back per-file to
        // the embedded bundle (process/ui_update.rs::serve_ui_request). The
        // window only loads via this scheme when an override is installed, so
        // default installs behave exactly like the static embedded window.
        .register_asynchronous_uri_scheme_protocol("hermesui", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            let path = request.uri().path().to_string();
            tauri::async_runtime::spawn_blocking(move || {
                let response = ui_update::serve_ui_request(&app, &path);
                let http_response = tauri::http::Response::builder()
                    .status(response.status)
                    .header("content-type", response.mime)
                    .header("cache-control", response.cache_control)
                    .body(response.body)
                    .unwrap_or_else(|_| tauri::http::Response::new(Vec::new()));
                responder.respond(http_response);
            });
        })
        .manage(app_state)
        .setup(move |app| {
            use tauri::Manager;
            let state = app.state::<AppState>();
            let bundled_resource_dir = app.path().resource_dir().ok();

            // The main window is built in code (not tauri.conf.json) so the
            // startup URL can select the installed UI override. In dev, and
            // whenever no override passes the gates, WebviewUrl::App keeps
            // today's behavior exactly (devUrl in dev, embedded dist packed).
            let window_url = if !cfg!(dev) && ui_update::active_ui_dir().is_some() {
                commands::ui_update::UI_PROTOCOL_ENTRY_URL
                    .parse()
                    .map(tauri::WebviewUrl::CustomProtocol)
                    .unwrap_or_else(|_| tauri::WebviewUrl::App("index.html".into()))
            } else {
                tauri::WebviewUrl::App("index.html".into())
            };
            let window_builder = tauri::WebviewWindowBuilder::new(
                app,
                crate::tray::MAIN_WINDOW_LABEL,
                window_url,
            )
            .title("Hermes Agent 中文社区桌面版")
            .inner_size(1240.0, 820.0)
            .min_inner_size(960.0, 680.0);
            #[cfg(target_os = "macos")]
            let window_builder = window_builder.title_bar_style(tauri::TitleBarStyle::Transparent);
            window_builder.build()?;

            // Focus channel for the single-instance guard: consume any stale
            // request from a previous run, then watch for new ones. Armed
            // before dashboard bootstrap so a second launch gets its focus
            // handoff even while the kernel is still starting.
            instance::clear_stale_focus_request();
            instance::spawn_focus_watcher(app.handle().clone());

            match tray::install(app) {
                Ok(()) => {
                    setup_tray_available.store(true, Ordering::Relaxed);
                }
                Err(err) => {
                    log::warn!("Failed to install system tray: {}", err);
                }
            }

            // Data-root diagnostics: one line so support logs show where the
            // tree is anchored and whether the portable marker was honored.
            log::info!(
                "runtime root: {} (portable: {})",
                runtime::runtime_root().display(),
                runtime::portable_mode_active()
            );

            // macOS Gatekeeper App Translocation runs a quarantined app from a
            // randomized read-only path, which hides the portable marker next
            // to the real .app — a portable unzip would silently fall back to
            // ~/Library. One non-blocking heads-up tells the user how to fix
            // it (harmless generic advice for DMG installs too).
            #[cfg(target_os = "macos")]
            if std::env::current_exe()
                .map(|p| p.components().any(|c| c.as_os_str() == "AppTranslocation"))
                .unwrap_or(false)
            {
                use tauri_plugin_dialog::DialogExt;
                log::warn!(
                    "running from an App Translocation path; a portable marker (if any) is invisible"
                );
                app.dialog()
                    .message(
                        "应用正被 macOS 隔离机制（App Translocation）从临时路径运行。\n\n\
                         如果你使用的是免安装版（portable）：数据将无法保存到解压目录。\n\
                         请把解压出来的整个文件夹移动到其他位置后重新启动，\n\
                         或在终端执行：xattr -dr com.apple.quarantine <解压目录>\n\n\
                         普通安装版用户请将应用拖入「应用程序」文件夹后重新打开。",
                    )
                    .title("检测到 macOS 应用隔离")
                    .show(|_| {});
            }

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

            // 4. Bootstrap mode flags. The window appears immediately; the
            // dashboard is brought up off the critical path unless the
            // emergency HERMES_DESKTOP_SYNC_BOOTSTRAP fallback is set.
            let is_dev = std::env::var("HERMES_DESKTOP_DEV_URL").is_ok() || cfg!(debug_assertions);
            let async_bootstrap = std::env::var("HERMES_DESKTOP_SYNC_BOOTSTRAP").is_err();
            let external_dev_dashboard = is_dev && dashboard::dev_external_dashboard_enabled();
            let allow_external_agent = dashboard::external_agent_allowed();
            let allow_port_fallback = !is_dev;

            // Seed AppState with the static fields the UI needs while it waits
            // (HERMES_HOME, profile name). finalize_bootstrap fills in the rest
            // — apiBaseUrl/gatewayUrl/token — once the dashboard is up. The
            // bridge waits on the `runtime-status` "ready" event before mounting
            // the React app. See web/src/lib/tauri-bridge.ts.
            {
                let mut inner = state.inner.lock().unwrap();
                inner.hermes_home = boot_home_str.clone();
                inner.hermes_home_base = base_str.clone();
                inner.current_profile = current_profile.clone();
            }

            // Persist the first-install/migration decision before resolving or
            // installing any backend. Existing users are marked complete;
            // genuinely clean installs stay shell-only until `/guide` chooses
            // a mode.
            let control = match desktop_control::initialize() {
                Ok(control) => control,
                Err(error) => {
                    record_bootstrap_error(
                        app.handle(),
                        format!("无法初始化桌面控制状态: {}", error),
                    );
                    return Ok(());
                }
            };

            let options = dashboard::EnsureDashboardOptions {
                host: host.clone(),
                port,
                hermes_home: boot_home_str.clone(),
                allow_external_agent,
                allow_port_fallback,
                connection_mode: ConnectionMode::Managed,
                remote_base_url: None,
            };

            // Resolve the backend for this boot: env override → connection.json
            // local/remote attachment → managed runtime. An env URL without a token
            // is the one fatal misconfiguration (matching the official desktop).
            let backend = match connection::resolve_connection_backend() {
                Ok(backend) => backend,
                Err(msg) => {
                    record_bootstrap_error(app.handle(), msg);
                    return Ok(());
                }
            };

            if matches!(backend, ConnectionBackend::Managed)
                && !desktop_control::should_start_managed_runtime(
                    &control,
                    external_dev_dashboard,
                )
            {
                finalize_offline_bootstrap(app.handle());
                return Ok(());
            }

            // --- Default path: bring the dashboard up in the background. ---
            if async_bootstrap {
                let app_handle = app.handle().clone();
                let resource_dir = bundled_resource_dir.clone();
                let host_for_task = host.clone();
                let boot_home_for_task = boot_home_str.clone();
                let base_for_task = base_str.clone();
                let profile_for_task = current_profile.clone();

                tauri::async_runtime::spawn(async move {
                    let (handle, mode) = match backend {
                        ConnectionBackend::Remote(remote) => (
                            connect_remote_backend(&app_handle, &remote).await,
                            ConnectionMode::Remote,
                        ),
                        ConnectionBackend::Local(local) => (
                            connect_local_backend(&app_handle, &local).await,
                            ConnectionMode::Local,
                        ),
                        ConnectionBackend::Managed if external_dev_dashboard => {
                            let api_base_url = dashboard::dashboard_base_url(&host_for_task, port);
                            if !dashboard::probe_dashboard(&api_base_url).await {
                                log::warn!(
                                    "External dev dashboard mode: dashboard not reachable at {}",
                                    api_base_url
                                );
                            }
                            (external_dev_handle(api_base_url), ConnectionMode::Managed)
                        }
                        ConnectionBackend::Managed => {
                            match acquire_managed_dashboard(
                                &app_handle,
                                options,
                                resource_dir,
                                true,
                            )
                            .await
                            {
                                Ok(h) => (h, ConnectionMode::Managed),
                                // Error already surfaced to the UI via runtime-status.
                                Err(_) => return,
                            }
                        }
                    };

                    finalize_bootstrap(
                        &app_handle,
                        handle,
                        boot_home_for_task,
                        base_for_task,
                        profile_for_task,
                        mode,
                    )
                    .await;
                    if mode == ConnectionMode::Managed {
                        tauri::async_runtime::spawn(
                            hermes_agent_cn::supervisor::supervise_managed_dashboard(
                                app_handle.clone(),
                            ),
                        );
                    }
                });

                log::info!("Hermes Agent 中文社区桌面版 bootstrapping in background");
                return Ok(());
            }

            // --- Synchronous fallback (HERMES_DESKTOP_SYNC_BOOTSTRAP). ---
            match backend {
                ConnectionBackend::Remote(remote) => {
                    let handle = tauri::async_runtime::block_on(connect_remote_backend(
                        app.handle(),
                        &remote,
                    ));
                    tauri::async_runtime::block_on(finalize_bootstrap(
                        app.handle(),
                        handle,
                        boot_home_str,
                        base_str,
                        current_profile,
                        ConnectionMode::Remote,
                    ));
                    return Ok(());
                }
                ConnectionBackend::Local(local) => {
                    let handle =
                        tauri::async_runtime::block_on(connect_local_backend(app.handle(), &local));
                    tauri::async_runtime::block_on(finalize_bootstrap(
                        app.handle(),
                        handle,
                        boot_home_str,
                        base_str,
                        current_profile,
                        ConnectionMode::Local,
                    ));
                    return Ok(());
                }
                ConnectionBackend::Managed => {}
            }

            if external_dev_dashboard {
                let api_base_url = dashboard::dashboard_base_url(&host, port);
                if !tauri::async_runtime::block_on(dashboard::probe_dashboard(&api_base_url)) {
                    log::warn!(
                        "External dev dashboard mode: dashboard not reachable at {}",
                        api_base_url
                    );
                }
                tauri::async_runtime::block_on(finalize_bootstrap(
                    app.handle(),
                    external_dev_handle(api_base_url),
                    boot_home_str,
                    base_str,
                    current_profile,
                    ConnectionMode::Managed,
                ));
                return Ok(());
            }

            // In sync mode the bundled-runtime install runs up front (blocking)
            // so acquire_managed_dashboard below is told not to repeat it.
            if !tauri::async_runtime::block_on(install_bundled_runtime_for_bootstrap(
                app.handle(),
                bundled_resource_dir.as_deref(),
            )) {
                return Ok(());
            }

            let info = runtime::get_runtime_info(None);
            if info.current.is_none() && info.updates_configured {
                // First run with the update channel configured but no managed
                // runtime on disk yet. Open the window now and finish boot in
                // the background rather than freezing for 10-30s.
                let app_handle = app.handle().clone();
                let resource_dir = bundled_resource_dir.clone();
                let boot_home_for_task = boot_home_str.clone();
                let base_for_task = base_str.clone();
                let profile_for_task = current_profile.clone();

                tauri::async_runtime::spawn(async move {
                    let handle =
                        match acquire_managed_dashboard(&app_handle, options, resource_dir, false)
                            .await
                        {
                            Ok(h) => h,
                            Err(_) => return,
                        };
                    finalize_bootstrap(
                        &app_handle,
                        handle,
                        boot_home_for_task,
                        base_for_task,
                        profile_for_task,
                        ConnectionMode::Managed,
                    )
                    .await;
                });

                log::info!("Hermes Agent 中文社区桌面版 bootstrapping in background");
                return Ok(());
            }

            // Managed runtime already present (or update channel not configured):
            // block on the happy path — fast on a normal launch.
            let handle = match tauri::async_runtime::block_on(acquire_managed_dashboard(
                app.handle(),
                options,
                bundled_resource_dir.clone(),
                false,
            )) {
                Ok(h) => h,
                Err(e) => {
                    return Err(Box::new(std::io::Error::other(e)) as Box<dyn std::error::Error>)
                }
            };

            tauri::async_runtime::block_on(finalize_bootstrap(
                app.handle(),
                handle,
                boot_home_str,
                base_str,
                current_profile,
                ConnectionMode::Managed,
            ));

            // Keep the managed dashboard/gateway alive: auto-restart it if the
            // owned process dies unexpectedly. Self-gates on Managed mode, so it
            // no-ops for attached local/remote backends.
            tauri::async_runtime::spawn(hermes_agent_cn::supervisor::supervise_managed_dashboard(
                app.handle().clone(),
            ));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::gateway::get_runtime_config,
            commands::gateway::refresh_gateway_url,
            commands::connection::get_connection_config,
            commands::connection::save_connection_config,
            commands::connection::probe_connection_config,
            commands::connection::test_connection_config,
            commands::connection::apply_connection_config,
            commands::connection_auth::connection_oauth_login,
            commands::connection_auth::connection_password_login,
            commands::connection_auth::connection_auth_me,
            commands::connection_auth::connection_oauth_logout,
            commands::backup::backup_export_profile,
            commands::backup::backup_import_profile,
            commands::config_migration::config_migration_scan,
            commands::config_migration::config_migration_import,
            commands::im_onboarding::im_onboarding_state,
            commands::im_onboarding::im_onboarding_begin,
            commands::im_onboarding::im_onboarding_poll,
            commands::im_onboarding::im_onboarding_apply,
            commands::file_dialogs::pick_files,
            commands::file_dialogs::pick_directory,
            commands::file_dialogs::create_workspace_project,
            commands::file_dialogs::open_workspace_path,
            commands::file_dialogs::open_external_url,
            commands::log_export::export_log_snapshot,
            commands::debug_bundle::export_debug_bundle,
            commands::desktop_update::desktop_check_update,
            commands::devtools::toggle_devtools,
            commands::environment::environment_check,
            commands::coding_agents::coding_agents_check,
            commands::api_proxy::api_request,
            commands::api_proxy::external_request,
            commands::api_proxy::upload_file,
            commands::api_proxy::download_external_image,
            commands::runtime_manager::runtime_info,
            commands::runtime_manager::runtime_check_update,
            commands::runtime_manager::runtime_install_update,
            commands::runtime_manager::runtime_rollback,
            commands::ui_update::ui_check_update,
            commands::ui_update::ui_install_update,
            commands::ui_update::ui_rollback,
            commands::ui_update::ui_reset_to_embedded,
            commands::runtime_manager::get_desktop_control_state,
            commands::runtime_manager::set_guide_state,
            commands::runtime_manager::managed_runtime_install,
            commands::runtime_manager::managed_runtime_start,
            commands::runtime_manager::managed_runtime_stop,
            commands::runtime_manager::managed_runtime_uninstall,
            commands::runtime_manager::managed_runtime_reinstall,
            commands::profiles::switch_profile,
            commands::yolo::get_yolo_mode,
            commands::yolo::set_yolo_mode,
            commands::memory::read_memory,
            commands::memory::add_memory_entry,
            commands::memory::update_memory_entry,
            commands::memory::remove_memory_entry,
            commands::memory::write_user_profile,
            commands::notify::desktop_notify,
            commands::ws_proxy::gateway_ws_open,
            commands::ws_proxy::gateway_ws_send,
            commands::ws_proxy::gateway_ws_close,
            commands::ui_store::ui_store_snapshot,
            commands::ui_store::ui_store_set_kv,
            commands::ui_store::ui_store_remove_kv,
            commands::ui_store::ui_store_record_turn_stats,
            commands::ui_store::ui_store_get_turn_stats,
            commands::ui_store::ui_store_get_turn_stats_window,
            commands::ui_store::ui_store_record_event,
            commands::terminal::terminal_start,
            commands::terminal::terminal_open_external,
            commands::terminal::terminal_write,
            commands::terminal::terminal_resize,
            commands::terminal::terminal_close,
            commands::preview::read_workspace_file,
            commands::preview::write_workspace_file,
            commands::preview::watch_preview_file,
            commands::preview::stop_preview_file_watch,
            commands::git::git_review_list,
            commands::git::git_review_diff,
            commands::git::git_review_stage,
            commands::git::git_review_unstage,
            commands::git::git_review_revert,
            commands::git::git_review_rev_parse,
            commands::git::git_review_commit,
            commands::git::git_review_commit_context,
            commands::git::git_review_push,
            commands::git::git_review_ship_info,
            commands::git::git_review_create_pr,
            commands::git::git_worktree_list,
            commands::git::git_worktree_add,
            commands::git::git_worktree_remove,
            commands::git::git_branch_list,
            commands::git::git_branch_switch,
            commands::git::git_repo_status,
        ])
        .on_window_event(move |window, event| match event {
            tauri::WindowEvent::CloseRequested { api, .. }
                if window.label() == tray::MAIN_WINDOW_LABEL
                    && close_tray_available.load(Ordering::Relaxed)
                    && !close_quit_requested.load(Ordering::Relaxed) =>
            {
                api.prevent_close();
                tray::hide_main_window_to_tray(window);
            }
            tauri::WindowEvent::Destroyed if window.label() == tray::MAIN_WINDOW_LABEL => {
                log::info!("Main window destroyed");
            }
            _ => {}
        })
        .build(tauri::generate_context!())
        .expect("error while building Hermes Agent 中文社区桌面版");

    app.run(move |app_handle, event| match event {
        tauri::RunEvent::ExitRequested { .. } => {
            quit_requested.store(true, Ordering::Relaxed);
        }
        tauri::RunEvent::Exit => {
            shutdown_owned_runtime(app_handle, "app exit");
        }
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Reopen { .. } => {
            tray::show_main_window(app_handle);
        }
        _ => {}
    });
}
