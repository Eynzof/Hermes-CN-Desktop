//! Per-runtime-root single-instance guard (issue #366).
//!
//! Two desktop shells sharing one runtime root would fight over the same
//! managed kernel (each respawn/quit tears down the other's backend), so a
//! second launch against the SAME root must hand focus to the incumbent and
//! exit — WeChat-style. Distinct roots (two portable extractions, or a
//! portable copy next to an installed build) are a supported scenario and
//! must keep coexisting, which is why this is an advisory file lock scoped
//! to `runtime_root()` rather than `tauri-plugin-single-instance` (that
//! plugin keys on the app identifier and would veto legitimate portable
//! side-by-side launches).
//!
//! Lock-file semantics: the file carries no content and is never deleted.
//! Both `flock` (Unix) and `LockFileEx` (Windows, via `fs2`) release the
//! lock when the owning process dies, so a leftover file from a crashed
//! shell can never deadlock the next launch; writing into a locked region
//! is also a known Windows footgun we avoid entirely. Diagnostics about the
//! owner live in `desktop-owner.json`, not here.

use std::fs::{self, OpenOptions};
use std::path::PathBuf;
use std::time::Duration;

use fs2::FileExt;

use crate::process::runtime;

const INSTANCE_LOCK_FILENAME: &str = "desktop-instance.lock";
const FOCUS_REQUEST_FILENAME: &str = "focus-request.json";
/// Poll cadence for the focus watcher. A 1s stat of one small file is
/// negligible, and polling (unlike `notify` watches) behaves identically on
/// network volumes and every Windows filesystem.
const FOCUS_WATCH_INTERVAL: Duration = Duration::from_secs(1);
/// Escape hatch for QA / development multi-open against one root.
const SINGLE_INSTANCE_ENV: &str = "HERMES_DESKTOP_SINGLE_INSTANCE";

/// Holding this guard means holding the exclusive instance lock; keep it
/// alive for the whole process (a `main()` local outliving `app.run()`).
pub struct InstanceGuard {
    _file: std::fs::File,
}

pub enum SingleInstance {
    /// We own the runtime root; proceed with startup.
    Acquired(InstanceGuard),
    /// A live shell already owns this runtime root.
    AlreadyRunning,
    /// The lock could not be evaluated (exotic filesystem, permissions…).
    /// Callers must FAIL OPEN — never let the guard itself block startup.
    Unavailable(String),
}

fn instance_lock_path() -> PathBuf {
    runtime::runtime_root().join(INSTANCE_LOCK_FILENAME)
}

fn focus_request_path() -> PathBuf {
    runtime::runtime_root().join(FOCUS_REQUEST_FILENAME)
}

fn single_instance_disabled() -> bool {
    std::env::var(SINGLE_INSTANCE_ENV)
        .map(|v| {
            let v = v.trim();
            v == "0" || v.eq_ignore_ascii_case("false") || v.eq_ignore_ascii_case("off")
        })
        .unwrap_or(false)
}

/// Try to become the single desktop instance for the current runtime root.
pub fn try_acquire() -> SingleInstance {
    if single_instance_disabled() {
        log::warn!(
            "{SINGLE_INSTANCE_ENV} disables the single-instance guard; \
             concurrent shells on one runtime root are unsupported"
        );
        return SingleInstance::Unavailable(format!("disabled via {SINGLE_INSTANCE_ENV}"));
    }

    let lock_path = instance_lock_path();
    if let Some(parent) = lock_path.parent() {
        if let Err(err) = fs::create_dir_all(parent) {
            return SingleInstance::Unavailable(format!(
                "create runtime root {}: {err}",
                parent.display()
            ));
        }
    }

    let file = match OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&lock_path)
    {
        Ok(file) => file,
        Err(err) => {
            return SingleInstance::Unavailable(format!("open {}: {err}", lock_path.display()));
        }
    };

    match file.try_lock_exclusive() {
        Ok(()) => SingleInstance::Acquired(InstanceGuard { _file: file }),
        Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => SingleInstance::AlreadyRunning,
        Err(err) => SingleInstance::Unavailable(format!("lock {}: {err}", lock_path.display())),
    }
}

