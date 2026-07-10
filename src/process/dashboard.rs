// Dashboard process management.
//
// Replaces hermes-cn-ui-v1/apps/desktop/src/main/hermes-process.ts.
// Responsible for probing, spawning, and managing the hermes dashboard subprocess.

use std::fs;
use std::io::Write;
use std::net::{TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::LazyLock;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use std::{
    io::{BufRead, BufReader, Read},
    thread,
};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::error::AppError;
use crate::state::{DashboardHandle, DashboardJobHandle};

// A freshly installed onefile runtime can spend tens of seconds on macOS
// unpacking/importing its embedded Python payload before the dashboard process
// begins serving HTTP. Local-source dev runtimes can also cross the old 60s
// boundary on cold caches, leaving a dashboard that becomes ready just after
// bootstrap has already failed. Keep a wider production-safe margin.
const DASHBOARD_READY_TIMEOUT: Duration = Duration::from_secs(120);
const PROBE_TIMEOUT: Duration = Duration::from_millis(900);
const SESSION_TOKEN_TIMEOUT: Duration = Duration::from_secs(3);
const ATTACHED_DASHBOARD_TIMEOUT: Duration = Duration::from_secs(5);
const SHUTDOWN_HTTP_TIMEOUT: Duration = Duration::from_millis(800);
const GRACEFUL_SHUTDOWN_TIMEOUT: Duration = Duration::from_millis(1800);
const FORCE_SHUTDOWN_TIMEOUT: Duration = Duration::from_millis(1200);
const OWNERSHIP_MARKER_SCHEMA_VERSION: u32 = 1;
pub const DEFAULT_DESKTOP_DASHBOARD_PORT: u16 = 9120;
const DASHBOARD_PORT_FALLBACK_LIMIT: u16 = 20;
/// How many spawn attempts (initial + retries on a lost bind race) before
/// giving up — bounds the damage of a crash-looping runtime, which would
/// otherwise burn the entire fallback range one kernel at a time.
const SPAWN_ATTEMPT_LIMIT: usize = 3;
static SESSION_TOKEN_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"__HERMES_SESSION_TOKEN__="([^"]+)""#).expect("valid session token regex")
});
static PROBE_HTTP_CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .timeout(PROBE_TIMEOUT)
        .build()
        .expect("valid dashboard probe HTTP client")
});
static SESSION_TOKEN_HTTP_CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .timeout(SESSION_TOKEN_TIMEOUT)
        .build()
        .expect("valid dashboard session token HTTP client")
});
static ATTACHED_HTTP_CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .timeout(ATTACHED_DASHBOARD_TIMEOUT)
        .build()
        .expect("valid attached dashboard HTTP client")
});

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DashboardOwnershipMarker {
    pub schema_version: u32,
    pub run_id: String,
    pub desktop_pid: u32,
    pub dashboard_pid: u32,
    pub api_base_url: String,
    pub hermes_home: String,
    pub runtime_root: String,
    pub gateway_runtime_dir: String,
    pub started_at_ms: u128,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime_version: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MarkerOwnerState {
    Missing,
    LiveDesktopOwner,
    StaleDesktopOwner,
    NotThisDashboard,
}

pub fn ownership_marker_path() -> PathBuf {
    crate::process::runtime::runtime_root().join("desktop-owner.json")
}

pub fn ownership_marker_path_display() -> String {
    ownership_marker_path().to_string_lossy().to_string()
}

/// Build the base URL for a dashboard at the given host and port.
pub fn dashboard_base_url(host: &str, port: u16) -> String {
    format!("http://{}:{}", host, port)
}

fn fallback_ports(start: u16) -> Vec<u16> {
    let mut ports = Vec::new();
    for offset in 1..=DASHBOARD_PORT_FALLBACK_LIMIT {
        let Some(port) = start.checked_add(offset) else {
            break;
        };
        ports.push(port);
    }
    ports
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn read_ownership_marker() -> Option<DashboardOwnershipMarker> {
    let path = ownership_marker_path();
    let content = fs::read_to_string(path).ok()?;
    serde_json::from_str(&content).ok()
}

fn write_ownership_marker(marker: &DashboardOwnershipMarker) -> Result<(), String> {
    let path = ownership_marker_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(marker).map_err(|e| e.to_string())?;
    fs::write(path, format!("{}\n", json)).map_err(|e| e.to_string())
}

fn rewrite_ownership_marker_for_current_desktop(
    marker: &DashboardOwnershipMarker,
) -> Result<DashboardOwnershipMarker, String> {
    let next = DashboardOwnershipMarker {
        schema_version: OWNERSHIP_MARKER_SCHEMA_VERSION,
        run_id: format!("{}-{}", std::process::id(), now_millis()),
        desktop_pid: std::process::id(),
        dashboard_pid: marker.dashboard_pid,
        api_base_url: marker.api_base_url.clone(),
        hermes_home: marker.hermes_home.clone(),
        runtime_root: marker.runtime_root.clone(),
        gateway_runtime_dir: marker.gateway_runtime_dir.clone(),
        started_at_ms: now_millis(),
        runtime_version: marker.runtime_version.clone(),
    };
    write_ownership_marker(&next)?;
    Ok(next)
}

pub fn remove_ownership_marker_path(path: Option<&str>) {
    let marker_path = path
        .map(PathBuf::from)
        .unwrap_or_else(ownership_marker_path);
    if let Err(err) = fs::remove_file(&marker_path) {
        if err.kind() != std::io::ErrorKind::NotFound {
            log::warn!(
                "Failed to remove dashboard ownership marker {}: {}",
                marker_path.display(),
                err
            );
        }
    }
}

fn same_path(left: &str, right: &str) -> bool {
    let left = fs::canonicalize(left).unwrap_or_else(|_| PathBuf::from(left));
    let right = fs::canonicalize(right).unwrap_or_else(|_| PathBuf::from(right));
    left == right
}

fn marker_owner_state(
    marker: Option<&DashboardOwnershipMarker>,
    api_base_url: &str,
    hermes_home: &str,
) -> MarkerOwnerState {
    let Some(marker) = marker else {
        return MarkerOwnerState::Missing;
    };
    if marker.schema_version != OWNERSHIP_MARKER_SCHEMA_VERSION
        || marker.api_base_url != api_base_url
        || !same_path(&marker.hermes_home, hermes_home)
    {
        return MarkerOwnerState::NotThisDashboard;
    }
    if pid_is_running(marker.desktop_pid) {
        MarkerOwnerState::LiveDesktopOwner
    } else {
        MarkerOwnerState::StaleDesktopOwner
    }
}

#[cfg(unix)]
fn pid_is_running(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    let rc = unsafe { libc::kill(pid as libc::pid_t, 0) };
    rc == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(windows)]
fn pid_is_running(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    let filter = format!("PID eq {}", pid);
    let Ok(output) = Command::new("tasklist")
        .args(["/FI", &filter, "/FO", "CSV", "/NH"])
        .output()
    else {
        return false;
    };
    String::from_utf8_lossy(&output.stdout).contains(&pid.to_string())
}

#[cfg(not(any(unix, windows)))]
fn pid_is_running(_pid: u32) -> bool {
    false
}

fn wait_for_child_exit(child: &mut Child, timeout: Duration) -> bool {
    let start = Instant::now();
    while start.elapsed() < timeout {
        match child.try_wait() {
            Ok(Some(_)) => return true,
            Ok(None) => thread::sleep(Duration::from_millis(80)),
            Err(_) => return true,
        }
    }
    false
}

fn request_dashboard_shutdown(api_base_url: &str, session_token: Option<&str>) -> bool {
    let shutdown_url = format!("{}/api/shutdown", api_base_url.trim_end_matches('/'));
    let parsed = match url::Url::parse(&shutdown_url) {
        Ok(url) => url,
        Err(err) => {
            log::debug!("Invalid dashboard shutdown URL {}: {}", shutdown_url, err);
            return false;
        }
    };
    if parsed.scheme() != "http" {
        log::debug!(
            "Skipping dashboard graceful shutdown for unsupported scheme {}",
            parsed.scheme()
        );
        return false;
    }
    let Some(host) = parsed.host_str() else {
        return false;
    };
    let port = parsed.port_or_known_default().unwrap_or(80);
    let path = match parsed.query() {
        Some(query) => format!("{}?{}", parsed.path(), query),
        None => parsed.path().to_string(),
    };

    let mut stream = match TcpStream::connect_timeout(
        &(host, port)
            .to_socket_addrs()
            .ok()
            .and_then(|mut addrs| addrs.next())
            .unwrap_or_else(|| std::net::SocketAddr::from(([127, 0, 0, 1], 0))),
        SHUTDOWN_HTTP_TIMEOUT,
    ) {
        Ok(stream) => stream,
        Err(err) => {
            log::debug!("Dashboard graceful shutdown endpoint unavailable: {}", err);
            return false;
        }
    };
    let _ = stream.set_read_timeout(Some(SHUTDOWN_HTTP_TIMEOUT));
    let _ = stream.set_write_timeout(Some(SHUTDOWN_HTTP_TIMEOUT));

    let mut request = format!(
        "POST {} HTTP/1.1\r\nHost: {}:{}\r\nAccept: application/json\r\nContent-Length: 0\r\nConnection: close\r\n",
        path, host, port
    );
    if let Some(token) = session_token.filter(|token| !token.is_empty()) {
        request.push_str(&format!(
            "Authorization: Bearer {}\r\nX-Hermes-Session-Token: {}\r\n",
            token, token
        ));
    }
    request.push_str("\r\n");

    if let Err(err) = stream.write_all(request.as_bytes()) {
        log::debug!("Dashboard graceful shutdown request failed: {}", err);
        return false;
    }
    let mut response = String::new();
    if let Err(err) = stream.read_to_string(&mut response) {
        log::debug!("Dashboard graceful shutdown response failed: {}", err);
        return false;
    }
    let status = response
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse::<u16>().ok())
        .unwrap_or(0);
    if (200..300).contains(&status) {
        true
    } else {
        if status != 404 {
            log::debug!(
                "Dashboard graceful shutdown endpoint returned HTTP {}",
                status
            );
        }
        false
    }
}

#[cfg(unix)]
fn signal_process_group(pid: u32, signal: libc::c_int) {
    if pid == 0 {
        return;
    }
    let pgid = -(pid as libc::pid_t);
    let rc = unsafe { libc::kill(pgid, signal) };
    if rc != 0 {
        log::debug!(
            "Failed to signal dashboard process group {} with {}: {}",
            pid,
            signal,
            std::io::Error::last_os_error()
        );
    }
}

#[cfg(not(unix))]
fn signal_process_group(_pid: u32, _signal: i32) {}

#[cfg(windows)]
fn create_dashboard_job(child: &Child) -> Result<DashboardJobHandle, String> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
    if job.is_null() {
        return Err(std::io::Error::last_os_error().to_string());
    }

    let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    let set_ok = unsafe {
        SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const _,
            std::mem::size_of_val(&info) as u32,
        )
    };
    if set_ok == 0 {
        let err = std::io::Error::last_os_error().to_string();
        unsafe { CloseHandle(job) };
        return Err(err);
    }

    let process = child.as_raw_handle() as HANDLE;
    let assign_ok = unsafe { AssignProcessToJobObject(job, process) };
    if assign_ok == 0 {
        let err = std::io::Error::last_os_error().to_string();
        unsafe { CloseHandle(job) };
        return Err(err);
    }

    Ok(unsafe { DashboardJobHandle::from_raw(job) })
}

