//! Unified Rust → Python FFI call wrapper (report §10 Hard FFI binding mode).
//!
//! Every embedded-mode entry point funnels through `call_ffi` so PyErr mapping,
//! JSON serialization and GIL handling live in exactly one place:
//!
//! ```text
//! py.import("hermes_embedded.api") -> getattr("handle_rpc")
//!   -> call1((method, params_json, ctx_json))
//!   -> json.dumps(result) -> serde_json::Value
//! ```
//!
//! PyO3 v0.29 Bound API is used (`py.import`, `getattr`, `call1`, `extract`).
//! Inputs default to serde JSON strings (stable across GIL/threads, report
//! decision point 9); hot paths can upgrade to direct PyDict construction
//! later without changing the signature.
//!
//! With the `embedded-python` feature off, this module is a stub: the rest of
//! the crate compiles and embedded-mode commands fail with a clear
//! `AppError::EmbeddedPython`, keeping default builds Python-free.

use std::path::Path;

#[cfg(feature = "embedded-python")]
use std::sync::{mpsc, OnceLock};

use serde_json::Value;

#[cfg(feature = "embedded-python")]
use pyo3::types::PyAnyMethods;

use crate::error::{AppError, AppResult};

/// Handle to a started CPython interpreter. Stored in the process-global
/// `EmbeddedPython` so it is initialized exactly once. Holds no `Python`
/// token (tokens are `!Send`); the process worker attaches for every call.
#[cfg(feature = "embedded-python")]
pub struct PythonInterpreter {
    #[allow(dead_code)] // payload path kept for diagnostics/updates
    payload_root: std::path::PathBuf,
    python_version: String,
    ffi_surface_version: String,
}

#[cfg(feature = "embedded-python")]
#[derive(Clone)]
struct PythonMetadata {
    python_version: String,
    ffi_surface_version: String,
}

/// Process-wide executor for every Rust → Python call.
///
/// CPython is process-global, while Tauri/Tokio may retire and recreate
/// blocking-pool threads. Keeping initialization and all FFI entry points on
/// one long-lived OS thread avoids carrying CPython thread state across those
/// worker lifetimes and makes concurrent callers queue at the same boundary
/// the GIL would serialize anyway.
#[cfg(feature = "embedded-python")]
struct PythonWorker {
    sender: mpsc::Sender<PythonCommand>,
    payload_root: std::path::PathBuf,
    metadata: PythonMetadata,
}

#[cfg(feature = "embedded-python")]
enum PythonCommand {
    CallFfi {
        module: String,
        func: String,
        args_json: String,
        reply: mpsc::SyncSender<AppResult<Value>>,
    },
    CallHandleRpc {
        method: String,
        params_json: String,
        ctx_json: String,
        reply: mpsc::SyncSender<AppResult<Value>>,
    },
    Eval {
        expr: String,
        reply: mpsc::SyncSender<AppResult<String>>,
    },
    Ping {
        reply: mpsc::SyncSender<bool>,
    },
}

#[cfg(feature = "embedded-python")]
static PYTHON_WORKER: OnceLock<Result<PythonWorker, AppError>> = OnceLock::new();

#[cfg(feature = "embedded-python")]
impl PythonWorker {
    fn start(payload_root: &Path) -> AppResult<Self> {
        set_payload_env(payload_root);
        add_dll_directory(payload_root);

        let payload_root = payload_root.to_path_buf();
        let worker_root = payload_root.clone();
        let (sender, receiver) = mpsc::channel();
        let (startup_tx, startup_rx) = mpsc::sync_channel(1);

        std::thread::Builder::new()
            .name("hermes-embedded-python".to_string())
            .spawn(move || {
                // The thread that initializes CPython is also its only Rust
                // caller for the rest of the process lifetime.
                pyo3::Python::initialize();
                let initialized =
                    pyo3::Python::attach(|py| initialize_interpreter(py, &worker_root));
                let metadata = match initialized {
                    Ok(metadata) => metadata,
                    Err(err) => {
                        let _ = startup_tx.send(Err(err));
                        return;
                    }
                };
                if startup_tx.send(Ok(metadata.clone())).is_err() {
                    return;
                }

                while let Ok(command) = receiver.recv() {
                    run_command(command);
                }
            })
            .map_err(|err| AppError::EmbeddedPython {
                msg: format!("failed to start embedded Python worker: {err}"),
                traceback: None,
            })?;

        let metadata = startup_rx.recv().map_err(|_| AppError::EmbeddedPython {
            msg: "embedded Python worker stopped during startup".to_string(),
            traceback: None,
        })??;
        Ok(Self {
            sender,
            payload_root,
            metadata,
        })
    }

