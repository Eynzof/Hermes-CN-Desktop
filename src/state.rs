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
    /// The child process, if we own it.
    pub child: Option<Child>,
}

impl DashboardHandle {
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
        let fallback_pid = self.child.as_ref().map(|child| child.id());
        crate::process::dashboard::terminate_owned_dashboard_tree(
            &self.api_base_url,
            self.child.as_mut(),
            fallback_pid,
            session_token,
        );
        self.child = None;
        self.job_handle = None;
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
    pub gateway_sse_stop: Option<Arc<AtomicBool>>,
    pub switch_profile_in_flight: bool,
    pub last_runtime_error: Option<String>,
    /// Whether the *currently running* managed dashboard was launched with
    /// YOLO mode (`HERMES_YOLO_MODE=1`). This is the effective runtime state,
    /// which can briefly differ from the persisted preference between a toggle
    /// and the runtime restart that applies it.
    pub yolo_mode: bool,
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
                gateway_sse_stop: None,
                switch_profile_in_flight: false,
                last_runtime_error: None,
                yolo_mode: false,
            }),
        }
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}
