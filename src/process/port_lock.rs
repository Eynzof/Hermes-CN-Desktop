//! Cross-process port coordination via advisory lock files.
//!
//! Multiple Hermes instances (CLI dashboards, desktop-managed dashboards,
//! gateways, proxies) use a lock file under
//! `$HERMES_HOME/.port-locks/<port>.lock` to reserve ports before binding.
//! The lock is advisory and released automatically when the holding process
//! exits.

use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use fs2::FileExt;

/// Tracks ports this process has already claimed. Because OS advisory locks are
/// per-process on POSIX, claiming the same port twice from the same process
/// would create two PortLock handles whose drops interfere with each other.
static LOCAL_CLAIMS: Mutex<Option<HashSet<u16>>> = Mutex::new(None);

fn local_claims_insert(port: u16) -> bool {
    let mut guard = LOCAL_CLAIMS.lock().unwrap_or_else(|e| e.into_inner());
    let set = guard.get_or_insert_with(HashSet::new);
    set.insert(port)
}

fn local_claims_remove(port: u16) {
    let mut guard = LOCAL_CLAIMS.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(set) = guard.as_mut() {
        set.remove(&port);
    }
}

/// Opaque handle representing a held port lock.
pub struct PortLock {
    port: u16,
    /// `None` for a no-op lock (same process already holds the real lock, or
    /// the lock file is unavailable). `Some(File)` for the real OS lock.
    file: Option<File>,
    path: PathBuf,
    /// Whether this handle owns the local bookkeeping entry and should clear
    /// it on release.
    owns_local_claim: bool,
}

impl PortLock {
    /// Return the port this lock guards.
    pub fn port(&self) -> u16 {
        self.port
    }

    /// Explicitly release the lock. Safe to call multiple times.
    pub fn release(self) {
        if let Some(file) = self.file.as_ref() {
            let _ = fs2::FileExt::unlock(file);
        }
        if self.owns_local_claim {
            local_claims_remove(self.port);
        }
    }
}

impl Drop for PortLock {
    fn drop(&mut self) {
        if let Some(file) = self.file.as_ref() {
            let _ = fs2::FileExt::unlock(file);
        }
        if self.owns_local_claim {
            local_claims_remove(self.port);
        }
    }
}

/// Return the lock directory for a given HERMES_HOME.
fn lock_dir(hermes_home: impl AsRef<Path>) -> PathBuf {
    hermes_home.as_ref().join(".port-locks")
}

/// Return the lock file path for a given port.
fn lock_file_path(port: u16, hermes_home: impl AsRef<Path>) -> PathBuf {
    lock_dir(hermes_home).join(format!("{}.lock", port))
}

/// Read the owner PID stored in a lock file, if any.
fn read_lock_owner(path: &Path) -> Option<u32> {
    let mut content = String::new();
    File::open(path)
        .ok()?
        .read_to_string(&mut content)
        .ok()?;
    content.lines().next()?.trim().parse().ok()
}

/// Write the current owner PID into the lock file.
fn write_lock_owner(path: &Path, pid: u32) {
    let _ = fs::write(path, format!("{}\n", pid));
}

/// Best-effort PID liveness check.
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
    use std::os::raw::c_void;

    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    const PROCESS_QUERY_INFORMATION: u32 = 0x0400;
    const STILL_ACTIVE: u32 = 259;

    // Use raw extern because windows-sys re-exports vary by feature set.
    extern "system" {
        fn OpenProcess(dwDesiredAccess: u32, bInheritHandle: i32, dwProcessId: u32) -> *mut c_void;
        fn GetExitCodeProcess(hProcess: *mut c_void, lpExitCode: *mut u32) -> i32;
        fn CloseHandle(hObject: *mut c_void) -> i32;
    }

    unsafe {
        let mut handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            handle = OpenProcess(PROCESS_QUERY_INFORMATION, 0, pid);
        }
        if handle.is_null() {
            return false;
        }
        let mut exit_code: u32 = 0;
        let result = GetExitCodeProcess(handle, &mut exit_code);
        CloseHandle(handle);
        if result != 0 {
            exit_code == STILL_ACTIVE
        } else {
            // Could not read exit code; be conservative.
            true
        }
    }
}