    fn call_ffi(&self, module: &str, func: &str, args_json: &str) -> AppResult<Value> {
        let (reply, result) = mpsc::sync_channel(1);
        self.send(PythonCommand::CallFfi {
            module: module.to_string(),
            func: func.to_string(),
            args_json: args_json.to_string(),
            reply,
        })?;
        recv_worker_result(result)
    }

    fn call_handle_rpc(&self, method: &str, params_json: &str, ctx_json: &str) -> AppResult<Value> {
        let (reply, result) = mpsc::sync_channel(1);
        self.send(PythonCommand::CallHandleRpc {
            method: method.to_string(),
            params_json: params_json.to_string(),
            ctx_json: ctx_json.to_string(),
            reply,
        })?;
        recv_worker_result(result)
    }

    fn eval(&self, expr: &str) -> AppResult<String> {
        let (reply, result) = mpsc::sync_channel(1);
        self.send(PythonCommand::Eval {
            expr: expr.to_string(),
            reply,
        })?;
        recv_worker_result(result)
    }

    fn ping(&self) -> bool {
        let (reply, result) = mpsc::sync_channel(1);
        self.send(PythonCommand::Ping { reply }).is_ok() && result.recv().unwrap_or(false)
    }

    fn send(&self, command: PythonCommand) -> AppResult<()> {
        self.sender
            .send(command)
            .map_err(|_| AppError::EmbeddedPython {
                msg: "embedded Python worker is no longer running".to_string(),
                traceback: None,
            })
    }
}

#[cfg(feature = "embedded-python")]
fn recv_worker_result<T>(receiver: mpsc::Receiver<AppResult<T>>) -> AppResult<T> {
    receiver.recv().map_err(|_| AppError::EmbeddedPython {
        msg: "embedded Python worker stopped before returning a result".to_string(),
        traceback: None,
    })?
}

#[cfg(feature = "embedded-python")]
fn python_worker() -> AppResult<&'static PythonWorker> {
    match PYTHON_WORKER.get() {
        Some(Ok(worker)) => Ok(worker),
        Some(Err(err)) => Err(err.clone()),
        None => Err(AppError::EmbeddedPython {
            msg: "embedded Python worker has not been initialized".to_string(),
            traceback: None,
        }),
    }
}

/// Non-feature placeholder so `EmbeddedPython.interpreter` compiles without
/// pyo3. Never constructed successfully.
#[cfg(not(feature = "embedded-python"))]
pub struct PythonInterpreter {
    #[allow(dead_code)]
    payload_root: std::path::PathBuf,
}

#[cfg(feature = "embedded-python")]
impl PythonInterpreter {
    /// Initialize CPython and import `hermes_embedded.api`.
    ///
    /// Payload discovery order (report Phase 1 / 5):
    /// - `PYTHONHOME`/`PYTHONPATH` are pointed at the payload root so
    ///   `import hermes_embedded` and Core's `hermes_cli` resolve inside it.
    /// - On Windows the payload's DLL directory is added so `python3.dll` and
    ///   `.pyd` extensions load without polluting the global PATH.
    pub fn start(payload_root: &Path) -> AppResult<Self> {
        let worker = match PYTHON_WORKER.get_or_init(|| PythonWorker::start(payload_root)) {
            Ok(worker) => worker,
            Err(err) => return Err(err.clone()),
        };
        let interp = PythonInterpreter {
            payload_root: worker.payload_root.clone(),
            python_version: worker.metadata.python_version.clone(),
            ffi_surface_version: worker.metadata.ffi_surface_version.clone(),
        };
        log::debug!(
            "PythonInterpreter started from {} ({})",
            interp.payload_root.display(),
            interp.python_version()
        );
        Ok(interp)
    }

