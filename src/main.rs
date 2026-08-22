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

/// Resolve the Vite dev-server URL when the desktop runs against it: the
/// explicit `HERMES_DESKTOP_DEV_URL` override wins, otherwise any debug build
/// (tauri dev / cargo run) assumes the standard 9545 dev server. `None` in
/// release builds — the window then loads the `hermesui:` scheme.
fn resolve_dev_url() -> Option<String> {
    if let Ok(url) = std::env::var("HERMES_DESKTOP_DEV_URL") {
        let trimmed = url.trim().to_string();
        if !trimmed.is_empty() {
            return Some(trimmed);
        }
    }
    if cfg!(debug_assertions) {
        return Some("http://localhost:9545".to_string());
    }
    None
}

/// MIME type for a served `hermesui:` asset, keyed by extension. Vite emits a
/// known set (html/js/css + hashed images/fonts); anything unknown falls back
/// to octet-stream.
fn hermesui_content_type(path: &Path) -> &'static str {
    match path.extension().and_then(|ext| ext.to_str()).unwrap_or("") {
        "html" | "htm" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript",
        "css" => "text/css",
        "json" | "map" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "txt" => "text/plain",
        _ => "application/octet-stream",
    }
}

fn empty_hermesui_response(status: u16) -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder()
        .status(status)
        .body(Vec::new())
        .unwrap()
}

/// Build the response for a `hermesui:` request.
///
/// 1. DEV bypass: while the Vite dev server owns the window the handler is
///    dormant (HMR untouched) — nothing is served from the hot-update tree.
/// 2. When `ui/current.json` exists, `index.html` is on disk and the signed
///    `appVersionFloor` gate passes, serve from `ui/versions/<v>/` with
///    `index.html` `no-cache` and hashed assets immutable.
/// 3. Otherwise fall back to the embedded `frontendDist` — the window can
///    never brick, even after a bad package installs.
fn build_hermesui_response(
    app: &tauri::AppHandle,
    request_path: &str,
) -> tauri::http::Response<Vec<u8>> {
    if resolve_dev_url().is_some() {
        return empty_hermesui_response(404);
    }

    if let Some(version_dir) = ui_update::ui_serving_version_dir() {
        if let Some(asset_path) = ui_update::resolve_ui_asset(&version_dir, request_path) {
            match std::fs::read(&asset_path) {
                Ok(bytes) => {
                    let is_index = asset_path
                        .file_name()
                        .and_then(|name| name.to_str())
                        .is_some_and(|name| name.eq_ignore_ascii_case("index.html"));
                    let cache = if is_index {
                        "no-cache"
                    } else {
                        "public, max-age=31536000, immutable"
                    };
                    return tauri::http::Response::builder()
                        .status(200)
                        .header("Content-Type", hermesui_content_type(&asset_path))
                        .header("Cache-Control", cache)
                        .body(bytes)
                        .unwrap_or_else(|_| empty_hermesui_response(500));
                }
                Err(_) => return empty_hermesui_response(404),
            }
        }
    }

    // Embedded frontendDist fallback (tauri:// scheme assets), so a clean
    // install / first launch / bad package still renders the app.
    let relative = request_path.trim_start_matches('/');
    let asset_key = if relative.is_empty() {
        "index.html".to_string()
    } else {
        relative.to_string()
    };
    if let Some(asset) = app.asset_resolver().get(asset_key) {
        let mut builder = tauri::http::Response::builder().status(200);
        builder = builder.header("Content-Type", asset.mime_type());
        if let Some(csp) = asset.csp_header() {
            builder = builder.header("Content-Security-Policy", csp);
        }
        return builder
            .body(asset.bytes)
            .unwrap_or_else(|_| empty_hermesui_response(500));
    }
    empty_hermesui_response(404)
}

