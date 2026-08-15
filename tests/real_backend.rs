//! Real-backend integration tests — the live counterparts of the wiremock /
//! loopback suites in this directory.
//!
//! Every sibling mock test stands in for "a hermes dashboard" with an
//! in-process fake (wiremock, or a hand-rolled loopback TCP/WS server). The
//! tests here run the SAME production code paths against the REAL
//! Hermes-CN-Core dashboard:
//!
//! | mock test                          | real test here                                  |
//! |------------------------------------|-------------------------------------------------|
//! | dashboard_probe.rs                 | real_dashboard_probe_reachable / _unreachable   |
//! | dashboard_token.rs                 | real_fetch_session_token_from_index             |
//! | connection_config.rs (probe)       | real_connection_probe_reachable_with_version    |
//! | connection_ws_e2e.rs (WS handshake)| real_connection_test_local_includes_ws          |
//! | connection_config.rs (token)       | real_connection_test_remote_with_token          |
//! | api_proxy.rs (forwarding)          | real_api_proxy_forwards_status / _sessions      |
//! | api_proxy.rs (origin guard)        | real_api_proxy_rejects_cross_origin             |
//! | runtime_manifest.rs                | real_runtime_update_manifest_from_external_url  |
//! | dashboard_spawn_retry.rs           | real_managed_runtime_spawns_the_real_dashboard  |
//!
//! # Configuration (all env vars; the suite is fully opt-in)
//!
//! ```text
//! HERMES_REAL_BACKEND_URL   base URL of an already-running backend. When set,
//!                           the harness never spawns anything — the backend is
//!                           external (may be a remote host).
//! HERMES_REAL_BACKEND_TOKEN session token for the external backend (required
//!                           only for the token-sensitive assertions; when
//!                           absent those degrade/skip).
//! HERMES_CORE_DIR           backend source tree used to AUTO-START the real
//!                           dashboard (default: ../Hermes-CN-Core, i.e. the
//!                           sibling checkout = C:/dev/Hermes-CN-Core here).
//! HERMES_CORE_PYTHON        override the Core venv interpreter (default:
//!                           $HERMES_CORE_DIR/.venv/{Scripts/python.exe,bin/python}).
//! HERMES_REAL_MANIFEST_URL  runtime-update manifest URL for the real manifest
//!                           test (e.g. the production GitHub Releases URL).
//!                           Unset ⇒ that single test skips (no surprise
//!                           network in auto-started runs).
//! ```
//!
//! When neither `HERMES_REAL_BACKEND_URL` nor a usable Core checkout exists the
//! whole suite skips loudly (eprintln) instead of failing, so the hermetic CI
//! gate (`cargo test` with no external backend) stays green. A configured
//! backend that FAILS to start is a hard test failure, never a silent skip.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::{channel, RecvTimeoutError};
use std::sync::{Mutex, Once, OnceLock};
use std::time::{Duration, Instant};

use hermes_agent_cn::commands::api_proxy::{api_request_impl, ApiRequestInput};
use hermes_agent_cn::commands::connection::{
    probe_connection_config, test_connection_config, ConnectionConfigInput,
};
use hermes_agent_cn::connection::ConnectionMode;
use hermes_agent_cn::error::AppError;
use hermes_agent_cn::process::dashboard::{
    ensure_hermes_dashboard, fetch_session_token, probe_dashboard, EnsureDashboardOptions,
};
use hermes_agent_cn::process::runtime::{check_runtime_update, RuntimeInstallRecord};
use serial_test::serial;

/// Surface `log::info!`/`log::warn!` (e.g. the managed-runtime kernel's
/// piped stdout/stderr via `drain_dashboard_output`) on the test stderr.
fn init_logging() {
    let _ = env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
        .try_init();
}

const START_TIMEOUT: Duration = Duration::from_secs(120);
const HTTP_POLL_TIMEOUT: Duration = Duration::from_secs(60);
const READY_LINE_PREFIX: &str = "HERMES_DASHBOARD_READY port=";

const STUB_CONFIG: &str = "model:\n\
    \x20 provider: custom\n\
    \x20 default: fake-model\n\
    \x20 base_url: http://127.0.0.1:9/v1\n\
    \x20 api_key: e2e-test-key\n\
    \x20 supports_vision: true\n\
    \x20 context_length: 200000\n\
    \x20 max_tokens: 256\n\
    memory:\n\
    \x20 memory_enabled: false\n\
    \x20 user_profile_enabled: false\n\
    compression:\n\
    \x20 enabled: false\n";