/// Ask the incumbent instance to bring its main window to the foreground.
/// Atomic write (temp file + rename) so the watcher never reads a torn file.
pub fn notify_running_instance() {
    let path = focus_request_path();
    let Some(parent) = path.parent().map(PathBuf::from) else {
        return;
    };
    let payload = format!(
        "{{\"pid\":{},\"at_ms\":{}}}\n",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    );
    let write = || -> std::io::Result<()> {
        let mut tmp = tempfile::NamedTempFile::new_in(&parent)?;
        use std::io::Write;
        tmp.write_all(payload.as_bytes())?;
        tmp.persist(&path).map_err(|e| e.error)?;
        Ok(())
    };
    if let Err(err) = write() {
        log::warn!("failed to write focus request {}: {err}", path.display());
    }
}

/// Remove a leftover focus request from a previous run. Called by the lock
/// holder during startup — its window is about to show anyway, so consuming
/// a racing request here is equivalent to honoring it.
pub fn clear_stale_focus_request() {
    let path = focus_request_path();
    match fs::remove_file(&path) {
        Ok(()) => log::debug!("cleared stale focus request {}", path.display()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => log::debug!("focus request cleanup {}: {err}", path.display()),
    }
}

/// Watch for focus requests from would-be second instances and raise the
/// main window. Delete-then-show ordering: showing is idempotent, so a
/// failed show never leaves the file behind to storm the loop.
pub fn spawn_focus_watcher(app: tauri::AppHandle) {
    std::thread::Builder::new()
        .name("instance-focus-watcher".into())
        .spawn(move || loop {
            let path = focus_request_path();
            if path.exists() {
                match fs::remove_file(&path) {
                    Ok(()) => {
                        log::info!("focus requested by another launch; raising main window");
                        crate::tray::show_main_window(&app);
                    }
                    Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
                    Err(err) => {
                        log::debug!("focus request consume {}: {err}", path.display());
                    }
                }
            }
            std::thread::sleep(FOCUS_WATCH_INTERVAL);
        })
        .map(|_| ())
        .unwrap_or_else(|err| log::warn!("failed to spawn focus watcher: {err}"));
}

#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;

    fn with_runtime_root<T>(f: impl FnOnce(&std::path::Path) -> T) -> T {
        let dir = tempfile::TempDir::new().expect("tempdir");
        std::env::set_var("HERMES_DESKTOP_RUNTIME_ROOT", dir.path());
        let out = f(dir.path());
        std::env::remove_var("HERMES_DESKTOP_RUNTIME_ROOT");
        out
    }

    #[test]
    #[serial]
    fn second_acquire_returns_already_running() {
        with_runtime_root(|_root| {
            let first = try_acquire();
            let guard = match first {
                SingleInstance::Acquired(g) => g,
                _ => panic!("first acquire should succeed"),
            };
            // flock/LockFileEx exclude a second descriptor even within one
            // process, so this models a second shell faithfully.
            match try_acquire() {
                SingleInstance::AlreadyRunning => {}
                SingleInstance::Acquired(_) => panic!("second acquire must be blocked"),
                SingleInstance::Unavailable(err) => panic!("unexpected: {err}"),
            }
            drop(guard);
        });
    }

    #[test]
    #[serial]
    fn drop_guard_releases_lock() {
        with_runtime_root(|_root| {
            match try_acquire() {
                SingleInstance::Acquired(guard) => drop(guard),
                _ => panic!("first acquire should succeed"),
            }
            match try_acquire() {
                SingleInstance::Acquired(_) => {}
                _ => panic!("lock must be reacquirable after drop"),
            }
        });
    }

    #[test]
    #[serial]
    fn focus_request_roundtrip() {
        with_runtime_root(|root| {
            notify_running_instance();
            let path = root.join(FOCUS_REQUEST_FILENAME);
            let body = std::fs::read_to_string(&path).expect("focus request written");
            assert!(body.contains("\"pid\""), "payload has pid: {body}");
            clear_stale_focus_request();
            assert!(!path.exists(), "cleared focus request must be gone");
            // Clearing again is a no-op, not an error.
            clear_stale_focus_request();
        });
    }

    #[test]
    #[serial]
    fn env_escape_hatch_disables_lock() {
        with_runtime_root(|_root| {
            std::env::set_var(SINGLE_INSTANCE_ENV, "0");
            let out = try_acquire();
            std::env::remove_var(SINGLE_INSTANCE_ENV);
            match out {
                SingleInstance::Unavailable(reason) => {
                    assert!(reason.contains(SINGLE_INSTANCE_ENV), "{reason}");
                }
                _ => panic!("escape hatch must report Unavailable (fail-open)"),
            }
        });
    }
}