/// Parse a single HTTP `Range: bytes=...` header value.
/// Mirrors `web/src/lib/httpRange.ts` for the Rust media stream path.
fn parse_media_range(value: Option<&str>, file_size: u64) -> Option<(u64, u64)> {
    let value = value?;
    let trimmed = value.trim();
    if !trimmed.to_lowercase().starts_with("bytes=") {
        return None;
    }
    let spec = &trimmed[6..].trim();
    if spec.contains(',') {
        return None;
    }
    let dash = spec.find('-')?;
    let start_str = &spec[..dash].trim();
    let end_str = &spec[dash + 1..].trim();

    // Suffix range `-N`.
    if start_str.is_empty() {
        let suffix: u64 = end_str.parse().ok()?;
        if suffix == 0 || file_size == 0 {
            return None;
        }
        let length = suffix.min(file_size);
        let start = file_size - length;
        return Some((start, file_size - 1));
    }

    let start: u64 = start_str.parse().ok()?;
    if start >= file_size {
        return None;
    }

    let end: u64 = if end_str.is_empty() {
        file_size - 1
    } else {
        let parsed: u64 = end_str.parse().ok()?;
        parsed.min(file_size - 1)
    };

    if end < start {
        return None;
    }
    Some((start, end))
}

fn empty_response(status: u16) -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder()
        .status(status)
        .body(Vec::new())
        .unwrap()
}