    pub fn python_version(&self) -> String {
        self.python_version.clone()
    }

    pub fn ffi_surface_version(&self) -> &str {
        &self.ffi_surface_version
    }

    /// Best-effort interpreter shutdown hook. CPython finalization happens on
    /// process teardown; this lets the shutdown path stop agent loops before
    /// the interpreter goes away.
    pub fn shutdown(&self) {
        log::info!("PythonInterpreter::shutdown requested");
    }
}

#[cfg(feature = "embedded-python")]
fn initialize_interpreter(py: pyo3::Python<'_>, payload_root: &Path) -> AppResult<PythonMetadata> {
    let payload_root_str = payload_root.display().to_string();
    // If the payload root IS the `hermes_embedded` package dir (dev spike),
    // put its parent on sys.path so `import hermes_embedded` resolves;
    // otherwise (PyInstaller _internal) the root itself is the path entry.
    let sys_path_entry = if payload_root.join("__init__.py").is_file() {
        payload_root
            .parent()
            .map(|p| p.display().to_string())
            .unwrap_or_else(|| payload_root_str.clone())
    } else {
        payload_root_str
    };

    // Ensure the payload root is importable even when the build-time Python
    // prefix would shadow PYTHONPATH (embedding quirk).
    let sys = py.import("sys")?;
    let sys_path = sys.getattr("path")?;
    sys_path.call_method1("insert", (0, sys_path_entry))?;

    let version_info: String = sys.getattr("version")?.extract()?;
    let python_version = version_info.lines().next().unwrap_or("unknown").to_string();

    let api = py.import("hermes_embedded.api")?;
    let ffi_surface_version: String = api.getattr("ffi_surface_version")?.extract()?;
    if ffi_surface_version != crate::embedded::FFI_SURFACE_VERSION {
        return Err(AppError::EmbeddedPython {
            msg: format!(
                "FFI surface version mismatch: Python reports {ffi_surface_version}, \
                 Rust expects {}",
                crate::embedded::FFI_SURFACE_VERSION
            ),
            traceback: None,
        });
    }

    // Expose the Python → Rust event bridge so the Core-side
    // RustBridgeTransport can push gateway frames into the WebView.
    crate::embedded::bridge::install(py)?;

    Ok(PythonMetadata {
        python_version,
        ffi_surface_version,
    })
}

#[cfg(not(feature = "embedded-python"))]
impl PythonInterpreter {
    pub fn start(payload_root: &Path) -> AppResult<Self> {
        let _ = payload_root;
        Err(AppError::EmbeddedPython {
            msg: "embedded-python cargo feature is disabled; rebuild with \
                  `--features embedded-python` to enable in-process CPython"
                .to_string(),
            traceback: None,
        })
    }

    pub fn python_version(&self) -> String {
        "unavailable".to_string()
    }

    pub fn ffi_surface_version(&self) -> &str {
        ""
    }

    pub fn shutdown(&self) {}
}

#[cfg(feature = "embedded-python")]
fn set_payload_env(payload_root: &Path) {
    let home = payload_root.display().to_string();
    // PyInstaller _internal layout ships the stdlib (encodings/ dir or
    // base_library.zip) — PYTHONHOME must point there. A bare `hermes_embedded`
    // dev package does NOT ship stdlib; keep the system stdlib and only add the
    // package to PYTHONPATH so `import hermes_embedded` resolves.
    let stdlib_present = payload_root.join("encodings").is_dir()
        || payload_root.join("base_library.zip").is_file()
        || payload_root.join("python314.zip").is_file();
    if stdlib_present {
        std::env::set_var("PYTHONHOME", &home);
    } else {
        log::debug!(
            "payload {} has no embedded stdlib; using system stdlib (dev package)",
            payload_root.display()
        );
    }
    let existing = std::env::var("PYTHONPATH").unwrap_or_default();
    let sep = if cfg!(windows) { ";" } else { ":" };
    let combined = if existing.is_empty() {
        home.clone()
    } else {
        format!("{home}{sep}{existing}")
    };
    std::env::set_var("PYTHONPATH", combined);
}

