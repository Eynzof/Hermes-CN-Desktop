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
}

impl DashboardHandle {
    /// Build a handle describing a remote Hermes Agent the desktop merely
    /// attaches to. `owns_process` is false, so app shutdown and restart paths
    /// never try to terminate or `/api/shutdown` the remote agent.
    pub fn remote(api_base_url: String, session_token: String) -> Self {
        Self {
            api_base_url,
            session_token: Some(session_token),
            owns_process: false,
            command_program: None,
            command_args: vec![],
            gateway_runtime_dir: None,
            gateway_lock_dir: None,
            ownership_marker_path: None,
            ownership_state: Some("remote".to_string()),
            job_handle: None,
            attached_pid: None,
            child: None,
        }
    }

    /// Stop the dashboard process tree if we own it.
    pub fn stop(&mut self) {
        self.stop_with_token(None);
    }

    /// Stop the dashboard process tree if we own it, first trying the
    /// dashboard's protected shutdown endpoint when a session token is known.
    pub fn stop_with_token(&mut self, session_token: Option<&str>) {
        if !self.owns_process {
            self.child = None;
            return;
        }
        let fallback_pid = self
            .child
            .as_ref()
            .map(|child| child.id())
            .or(self.attached_pid);
        crate::process::dashboard::terminate_owned_dashboard_tree(
            &self.api_base_url,
            self.child.as_mut(),
            fallback_pid,
            session_token,
        );
        self.child = None;
        self.job_handle = None;
        self.attached_pid = None;
        self.owns_process = false;
        crate::process::dashboard::remove_ownership_marker_path(
            self.ownership_marker_path.as_deref(),
        );
        self.ownership_state = Some("stopped".to_string());
    }
}

impl Drop for DashboardHandle {
    fn drop(&mut self) {
        self.stop();
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
    /// Whether the desktop is attached to a remote Hermes Agent (shell mode)
    /// or running its own managed runtime. Set during bootstrap and by
    /// `apply_connection_config`; commands consult it to skip local-only
    /// behavior (token refresh, profile switch, YOLO, runtime updates).
    pub connection_mode: crate::connection::ConnectionMode,
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
                connection_mode: crate::connection::ConnectionMode::Local,
            }),
        }
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}
