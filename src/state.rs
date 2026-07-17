// Shared application state, passed to every Tauri command via tauri::State<AppState>.
//
// Replaces the module-level mutable globals in the Electron main process
// (hermes-cn-ui-v1/apps/desktop/src/main/main.ts lines 48-52).
//
// All mutable fields live behind a Mutex. Contention is low because IPC calls
// come from a single renderer and are mostly sequential.

use std::process::Child;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::sync::Mutex;
use tokio::sync::mpsc;
use tokio::sync::Notify;

use crate::process::port_lock::PortLock;

/// Handle to the live Rust→runtime `/api/ws` relay (see commands/ws_proxy.rs).
/// Holds only std/tokio types so this module stays decoupled from the WS crate.
pub struct GatewayWsHandle {
    /// Per-connection id; relay events are tagged with it so a stale relay from
    /// a prior connection can't deliver into a freshly-opened socket's shim.
    pub connection_id: String,
    /// Outbound text frames pushed by `gateway_ws_send` → the writer task.
    pub tx: mpsc::UnboundedSender<String>,
    /// Set to stop the reader/writer tasks (checked at each loop iteration).
    pub abort: Arc<AtomicBool>,
    /// Wakes the reader/writer tasks so they observe `abort` promptly.
    pub notify: Arc<Notify>,
}

/// Windows Job Object handle used to bind the dashboard process tree to the
/// desktop lifecycle. On non-Windows this is a zero-sized placeholder so the
/// DashboardHandle shape stays uniform across platforms.
pub struct DashboardJobHandle {
    #[cfg(windows)]
    raw: windows_sys::Win32::Foundation::HANDLE,
}

impl DashboardJobHandle {
    /// Take ownership of a valid Windows Job Object handle.
    ///
    /// # Safety
    ///
    /// `raw` must be a live Job Object handle owned by the caller, and it must
    /// not be closed elsewhere after this wrapper is constructed.
    #[cfg(windows)]
    pub unsafe fn from_raw(raw: windows_sys::Win32::Foundation::HANDLE) -> Self {
        Self { raw }
    }
}

#[cfg(windows)]
unsafe impl Send for DashboardJobHandle {}

impl Drop for DashboardJobHandle {
    fn drop(&mut self) {
        #[cfg(windows)]
        unsafe {
            if !self.raw.is_null() {
                let _ = windows_sys::Win32::Foundation::CloseHandle(self.raw);
                self.raw = std::ptr::null_mut();
            }
        }
    }
}

/// Handle to a running hermes dashboard subprocess.
pub struct DashboardHandle {
    /// Base URL of the dashboard API (e.g. "http://127.0.0.1:9120").
    pub api_base_url: String,
    /// Session token known by this desktop process for the dashboard.
    pub session_token: Option<String>,
    /// Whether we spawned this process (true) or attached to an existing one (false).
    pub owns_process: bool,
    /// Program used to spawn the dashboard when `owns_process` is true.
    pub command_program: Option<String>,
    /// Arguments passed to `command_program`.
    pub command_args: Vec<String>,
    /// Runtime-scoped gateway directory injected into the dashboard environment.
    pub gateway_runtime_dir: Option<String>,
    /// Runtime-scoped lock directory injected into the dashboard environment.
    pub gateway_lock_dir: Option<String>,
    /// Path to the desktop ownership marker, when the dashboard is managed or attached.
    pub ownership_marker_path: Option<String>,
    /// Diagnostic ownership state: owned, attached, orphan-cleaned, etc.
    pub ownership_state: Option<String>,
    /// Windows Job Object keeping the owned runtime process tree tied to this handle.
    pub job_handle: Option<DashboardJobHandle>,
    /// PID for an already-running desktop-owned dashboard that this process
    /// adopted from a stale ownership marker. `child` is unavailable in that
    /// case, but the PID still lets normal desktop shutdown clean the orphan.
    pub attached_pid: Option<u32>,
    /// The child process, if we own it.
    pub child: Option<Child>,
    /// Port locks held by this desktop instance for the dashboard API port and
    /// its associated satellite ports. Released when the handle is dropped.
    pub port_locks: Option<Vec<PortLock>>,
}

impl DashboardHandle {
    /// Build a handle describing a remote Hermes Agent the desktop merely
    /// attaches to. `owns_process` is false, so app shutdown and restart paths
    /// never try to terminate or `/api/shutdown` the remote agent.
    pub fn remote(api_base_url: String, session_token: String) -> Self {
        Self::attached(api_base_url, Some(session_token), "remote")
    }

    /// Build a handle for a gated remote Hermes Agent authenticated by an
    /// OAuth/cookie session (managed by `oauth_session`, not a token here).
    pub fn remote_oauth(api_base_url: String) -> Self {
        Self::attached(api_base_url, None, "remote-oauth")
    }

    /// Build a handle for a loopback Hermes Agent CLI dashboard that the
    /// desktop attaches to but does not own.
    pub fn local(api_base_url: String, session_token: Option<String>) -> Self {
        Self::attached(api_base_url, session_token, "local")
    }