/// Windows: make the payload's DLL directory discoverable for `python3.dll`
/// and compiled `.pyd` extensions without mutating the global PATH.
#[cfg(all(feature = "embedded-python", windows))]
fn add_dll_directory(payload_root: &Path) {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{GetLastError, ERROR_INVALID_PARAMETER};
    use windows_sys::Win32::System::LibraryLoader::{
        AddDllDirectory, SetDefaultDllDirectories, LOAD_LIBRARY_SEARCH_DEFAULT_DIRS,
    };
    let wide: Vec<u16> = payload_root
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    // SAFETY: `wide` is a nul-terminated path; the returned handle is a cookie
    // that lives for the process lifetime and is never dereferenced.
    unsafe {
        let _ = SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_DEFAULT_DIRS);
        let handle = AddDllDirectory(wide.as_ptr());
        if handle.is_null() {
            let err = GetLastError();
            if err != ERROR_INVALID_PARAMETER {
                log::warn!(
                    "AddDllDirectory failed for {} (last error {err})",
                    payload_root.display()
                );
            }
        } else {
            log::debug!("AddDllDirectory: {}", payload_root.display());
        }
    }
}

#[cfg(all(feature = "embedded-python", not(windows)))]
fn add_dll_directory(payload_root: &Path) {
    // POSIX payloads resolve .so/.dylib via rpath/LD_LIBRARY_PATH; nothing to
    // add for the spike. (macOS hardened-runtime exceptions are a Phase 5
    // packaging concern.)
    log::debug!(
        "add_dll_directory: {} (posix, no-op)",
        payload_root.display()
    );
}

#[cfg(feature = "embedded-python")]
fn run_command(command: PythonCommand) {
    match command {
        PythonCommand::CallFfi {
            module,
            func,
            args_json,
            reply,
        } => {
            let result =
                pyo3::Python::attach(|py| call_ffi_attached(py, &module, &func, &args_json));
            let _ = reply.send(result);
        }
        PythonCommand::CallHandleRpc {
            method,
            params_json,
            ctx_json,
            reply,
        } => {
            let result = pyo3::Python::attach(|py| {
                call_handle_rpc_attached(py, &method, &params_json, &ctx_json)
            });
            let _ = reply.send(result);
        }
        PythonCommand::Eval { expr, reply } => {
            let result = pyo3::Python::attach(|py| eval_attached(py, &expr));
            let _ = reply.send(result);
        }
        PythonCommand::Ping { reply } => {
            let alive = pyo3::Python::attach(|py| py.import("sys").is_ok());
            let _ = reply.send(alive);
        }
    }
}

#[cfg(feature = "embedded-python")]
fn call_ffi_attached(
    py: pyo3::Python<'_>,
    module: &str,
    func: &str,
    args_json: &str,
) -> AppResult<Value> {
    let module = py.import(module)?;
    let func = module.getattr(func)?;
    let result = func.call1((args_json,))?;
    json_value(py, result)
}

#[cfg(feature = "embedded-python")]
fn call_handle_rpc_attached(
    py: pyo3::Python<'_>,
    method: &str,
    params_json: &str,
    ctx_json: &str,
) -> AppResult<Value> {
    let api = py.import("hermes_embedded.api")?;
    let func = api.getattr("handle_rpc")?;
    let result = func.call1((method, params_json, ctx_json))?;
    json_value(py, result)
}