const STUB_INDEX: &str = "<!doctype html><html><head><meta charset=\"utf-8\">\
<title>real-backend</title></head><body>stub</body></html>\n";

// ─────────────────────────────────────────────────────────────────────────
// Env helpers
// ─────────────────────────────────────────────────────────────────────────

fn env_non_empty(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

fn manifest_dir() -> Option<PathBuf> {
    std::env::var("CARGO_MANIFEST_DIR").ok().map(PathBuf::from)
}

/// Resolve the Core backend source tree: `HERMES_CORE_DIR`, else the sibling
/// `../Hermes-CN-Core` of this repo (the convention used by the e2e harness
/// and the dev tooling).
fn default_core_dir() -> Option<PathBuf> {
    if let Some(dir) = env_non_empty("HERMES_CORE_DIR") {
        if Path::new(&dir).join("hermes_cli").is_dir() {
            return Some(PathBuf::from(dir));
        }
    }
    let sibling = manifest_dir()
        .or_else(|| std::env::current_dir().ok())
        .map(|base| base.join("..").join("Hermes-CN-Core"));
    let sibling = sibling?;
    sibling.join("hermes_cli").is_dir().then_some(sibling)
}

/// The venv interpreter for the Core checkout (`HERMES_CORE_PYTHON` wins).
fn core_python(core_dir: &Path) -> Option<PathBuf> {
    if let Some(py) = env_non_empty("HERMES_CORE_PYTHON") {
        if Path::new(&py).is_file() {
            return Some(PathBuf::from(py));
        }
    }
    let py = if cfg!(target_os = "windows") {
        core_dir.join(".venv").join("Scripts").join("python.exe")
    } else {
        core_dir.join(".venv").join("bin").join("python")
    };
    py.is_file().then_some(py)
}

fn core_dir_and_hermes() -> Option<(PathBuf, PathBuf)> {
    let core = default_core_dir()?;
    let exe = if cfg!(target_os = "windows") {
        core.join(".venv").join("Scripts").join("hermes.exe")
    } else {
        core.join(".venv").join("bin").join("hermes")
    };
    exe.is_file().then_some((core, exe))
}

fn host_platform() -> &'static str {
    if cfg!(target_os = "windows") {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    }
}

fn host_arch() -> &'static str {
    if cfg!(target_arch = "x86_64") {
        "x64"
    } else if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        std::env::consts::ARCH
    }
}

/// Claim an ephemeral loopback port from the OS, then release it.
fn free_port() -> Result<u16, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    drop(listener);
    Ok(port)
}

/// Point HERMES_DESKTOP_RUNTIME_ROOT at a fresh temp dir so saved connection
/// config / env from a dev machine (or a sibling test) cannot leak in.
fn isolate_runtime_root() -> tempfile::TempDir {
    let dir = tempfile::TempDir::new().expect("create temp runtime root");
    std::env::set_var("HERMES_DESKTOP_RUNTIME_ROOT", dir.path());
    std::env::remove_var("HERMES_DESKTOP_REMOTE_URL");
    std::env::remove_var("HERMES_DESKTOP_REMOTE_TOKEN");
    dir
}

// ─────────────────────────────────────────────────────────────────────────
// Backend harness: external URL or auto-started real Core dashboard
// ─────────────────────────────────────────────────────────────────────────

struct RealBackend {
    base_url: String,
    token: Option<String>,
    home: Option<PathBuf>,
    /// Keeps the temp HERMES_HOME / web-dist dirs alive for the process
    /// lifetime (statics are never dropped; the atexit handler removes them).
    _home_guard: Option<tempfile::TempDir>,
    _web_dist_guard: Option<tempfile::TempDir>,
}

impl RealBackend {
    /// A hermes-home path for api_proxy calls (kept alive for the process
    /// lifetime via `_home_guard`).
    fn hermes_home(&self) -> String {
        self.home
            .as_ref()
            .expect("backend home is always set")
            .to_string_lossy()
            .to_string()
    }
}

/// Child PID + home dir for the atexit cleanup (kills the dashboard and
/// removes the temp runtime even when a test panics or the harness exits).
static BACKEND_PID: AtomicU32 = AtomicU32::new(0);
static BACKEND_HOME: Mutex<Option<PathBuf>> = Mutex::new(None);

