//! Effective-PATH resolution.
//!
//! GUI-launched apps inherit a minimal environment block (launchd on macOS,
//! the login-time snapshot on Windows), so the process PATH usually misses
//! Homebrew, nvm, registry edits made after login, etc. This module computes
//! the PATH a user's terminal would see, caches it, and exposes it to
//! (a) tool probing in `environment.rs` and (b) child-process spawn sites
//! (dashboard / gateway / in-app terminal), which is what makes node/npx/rg
//! visible to the managed runtime and its MCP subprocesses (#190 #196 #197).
//!
//! Deliberately never calls `std::env::set_var` — mutating the process
//! environment after threads exist is undefined behavior territory. Consumers
//! read the cached value and apply it per `Command` via `.env("PATH", ...)`.

use std::collections::HashSet;
use std::env;
use std::ffi::{OsStr, OsString};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, OnceLock, RwLock};
use std::thread;
use std::time::{Duration, Instant};

/// Upper bound for the login-shell PATH probe. Shell startup files normally
/// finish in tens of milliseconds; a hung profile must not stall bootstrap.
pub const SHELL_PROBE_TIMEOUT: Duration = Duration::from_millis(2500);

/// Throttle for non-forced refreshes: the env page auto-refetches every 60s
/// and must not spawn a login shell each time.
const MIN_REFRESH_INTERVAL: Duration = Duration::from_secs(20);

/// Marker printed right before the PATH value so profile noise (echo in
/// .zprofile etc.) cannot corrupt parsing.
const PATH_MARKER: &str = "__HERMES_PATH_MARKER__";

/// Escape hatch: set to "1" to skip the login-shell probe entirely.
const DISABLE_SHELL_PATH_ENV: &str = "HERMES_DESKTOP_DISABLE_SHELL_PATH";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PathSource {
    Process,
    LoginShell,
    RegistryMachine,
    RegistryUser,
    WellKnown,
}

#[derive(Debug, Clone)]
pub enum ShellProbeOutcome {
    Ok {
        shell: String,
    },
    Timeout {
        shell: String,
    },
    Failed {
        shell: String,
        error: String,
    },
    Disabled,
    /// Windows: PATH comes from the registry, not a login shell.
    NotApplicable,
}

#[derive(Debug, Clone)]
pub struct EffectivePath {
    pub entries: Vec<(PathBuf, PathSource)>,
    pub probe: ShellProbeOutcome,
    /// Windows: PATHEXT read from the registry (machine hive), if any.
    pub pathext: Option<String>,
}

struct CacheState {
    value: Option<Arc<EffectivePath>>,
    resolved_at: Option<Instant>,
}

fn cache() -> &'static RwLock<CacheState> {
    static CACHE: OnceLock<RwLock<CacheState>> = OnceLock::new();
    CACHE.get_or_init(|| {
        RwLock::new(CacheState {
            value: None,
            resolved_at: None,
        })
    })
}

fn applied_to_runtime() -> &'static RwLock<Option<OsString>> {
    static APPLIED: OnceLock<RwLock<Option<OsString>>> = OnceLock::new();
    APPLIED.get_or_init(|| RwLock::new(None))
}

/// Resolve the effective PATH now and update the cache. Blocking for at most
/// `timeout` plus a small epsilon. Non-forced calls within
/// `MIN_REFRESH_INTERVAL` of the last resolution return the cached value.
pub fn refresh_blocking(timeout: Duration, force: bool) -> Arc<EffectivePath> {
    if !force {
        let state = cache().read().expect("path cache poisoned");
        if let (Some(value), Some(at)) = (&state.value, state.resolved_at) {
            if at.elapsed() < MIN_REFRESH_INTERVAL {
                return value.clone();
            }
        }
    }

    let resolved = Arc::new(resolve(timeout));
    let mut state = cache().write().expect("path cache poisoned");
    state.value = Some(resolved.clone());
    state.resolved_at = Some(Instant::now());
    resolved
}

/// Cached snapshot; resolves synchronously on first use.
pub fn snapshot() -> Arc<EffectivePath> {
    if let Some(value) = cache().read().expect("path cache poisoned").value.clone() {
        return value;
    }
    refresh_blocking(SHELL_PROBE_TIMEOUT, true)
}

/// Joined PATH for `cmd.env("PATH", ...)`. Falls back to the process PATH if
/// resolution ever produced nothing.
pub fn effective_path_os() -> OsString {
    join_entries(&snapshot().entries).unwrap_or_else(|| env::var_os("PATH").unwrap_or_default())
}

