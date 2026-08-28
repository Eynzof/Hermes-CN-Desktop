use std::collections::BTreeSet;
use std::fs::{self, OpenOptions};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use fs2::FileExt;
use serde_json::Value;

use crate::process::runtime::RuntimeInstallRecord;

const GATEWAY_PID_FILE: &str = "gateway.pid";
const GATEWAY_LOCK_FILE: &str = "gateway.lock";
const GATEWAY_STOP_HELPER_TIMEOUT: Duration = Duration::from_secs(12);
const GATEWAY_SETTLE_TIMEOUT: Duration = Duration::from_secs(6);
const GATEWAY_FORCE_SETTLE_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum GatewayRecordSource {
    PidFile,
    LockFile,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct GatewayRuntimeRecord {
    pid: Option<u32>,
    kind: Option<String>,
    argv: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ManagedGatewayPreflightReport {
    pub stop_attempted: bool,
    pub stop_exit_code: Option<i32>,
    pub stop_timed_out: bool,
    pub force_killed_pids: Vec<u32>,
    pub stale_files_removed: usize,
    pub remaining_pids: Vec<u32>,
    pub lock_active: bool,
}

impl ManagedGatewayPreflightReport {
    pub fn summary(&self) -> String {
        format!(
            "stop_attempted={}, stop_exit_code={:?}, stop_timed_out={}, force_killed_pids={:?}, stale_files_removed={}, remaining_pids={:?}, lock_active={}",
            self.stop_attempted,
            self.stop_exit_code,
            self.stop_timed_out,
            self.force_killed_pids,
            self.stale_files_removed,
            self.remaining_pids,
            self.lock_active
        )
    }
}

fn gateway_pid_path(runtime_dir: &Path) -> PathBuf {
    runtime_dir.join(GATEWAY_PID_FILE)
}

fn gateway_lock_path(runtime_dir: &Path) -> PathBuf {
    runtime_dir.join(GATEWAY_LOCK_FILE)
}

fn normalize_path_text(path: &Path) -> String {
    fs::canonicalize(path)
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .replace('\\', "/")
        .to_lowercase()
}

fn text_contains_path(text: &str, path: &Path) -> bool {
    let normalized_text = text.replace('\\', "/").to_lowercase();
    let raw = path.to_string_lossy().replace('\\', "/").to_lowercase();
    if !raw.is_empty() && normalized_text.contains(&raw) {
        return true;
    }
    let canonical = normalize_path_text(path);
    !canonical.is_empty() && normalized_text.contains(&canonical)
}

fn parse_pid_value(value: &Value) -> Option<u32> {
    match value {
        Value::Number(number) => number.as_u64().and_then(|pid| u32::try_from(pid).ok()),
        Value::String(text) => text.trim().parse::<u32>().ok(),
        _ => None,
    }
}

fn parse_gateway_runtime_record(raw: &str) -> Option<GatewayRuntimeRecord> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Ok(pid) = trimmed.parse::<u32>() {
        return Some(GatewayRuntimeRecord {
            pid: Some(pid),
            ..GatewayRuntimeRecord::default()
        });
    }

    let value = serde_json::from_str::<Value>(trimmed).ok()?;
    match value {
        Value::Number(_) | Value::String(_) => Some(GatewayRuntimeRecord {
            pid: parse_pid_value(&value),
            ..GatewayRuntimeRecord::default()
        }),
        Value::Object(map) => {
            let argv = map
                .get("argv")
                .and_then(|value| value.as_array())
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|item| item.as_str().map(ToString::to_string))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            Some(GatewayRuntimeRecord {
                pid: map.get("pid").and_then(parse_pid_value),
                kind: map
                    .get("kind")
                    .and_then(|value| value.as_str())
                    .map(ToString::to_string),
                argv,
            })
        }
        _ => None,
    }
}

fn read_gateway_runtime_record(path: &Path) -> Option<GatewayRuntimeRecord> {
    let content = fs::read_to_string(path).ok()?;
    parse_gateway_runtime_record(&content)
}

