//! In-process CPython embedding — the Hard FFI end-state from refactor_report.md.
//!
//! The desktop no longer spawns a `hermes` subprocess and talks to it over
//! loopback HTTP/WebSocket. Instead the Python runtime is embedded into the
//! Tauri process and Rust calls Core functions directly through the CPython C
//! ABI (pyo3). Transport between Rust and Python is therefore **zero HTTP**:
//! no 9120/8644/8645 listeners, no reqwest proxy pass, no tokio-tungstenite
//! relay. REST routes are mapped to FFI entry points (`ffi.rs`), Gateway
//! JSON-RPC frames flow through an in-memory Rust-backed Transport
//! (`transport.rs`), and Python → Rust events ride a structured channel
//! (`events.rs`).
//!
//! Feature model
//! -------------
//! The full pyo3 backend lives behind the `embedded-python` cargo feature
//! (off by default — linking libpython requires a real CPython install, which
//! CI runners without Python dev headers should not be forced to do). The
//! embedded *architecture* (payload resolution, FFI registry, coverage gate,
//! event bus, gateway transport, REST routing, mode flags) always compiles and
//! is unit-tested with a stub backend, so default builds and `cargo test` stay
//! green everywhere.
//!
//! Runtime modes
//! -------------
//! - Embedded (this module): managed runtime rendered inside the desktop
//!   process; `api_base_url` is the placeholder `embedded://local`.
//! - Subprocess managed / local / remote: unchanged HTTP/WS paths (remote and
//!   attach-to-external modes cannot embed an external process).
//!   `HERMES_DESKTOP_EMBEDDED_PYTHON=0` disables the embedded path and falls
//!   back to the subprocess runtime (double-track, report §8 success criteria 6).

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde::Serialize;

use crate::error::{AppError, AppResult};

pub mod api;
pub mod call;
pub mod events;
pub mod ffi;
pub mod rpc;
pub mod transport;

/// Version of the Rust ↔ Python FFI surface. Must match
/// `hermes_embedded.api.ffi_surface_version` in the Core-side package. The
/// desktop checks it at startup alongside `EXPECTED_BACKEND_VERSION` so Rust
/// bridge and Python function signatures cannot silently drift
/// (report §3.7 / §8 success criteria 11).
pub const FFI_SURFACE_VERSION: &str = "0.1.0";

/// Env var that disables the embedded runtime entirely (subprocess fallback).
pub const EMBEDDED_DISABLE_ENV: &str = "HERMES_DESKTOP_EMBEDDED_PYTHON";

/// Placeholder API base URL reported by `get_runtime_config` in embedded mode.
/// No socket is ever bound; the value exists so the frontend contract
/// (`apiBaseUrl` non-empty, `embedded: true`) stays compatible with remote.
pub const EMBEDDED_API_BASE_URL: &str = "embedded://local";

/// Placeholder gateway URL reported in embedded mode (frontend forces relay,
/// which then talks to the in-memory transport — never to a ws:// socket).
pub const EMBEDDED_GATEWAY_URL: &str = "embedded://gateway";

/// Should the embedded runtime be attempted at all? Respects the explicit
/// opt-out env var (defaults to enabled when a payload can be located).
pub fn embedded_enabled() -> bool {
    std::env::var(EMBEDDED_DISABLE_ENV)
        .map(|v| v != "0" && !v.eq_ignore_ascii_case("false"))
        .unwrap_or(true)
}