fn register_cleanup() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| unsafe {
        libc::atexit(cleanup_backend);
    });
}

extern "C" fn cleanup_backend() {
    let pid = BACKEND_PID.swap(0, Ordering::SeqCst);
    if pid != 0 {
        let _ = kill_pid(pid);
    }
    if let Ok(mut home) = BACKEND_HOME.lock() {
        if let Some(dir) = home.take() {
            let _ = std::fs::remove_dir_all(dir);
        }
    }
}

#[cfg(target_os = "windows")]
fn kill_pid(pid: u32) -> Result<(), String> {
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};
    unsafe {
        let handle: HANDLE = OpenProcess(PROCESS_TERMINATE, 0, pid);
        if handle.is_null() {
            return Err(format!("OpenProcess({pid}) failed"));
        }
        let rc = TerminateProcess(handle, 1);
        CloseHandle(handle);
        if rc == 0 {
            return Err(format!("TerminateProcess({pid}) failed"));
        }
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn kill_pid(pid: u32) -> Result<(), String> {
    let rc = unsafe { libc::kill(pid as libc::pid_t, libc::SIGTERM) };
    if rc == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error().to_string())
    }
}

/// Spawn the REAL Core dashboard from the checkout venv and wait until it
/// announces readiness (mirrors e2e/harness/start-backend.mjs).
fn start_core_dashboard(core_dir: &Path, python: &Path) -> Result<RealBackend, String> {
    let home = tempfile::TempDir::new().map_err(|e| format!("temp HERMES_HOME: {e}"))?;
    let web_dist = tempfile::TempDir::new().map_err(|e| format!("temp web_dist: {e}"))?;
    let home_path = home.path().to_path_buf();
    let dist_path = web_dist.path().to_path_buf();

    std::fs::write(home_path.join("config.yaml"), STUB_CONFIG)
        .map_err(|e| format!("write config.yaml: {e}"))?;
    // Core injects the session token into whatever index.html it serves; the
    // assets dir is required by the StaticFiles mount.
    std::fs::create_dir_all(dist_path.join("assets")).map_err(|e| e.to_string())?;
    std::fs::write(dist_path.join("index.html"), STUB_INDEX).map_err(|e| e.to_string())?;

    let token = env_non_empty("HERMES_REAL_BACKEND_TOKEN")
        .unwrap_or_else(|| "real-backend-e2e-token".to_string());
    let port = free_port()?;

    let mut cmd = Command::new(python);
    cmd.current_dir(core_dir)
        .arg("-m")
        .arg("hermes_cli.main")
        .arg("dashboard")
        .arg("--host")
        .arg("127.0.0.1")
        .arg("--port")
        .arg(port.to_string())
        .arg("--no-open")
        .arg("--skip-build")
        .env("HERMES_HOME", &home_path)
        .env("HERMES_WEB_DIST", &dist_path)
        .env("HERMES_DASHBOARD_SESSION_TOKEN", &token)
        .env("HERMES_NO_ANALYTICS", "1")
        .env("HERMES_DISABLE_LAZY_INSTALLS", "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("spawn Core dashboard ({python:?}): {e}"))?;

    let actual_port = read_until_ready(&mut child, port)?;
    wait_for_http_ok("127.0.0.1", actual_port)?;

    register_cleanup();
    BACKEND_PID.store(child.id(), Ordering::SeqCst);
    *BACKEND_HOME.lock().expect("backend home lock") = Some(home_path.clone());

    Ok(RealBackend {
        base_url: format!("http://127.0.0.1:{actual_port}"),
        token: Some(token),
        home: Some(home_path),
        _home_guard: Some(home),
        _web_dist_guard: Some(web_dist),
    })
}

/// Read the child's stdout/stderr until `HERMES_DASHBOARD_READY port=N`,
/// collecting a log tail for useful failure messages.
fn read_until_ready(child: &mut Child, requested_port: u16) -> Result<u16, String> {
    let (tx, rx) = channel::<String>();
    if let Some(stdout) = child.stdout.take() {
        spawn_pipe_reader(stdout, tx.clone());
    }
    if let Some(stderr) = child.stderr.take() {
        spawn_pipe_reader(stderr, tx.clone());
    }
    let deadline = Instant::now() + START_TIMEOUT;
    let mut log: Vec<String> = Vec::new();
    loop {
        match rx.recv_timeout(Duration::from_millis(250)) {
            Ok(line) => {
                if log.len() < 300 {
                    log.push(line.clone());
                }
                if let Some(port) = ready_port(&line) {
                    // Keep draining in the background so a chatty kernel can
                    // never block on a full pipe.
                    let _ = std::thread::spawn(move || while rx.recv().is_ok() {});
                    return Ok(port);
                }
            }
            Err(RecvTimeoutError::Timeout) => {
                if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
                    return Err(format!(
                        "Core dashboard exited early ({status}) before READY; log:\n{}",
                        log.join("\n")
                    ));
                }
                if Instant::now() >= deadline {
                    return Err(format!(
                        "Core dashboard did not announce READY within {START_TIMEOUT:?} \
                         (requested port {requested_port}); log tail:\n{}",
                        log.join("\n")
                    ));
                }
            }
            Err(RecvTimeoutError::Disconnected) => {
                return Err(format!(
                    "Core dashboard stdout/stderr closed before READY; log:\n{}",
                    log.join("\n")
                ));
            }
        }
    }
}