fn command_line_looks_like_gateway(command_line: &str) -> bool {
    let normalized = command_line.replace('\\', "/").to_lowercase();
    [
        "hermes_cli.main gateway",
        "hermes_cli/main.py gateway",
        "hermes gateway",
        "hermes-gateway",
        "gateway/run.py",
        "gateway run",
    ]
    .iter()
    .any(|pattern| normalized.contains(pattern))
}

fn record_looks_like_gateway(record: &GatewayRuntimeRecord) -> bool {
    if record.kind.as_deref() == Some("hermes-gateway") {
        return true;
    }
    if record.argv.is_empty() {
        return false;
    }
    command_line_looks_like_gateway(&record.argv.join(" "))
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

#[cfg(unix)]
fn process_command_line(pid: u32) -> Option<String> {
    let output = Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "command="])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!text.is_empty()).then_some(text)
}

#[cfg(windows)]
fn process_command_line(pid: u32) -> Option<String> {
    let script = format!(
        "$p = Get-CimInstance Win32_Process -Filter \"ProcessId = {}\"; if ($p) {{ $p.CommandLine }}",
        pid
    );
    let output = Command::new("powershell")
        .args(["-NoProfile", "-Command", &script])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!text.is_empty()).then_some(text)
}

#[cfg(not(any(unix, windows)))]
fn process_command_line(_pid: u32) -> Option<String> {
    None
}

fn live_record_pid(record: &GatewayRuntimeRecord) -> Option<u32> {
    let pid = record.pid?;
    pid_is_running(pid).then_some(pid)
}

fn command_line_verifies_gateway(command_line: Option<&str>) -> bool {
    command_line.is_some_and(command_line_looks_like_gateway)
}

fn live_record_pid_is_verified_gateway(
    record: &GatewayRuntimeRecord,
    source: GatewayRecordSource,
) -> Option<u32> {
    let pid = live_record_pid(record)?;
    if command_line_verifies_gateway(process_command_line(pid).as_deref()) {
        Some(pid)
    } else {
        log::warn!(
            "Skipping unverified Gateway pid {} from {:?}; record_claims_gateway={}",
            pid,
            source,
            record_looks_like_gateway(record)
        );
        None
    }
}

fn gateway_record_paths(runtime_dir: &Path) -> [(PathBuf, GatewayRecordSource); 2] {
    [
        (gateway_pid_path(runtime_dir), GatewayRecordSource::PidFile),
        (
            gateway_lock_path(runtime_dir),
            GatewayRecordSource::LockFile,
        ),
    ]
}

fn gateway_pid_candidates(runtime_dir: &Path) -> Vec<u32> {
    let mut pids = BTreeSet::new();
    for (path, _) in gateway_record_paths(runtime_dir) {
        if let Some(record) = read_gateway_runtime_record(&path) {
            if let Some(pid) = live_record_pid(&record) {
                pids.insert(pid);
            }
        }
    }
    pids.into_iter().collect()
}

fn verified_gateway_pid_candidates(runtime_dir: &Path) -> Vec<u32> {
    let mut pids = BTreeSet::new();
    for (path, source) in gateway_record_paths(runtime_dir) {
        if let Some(record) = read_gateway_runtime_record(&path) {
            if let Some(pid) = live_record_pid_is_verified_gateway(&record, source) {
                pids.insert(pid);
            }
        }
    }
    pids.into_iter().collect()
}

fn token_lock_paths(gateway_lock_dir: &Path) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    let Ok(entries) = fs::read_dir(gateway_lock_dir) else {
        return paths;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().is_some_and(|ext| ext == "lock") {
            paths.push(path);
        }
    }
    paths.sort();
    paths
}

fn token_lock_record_matches_managed_runtime(
    record: &GatewayRuntimeRecord,
    pid: u32,
    runtime_root: &Path,
) -> bool {
    if !record_looks_like_gateway(record) {
        return false;
    }
    if !record.argv.is_empty() && text_contains_path(&record.argv.join(" "), runtime_root) {
        return true;
    }
    process_command_line(pid)
        .as_deref()
        .is_some_and(|command_line| {
            command_line_looks_like_gateway(command_line)
                && text_contains_path(command_line, runtime_root)
        })
}

