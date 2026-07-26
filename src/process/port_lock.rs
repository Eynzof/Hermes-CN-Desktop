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

/// Check whether *port* is in the local claims set (used by tests).
pub fn local_claims_contains(port: u16) -> bool {
    let guard = LOCAL_CLAIMS.lock().unwrap_or_else(|e| e.into_inner());
    guard.as_ref().map_or(false, |set| set.contains(&port))
}

/// Clear all local port claims (used before retry-loops that re-acquire
/// locks on potentially different ports).
pub fn reset_local_claims() {
    if let Ok(mut guard) = LOCAL_CLAIMS.lock() {
        *guard = None;
    }
}

/// Opaque handle representing a held port lock.
pub struct PortLock {
    port: u16,
    /// `None` for a no-op lock (same process already holds the real lock, or
    /// the lock file is unavailable). `Some(File)` for the real OS lock.
    file: Option<File>,
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
///
/// The lock file format is ``PID:START_TIME_EPOCH_MS`` on one line.
/// Old-format files (just ``PID`` alone) are also parsed for backward
/// compatibility.
fn read_lock_owner(path: &Path) -> Option<u32> {
    let mut content = String::new();
    File::open(path).ok()?.read_to_string(&mut content).ok()?;
    let first = content.lines().next()?.trim();
    let pid_str = first.split(':').next()?.trim();
    pid_str.parse().ok()
}

/// Read ``(PID, start_time_epoch_ms)`` from the lock file.
/// Old-format files (no ``:``) return ``(pid, 0)``.
fn read_lock_owner_with_start_time(path: &Path) -> Option<(u32, u64)> {
    let mut content = String::new();
    File::open(path).ok()?.read_to_string(&mut content).ok()?;
    let first = content.lines().next()?.trim();
    if first.is_empty() {
        return None;
    }
    if let Some((pid_str, time_str)) = first.split_once(':') {
        let pid = pid_str.trim().parse().ok()?;
        let start_time = time_str.trim().parse().unwrap_or(0);
        Some((pid, start_time))
    } else {
        // Old format: just PID.
        let pid = first.parse().ok()?;
        Some((pid, 0))
    }
}

/// Write the current owner PID and start time into the lock file.
/// Format: ``PID:START_TIME_EPOCH_MS`` where START_TIME is the process
/// creation time (used to detect PID reuse — see Bug 5).
fn write_lock_owner(path: &Path, pid: u32) {
    let start_time = get_my_start_time().unwrap_or_else(|| now_millis() as u64);
    let _ = fs::write(path, format!("{}:{}\n", pid, start_time));
}

/// Return the current process's creation time as epoch ms, or ``None``.
pub fn get_my_start_time() -> Option<u64> {
    get_process_start_time(std::process::id())
}

/// Best-effort PID liveness check.
#[cfg(unix)]
pub fn pid_is_running(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    let rc = unsafe { libc::kill(pid as libc::pid_t, 0) };
    rc == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(windows)]
pub fn pid_is_running(pid: u32) -> bool {
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
pub fn pid_is_running(_pid: u32) -> bool {
    false
}

/// Return the creation time of *pid* as epoch milliseconds, or ``None``.
///
/// Used to detect PID reuse.
#[cfg(windows)]
fn get_process_start_time(pid: u32) -> Option<u64> {
    if pid == 0 {
        return None;
    }
    use std::os::raw::c_void;

    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;

    extern "system" {
        fn OpenProcess(dwDesiredAccess: u32, bInheritHandle: i32, dwProcessId: u32) -> *mut c_void;
        fn CloseHandle(hObject: *mut c_void) -> i32;
        fn GetProcessTimes(
            hProcess: *mut c_void,
            lpCreationTime: *mut u64,
            lpExitTime: *mut u64,
            lpKernelTime: *mut u64,
            lpUserTime: *mut u64,
        ) -> i32;
    }

    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return None;
        }
        let mut creation: u64 = 0;
        let mut exit_t: u64 = 0;
        let mut kernel_t: u64 = 0;
        let mut user_t: u64 = 0;
        let result = GetProcessTimes(
            handle,
            &mut creation,
            &mut exit_t,
            &mut kernel_t,
            &mut user_t,
        );
        CloseHandle(handle);
        if result == 0 {
            return None;
        }
        // FILETIME is 100-ns intervals since 1601-01-01.
        // 11644473600 = seconds from 1601-01-01 to 1970-01-01.
        let epoch_ms = (creation / 10_000).saturating_sub(11644473600_000);
        Some(epoch_ms)
    }
}

