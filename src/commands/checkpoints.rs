//! Read-only checkpoint helpers for the in-process checkpoint manager.
//!
//! These commands shell system `git` exactly like `src/commands/git.rs` but
//! are scoped to status / diff / snapshot capture. They intentionally do **not**
//! mutate the working tree or the user's repo; restoration is performed by the
//! caller after explicit user confirmation.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

const CHILD_TIMEOUT: Duration = Duration::from_secs(30);
const CHILD_POLL_INTERVAL: Duration = Duration::from_millis(100);

// ── IPC payloads ───────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointStatusInput {
    pub cwd: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointStatusResult {
    pub is_repo: bool,
    pub branch: Option<String>,
    pub clean: bool,
    pub files: Vec<CheckpointStatusFile>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointStatusFile {
    pub path: String,
    pub status: String,
    pub staged: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointDiffInput {
    pub cwd: String,
    #[serde(default)]
    pub base_ref: Option<String>,
    #[serde(default)]
    pub stat_only: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointDiffResult {
    pub empty: bool,
    pub stat: Vec<CheckpointDiffStat>,
    pub diff: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointDiffStat {
    pub path: String,
    pub added: u64,
    pub removed: u64,
    pub status: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointSnapshotInput {
    pub cwd: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointSnapshotResult {
    /// HEAD commit hash when inside a repo, else None.
    pub head: Option<String>,
    pub clean: bool,
    pub message: String,
}

// ── Process helpers (mirrors src/commands/git.rs) ────────────────────────────

#[cfg(unix)]
fn augmented_path() -> Option<String> {
    let mut dirs = vec![
        "/opt/homebrew/bin".to_string(),
        "/usr/local/bin".to_string(),
        "/usr/bin".to_string(),
    ];
    if let Ok(existing) = std::env::var("PATH") {
        dirs.push(existing);
    }
    Some(dirs.join(":"))
}

#[cfg(not(unix))]
fn augmented_path() -> Option<String> {
    None
}

fn git_command(cwd: &Path, args: &[&str]) -> Command {
    let mut cmd = Command::new("git");
    cmd.current_dir(cwd);
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    cmd.env("LC_ALL", "C");
    cmd.env("GIT_CONFIG_GLOBAL", std::ffi::OsStr::new("/dev/null"));
    cmd.env("GIT_CONFIG_NOSYSTEM", "1");
    if let Some(path) = augmented_path() {
        cmd.env("PATH", path);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.args(["-c", "core.quotepath=false"]);
    cmd.args(args);
    cmd
}

fn output_with_timeout(
    mut cmd: Command,
    timeout: Duration,
) -> std::io::Result<std::process::Output> {
    use std::io::Read;
    use std::process::Stdio;

    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    let mut child = cmd.spawn()?;

    fn drain<R: Read + Send + 'static>(pipe: Option<R>) -> std::thread::JoinHandle<Vec<u8>> {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            if let Some(mut pipe) = pipe {
                let _ = pipe.read_to_end(&mut buf);
            }
            buf
        })
    }
    let stdout = drain(child.stdout.take());
    let stderr = drain(child.stderr.take());

    let deadline = Instant::now() + timeout;
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            let _ = stdout.join();
            let _ = stderr.join();
            return Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "git command timed out",
            ));
        }
        std::thread::sleep(CHILD_POLL_INTERVAL);
    };

    Ok(std::process::Output {
        status,
        stdout: stdout.join().unwrap_or_default(),
        stderr: stderr.join().unwrap_or_default(),
    })
}

fn run_git(cwd: &Path, args: &[&str]) -> AppResult<String> {
    let output = output_with_timeout(git_command(cwd, args), CHILD_TIMEOUT).map_err(|e| {
        if e.kind() == std::io::ErrorKind::TimedOut {
            AppError::Git("git 命令超时".to_string())
        } else {
            AppError::Git(format!("failed to run git: {e}"))
        }
    })?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(AppError::Git(stderr.trim().to_string()))
    }
}

