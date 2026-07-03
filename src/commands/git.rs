// Git ops backing the Codex-style review pane (issue #328).
//
// Faithful port of the Electron reference `apps/desktop/electron/git-review-ops.cjs`.
// The official desktop end shells the system `git`/`gh` binaries from its own
// backend (via `simple-git`) rather than forwarding to Python Core — so the
// equivalent Tauri implementation shells `git`/`gh` from the Rust backend too.
// We don't depend on `simple-git`, so the structured `status()`/`diffSummary()`
// results it returns are reproduced here by parsing porcelain / `--numstat`.
//
// Reads degrade to empty/None on a non-repo or missing tool (the pane then shows
// "not a repo" / "no changes" instead of erroring). Mutations propagate errors so
// the renderer can toast a friendly message.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

/// Cap the diff handed to commit-message generation so the payload stays bounded.
const COMMIT_CONTEXT_DIFF_MAX_CHARS: usize = 120_000;
/// Cap the untracked-file list appended to that diff.
const COMMIT_CONTEXT_UNTRACKED_MAX: usize = 80;
/// Skip line-counting an untracked file larger than this (matches upstream).
const UNTRACKED_LINE_COUNT_MAX_BYTES: u64 = 1024 * 1024;
/// Hard deadline for a git/gh subprocess — a hung child (credential prompt that
/// slipped through, network stall) is killed instead of wedging the pane.
const CHILD_TIMEOUT: Duration = Duration::from_secs(30);
/// `try_wait` polling interval while a child runs under the timeout.
const CHILD_POLL_INTERVAL: Duration = Duration::from_millis(100);

// ── IPC payloads ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewFile {
    pub path: String,
    pub added: u64,
    pub removed: u64,
    /// Single-letter git status (`M`/`A`/`D`/`R`/`?` …).
    pub status: String,
    pub staged: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewList {
    pub files: Vec<ReviewFile>,
    /// merge-base for `branch` scope, else null.
    pub base: Option<String>,
    /// Whether the path is inside a git work tree; the pane's "not a repo"
    /// empty state keys off this instead of guessing from an empty list.
    pub is_repo: bool,
}