fn spawn_pipe_reader<R: Read + Send + 'static>(reader: R, tx: std::sync::mpsc::Sender<String>) {
    std::thread::spawn(move || {
        for line in BufReader::new(reader).lines().map_while(Result::ok) {
            if tx.send(line).is_err() {
                break;
            }
        }
    });
}

fn ready_port(line: &str) -> Option<u16> {
    line.trim().strip_prefix(READY_LINE_PREFIX)?.parse().ok()
}

/// The READY line is printed once the socket is bound but before the accept
/// loop drains; poll /api/status so the first real probe never races it.
fn wait_for_http_ok(host: &str, port: u16) -> Result<(), String> {
    let deadline = Instant::now() + HTTP_POLL_TIMEOUT;
    loop {
        if http_status_ok(host, port) {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(format!(
                "dashboard at {host}:{port} never answered /api/status within {HTTP_POLL_TIMEOUT:?}"
            ));
        }
        std::thread::sleep(Duration::from_millis(250));
    }
}

fn http_status_ok(host: &str, port: u16) -> bool {
    let Ok(mut stream) = std::net::TcpStream::connect((host, port)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
    let request = format!(
        "GET /api/status HTTP/1.1\r\nHost: {host}:{port}\r\nAccept: application/json\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut buf = [0u8; 512];
    let mut response = Vec::new();
    loop {
        match stream.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => response.extend_from_slice(&buf[..n]),
            Err(_) => break,
        }
    }
    String::from_utf8_lossy(&response)
        .lines()
        .next()
        .map(|line| line.contains(" 200 "))
        .unwrap_or(false)
}

/// Resolve the configured backend. `Ok` = usable; `Err` starting with
/// "skipped:" = no backend configured (tests skip); any other Err = the
/// configured backend failed to start (tests must fail loudly).
static BACKEND: OnceLock<Result<RealBackend, String>> = OnceLock::new();

fn backend() -> &'static Result<RealBackend, String> {
    BACKEND.get_or_init(start_real_backend)
}

fn start_real_backend() -> Result<RealBackend, String> {
    // External backend: never spawn anything, use it as-is.
    if let Some(url) = env_non_empty("HERMES_REAL_BACKEND_URL") {
        let token = env_non_empty("HERMES_REAL_BACKEND_TOKEN");
        // Keep a scratch HERMES_HOME alive for api_proxy calls that may touch
        // local state (ui_store etc.).
        let scratch_home =
            tempfile::TempDir::new().map_err(|e| format!("temp scratch home: {e}"))?;
        let home_path = scratch_home.path().to_path_buf();
        return Ok(RealBackend {
            base_url: url.trim_end_matches('/').to_string(),
            token,
            home: Some(home_path),
            _home_guard: Some(scratch_home),
            _web_dist_guard: None,
        });
    }

    let core_dir = default_core_dir().ok_or_else(|| {
        "skipped: no HERMES_REAL_BACKEND_URL and no Hermes-CN-Core checkout found \
         (set HERMES_REAL_BACKEND_URL for an external backend, or \
         HERMES_CORE_DIR / HERMES_CORE_PYTHON to auto-start one)"
            .to_string()
    })?;
    let python = core_python(&core_dir).ok_or_else(|| {
        format!(
            "skipped: Core venv interpreter not found under {core_dir:?} \
             (set HERMES_CORE_PYTHON to opt in)"
        )
    })?;
    start_core_dashboard(&core_dir, &python)
}

