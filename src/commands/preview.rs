// Right-rail rich preview backend (issue #233).
//
// Powers the task-detail right rail's file/code preview and "文件实时刷新"
// (live file watch). Mirrors the Electron reference preload API
// (apps/desktop right-rail: readFileText / watchPreviewFile /
// onPreviewFileChanged) so the ported React component logic stays close.
//
// Two capabilities:
// - `read_workspace_file`: read a single file from the session workspace,
//   capped and binary-safe, with a containment guard so the renderer can't
//   steer it outside the workspace root.
// - `watch_preview_file` / `stop_preview_file_watch`: native fs watch that
//   emits a `preview-file-changed` event on every change. The renderer
//   debounces (matching the upstream 200ms FILE_RELOAD_DEBOUNCE_MS) before
//   re-reading, so Rust stays a thin raw-event source.

use std::collections::HashMap;
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

use base64::Engine;
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::error::{AppError, AppResult};

/// Tauri event emitted to the renderer whenever a watched file changes.
const PREVIEW_FILE_CHANGED: &str = "preview-file-changed";

/// Match the upstream `TEXT_PREVIEW_MAX_BYTES` (512 KB). Larger files are
/// truncated for the text preview rather than streamed in full.
const TEXT_PREVIEW_MAX_BYTES: u64 = 512 * 1024;
/// Cap inline image data URLs so a giant asset can't balloon the IPC payload.
const IMAGE_PREVIEW_MAX_BYTES: u64 = 8 * 1024 * 1024;
/// Bytes sampled from the head of a file to decide text vs binary.
const BINARY_SNIFF_BYTES: usize = 4096;
/// Match the upstream `hermes:fs:writeText` cap (1 MB). The spot editor's save
/// is the only writer, so this is a hard ceiling that keeps the command from
/// being abused as a bulk-write primitive.
const TEXT_WRITE_MAX_BYTES: usize = 1_000_000;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadWorkspaceFileInput {
    /// File to read. Absolute or relative to `root`; must resolve inside `root`.
    pub path: String,
    /// Session workspace root. Reads are confined to this directory.
    pub root: String,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilePreview {
    /// UTF-8 text content, when the file is textual. Lossy (�-substituted)
    /// when `lossy_utf8` is set — display-only in that case.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// `data:<mime>;base64,...` for previewable images.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data_url: Option<String>,
    /// Full size on disk in bytes (independent of how much was read).
    pub byte_size: u64,
    /// True when the content is binary (no text preview available).
    pub binary: bool,
    /// True when `text` was cut at `TEXT_PREVIEW_MAX_BYTES`.
    pub truncated: bool,
    /// True when the bytes were not valid UTF-8 (e.g. GBK) and `text` was
    /// produced by a lossy conversion. Such a preview must never be edited and
    /// written back: saving the � text as UTF-8 would irreversibly corrupt the
    /// original bytes.
    pub lossy_utf8: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteWorkspaceFileInput {
    /// File to write. Absolute or relative to `root`; must resolve inside `root`.
    pub path: String,
    /// Session workspace root. Writes are confined to this directory.
    pub root: String,
    /// New UTF-8 file content.
    pub content: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteWorkspaceFileResult {
    /// Canonical path actually written.
    pub path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchPreviewFileInput {
    pub path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchPreviewFileResult {
    pub watch_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StopPreviewFileWatchInput {
    pub watch_id: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PreviewFileChangedPayload {
    watch_id: String,
    path: String,
}

/// Resolve `path` (preferably absolute, as the renderer's file browser sends)
/// to a canonical, existing file. Containment in `root` is **best-effort**: it
/// is enforced only when `root` itself canonicalizes, so a workspace path the
/// renderer could browse via the (more lenient) `/api/fs/list` endpoint never
/// gets a valid file read rejected just because `canonicalize()` is stricter.
/// Traversal/symlink escapes are still caught when containment applies.
///
/// **Read path only.** Writes go through the strict
/// [`resolve_within_root_strict`], which never skips containment.
fn resolve_within_root(root: &str, path: &str) -> AppResult<PathBuf> {
    let raw = path.trim();
    if raw.is_empty() {
        return Err(AppError::InvalidRequest("Empty path".to_string()));
    }
    let root = root.trim();

    let candidate = {
        let pb = PathBuf::from(raw);
        if pb.is_absolute() {
            pb
        } else if !root.is_empty() {
            PathBuf::from(root).join(pb)
        } else {
            return Err(AppError::InvalidRequest(
                "Relative path requires a workspace root".to_string(),
            ));
        }
    };

    let real = candidate
        .canonicalize()
        .map_err(|e| AppError::FileError(format!("Path not accessible: {e}")))?;

    // Enforce containment only when the workspace root canonicalizes. The file
    // browser is already gated to the user's home subtree by the dashboard, so
    // skipping the check for an un-canonicalizable root is safe and avoids a
    // spurious rejection that surfaces to the user as "no content".
    if !root.is_empty() {
        if let Ok(root_real) = PathBuf::from(root).canonicalize() {
            if !real.starts_with(&root_real) {
                return Err(AppError::OriginViolation(format!(
                    "Path escapes workspace: {}",
                    real.display()
                )));
            }
        }
    }

    Ok(real)
}

/// Strict resolver for the **write** path. Unlike the lenient read-side
/// [`resolve_within_root`], a write must never proceed without a verified
/// workspace containment: an empty `root`, a `root` that fails to
/// canonicalize, or a target that resolves outside the canonical root are all
/// hard errors — otherwise the command could overwrite any existing file the
/// process can touch.
fn resolve_within_root_strict(root: &str, path: &str) -> AppResult<PathBuf> {
    let raw = path.trim();
    if raw.is_empty() {
        return Err(AppError::InvalidRequest("Empty path".to_string()));
    }
    let root = root.trim();
    if root.is_empty() {
        return Err(AppError::InvalidRequest(
            "Write requires a workspace root".to_string(),
        ));
    }
    let root_real = PathBuf::from(root)
        .canonicalize()
        .map_err(|e| AppError::FileError(format!("Workspace root not accessible: {e}")))?;

    let candidate = {
        let pb = PathBuf::from(raw);
        if pb.is_absolute() {
            pb
        } else {
            root_real.join(pb)
        }
    };
    let real = candidate
        .canonicalize()
        .map_err(|e| AppError::FileError(format!("Path not accessible: {e}")))?;
    if !real.starts_with(&root_real) {
        return Err(AppError::OriginViolation(format!(
            "Path escapes workspace: {}",
            real.display()
        )));
    }
    Ok(real)
}

/// Map a lowercase file extension to an image MIME type, when previewable.
fn image_mime(ext: &str) -> Option<&'static str> {
    match ext {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "bmp" => Some("image/bmp"),
        "ico" => Some("image/x-icon"),
        "svg" => Some("image/svg+xml"),
        _ => None,
    }
}

/// Heuristic binary sniff over a head sample: any NUL byte, or a high ratio of
/// non-text control characters, marks the content binary.
fn looks_binary(sample: &[u8]) -> bool {
    if sample.is_empty() {
        return false;
    }
    if sample.contains(&0) {
        return true;
    }
    let suspicious = sample
        .iter()
        .filter(|&&b| b < 0x09 || (b > 0x0d && b < 0x20))
        .count();
    suspicious * 100 / sample.len() > 30
}

/// Core, AppHandle-free read logic so it can be unit-tested directly.
fn read_file_preview(root: &str, path: &str) -> AppResult<FilePreview> {
    let resolved = resolve_within_root(root, path)?;
    let meta = fs::metadata(&resolved)?;
    if !meta.is_file() {
        return Err(AppError::FileError("Not a regular file".to_string()));
    }
    let byte_size = meta.len();

    let ext = resolved
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase());

    if let Some(mime) = ext.as_deref().and_then(image_mime) {
        if byte_size > IMAGE_PREVIEW_MAX_BYTES {
            return Ok(FilePreview {
                binary: true,
                byte_size,
                ..Default::default()
            });
        }
        let bytes = fs::read(&resolved)?;
        let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
        return Ok(FilePreview {
            data_url: Some(format!("data:{mime};base64,{b64}")),
            binary: true,
            byte_size,
            ..Default::default()
        });
    }

    // Read at most the text cap + 1 byte (the extra byte only signals "there is
    // more", it is never surfaced).
    let file = fs::File::open(&resolved)?;
    let mut buf = Vec::new();
    file.take(TEXT_PREVIEW_MAX_BYTES + 1)
        .read_to_end(&mut buf)?;

    let sniff_len = buf.len().min(BINARY_SNIFF_BYTES);
    if looks_binary(&buf[..sniff_len]) {
        return Ok(FilePreview {
            binary: true,
            byte_size,
            ..Default::default()
        });
    }

    let keep = buf.len().min(TEXT_PREVIEW_MAX_BYTES as usize);
    // Strict UTF-8 first: only a byte-exact decode may be treated as editable
    // source. Anything else (GBK, Latin-1, …) still gets a lossy preview for
    // display, but is flagged so the spot editor refuses to write it back.
    let (text, lossy_utf8) = match std::str::from_utf8(&buf[..keep]) {
        Ok(s) => (s.to_owned(), false),
        Err(_) => (String::from_utf8_lossy(&buf[..keep]).into_owned(), true),
    };
    Ok(FilePreview {
        text: Some(text),
        byte_size,
        truncated: byte_size > TEXT_PREVIEW_MAX_BYTES,
        binary: false,
        lossy_utf8,
        ..Default::default()
    })
}

#[tauri::command]
pub fn read_workspace_file(input: ReadWorkspaceFileInput) -> AppResult<FilePreview> {
    read_file_preview(&input.root, &input.path)
}

/// Core, AppHandle-free write logic so it can be unit-tested directly. Mirrors
/// the Electron `hermes:fs:writeText` hardening: a size cap, a **strict**
/// workspace-containment guard ([`resolve_within_root_strict`] — unlike reads,
/// a missing or un-canonicalizable root is a hard error), and an
/// existing-regular-file requirement (the spot editor only ever saves a file it
/// already previewed, so this never creates files or directory trees and never
/// escapes the root). The write itself is atomic: the full content goes to a
/// sibling temp file which is then renamed over the target, so a crash
/// mid-write can never leave a half-written file. Stale-on-disk detection is
/// the caller's job (re-read + compare before save).
fn write_file_text(root: &str, path: &str, content: &str) -> AppResult<WriteWorkspaceFileResult> {
    if content.len() > TEXT_WRITE_MAX_BYTES {
        return Err(AppError::InvalidRequest("Content too large".to_string()));
    }
    let resolved = resolve_within_root_strict(root, path)?;
    let meta = fs::metadata(&resolved)?;
    if !meta.is_file() {
        return Err(AppError::FileError("Not a regular file".to_string()));
    }

    let dir = resolved
        .parent()
        .ok_or_else(|| AppError::FileError("No parent directory".to_string()))?;
    let mut tmp = tempfile::NamedTempFile::new_in(dir)
        .map_err(|e| AppError::FileError(format!("Failed to create temp file: {e}")))?;
    io::Write::write_all(&mut tmp, content.as_bytes())?;
    tmp.as_file().sync_all()?;
    // NamedTempFile creates 0600 on Unix; carry the original mode over so the
    // rename doesn't silently tighten (or loosen) the file's permissions.
    tmp.as_file().set_permissions(meta.permissions())?;
    tmp.persist(&resolved)
        .map_err(|e| AppError::FileError(format!("Failed to replace file: {e}")))?;
    Ok(WriteWorkspaceFileResult {
        path: resolved.to_string_lossy().to_string(),
    })
}

#[tauri::command]
pub fn write_workspace_file(input: WriteWorkspaceFileInput) -> AppResult<WriteWorkspaceFileResult> {
    write_file_text(&input.root, &input.path, &input.content)
}

/// Live watcher registry. Keeping the `RecommendedWatcher` alive is what keeps
/// the OS watch active; dropping it (via stop / app exit) tears it down.
fn watchers() -> &'static Mutex<HashMap<String, RecommendedWatcher>> {
    static WATCHERS: OnceLock<Mutex<HashMap<String, RecommendedWatcher>>> = OnceLock::new();
    WATCHERS.get_or_init(|| Mutex::new(HashMap::new()))
}

static WATCH_SEQ: AtomicU64 = AtomicU64::new(0);

/// Build a non-recursive file watcher whose change events are routed to
/// `on_change`. Split out from the command so tests can assert change
/// detection without a Tauri `AppHandle`.
fn spawn_file_watcher(
    path: &Path,
    on_change: impl Fn() + Send + 'static,
) -> AppResult<RecommendedWatcher> {
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(event) = res {
            use notify::EventKind;
            if matches!(
                event.kind,
                EventKind::Modify(_) | EventKind::Create(_) | EventKind::Remove(_)
            ) {
                on_change();
            }
        }
    })
    .map_err(|e| AppError::FileError(format!("Failed to create watcher: {e}")))?;

    watcher
        .watch(path, RecursiveMode::NonRecursive)
        .map_err(|e| AppError::FileError(format!("Failed to watch path: {e}")))?;

    Ok(watcher)
}

#[tauri::command]
pub fn watch_preview_file(
    app: AppHandle,
    input: WatchPreviewFileInput,
) -> AppResult<WatchPreviewFileResult> {
    let path = PathBuf::from(input.path.trim());
    if !path.exists() {
        return Err(AppError::FileError(format!(
            "Cannot watch missing path: {}",
            path.display()
        )));
    }

    let watch_id = format!("watch-{}", WATCH_SEQ.fetch_add(1, Ordering::Relaxed));
    let emit_id = watch_id.clone();
    let emit_path = path.to_string_lossy().to_string();

    let watcher = spawn_file_watcher(&path, move || {
        let _ = app.emit(
            PREVIEW_FILE_CHANGED,
            PreviewFileChangedPayload {
                watch_id: emit_id.clone(),
                path: emit_path.clone(),
            },
        );
    })?;

    watchers().lock()?.insert(watch_id.clone(), watcher);
    Ok(WatchPreviewFileResult { watch_id })
}

#[tauri::command]
pub fn stop_preview_file_watch(input: StopPreviewFileWatchInput) -> AppResult<bool> {
    Ok(watchers().lock()?.remove(&input.watch_id).is_some())
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;
    use std::sync::mpsc;
    use std::time::Duration;

    #[test]
    fn reads_small_text_file() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().to_string();
        std::fs::write(dir.path().join("a.txt"), b"hello world").unwrap();

        let preview = read_file_preview(&root, "a.txt").unwrap();
        assert_eq!(preview.text.as_deref(), Some("hello world"));
        assert!(!preview.binary);
        assert!(!preview.truncated);
        assert!(!preview.lossy_utf8);
        assert_eq!(preview.byte_size, 11);
    }

    #[test]
    fn flags_lossy_for_non_utf8_text() {
        // "你好" in GBK — textual (no NULs / control chars) but invalid UTF-8.
        // The preview must stay displayable yet be flagged lossy so the spot
        // editor never writes the �-substituted text back over the GBK bytes.
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().to_string();
        std::fs::write(
            dir.path().join("gbk.txt"),
            [b'h', b'i', 0xc4, 0xe3, 0xba, 0xc3],
        )
        .unwrap();

        let preview = read_file_preview(&root, "gbk.txt").unwrap();
        assert!(preview.lossy_utf8, "non-UTF-8 text must be flagged lossy");
        assert!(!preview.binary);
        let text = preview.text.expect("lossy preview still carries text");
        assert!(text.starts_with("hi"));
        assert!(
            text.contains('\u{fffd}'),
            "lossy conversion should substitute replacement chars"
        );
    }

    #[test]
    fn truncates_large_text_file() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().to_string();
        let big = "x".repeat((TEXT_PREVIEW_MAX_BYTES as usize) + 4096);
        std::fs::write(dir.path().join("big.txt"), big.as_bytes()).unwrap();

        let preview = read_file_preview(&root, "big.txt").unwrap();
        assert!(preview.truncated);
        assert!(!preview.binary);
        assert_eq!(
            preview.text.as_ref().map(|t| t.len()),
            Some(TEXT_PREVIEW_MAX_BYTES as usize)
        );
        assert_eq!(
            preview.byte_size,
            (TEXT_PREVIEW_MAX_BYTES as usize + 4096) as u64
        );
    }

    #[test]
    fn detects_binary_content() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().to_string();
        std::fs::write(dir.path().join("blob.bin"), [0u8, 1, 2, 3, 0, 9]).unwrap();

        let preview = read_file_preview(&root, "blob.bin").unwrap();
        assert!(preview.binary);
        assert!(preview.text.is_none());
        assert!(preview.data_url.is_none());
    }

    #[test]
    fn encodes_small_image_as_data_url() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().to_string();
        // 1x1 transparent PNG header bytes are enough to exercise the path.
        std::fs::write(dir.path().join("pixel.png"), [0x89, 0x50, 0x4e, 0x47]).unwrap();

        let preview = read_file_preview(&root, "pixel.png").unwrap();
        assert!(preview.binary);
        assert!(preview
            .data_url
            .as_deref()
            .unwrap()
            .starts_with("data:image/png;base64,"));
    }

    #[test]
    fn rejects_path_escaping_root() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("ws");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(dir.path().join("secret.txt"), b"nope").unwrap();

        let err = read_file_preview(&root.to_string_lossy(), "../secret.txt").unwrap_err();
        assert!(
            matches!(err, AppError::OriginViolation(_)),
            "expected OriginViolation, got {err:?}"
        );
    }

    #[test]
    fn rejects_empty_root() {
        let err = read_file_preview("", "a.txt").unwrap_err();
        assert!(matches!(err, AppError::InvalidRequest(_)));
    }

    #[test]
    fn reads_absolute_file_when_root_uncanonicalizable() {
        // The file browser always sends an absolute path; a workspace root that
        // canonicalize() can't resolve must not block a valid read (the bug
        // that surfaced as "no content"). Containment is skipped, not fatal.
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a.txt");
        std::fs::write(&file, b"hello").unwrap();

        let preview = read_file_preview("/no/such/root-xyz-404", &file.to_string_lossy()).unwrap();
        assert_eq!(preview.text.as_deref(), Some("hello"));
    }

    #[test]
    fn writes_text_file_in_place() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().to_string();
        let file = dir.path().join("note.md");
        std::fs::write(&file, b"old").unwrap();

        let result = write_file_text(&root, "note.md", "new content").unwrap();
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            "new content",
            "the on-disk file should reflect the saved buffer"
        );
        assert!(result.path.ends_with("note.md"));
    }

    #[test]
    fn write_replaces_content_atomically_without_leftovers() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().to_string();
        let file = dir.path().join("doc.txt");
        std::fs::write(&file, b"before").unwrap();

        write_file_text(&root, "doc.txt", "after").unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "after");
        // The temp file must have been renamed over the target, not left behind.
        let names: Vec<String> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(names, vec!["doc.txt".to_string()]);
    }

    #[cfg(unix)]
    #[test]
    fn write_preserves_file_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().to_string();
        let file = dir.path().join("script.sh");
        std::fs::write(&file, b"echo hi").unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o755)).unwrap();

        write_file_text(&root, "script.sh", "echo bye").unwrap();
        let mode = std::fs::metadata(&file).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o755, "atomic replace must not reset the mode");
    }

    #[test]
    fn write_rejects_empty_root() {
        // The read path tolerates a blank root for absolute paths; the write
        // path must not — otherwise any existing file becomes writable.
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("target.txt");
        std::fs::write(&file, b"keep").unwrap();

        let err = write_file_text("", &file.to_string_lossy(), "pwned").unwrap_err();
        assert!(
            matches!(err, AppError::InvalidRequest(_)),
            "expected InvalidRequest, got {err:?}"
        );
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            "keep",
            "a rejected write must not touch the file"
        );
    }

    #[test]
    fn write_rejects_uncanonicalizable_root() {
        // Same story for a root that doesn't exist: reads skip containment,
        // writes must fail hard instead of falling through to the target.
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("target.txt");
        std::fs::write(&file, b"keep").unwrap();

        let err =
            write_file_text("/no/such/root-xyz-404", &file.to_string_lossy(), "pwned").unwrap_err();
        assert!(
            matches!(err, AppError::FileError(_)),
            "expected FileError, got {err:?}"
        );
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            "keep",
            "a rejected write must not touch the file"
        );
    }

    #[test]
    fn write_rejects_path_escaping_root() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("ws");
        std::fs::create_dir_all(&root).unwrap();
        let secret = dir.path().join("secret.txt");
        std::fs::write(&secret, b"keep").unwrap();

        let err = write_file_text(&root.to_string_lossy(), "../secret.txt", "pwned").unwrap_err();
        assert!(
            matches!(err, AppError::OriginViolation(_)),
            "expected OriginViolation, got {err:?}"
        );
        assert_eq!(
            std::fs::read_to_string(&secret).unwrap(),
            "keep",
            "a rejected write must not touch the file"
        );
    }

    #[test]
    fn write_rejects_oversized_content() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().to_string();
        let file = dir.path().join("big.txt");
        std::fs::write(&file, b"small").unwrap();

        let huge = "x".repeat(TEXT_WRITE_MAX_BYTES + 1);
        let err = write_file_text(&root, "big.txt", &huge).unwrap_err();
        assert!(matches!(err, AppError::InvalidRequest(_)));
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            "small",
            "an oversized write must be rejected before touching disk"
        );
    }

    #[test]
    fn write_rejects_missing_file() {
        // The spot editor only saves files it previewed; a path that doesn't
        // resolve must fail rather than create a new file.
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().to_string();

        let err = write_file_text(&root, "does-not-exist.txt", "data").unwrap_err();
        assert!(matches!(err, AppError::FileError(_)));
    }

    #[test]
    fn watcher_fires_on_modification() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("watched.txt");
        std::fs::write(&file, b"v1").unwrap();

        let (tx, rx) = mpsc::channel::<()>();
        let _watcher = spawn_file_watcher(&file, move || {
            let _ = tx.send(());
        })
        .unwrap();

        // Give the watcher a moment to register before mutating.
        std::thread::sleep(Duration::from_millis(200));
        std::fs::write(&file, b"v2-changed").unwrap();

        assert!(
            rx.recv_timeout(Duration::from_secs(5)).is_ok(),
            "watcher should fire on file modification"
        );
    }
}