#[cfg(unix)]
fn get_process_start_time(pid: u32) -> Option<u64> {
    if pid == 0 {
        return None;
    }
    // Read /proc/<pid>/stat field 22 (start_time in jiffies since boot).
    let stat_path = format!("/proc/{pid}/stat");
    let stat_content = fs::read_to_string(&stat_path).ok()?;
    let fields: Vec<&str> = stat_content.split_whitespace().collect();
    if fields.len() < 22 {
        return None;
    }
    let start_jiffies: u64 = fields.get(21)?.parse().ok()?;
    // Read boot time from /proc/stat.
    let proc_stat = fs::read_to_string("/proc/stat").ok()?;
    let btime_secs: u64 = proc_stat
        .lines()
        .find(|line| line.starts_with("btime "))?
        .split_whitespace()
        .nth(1)?
        .parse()
        .ok()?;
    let clk_tck: u64 = unsafe { libc::sysconf(libc::_SC_CLK_TCK) } as u64;
    let start_secs = btime_secs + (start_jiffies / clk_tck);
    Some(start_secs * 1000)
}

#[cfg(not(any(unix, windows)))]
fn get_process_start_time(_pid: u32) -> Option<u64> {
    None
}

/// Check if the lock at *path* is held by a stale (dead or PID-reused) owner.
///
/// Returns ``true`` when the lock should be broken.
fn stale_lock_owner(path: &Path) -> bool {
    let Some((pid, stored_start_time)) = read_lock_owner_with_start_time(path) else {
        return false;
    };

    // PID 0 is never valid.
    if pid == 0 {
        return true;
    }

    // If PID is not running, the lock is definitely stale.
    if !pid_is_running(pid) {
        return true;
    }

    // PID is running.  Check if the start time matches (PID reuse guard).
    if stored_start_time > 0 {
        if let Some(actual_start_time) = get_process_start_time(pid) {
            if actual_start_time != stored_start_time {
                // The process with this PID today is a *different* process.
                return true;
            }
        }
    }

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
                owns_local_claim: true,
            });
        }
    }

    let file = match OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(&path)
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
                owns_local_claim: true,
            });
        }
    };

    if file.try_lock_exclusive().is_ok() {
        write_lock_owner(&path, std::process::id());
        return Some(PortLock {
            port,
            file: Some(file),
            owns_local_claim: true,
        });
    }

    // Lock is held. Check whether the owner is still alive (stale lock,
    // including PID reuse detection via start_time mismatch).
    if stale_lock_owner(&path) {
        // Break stale lock. Close our failed handle first to avoid holding
        // a conflicting view, then reopen and claim.
        drop(file);
        // Small, deterministic backoff to reduce thundering herd when many
        // instances race to break a stale lock.
        std::thread::sleep(std::time::Duration::from_millis(10));
        let fresh = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(&path)
            .ok()?;
        if fresh.try_lock_exclusive().is_ok() {
            write_lock_owner(&path, std::process::id());
            return Some(PortLock {
                port,
                file: Some(fresh),
                owns_local_claim: true,
            });
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
pub fn claim_port_set(ports: &[u16], hermes_home: impl AsRef<Path>) -> Option<Vec<PortLock>> {
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
                    .truncate(false)
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
        let second =
            try_claim_port(50001, dir.path()).expect("second claim in same process should succeed");
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
            .truncate(false)
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

    // ── Bug 4: local_claims cleanup ─────────────────────────────────

    #[test]
    fn local_claims_cleared_after_drop_all_locks() {
        let dir = TempDir::new().unwrap();
        let home = dir.path();

        // First claim
        let locks = claim_port_set(&[50010, 50011, 50012], home).unwrap();
        assert!(local_claims_contains(50010));
        assert!(local_claims_contains(50011));
        assert!(local_claims_contains(50012));

        // Release all
        drop(locks);

        // Local claims cleared
        assert!(!local_claims_contains(50010));
        assert!(!local_claims_contains(50011));
        assert!(!local_claims_contains(50012));

        // Re-claim same ports — should get real OS locks, not no-op handles
        let locks2 = claim_port_set(&[50010, 50011, 50012], home).unwrap();
        for lock in &locks2 {
            assert!(
                lock.file.is_some(),
                "port {} should have real OS lock after re-claim",
                lock.port()
            );
        }
        drop(locks2);
    }

    // ── Bug 5: PID reuse detection ───────────────────────────────────

    #[test]
    fn stale_lock_with_start_time_detected() {
        let dir = TempDir::new().unwrap();
        let home = dir.path();
        let path = lock_file_path(50020, home);
        fs::create_dir_all(path.parent().unwrap()).unwrap();

        // Write a lock with our PID but a deliberately *wrong* start_time
        // (simulating PID reuse).
        let our_pid = std::process::id();
        let fake_start = (now_millis() as u64).saturating_sub(3600_000); // 1h ago
        fs::write(&path, format!("{}:{}\n", our_pid, fake_start)).unwrap();

        // stale_lock_owner should detect the mismatch
        assert!(
            stale_lock_owner(&path),
            "should detect stale lock via start_time mismatch"
        );

        // And try_claim_port should break it
        let lock = try_claim_port(50020, home).expect("should break stale lock and claim");
        lock.release();
    }

    #[test]
    fn stale_lock_not_broken_when_owner_alive() {
        let dir = TempDir::new().unwrap();
        let home = dir.path();
        let path = lock_file_path(50021, home);
        fs::create_dir_all(path.parent().unwrap()).unwrap();

        // Write a lock with our PID and our actual start_time.
        let our_pid = std::process::id();
        write_lock_owner(&path, our_pid);

        // stale_lock_owner should return false (we're alive, times match)
        assert!(
            !stale_lock_owner(&path),
            "live owner with matching start_time should not be stale"
        );
    }

    // ── Bug 7: PID consistency matrix ────────────────────────────────

    #[test]
    fn pid_is_running_consistency_matrix() {
        assert!(!pid_is_running(0)); // PID 0
        assert!(pid_is_running(std::process::id())); // ourselves
        assert!(!pid_is_running(99999999)); // nonexistent
                                            // SYSTEM PID (4) — should not crash
        let _system = pid_is_running(4);
    }

    // ── Bug 8: Lock file format compatibility ────────────────────────

    #[test]
    fn read_lock_owner_edge_cases() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("test.lock");

        let cases: Vec<(&str, Option<u32>)> = vec![
            ("12345\n", Some(12345)),
            ("12345", Some(12345)),
            ("  12345  \n", Some(12345)),
            ("12345\n99999\n", Some(12345)),
            ("", None),
            ("\n", None),
            ("abc", None),
            ("12abc", None),
            ("0\n", Some(0)),
            // New format (pid:start_time): read_lock_owner returns just the pid
            ("12345:67890\n", Some(12345)),
            ("  12345  :  67890  \n", Some(12345)),
        ];

        for (content, expected) in cases {
            fs::write(&path, content).unwrap();
            let result = read_lock_owner(&path);
            assert_eq!(
                result, expected,
                "Mismatch for content {:?}: got {:?}, expected {:?}",
                content, result, expected
            );
        }
    }

    #[test]
    fn read_lock_owner_with_start_time_parses() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("test2.lock");

        // Old format (no colon)
        fs::write(&path, "42\n").unwrap();
        let r = read_lock_owner_with_start_time(&path);
        assert_eq!(r, Some((42, 0)));

        // New format
        fs::write(&path, "42:1234567890\n").unwrap();
        let r = read_lock_owner_with_start_time(&path);
        assert_eq!(r, Some((42, 1234567890)));

        // Empty file
        fs::write(&path, "").unwrap();
        let r = read_lock_owner_with_start_time(&path);
        assert_eq!(r, None);

        // Garbage
        fs::write(&path, "abc\n").unwrap();
        let r = read_lock_owner_with_start_time(&path);
        assert_eq!(r, None);
    }
}