/// Directories to search when probing for tools.
pub fn effective_entries() -> Vec<PathBuf> {
    let snap = snapshot();
    if !snap.entries.is_empty() {
        return snap.entries.iter().map(|(p, _)| p.clone()).collect();
    }
    env::var_os("PATH")
        .map(|p| env::split_paths(&p).collect())
        .unwrap_or_default()
}

/// Windows PATHEXT from the registry, if resolved. Callers fall back to the
/// process env / built-in default themselves.
pub fn effective_pathext() -> Option<String> {
    snapshot().pathext.clone()
}

/// Record the PATH actually handed to the managed dashboard at spawn time.
pub fn mark_applied_to_runtime(applied: &OsStr) {
    *applied_to_runtime().write().expect("applied path poisoned") = Some(applied.to_os_string());
}

/// True when the current effective PATH differs from what the running
/// dashboard was spawned with — the env page uses this to recommend a
/// runtime restart.
pub fn runtime_path_stale() -> bool {
    let guard = applied_to_runtime().read().expect("applied path poisoned");
    let Some(applied) = guard.as_ref() else {
        return false;
    };
    *applied != effective_path_os()
}

fn join_entries(entries: &[(PathBuf, PathSource)]) -> Option<OsString> {
    if entries.is_empty() {
        return None;
    }
    env::join_paths(entries.iter().map(|(p, _)| p.clone())).ok()
}

fn process_path_entries() -> Vec<PathBuf> {
    env::var_os("PATH")
        .map(|p| env::split_paths(&p).collect())
        .unwrap_or_default()
}

#[cfg(not(target_os = "windows"))]
fn resolve(timeout: Duration) -> EffectivePath {
    let disabled = env::var(DISABLE_SHELL_PATH_ENV).is_ok_and(|v| v == "1");
    let (primary, probe) = if disabled {
        (Vec::new(), ShellProbeOutcome::Disabled)
    } else {
        let shell = login_shell();
        match probe_login_shell_path(&shell, timeout) {
            Ok(raw) => {
                let entries = env::split_paths(&raw)
                    .map(|p| (p, PathSource::LoginShell))
                    .collect();
                (entries, ShellProbeOutcome::Ok { shell })
            }
            Err(RunError::Timeout) => (Vec::new(), ShellProbeOutcome::Timeout { shell }),
            Err(RunError::Failed(error)) => {
                (Vec::new(), ShellProbeOutcome::Failed { shell, error })
            }
        }
    };

    let well_known = dirs::home_dir()
        .map(|home| well_known_unix_dirs(&home))
        .unwrap_or_default();

    EffectivePath {
        entries: merge_path_entries(primary, process_path_entries(), well_known, false),
        probe,
        pathext: None,
    }
}

#[cfg(target_os = "windows")]
fn resolve(_timeout: Duration) -> EffectivePath {
    let registry = read_registry_environment();
    let lookup = |name: &str| env::var(name).ok();
    let machine = registry
        .machine_path
        .as_deref()
        .map(|v| expand_windows_placeholders(v, &lookup));
    let user = registry
        .user_path
        .as_deref()
        .map(|v| expand_windows_placeholders(v, &lookup));
    let primary = merge_windows_paths(machine.as_deref(), user.as_deref());

    EffectivePath {
        entries: merge_path_entries(primary, process_path_entries(), Vec::new(), true),
        probe: ShellProbeOutcome::NotApplicable,
        pathext: registry.machine_pathext,
    }
}

#[cfg(not(target_os = "windows"))]
fn login_shell() -> String {
    if let Ok(shell) = env::var("SHELL") {
        let trimmed = shell.trim();
        if !trimmed.is_empty() && Path::new(trimmed).is_file() {
            return trimmed.to_string();
        }
    }
    if cfg!(target_os = "macos") {
        "/bin/zsh".to_string()
    } else {
        "/bin/sh".to_string()
    }
}

#[cfg(not(target_os = "windows"))]
fn probe_login_shell_path(shell: &str, timeout: Duration) -> Result<String, RunError> {
    let (program, args) = login_shell_invocation(shell);
    let mut cmd = Command::new(program);
    cmd.args(args);
    let output = run_with_timeout(cmd, timeout)?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(RunError::Failed(format!(
            "exit {}: {}",
            output.status,
            stderr.trim()
        )));
    }
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    parse_login_shell_path_output(&stdout)
        .ok_or_else(|| RunError::Failed("empty PATH output".to_string()))
}