fn run_git_ok(cwd: &Path, args: &[&str]) -> String {
    run_git(cwd, args).unwrap_or_default()
}

fn run_git_capture(cwd: &Path, args: &[&str]) -> String {
    match output_with_timeout(git_command(cwd, args), CHILD_TIMEOUT) {
        Ok(output) => String::from_utf8_lossy(&output.stdout).into_owned(),
        Err(_) => String::new(),
    }
}

fn resolve_dir(cwd: &str) -> AppResult<PathBuf> {
    let raw = cwd.trim();
    if raw.is_empty() {
        return Err(AppError::InvalidRequest(
            "Empty working directory".to_string(),
        ));
    }
    let real = PathBuf::from(raw)
        .canonicalize()
        .map_err(|e| AppError::FileError(format!("Working directory not accessible: {e}")))?;
    if !real.is_dir() {
        return Err(AppError::FileError(
            "Working directory is not a directory".to_string(),
        ));
    }
    Ok(real)
}

fn is_inside_worktree(cwd: &Path) -> bool {
    run_git_ok(cwd, &["rev-parse", "--is-inside-work-tree"]).trim() == "true"
}

fn current_branch(cwd: &Path) -> Option<String> {
    let name = run_git_ok(cwd, &["rev-parse", "--abbrev-ref", "HEAD"])
        .trim()
        .to_string();
    if name.is_empty() || name == "HEAD" {
        None
    } else {
        Some(name)
    }
}

fn ensure_safe_ref(reference: &str) -> AppResult<()> {
    if reference.trim_start().starts_with('-') {
        return Err(AppError::InvalidRequest(format!(
            "非法 git 引用（不能以 '-' 开头）：{reference}"
        )));
    }
    Ok(())
}

// ── Parsing helpers ──────────────────────────────────────────────────────────

fn status_letter(x: char, y: char) -> String {
    if x == '?' || y == '?' {
        return "?".to_string();
    }
    let code = if x != ' ' { x } else { y };
    if code == ' ' {
        "M".to_string()
    } else {
        code.to_ascii_uppercase().to_string()
    }
}

fn is_staged(x: char) -> bool {
    x != ' ' && x != '?'
}

fn status_entries(cwd: &Path) -> Vec<(char, char, String)> {
    let raw = run_git_capture(cwd, &["status", "--porcelain=v1", "-z", "-uall"]);
    let mut fields = raw.split('\0');
    let mut entries = Vec::new();

    while let Some(field) = fields.next() {
        if field.len() < 3 {
            continue;
        }
        let mut chars = field.chars();
        let x = chars.next().unwrap_or(' ');
        let y = chars.next().unwrap_or(' ');
        let Some(path) = field.get(3..).map(str::to_string) else {
            continue;
        };
        let is_rename = matches!(x, 'R' | 'C') || matches!(y, 'R' | 'C');
        if is_rename {
            fields.next();
        }
        entries.push((x, y, path));
    }
    entries
}

fn numstat_map(cwd: &Path, args: &[&str]) -> HashMap<String, (u64, u64)> {
    let mut full = vec!["diff", "--numstat"];
    full.extend_from_slice(args);
    let out = run_git_ok(cwd, &full);

    let mut map = HashMap::new();
    for line in out.lines() {
        let mut parts = line.splitn(3, '\t');
        let added = parts.next().unwrap_or("");
        let removed = parts.next().unwrap_or("");
        let path = parts.next().unwrap_or("");
        if path.is_empty() {
            continue;
        }
        map.insert(
            path.to_string(),
            (
                added.parse::<u64>().unwrap_or(0),
                removed.parse::<u64>().unwrap_or(0),
            ),
        );
    }
    map
}

// ── Tauri commands ───────────────────────────────────────────────────────────