/// `Some(backend)` when configured; `None` (with a loud skip message) when no
/// backend is configured at all; panics when a configured backend failed so a
/// broken opt-in run is never mistaken for a green suite.
fn backend_or_skip() -> Option<&'static RealBackend> {
    match backend() {
        Ok(b) => Some(b),
        Err(msg) if msg.starts_with("skipped:") => {
            eprintln!("[real_backend] SKIP: {msg}");
            None
        }
        Err(msg) => panic!("[real_backend] configured backend failed to start: {msg}"),
    }
}

// ─────────────────────────────────────────────────────────────────────────
// Real tests (mirroring the wiremock suites; all #[serial] because they share
// the one backend and mutate process env)
// ─────────────────────────────────────────────────────────────────────────

/// Real counterpart of dashboard_probe.rs `returns_true_for_2xx_status`.
#[tokio::test]
#[serial]
async fn real_dashboard_probe_reachable() {
    let Some(b) = backend_or_skip() else { return };
    assert!(
        probe_dashboard(&b.base_url).await,
        "real dashboard at {} must answer /api/status",
        b.base_url
    );
}

/// Real counterpart of dashboard_probe.rs `returns_false_when_server_unreachable`
/// — a genuinely dead loopback port, no mock involved.
#[tokio::test]
#[serial]
async fn real_dashboard_probe_unreachable_port() {
    if backend_or_skip().is_none() {
        return;
    }
    // Port 1 on loopback is not listening on any host we run on; the connect
    // fails fast so the 900ms probe timeout never matters.
    assert!(!probe_dashboard("http://127.0.0.1:1").await);
}

/// Real counterpart of dashboard_token.rs — the token comes out of the real
/// index.html bootstrap script Core injects.
#[tokio::test]
#[serial]
async fn real_fetch_session_token_from_index() {
    let Some(b) = backend_or_skip() else { return };
    let found = fetch_session_token(&b.base_url).await;
    let token = found.expect("real dashboard index must embed a session token");
    assert!(!token.is_empty());
    if let Some(expected) = b.token.as_deref() {
        assert_eq!(
            token, expected,
            "token embedded by the real dashboard must match the one we injected"
        );
    }
}

/// Real counterpart of connection_config.rs `probe_reports_reachable_with_version`.
#[tokio::test]
#[serial]
async fn real_connection_probe_reachable_with_version() {
    let Some(b) = backend_or_skip() else { return };
    let result = probe_connection_config(b.base_url.clone())
        .await
        .expect("probe ok");
    assert!(result.reachable, "real dashboard must be reachable");
    assert!(
        !result.auth_required,
        "token-mode dashboard has no OAuth gate"
    );
    assert!(
        result.version.is_some(),
        "real dashboard /api/status must report a version"
    );
}

/// Real counterpart of connection_ws_e2e.rs — the full HTTP + WebSocket leg
/// against the REAL /api/ws gateway (wiremock could never do the upgrade).
#[tokio::test]
#[serial]
async fn real_connection_test_local_includes_ws() {
    let Some(b) = backend_or_skip() else { return };
    let _root = isolate_runtime_root();
    let result = test_connection_config(ConnectionConfigInput {
        mode: Some("local".to_string()),
        local_url: Some(b.base_url.clone()),
        remote_url: None,
        remote_token: None,
        remote_auth_mode: None,
    })
    .await
    .expect("connection test ok");

    assert!(result.http_ok, "HTTP step failed: {:?}", result.error);
    assert_eq!(result.http_status, Some(200));
    assert!(
        result.ws_ok,
        "real WebSocket handshake against /api/ws failed: {:?}",
        result.error
    );
    assert!(result.ok, "expected overall-ok: {:?}", result.error);
    assert!(result.error.is_none());
}