/// Login shell, non-interactive: `-l -c`. Never `-i` — interactive shells can
/// block on prompts (powerlevel10k instant prompt, mesg, ...). `printenv`
/// reads the exported variable through an external binary, which sidesteps
/// fish's list-typed `$PATH` expansion.
fn login_shell_invocation(shell: &str) -> (String, Vec<String>) {
    (
        shell.to_string(),
        vec![
            "-l".to_string(),
            "-c".to_string(),
            format!("printf \"%s\" \"{PATH_MARKER}\"; printenv PATH"),
        ],
    )
}

/// Extract the PATH from the probe stdout: everything on the marker's line
/// after its LAST occurrence (profile noise printed before the command runs
/// is discarded; the marker itself is printed without a trailing newline).
fn parse_login_shell_path_output(stdout: &str) -> Option<String> {
    let idx = stdout.rfind(PATH_MARKER)?;
    let after = &stdout[idx + PATH_MARKER.len()..];
    let line = after.lines().next()?.trim();
    if line.is_empty() {
        None
    } else {
        Some(line.to_string())
    }
}

#[derive(Debug)]
enum RunError {
    Timeout,
    Failed(String),
}

/// Run a command with stdin detached, killing it at the deadline. Polling
/// `try_wait` keeps this dependency-free; the probe output is far below pipe
/// buffer capacity, so a successful child never blocks on writes.
fn run_with_timeout(mut cmd: Command, timeout: Duration) -> Result<std::process::Output, RunError> {
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| RunError::Failed(e.to_string()))?;
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => {
                return child
                    .wait_with_output()
                    .map_err(|e| RunError::Failed(e.to_string()));
            }
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(RunError::Timeout);
                }
                thread::sleep(Duration::from_millis(10));
            }
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(RunError::Failed(e.to_string()));
            }
        }
    }
}

/// Merge PATH entry lists, deduping while keeping the first occurrence.
/// Order: `primary` (login shell / registry — matches what the user's
/// terminal resolves), then process-PATH extras, then existing well-known
/// dirs as a safety net. The desktop never resolves `hermes` from PATH and
/// the in-app terminal prepends its shim dir explicitly, so demoting the
/// process PATH cannot re-enable a global hermes install.
fn merge_path_entries(
    primary: Vec<(PathBuf, PathSource)>,
    process: Vec<PathBuf>,
    well_known: Vec<PathBuf>,
    case_insensitive: bool,
) -> Vec<(PathBuf, PathSource)> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut out: Vec<(PathBuf, PathSource)> = Vec::new();
    let mut push = |path: PathBuf, source: PathSource, out: &mut Vec<(PathBuf, PathSource)>| {
        // Drop relative / empty entries before they reach a spawned child. A
        // `.` or `./bin` inherited from a user's shell profile would resolve
        // node/npx/rg against the desktop's GUI-launched working directory
        // instead of a trusted install dir — a hijack vector once that PATH is
        // injected into the dashboard / gateway / MCP subprocess tree.
        if !path.is_absolute() {
            return;
        }
        let key = dedupe_key(&path, case_insensitive);
        if key.is_empty() || !seen.insert(key) {
            return;
        }
        out.push((path, source));
    };
    for (path, source) in primary {
        push(path, source, &mut out);
    }
    for path in process {
        push(path, PathSource::Process, &mut out);
    }
    for path in well_known {
        push(path, PathSource::WellKnown, &mut out);
    }
    out
}

fn dedupe_key(path: &Path, case_insensitive: bool) -> String {
    let raw = path.to_string_lossy();
    let trimmed = raw.trim().trim_end_matches(['/', '\\']);
    // Keep filesystem roots ("/", "C:\") that trimming would erase.
    let kept = if trimmed.is_empty() {
        raw.trim()
    } else {
        trimmed
    };
    if case_insensitive {
        kept.to_lowercase()
    } else {
        kept.to_string()
    }
}