#[derive(Debug, Serialize)]
pub struct OkFlag {
    pub ok: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitContext {
    pub diff: String,
    pub recent: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrInfo {
    pub url: String,
    pub state: String,
    pub number: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShipInfo {
    /// gh is installed AND authenticated (the PR action can run).
    pub gh_ready: bool,
    pub pr: Option<PrInfo>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatePrResult {
    pub url: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewListInput {
    pub repo_path: String,
    /// `"uncommitted"` (default) | `"branch"` | `"lastTurn"`.
    pub scope: String,
    #[serde(default)]
    pub base_ref: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewDiffInput {
    pub repo_path: String,
    pub file_path: String,
    pub scope: String,
    #[serde(default)]
    pub base_ref: Option<String>,
    #[serde(default)]
    pub staged: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewPathInput {
    pub repo_path: String,
    /// `null` → whole tree (stage/unstage/revert all).
    #[serde(default)]
    pub file_path: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewRevParseInput {
    pub repo_path: String,
    #[serde(default, rename = "ref")]
    pub reference: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewCommitInput {
    pub repo_path: String,
    pub message: String,
    #[serde(default)]
    pub push: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoPathInput {
    pub repo_path: String,
}

// ── Process helpers ──────────────────────────────────────────────────────────

/// GUI-launched apps inherit a minimal PATH (no `/opt/homebrew/bin` etc.), so
/// `git`/`gh` — and the `git` that `gh` shells to — may not be found. Prepend the
/// common package-manager bins so they run the same way they do in a terminal.
/// Mirrors the upstream `ghEnv` augmentation. Unix only; Windows keeps inherited
/// PATH (its separators/locations differ).
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

/// A `Command` rooted at `cwd` with PATH augmented and interactive prompts
/// disabled (`GIT_TERMINAL_PROMPT=0`), so a push that needs credentials fails
/// fast instead of hanging on a hidden prompt. `LC_ALL=C` pins the child's
/// locale: error-string matching and porcelain parsing must not depend on a
/// localized git (a Chinese git emits translated messages).
fn command(program: &str, cwd: &Path) -> Command {
    let mut cmd = Command::new(program);
    cmd.current_dir(cwd);
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    cmd.env("LC_ALL", "C");
    if let Some(path) = augmented_path() {
        cmd.env("PATH", path);
    }
    // The app is a windowed subsystem; without this every git/gh call flashes a
    // console window on Windows (same as process/dashboard.rs, process/gateway.rs).
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// The single entry for building `git` argv. `-c core.quotepath=false` keeps
/// non-ASCII paths raw in `--numstat`/diff output so they match the unquoted
/// paths from `status -z` (a quoted `"\344\270\255..."` row would never join).
fn git_command(cwd: &Path, args: &[&str]) -> Command {
    let mut cmd = command("git", cwd);
    cmd.args(["-c", "core.quotepath=false"]);
    cmd.args(args);
    cmd
}

/// `Command::output()` with a hard timeout. Spawns with piped stdio, drains
/// stdout/stderr on background threads (draining inline would deadlock once a
/// pipe fills), and polls `try_wait` until `timeout`, then kills the child and
/// reports `ErrorKind::TimedOut`. The synchronous API has no native timeout.
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
            let _ = child.wait(); // reap; closes the pipes so the readers finish
            let _ = stdout.join();
            let _ = stderr.join();
            return Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "命令执行超时，已终止",
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

/// Run `git` and require success — stdout on exit 0, else `AppError::Git(stderr)`.
/// Used by mutations.
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

/// Run `git` for a read: stdout on success, `""` on any failure. Lets reads
/// degrade silently on a non-repo / missing ref.
fn run_git_ok(cwd: &Path, args: &[&str]) -> String {
    run_git(cwd, args).unwrap_or_default()
}

/// Run `git` and return stdout regardless of exit code (`git diff --no-index`
/// exits non-zero by design when files differ, yet still emits the diff).
fn run_git_capture(cwd: &Path, args: &[&str]) -> String {
    match output_with_timeout(git_command(cwd, args), CHILD_TIMEOUT) {
        Ok(output) => String::from_utf8_lossy(&output.stdout).into_owned(),
        Err(_) => String::new(),
    }
}

/// Run the `gh` CLI. Returns `(ok, stdout)` so callers branch on
/// availability/auth without a throw. gh missing/unauthed/hung → `(false, "")`.
fn run_gh(cwd: &Path, args: &[&str]) -> (bool, String) {
    let mut cmd = command("gh", cwd);
    cmd.args(args);
    match output_with_timeout(cmd, CHILD_TIMEOUT) {
        Ok(output) => (
            output.status.success(),
            String::from_utf8_lossy(&output.stdout).into_owned(),
        ),
        Err(_) => (false, String::new()),
    }
}

/// Validate the repo path: canonicalize and require an existing directory.
/// Reads catch the error and fall soft; mutations propagate it.
fn resolve_repo_dir(repo_path: &str) -> AppResult<PathBuf> {
    let raw = repo_path.trim();
    if raw.is_empty() {
        return Err(AppError::InvalidRequest("Empty repo path".to_string()));
    }
    let real = PathBuf::from(raw)
        .canonicalize()
        .map_err(|e| AppError::FileError(format!("Repo path not accessible: {e}")))?;
    if !real.is_dir() {
        return Err(AppError::FileError(
            "Repo path is not a directory".to_string(),
        ));
    }
    Ok(real)
}

/// Renderer-supplied refs get spliced into argv before `--`; reject anything
/// that would parse as an option so `-...` can't smuggle git flags.
fn ensure_safe_ref(reference: &str) -> AppResult<()> {
    if reference.trim_start().starts_with('-') {
        return Err(AppError::InvalidRequest(format!(
            "非法 git 引用（不能以 '-' 开头）：{reference}"
        )));
    }
    Ok(())
}

// ── Parsing helpers ──────────────────────────────────────────────────────────

/// `git` reports renames as `old => new` (and the `dir/{old => new}/f` brace
/// form in `--numstat`, or `old -> new` in porcelain); resolve to the NEW path so
/// a row addresses the real file for diff/stage. Mirrors `resolveRenamePath`.
fn resolve_rename_path(raw: &str) -> String {
    let path = raw.trim();

    // Brace form from `--numstat`: `dir/{old => new}/file`.
    if let (Some(open), Some(close)) = (path.find('{'), path.find('}')) {
        if open < close {
            let inner = &path[open + 1..close];
            if let Some(arrow) = inner.find(" => ") {
                let to = &inner[arrow + 4..];
                let combined = format!("{}{}{}", &path[..open], to, &path[close + 1..]);
                return collapse_slashes(&combined);
            }
        }
    }

    for sep in [" -> ", " => "] {
        if let Some(idx) = path.rfind(sep) {
            return path[idx + sep.len()..].trim().to_string();
        }
    }

    path.to_string()
}

fn collapse_slashes(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    let mut prev_slash = false;
    for ch in path.chars() {
        if ch == '/' {
            if !prev_slash {
                out.push(ch);
            }
            prev_slash = true;
        } else {
            out.push(ch);
            prev_slash = false;
        }
    }
    out
}

/// A status file's single-letter classification, preferring the staged (index)
/// code over the worktree code; untracked wins. Mirrors `statusLetter`.
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

/// Index (staged) side is set and not untracked. Mirrors `isStaged`.
fn is_staged(x: char) -> bool {
    x != ' ' && x != '?'
}

/// Parse `git status --porcelain=v1 -z` into `(index, worktree, new_path)` rows.
/// The `-z` format avoids path quoting and puts the rename's NEW path in the
/// record itself (the following NUL field is the old path, which we skip).
/// `-uall` expands untracked directories into individual files instead of a
/// single collapsed `dir/` row.
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
        // `get` (not slicing) so a multibyte char straddling index 3 can't panic.
        let Some(path) = field.get(3..).map(str::to_string) else {
            continue;
        };
        let is_rename = matches!(x, 'R' | 'C') || matches!(y, 'R' | 'C');
        if is_rename {
            // The next NUL field is the rename's original path; consume it.
            fields.next();
        }
        entries.push((x, y, path));
    }

    entries
}

/// Untracked paths from a status scan (`??` rows).
fn untracked_paths(cwd: &Path) -> Vec<String> {
    status_entries(cwd)
        .into_iter()
        .filter(|(x, y, _)| *x == '?' || *y == '?')
        .map(|(_, _, path)| path)
        .collect()
}

/// `git diff --numstat <args>` → `path → (added, removed)`. Binary files report
/// `-`, parsed as 0.
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
            resolve_rename_path(path),
            (
                added.parse::<u64>().unwrap_or(0),
                removed.parse::<u64>().unwrap_or(0),
            ),
        );
    }
    map
}

/// Untracked files carry no `--numstat`; count insertions from disk so the tree
/// can show +N for a new file. Insertions = newline count, plus one for a final
/// unterminated line. Binary (NUL byte) or oversized → 0. Mirrors
/// `untrackedInsertions`.
fn untracked_insertions(cwd: &Path, rel_path: &str) -> u64 {
    let full = cwd.join(rel_path);
    let Ok(meta) = fs::metadata(&full) else {
        return 0;
    };
    if !meta.is_file() || meta.len() > UNTRACKED_LINE_COUNT_MAX_BYTES {
        return 0;
    }
    let Ok(bytes) = fs::read(&full) else {
        return 0;
    };
    if bytes.contains(&0) {
        return 0;
    }
    let newlines = bytes.iter().filter(|&&b| b == b'\n').count() as u64;
    if !bytes.is_empty() && *bytes.last().unwrap() != b'\n' {
        newlines + 1
    } else {
        newlines
    }
}

/// Fill in +N insertions for untracked files (status `?`, no counts yet).
fn fill_untracked_counts(cwd: &Path, files: &mut [ReviewFile]) {
    for file in files.iter_mut() {
        if file.status == "?" && file.added == 0 && file.removed == 0 {
            file.added = untracked_insertions(cwd, &file.path);
        }
    }
}

fn cap_text(text: &str, max_chars: usize, label: &str) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    let kept: String = text.chars().take(max_chars).collect();
    let omitted = text.chars().count() - max_chars;
    format!("{kept}\n# {label}: {omitted} chars omitted\n")
}

/// Resolve the base ref for "all branch changes": merge-base with the remote
/// default branch, falling back to common trunk names. Mirrors `branchBase`.
fn branch_base(cwd: &Path) -> Option<String> {
    let mut candidates = Vec::new();
    let head = run_git_ok(cwd, &["rev-parse", "--abbrev-ref", "origin/HEAD"])
        .trim()
        .to_string();
    if !head.is_empty() {
        candidates.push(head);
    }
    for trunk in ["origin/main", "origin/master", "main", "master"] {
        candidates.push(trunk.to_string());
    }

    for reference in candidates {
        let base = run_git_ok(cwd, &["merge-base", "HEAD", &reference])
            .trim()
            .to_string();
        if !base.is_empty() {
            return Some(base);
        }
    }
    None
}

/// Current branch name, or None when detached / no commits.
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

/// Whether the current branch has an upstream configured.
fn has_upstream(cwd: &Path) -> bool {
    run_git(
        cwd,
        &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    )
    .is_ok()
}

/// Count of staged files (index has entries vs HEAD).
fn staged_count(cwd: &Path) -> usize {
    run_git_ok(cwd, &["diff", "--cached", "--name-only"])
        .lines()
        .filter(|l| !l.trim().is_empty())
        .count()
}

/// Push the current branch, setting upstream on the first push. Mirrors the
/// `reviewPush` / `reviewCommit` push tail.
fn push_current(cwd: &Path) -> AppResult<()> {
    if has_upstream(cwd) {
        run_git(cwd, &["push"])?;
    } else if let Some(branch) = current_branch(cwd) {
        run_git(cwd, &["push", "-u", "origin", &branch])?;
    }
    Ok(())
}

// ── Core review ops (AppHandle-free, unit-testable) ──────────────────────────

fn review_list_impl(repo_path: &str, scope: &str, base_ref: Option<&str>) -> ReviewList {
    let empty = |is_repo: bool| ReviewList {
        files: Vec::new(),
        base: None,
        is_repo,
    };

    let Ok(cwd) = resolve_repo_dir(repo_path) else {
        return empty(false);
    };

    // Distinguish "not a repo" from "clean repo" so the pane's empty state is
    // honest (the frontend renders "不是 git 仓库" only when this is false).
    if run_git_ok(&cwd, &["rev-parse", "--is-inside-work-tree"]).trim() != "true" {
        return empty(false);
    }

    if scope == "branch" || scope == "lastTurn" {
        let base = if scope == "branch" {
            branch_base(&cwd)
        } else {
            base_ref.map(|s| s.to_string())
        };
        let Some(base) = base else {
            return empty(true);
        };

        let range = if scope == "branch" {
            format!("{base}...HEAD")
        } else {
            base.clone()
        };

        let counts = numstat_map(&cwd, &[&range]);
        let mut files: Vec<ReviewFile> = counts
            .into_iter()
            .map(|(path, (added, removed))| ReviewFile {
                path,
                added,
                removed,
                status: "M".to_string(),
                staged: false,
            })
            .collect();

        // "Last turn" also surfaces files created since the baseline (untracked).
        if scope == "lastTurn" {
            for path in untracked_paths(&cwd) {
                if !files.iter().any(|f| f.path == path) {
                    files.push(ReviewFile {
                        path,
                        added: 0,
                        removed: 0,
                        status: "?".to_string(),
                        staged: false,
                    });
                }
            }
        }

        files.sort_by(|a, b| a.path.cmp(&b.path));
        fill_untracked_counts(&cwd, &mut files);
        return ReviewList {
            files,
            base: Some(base),
            is_repo: true,
        };
    }

    // Default: uncommitted (staged + unstaged + untracked), one row per path.
    let staged = numstat_map(&cwd, &["--cached"]);
    let unstaged = numstat_map(&cwd, &[]);

    let mut files: Vec<ReviewFile> = status_entries(&cwd)
        .into_iter()
        .map(|(x, y, raw)| {
            let path = resolve_rename_path(&raw);
            let sc = staged.get(&path).copied().unwrap_or((0, 0));
            let uc = unstaged.get(&path).copied().unwrap_or((0, 0));
            ReviewFile {
                added: sc.0 + uc.0,
                removed: sc.1 + uc.1,
                status: status_letter(x, y),
                staged: is_staged(x),
                path,
            }
        })
        .collect();

    files.sort_by(|a, b| a.path.cmp(&b.path));
    fill_untracked_counts(&cwd, &mut files);
    ReviewList {
        files,
        base: None,
        is_repo: true,
    }
}

fn review_diff_impl(
    repo_path: &str,
    file_path: &str,
    scope: &str,
    base_ref: Option<&str>,
    staged: bool,
) -> String {
    let Ok(cwd) = resolve_repo_dir(repo_path) else {
        return String::new();
    };

    if scope == "branch" {
        return match branch_base(&cwd) {
            Some(base) => run_git_ok(&cwd, &["diff", &format!("{base}...HEAD"), "--", file_path]),
            None => String::new(),
        };
    }

    if scope == "lastTurn" {
        return match base_ref {
            Some(base) => run_git_ok(&cwd, &["diff", base, "--", file_path]),
            None => String::new(),
        };
    }

    if staged {
        return run_git_ok(&cwd, &["diff", "--cached", "--", file_path]);
    }

    let worktree = run_git_ok(&cwd, &["diff", "--", file_path]);
    if !worktree.trim().is_empty() {
        return worktree;
    }

    // Untracked file: synthesize an all-add diff via --no-index (exits non-zero
    // by design when files differ, so capture stdout regardless).
    run_git_capture(&cwd, &["diff", "--no-index", "--", "/dev/null", file_path])
}

fn commit_context_impl(repo_path: &str) -> CommitContext {
    let Ok(cwd) = resolve_repo_dir(repo_path) else {
        return CommitContext {
            diff: String::new(),
            recent: String::new(),
        };
    };

    // What will land: staged changes if any, otherwise all tracked changes vs HEAD.
    let raw_diff = if staged_count(&cwd) > 0 {
        run_git_ok(&cwd, &["diff", "--cached"])
    } else {
        run_git_ok(&cwd, &["diff", "HEAD"])
    };
    let mut diff = cap_text(
        &raw_diff,
        COMMIT_CONTEXT_DIFF_MAX_CHARS,
        "diff truncated for commit-message generation",
    );

    // Untracked files have no diff — list them so new files aren't invisible.
    let untracked = untracked_paths(&cwd);
    if !untracked.is_empty() {
        let visible = untracked
            .iter()
            .take(COMMIT_CONTEXT_UNTRACKED_MAX)
            .map(|p| format!("#   {p}"))
            .collect::<Vec<_>>()
            .join("\n");
        let omitted = untracked.len().saturating_sub(COMMIT_CONTEXT_UNTRACKED_MAX);
        let mut note = format!("\n# New (untracked) files:\n{visible}\n");
        if omitted > 0 {
            note.push_str(&format!("#   ... {omitted} more omitted\n"));
        }
        diff = if diff.is_empty() {
            note
        } else {
            format!("{diff}{note}")
        };
    }

    let recent = run_git_ok(&cwd, &["log", "-n", "10", "--pretty=format:%s"])
        .trim()
        .to_string();

    CommitContext { diff, recent }
}

fn ship_info_impl(repo_path: &str) -> ShipInfo {
    let Ok(cwd) = resolve_repo_dir(repo_path) else {
        return ShipInfo {
            gh_ready: false,
            pr: None,
        };
    };

    let (auth_ok, _) = run_gh(&cwd, &["auth", "status"]);
    if !auth_ok {
        return ShipInfo {
            gh_ready: false,
            pr: None,
        };
    }

    let (view_ok, stdout) = run_gh(&cwd, &["pr", "view", "--json", "url,state,number"]);
    if !view_ok {
        // gh exits non-zero when no PR exists for the branch — that's not an error.
        return ShipInfo {
            gh_ready: true,
            pr: None,
        };
    }

    let pr = serde_json::from_str::<serde_json::Value>(&stdout)
        .ok()
        .and_then(|value| {
            let url = value.get("url")?.as_str()?.to_string();
            if url.is_empty() {
                return None;
            }
            Some(PrInfo {
                url,
                state: value
                    .get("state")
                    .and_then(|s| s.as_str())
                    .unwrap_or("")
                    .to_string(),
                number: value.get("number").and_then(|n| n.as_i64()).unwrap_or(0),
            })
        });

    ShipInfo { gh_ready: true, pr }
}

fn review_stage_impl(repo_path: &str, file_path: Option<&str>) -> AppResult<OkFlag> {
    let cwd = resolve_repo_dir(repo_path)?;
    match file_path {
        Some(path) => run_git(&cwd, &["add", "--", path])?,
        None => run_git(&cwd, &["add", "-A"])?,
    };
    Ok(OkFlag { ok: true })
}

fn review_unstage_impl(repo_path: &str, file_path: Option<&str>) -> AppResult<OkFlag> {
    let cwd = resolve_repo_dir(repo_path)?;
    match file_path {
        Some(path) => run_git(&cwd, &["reset", "-q", "HEAD", "--", path])?,
        None => run_git(&cwd, &["reset", "-q", "HEAD"])?,
    };
    Ok(OkFlag { ok: true })
}

fn review_revert_impl(repo_path: &str, file_path: Option<&str>) -> AppResult<OkFlag> {
    let cwd = resolve_repo_dir(repo_path)?;
    // Destructive: restore tracked files and remove untracked ones. Errors are
    // swallowed (mirrors the upstream `.catch`) so a partial revert still runs.
    match file_path {
        Some(path) => {
            let _ = run_git(&cwd, &["checkout", "HEAD", "--", path]);
            let _ = run_git(&cwd, &["clean", "-fd", "--", path]);
        }
        None => {
            let _ = run_git(&cwd, &["checkout", "HEAD", "--", "."]);
            let _ = run_git(&cwd, &["clean", "-fd"]);
        }
    }
    Ok(OkFlag { ok: true })
}

fn review_rev_parse_impl(repo_path: &str, reference: Option<&str>) -> AppResult<Option<String>> {
    let reference = reference.unwrap_or("HEAD");
    ensure_safe_ref(reference)?;
    let Ok(cwd) = resolve_repo_dir(repo_path) else {
        return Ok(None);
    };
    let sha = run_git(&cwd, &["rev-parse", reference])
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    Ok(if sha.is_empty() { None } else { Some(sha) })
}

fn review_commit_impl(repo_path: &str, message: &str, push: bool) -> AppResult<OkFlag> {
    let cwd = resolve_repo_dir(repo_path)?;
    // Mirror VS Code: nothing staged → "commit all" (stage everything first).
    if staged_count(&cwd) == 0 {
        run_git(&cwd, &["add", "-A"])?;
    }
    run_git(&cwd, &["commit", "-m", message])?;
    if push {
        push_current(&cwd)?;
    }
    Ok(OkFlag { ok: true })
}

// ── Tauri commands ───────────────────────────────────────────────────────────
//
// All async: Tauri v2 runs async commands on its runtime thread pool, so the
// blocking subprocess work below never stalls the main (UI) thread.

#[tauri::command]
pub async fn git_review_list(input: ReviewListInput) -> AppResult<ReviewList> {
    if let Some(reference) = input.base_ref.as_deref() {
        ensure_safe_ref(reference)?;
    }
    Ok(review_list_impl(
        &input.repo_path,
        &input.scope,
        input.base_ref.as_deref(),
    ))
}

#[tauri::command]
pub async fn git_review_diff(input: ReviewDiffInput) -> AppResult<String> {
    if let Some(reference) = input.base_ref.as_deref() {
        ensure_safe_ref(reference)?;
    }
    Ok(review_diff_impl(
        &input.repo_path,
        &input.file_path,
        &input.scope,
        input.base_ref.as_deref(),
        input.staged,
    ))
}

#[tauri::command]
pub async fn git_review_stage(input: ReviewPathInput) -> AppResult<OkFlag> {
    review_stage_impl(&input.repo_path, input.file_path.as_deref())
}

#[tauri::command]
pub async fn git_review_unstage(input: ReviewPathInput) -> AppResult<OkFlag> {
    review_unstage_impl(&input.repo_path, input.file_path.as_deref())
}

#[tauri::command]
pub async fn git_review_revert(input: ReviewPathInput) -> AppResult<OkFlag> {
    review_revert_impl(&input.repo_path, input.file_path.as_deref())
}

#[tauri::command]
pub async fn git_review_rev_parse(input: ReviewRevParseInput) -> AppResult<Option<String>> {
    review_rev_parse_impl(&input.repo_path, input.reference.as_deref())
}

#[tauri::command]
pub async fn git_review_commit(input: ReviewCommitInput) -> AppResult<OkFlag> {
    review_commit_impl(&input.repo_path, &input.message, input.push)
}

#[tauri::command]
pub async fn git_review_commit_context(input: RepoPathInput) -> AppResult<CommitContext> {
    Ok(commit_context_impl(&input.repo_path))
}

#[tauri::command]
pub async fn git_review_push(input: RepoPathInput) -> AppResult<OkFlag> {
    let cwd = resolve_repo_dir(&input.repo_path)?;
    push_current(&cwd)?;
    Ok(OkFlag { ok: true })
}

#[tauri::command]
pub async fn git_review_ship_info(input: RepoPathInput) -> AppResult<ShipInfo> {
    Ok(ship_info_impl(&input.repo_path))
}

#[tauri::command]
pub async fn git_review_create_pr(input: RepoPathInput) -> AppResult<CreatePrResult> {
    let cwd = resolve_repo_dir(&input.repo_path)?;
    // Push first so gh has a remote ref (best-effort, like upstream).
    let _ = push_current(&cwd);
    let (ok, stdout) = run_gh(&cwd, &["pr", "create", "--fill"]);
    if !ok {
        return Err(AppError::Git(
            "gh pr create failed (is gh installed and authenticated?)".to_string(),
        ));
    }
    let url = stdout
        .trim()
        .lines()
        .rfind(|l| !l.trim().is_empty())
        .unwrap_or("")
        .to_string();
    Ok(CreatePrResult { url })
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    fn git(dir: &Path, args: &[&str]) {
        let out = command("git", dir).args(args).output().unwrap();
        assert!(
            out.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    /// A throwaway repo with one committed file and deterministic identity/config
    /// (no dependence on the host's global git config).
    fn init_repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path();
        git(path, &["init", "-q", "-b", "main"]);
        git(path, &["config", "user.email", "test@example.com"]);
        git(path, &["config", "user.name", "Test"]);
        git(path, &["config", "commit.gpgsign", "false"]);
        fs::write(path.join("README.md"), "hello\n").unwrap();
        git(path, &["add", "-A"]);
        git(path, &["commit", "-q", "-m", "init"]);
        dir
    }

    #[test]
    fn resolve_rename_path_handles_arrow_and_brace_forms() {
        assert_eq!(resolve_rename_path("plain.rs"), "plain.rs");
        assert_eq!(resolve_rename_path("old.rs -> new.rs"), "new.rs");
        assert_eq!(resolve_rename_path("old.rs => new.rs"), "new.rs");
        assert_eq!(resolve_rename_path("src/{old => new}/f.rs"), "src/new/f.rs");
        assert_eq!(resolve_rename_path("{a => b}"), "b");
    }

    #[test]
    fn status_letter_prefers_index_and_marks_untracked() {
        assert_eq!(status_letter('M', ' '), "M");
        assert_eq!(status_letter(' ', 'M'), "M");
        assert_eq!(status_letter('A', 'M'), "A");
        assert_eq!(status_letter('?', '?'), "?");
        assert_eq!(status_letter('D', ' '), "D");
    }

    #[test]
    fn is_staged_reads_index_column() {
        assert!(is_staged('M'));
        assert!(is_staged('A'));
        assert!(!is_staged(' '));
        assert!(!is_staged('?'));
    }

    #[test]
    fn cap_text_truncates_with_a_note() {
        assert_eq!(cap_text("short", 100, "x"), "short");
        let capped = cap_text("abcdefgh", 4, "trimmed");
        assert!(capped.starts_with("abcd"));
        assert!(capped.contains("trimmed"));
        assert!(capped.contains("4 chars omitted"));
    }

    #[test]
    fn untracked_insertions_counts_lines_and_skips_binary() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("two.txt"), "a\nb\n").unwrap();
        fs::write(dir.path().join("noeol.txt"), "a\nb").unwrap();
        fs::write(dir.path().join("blob.bin"), [1u8, 0, 2, 3]).unwrap();

        assert_eq!(untracked_insertions(dir.path(), "two.txt"), 2);
        assert_eq!(untracked_insertions(dir.path(), "noeol.txt"), 2);
        assert_eq!(untracked_insertions(dir.path(), "blob.bin"), 0);
        assert_eq!(untracked_insertions(dir.path(), "missing.txt"), 0);
    }

    #[test]
    fn review_list_reports_modified_staged_and_untracked() {
        let dir = init_repo();
        let path = dir.path();
        // Modify a tracked file (unstaged), stage a new file, and leave one untracked.
        fs::write(path.join("README.md"), "hello\nworld\n").unwrap();
        fs::write(path.join("staged.txt"), "one\ntwo\n").unwrap();
        git(path, &["add", "staged.txt"]);
        fs::write(path.join("untracked.txt"), "x\ny\nz\n").unwrap();

        let list = review_list_impl(&path.to_string_lossy(), "uncommitted", None);
        let by_path: HashMap<_, _> = list.files.iter().map(|f| (f.path.as_str(), f)).collect();

        assert_eq!(list.base, None);
        assert!(list.is_repo);
        let readme = by_path.get("README.md").expect("README.md present");
        assert_eq!(readme.status, "M");
        assert!(!readme.staged);
        assert_eq!(readme.added, 1);

        let staged = by_path.get("staged.txt").expect("staged.txt present");
        assert!(staged.staged);
        assert_eq!(staged.status, "A");

        let untracked = by_path.get("untracked.txt").expect("untracked.txt present");
        assert_eq!(untracked.status, "?");
        assert!(!untracked.staged);
        assert_eq!(untracked.added, 3, "untracked insertions counted from disk");

        // Sorted by path.
        let paths: Vec<_> = list.files.iter().map(|f| f.path.clone()).collect();
        let mut sorted = paths.clone();
        sorted.sort();
        assert_eq!(paths, sorted);
    }

    #[test]
    fn stage_unstage_roundtrip_flips_staged_flag() {
        let dir = init_repo();
        let repo = dir.path().to_string_lossy().to_string();
        fs::write(dir.path().join("README.md"), "hello\nchanged\n").unwrap();

        review_stage_impl(&repo, Some("README.md")).unwrap();
        let staged = review_list_impl(&repo, "uncommitted", None);
        assert!(staged
            .files
            .iter()
            .any(|f| f.path == "README.md" && f.staged));

        review_unstage_impl(&repo, Some("README.md")).unwrap();
        let unstaged = review_list_impl(&repo, "uncommitted", None);
        assert!(unstaged
            .files
            .iter()
            .any(|f| f.path == "README.md" && !f.staged));
    }

    #[test]
    fn commit_clears_the_change_list() {
        let dir = init_repo();
        let repo = dir.path().to_string_lossy().to_string();
        fs::write(dir.path().join("README.md"), "hello\nmore\n").unwrap();

        review_commit_impl(&repo, "docs: 更新 README", false).unwrap();

        let list = review_list_impl(&repo, "uncommitted", None);
        assert!(list.files.is_empty(), "tree is clean after commit");
        // The commit subject shows up in the commit context's recent log.
        let ctx = commit_context_impl(&repo);
        assert!(ctx.recent.contains("更新 README"));
    }

    #[test]
    fn review_diff_shows_worktree_change_and_untracked_all_add() {
        let dir = init_repo();
        let repo = dir.path().to_string_lossy().to_string();
        fs::write(dir.path().join("README.md"), "hello\nplus\n").unwrap();
        fs::write(dir.path().join("new.txt"), "brand\nnew\n").unwrap();

        let tracked = review_diff_impl(&repo, "README.md", "uncommitted", None, false);
        assert!(tracked.contains("+plus"), "worktree diff: {tracked}");

        let untracked = review_diff_impl(&repo, "new.txt", "uncommitted", None, false);
        assert!(untracked.contains("+brand"), "all-add diff: {untracked}");
        assert!(untracked.contains("+new"));
    }

    #[test]
    fn revert_restores_tracked_and_removes_untracked() {
        let dir = init_repo();
        let repo = dir.path().to_string_lossy().to_string();
        fs::write(dir.path().join("README.md"), "hello\nedited\n").unwrap();
        fs::write(dir.path().join("scratch.txt"), "temp\n").unwrap();

        review_revert_impl(&repo, None).unwrap();

        assert_eq!(
            fs::read_to_string(dir.path().join("README.md")).unwrap(),
            "hello\n",
            "tracked file restored to HEAD"
        );
        assert!(
            !dir.path().join("scratch.txt").exists(),
            "untracked file removed"
        );
    }

    #[test]
    fn read_ops_degrade_on_non_repo() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().to_string_lossy().to_string();
        let list = review_list_impl(&repo, "uncommitted", None);
        assert!(list.files.is_empty());
        assert!(!list.is_repo, "non-repo dir is flagged");
        assert_eq!(commit_context_impl(&repo).diff, "");
        assert!(review_diff_impl(&repo, "x", "uncommitted", None, false).is_empty());
    }

    #[test]
    fn rev_parse_resolves_head_and_returns_none_off_repo() {
        let dir = init_repo();
        let head = review_rev_parse_impl(&dir.path().to_string_lossy(), None).unwrap();
        assert!(head.is_some());
        assert_eq!(head.unwrap().len(), 40, "full sha");

        let off_repo = tempfile::tempdir().unwrap();
        let none = review_rev_parse_impl(&off_repo.path().to_string_lossy(), None).unwrap();
        assert!(none.is_none());
    }

    #[test]
    fn option_like_refs_are_rejected() {
        assert!(ensure_safe_ref("main").is_ok());
        assert!(ensure_safe_ref("origin/HEAD").is_ok());
        assert!(ensure_safe_ref("--upload-pack=evil").is_err());
        assert!(ensure_safe_ref("-x").is_err());
        assert!(ensure_safe_ref("  --flag").is_err());

        // The rev-parse command path refuses before touching git.
        let dir = init_repo();
        let err = review_rev_parse_impl(&dir.path().to_string_lossy(), Some("--verify"));
        assert!(err.is_err(), "option-like ref must be rejected");
    }

    #[test]
    fn status_expands_untracked_directories() {
        let dir = init_repo();
        let path = dir.path();
        fs::create_dir_all(path.join("newdir/sub")).unwrap();
        fs::write(path.join("newdir/sub/a.txt"), "x\n").unwrap();
        fs::write(path.join("newdir/b.txt"), "y\ny\n").unwrap();

        let list = review_list_impl(&path.to_string_lossy(), "uncommitted", None);
        let paths: Vec<_> = list.files.iter().map(|f| f.path.as_str()).collect();
        assert!(paths.contains(&"newdir/sub/a.txt"), "got {paths:?}");
        assert!(paths.contains(&"newdir/b.txt"), "got {paths:?}");
        assert!(
            !paths.contains(&"newdir/"),
            "no collapsed dir row: {paths:?}"
        );
    }

    #[test]
    fn numstat_counts_join_non_ascii_paths() {
        let dir = init_repo();
        let path = dir.path();
        // Committed file with a non-ASCII name; without `-c core.quotepath=false`
        // numstat quotes it (`"\344\270\255..."`) and never joins the status row.
        fs::write(path.join("中文 文件.txt"), "一\n").unwrap();
        git(path, &["add", "-A"]);
        git(path, &["commit", "-q", "-m", "add non-ascii"]);
        fs::write(path.join("中文 文件.txt"), "一\n二\n").unwrap();

        let list = review_list_impl(&path.to_string_lossy(), "uncommitted", None);
        let file = list
            .files
            .iter()
            .find(|f| f.path == "中文 文件.txt")
            .expect("row keeps the raw path");
        assert_eq!(file.added, 1, "numstat counts joined onto the status row");
        assert_eq!(file.status, "M");
    }

    #[cfg(unix)]
    #[test]
    fn output_with_timeout_kills_a_hung_child() {
        let mut cmd = Command::new("sleep");
        cmd.arg("30");
        let started = Instant::now();
        let err = output_with_timeout(cmd, Duration::from_millis(300)).unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::TimedOut);
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "child was killed at the deadline instead of running out the clock"
        );
    }

    #[test]
    fn output_with_timeout_collects_output_on_normal_exit() {
        let dir = init_repo();
        let out = output_with_timeout(
            git_command(dir.path(), &["rev-parse", "--is-inside-work-tree"]),
            CHILD_TIMEOUT,
        )
        .unwrap();
        assert!(out.status.success());
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "true");
    }
}