/// Locate the embedded Python payload root.
///
/// Priority:
/// 1. `HERMES_DESKTOP_EMBEDDED_PAYLOAD` — explicit override (dev spike).
/// 2. `resource_dir/static/embedded-python` — staged Tauri resource.
/// 3. `resource_dir/static/bundled-runtime/<platform>-<arch>/_internal` —
///    the PyInstaller payload already staged by stage-bundled-runtime.mjs.
/// 4. A `hermes_embedded` package directory next to the desktop source tree
///    (dev-only convenience so `pnpm tauri:dev` can embed the Core package
///    without a full PyInstaller payload).
///
/// Returns `None` when no payload exists — the caller then falls back to the
/// subprocess managed runtime.
pub fn resolve_payload_root(resource_dir: Option<&Path>) -> Option<PathBuf> {
    if let Ok(override_path) = std::env::var("HERMES_DESKTOP_EMBEDDED_PAYLOAD") {
        let p = PathBuf::from(override_path);
        if looks_like_payload_root(&p) {
            return Some(normalize_payload_root(p));
        }
    }
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(res) = resource_dir {
        candidates.push(res.join("static").join("embedded-python"));
        candidates.push(res.join("static").join("bundled-runtime"));
    }
    // Dev-only: the reference Python package in the desktop repo (or a
    // hermes-core mklink pointing at Hermes-CN-Core).
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("hermes_embedded"));
        candidates.push(cwd.join("hermes-core").join("hermes_embedded"));
        if let Some(parent) = cwd.parent() {
            candidates.push(parent.join("Hermes-CN-Core").join("hermes_embedded"));
        }
    }
    for candidate in candidates {
        if candidate.is_dir() && looks_like_payload_root(&candidate) {
            return Some(normalize_payload_root(candidate));
        }
        // PyInstaller onefile extraction layout: <root>/<something>/_internal.
        if candidate.is_dir() {
            if let Ok(entries) = std::fs::read_dir(&candidate) {
                for entry in entries.flatten() {
                    let internal = entry.path().join("_internal");
                    if internal.is_dir() && looks_like_payload_root(&internal) {
                        return Some(internal);
                    }
                }
            }
        }
    }
    None
}

/// If the located path IS the `hermes_embedded` package directory (dev spike
/// layout), return its parent so `import hermes_embedded` resolves and the
/// rest of the codebase can consistently use `root.join("hermes_embedded")`.
fn normalize_payload_root(path: PathBuf) -> PathBuf {
    if path.join("__init__.py").is_file() && path.join("api.py").is_file() {
        path.parent().map(|p| p.to_path_buf()).unwrap_or(path)
    } else {
        path
    }
}

/// Heuristic: a payload root must contain the embedded API package or a
/// PyInstaller-style Python runtime (`python3.dll` on Windows, `libpython` on
/// POSIX, or `python3*.zip` stdlib archive). Also accepts the `hermes_embedded`
/// package directory itself (dev spike layout).
fn looks_like_payload_root(path: &Path) -> bool {
    if path.join("hermes_embedded").join("__init__.py").is_file() {
        return true;
    }
    if path.join("hermes_embedded").join("api.py").is_file() {
        return true;
    }
    if path.join("__init__.py").is_file() && path.join("api.py").is_file() {
        return true;
    }
    #[cfg(windows)]
    if path.join("python3.dll").is_file() || path.join("python314.dll").is_file() {
        return true;
    }
    #[cfg(not(windows))]
    if path.join("libpython3.14.so").is_file()
        || path.join("libpython3.14.dylib").is_file()
        || path.join("python3.14").is_dir()
    {
        return true;
    }
    // PyInstaller onefile `_internal` often holds a `base_library.zip` /
    // `python314.dll` at the top level.
    if path.join("base_library.zip").is_file() {
        return true;
    }
    false
}

/// Lifecycle state of the embedded interpreter.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "state")]
pub enum EmbeddedStatus {
    /// Feature off or no payload found — subprocess runtime is used.
    Unavailable,
    /// Payload located; interpreter not started yet.
    NotStarted,
    /// `EmbeddedPython::start` is running.
    Starting,
    /// Interpreter is initialized and `hermes_embedded.api` is importable.
    Ready {
        python_version: String,
        ffi_surface_version: String,
    },
    /// Startup or runtime failure; the message is surfaced in the UI.
    Failed(String),
}

impl EmbeddedStatus {
    pub fn is_ready(&self) -> bool {
        matches!(self, EmbeddedStatus::Ready { .. })
    }
}

/// Process-global handle to the embedded interpreter. Stored behind a
/// `OnceLock` so the interpreter is initialized exactly once per process
/// (CPython cannot be cleanly initialized twice), independent of how many
/// profiles/restarts the desktop performs.
static EMBEDDED: OnceLock<EmbeddedPython> = OnceLock::new();