fn gateway_token_lock_pid_candidates(gateway_lock_dir: &Path, runtime_root: &Path) -> Vec<u32> {
    let mut pids = BTreeSet::new();
    for path in token_lock_paths(gateway_lock_dir) {
        let Some(record) = read_gateway_runtime_record(&path) else {
            continue;
        };
        let Some(pid) = record.pid else {
            continue;
        };
        if pid_is_running(pid)
            && token_lock_record_matches_managed_runtime(&record, pid, runtime_root)
        {
            pids.insert(pid);
        }
    }
    pids.into_iter().collect()
}

fn managed_gateway_pid_candidates(
    runtime_dir: &Path,
    gateway_lock_dir: &Path,
    runtime_root: &Path,
) -> Vec<u32> {
    let mut pids = BTreeSet::new();
    pids.extend(gateway_pid_candidates(runtime_dir));
    pids.extend(gateway_token_lock_pid_candidates(
        gateway_lock_dir,
        runtime_root,
    ));
    pids.into_iter().collect()
}

fn verified_managed_gateway_pid_candidates(
    runtime_dir: &Path,
    gateway_lock_dir: &Path,
    runtime_root: &Path,
) -> Vec<u32> {
    let mut pids = BTreeSet::new();
    pids.extend(verified_gateway_pid_candidates(runtime_dir));
    pids.extend(gateway_token_lock_pid_candidates(
        gateway_lock_dir,
        runtime_root,
    ));
    pids.into_iter().collect()
}

fn cleanup_stale_gateway_token_lock_files(gateway_lock_dir: &Path, _runtime_root: &Path) -> usize {
    let mut removed = 0;
    for path in token_lock_paths(gateway_lock_dir) {
        let remove = match read_gateway_runtime_record(&path) {
            Some(record) => match record.pid {
                Some(pid) if pid_is_running(pid) => !record_looks_like_gateway(&record),
                _ => true,
            },
            None => true,
        };
        if remove {
            match fs::remove_file(&path) {
                Ok(()) => removed += 1,
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => {}
            }
        }
    }
    removed
}

fn gateway_runtime_lock_active(runtime_dir: &Path) -> bool {
    let lock_path = gateway_lock_path(runtime_dir);
    if !lock_path.exists() {
        return false;
    }
    let file = match OpenOptions::new().read(true).write(true).open(&lock_path) {
        Ok(file) => file,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return false,
        Err(_) => return true,
    };
    match file.try_lock_exclusive() {
        Ok(()) => {
            let _ = file.unlock();
            false
        }
        Err(_) => true,
    }
}

pub fn cleanup_stale_gateway_runtime_files(runtime_dir: &Path) -> usize {
    if !runtime_dir.exists() {
        return 0;
    }
    if !gateway_pid_candidates(runtime_dir).is_empty() || gateway_runtime_lock_active(runtime_dir) {
        return 0;
    }

    let mut removed = 0;
    for path in [
        gateway_pid_path(runtime_dir),
        gateway_lock_path(runtime_dir),
    ] {
        match fs::remove_file(&path) {
            Ok(()) => removed += 1,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => {}
        }
    }
    removed
}

pub fn managed_gateway_runtime_occupancy(runtime_dir: &Path) -> (Vec<u32>, bool) {
    let _ = cleanup_stale_gateway_runtime_files(runtime_dir);
    (
        gateway_pid_candidates(runtime_dir),
        gateway_runtime_lock_active(runtime_dir),
    )
}

fn wait_for_child_exit(child: &mut Child, timeout: Duration) -> Option<Option<i32>> {
    let start = Instant::now();
    while start.elapsed() < timeout {
        match child.try_wait() {
            Ok(Some(status)) => return Some(status.code()),
            Ok(None) => thread::sleep(Duration::from_millis(100)),
            Err(_) => return Some(None),
        }
    }
    None
}