/// Common install locations GUI processes routinely miss. Only existing
/// directories are returned. `home` is injected for testability.
fn well_known_unix_dirs(home: &Path) -> Vec<PathBuf> {
    let mut candidates = vec![
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
        home.join(".local").join("bin"),
        home.join(".cargo").join("bin"),
        home.join(".volta").join("bin"),
        home.join(".bun").join("bin"),
    ];
    if let Some(nvm_bin) = nvm_current_bin(&home.join(".nvm")) {
        candidates.push(nvm_bin);
    }
    candidates.into_iter().filter(|d| d.is_dir()).collect()
}

/// Resolve nvm's active node bin dir: the `alias/default` target when it
/// exists, otherwise the highest installed version.
fn nvm_current_bin(nvm_dir: &Path) -> Option<PathBuf> {
    let versions = nvm_dir.join("versions").join("node");
    if let Ok(alias) = fs::read_to_string(nvm_dir.join("alias").join("default")) {
        let alias = alias.trim();
        if !alias.is_empty() {
            let direct = versions.join(alias).join("bin");
            if direct.is_dir() {
                return Some(direct);
            }
            let want = alias.trim_start_matches('v');
            if let Some(found) = best_version_bin(&versions, Some(want)) {
                return Some(found);
            }
        }
    }
    best_version_bin(&versions, None)
}

fn best_version_bin(versions: &Path, prefix: Option<&str>) -> Option<PathBuf> {
    let mut best: Option<(Vec<u64>, PathBuf)> = None;
    for entry in fs::read_dir(versions).ok()?.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let normalized = name.trim_start_matches('v');
        if let Some(prefix) = prefix {
            if !normalized.starts_with(prefix) {
                continue;
            }
        }
        let Some(parsed) = parse_version(normalized) else {
            continue;
        };
        let bin = entry.path().join("bin");
        if !bin.is_dir() {
            continue;
        }
        if best.as_ref().is_none_or(|(v, _)| parsed > *v) {
            best = Some((parsed, bin));
        }
    }
    best.map(|(_, bin)| bin)
}

fn parse_version(value: &str) -> Option<Vec<u64>> {
    let parts: Vec<u64> = value
        .split('.')
        .map(|part| part.parse::<u64>())
        .collect::<Result<_, _>>()
        .ok()?;
    if parts.is_empty() {
        None
    } else {
        Some(parts)
    }
}