/// The embedded runtime handle. The real pyo3 interpreter lives behind the
/// `embedded-python` feature; without it the struct only carries the payload
/// path and a `Unavailable` status so the rest of the codebase compiles and is
/// testable everywhere.
pub struct EmbeddedPython {
    payload_root: Option<PathBuf>,
    status: EmbeddedStatus,
    #[cfg(feature = "embedded-python")]
    interpreter: Option<crate::embedded::call::PythonInterpreter>,
}

impl EmbeddedPython {
    pub fn get() -> Option<&'static EmbeddedPython> {
        EMBEDDED.get()
    }

    /// Initialize the embedded runtime if it hasn't been initialized yet.
    /// Returns `true` when the interpreter ended up Ready (or was already
    /// Ready). Fails fast (no retry inside) so the caller can fall back to the
    /// subprocess runtime.
    pub fn ensure_started(resource_dir: Option<&Path>) -> bool {
        if !embedded_enabled() {
            return false;
        }
        let Some(payload) = resolve_payload_root(resource_dir) else {
            return false;
        };
        let _ = EMBEDDED.get_or_init(|| EmbeddedPython::start(payload));
        EMBEDDED
            .get()
            .is_some_and(|e| e.status().is_ready() || e.status() == &EmbeddedStatus::NotStarted)
    }

    fn start(payload_root: PathBuf) -> EmbeddedPython {
        #[cfg(feature = "embedded-python")]
        {
            let mut this = EmbeddedPython {
                payload_root: Some(payload_root.clone()),
                status: EmbeddedStatus::Starting,
                interpreter: None,
            };
            match crate::embedded::call::PythonInterpreter::start(&payload_root) {
                Ok(interp) => {
                    let python_version = interp.python_version();
                    let ffi_version = interp.ffi_surface_version().to_string();
                    this.status = EmbeddedStatus::Ready {
                        python_version: python_version.clone(),
                        ffi_surface_version: ffi_version.clone(),
                    };
                    log::info!(
                        "Embedded Python ready: {} (ffi_surface_version {})",
                        this.status,
                        ffi_version
                    );
                    this.interpreter = Some(interp);
                }
                Err(err) => {
                    let msg = err.to_string();
                    this.status = EmbeddedStatus::Failed(msg.clone());
                    log::error!("Embedded Python failed to start: {msg}");
                }
            }
            this
        }
        #[cfg(not(feature = "embedded-python"))]
        {
            EmbeddedPython {
                payload_root: Some(payload_root),
                status: EmbeddedStatus::Unavailable,
            }
        }
    }

    pub fn payload_root(&self) -> Option<&Path> {
        self.payload_root.as_deref()
    }

    pub fn status(&self) -> &EmbeddedStatus {
        &self.status
    }
}

impl std::fmt::Display for EmbeddedStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            EmbeddedStatus::Unavailable => write!(f, "unavailable"),
            EmbeddedStatus::NotStarted => write!(f, "not-started"),
            EmbeddedStatus::Starting => write!(f, "starting"),
            EmbeddedStatus::Ready { .. } => write!(f, "ready"),
            EmbeddedStatus::Failed(msg) => write!(f, "failed: {msg}"),
        }
    }
}

/// Shut down the embedded interpreter at app exit. Best-effort: PyO3 finalizes
/// the interpreter on `Python::detach`/process teardown; this exists as the
/// explicit hook called from `main.rs` shutdown so agent loops are stopped
/// before the interpreter goes away (report Phase 5).
pub fn shutdown() {
    if let Some(runtime) = EMBEDDED.get() {
        log::info!("Embedded Python shutdown ({})", runtime.status);
        #[cfg(feature = "embedded-python")]
        if let Some(interp) = &runtime.interpreter {
            interp.shutdown();
        }
    }
}
/// Convenience guard for commands that require a Ready embedded runtime.
pub fn ready_runtime() -> AppResult<&'static EmbeddedPython> {
    let runtime = EMBEDDED.get().ok_or_else(|| AppError::EmbeddedPython {
        msg: "embedded runtime not initialized".to_string(),
        traceback: None,
    })?;
    if !runtime.status.is_ready() {
        return Err(AppError::EmbeddedPython {
            msg: format!("embedded runtime is {}", runtime.status),
            traceback: None,
        });
    }
    Ok(runtime)
}