fn wait_for_gateway_runtime_to_settle(
    runtime_dir: &Path,
    gateway_lock_dir: &Path,
    runtime_root: &Path,
    timeout: Duration,
) -> bool {
    let start = Instant::now();
    while start.elapsed() < timeout {
        let _ = cleanup_stale_gateway_runtime_files(runtime_dir);
        let _ = cleanup_stale_gateway_token_lock_files(gateway_lock_dir, runtime_root);
        if managed_gateway_pid_candidates(runtime_dir, gateway_lock_dir, runtime_root).is_empty()
            && !gateway_runtime_lock_active(runtime_dir)
        {
            return true;
        }
        thread::sleep(Duration::from_millis(200));
    }
    false
}

fn apply_managed_gateway_env(
    cmd: &mut Command,
    hermes_home: &str,
    gateway_runtime_dir: &Path,
    gateway_lock_dir: &Path,
) {
    // User .env first; the explicit desktop wiring below must win.
    crate::env_file::inject_env_file(cmd, hermes_home, "gateway helper");
    cmd.env("HERMES_HOME", hermes_home)
        .env("HERMES_GATEWAY_RUNTIME_DIR", gateway_runtime_dir)
        .env("HERMES_GATEWAY_LOCK_DIR", gateway_lock_dir)
        .env("HERMES_DESKTOP_MANAGED", "1")
        .env("HERMES_DESKTOP", "1")
        .env("HERMES_GATEWAY_DETACHED", "1")
        .env("HERMES_NONINTERACTIVE", "1")
        .env("PYTHONUNBUFFERED", "1")
        // Prepend the bundled node bin dir (P-032) so gateway-spawned
        // node-based MCP stdio servers resolve node/npx without a host install.
        .env(
            "PATH",
            crate::process::runtime::prepend_bundled_node_to_path(
                crate::path_resolver::effective_path_os(),
            ),
        );
    if let Some(node) = crate::process::runtime::current_node_binary() {
        cmd.env("HERMES_NODE", node);
    }
}

fn spawn_gateway_stop_helper(
    record: &RuntimeInstallRecord,
    hermes_home: &str,
    gateway_runtime_dir: &Path,
    gateway_lock_dir: &Path,
) -> Result<Child, String> {
    let mut cmd = Command::new(&record.executable_path);
    cmd.args(["gateway", "stop"])
        .current_dir(&record.path)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .stdin(Stdio::null());
    apply_managed_gateway_env(&mut cmd, hermes_home, gateway_runtime_dir, gateway_lock_dir);

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x00000200;
        cmd.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
    }

    cmd.spawn()
        .map_err(|err| format!("无法启动 Gateway stop helper：{err}"))
}

#[cfg(unix)]
fn terminate_pid(pid: u32, force: bool) {
    let signal = if force { libc::SIGKILL } else { libc::SIGTERM };
    let _ = unsafe { libc::kill(pid as libc::pid_t, signal) };
}