#[cfg(windows)]
fn force_kill_process_tree(pid: u32) {
    if pid == 0 {
        return;
    }
    let pid_arg = pid.to_string();
    let _ = Command::new("taskkill")
        .args(["/PID", &pid_arg, "/T", "/F"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

pub fn terminate_owned_dashboard_tree(
    api_base_url: &str,
    child: Option<&mut Child>,
    fallback_pid: Option<u32>,
    session_token: Option<&str>,
) {
    let _ = request_dashboard_shutdown(api_base_url, session_token);

    if let Some(child) = child {
        if wait_for_child_exit(child, GRACEFUL_SHUTDOWN_TIMEOUT) {
            return;
        }
        let pid = child.id();
        #[cfg(unix)]
        signal_process_group(pid, libc::SIGTERM);
        if wait_for_child_exit(child, FORCE_SHUTDOWN_TIMEOUT) {
            return;
        }
        #[cfg(unix)]
        signal_process_group(pid, libc::SIGKILL);
        #[cfg(windows)]
        force_kill_process_tree(pid);
        let _ = child.kill();
        let _ = child.wait();
        return;
    }

    if let Some(pid) = fallback_pid {
        #[cfg(unix)]
        {
            signal_process_group(pid, libc::SIGTERM);
            thread::sleep(GRACEFUL_SHUTDOWN_TIMEOUT);
            if pid_is_running(pid) {
                signal_process_group(pid, libc::SIGKILL);
            }
        }
        #[cfg(windows)]
        {
            force_kill_process_tree(pid);
        }
    }
}

fn probe_dashboard_port(api_base_url: &str) -> bool {
    let parsed = match url::Url::parse(api_base_url) {
        Ok(url) => url,
        Err(err) => {
            log::debug!("Invalid dashboard probe URL {}: {}", api_base_url, err);
            return false;
        }
    };
    if !matches!(parsed.scheme(), "http" | "https") {
        return false;
    }
    let Some(host) = parsed.host_str() else {
        return false;
    };
    let port = parsed.port_or_known_default().unwrap_or(80);
    let Some(addr) = (host, port)
        .to_socket_addrs()
        .ok()
        .and_then(|mut addrs| addrs.next())
    else {
        return false;
    };
    TcpStream::connect_timeout(&addr, PROBE_TIMEOUT).is_ok()
}

/// Check if a compatible dashboard status endpoint is reachable at the given
/// base URL. Returns true if /api/status responds with 2xx or 401.
pub async fn probe_dashboard(api_base_url: &str) -> bool {
    let url = format!("{}/api/status", api_base_url);

    match PROBE_HTTP_CLIENT
        .get(&url)
        .header("Accept", "application/json")
        .send()
        .await
    {
        Ok(res) => res.status().is_success() || res.status().as_u16() == 401,
        Err(_) => false,
    }
}

/// More tolerant probe for an already-running local/remote dashboard we do not
/// own. The normal readiness probe is intentionally short so managed startup
/// loops remain responsive, but a user CLI dashboard can briefly spend more
/// than 900ms in `/api/status` while spawning TUI sidecars or loading plugins.
/// Treat that as transient instead of reporting "9119 unreachable".
pub async fn probe_attached_dashboard(api_base_url: &str) -> bool {
    let url = format!("{}/api/status", api_base_url);

    for attempt in 0..3 {
        match ATTACHED_HTTP_CLIENT
            .get(&url)
            .header("Accept", "application/json")
            .send()
            .await
        {
            Ok(res) if res.status().is_success() || res.status().as_u16() == 401 => {
                return true;
            }
            Ok(res) => {
                log::debug!(
                    "Attached dashboard probe at {} returned HTTP {}",
                    api_base_url,
                    res.status()
                );
            }
            Err(err) => {
                log::debug!(
                    "Attached dashboard probe attempt {} at {} failed: {}",
                    attempt + 1,
                    api_base_url,
                    err
                );
            }
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }

    if probe_dashboard_port(api_base_url) {
        log::warn!(
            "Attached dashboard port is listening at {}, but /api/status did not answer within {:?}",
            api_base_url,
            ATTACHED_DASHBOARD_TIMEOUT
        );
    }
    false
}

async fn probe_dashboard_openapi(api_base_url: &str) -> bool {
    let url = format!("{}/openapi.json", api_base_url);

    matches!(
        PROBE_HTTP_CLIENT
            .get(&url)
            .header("Accept", "application/json")
            .send()
            .await,
        Ok(res) if res.status().is_success()
    )
}

/// Check whether a newly spawned dashboard is far enough along to be adopted.
///
/// The full `/api/status` route does config, gateway, and SQLite work. On a
/// cold Windows first-run it can exceed the short probe timeout even after
/// uvicorn has already mounted the app, which makes the desktop kill a usable
/// runtime with "Not ready ... within 120s". For the child we just spawned,
/// `/openapi.json` is a lighter proof that FastAPI is serving the dashboard.
async fn probe_spawned_dashboard_ready(api_base_url: &str) -> bool {
    if probe_dashboard(api_base_url).await {
        return true;
    }
    if probe_dashboard_openapi(api_base_url).await {
        log::debug!(
            "Dashboard OpenAPI is reachable at {}, but /api/status did not answer within {:?}; treating spawned dashboard as ready",
            api_base_url,
            PROBE_TIMEOUT
        );
        return true;
    }
    if probe_dashboard_port(api_base_url) {
        log::debug!(
            "Dashboard port is listening at {}, but HTTP readiness probes are not passing yet",
            api_base_url
        );
    }
    false
}

/// Check if the dashboard at the given URL supports the /api/upload endpoint
/// (indicates our fork/patched version).
async fn dashboard_supports_uploads(api_base_url: &str) -> bool {
    has_openapi_path(api_base_url, "/api/upload").await
}

/// Probe the upstream-native `/api/ws` gateway by actually completing a
/// WebSocket handshake (the route is a WS upgrade, so it never appears in
/// openapi.json — an HTTP GET can't verify it). The connection is dropped
/// immediately after the handshake; the server reaps the orphan transport.
pub async fn dashboard_supports_ws(api_base_url: &str, token: Option<&str>) -> bool {
    let url = build_gateway_url(api_base_url, token);
    matches!(
        tokio::time::timeout(
            std::time::Duration::from_secs(4),
            tokio_tungstenite::connect_async(url),
        )
        .await,
        Ok(Ok(_))
    )
}

async fn has_openapi_path(api_base_url: &str, path: &str) -> bool {
    let url = format!("{}/openapi.json", api_base_url);

    match PROBE_HTTP_CLIENT
        .get(&url)
        .header("Accept", "application/json")
        .send()
        .await
    {
        Ok(res) if res.status().is_success() => {
            if let Ok(data) = res.json::<serde_json::Value>().await {
                data.get("paths").and_then(|p| p.get(path)).is_some()
            } else {
                false
            }
        }
        _ => false,
    }
}

/// Get the HERMES_HOME value from a running dashboard.
pub async fn fetch_dashboard_hermes_home(api_base_url: &str) -> Option<String> {
    let url = format!("{}/api/status", api_base_url);

    let res = PROBE_HTTP_CLIENT
        .get(&url)
        .header("Accept", "application/json")
        .send()
        .await
        .ok()?;
    let data: serde_json::Value = res.json().await.ok()?;
    data.get("hermes_home")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

/// Tolerant HERMES_HOME lookup for attached local dashboards. This mirrors
/// `probe_attached_dashboard` so a busy CLI dashboard does not make the
/// desktop fall back to its managed runtime data root.
pub async fn fetch_attached_dashboard_hermes_home(api_base_url: &str) -> Option<String> {
    let url = format!("{}/api/status", api_base_url);

    for attempt in 0..3 {
        match ATTACHED_HTTP_CLIENT
            .get(&url)
            .header("Accept", "application/json")
            .send()
            .await
        {
            Ok(res) => match res.json::<serde_json::Value>().await {
                Ok(data) => {
                    if let Some(home) = data
                        .get("hermes_home")
                        .and_then(|v| v.as_str())
                        .map(str::to_string)
                        .filter(|s| !s.trim().is_empty())
                    {
                        return Some(home);
                    }
                }
                Err(err) => {
                    log::debug!(
                        "Attached dashboard hermes_home parse attempt {} at {} failed: {}",
                        attempt + 1,
                        api_base_url,
                        err
                    );
                }
            },
            Err(err) => {
                log::debug!(
                    "Attached dashboard hermes_home attempt {} at {} failed: {}",
                    attempt + 1,
                    api_base_url,
                    err
                );
            }
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }

    None
}

/// Check whether an existing dashboard's hermes_home matches ours.
async fn dashboard_matches_hermes_home(api_base_url: &str, hermes_home: &str) -> bool {
    match fetch_dashboard_hermes_home(api_base_url).await {
        Some(current) if !current.is_empty() => {
            let left = std::fs::canonicalize(&current).unwrap_or_else(|_| PathBuf::from(&current));
            let right =
                std::fs::canonicalize(hermes_home).unwrap_or_else(|_| PathBuf::from(hermes_home));
            left == right
        }
        _ => false,
    }
}

/// Fetch the session token from the dashboard's HTML page.
/// The token is embedded as `__HERMES_SESSION_TOKEN__="<token>"`.
pub async fn fetch_session_token(api_base_url: &str) -> Option<String> {
    let url = format!("{}/", api_base_url);

    let res = SESSION_TOKEN_HTTP_CLIENT
        .get(&url)
        .header("Accept", "text/html")
        .send()
        .await
        .ok()?;
    if !res.status().is_success() {
        return None;
    }
    let html = res.text().await.ok()?;
    SESSION_TOKEN_RE.captures(&html).map(|c| c[1].to_string())
}

/// Build a WebSocket gateway URL from the dashboard API base URL.
pub fn build_gateway_url(api_base_url: &str, token: Option<&str>) -> String {
    let ws_url = api_base_url
        .replace("http://", "ws://")
        .replace("https://", "wss://");
    match token {
        Some(t) => format!(
            "{}/api/ws?token={}",
            ws_url.trim_end_matches('/'),
            urlencoding::encode(t)
        ),
        None => format!("{}/api/ws", ws_url.trim_end_matches('/')),
    }
}

pub struct EnsureDashboardOptions {
    pub host: String,
    pub port: u16,
    pub hermes_home: String,
    /// Whether the desktop is allowed to reuse/spawn a dashboard outside the
    /// managed runtime directory. This is intentionally false for the product
    /// and for managed dev: the kernel must live under runtime/current.json.
    pub allow_external_agent: bool,
    /// Whether an occupied primary port may fall back to port+1..port+20.
    /// Production can do this because the Tauri bridge receives the final
    /// apiBaseUrl. Vite dev proxy is fixed before Rust starts, so managed dev
    /// keeps this false and asks the user to free the port instead.
    pub allow_port_fallback: bool,
}

struct SpawnedDashboard {
    child: Child,
    session_token: Option<String>,
    command_program: String,
    command_args: Vec<String>,
    gateway_runtime_dir: String,
    gateway_lock_dir: String,
    ownership_marker_path: String,
    job_handle: Option<DashboardJobHandle>,
    /// Unique path this spawn's kernel writes `{"port": N}` to once its
    /// socket is bound (`HERMES_DESKTOP_READY_FILE`). Only this shell and
    /// this child know the path, so its appearance is an identity-proving
    /// readiness signal — unlike an HTTP probe of the port, which any
    /// process that stole the port could answer.
    ready_file: PathBuf,
}

/// Ready files live in the runtime root as `dashboard-ready-<pid>-<ms>.json`.
const READY_FILE_PREFIX: &str = "dashboard-ready-";

fn new_ready_file_path() -> PathBuf {
    crate::process::runtime::runtime_root().join(format!(
        "{READY_FILE_PREFIX}{}-{}.json",
        std::process::id(),
        now_millis()
    ))
}

/// Remove leftover ready files from crashed shells. Called on the ensure
/// path while holding the single-instance lock, so no sibling shell on this
/// runtime root can be mid-spawn.
fn sweep_stale_ready_files() {
    let root = crate::process::runtime::runtime_root();
    let Ok(entries) = fs::read_dir(&root) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with(READY_FILE_PREFIX) && name.ends_with(".json") {
            if let Err(err) = fs::remove_file(entry.path()) {
                log::debug!("stale ready-file cleanup {}: {err}", name);
            }
        }
    }
}

fn remove_ready_file(path: &Path) {
    match fs::remove_file(path) {
        Ok(()) => {}
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => log::debug!("ready-file cleanup {}: {err}", path.display()),
    }
}

/// Parse the kernel-written ready payload (`{"port": N}`). Written
/// atomically by Core (`_write_dashboard_ready_file`) after the socket is
/// bound, so a readable file means the dashboard is serving.
fn read_ready_file_port(path: &Path) -> Option<u16> {
    let body = fs::read_to_string(path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&body).ok()?;
    value.get("port")?.as_u64()?.try_into().ok()
}

fn env_flag(name: &str) -> bool {
    std::env::var(name)
        .ok()
        .map(|value| crate::util::str_is_truthy(&value))
        .unwrap_or(false)
}

fn configured_session_token() -> Option<String> {
    [
        "HERMES_DESKTOP_SESSION_TOKEN",
        "HERMES_DASHBOARD_SESSION_TOKEN",
    ]
    .iter()
    .find_map(|name| {
        std::env::var(name)
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    })
}

fn generate_session_token() -> Option<String> {
    let mut bytes = [0_u8; 32];
    if let Err(err) = getrandom::fill(&mut bytes) {
        log::warn!("Failed to generate dashboard session token: {}", err);
        return None;
    }
    Some(URL_SAFE_NO_PAD.encode(bytes))
}

fn session_token_for_spawn() -> Option<String> {
    configured_session_token().or_else(generate_session_token)
}

async fn known_session_token_for_existing(api_base_url: &str) -> Option<String> {
    match configured_session_token() {
        Some(token) => Some(token),
        None => fetch_session_token(api_base_url).await,
    }
}

/// Whether YOLO mode should be active for a managed dashboard bound to
/// `hermes_home`.
///
/// The persisted desktop toggle (UI-store KV, see
/// [`crate::ui_store::yolo_mode_preference`]) is authoritative: an explicit
/// preference — including an explicit "off" — wins over any inherited
/// `HERMES_YOLO_MODE` in the desktop's own environment. So disabling YOLO in
/// the UI truly disables it, even when the desktop process was launched with
/// `HERMES_YOLO_MODE=1` (see #287). The env var only acts as the default before
/// the user has ever touched the toggle, preserving the documented power-user /
/// dev escape hatch from #78.
pub fn yolo_mode_effective(hermes_home: &str) -> bool {
    match crate::ui_store::yolo_mode_preference(hermes_home) {
        Some(pref) => pref,
        None => env_flag("HERMES_YOLO_MODE"),
    }
}

pub fn external_agent_allowed() -> bool {
    if env_flag("HERMES_DESKTOP_ALLOW_EXTERNAL_AGENT")
        || env_flag("HERMES_DESKTOP_DEV_EXTERNAL_DASHBOARD")
    {
        log::warn!(
            "Ignoring external desktop-agent flags; desktop is locked to the managed runtime"
        );
    }
    false
}

pub fn dev_external_dashboard_enabled() -> bool {
    if env_flag("HERMES_DESKTOP_DEV_EXTERNAL_DASHBOARD") {
        log::warn!(
            "Ignoring HERMES_DESKTOP_DEV_EXTERNAL_DASHBOARD; desktop is locked to the managed runtime"
        );
    }
    false
}

/// Find and resolve the hermes executable path.
/// Order: managed runtime (current.json) only.
///
/// The desktop is deliberately locked to the fork-specific managed runtime so
/// the kernel, HERMES_HOME, gateway pid/lock/status files, and runtime assets
/// stay under one desktop-owned runtime root. External PATH / shell commands
/// are not accepted, even in dev mode.
fn resolve_hermes_command(allow_external_agent: bool) -> Result<(String, Vec<String>), AppError> {
    if let Some(record) = crate::process::runtime::read_current_record() {
        log::info!(
            "Using managed runtime v{} at {}",
            record.runtime_version,
            record.executable_path
        );
        return Ok((record.executable_path, vec![]));
    }

    if allow_external_agent || std::env::var("HERMES_DESKTOP_AGENT_COMMAND").is_ok() {
        log::warn!(
            "Ignoring external agent configuration; desktop requires managed runtime at {}",
            crate::process::runtime::current_record_path_display()
        );
    }

    Err(AppError::RuntimeUnavailable(format!(
        "Managed runtime is not installed at {}. The desktop is locked to its bundled managed runtime and will not fall back to PATH or HERMES_DESKTOP_AGENT_COMMAND.",
        crate::process::runtime::current_record_path_display()
    )))
}

/// Spawn the hermes dashboard subprocess.
fn spawn_dashboard(options: &EnsureDashboardOptions) -> Result<SpawnedDashboard, AppError> {
    let (program, mut prefix_args) = resolve_hermes_command(options.allow_external_agent)?;

    let api_args = vec![
        "dashboard".to_string(),
        "--host".to_string(),
        options.host.clone(),
        "--port".to_string(),
        options.port.to_string(),
        "--no-open".to_string(),
    ];

    prefix_args.extend(api_args);

    let mut cmd = Command::new(&program);
    if let Some(program_dir) = Path::new(&program)
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
    {
        cmd.current_dir(program_dir);
    }
    // User-configured $HERMES_HOME/.env goes in first so every explicit
    // .env(...) below — and the env_remove for HERMES_YOLO_MODE — wins
    // over file contents. Re-read on every respawn so profile switches and
    // .env edits take effect without restarting the desktop. See #197.
    crate::env_file::inject_env_file(&mut cmd, &options.hermes_home, "dashboard");
    // The effective PATH (login shell / registry merged) is the lifeline for
    // the whole runtime tree: dashboard → gateway → MCP stdio servers only
    // see node/npx/rg through it (#190 #196 #197). env_file treats PATH as a
    // reserved key, so this explicit set is the single source of child PATH.
    // Prepend the bundled node bin dir (P-032) so /chat's Ink TUI and
    // node-based MCP servers work without a host Node install.
    let effective_path = crate::process::runtime::prepend_bundled_node_to_path(
        crate::path_resolver::effective_path_os(),
    );
    cmd.env("PATH", &effective_path);
    let session_token = session_token_for_spawn();
    let gateway_runtime_dir = crate::process::runtime::gateway_runtime_dir();
    let gateway_lock_dir = gateway_runtime_dir.join("token-locks");
    let _ = std::fs::create_dir_all(&gateway_lock_dir);
    let _ = std::fs::create_dir_all(&gateway_runtime_dir);
    cmd.args(&prefix_args)
        .env("HERMES_HOME", &options.hermes_home)
        .env(
            "HERMES_DASHBOARD_TUI",
            std::env::var("HERMES_DASHBOARD_TUI").unwrap_or_else(|_| "1".to_string()),
        )
        // Packaged managed runtimes are frozen app bundles, not writable Python
        // virtualenvs. If a dashboard import tries Hermes's lazy dependency
        // installer, `sys.executable -m pip ...` recursively launches the
        // frozen runtime executable on Windows and can stall first boot. The
        // installer already bundles the required dashboard dependencies, so
        // fail missing optional deps explicitly instead of attempting pip.
        .env("HERMES_DISABLE_LAZY_INSTALLS", "1")
        // Keep the first-run critical path focused on binding the dashboard.
        // Heavy agent imports can still happen on demand after the UI is ready.
        .env(
            "HERMES_DASHBOARD_PREWARM_AGENT",
            std::env::var("HERMES_DASHBOARD_PREWARM_AGENT").unwrap_or_else(|_| "0".to_string()),
        );
    if let Some(token) = session_token.as_deref() {
        cmd.env("HERMES_DASHBOARD_SESSION_TOKEN", token);
    }
    if let Some(web_dist) = crate::process::runtime::current_dashboard_web_dist_dir() {
        cmd.env("HERMES_WEB_DIST", &web_dist);
    } else {
        log::warn!("Dashboard web_dist is missing from the managed runtime");
    }
    if let Some(skills_dir) = crate::process::runtime::current_bundled_skills_dir() {
        cmd.env("HERMES_BUNDLED_SKILLS", &skills_dir);
    } else {
        log::warn!("Bundled skills are missing from the managed runtime");
    }
    if let Some(plugins_dir) = crate::process::runtime::current_bundled_plugins_dir() {
        cmd.env("HERMES_BUNDLED_PLUGINS", &plugins_dir);
    } else {
        log::warn!("Bundled plugins are missing from the managed runtime");
    }
    // Bundled Node runtime + prebuilt Ink TUI (P-032): HERMES_NODE makes node
    // resolution deterministic for the /chat PTY launcher; HERMES_TUI_DIR
    // points it at the prebuilt bundle so it never needs a ui-tui/ checkout.
    if let Some(node) = crate::process::runtime::current_node_binary() {
        cmd.env("HERMES_NODE", &node);
    } else {
        log::warn!("Bundled node is missing from the managed runtime; /chat will be unavailable");
    }
    if let Some(tui_dir) = crate::process::runtime::current_tui_dir() {
        cmd.env("HERMES_TUI_DIR", &tui_dir);
    } else {
        log::warn!("Bundled TUI is missing from the managed runtime; /chat will be unavailable");
    }
    cmd.env("HERMES_GATEWAY_LOCK_DIR", &gateway_lock_dir)
        .env("HERMES_GATEWAY_RUNTIME_DIR", &gateway_runtime_dir)
        .env("HERMES_DESKTOP_MANAGED", "1")
        .env("HERMES_GATEWAY_DETACHED", "1");
    // Identity-proving readiness channel: the kernel atomically writes
    // {"port": N} here once its socket is bound (Core:
    // _write_dashboard_ready_file). The unique path doubles as the identity
    // check — no other process can know it.
    let ready_file = new_ready_file_path();
    cmd.env("HERMES_DESKTOP_READY_FILE", &ready_file);

    // YOLO mode: the backend freezes HERMES_YOLO_MODE at import time, so it can
    // only be toggled by (re)launching the runtime. Drive it from the persisted
    // desktop preference (per HERMES_HOME) and make that decision authoritative
    // (an inherited HERMES_YOLO_MODE only seeds the default before the user has
    // ever set the preference). When the result is off, explicitly clear any
    // inherited HERMES_YOLO_MODE so the runtime never silently bypasses approval
    // prompts (see #287).
    if yolo_mode_effective(&options.hermes_home) {
        cmd.env("HERMES_YOLO_MODE", "1");
        log::warn!(
            "YOLO mode is ON: the managed runtime will auto-approve dangerous-command prompts"
        );
    } else {
        cmd.env_remove("HERMES_YOLO_MODE");
    }

    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // Put the dashboard in its own process group so shutdown can target
        // gateway/MCP/worker descendants without touching unrelated user
        // processes.
        cmd.process_group(0);
    }

    // Windows: hide the console window for the child process
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x00000200;
        cmd.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| AppError::DashboardStartup(e.to_string()))?;
    crate::path_resolver::mark_applied_to_runtime(&effective_path);
    let job_handle = {
        #[cfg(windows)]
        {
            match create_dashboard_job(&child) {
                Ok(job) => Some(job),
                Err(err) => {
                    log::warn!("Failed to attach dashboard to Windows Job Object: {}", err);
                    None
                }
            }
        }
        #[cfg(not(windows))]
        {
            None
        }
    };
    let api_base_url = dashboard_base_url(&options.host, options.port);
    let marker_path = ownership_marker_path_display();
    let runtime_version =
        crate::process::runtime::read_current_record().map(|record| record.runtime_version);
    let marker = DashboardOwnershipMarker {
        schema_version: OWNERSHIP_MARKER_SCHEMA_VERSION,
        run_id: format!("{}-{}", std::process::id(), now_millis()),
        desktop_pid: std::process::id(),
        dashboard_pid: child.id(),
        api_base_url,
        hermes_home: options.hermes_home.clone(),
        runtime_root: crate::process::runtime::runtime_root()
            .to_string_lossy()
            .to_string(),
        gateway_runtime_dir: gateway_runtime_dir.to_string_lossy().to_string(),
        started_at_ms: now_millis(),
        runtime_version,
    };
    if let Err(err) = write_ownership_marker(&marker) {
        log::warn!("Failed to write dashboard ownership marker: {}", err);
    }
    drain_dashboard_output(&mut child);
    Ok(SpawnedDashboard {
        child,
        session_token,
        command_program: program,
        command_args: prefix_args,
        gateway_runtime_dir: gateway_runtime_dir.to_string_lossy().to_string(),
        gateway_lock_dir: gateway_lock_dir.to_string_lossy().to_string(),
        ownership_marker_path: marker_path,
        job_handle,
        ready_file,
    })
}

async fn dashboard_is_compatible(api_base_url: &str, hermes_home: &str) -> bool {
    // `/api/ws` is upstream-native — every runtime this desktop can manage
    // serves it, so compatibility only needs the fork's upload route and a
    // matching HERMES_HOME. The legacy `/api/v2/*` transport probe was removed
    // when the desktop switched to WS-only Gateway traffic.
    probe_dashboard(api_base_url).await
        && dashboard_supports_uploads(api_base_url).await
        && dashboard_matches_hermes_home(api_base_url, hermes_home).await
}

fn drain_dashboard_output(child: &mut Child) {
    if let Some(stdout) = child.stdout.take() {
        spawn_dashboard_log_reader("stdout", stdout);
    }
    if let Some(stderr) = child.stderr.take() {
        spawn_dashboard_log_reader("stderr", stderr);
    }
}

fn spawn_dashboard_log_reader<R>(stream: &'static str, reader: R)
where
    R: Read + Send + 'static,
{
    let _ = thread::Builder::new()
        .name(format!("hermes-dashboard-{}", stream))
        .spawn(move || {
            let lines = BufReader::new(reader).lines();
            for line in lines.map_while(Result::ok) {
                if line.trim().is_empty() {
                    continue;
                }
                match stream {
                    "stderr" => log::warn!("[dashboard stderr] {}", line),
                    _ => log::info!("[dashboard stdout] {}", line),
                }
            }
        });
}

/// Outcome of waiting for a freshly spawned dashboard.
#[derive(Debug, PartialEq, Eq)]
enum WaitOutcome {
    /// The kernel is serving AND proven to be ours (ready file appeared, or
    /// the HTML-embedded session token matches the one we minted).
    Ready {
        actual_port: Option<u16>,
    },
    /// Our child died before becoming ready — the port-bind OSError path
    /// exits within moments, so this fires fast instead of a 120s stall.
    ExitedEarly(String),
    /// Something answers on the port but its session token differs from the
    /// one we minted: another process won the bind race. Our child cannot
    /// bind the same port, so give up on it immediately and move on.
    PortStolen,
    TimedOut,
}

/// What the HTTP identity probe saw this tick.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HttpProbeState {
    /// `/` served the exact token we minted for this spawn.
    OursReady,
    /// `/` served a DIFFERENT token — foreign dashboard owns the port.
    Foreign,
    /// Nothing conclusive (connection refused, page not up yet, no token).
    Silent,
}

/// Pure per-tick decision, ordered by signal strength: a dead child beats
/// everything; the ready file is identity-proving and authoritative; the
/// HTTP token comparison covers runtimes that predate the ready file; only
/// then does the timeout fire. Returns `None` to keep waiting.
fn classify_wait_tick(
    child_exit: Option<String>,
    ready_port: Option<u16>,
    http: HttpProbeState,
    timed_out: bool,
) -> Option<WaitOutcome> {
    if let Some(status) = child_exit {
        return Some(WaitOutcome::ExitedEarly(status));
    }
    if let Some(port) = ready_port {
        return Some(WaitOutcome::Ready {
            actual_port: Some(port),
        });
    }
    match http {
        HttpProbeState::OursReady => Some(WaitOutcome::Ready { actual_port: None }),
        HttpProbeState::Foreign => Some(WaitOutcome::PortStolen),
        HttpProbeState::Silent => {
            if timed_out {
                Some(WaitOutcome::TimedOut)
            } else {
                None
            }
        }
    }
}

/// HTTP identity probe: fetch the session token the dashboard embeds in its
/// loopback index page and compare byte-for-byte with the token this shell
/// minted for the spawn. 32 random bytes — equality means "our child",
/// inequality means the port was stolen. With no expected token (getrandom
/// failure — extreme edge) degrade to the legacy liveness probe.
async fn http_identity_probe(api_base_url: &str, expected_token: Option<&str>) -> HttpProbeState {
    let Some(expected) = expected_token.filter(|token| !token.is_empty()) else {
        return if probe_spawned_dashboard_ready(api_base_url).await {
            HttpProbeState::OursReady
        } else {
            HttpProbeState::Silent
        };
    };
    match fetch_session_token(api_base_url).await {
        Some(found) if found == expected => HttpProbeState::OursReady,
        Some(_) => HttpProbeState::Foreign,
        None => HttpProbeState::Silent,
    }
}

/// Wait until the spawned dashboard is ready — with identity verification —
/// or fails. Replaces the old boolean wait that treated any HTTP answer
/// (even a 401 from a foreign dashboard) as success.
async fn wait_for_spawned_dashboard(
    api_base_url: &str,
    child: &mut Child,
    ready_file: &Path,
    expected_token: Option<&str>,
) -> WaitOutcome {
    let start = Instant::now();
    loop {
        let child_exit = match child.try_wait() {
            Ok(Some(status)) => Some(status.to_string()),
            Ok(None) => None,
            Err(err) => Some(format!("try_wait failed: {err}")),
        };
        let ready_port = read_ready_file_port(ready_file);
        // Skip the HTTP round-trip when a stronger signal already decides.
        let http = if child_exit.is_none() && ready_port.is_none() {
            http_identity_probe(api_base_url, expected_token).await
        } else {
            HttpProbeState::Silent
        };
        let timed_out = start.elapsed() >= DASHBOARD_READY_TIMEOUT;
        if let Some(outcome) = classify_wait_tick(child_exit, ready_port, http, timed_out) {
            return outcome;
        }
        tokio::time::sleep(Duration::from_millis(350)).await;
    }
}

/// Ensure a hermes dashboard is running. Probes existing instances first,
/// falls back to spawning a new one. Tries up to 20 port offsets if the
/// primary port is occupied by an incompatible dashboard.
pub async fn ensure_hermes_dashboard(
    options: EnsureDashboardOptions,
) -> Result<DashboardHandle, AppError> {
    let api_base_url = dashboard_base_url(&options.host, options.port);

    // Reuse an existing dashboard only after the compatibility probe proves it
    // is serving the same isolated runtime HERMES_HOME and supports the
    // desktop-required routes. This keeps hot reload / second launch usable
    // without falling back to a user-installed ~/.hermes or PATH runtime.
    // Crashed shells can leave ready files behind; while we hold the
    // per-root single-instance lock no sibling shell can be mid-spawn, so
    // everything matching the prefix is stale.
    sweep_stale_ready_files();

    let mut primary_occupied = probe_dashboard_port(&api_base_url);
    let ownership_marker = read_ownership_marker();
    let primary_marker_state = marker_owner_state(
        ownership_marker.as_ref(),
        &api_base_url,
        &options.hermes_home,
    );
    // While this process holds the per-root single-instance lock, no OTHER
    // live shell can own this runtime root — a marker naming a live foreign
    // desktop_pid can only be OS PID reuse. Treat it as stale so the orphan
    // kernel gets adopted or cleaned instead of lingering unmanaged forever.
    // Our own pid stays Live (legitimate during in-process respawns).
    let primary_marker_state = if primary_marker_state == MarkerOwnerState::LiveDesktopOwner
        && ownership_marker
            .as_ref()
            .map(|marker| marker.desktop_pid != std::process::id())
            .unwrap_or(false)
    {
        log::warn!(
            "ownership marker claims a live desktop owner (pid {}) while this process holds the instance lock; treating it as stale — PID reuse suspected",
            ownership_marker
                .as_ref()
                .map(|marker| marker.desktop_pid)
                .unwrap_or(0)
        );
        MarkerOwnerState::StaleDesktopOwner
    } else {
        primary_marker_state
    };
    if primary_occupied && primary_marker_state == MarkerOwnerState::StaleDesktopOwner {
        if let Some(marker) = ownership_marker.as_ref() {
            let stale_dashboard_compatible =
                dashboard_is_compatible(&api_base_url, &options.hermes_home).await;
            if stale_dashboard_compatible {
                if let Some(session_token) = known_session_token_for_existing(&api_base_url).await {
                    log::warn!(
                        "Adopting compatible stale desktop-owned dashboard at {} (orphan pid {})",
                        api_base_url,
                        marker.dashboard_pid
                    );
                    let adopted_marker = match rewrite_ownership_marker_for_current_desktop(marker)
                    {
                        Ok(next) => next,
                        Err(err) => {
                            log::warn!("Failed to refresh dashboard ownership marker: {}", err);
                            marker.clone()
                        }
                    };
                    let gateway_runtime_dir = adopted_marker.gateway_runtime_dir.clone();
                    let gateway_lock_dir = PathBuf::from(&gateway_runtime_dir)
                        .join("token-locks")
                        .to_string_lossy()
                        .to_string();
                    return Ok(DashboardHandle {
                        api_base_url,
                        session_token: Some(session_token),
                        owns_process: true,
                        command_program: None,
                        command_args: vec![],
                        gateway_runtime_dir: Some(gateway_runtime_dir),
                        gateway_lock_dir: Some(gateway_lock_dir),
                        ownership_marker_path: Some(ownership_marker_path_display()),
                        ownership_state: Some("attached-stale-compatible".to_string()),
                        job_handle: None,
                        attached_pid: Some(adopted_marker.dashboard_pid),
                        child: None,
                    });
                }

                log::warn!(
                    "Found compatible stale desktop-owned dashboard at {} (orphan pid {}) but no session token is recoverable; cleaning it so the desktop can spawn a token-owned runtime",
                    api_base_url,
                    marker.dashboard_pid
                );
            } else {
                log::warn!(
                    "Found stale but incompatible desktop-owned dashboard marker for {}; cleaning orphan pid {}",
                    api_base_url,
                    marker.dashboard_pid
                );
            }

            terminate_owned_dashboard_tree(
                &marker.api_base_url,
                None,
                Some(marker.dashboard_pid),
                None,
            );
            remove_ownership_marker_path(None);
            tokio::time::sleep(Duration::from_millis(350)).await;
            primary_occupied = probe_dashboard_port(&api_base_url);
            if primary_occupied {
                let stale_kind = if stale_dashboard_compatible {
                    "stale desktop-owned dashboard"
                } else {
                    "incompatible dashboard"
                };
                return Err(AppError::DashboardStartup(format!(
                    "{} is still occupied by a {} after cleanup. Stop the remaining process on port {} and retry.",
                    api_base_url, stale_kind, options.port
                )));
            }
        }
    }

    let can_reuse_existing = true;
    if primary_occupied
        && can_reuse_existing
        && dashboard_is_compatible(&api_base_url, &options.hermes_home).await
    {
        let session_token = match known_session_token_for_existing(&api_base_url).await {
            Some(token) => token,
            None => {
                return Err(AppError::DashboardStartup(format!(
                    "{} is occupied by a compatible dashboard, but its session token cannot be recovered. Stop the process on port {} and retry.",
                    api_base_url, options.port
                )));
            }
        };
        let ownership_state = match primary_marker_state {
            MarkerOwnerState::LiveDesktopOwner => "attached-live-desktop-owner",
            MarkerOwnerState::Missing => "attached-compatible-unmarked",
            MarkerOwnerState::NotThisDashboard => "attached-compatible-unmatched-marker",
            MarkerOwnerState::StaleDesktopOwner => "attached-stale-compatible",
        };
        log::info!(
            "Reusing compatible dashboard at {} ({})",
            api_base_url,
            ownership_state
        );
        return Ok(DashboardHandle {
            api_base_url,
            session_token: Some(session_token),
            owns_process: false,
            command_program: None,
            command_args: vec![],
            gateway_runtime_dir: None,
            gateway_lock_dir: None,
            ownership_marker_path: Some(ownership_marker_path_display()),
            ownership_state: Some(ownership_state.to_string()),
            job_handle: None,
            attached_pid: None,
            child: None,
        });
    }

    // Try port fallbacks if the primary port has an incompatible dashboard
    let mut spawn_options = EnsureDashboardOptions {
        host: options.host.clone(),
        port: options.port,
        hermes_home: options.hermes_home.clone(),
        allow_external_agent: options.allow_external_agent,
        allow_port_fallback: options.allow_port_fallback,
    };

    if primary_occupied {
        if !options.allow_port_fallback {
            return Err(AppError::DashboardStartup(format!(
                "{} is already occupied by another dashboard. Stop the process on port {} so the desktop can spawn its managed runtime dashboard.",
                api_base_url, options.port
            )));
        }
        log::warn!(
            "Dashboard at {} is not compatible; trying alternate ports",
            api_base_url
        );
        let mut found = false;
        for candidate_port in fallback_ports(options.port) {
            let candidate_url = dashboard_base_url(&options.host, candidate_port);
            if probe_dashboard_port(&candidate_url) {
                if options.allow_external_agent
                    && dashboard_is_compatible(&candidate_url, &options.hermes_home).await
                {
                    let session_token = known_session_token_for_existing(&candidate_url).await;
                    return Ok(DashboardHandle {
                        api_base_url: candidate_url,
                        session_token,
                        owns_process: false,
                        command_program: None,
                        command_args: vec![],
                        gateway_runtime_dir: None,
                        gateway_lock_dir: None,
                        ownership_marker_path: Some(ownership_marker_path_display()),
                        ownership_state: Some("attached-compatible-fallback".to_string()),
                        job_handle: None,
                        attached_pid: None,
                        child: None,
                    });
                }
                continue;
            }
            spawn_options.port = candidate_port;
            found = true;
            break;
        }
        if !found {
            return Err(AppError::DashboardStartup(format!(
                "No available port from {} to {}",
                options.port,
                options.port.saturating_add(DASHBOARD_PORT_FALLBACK_LIMIT)
            )));
        }
    }

    // Spawn a new dashboard, retrying on a lost bind race. The pre-scan
    // above picked a free port, but between that probe and the child's
    // bind() another process can win the port (TOCTOU): our child then
    // exits with a bind error (ExitedEarly), or a foreign dashboard answers
    // on our port (PortStolen). Either way pick the next free port and
    // respawn — bounded by SPAWN_ATTEMPT_LIMIT.
    let mut tried_ports: Vec<u16> = Vec::new();
    let mut last_failure = String::from("no spawn attempted");
    for attempt in 1..=SPAWN_ATTEMPT_LIMIT {
        if attempt > 1 {
            // Re-scan for the next candidate, skipping burned ports and
            // anything that became occupied since the previous scan.
            let next = std::iter::once(options.port)
                .chain(fallback_ports(options.port))
                .find(|port| {
                    !tried_ports.contains(port)
                        && !probe_dashboard_port(&dashboard_base_url(&options.host, *port))
                });
            match next {
                Some(port) => spawn_options.port = port,
                None => break,
            }
        }
        tried_ports.push(spawn_options.port);

        let SpawnedDashboard {
            mut child,
            session_token,
            command_program,
            command_args,
            gateway_runtime_dir,
            gateway_lock_dir,
            ownership_marker_path,
            job_handle,
            ready_file,
        } = spawn_dashboard(&spawn_options)?;
        let child_url = dashboard_base_url(&spawn_options.host, spawn_options.port);

        let outcome = wait_for_spawned_dashboard(
            &child_url,
            &mut child,
            &ready_file,
            session_token.as_deref(),
        )
        .await;

        let failure_reason = match outcome {
            WaitOutcome::Ready { actual_port } => {
                remove_ready_file(&ready_file);
                // Trust the kernel-reported bound port when present (today it
                // always equals the requested one; forward-compatible with
                // `--port 0`).
                let final_url = actual_port
                    .filter(|port| *port != spawn_options.port)
                    .map(|port| dashboard_base_url(&spawn_options.host, port))
                    .unwrap_or(child_url);
                log::info!("Dashboard started at {}", final_url);
                return Ok(DashboardHandle {
                    api_base_url: final_url,
                    session_token,
                    owns_process: true,
                    command_program: Some(command_program),
                    command_args,
                    gateway_runtime_dir: Some(gateway_runtime_dir),
                    gateway_lock_dir: Some(gateway_lock_dir),
                    ownership_marker_path: Some(ownership_marker_path),
                    ownership_state: Some("owned".to_string()),
                    job_handle,
                    attached_pid: None,
                    child: Some(child),
                });
            }
            WaitOutcome::TimedOut => {
                terminate_owned_dashboard_tree(&child_url, Some(&mut child), None, None);
                remove_ownership_marker_path(Some(&ownership_marker_path));
                remove_ready_file(&ready_file);
                // A kernel that is alive but not serving after 120s is not a
                // bind race — retrying elsewhere would just take another 120s.
                return Err(AppError::DashboardStartup(format!(
                    "Not ready at {} within {}s",
                    child_url,
                    DASHBOARD_READY_TIMEOUT.as_secs()
                )));
            }
            WaitOutcome::ExitedEarly(status) => {
                format!("dashboard exited before ready ({status})")
            }
            WaitOutcome::PortStolen => {
                "port answered with a foreign session token (bind race lost)".to_string()
            }
        };

        terminate_owned_dashboard_tree(&child_url, Some(&mut child), None, None);
        remove_ownership_marker_path(Some(&ownership_marker_path));
        remove_ready_file(&ready_file);

        if !options.allow_port_fallback {
            // Dev semantics: the Vite proxy target is fixed, so surface the
            // conflict instead of drifting to another port.
            return Err(AppError::DashboardStartup(format!(
                "{} — {}. Stop the process on port {} so the desktop can spawn its managed runtime dashboard.",
                child_url, failure_reason, spawn_options.port
            )));
        }
        log::warn!(
            "Dashboard spawn on {} failed ({}); retrying on another port (attempt {}/{})",
            child_url,
            failure_reason,
            attempt,
            SPAWN_ATTEMPT_LIMIT
        );
        last_failure = failure_reason;
    }

    Err(AppError::DashboardStartup(format!(
        "Failed to start the dashboard after {} attempt(s) on ports {:?} — last failure: {}",
        tried_ports.len(),
        tried_ports,
        last_failure
    )))
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;
    use serial_test::serial;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[test]
    #[serial]
    fn external_agent_escape_hatches_are_ignored() {
        std::env::set_var("HERMES_DESKTOP_ALLOW_EXTERNAL_AGENT", "1");
        std::env::set_var("HERMES_DESKTOP_DEV_EXTERNAL_DASHBOARD", "1");

        assert!(!external_agent_allowed());
        assert!(!dev_external_dashboard_enabled());

        std::env::remove_var("HERMES_DESKTOP_ALLOW_EXTERNAL_AGENT");
        std::env::remove_var("HERMES_DESKTOP_DEV_EXTERNAL_DASHBOARD");
    }

    #[test]
    #[serial]
    fn yolo_mode_effective_combines_persisted_pref_and_env() {
        use tempfile::TempDir;
        std::env::remove_var("HERMES_YOLO_MODE");
        let dir = TempDir::new().unwrap();
        let home = dir.path().to_str().unwrap();

        // Neither persisted nor env → off.
        assert!(!yolo_mode_effective(home));

        // Persisted preference toggles it.
        crate::ui_store::set_yolo_mode(home, true).unwrap();
        assert!(yolo_mode_effective(home));
        crate::ui_store::set_yolo_mode(home, false).unwrap();
        assert!(!yolo_mode_effective(home));

        // The persisted preference is authoritative: an explicit "off" wins over
        // an inherited HERMES_YOLO_MODE=1 (the #287 bug — the UI toggle must
        // actually disable the runtime).
        std::env::set_var("HERMES_YOLO_MODE", "1");
        assert!(!yolo_mode_effective(home));
        // An explicit "on" stays on regardless of env.
        crate::ui_store::set_yolo_mode(home, true).unwrap();
        assert!(yolo_mode_effective(home));

        // With no persisted preference, the env var seeds the default — the
        // documented power-user / dev escape hatch before the UI is ever used.
        // (Use a fresh home so the preference is genuinely unset.)
        let fresh = TempDir::new().unwrap();
        let fresh_home = fresh.path().to_str().unwrap();
        assert!(yolo_mode_effective(fresh_home));
        std::env::remove_var("HERMES_YOLO_MODE");
        assert!(!yolo_mode_effective(fresh_home));
    }

    #[test]
    fn dashboard_base_url_standard() {
        assert_eq!(
            dashboard_base_url("127.0.0.1", 9119),
            "http://127.0.0.1:9119"
        );
    }

    #[test]
    fn dashboard_base_url_alt_host_and_port() {
        assert_eq!(dashboard_base_url("0.0.0.0", 8080), "http://0.0.0.0:8080");
    }

    #[test]
    fn fallback_ports_stop_at_u16_max() {
        assert_eq!(fallback_ports(u16::MAX - 2), vec![u16::MAX - 1, u16::MAX]);
        assert!(fallback_ports(u16::MAX).is_empty());
    }

    #[test]
    fn desktop_default_port_avoids_global_hermes_dashboard_default() {
        assert_eq!(DEFAULT_DESKTOP_DASHBOARD_PORT, 9120);
    }

    #[test]
    fn gateway_url_without_token() {
        assert_eq!(
            build_gateway_url("http://127.0.0.1:9119", None),
            "ws://127.0.0.1:9119/api/ws"
        );
    }

    #[test]
    fn gateway_url_with_token_is_appended() {
        assert_eq!(
            build_gateway_url("http://127.0.0.1:9119", Some("abc123")),
            "ws://127.0.0.1:9119/api/ws?token=abc123"
        );
    }

    #[test]
    fn gateway_url_encodes_token_query_value() {
        assert_eq!(
            build_gateway_url("http://127.0.0.1:9119", Some("token with space&x=y")),
            "ws://127.0.0.1:9119/api/ws?token=token%20with%20space%26x%3Dy"
        );
    }

    #[test]
    fn gateway_url_promotes_https_to_wss() {
        assert_eq!(
            build_gateway_url("https://example.com:443", Some("tok")),
            "wss://example.com:443/api/ws?token=tok"
        );
    }

    #[test]
    fn gateway_url_does_not_promote_other_schemes() {
        // Only http/https are rewritten — anything else passes through.
        let out = build_gateway_url("file:///local", None);
        assert_eq!(out, "file:///local/api/ws");
    }

    fn test_marker(
        desktop_pid: u32,
        api_base_url: &str,
        hermes_home: &str,
    ) -> DashboardOwnershipMarker {
        DashboardOwnershipMarker {
            schema_version: OWNERSHIP_MARKER_SCHEMA_VERSION,
            run_id: "test-run".to_string(),
            desktop_pid,
            dashboard_pid: 0,
            api_base_url: api_base_url.to_string(),
            hermes_home: hermes_home.to_string(),
            runtime_root: "/tmp/hermes-runtime-test".to_string(),
            gateway_runtime_dir: "/tmp/hermes-runtime-test/gateway".to_string(),
            started_at_ms: 1,
            runtime_version: Some("test".to_string()),
        }
    }

    fn host_port_from_uri(uri: &str) -> (String, u16) {
        let parsed = url::Url::parse(uri).expect("mock server uri");
        (
            parsed.host_str().expect("mock host").to_string(),
            parsed.port().expect("mock port"),
        )
    }

    async fn mount_dashboard_mock(
        server: &MockServer,
        hermes_home: &str,
        include_required_routes: bool,
    ) {
        Mock::given(method("GET"))
            .and(path("/"))
            .respond_with(ResponseTemplate::new(200).set_body_string(
                r#"<script>window.__HERMES_SESSION_TOKEN__="test-session-token"</script>"#,
            ))
            .mount(server)
            .await;

        Mock::given(method("GET"))
            .and(path("/api/status"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "hermes_home": hermes_home,
            })))
            .mount(server)
            .await;

        // Compatibility now hinges on the fork's `/api/upload` route alone —
        // `/api/ws` is upstream-native and never appears in openapi.json. An
        // "incompatible" dashboard is one missing the fork route (e.g. a stock
        // upstream build adopted by accident).
        let paths = if include_required_routes {
            serde_json::json!({
                "/api/upload": {},
            })
        } else {
            serde_json::json!({
                "/api/status": {},
            })
        };
        Mock::given(method("GET"))
            .and(path("/openapi.json"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "openapi": "3.1.0",
                "paths": paths,
            })))
            .mount(server)
            .await;
    }

    #[test]
    fn marker_owner_state_detects_live_and_stale_desktop_owner() {
        let temp = tempfile::tempdir().expect("tempdir");
        let home = temp.path().join("home");
        std::fs::create_dir_all(&home).expect("home");
        let home = home.to_string_lossy().to_string();
        let api_base_url = "http://127.0.0.1:9120";

        let live = test_marker(std::process::id(), api_base_url, &home);
        assert_eq!(
            marker_owner_state(Some(&live), api_base_url, &home),
            MarkerOwnerState::LiveDesktopOwner
        );

        let stale = test_marker(0, api_base_url, &home);
        assert_eq!(
            marker_owner_state(Some(&stale), api_base_url, &home),
            MarkerOwnerState::StaleDesktopOwner
        );
    }

    #[test]
    fn marker_owner_state_rejects_unmatched_dashboard_scope() {
        let temp = tempfile::tempdir().expect("tempdir");
        let home = temp.path().join("home");
        let other_home = temp.path().join("other-home");
        std::fs::create_dir_all(&home).expect("home");
        std::fs::create_dir_all(&other_home).expect("other");
        let home = home.to_string_lossy().to_string();
        let other_home = other_home.to_string_lossy().to_string();
        let marker = test_marker(std::process::id(), "http://127.0.0.1:9120", &home);

        assert_eq!(
            marker_owner_state(Some(&marker), "http://127.0.0.1:9121", &home),
            MarkerOwnerState::NotThisDashboard
        );
        assert_eq!(
            marker_owner_state(Some(&marker), "http://127.0.0.1:9120", &other_home),
            MarkerOwnerState::NotThisDashboard
        );
    }

    #[tokio::test]
    #[serial]
    async fn stale_desktop_owned_compatible_dashboard_is_adopted_before_cleanup() {
        let runtime = tempfile::tempdir().expect("runtime root");
        std::env::set_var("HERMES_DESKTOP_RUNTIME_ROOT", runtime.path());
        let home = runtime.path().join("hermes-home");
        std::fs::create_dir_all(&home).expect("home");
        let home = home.to_string_lossy().to_string();

        let server = MockServer::start().await;
        mount_dashboard_mock(&server, &home, true).await;
        let (host, port) = host_port_from_uri(&server.uri());
        let api_base_url = dashboard_base_url(&host, port);

        let marker = DashboardOwnershipMarker {
            dashboard_pid: 0,
            gateway_runtime_dir: runtime
                .path()
                .join("gateway-runtime")
                .to_string_lossy()
                .to_string(),
            ..test_marker(0, &api_base_url, &home)
        };
        write_ownership_marker(&marker).expect("write stale marker");

        let handle = ensure_hermes_dashboard(EnsureDashboardOptions {
            host,
            port,
            hermes_home: home,
            allow_external_agent: false,
            allow_port_fallback: false,
        })
        .await
        .expect("compatible stale dashboard should be adopted");

        assert_eq!(handle.api_base_url, api_base_url);
        assert_eq!(handle.session_token.as_deref(), Some("test-session-token"));
        assert!(handle.owns_process);
        assert_eq!(handle.attached_pid, Some(0));
        assert_eq!(
            handle.ownership_state.as_deref(),
            Some("attached-stale-compatible")
        );
        let refreshed = read_ownership_marker().expect("refreshed marker");
        assert_eq!(refreshed.desktop_pid, std::process::id());
        assert_eq!(refreshed.api_base_url, api_base_url);

        drop(handle);
        std::env::remove_var("HERMES_DESKTOP_RUNTIME_ROOT");
    }

    #[tokio::test]
    #[serial]
    async fn stale_desktop_owned_incompatible_dashboard_is_not_reused() {
        let runtime = tempfile::tempdir().expect("runtime root");
        std::env::set_var("HERMES_DESKTOP_RUNTIME_ROOT", runtime.path());
        let home = runtime.path().join("hermes-home");
        std::fs::create_dir_all(&home).expect("home");
        let home = home.to_string_lossy().to_string();

        let server = MockServer::start().await;
        mount_dashboard_mock(&server, &home, false).await;
        let (host, port) = host_port_from_uri(&server.uri());
        let api_base_url = dashboard_base_url(&host, port);

        let marker = DashboardOwnershipMarker {
            dashboard_pid: 0,
            gateway_runtime_dir: runtime
                .path()
                .join("gateway-runtime")
                .to_string_lossy()
                .to_string(),
            ..test_marker(0, &api_base_url, &home)
        };
        write_ownership_marker(&marker).expect("write stale marker");

        let result = ensure_hermes_dashboard(EnsureDashboardOptions {
            host,
            port,
            hermes_home: home,
            allow_external_agent: false,
            allow_port_fallback: false,
        })
        .await;
        let err = match result {
            Ok(_) => panic!("incompatible stale dashboard must not be reused"),
            Err(err) => err.to_string(),
        };

        assert!(err.contains("incompatible dashboard"));
        assert!(read_ownership_marker().is_none());
        std::env::remove_var("HERMES_DESKTOP_RUNTIME_ROOT");
    }

    #[test]
    fn classify_wait_tick_child_exit_beats_everything() {
        let out = classify_wait_tick(
            Some("exit status: 1".into()),
            Some(9121),
            HttpProbeState::OursReady,
            true,
        );
        assert_eq!(out, Some(WaitOutcome::ExitedEarly("exit status: 1".into())));
    }

    #[test]
    fn classify_wait_tick_ready_file_is_authoritative() {
        let out = classify_wait_tick(None, Some(9121), HttpProbeState::Foreign, false);
        assert_eq!(
            out,
            Some(WaitOutcome::Ready {
                actual_port: Some(9121)
            })
        );
    }

    #[test]
    fn classify_wait_tick_http_token_decides_identity() {
        assert_eq!(
            classify_wait_tick(None, None, HttpProbeState::OursReady, false),
            Some(WaitOutcome::Ready { actual_port: None })
        );
        assert_eq!(
            classify_wait_tick(None, None, HttpProbeState::Foreign, false),
            Some(WaitOutcome::PortStolen)
        );
    }

    #[test]
    fn classify_wait_tick_silent_keeps_waiting_until_timeout() {
        assert_eq!(
            classify_wait_tick(None, None, HttpProbeState::Silent, false),
            None
        );
        assert_eq!(
            classify_wait_tick(None, None, HttpProbeState::Silent, true),
            Some(WaitOutcome::TimedOut)
        );
    }

    #[tokio::test]
    async fn http_identity_probe_accepts_our_token_and_rejects_foreign() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/"))
            .respond_with(
                ResponseTemplate::new(200).set_body_string(
                    r#"<script>window.__HERMES_SESSION_TOKEN__="token-A"</script>"#,
                ),
            )
            .mount(&server)
            .await;
        let url = server.uri();

        assert_eq!(
            http_identity_probe(&url, Some("token-A")).await,
            HttpProbeState::OursReady
        );
        assert_eq!(
            http_identity_probe(&url, Some("token-B")).await,
            HttpProbeState::Foreign
        );
    }

    #[tokio::test]
    async fn http_identity_probe_is_silent_when_no_token_served() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/"))
            .respond_with(ResponseTemplate::new(200).set_body_string("<html>booting</html>"))
            .mount(&server)
            .await;
        assert_eq!(
            http_identity_probe(&server.uri(), Some("token-A")).await,
            HttpProbeState::Silent
        );
    }

    #[test]
    #[serial]
    fn ready_file_roundtrip_and_sweep() {
        let runtime = tempfile::tempdir().expect("runtime root");
        std::env::set_var("HERMES_DESKTOP_RUNTIME_ROOT", runtime.path());

        let path = new_ready_file_path();
        std::fs::write(&path, r#"{"port": 9123}"#).expect("write ready file");
        assert_eq!(read_ready_file_port(&path), Some(9123));

        // Torn / invalid payloads read as "not ready", never panic.
        std::fs::write(&path, "{\"po").expect("write torn file");
        assert_eq!(read_ready_file_port(&path), None);

        std::fs::write(&path, r#"{"port": 9123}"#).expect("rewrite");
        sweep_stale_ready_files();
        assert!(!path.exists(), "sweep must remove stale ready files");

        remove_ready_file(&path); // idempotent on missing files
        std::env::remove_var("HERMES_DESKTOP_RUNTIME_ROOT");
    }

    /// A marker naming a live pid that is NOT this process must be treated
    /// as stale while the single-instance lock is held (PID reuse): the
    /// compatible orphan gets adopted instead of being attached as if a
    /// sibling desktop owned it.
    #[cfg(unix)]
    #[tokio::test]
    #[serial]
    async fn live_foreign_marker_is_collapsed_to_stale_and_adopted() {
        let runtime = tempfile::tempdir().expect("runtime root");
        std::env::set_var("HERMES_DESKTOP_RUNTIME_ROOT", runtime.path());
        let home = runtime.path().join("hermes-home");
        std::fs::create_dir_all(&home).expect("home");
        let home = home.to_string_lossy().to_string();

        let server = MockServer::start().await;
        mount_dashboard_mock(&server, &home, true).await;
        let (host, port) = host_port_from_uri(&server.uri());
        let api_base_url = dashboard_base_url(&host, port);

        // pid 1 (launchd/init) is always alive and never this process.
        let marker = test_marker(1, &api_base_url, &home);
        write_ownership_marker(&marker).expect("write live-foreign marker");

        let handle = ensure_hermes_dashboard(EnsureDashboardOptions {
            host,
            port,
            hermes_home: home,
            allow_external_agent: false,
            allow_port_fallback: false,
        })
        .await
        .expect("compatible orphan must be adopted");

        assert_eq!(
            handle.ownership_state.as_deref(),
            Some("attached-stale-compatible"),
            "live-foreign marker must collapse to stale adoption, not live attach"
        );
        std::env::remove_var("HERMES_DESKTOP_RUNTIME_ROOT");
    }
}