#[tauri::command]
pub async fn checkpoint_status(input: CheckpointStatusInput) -> AppResult<CheckpointStatusResult> {
    let cwd = resolve_dir(&input.cwd)?;
    if !is_inside_worktree(&cwd) {
        return Ok(CheckpointStatusResult {
            is_repo: false,
            branch: None,
            clean: true,
            files: Vec::new(),
        });
    }

    let staged = numstat_map(&cwd, &["--cached"]);
    let unstaged = numstat_map(&cwd, &[]);
    let entries = status_entries(&cwd);
    let files: Vec<CheckpointStatusFile> = entries
        .into_iter()
        .map(|(x, y, path)| {
            let _counts = if is_staged(x) {
                staged.get(&path).copied()
            } else {
                unstaged.get(&path).copied()
            }
            .unwrap_or((0, 0));
            CheckpointStatusFile {
                path,
                status: status_letter(x, y),
                staged: is_staged(x),
            }
        })
        .collect();

    Ok(CheckpointStatusResult {
        is_repo: true,
        branch: current_branch(&cwd),
        clean: files.is_empty(),
        files,
    })
}

#[tauri::command]
pub async fn checkpoint_diff(input: CheckpointDiffInput) -> AppResult<CheckpointDiffResult> {
    let cwd = resolve_dir(&input.cwd)?;
    if !is_inside_worktree(&cwd) {
        return Ok(CheckpointDiffResult {
            empty: true,
            stat: Vec::new(),
            diff: String::new(),
        });
    }

    let mut stat_args = vec!["--numstat"];
    if let Some(base_ref) = input.base_ref.as_deref() {
        ensure_safe_ref(base_ref)?;
        stat_args.push(base_ref);
    }
    let stat_out = run_git_ok(&cwd, &stat_args);
    let mut stat = Vec::new();
    for line in stat_out.lines() {
        let mut parts = line.splitn(3, '\t');
        let added = parts.next().unwrap_or("");
        let removed = parts.next().unwrap_or("");
        let path = parts.next().unwrap_or("");
        if path.is_empty() {
            continue;
        }
        stat.push(CheckpointDiffStat {
            path: path.to_string(),
            added: added.parse::<u64>().unwrap_or(0),
            removed: removed.parse::<u64>().unwrap_or(0),
            status: "M".to_string(),
        });
    }

    let diff_text = if input.stat_only {
        String::new()
    } else {
        let mut diff_args = vec!["diff", "--no-color"];
        if let Some(base_ref) = input.base_ref.as_deref() {
            diff_args.push(base_ref);
        }
        run_git_capture(&cwd, &diff_args)
    };

    Ok(CheckpointDiffResult {
        empty: stat.is_empty() && diff_text.trim().is_empty(),
        stat,
        diff: diff_text,
    })
}

#[tauri::command]
pub async fn checkpoint_snapshot(
    input: CheckpointSnapshotInput,
) -> AppResult<CheckpointSnapshotResult> {
    let cwd = resolve_dir(&input.cwd)?;
    if !is_inside_worktree(&cwd) {
        return Ok(CheckpointSnapshotResult {
            head: None,
            clean: true,
            message: "Not a git repository".to_string(),
        });
    }

    let head = run_git_ok(&cwd, &["rev-parse", "HEAD"]).trim().to_string();
    let head = if head.is_empty() { None } else { Some(head) };
    let clean = status_entries(&cwd).is_empty();
    let message = if clean {
        "Working tree clean".to_string()
    } else {
        "Working tree has uncommitted changes".to_string()
    };

    Ok(CheckpointSnapshotResult {
        head,
        clean,
        message,
    })
}

// ── Unit tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_status_letter() {
        assert_eq!(status_letter('M', ' '), "M");
        assert_eq!(status_letter(' ', 'M'), "M");
        assert_eq!(status_letter('?', '?'), "?");
        assert_eq!(status_letter(' ', ' '), "M");
    }

    #[test]
    fn test_is_staged() {
        assert!(is_staged('M'));
        assert!(!is_staged(' '));
        assert!(!is_staged('?'));
    }

    #[test]
    fn test_ensure_safe_ref_rejects_dash() {
        assert!(ensure_safe_ref("-bad").is_err());
        assert!(ensure_safe_ref("HEAD").is_ok());
        assert!(ensure_safe_ref("abc123").is_ok());
    }
}