    fn attached(
        api_base_url: String,
        session_token: Option<String>,
        ownership_state: &str,
    ) -> Self {
        Self {
            api_base_url,
            session_token,
            owns_process: false,
            command_program: None,
            command_args: vec![],
            gateway_runtime_dir: None,
            gateway_lock_dir: None,
            ownership_marker_path: None,
            ownership_state: Some(ownership_state.to_string()),
            job_handle: None,
            attached_pid: None,
            child: None,
            port_locks: None,
        }
    }

    /// Stop the dashboard process tree if we own it.
    pub fn stop(&mut self) -> bool {
        self.stop_with_token(None)
    }

    /// Stop the dashboard process tree if we own it, first trying the
    /// dashboard's protected shutdown endpoint when a session token is known.
    pub fn stop_with_token(&mut self, session_token: Option<&str>) -> bool {
        if !self.owns_process {
            self.child = None;
            return true;
        }
        let fallback_pid = self
            .child
            .as_ref()
            .map(|child| child.id())
            .or(self.attached_pid);
        let stopped = crate::process::dashboard::terminate_owned_dashboard_tree(
            &self.api_base_url,
            self.child.as_mut(),
            fallback_pid,
            session_token,
        );
        if !stopped {
            self.ownership_state = Some("stop-failed".to_string());
            return false;
        }
        self.child = None;
        self.job_handle = None;
        self.attached_pid = None;
        self.owns_process = false;
        crate::process::dashboard::remove_ownership_marker_path(
            self.ownership_marker_path.as_deref(),
        );
        // Explicitly release port locks so another Hermes instance can claim
        // the ports immediately instead of waiting for the handle to drop.
        if let Some(locks) = self.port_locks.take() {
            for lock in locks {
                lock.release();
            }
        }
        self.ownership_state = Some("stopped".to_string());
        true
    }
}

impl Drop for DashboardHandle {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

/// Interior mutable state shared across all Tauri commands.
pub struct AppStateInner {
    pub api_base_url: String,
    pub gateway_url: String,
    pub hermes_home: String,
    /// The root hermes-home (before profile sub-directory resolution).
    pub hermes_home_base: String,
    pub session_token: Option<String>,
    pub current_profile: String,
    pub dashboard_handle: Option<DashboardHandle>,
    /// The live Rust→runtime `/api/ws` relay connection, when the webview is
    /// on the relay socket path. `None` on webview-direct WS or before the
    /// first relay connect.
    pub gateway_ws: Option<GatewayWsHandle>,
    /// Set while a managed-dashboard restart is in progress (profile switch or
    /// YOLO toggle). Guards against two restarts racing on `dashboard_handle`.
    pub dashboard_restart_in_flight: bool,
    pub last_runtime_error: Option<String>,
    /// Whether the *currently running* managed dashboard was launched with
    /// YOLO mode (`HERMES_YOLO_MODE=1`). This is the effective runtime state,
    /// which can briefly differ from the persisted preference between a toggle
    /// and the runtime restart that applies it.
    pub yolo_mode: bool,
    /// Whether the desktop is running its own managed runtime, attached to a
    /// loopback CLI dashboard, or attached to a remote Hermes Agent. Set
    /// during bootstrap and by `apply_connection_config`; commands consult it
    /// to decide ownership-only behavior (profile switch, YOLO, runtime
    /// updates) and token refresh strategy.
    pub connection_mode: crate::connection::ConnectionMode,
    /// Live OAuth/cookie session for a gated remote gateway, when
    /// `connection_mode == Remote` and the backend authenticates via OAuth.
    /// `None` for token/local/managed. REST and WS both consult this to pick
    /// the cookie-aware client and mint WS tickets.
    pub oauth_session: Option<std::sync::Arc<crate::oauth_session::OauthSession>>,
    /// Debounce marker for `connection-auth-expired` emits (a burst of 401s
    /// must not storm the UI with re-login banners).
    pub last_auth_expired_emit: Option<std::time::Instant>,
}

/// A snapshot of how the currently-connected dashboard authenticates, taken
/// once inside the state lock so each command can drop the guard before doing
/// async I/O. Token variant carries the shared session token (loopback/local/
/// remote-token); Oauth variant carries the shared cookie session.
#[derive(Clone)]
pub enum DashboardAuth {
    Token(Option<String>),
    Oauth(std::sync::Arc<crate::oauth_session::OauthSession>),
}

impl AppStateInner {
    /// Snapshot the current auth strategy for use outside the lock.
    pub fn dashboard_auth(&self) -> DashboardAuth {
        match &self.oauth_session {
            Some(session) => DashboardAuth::Oauth(session.clone()),
            None => DashboardAuth::Token(self.session_token.clone()),
        }
    }
}

/// Thread-safe wrapper. Tauri manages this via `app.manage(AppState::new())`.
pub struct AppState {
    pub inner: Mutex<AppStateInner>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(AppStateInner {
                api_base_url: String::new(),
                gateway_url: String::new(),
                hermes_home: String::new(),
                hermes_home_base: String::new(),
                session_token: None,
                current_profile: "default".to_string(),
                dashboard_handle: None,
                gateway_ws: None,
                dashboard_restart_in_flight: false,
                last_runtime_error: None,
                yolo_mode: false,
                connection_mode: crate::connection::ConnectionMode::Managed,
                oauth_session: None,
                last_auth_expired_emit: None,
            }),
        }
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}