/// Real counterpart of connection_config.rs `test_connection_sends_auth_headers
/// _and_reports_http_ok` — remote-token mode with the minted token.
#[tokio::test]
#[serial]
async fn real_connection_test_remote_with_token() {
    let Some(b) = backend_or_skip() else { return };
    let Some(token) = b.token.clone() else {
        eprintln!(
            "[real_backend] SKIP: remote-token connection test needs a known token \
             (HERMES_REAL_BACKEND_TOKEN in external mode)"
        );
        return;
    };
    let _root = isolate_runtime_root();
    let result = test_connection_config(ConnectionConfigInput {
        mode: Some("remote".to_string()),
        local_url: None,
        remote_url: Some(b.base_url.clone()),
        remote_token: Some(token),
        remote_auth_mode: None,
    })
    .await
    .expect("connection test ok");

    assert!(result.http_ok, "HTTP step failed: {:?}", result.error);
    assert!(result.ws_ok, "WS handshake failed: {:?}", result.error);
    assert!(result.ok, "expected overall-ok: {:?}", result.error);
}

/// Real counterpart of api_proxy.rs `injects_bearer_and_session_token_headers
/// _when_token_present` — the proxied GET /api/status must succeed on the real
/// dashboard with the token attached.
#[tokio::test]
#[serial]
async fn real_api_proxy_forwards_status() {
    let Some(b) = backend_or_skip() else { return };
    let result = api_request_impl(
        ApiRequestInput {
            path: "/api/status".to_string(),
            method: Some("GET".to_string()),
            headers: None,
            body: None,
        },
        &b.base_url,
        b.token.as_deref(),
        &b.hermes_home(),
    )
    .await
    .expect("api_request should succeed");
    assert_eq!(result.status, 200);
    assert!(result.ok);
    assert!(
        result.body.contains("version"),
        "real /api/status body should carry a version, got: {}",
        &result.body[..result.body.len().min(200)]
    );
}

/// Real counterpart of api_proxy.rs `post_body_is_forwarded_verbatim` and the
/// sessions-list path — the proxied REST surface works against the real
/// dashboard.
#[tokio::test]
#[serial]
async fn real_api_proxy_forwards_sessions() {
    let Some(b) = backend_or_skip() else { return };
    let result = api_request_impl(
        ApiRequestInput {
            path: "/api/sessions".to_string(),
            method: Some("GET".to_string()),
            headers: None,
            body: None,
        },
        &b.base_url,
        b.token.as_deref(),
        &b.hermes_home(),
    )
    .await
    .expect("api_request should succeed");
    assert_eq!(result.status, 200);
    assert!(
        result.ok,
        "body: {}",
        &result.body[..result.body.len().min(300)]
    );
}

/// Real counterpart of api_proxy.rs `absolute_url_outside_origin_is_rejected` —
/// the origin guard must hold even when a REAL dashboard is reachable.
#[tokio::test]
#[serial]
async fn real_api_proxy_rejects_cross_origin() {
    let Some(b) = backend_or_skip() else { return };
    let home = tempfile::TempDir::new().expect("temp home");
    let err = api_request_impl(
        ApiRequestInput {
            path: "https://evil.example.com/api/data".to_string(),
            method: Some("GET".to_string()),
            headers: None,
            body: None,
        },
        &b.base_url,
        None,
        home.path().to_str().unwrap(),
    )
    .await
    .expect_err("cross-origin request must be rejected even with a live backend");
    assert!(
        matches!(err, AppError::OriginViolation(_)),
        "expected OriginViolation, got {err:?}"
    );
}

/// Real counterpart of runtime_manifest.rs `returns_manifest_when_remote_
/// responds_with_valid_json` — fetches the manifest from a REAL external URL
/// (HERMES_REAL_MANIFEST_URL; the production GitHub Releases URL in
/// verification). Explicitly gated so an auto-started suite never surprises
/// anyone with network traffic.
#[tokio::test]
#[serial]
async fn real_runtime_update_manifest_from_external_url() {
    let Some(url) = env_non_empty("HERMES_REAL_MANIFEST_URL") else {
        eprintln!(
            "[real_backend] SKIP: real manifest test needs HERMES_REAL_MANIFEST_URL \
             (e.g. https://github.com/Eynzof/Hermes-CN-Core/releases/latest/download/\
             stable-{}-{}.json)",
            host_platform(),
            host_arch()
        );
        return;
    };
    if backend_or_skip().is_none() {
        return;
    }
    let _root = isolate_runtime_root();
    std::env::set_var("HERMES_RUNTIME_UPDATE_MANIFEST_URL", &url);
    let result = check_runtime_update().await;
    std::env::remove_var("HERMES_RUNTIME_UPDATE_MANIFEST_URL");

    assert!(result.ok, "real manifest fetch failed: {:?}", result.error);
    let manifest = result.manifest.expect("manifest should be present");
    assert_eq!(manifest.platform, host_platform());
    assert_eq!(manifest.arch, host_arch());
    assert!(!manifest.runtime_version.is_empty());
    assert!(!manifest.artifact_url.is_empty());
}

