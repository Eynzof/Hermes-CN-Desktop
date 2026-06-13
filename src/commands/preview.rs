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
use std::io::Read;
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
    /// UTF-8 (lossy) text content, when the file is textual.
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

/// Resolve `path` against `root` and confirm the canonical target stays inside
/// the canonical `root`. Rejects empty input, traversal (`..`), and symlinks
/// that escape the workspace. Returns the canonical, existing path.
fn resolve_within_root(root: &str, path: &str) -> AppResult<PathBuf> {
    let raw = path.trim();
    if raw.is_empty() {
        return Err(AppError::InvalidRequest("Empty path".to_string()));
    }
    let root = root.trim();
    if root.is_empty() {
        return Err(AppError::InvalidRequest(
            "Workspace root is required".to_string(),
        ));
    }

    let root_real = PathBuf::from(root)
        .canonicalize()
        .map_err(|e| AppError::InvalidRequest(format!("Workspace root not accessible: {e}")))?;

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
    let text = String::from_utf8_lossy(&buf[..keep]).into_owned();
    Ok(FilePreview {
        text: Some(text),
        byte_size,
        truncated: byte_size > TEXT_PREVIEW_MAX_BYTES,
        binary: false,
        ..Default::default()
    })
}

#[tauri::command]
pub fn read_workspace_file(input: ReadWorkspaceFileInput) -> AppResult<FilePreview> {
    read_file_preview(&input.root, &input.path)
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
        assert_eq!(preview.byte_size, 11);
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