/// Call a Python function with a JSON-encoded argument tuple and normalize the
/// result to `serde_json::Value`. Works for both REST (`handle_rpc`-style) and
/// gateway (`dispatch`-style) entry points.
///
/// `args_json` is passed through as a single JSON string argument; the Python
/// side `handle_rpc(method, params_json, ctx_json)` contract expects three
/// positional args — use `call_ffi_handle_rpc` for that shape.
pub fn call_ffi(module: &str, func: &str, args_json: &str) -> AppResult<Value> {
    #[cfg(feature = "embedded-python")]
    {
        python_worker()?.call_ffi(module, func, args_json)
    }
    #[cfg(not(feature = "embedded-python"))]
    {
        let _ = (module, func, args_json);
        Err(AppError::EmbeddedPython {
            msg: "embedded-python cargo feature is disabled".to_string(),
            traceback: None,
        })
    }
}

/// The standard REST/gateway FFI shape:
/// `hermes_embedded.api.handle_rpc(method: str, params_json: str, ctx_json: str) -> Any`.
pub fn call_handle_rpc(method: &str, params_json: &str, ctx_json: &str) -> AppResult<Value> {
    #[cfg(feature = "embedded-python")]
    {
        python_worker()?.call_handle_rpc(method, params_json, ctx_json)
    }
    #[cfg(not(feature = "embedded-python"))]
    {
        let _ = (method, params_json, ctx_json);
        Err(AppError::EmbeddedPython {
            msg: "embedded-python cargo feature is disabled".to_string(),
            traceback: None,
        })
    }
}

/// Normalize a Python result to `serde_json::Value` by round-tripping through
/// `json.dumps` (contract: FFI surfaces return JSON-serializable objects).
#[cfg(feature = "embedded-python")]
fn json_value(py: pyo3::Python<'_>, obj: pyo3::Bound<'_, pyo3::PyAny>) -> AppResult<Value> {
    let json = py.import("json")?;
    let dumps = json.getattr("dumps")?;
    let text: String = dumps.call1((obj,))?.extract()?;
    serde_json::from_str(&text).map_err(|e| AppError::EmbeddedPython {
        msg: format!("FFI result is not valid JSON: {e}"),
        traceback: None,
    })
}

/// Bootstrap-only `py.eval` (report §10.3: never for business calls). Used by
/// unit tests and the Phase 0 spike to verify interpreter liveness.
#[cfg(feature = "embedded-python")]
pub fn eval_for_bootstrap(expr: &str) -> AppResult<String> {
    python_worker()?.eval(expr)
}

#[cfg(feature = "embedded-python")]
fn eval_attached(py: pyo3::Python<'_>, expr: &str) -> AppResult<String> {
    let expr_c = std::ffi::CString::new(expr).map_err(|e| AppError::EmbeddedPython {
        msg: format!("bootstrap expression contains NUL: {e}"),
        traceback: None,
    })?;
    let result = py.eval(expr_c.as_c_str(), None, None)?;
    let text: String = result.str()?.extract()?;
    Ok(text)
}

/// Fast check that a real interpreter is reachable (used by the feature-gated
/// integration test and `embedded_status` command).
#[cfg(feature = "embedded-python")]
pub fn interpreter_alive() -> bool {
    python_worker().is_ok_and(PythonWorker::ping)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(not(feature = "embedded-python"))]
    #[test]
    fn call_ffi_without_feature_reports_clear_error() {
        let err = call_ffi("hermes_embedded.api", "get_version", "[]").unwrap_err();
        match err {
            AppError::EmbeddedPython { msg, .. } => {
                assert!(msg.contains("embedded-python"), "unexpected message: {msg}")
            }
            other => panic!("expected EmbeddedPython error, got {other:?}"),
        }
    }

    #[cfg(not(feature = "embedded-python"))]
    #[test]
    fn call_handle_rpc_without_feature_reports_clear_error() {
        let err = call_handle_rpc("get_version", "{}", "{}").unwrap_err();
        assert!(matches!(err, AppError::EmbeddedPython { .. }));
    }
    #[cfg(feature = "embedded-python")]
    #[test]
    fn eval_bootstrap_runs_python() {
        // Exercise the attached helper in this isolated unit-test process;
        // the public function is covered through the real worker integration.
        pyo3::Python::initialize();
        let out = pyo3::Python::attach(|py| eval_attached(py, "str(1 + 1)")).unwrap();
        assert_eq!(out, "2");
    }
}