/// Real counterpart of dashboard_spawn_retry.rs — instead of a fake shell
/// script kernel, the record points at the REAL Core venv python, so
/// `ensure_hermes_dashboard` spawns the real dashboard through the full
/// managed-runtime path (resolve → spawn → ready-file + token identity wait).
#[tokio::test]
#[serial]
async fn real_managed_runtime_spawns_the_real_dashboard() {
    init_logging();
    let Some(b) = backend_or_skip() else { return };
    let Some((_core_dir, hermes)) = core_dir_and_hermes() else {
        eprintln!(
            "[real_backend] SKIP: managed-runtime spawn test needs a Core checkout \
             with a venv console script (HERMES_CORE_DIR + hermes.exe/bin/hermes)"
        );
        return;
    };

    let _root = isolate_runtime_root();
    let runtime_root = _root.path().to_path_buf();
    let home = runtime_root.join("hermes-home");
    std::fs::create_dir_all(&home).expect("hermes-home");
    std::fs::write(home.join("config.yaml"), STUB_CONFIG).expect("config.yaml");

    // Stub SPA so the kernel serves a web UI without an npm build.
    let web_dist = runtime_root
        .join("_internal")
        .join("hermes_cli")
        .join("web_dist");
    std::fs::create_dir_all(web_dist.join("assets")).expect("assets dir");
    std::fs::write(web_dist.join("index.html"), STUB_INDEX).expect("index.html");

    let record = RuntimeInstallRecord {
        schema_version: 2,
        runtime_version: "0.0.0-real-backend".to_string(),
        kernel_version: "0.0.0-real-backend".to_string(),
        runtime_flavor: "cn".to_string(),
        runtime_revision: 1,
        platform: host_platform().to_string(),
        arch: host_arch().to_string(),
        path: runtime_root.to_string_lossy().to_string(),
        executable_path: hermes.to_string_lossy().to_string(),
        source: "real-backend-test".to_string(),
        installed_at: "1970-01-01T00:00:00Z".to_string(),
        source_repo: None,
        source_commit: None,
        local_dirty_hash: None,
        artifact_sha256: None,
        previous_runtime_version: None,
    };
    std::fs::write(
        runtime_root.join("current.json"),
        serde_json::to_string_pretty(&record).expect("serialize record"),
    )
    .expect("write current.json");

    // The kernel is spawned from the checkout's venv; keep its telemetry and
    // lazy pip installs off.
    std::env::set_var("HERMES_NO_ANALYTICS", "1");
    std::env::set_var("HERMES_DISABLE_LAZY_INSTALLS", "1");

    let port = free_port().expect("free port");
    let mut handle = ensure_hermes_dashboard(EnsureDashboardOptions {
        host: "127.0.0.1".to_string(),
        port,
        hermes_home: home.to_string_lossy().to_string(),
        allow_external_agent: false,
        allow_port_fallback: false,
        connection_mode: ConnectionMode::Managed,
        remote_base_url: None,
    })
    .await
    .expect("managed spawn of the real Core dashboard should become ready");

    assert_eq!(handle.api_base_url, format!("http://127.0.0.1:{port}"));
    assert!(handle.owns_process, "desktop must own the spawned kernel");
    assert!(
        handle.session_token.is_some(),
        "spawn must mint a session token"
    );
    assert_eq!(
        handle.ownership_state.as_deref(),
        Some("owned"),
        "the kernel must be owned by this desktop"
    );
    assert!(
        probe_dashboard(&handle.api_base_url).await,
        "spawned real dashboard must answer /api/status"
    );

    // Reap the kernel so it doesn't outlive the test.
    if let Some(mut child) = handle.child.take() {
        let _ = child.kill();
        let _ = child.wait();
    }

    // Sanity: the record + runtime root the desktop used are the temp ones.
    assert_eq!(
        hermes_agent_cn::process::runtime::runtime_root(),
        runtime_root
    );
    let _ = b; // shared backend stays alive for the remaining tests
}