/// Build the response for a `hermes-media:` custom-protocol request.
/// Mirrors `GET /api/media/file` Range streaming with extension + mime allowlists.
fn build_hermes_media_response(_app: &tauri::AppHandle, request: &tauri::http::Request<Vec<u8>>) -> tauri::http::Response<Vec<u8>> {
    let uri = request.uri();
    let query = uri.query().unwrap_or("");
    let path = urlencoding::decode(query)
        .ok()
        .and_then(|decoded| {
            decoded
                .split('&')
                .find_map(|pair| {
                    let mut parts = pair.splitn(2, '=');
                    let key = parts.next()?;
                    let value = parts.next()?;
                    if key == "path" {
                        Some(value.to_string())
                    } else {
                        None
                    }
                })
        })
        .unwrap_or_default();

    if path.is_empty() {
        return empty_response(400);
    }

    let resolved = match commands::media_file::resolve_media_path(&path) {
        Ok(p) => p,
        Err(_) => return empty_response(404),
    };

    let mime = commands::media_file::mime_from_path(&resolved).unwrap_or("application/octet-stream");
    if !commands::media_file::allowed_mime(mime) {
        return empty_response(415);
    }

    let metadata = match fs::metadata(&resolved) {
        Ok(m) if m.is_file() => m,
        _ => return empty_response(404),
    };

    let file_size = metadata.len();
    const CHUNK_SIZE: u64 = 64 * 1024;
    const MAX_STREAM_BYTES: u64 = 4 * 1024 * 1024 * 1024;

    let range = parse_media_range(
        request.headers().get("Range").and_then(|v| v.to_str().ok()),
        file_size,
    );

    let (start, end, status, content_range) = match range {
        Some((s, e)) => {
            let length = e - s + 1;
            if length > MAX_STREAM_BYTES {
                return empty_response(416);
            }
            let range_header = format!("bytes {}-{}/{}", s, e, file_size);
            (s, e, 206, Some(range_header))
        }
        None => {
            let capped = file_size.min(MAX_STREAM_BYTES);
            (0, capped.saturating_sub(1), 200, None)
        }
    };

    let length = end - start + 1;
    let mut file = match std::fs::File::open(&resolved) {
        Ok(f) => f,
        Err(_) => return empty_response(500),
    };
    use std::io::{Read, Seek};
    if let Err(_) = file.seek(std::io::SeekFrom::Start(start)) {
        return empty_response(500);
    }

    let mut remaining = length;
    let mut body = Vec::with_capacity(remaining as usize);
    let mut buf = vec![0u8; CHUNK_SIZE as usize];
    while remaining > 0 {
        let to_read = (remaining as usize).min(buf.len());
        match file.read(&mut buf[..to_read]) {
            Ok(0) => break,
            Ok(n) => {
                body.extend_from_slice(&buf[..n]);
                remaining -= n as u64;
            }
            Err(_) => return empty_response(500),
        }
    }

    let mut builder = tauri::http::Response::builder()
        .status(status)
        .header("Content-Type", mime)
        .header("Accept-Ranges", "bytes")
        .header("Content-Length", body.len());
    if let Some(cr) = content_range {
        builder = builder.header("Content-Range", cr);
    }
    builder.body(body).unwrap_or_else(|_| empty_response(500))
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
        .manage(app_state)
        // Track B UI hot update: serve the webview from the writable
        // `ui/versions/<v>/` tree (signed `appVersionFloor` gate + path-traversal
        // guard, embedded frontendDist fallback, dev bypass) so the React UI can
        // update without touching the kernel or the shell binary.
        .register_asynchronous_uri_scheme_protocol("hermesui", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            let path = request.uri().path().to_string();
            tauri::async_runtime::spawn(async move {
                let response = build_hermesui_response(&app, &path);
                responder.respond(response);
            });
        })
        // Local-first authenticated media streaming for chat/preview attachments.
        .register_asynchronous_uri_scheme_protocol("hermes-media", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            tauri::async_runtime::spawn(async move {
                let response = build_hermes_media_response(&app, &request);
                responder.respond(response);
            });
        })
        .setup(move |app| {
            use tauri::Manager;
            let state = app.state::<AppState>();

            // Create the main window: production loads the hot-updatable UI
            // through the `hermesui:` custom scheme; dev builds keep the Vite
            // dev server (http://localhost:9545) so HMR is unaffected.
            let window_url = match resolve_dev_url() {
                Some(dev_url) => tauri::WebviewUrl::External(
                    dev_url.parse().expect("valid dev URL"),
                ),
                None => tauri::WebviewUrl::CustomProtocol(
                    "hermesui://localhost/index.html"
                        .parse()
                        .expect("valid hermesui URL"),
                ),
            };
            let window_builder = tauri::WebviewWindowBuilder::new(app, tray::MAIN_WINDOW_LABEL, window_url)
                .title("Hermes Agent 中文社区桌面版")
                .inner_size(1240.0, 820.0)
                .min_inner_size(960.0, 680.0);
            #[cfg(target_os = "macos")]
            let window_builder = window_builder.title_bar_style(tauri::TitleBarStyle::Transparent);
            window_builder.build()?;
            let bundled_resource_dir = app.path().resource_dir().ok();

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
            // installing any backend. Standard clean installs start the
            // managed workspace; model onboarding is presented inside AppShell
            // once the dashboard is ready.
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
            commands::fatal_error::fatal_error_and_exit,
            commands::connection::get_connection_config,
            commands::connection::save_connection_config,
            commands::connection::probe_connection_config,
            commands::connection::test_connection_config,
            commands::connection::apply_connection_config,
            commands::connection_auth::connection_oauth_login,
            commands::connection_auth::connection_password_login,
            commands::connection_auth::connection_auth_me,
              commands::connection_auth::connection_oauth_logout,
              commands::spotify_oauth::spotify_oauth_start,
              commands::spotify_oauth::spotify_oauth_wait,
              commands::spotify_oauth::spotify_oauth_read,
              commands::spotify_oauth::spotify_oauth_write,
              commands::spotify_oauth::spotify_oauth_disconnect,
              commands::spotify_oauth::spotify_oauth_cancel,
              commands::meet::meet_join,
              commands::meet::meet_status,
              commands::meet::meet_transcript,
              commands::meet::meet_leave,
              commands::meet::meet_say,
              commands::meet::meet_setup,
              commands::mcp::mcp_stdio_spawn,
              commands::mcp::mcp_stdio_write,
              commands::mcp::mcp_stdio_kill,
              commands::mcp::mcp_stdio_status,
              commands::subscription_proxy::subscription_proxy_start,
              commands::subscription_proxy::subscription_proxy_stop,
              commands::subscription_proxy::subscription_proxy_status,
              commands::subscription_proxy::subscription_proxy_providers,
              commands::acp::acp_start,
              commands::acp::acp_stop,
              commands::acp::acp_status,
              commands::acp::acp_list_sessions,
              commands::meet::meet_oauth_start,
              commands::meet::meet_oauth_wait,
              commands::meet::meet_oauth_read,
              commands::meet::meet_oauth_write,
              commands::meet::meet_oauth_disconnect,
              commands::meet::meet_oauth_cancel,
              commands::backup::backup_export_profile,
            commands::backup::backup_import_profile,
            commands::browser_companion::open_browser_companion,
            commands::browser::browser_cdp_probe,
            commands::browser::browser_find_free_port,
            commands::browser::browser_launch_chrome_debug,
            commands::browser::browser_sidecar_start,
            commands::browser::browser_sidecar_stop,
            commands::browser::browser_event_subscribe,
            commands::browser::browser_navigate,
            commands::browser::browser_snapshot,
            commands::browser::browser_click,
            commands::browser::browser_type,
            commands::browser::browser_scroll,
            commands::browser::browser_back,
            commands::browser::browser_press,
            commands::browser::browser_console,
            commands::browser::browser_get_images,
            commands::browser::browser_vision,
            commands::browser::browser_cdp,
            commands::browser::browser_dialog,
            commands::browser::browser_exec,
            commands::checkpoints::checkpoint_status,
            commands::checkpoints::checkpoint_diff,
            commands::checkpoints::checkpoint_snapshot,
            commands::cli::cli_spawn,
            commands::cli::cli_resolve_command,
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
            commands::projects::projects_list,
            commands::projects::projects_create,
            commands::projects::projects_update,
            commands::projects::projects_set_active,
            commands::projects::projects_delete,
            commands::projects::projects_tree,
            commands::context_files::read_context_files,
              commands::log_export::export_log_snapshot,
              commands::lsp::lsp_spawn,
              commands::lsp::lsp_write_stdin,
              commands::lsp::lsp_shutdown,
              commands::lsp::lsp_probe_binary,
              commands::lsp::lsp_status,
              commands::session_export::export_session_json,
            commands::state_db::state_db_query,
            commands::state_db::state_db_exec,
            commands::state_db::state_db_fts_search,
            commands::state_db::state_db_search_meta,
            commands::debug_bundle::export_debug_bundle,
            commands::desktop_update::desktop_check_update,
            commands::fs::fs_list,
            commands::upload::upload_file_local,
            commands::media_file::media_data_url,
            commands::media_file::media_file_url,
            commands::dashboard_local::dashboard_local_status,
            commands::dashboard_local::dashboard_local_env,
            commands::dashboard_api::mcp_servers_summary,
            commands::dashboard_api::active_profile_get,
            commands::dashboard_api::active_profile_set,
            commands::dashboard_api::memory_provider_status,
            commands::dashboard_api::oauth_providers_status,
            commands::app_update::app_update_check,
            commands::app_update::app_update_install,
            hermes_agent_cn::update_config::get_update_config,
            hermes_agent_cn::update_config::set_update_config,
            commands::devtools::toggle_devtools,
            commands::environment::environment_check,
            commands::coding_agents::coding_agents_check,
            commands::api_proxy::api_request,
            commands::api_server::api_server_start,
            commands::api_server::api_server_stop,
            commands::api_server::api_server_status,
            commands::egress_proxy::egress_proxy_start,
            commands::egress_proxy::egress_proxy_stop,
            commands::egress_proxy::egress_proxy_status,
            commands::egress_proxy::egress_proxy_set_rules,
            commands::egress_proxy::egress_proxy_download,
            commands::egress_proxy::egress_proxy_import_secrets,
            commands::egress_proxy::egress_proxy_export_secrets,
            commands::observability::observability_get_config,
            commands::observability::observability_set_config,
            commands::codex_app_server::codex_app_server_check,
            commands::codex_app_server::codex_app_server_start,
            commands::codex_app_server::codex_app_server_stop,
            commands::codex_app_server::codex_app_server_status,
            commands::codex_app_server::codex_app_server_run_turn,
            commands::codex_app_server::codex_app_server_interrupt,
            commands::codex_app_server::codex_app_server_close,
            commands::codex_app_server::codex_app_server_respond,
            commands::codex_app_server::codex_app_server_plugin_list,
            commands::codex_app_server::codex_app_server_apply_config_toml,
            commands::api_proxy::external_request,
            commands::ha_proxy::ha_request,
            commands::api_proxy::upload_file,
            commands::api_proxy::download_external_image,
            commands::web_tools::web_provider_request,
            commands::web_tools::web_store_full_text,
            commands::runtime_manager::runtime_info,
            commands::runtime_manager::runtime_check_update,
            commands::runtime_manager::runtime_install_update,
            commands::runtime_manager::runtime_rollback,
            commands::runtime_manager::get_desktop_control_state,
            commands::runtime_manager::set_guide_state,
            commands::runtime_manager::managed_runtime_install,
            commands::runtime_manager::managed_runtime_start,
            commands::runtime_manager::managed_runtime_stop,
            commands::runtime_manager::managed_runtime_uninstall,
        commands::runtime_manager::managed_runtime_reinstall,
            commands::runtime_manager::toolchain_status,
            commands::smoke::run_dashboard_smoke,
            commands::windows_env::refresh_windows_path,
            commands::profiles::switch_profile,
            commands::yolo::get_yolo_mode,
            commands::yolo::set_yolo_mode,
commands::memory::read_memory,
commands::memory::add_memory_entry,
commands::memory::update_memory_entry,
commands::memory::remove_memory_entry,
commands::memory::write_user_profile,
commands::memory_files::read_memory_files,
            commands::model_config::set_model_config,
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
            commands::terminal::terminal_detach,
            commands::terminal_env::terminal_env_exec,
            commands::terminal_env::terminal_env_create_session,
            commands::terminal_env::terminal_env_cleanup,
            commands::pets::pets_list,
            commands::pets::pet_select,
            commands::pets::pet_hatch,
            commands::profile_ops::export_profile,
            commands::profile_ops::import_profile,
            commands::profile_ops::distribution_info,
            commands::preview::read_file_data_url,
            commands::preview::read_workspace_file,
            commands::preview::write_workspace_file,
            commands::preview::watch_preview_file,
            commands::preview::stop_preview_file_watch,
            commands::context_refs::context_refs_folder_list,
            commands::context_refs::context_refs_git_capture,
            commands::context_refs::context_refs_http_fetch,
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
            commands::hot_update::hot_update_backend,
            commands::wake_word::wake_start,
            commands::wake_word::wake_stop,
            commands::wake_word::wake_pause,
            commands::wake_word::wake_resume,
            commands::wake_word::wake_status,
            commands::wake_word::wake_feed,
            commands::wake_word::wake_frame_info,
            commands::ui_update::ui_check_update,
            commands::ui_update::ui_install_update,
            commands::ui_update::ui_rollback,
            commands::messaging::get_messaging_platforms,
            commands::messaging::get_messaging_status,
            commands::messaging::set_messaging_platform_config,
            commands::messaging::start_messaging_platform,
            commands::messaging::stop_messaging_platform,
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

#[cfg(test)]
mod media_stream_tests {
    use super::parse_media_range;

    #[test]
    fn parse_range_start_end() {
        assert_eq!(parse_media_range(Some("bytes=0-99"), 200), Some((0, 99)));
    }

    #[test]
    fn parse_range_clamps_end() {
        assert_eq!(parse_media_range(Some("bytes=0-999"), 100), Some((0, 99)));
    }

    #[test]
    fn parse_range_open_end() {
        assert_eq!(parse_media_range(Some("bytes=50-"), 200), Some((50, 199)));
    }

    #[test]
    fn parse_range_suffix() {
        assert_eq!(parse_media_range(Some("bytes=-50"), 200), Some((150, 199)));
    }

    #[test]
    fn parse_range_rejects_multipart() {
        assert_eq!(parse_media_range(Some("bytes=0-9,20-29"), 100), None);
    }

    #[test]
    fn parse_range_rejects_start_beyond_size() {
        assert_eq!(parse_media_range(Some("bytes=100-"), 100), None);
    }

    #[test]
    fn parse_range_rejects_end_before_start() {
        assert_eq!(parse_media_range(Some("bytes=10-5"), 100), None);
    }

    #[test]
    fn parse_range_missing_header() {
        assert_eq!(parse_media_range(None, 100), None);
    }
}