#[cfg(not(any(unix, windows)))]
fn pid_is_running(_pid: u32) -> bool {
    false
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

/// Try to claim a port via lock file.
///
/// Returns `Some(PortLock)` on success. The lock is released when the handle
/// is dropped or `release()` is called. Returns `None` when the port is already
/// locked by another live process.
///
/// If the lock file cannot be created (read-only filesystem, permission
/// denied), returns a no-op `PortLock` so Hermes can still start.
pub fn try_claim_port(port: u16, hermes_home: impl AsRef<Path>) -> Option<PortLock> {
    let path = lock_file_path(port, &hermes_home);

    // Same-process deduplication: return a no-op handle if we already hold
    // this port. This prevents double-locking during respawn and makes the
    // Rust behavior match the Python implementation.
    let already_claimed_locally = !local_claims_insert(port);
    if already_claimed_locally {
        return Some(PortLock {
            port,
            file: None,
            path,
            owns_local_claim: false,
        });
    }

    if let Some(parent) = path.parent() {
        if let Err(err) = fs::create_dir_all(parent) {
            log::debug!(
                "Cannot create port lock directory {}: {}; falling back to no-lock",
                parent.display(),
                err
            );
            return Some(PortLock {
                port,
                file: None,
                path,
                owns_local_claim: true,
            });
        }
    }

    let file = match OpenOptions::new().create(true).read(true).write(true).open(&path)
    {
        Ok(f) => f,
        Err(err) => {
            log::debug!(
                "Cannot open port lock file {}: {}; falling back to no-lock",
                path.display(),
                err
            );
            return Some(PortLock {
                port,
                file: None,
                path,
                owns_local_claim: true,
            });
        }
    };

    if file.try_lock_exclusive().is_ok() {
        write_lock_owner(&path, std::process::id());
        return Some(PortLock {
            port,
            file: Some(file),
            path,
            owns_local_claim: true,
        });
    }

    // Lock is held. Check whether the owner is still alive.
    if let Some(owner) = read_lock_owner(&path) {
        if !pid_is_running(owner) {
            // Break stale lock. Close our failed handle first to avoid holding
            // a conflicting view, then reopen and claim.
            drop(file);
            // Small, deterministic backoff to reduce thundering herd when many
            // instances race to break a stale lock.
            std::thread::sleep(std::time::Duration::from_millis(10));
            let fresh = OpenOptions::new()
                .create(true)
                .read(true)
                .write(true)
                .open(&path)
                .ok()?;
            if fresh.try_lock_exclusive().is_ok() {
                write_lock_owner(&path, std::process::id());
                return Some(PortLock {
                    port,
                    file: Some(fresh),
                    path,
                    owns_local_claim: true,
                });
            }
        }
    }

    // Lock failed and the owner appears alive. Undo the local claim so a
    // future attempt in this process can try again.
    local_claims_remove(port);
    None
}

/// Atomically claim a set of ports, or none at all.
///
/// On failure, any locks already acquired are released and `None` is returned.
pub fn claim_port_set(
    ports: &[u16],
    hermes_home: impl AsRef<Path>,
) -> Option<Vec<PortLock>> {
    let mut locks = Vec::with_capacity(ports.len());
    for port in ports {
        match try_claim_port(*port, hermes_home.as_ref()) {
            Some(lock) => locks.push(lock),
            None => {
                for lock in locks {
                    lock.release();
                }
                return None;
            }
        }
    }
    Some(locks)
}

/// Release any orphaned port locks whose owner PID is dead.
///
/// This is used when adopting a stale dashboard marker: the marker records the
/// ports it claimed, and a new desktop instance can break locks left behind by
/// a crashed process.
pub fn release_orphaned_port_locks(ports: &[u16], hermes_home: impl AsRef<Path>) {
    for port in ports {
        let path = lock_file_path(*port, hermes_home.as_ref());
        if let Some(owner) = read_lock_owner(&path) {
            if !pid_is_running(owner) {
                if let Ok(file) = OpenOptions::new()
                    .create(true)
                    .read(true)
                    .write(true)
                    .open(&path)
                {
                    if file.try_lock_exclusive().is_ok() {
                        log::info!(
                            "Broke stale port lock for {} (previous owner pid {})",
                            port,
                            owner
                        );
                        // We hold the lock briefly; dropping releases it.
                    }
                }
            }
        }
    }
}

/// Return a deterministic owner identifier for lock-file bookkeeping.
pub fn owner_identifier() -> String {
    format!("{}-{}", std::process::id(), now_millis())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn can_claim_and_release_port() {
        let dir = TempDir::new().unwrap();
        let lock = try_claim_port(50000, dir.path()).expect("claim should succeed");
        assert_eq!(lock.port(), 50000);
        lock.release();
    }

    #[test]
    fn double_claim_in_same_process_succeeds_no_op() {
        let dir = TempDir::new().unwrap();
        let first = try_claim_port(50001, dir.path()).expect("first claim should succeed");
        let second = try_claim_port(50001, dir.path()).expect("second claim in same process should succeed");
        second.release();
        first.release();
    }

    #[test]
    fn claim_set_releases_on_failure() {
        let dir = TempDir::new().unwrap();
        let home = dir.path();

        // Claim a free port so the set has something to release on failure.
        let _free = try_claim_port(50003, home).unwrap();

        // Manually occupy 50004 with the maximum possible PID. Because the
        // file is not actually locked by a live process, try_claim_port will
        // treat it as stale and recover it. To make the test deterministic
        // without spawning a subprocess, we hold the underlying file lock
        // ourselves and verify the set release logic.
        let path = lock_file_path(50004, home);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let occupying = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .open(&path)
            .unwrap();
        occupying.lock_exclusive().unwrap();

        let result = claim_port_set(&[50005, 50004], home);
        assert!(
            result.is_none(),
            "claim set should fail because 50004 is locked"
        );

        // 50005 must not remain locked after the failed atomic claim.
        let recovered = try_claim_port(50005, home);
        assert!(
            recovered.is_some(),
            "failed claim set should release partial locks"
        );
        recovered.unwrap().release();
    }

    #[test]
    fn stale_lock_is_recovered() {
        let dir = TempDir::new().unwrap();
        let home = dir.path();
        let path = lock_file_path(50006, home);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "999999999\n").unwrap();

        let lock = try_claim_port(50006, home).expect("should recover stale lock");
        lock.release();
    }
}