#[cfg(windows)]
fn terminate_pid(pid: u32, force: bool) {
    let pid_arg = pid.to_string();
    let mut args = vec!["/PID", pid_arg.as_str(), "/T"];
    if force {
        args.push("/F");
    }
    let _ = Command::new("taskkill")
        .args(args)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

#[cfg(not(any(unix, windows)))]
fn terminate_pid(_pid: u32, _force: bool) {}

pub fn preflight_managed_gateway_restart(
    record: &RuntimeInstallRecord,
    hermes_home: &str,
    gateway_runtime_dir: &Path,
    gateway_lock_dir: &Path,
) -> Result<ManagedGatewayPreflightReport, String> {
    fs::create_dir_all(gateway_runtime_dir)
        .map_err(|err| format!("无法创建 Gateway runtime 目录：{err}"))?;
    fs::create_dir_all(gateway_lock_dir)
        .map_err(|err| format!("无法创建 Gateway lock 目录：{err}"))?;

    let mut report = ManagedGatewayPreflightReport::default();
    let runtime_root = crate::process::runtime::runtime_root();
    report.stale_files_removed +=
        cleanup_stale_gateway_token_lock_files(gateway_lock_dir, &runtime_root);
    let live_pids =
        managed_gateway_pid_candidates(gateway_runtime_dir, gateway_lock_dir, &runtime_root);
    let verified_pids = verified_managed_gateway_pid_candidates(
        gateway_runtime_dir,
        gateway_lock_dir,
        &runtime_root,
    );
    let lock_active = gateway_runtime_lock_active(gateway_runtime_dir);
    if live_pids.iter().any(|pid| !verified_pids.contains(pid)) {
        report.remaining_pids = live_pids;
        report.lock_active = lock_active;
        return Ok(report);
    }
    if live_pids.is_empty() {
        if lock_active {
            report.lock_active = true;
        } else {
            report.stale_files_removed += cleanup_stale_gateway_runtime_files(gateway_runtime_dir);
        }
        return Ok(report);
    }
    report.stop_attempted = true;
    match spawn_gateway_stop_helper(record, hermes_home, gateway_runtime_dir, gateway_lock_dir) {
        Ok(mut child) => match wait_for_child_exit(&mut child, GATEWAY_STOP_HELPER_TIMEOUT) {
            Some(code) => report.stop_exit_code = code,
            None => {
                report.stop_timed_out = true;
                let _ = child.kill();
                let _ = child.wait();
            }
        },
        Err(err) => {
            log::warn!("{}", err);
        }
    }
    let _ = wait_for_gateway_runtime_to_settle(
        gateway_runtime_dir,
        gateway_lock_dir,
        &runtime_root,
        GATEWAY_SETTLE_TIMEOUT,
    );

    report.stale_files_removed += cleanup_stale_gateway_runtime_files(gateway_runtime_dir);
    report.stale_files_removed +=
        cleanup_stale_gateway_token_lock_files(gateway_lock_dir, &runtime_root);

    let verified = verified_managed_gateway_pid_candidates(
        gateway_runtime_dir,
        gateway_lock_dir,
        &runtime_root,
    );
    if !verified.is_empty() {
        for pid in &verified {
            terminate_pid(*pid, false);
        }
        if !wait_for_gateway_runtime_to_settle(
            gateway_runtime_dir,
            gateway_lock_dir,
            &runtime_root,
            GATEWAY_FORCE_SETTLE_TIMEOUT,
        ) {
            for pid in verified_managed_gateway_pid_candidates(
                gateway_runtime_dir,
                gateway_lock_dir,
                &runtime_root,
            ) {
                terminate_pid(pid, true);
                report.force_killed_pids.push(pid);
            }
            let _ = wait_for_gateway_runtime_to_settle(
                gateway_runtime_dir,
                gateway_lock_dir,
                &runtime_root,
                GATEWAY_FORCE_SETTLE_TIMEOUT,
            );
        }
    }

    report.stale_files_removed += cleanup_stale_gateway_runtime_files(gateway_runtime_dir);
    report.stale_files_removed +=
        cleanup_stale_gateway_token_lock_files(gateway_lock_dir, &runtime_root);
    report.remaining_pids =
        managed_gateway_pid_candidates(gateway_runtime_dir, gateway_lock_dir, &runtime_root);
    report.lock_active = gateway_runtime_lock_active(gateway_runtime_dir)
        || !gateway_token_lock_pid_candidates(gateway_lock_dir, &runtime_root).is_empty();
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    #[test]
    fn parse_gateway_runtime_record_accepts_plain_pid() {
        assert_eq!(
            parse_gateway_runtime_record("1234").unwrap().pid,
            Some(1234)
        );
    }

    #[test]
    fn parse_gateway_runtime_record_accepts_json_record() {
        let record = parse_gateway_runtime_record(
            r#"{"pid":1234,"kind":"hermes-gateway","argv":["hermes","gateway","run"]}"#,
        )
        .unwrap();
        assert_eq!(record.pid, Some(1234));
        assert!(record_looks_like_gateway(&record));
    }

    #[test]
    fn record_looks_like_gateway_matches_windows_paths() {
        let record = GatewayRuntimeRecord {
            pid: Some(42),
            kind: None,
            argv: vec![
                r"C:\Program Files\Hermes\hermes.exe".to_string(),
                "gateway".to_string(),
                "run".to_string(),
            ],
        };
        assert!(record_looks_like_gateway(&record));
    }

    #[test]
    fn gateway_process_identity_requires_live_command_line_match() {
        assert!(command_line_verifies_gateway(Some(
            r#"C:\Hermes\hermes.exe gateway run"#
        )));
        assert!(!command_line_verifies_gateway(Some(
            r#"C:\Windows\System32\notepad.exe"#
        )));
        assert!(!command_line_verifies_gateway(None));
    }

    #[test]
    fn cleanup_stale_gateway_runtime_files_removes_dead_records() {
        let temp = tempfile::tempdir().expect("tempdir");
        let pid_path = gateway_pid_path(temp.path());
        let lock_path = gateway_lock_path(temp.path());
        fs::write(&pid_path, "0").expect("pid");
        fs::write(&lock_path, r#"{"pid":0,"kind":"hermes-gateway"}"#).expect("lock");

        let removed = cleanup_stale_gateway_runtime_files(temp.path());

        assert_eq!(removed, 2);
        assert!(!pid_path.exists());
        assert!(!lock_path.exists());
    }

    #[test]
    fn cleanup_stale_gateway_runtime_files_keeps_active_lock() {
        let temp = tempfile::tempdir().expect("tempdir");
        let lock_path = gateway_lock_path(temp.path());
        fs::write(&lock_path, r#"{"pid":0,"kind":"hermes-gateway"}"#).expect("lock");
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .open(&lock_path)
            .expect("open lock");
        file.lock_exclusive().expect("hold lock");

        let removed = cleanup_stale_gateway_runtime_files(temp.path());

        assert_eq!(removed, 0);
        assert!(lock_path.exists());
        file.unlock().expect("unlock");
    }

    #[test]
    fn cleanup_stale_gateway_token_lock_files_removes_dead_pid() {
        let temp = tempfile::tempdir().expect("tempdir");
        let runtime_root = temp.path().join("runtime");
        fs::create_dir_all(&runtime_root).expect("runtime");
        let lock_dir = temp.path().join("token-locks");
        fs::create_dir_all(&lock_dir).expect("locks");
        let lock_path = lock_dir.join("weixin.lock");
        fs::write(
            &lock_path,
            format!(
                r#"{{"pid":0,"kind":"hermes-gateway","argv":["{}/versions/old/hermes","gateway","run"]}}"#,
                runtime_root.display()
            ),
        )
        .expect("lock");

        let removed = cleanup_stale_gateway_token_lock_files(&lock_dir, &runtime_root);

        assert_eq!(removed, 1);
        assert!(!lock_path.exists());
    }

    #[test]
    fn gateway_token_lock_pid_candidates_accepts_managed_runtime_path() {
        let temp = tempfile::tempdir().expect("tempdir");
        let runtime_root = temp.path().join("runtime");
        fs::create_dir_all(&runtime_root).expect("runtime");
        let lock_dir = temp.path().join("token-locks");
        fs::create_dir_all(&lock_dir).expect("locks");
        let pid = std::process::id();
        fs::write(
            lock_dir.join("weixin.lock"),
            format!(
                r#"{{"pid":{},"kind":"hermes-gateway","argv":["{}/versions/old/hermes","gateway","run","--replace"]}}"#,
                pid,
                runtime_root.display()
            ),
        )
        .expect("lock");

        assert_eq!(
            gateway_token_lock_pid_candidates(&lock_dir, &runtime_root),
            vec![pid]
        );
    }

    #[test]
    fn gateway_token_lock_pid_candidates_rejects_unrelated_runtime_path() {
        let temp = tempfile::tempdir().expect("tempdir");
        let runtime_root = temp.path().join("runtime");
        let other_root = temp.path().join("other-runtime");
        fs::create_dir_all(&runtime_root).expect("runtime");
        fs::create_dir_all(&other_root).expect("other");
        let lock_dir = temp.path().join("token-locks");
        fs::create_dir_all(&lock_dir).expect("locks");
        fs::write(
            lock_dir.join("weixin.lock"),
            format!(
                r#"{{"pid":{},"kind":"hermes-gateway","argv":["{}/versions/old/hermes","gateway","run","--replace"]}}"#,
                std::process::id(),
                other_root.display()
            ),
        )
        .expect("lock");

        assert!(gateway_token_lock_pid_candidates(&lock_dir, &runtime_root).is_empty());
    }
}