/// Expand `%VAR%` placeholders the way REG_EXPAND_SZ values are expanded.
/// Unknown variables are kept literally; `%%` collapses to `%`. Pure and
/// cfg-free so it is testable on any OS.
#[allow(dead_code)]
fn expand_windows_placeholders(value: &str, lookup: &dyn Fn(&str) -> Option<String>) -> String {
    let mut out = String::new();
    let mut rest = value;
    while let Some(start) = rest.find('%') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        match after.find('%') {
            Some(end) => {
                let name = &after[..end];
                if name.is_empty() {
                    out.push('%');
                } else if let Some(resolved) = lookup(name) {
                    out.push_str(&resolved);
                } else {
                    out.push('%');
                    out.push_str(name);
                    out.push('%');
                }
                rest = &after[end + 1..];
            }
            None => {
                out.push('%');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// Merge Windows registry PATH sources in OS semantics order: machine, then
/// user. Process-only extras are appended by the caller through
/// `merge_path_entries`. Pure and cfg-free for tests.
#[allow(dead_code)]
fn merge_windows_paths(machine: Option<&str>, user: Option<&str>) -> Vec<(PathBuf, PathSource)> {
    let mut out = Vec::new();
    for (value, source) in [
        (machine, PathSource::RegistryMachine),
        (user, PathSource::RegistryUser),
    ] {
        let Some(value) = value else { continue };
        for piece in value.split(';') {
            let trimmed = piece.trim().trim_matches('"');
            if !trimmed.is_empty() {
                out.push((PathBuf::from(trimmed), source));
            }
        }
    }
    out
}

#[cfg(target_os = "windows")]
struct RegistryEnvironment {
    machine_path: Option<String>,
    user_path: Option<String>,
    machine_pathext: Option<String>,
}

/// Read PATH/PATHEXT from the registry so changes made after login (setx,
/// installers) are visible without relaunching the app. Each value is
/// independently optional — restricted hives just fall back to the process
/// environment.
#[cfg(target_os = "windows")]
fn read_registry_environment() -> RegistryEnvironment {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
    use winreg::RegKey;

    fn read_value(hive: winreg::HKEY, subkey: &str, name: &str) -> Option<String> {
        RegKey::predef(hive)
            .open_subkey(subkey)
            .ok()?
            .get_value::<String, _>(name)
            .ok()
            .filter(|v| !v.trim().is_empty())
    }

    const MACHINE_ENV: &str = r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment";
    RegistryEnvironment {
        machine_path: read_value(HKEY_LOCAL_MACHINE, MACHINE_ENV, "Path"),
        user_path: read_value(HKEY_CURRENT_USER, "Environment", "Path"),
        machine_pathext: read_value(HKEY_LOCAL_MACHINE, MACHINE_ENV, "PATHEXT"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    fn p(s: &str) -> PathBuf {
        PathBuf::from(s)
    }

    // Uses POSIX-absolute fixtures; `is_absolute()` in merge_path_entries is
    // platform-specific, so these run on Unix only.
    #[cfg(unix)]
    #[test]
    fn merge_dedupes_keeping_first_occurrence() {
        let merged = merge_path_entries(
            vec![
                (p("/opt/homebrew/bin"), PathSource::LoginShell),
                (p("/usr/bin"), PathSource::LoginShell),
            ],
            vec![p("/usr/bin"), p("/sbin")],
            vec![p("/opt/homebrew/bin/")],
            false,
        );
        assert_eq!(
            merged,
            vec![
                (p("/opt/homebrew/bin"), PathSource::LoginShell),
                (p("/usr/bin"), PathSource::LoginShell),
                (p("/sbin"), PathSource::Process),
            ]
        );
    }

    #[cfg(unix)]
    #[test]
    fn merge_orders_shell_then_process_then_well_known() {
        let merged = merge_path_entries(
            vec![(p("/shell"), PathSource::LoginShell)],
            vec![p("/process")],
            vec![p("/well-known")],
            false,
        );
        assert_eq!(
            merged.iter().map(|(_, s)| *s).collect::<Vec<_>>(),
            vec![
                PathSource::LoginShell,
                PathSource::Process,
                PathSource::WellKnown
            ]
        );
    }

    // A relative entry (`.`, `./bin`) from a user's shell profile must never
    // be forwarded to a spawned child: it would resolve tools against the
    // desktop's working directory rather than a trusted install dir.
    #[cfg(unix)]
    #[test]
    fn merge_drops_relative_entries() {
        let merged = merge_path_entries(
            vec![
                (p("."), PathSource::LoginShell),
                (p("./bin"), PathSource::LoginShell),
                (p("/usr/bin"), PathSource::LoginShell),
            ],
            vec![p("relative/dir"), p("/sbin")],
            vec![],
            false,
        );
        assert_eq!(
            merged,
            vec![
                (p("/usr/bin"), PathSource::LoginShell),
                (p("/sbin"), PathSource::Process),
            ]
        );
    }

    #[test]
    fn merge_skips_empty_entries() {
        let merged = merge_path_entries(
            vec![(p(""), PathSource::LoginShell)],
            vec![p("  ")],
            vec![],
            false,
        );
        assert_eq!(merged, vec![]);
    }

    #[test]
    fn dedupe_key_is_case_insensitive_on_demand() {
        assert_eq!(
            dedupe_key(Path::new(r"C:\Tools\Bin\"), true),
            dedupe_key(Path::new(r"c:\tools\bin"), true)
        );
        assert_ne!(
            dedupe_key(Path::new("/Tools"), false),
            dedupe_key(Path::new("/tools"), false)
        );
    }

    #[test]
    fn parse_login_shell_output_takes_text_after_last_marker() {
        let noisy = format!(
            "profile says hi\n{PATH_MARKER}ignored-earlier\nmore noise {PATH_MARKER}/usr/bin:/opt/homebrew/bin\ntrailing"
        );
        assert_eq!(
            parse_login_shell_path_output(&noisy),
            Some("/usr/bin:/opt/homebrew/bin".to_string())
        );
    }

    #[test]
    fn parse_login_shell_output_rejects_empty_or_missing_marker() {
        assert_eq!(parse_login_shell_path_output("no marker here"), None);
        assert_eq!(
            parse_login_shell_path_output(&format!("{PATH_MARKER}\n/late/line")),
            None
        );
    }

    #[test]
    fn login_shell_invocation_uses_l_c_and_printenv() {
        let (program, args) = login_shell_invocation("/bin/zsh");
        assert_eq!(program, "/bin/zsh");
        assert_eq!(args.len(), 3);
        assert_eq!(args[0], "-l");
        assert_eq!(args[1], "-c");
        assert!(args[2].contains("printenv PATH"));
        assert!(!args.contains(&"-i".to_string()));
    }

    #[test]
    fn well_known_unix_dirs_only_includes_existing() {
        let home = tempfile::TempDir::new().unwrap();
        let cargo_bin = home.path().join(".cargo").join("bin");
        fs::create_dir_all(&cargo_bin).unwrap();

        let dirs = well_known_unix_dirs(home.path());
        let home_dirs: Vec<&PathBuf> = dirs.iter().filter(|d| d.starts_with(home.path())).collect();
        assert_eq!(home_dirs, vec![&cargo_bin]);
    }

    #[test]
    fn nvm_bin_prefers_default_alias() {
        let home = tempfile::TempDir::new().unwrap();
        let nvm = home.path().join(".nvm");
        let v20 = nvm.join("versions/node/v20.1.0/bin");
        let v22 = nvm.join("versions/node/v22.2.0/bin");
        fs::create_dir_all(&v20).unwrap();
        fs::create_dir_all(&v22).unwrap();
        fs::create_dir_all(nvm.join("alias")).unwrap();
        fs::write(nvm.join("alias/default"), "v20.1.0\n").unwrap();

        assert_eq!(nvm_current_bin(&nvm), Some(v20));
    }

    #[test]
    fn nvm_bin_falls_back_to_newest_version() {
        let home = tempfile::TempDir::new().unwrap();
        let nvm = home.path().join(".nvm");
        let v20 = nvm.join("versions/node/v20.10.0/bin");
        let v22 = nvm.join("versions/node/v22.2.0/bin");
        fs::create_dir_all(&v20).unwrap();
        fs::create_dir_all(&v22).unwrap();

        assert_eq!(nvm_current_bin(&nvm), Some(v22));
    }

    #[test]
    fn expand_windows_placeholders_resolves_known_and_keeps_unknown() {
        let lookup = |name: &str| match name {
            "SystemRoot" => Some(r"C:\Windows".to_string()),
            _ => None,
        };
        assert_eq!(
            expand_windows_placeholders(r"%SystemRoot%\bin;%NOPE%\x;100%%", &lookup),
            r"C:\Windows\bin;%NOPE%\x;100%"
        );
    }

    #[test]
    fn merge_windows_paths_machine_then_user() {
        let merged = merge_windows_paths(
            Some(r"C:\Windows;C:\Windows\System32"),
            Some(r#"C:\Users\me\bin; ;"C:\Quoted""#),
        );
        assert_eq!(
            merged,
            vec![
                (p(r"C:\Windows"), PathSource::RegistryMachine),
                (p(r"C:\Windows\System32"), PathSource::RegistryMachine),
                (p(r"C:\Users\me\bin"), PathSource::RegistryUser),
                (p(r"C:\Quoted"), PathSource::RegistryUser),
            ]
        );
    }

    #[cfg(unix)]
    #[test]
    fn run_with_timeout_kills_hung_child() {
        let mut cmd = Command::new("sleep");
        cmd.arg("30");
        let started = Instant::now();
        let result = run_with_timeout(cmd, Duration::from_millis(100));
        assert!(matches!(result, Err(RunError::Timeout)));
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn join_entries_empty_is_none() {
        assert_eq!(join_entries(&[]), None);
        let joined = join_entries(&[(p("/usr/bin"), PathSource::Process)]).unwrap();
        assert_eq!(joined, OsString::from("/usr/bin"));
    }

    #[test]
    #[serial_test::serial]
    fn refresh_is_throttled_then_forced() {
        let first = refresh_blocking(Duration::from_millis(500), true);
        let second = refresh_blocking(Duration::from_millis(500), false);
        assert!(
            Arc::ptr_eq(&first, &second),
            "throttled call must reuse cache"
        );
        let third = refresh_blocking(Duration::from_millis(500), true);
        assert!(!Arc::ptr_eq(&second, &third), "forced call must re-resolve");
    }

    #[test]
    #[serial_test::serial]
    fn runtime_path_stale_flips_on_mark() {
        let current = effective_path_os();
        mark_applied_to_runtime(&current);
        assert!(!runtime_path_stale());
        mark_applied_to_runtime(OsStr::new("/definitely/not/the/current/path"));
        assert!(runtime_path_stale());
        // Reset so other tests see a clean slate.
        mark_applied_to_runtime(&current);
    }
}