/// Read the Core backend version directly from Python (`get_version`), used by
/// the frontend version gate (`EXPECTED_BACKEND_VERSION`) in embedded mode —
/// there is no `/api/version` HTTP endpoint to fetch (report §8 criterion 3).
pub fn get_backend_version() -> AppResult<String> {
    let _runtime = ready_runtime()?;
    let value = crate::embedded::call::call_handle_rpc("get_version", "{}", "{}")?;
    value
        .as_str()
        .map(String::from)
        .ok_or_else(|| AppError::EmbeddedPython {
            msg: "embedded get_version() did not return a string".to_string(),
            traceback: None,
        })
}
/// Synthetic session token for the embedded runtime. The frontend contract
/// (`Authorization` / `X-Hermes-Session-Token` headers) expects a non-empty
/// token even though no HTTP request is ever sent in embedded mode — the value
/// only has to be stable within a desktop session.
pub fn embedded_session_token() -> String {
    "embedded-session-token".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    #[test]
    fn embedded_enabled_defaults_to_true() {
        // Safe default: without the opt-out env the feature is on.
        let prev = std::env::var_os(EMBEDDED_DISABLE_ENV);
        std::env::remove_var(EMBEDDED_DISABLE_ENV);
        assert!(embedded_enabled());
        if let Some(v) = prev {
            std::env::set_var(EMBEDDED_DISABLE_ENV, v);
        }
    }

    #[test]
    fn embedded_enabled_respects_opt_out() {
        std::env::set_var(EMBEDDED_DISABLE_ENV, "0");
        assert!(!embedded_enabled());
        std::env::set_var(EMBEDDED_DISABLE_ENV, "false");
        assert!(!embedded_enabled());
        std::env::set_var(EMBEDDED_DISABLE_ENV, "1");
        assert!(embedded_enabled());
        std::env::remove_var(EMBEDDED_DISABLE_ENV);
    }

    #[test]
    #[serial_test::serial]
    fn payload_root_detects_hermes_embedded_package() {
        let dir = tempfile::TempDir::new().unwrap();
        let pkg = dir.path().join("hermes_embedded");
        std::fs::create_dir_all(&pkg).unwrap();
        std::fs::write(pkg.join("__init__.py"), "").unwrap();
        std::fs::write(pkg.join("api.py"), "").unwrap();
        assert!(looks_like_payload_root(&pkg));

        // resolve_payload_root honours the explicit env override.
        std::env::set_var(
            "HERMES_DESKTOP_EMBEDDED_PAYLOAD",
            dir.path().to_str().unwrap(),
        );
        assert_eq!(resolve_payload_root(None).unwrap(), dir.path());
        std::env::remove_var("HERMES_DESKTOP_EMBEDDED_PAYLOAD");
    }

    #[test]
    #[serial_test::serial]
    fn payload_root_rejects_empty_dir() {
        // An empty directory is not a payload. NOTE: `resolve_payload_root(None)`
        // is not asserted here — the repo's own `hermes_embedded` dev package in
        // the cwd makes global resolution succeed.
        let dir = tempfile::TempDir::new().unwrap();
        assert!(!looks_like_payload_root(dir.path()));
        let nested = dir.path().join("nope");
        std::fs::create_dir_all(&nested).unwrap();
        assert!(!looks_like_payload_root(&nested));
    }

    #[test]
    fn embedded_status_display() {
        assert_eq!(EmbeddedStatus::Unavailable.to_string(), "unavailable");
        assert_eq!(
            EmbeddedStatus::Ready {
                python_version: "3.14.0".into(),
                ffi_surface_version: "0.1.0".into(),
            }
            .to_string(),
            "ready"
        );
        assert!(EmbeddedStatus::Failed("boom".into())
            .to_string()
            .contains("boom"));
    }

    #[test]
    fn embedded_api_base_url_placeholder_is_stable() {
        assert_eq!(EMBEDDED_API_BASE_URL, "embedded://local");
        assert_eq!(EMBEDDED_GATEWAY_URL, "embedded://gateway");
    }

    #[test]
    fn ffi_surface_version_is_pinned() {
        assert_eq!(FFI_SURFACE_VERSION, "0.1.0");
    }
}
