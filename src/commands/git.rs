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

// ── Worktree / branch / status ops (issue #327) ──────────────────────────────
//
// Faithful port of the Electron reference `apps/desktop/electron/git-worktree-ops.cjs`:
// list real worktrees, spin up a fresh one the lightest way (`git worktree add
// -b`), remove them, list branches for the "convert a branch into a worktree"
// picker, switch branch, and a compact repo status. Git is the source of truth.

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Worktree {
    pub path: String,
    pub branch: Option<String>,
    pub is_main: bool,
    pub detached: bool,
    pub locked: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeAddResult {
    pub path: String,
    pub branch: String,
    pub repo_root: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeRemoveResult {
    pub removed: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Branch {
    pub name: String,
    pub checked_out: bool,
    pub is_default: bool,
    pub worktree_path: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchSwitchResult {
    pub branch: String,
}

/// Compact working-tree status for the projects sidebar. A leaner subset of the
/// upstream `repoStatus` (no per-file list — the worktree UI only needs the
/// branch line + counts).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoStatus {
    pub branch: Option<String>,
    pub default_branch: Option<String>,
    pub detached: bool,
    pub ahead: u64,
    pub behind: u64,
    pub staged: u64,
    pub unstaged: u64,
    pub untracked: u64,
    pub conflicted: u64,
    pub changed: u64,
    pub added: u64,
    pub removed: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeAddInput {
    pub repo_path: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub branch: Option<String>,
    #[serde(default)]
    pub base: Option<String>,
    /// When set, check this existing branch out into a worktree instead of
    /// creating a new branch.
    #[serde(default)]
    pub existing_branch: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeRemoveInput {
    pub repo_path: String,
    pub worktree_path: String,
    #[serde(default)]
    pub force: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchSwitchInput {
    pub repo_path: String,
    pub branch: String,
}

const TRUNK_BRANCHES: [&str; 2] = ["main", "master"];

/// Collapse runs of `ch` into a single occurrence.
fn collapse_char(input: &str, ch: char) -> String {
    let mut out = String::with_capacity(input.len());
    let mut prev = false;
    for c in input.chars() {
        if c == ch {
            if !prev {
                out.push(c);
            }
            prev = true;
        } else {
            out.push(c);
            prev = false;
        }
    }
    out
}

/// A git-ref-safe branch name (spaces → "-", drop forbidden chars, collapse
/// repeats, trim edges), or "" when nothing usable remains. Mirrors the upstream
/// `sanitizeBranch` so a bad value can't reach `git`.
fn sanitize_branch(name: &str) -> String {
    let spaced: String = name
        .chars()
        .map(|c| if c.is_whitespace() { '-' } else { c })
        .collect();
    let kept: String = spaced
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '/' | '-'))
        .collect();
    let collapsed = collapse_char(&collapse_char(&collapse_char(&kept, '-'), '/'), '.');
    collapsed
        .trim_matches(|c| matches!(c, '-' | '.' | '/'))
        .to_string()
}

/// A lowercase, hyphenated slug (≤40 chars) for a worktree dir name. Mirrors the
/// upstream `slugify`; empty input → "work".
fn slugify(name: &str) -> String {
    let mut out = String::new();
    let mut prev_dash = false;
    for c in name.trim().to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
            prev_dash = false;
        } else if !prev_dash {
            out.push('-');
            prev_dash = true;
        }
    }
    let trimmed = out.trim_matches('-');
    let capped: String = trimmed.chars().take(40).collect();
    let slug = capped.trim_end_matches('-').to_string();
    if slug.is_empty() {
        "work".to_string()
    } else {
        slug
    }
}

/// Parse `git worktree list --porcelain` into `(path, branch, detached, locked)`.
/// The first record is the main worktree.
fn parse_worktrees(out: &str) -> Vec<(String, Option<String>, bool, bool)> {
    let mut trees = Vec::new();
    let mut cur: Option<(String, Option<String>, bool, bool)> = None;

    for line in out.lines() {
        if let Some(rest) = line.strip_prefix("worktree ") {
            if let Some(done) = cur.take() {
                trees.push(done);
            }
            cur = Some((rest.trim().to_string(), None, false, false));
        } else if let Some(entry) = cur.as_mut() {
            if let Some(branch) = line.strip_prefix("branch ") {
                entry.1 = Some(
                    branch
                        .trim()
                        .strip_prefix("refs/heads/")
                        .unwrap_or(branch.trim())
                        .to_string(),
                );
            } else if line == "detached" {
                entry.2 = true;
            } else if line.starts_with("locked") {
                entry.3 = true;
            }
        }
    }

    if let Some(done) = cur {
        trees.push(done);
    }
    trees
}

fn list_worktrees_impl(cwd: &Path) -> Vec<Worktree> {
    let out = run_git_ok(cwd, &["worktree", "list", "--porcelain"]);
    parse_worktrees(&out)
        .into_iter()
        .enumerate()
        .map(|(index, (path, branch, detached, locked))| Worktree {
            path,
            branch,
            is_main: index == 0,
            detached,
            locked,
        })
        .collect()
}

/// Resolve the repo's default branch NAME, preferring the remote HEAD, then
/// `init.defaultBranch`, then common trunk names. "" when none. Mirrors the
/// upstream `defaultBranch`.
fn default_branch(cwd: &Path) -> String {
    let remote = run_git_ok(
        cwd,
        &[
            "symbolic-ref",
            "--quiet",
            "--short",
            "refs/remotes/origin/HEAD",
        ],
    );
    let remote = remote.trim().strip_prefix("origin/").unwrap_or("").trim();
    if !remote.is_empty() {
        return remote.to_string();
    }

    let configured = run_git_ok(cwd, &["config", "--get", "init.defaultBranch"]);
    let configured = configured.trim();
    if !configured.is_empty() {
        return configured.to_string();
    }

    for branch in TRUNK_BRANCHES {
        let probe = run_git_ok(
            cwd,
            &["show-ref", "--verify", &format!("refs/heads/{branch}")],
        );
        if !probe.trim().is_empty() {
            return branch.to_string();
        }
    }
    String::new()
}

/// Resolve the repo's MAIN worktree root so `.worktrees/` always nests under the
/// primary checkout even when called from a linked worktree.
fn main_root(cwd: &Path) -> PathBuf {
    list_worktrees_impl(cwd)
        .into_iter()
        .find(|tree| tree.is_main)
        .map(|tree| PathBuf::from(tree.path))
        .unwrap_or_else(|| cwd.to_path_buf())
}

/// First non-existing dir of `base`, `base-2`, `base-3`, … Mirrors `uniqueDir`.
fn unique_dir(base: &Path) -> PathBuf {
    if !base.exists() {
        return base.to_path_buf();
    }
    let mut n = 1u32;
    loop {
        n += 1;
        let candidate = PathBuf::from(format!("{}-{}", base.display(), n));
        if !candidate.exists() {
            return candidate;
        }
    }
}

/// Keep `.worktrees/` out of the main repo's status (and out of a one-click
/// review commit, which would record the nested worktree as a gitlink) by
/// appending it to `<git-common-dir>/info/exclude`. Repo-local — never touches
/// the user's `.gitignore`. Idempotent and best-effort: the worktree already
/// exists, so a failure to write the exclude must not fail the add.
fn ensure_worktrees_excluded(root: &Path) {
    let out = run_git_ok(root, &["rev-parse", "--git-common-dir"]);
    let common = out.trim();
    if common.is_empty() {
        return;
    }
    let common_dir = PathBuf::from(common);
    let common_dir = if common_dir.is_absolute() {
        common_dir
    } else {
        root.join(common_dir)
    };

    let exclude = common_dir.join("info").join("exclude");
    let existing = fs::read_to_string(&exclude).unwrap_or_default();
    if existing.lines().any(|line| line.trim() == ".worktrees/") {
        return;
    }
    if let Some(parent) = exclude.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let mut content = existing;
    if !content.is_empty() && !content.ends_with('\n') {
        content.push('\n');
    }
    content.push_str(".worktrees/\n");
    let _ = fs::write(&exclude, content);
}

/// `Ok(())` when `refs/heads/<branch>` exists. Locale-independent (probes the
/// ref instead of sniffing git's translated error strings).
fn require_local_branch(cwd: &Path, branch: &str) -> AppResult<()> {
    if local_branch_exists(cwd, branch) {
        Ok(())
    } else {
        Err(AppError::Git(format!("Branch '{branch}' does not exist.")))
    }
}

fn local_branch_exists(cwd: &Path, branch: &str) -> bool {
    run_git(
        cwd,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("refs/heads/{branch}"),
        ],
    )
    .is_ok()
}

/// A brand-new project folder isn't a git repo — and a freshly-init'd one has no
/// commit to branch from — so `git worktree add` would fail. Make the dir a repo
/// with a root commit (no-op for a repo that already has commits). Mirrors
/// `ensureGitRepo`.
fn ensure_git_repo(dir: &Path) -> AppResult<()> {
    let mut needs_root = false;
    match run_git(dir, &["rev-parse", "--is-inside-work-tree"]) {
        Ok(out) if out.trim() == "true" => {
            // Repo exists; a worktree still needs a HEAD to branch from.
            if run_git(dir, &["rev-parse", "--verify", "HEAD"]).is_err() {
                needs_root = true;
            }
        }
        _ => {
            run_git(dir, &["init"])?;
            needs_root = true;
        }
    }

    if needs_root {
        // Inline identity so the seed commit lands even with no global git config.
        run_git(
            dir,
            &[
                "-c",
                "user.email=hermes@localhost",
                "-c",
                "user.name=Hermes",
                "commit",
                "--allow-empty",
                "-m",
                "Initial commit",
            ],
        )?;
    }
    Ok(())
}

fn add_existing_branch_worktree(root: &Path, name: &str) -> AppResult<WorktreeAddResult> {
    // The name comes from `for-each-ref` — already a legal ref. Sanitizing here
    // would rewrite it (`feat#123` → `feat123`, CJK names → "") and check out
    // the wrong branch; verify it exists instead.
    let branch = name.trim().to_string();
    if branch.is_empty() {
        return Err(AppError::Git("Branch name is required.".to_string()));
    }
    require_local_branch(root, &branch)?;

    let root_str = root.to_string_lossy().to_string();
    if branch == default_branch(root) {
        run_git(root, &["switch", "--", &branch])?;
        return Ok(WorktreeAddResult {
            path: root_str.clone(),
            branch,
            repo_root: root_str,
        });
    }

    let dir = unique_dir(&root.join(".worktrees").join(slugify(&branch)));
    let dir_str = dir.to_string_lossy().to_string();
    run_git(root, &["worktree", "add", "--", &dir_str, &branch])?;
    ensure_worktrees_excluded(root);
    Ok(WorktreeAddResult {
        path: dir_str,
        branch,
        repo_root: root_str,
    })
}

fn add_worktree_impl(
    repo_path: &str,
    name: Option<&str>,
    branch: Option<&str>,
    base: Option<&str>,
    existing_branch: Option<&str>,
) -> AppResult<WorktreeAddResult> {
    let resolved = resolve_repo_dir(repo_path)?;
    // A new project folder may not be a git repo yet — init it (with a root
    // commit) so the worktree has something to branch from.
    ensure_git_repo(&resolved)?;
    let root = main_root(&resolved);

    if let Some(existing) = existing_branch.filter(|b| !b.trim().is_empty()) {
        return add_existing_branch_worktree(&root, existing);
    }

    let slug = slugify(name.unwrap_or(""));
    let sanitized = sanitize_branch(branch.unwrap_or(""));
    let branch_name = if sanitized.is_empty() {
        format!("hermes/{slug}")
    } else {
        sanitized
    };

    let base_owned = base.map(|b| b.trim().to_string()).filter(|b| !b.is_empty());
    if let Some(base) = base_owned.as_deref() {
        let probe = format!("{base}^{{commit}}");
        if run_git(&root, &["rev-parse", "--verify", "--quiet", &probe]).is_err() {
            return Err(AppError::Git(format!("Base ref '{base}' not found.")));
        }
    }

    let dir = unique_dir(&root.join(".worktrees").join(&slug));
    let dir_str = dir.to_string_lossy().to_string();

    // Probe the ref up front (locale-independent — never sniff git's translated
    // error strings): an existing branch is checked out into the fresh dir, a
    // new one is created with `-b`.
    if local_branch_exists(&root, &branch_name) {
        run_git(&root, &["worktree", "add", "--", &dir_str, &branch_name])?;
    } else {
        let mut args: Vec<&str> = vec!["worktree", "add", "-b", &branch_name, "--", &dir_str];
        if let Some(base) = base_owned.as_deref() {
            args.push(base);
        }
        run_git(&root, &args)?;
    }
    ensure_worktrees_excluded(&root);

    Ok(WorktreeAddResult {
        path: dir_str,
        branch: branch_name,
        repo_root: root.to_string_lossy().to_string(),
    })
}

fn remove_worktree_impl(
    repo_path: &str,
    worktree_path: &str,
    force: bool,
) -> AppResult<WorktreeRemoveResult> {
    let resolved_repo = resolve_repo_dir(repo_path)?;
    let tree = std::fs::canonicalize(worktree_path.trim())
        .unwrap_or_else(|_| PathBuf::from(worktree_path.trim()));
    let root = main_root(&resolved_repo);
    let tree_str = tree.to_string_lossy().to_string();

    let mut args: Vec<&str> = vec!["worktree", "remove"];
    if force {
        args.push("--force");
    }
    args.push("--");
    args.push(&tree_str);
    run_git(&root, &args)?;

    Ok(WorktreeRemoveResult { removed: tree_str })
}

fn list_branches_impl(cwd: &Path) -> Vec<Branch> {
    let out = run_git_ok(
        cwd,
        &[
            "for-each-ref",
            "--format=%(refname:short)",
            "--sort=-committerdate",
            "refs/heads",
        ],
    );
    if out.trim().is_empty() {
        return Vec::new();
    }

    let path_by_branch: HashMap<String, String> = list_worktrees_impl(cwd)
        .into_iter()
        .filter_map(|tree| tree.branch.map(|branch| (branch, tree.path)))
        .collect();
    let trunk = default_branch(cwd);

    out.lines()
        .map(|line| line.trim())
        .filter(|line| !line.is_empty())
        .map(|name| Branch {
            name: name.to_string(),
            checked_out: path_by_branch.contains_key(name),
            is_default: !trunk.is_empty() && name == trunk,
            worktree_path: path_by_branch.get(name).cloned(),
        })
        .collect()
}

/// behind/ahead vs the current branch's upstream (0/0 when none configured).
fn ahead_behind(cwd: &Path) -> (u64, u64) {
    let out =
        run_git(cwd, &["rev-list", "--left-right", "--count", "@{u}...HEAD"]).unwrap_or_default();
    let mut parts = out.split_whitespace();
    let behind = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    let ahead = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    (ahead, behind)
}

fn repo_status_impl(repo_path: &str) -> Option<RepoStatus> {
    let cwd = resolve_repo_dir(repo_path).ok()?;
    let inside = run_git(&cwd, &["rev-parse", "--is-inside-work-tree"])
        .map(|out| out.trim() == "true")
        .unwrap_or(false);
    if !inside {
        return None;
    }

    let entries = status_entries(&cwd);
    let branch = current_branch(&cwd);
    let detached = branch.is_none();

    let mut staged = 0u64;
    let mut unstaged = 0u64;
    let mut untracked = 0u64;
    let mut conflicted = 0u64;
    for (x, y, _) in &entries {
        if is_staged(*x) {
            staged += 1;
        }
        if *y != ' ' && *y != '?' {
            unstaged += 1;
        }
        if *x == '?' || *y == '?' {
            untracked += 1;
        }
        if *x == 'U' || *y == 'U' {
            conflicted += 1;
        }
    }

    let (ahead, behind) = ahead_behind(&cwd);

    let counts = numstat_map(&cwd, &["HEAD"]);
    let mut added: u64 = counts.values().map(|(a, _)| *a).sum();
    let removed: u64 = counts.values().map(|(_, d)| *d).sum();
    for (x, y, path) in &entries {
        if *x == '?' || *y == '?' {
            added += untracked_insertions(&cwd, path);
        }
    }

    let trunk = default_branch(&cwd);
    Some(RepoStatus {
        branch,
        default_branch: if trunk.is_empty() { None } else { Some(trunk) },
        detached,
        ahead,
        behind,
        staged,
        unstaged,
        untracked,
        conflicted,
        changed: entries.len() as u64,
        added,
        removed,
    })
}

#[tauri::command]
pub fn git_worktree_list(input: RepoPathInput) -> AppResult<Vec<Worktree>> {
    let Ok(cwd) = resolve_repo_dir(&input.repo_path) else {
        return Ok(Vec::new());
    };
    Ok(list_worktrees_impl(&cwd))
}

#[tauri::command]
pub fn git_worktree_add(input: WorktreeAddInput) -> AppResult<WorktreeAddResult> {
    add_worktree_impl(
        &input.repo_path,
        input.name.as_deref(),
        input.branch.as_deref(),
        input.base.as_deref(),
        input.existing_branch.as_deref(),
    )
}

#[tauri::command]
pub fn git_worktree_remove(input: WorktreeRemoveInput) -> AppResult<WorktreeRemoveResult> {
    remove_worktree_impl(&input.repo_path, &input.worktree_path, input.force)
}

#[tauri::command]
pub fn git_branch_list(input: RepoPathInput) -> AppResult<Vec<Branch>> {
    let Ok(cwd) = resolve_repo_dir(&input.repo_path) else {
        return Ok(Vec::new());
    };
    Ok(list_branches_impl(&cwd))
}

#[tauri::command]
pub fn git_branch_switch(input: BranchSwitchInput) -> AppResult<BranchSwitchResult> {
    let cwd = resolve_repo_dir(&input.repo_path)?;
    // The target comes from `for-each-ref` — already a legal ref name; don't
    // sanitize (it would rewrite `feat#123` / strip CJK names). Verify instead.
    let target = input.branch.trim().to_string();
    if target.is_empty() {
        return Err(AppError::Git("Branch name is required.".to_string()));
    }
    require_local_branch(&cwd, &target)?;
    run_git(&cwd, &["switch", "--", &target])?;
    Ok(BranchSwitchResult { branch: target })
}

#[tauri::command]
pub fn git_repo_status(input: RepoPathInput) -> AppResult<Option<RepoStatus>> {
    Ok(repo_status_impl(&input.repo_path))
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    fn git(dir: &Path, args: &[&str]) {
        // Isolate test-driven git calls from the host's global/system config.
        let mut cmd = command("git", dir);
        cmd.env("GIT_CONFIG_GLOBAL", if cfg!(windows) { "NUL" } else { "/dev/null" })
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .args(args);
        let out = cmd.output().unwrap();
        assert!(
            out.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    /// A throwaway repo with one committed file and deterministic identity/config
    /// (no dependence on the host's global git config). The production paths
    /// under test run git without env isolation, so pin the settings they read
    /// (e.g. `init.defaultBranch`) in the repo-local config where they win over
    /// any host value.
    fn init_repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path();
        git(path, &["init", "-q", "-b", "main"]);
        git(path, &["config", "user.email", "test@example.com"]);
        git(path, &["config", "user.name", "Test"]);
        git(path, &["config", "commit.gpgsign", "false"]);
        git(path, &["config", "init.defaultBranch", "main"]);
        git(path, &["config", "core.autocrlf", "false"]);
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
    fn sanitize_branch_makes_ref_safe_names() {
        assert_eq!(sanitize_branch("Feature  Login"), "Feature-Login");
        assert_eq!(sanitize_branch("a//b..c--d"), "a/b.c-d");
        assert_eq!(sanitize_branch("--/trim/--"), "trim");
        assert_eq!(sanitize_branch("héllo!@#"), "hllo");
        assert_eq!(sanitize_branch("   "), "");
    }

    #[test]
    fn slugify_lowercases_and_hyphenates() {
        assert_eq!(slugify("My New Feature"), "my-new-feature");
        assert_eq!(slugify("  spaced  "), "spaced");
        assert_eq!(slugify("!!!"), "work");
        assert_eq!(slugify(""), "work");
    }

    #[test]
    fn parse_worktrees_reads_porcelain() {
        let out = "worktree /repo\nHEAD abc\nbranch refs/heads/main\n\nworktree /repo/.worktrees/feat\nHEAD def\nbranch refs/heads/hermes/feat\nlocked\n";
        let trees = parse_worktrees(out);
        assert_eq!(trees.len(), 2);
        assert_eq!(trees[0].0, "/repo");
        assert_eq!(trees[0].1.as_deref(), Some("main"));
        assert_eq!(trees[1].1.as_deref(), Some("hermes/feat"));
        assert!(trees[1].3, "second worktree is locked");
    }

    #[test]
    fn worktree_add_list_and_remove_roundtrip() {
        let dir = init_repo();
        let repo = dir.path().to_string_lossy().to_string();

        let added = add_worktree_impl(&repo, Some("Login Page"), None, None, None).unwrap();
        assert_eq!(added.branch, "hermes/login-page", "default branch name");
        assert!(
            std::path::Path::new(&added.path).is_dir(),
            "worktree dir created"
        );
        assert!(added.path.contains(".worktrees"));

        let list = list_worktrees_impl(dir.path());
        assert_eq!(list.len(), 2);
        assert!(list[0].is_main, "main worktree first");
        assert!(list
            .iter()
            .any(|w| w.branch.as_deref() == Some("hermes/login-page")));

        // The branch picker sees the new branch as checked out, with its path.
        let branches = list_branches_impl(dir.path());
        let feat = branches
            .iter()
            .find(|b| b.name == "hermes/login-page")
            .expect("branch listed");
        assert!(feat.checked_out);
        // On Windows, git porcelain output uses forward slashes while Rust
        // PathBuf uses backslashes. Normalize both sides for comparison.
        let expected_path = added.path.replace("\\", "/");
        let actual_path = feat.worktree_path.as_deref().unwrap_or("").replace("\\", "/");
        assert_eq!(actual_path, expected_path, "worktree path mismatch");
        assert!(branches.iter().any(|b| b.name == "main" && b.is_default));

        let removed = remove_worktree_impl(&repo, &added.path, false).unwrap();
        assert!(removed.removed.contains("login-page"));
        assert_eq!(
            list_worktrees_impl(dir.path()).len(),
            1,
            "back to one worktree"
        );
    }

    #[test]
    fn worktree_add_existing_default_branch_switches_in_place() {
        let dir = init_repo();
        let repo = dir.path().to_string_lossy().to_string();
        // init_repo is already on `main` (the default) — checking out the default
        // branch switches in place rather than spawning a worktree.
        let result = add_worktree_impl(&repo, None, None, None, Some("main")).unwrap();
        assert_eq!(result.branch, "main");
        assert_eq!(result.path, result.repo_root, "no new worktree dir");
        assert_eq!(list_worktrees_impl(dir.path()).len(), 1);
    }

    #[test]
    fn worktree_add_excludes_dot_worktrees_from_main_status() {
        let dir = init_repo();
        let repo = dir.path().to_string_lossy().to_string();

        add_worktree_impl(&repo, Some("one"), None, None, None).unwrap();
        let status = run_git_ok(dir.path(), &["status", "--porcelain"]);
        assert!(
            !status.contains(".worktrees"),
            "main repo status stays clean: {status}"
        );

        let exclude = dir.path().join(".git").join("info").join("exclude");
        let read = || fs::read_to_string(&exclude).unwrap_or_default();
        assert_eq!(
            read().lines().filter(|l| *l == ".worktrees/").count(),
            1,
            "exclude gained the entry"
        );

        // A second add must not duplicate the line.
        add_worktree_impl(&repo, Some("two"), None, None, None).unwrap();
        assert_eq!(
            read().lines().filter(|l| *l == ".worktrees/").count(),
            1,
            "exclude entry is idempotent"
        );
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
    fn worktree_add_existing_branch_keeps_ref_special_chars() {
        let dir = init_repo();
        let repo = dir.path().to_string_lossy().to_string();
        // `#` is legal in a ref name; sanitizing would silently retarget feat123.
        git(dir.path(), &["branch", "feat#123"]);

        let added = add_worktree_impl(&repo, None, None, None, Some("feat#123")).unwrap();
        assert_eq!(added.branch, "feat#123", "branch name untouched");
        let tree = PathBuf::from(&added.path);
        assert!(tree.is_dir());
        assert_eq!(current_branch(&tree).as_deref(), Some("feat#123"));
    }

    #[test]
    fn worktree_add_existing_branch_missing_errors_without_side_effects() {
        let dir = init_repo();
        let repo = dir.path().to_string_lossy().to_string();

        let err = add_worktree_impl(&repo, None, None, None, Some("nope")).unwrap_err();
        assert!(
            err.to_string().contains("does not exist"),
            "clear error: {err}"
        );
        assert!(
            !dir.path().join(".worktrees").exists(),
            "nothing written on failure"
        );
        assert_eq!(list_worktrees_impl(dir.path()).len(), 1);
    }

    #[test]
    fn worktree_add_rejects_unknown_base() {
        let dir = init_repo();
        let repo = dir.path().to_string_lossy().to_string();

        let err =
            add_worktree_impl(&repo, Some("thing"), None, Some("no-such-base"), None).unwrap_err();
        assert!(err.to_string().contains("not found"), "clear error: {err}");
        assert!(
            !dir.path().join(".worktrees").exists(),
            "nothing written on failure"
        );
    }

    #[test]
    fn worktree_add_initializes_a_non_repo_folder() {
        // A brand-new project folder isn't a git repo — add should init it first.
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().to_string_lossy().to_string();
        let added = add_worktree_impl(&repo, Some("scratch"), None, None, None).unwrap();
        assert_eq!(added.branch, "hermes/scratch");
        assert!(std::path::Path::new(&added.path).is_dir());
    }

    #[test]
    fn branch_switch_moves_head() {
        let dir = init_repo();
        let repo = dir.path().to_string_lossy().to_string();
        git(dir.path(), &["branch", "topic"]);

        let result = git_branch_switch(BranchSwitchInput {
            repo_path: repo.clone(),
            branch: "topic".to_string(),
        })
        .unwrap();
        assert_eq!(result.branch, "topic");
        assert_eq!(current_branch(dir.path()).as_deref(), Some("topic"));
    }

    #[test]
    fn branch_switch_keeps_special_chars_and_rejects_missing() {
        let dir = init_repo();
        let repo = dir.path().to_string_lossy().to_string();
        git(dir.path(), &["branch", "feat#123"]);
        git(dir.path(), &["branch", "功能/测试"]);

        // Sanitizing would rewrite `feat#123` → `feat123` (a different branch).
        let hash = git_branch_switch(BranchSwitchInput {
            repo_path: repo.clone(),
            branch: "feat#123".to_string(),
        })
        .unwrap();
        assert_eq!(hash.branch, "feat#123");
        assert_eq!(current_branch(dir.path()).as_deref(), Some("feat#123"));

        // Sanitizing would strip a CJK name to "" ("Branch name is required").
        let cjk = git_branch_switch(BranchSwitchInput {
            repo_path: repo.clone(),
            branch: "功能/测试".to_string(),
        })
        .unwrap();
        assert_eq!(cjk.branch, "功能/测试");
        assert_eq!(current_branch(dir.path()).as_deref(), Some("功能/测试"));

        let err = git_branch_switch(BranchSwitchInput {
            repo_path: repo,
            branch: "missing".to_string(),
        })
        .unwrap_err();
        assert!(
            err.to_string().contains("does not exist"),
            "clear error: {err}"
        );
        assert_eq!(
            current_branch(dir.path()).as_deref(),
            Some("功能/测试"),
            "HEAD unmoved on failure"
        );
    }

    #[test]
    fn repo_status_reports_branch_and_counts() {
        let dir = init_repo();
        let repo = dir.path().to_string_lossy().to_string();
        std::fs::write(dir.path().join("README.md"), "hello\nmore\n").unwrap();
        std::fs::write(dir.path().join("fresh.txt"), "a\nb\n").unwrap();

        let status = git_repo_status(RepoPathInput { repo_path: repo })
            .unwrap()
            .expect("a repo reports status");
        assert_eq!(status.branch.as_deref(), Some("main"));
        assert!(!status.detached);
        assert_eq!(status.untracked, 1, "fresh.txt is untracked");
        assert_eq!(status.changed, 2, "modified README + untracked fresh");
        assert!(status.added >= 3, "1 added line + 2 untracked lines");

        // A non-repo folder reports None.
        let none = git_repo_status(RepoPathInput {
            repo_path: tempfile::tempdir()
                .unwrap()
                .path()
                .to_string_lossy()
                .to_string(),
        })
        .unwrap();
        assert!(none.is_none());
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
