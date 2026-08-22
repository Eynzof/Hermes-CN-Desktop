// Local-first attachment upload.
//
// Writes uploaded bytes directly to HERMES_HOME/uploads/<session_id>/ so the
// webview never has to round-trip through the Python `/api/upload` endpoint.
// Mirrors Python `_safe_upload_filename`, `_unique_upload_path`, and the 50 MiB
// cap.

use std::fs;
use std::path::{Path, PathBuf};

use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::state::AppState;

const UPLOAD_MAX_BYTES: usize = 50 * 1024 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadFileLocalInput {
    pub session_id: String,
    pub name: String,
    pub mime_type: String,
    pub data: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadFileLocalResult {
    pub ok: bool,
    pub filename: String,
    pub path: String,
    pub size: usize,
    pub mime_type: String,
}

fn is_valid_session_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 160 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn sanitize_filename(name: &str) -> String {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return "upload".to_string();
    }
    let mut out = String::with_capacity(trimmed.len());
    for c in trimmed.chars() {
        match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '\0' => out.push('_'),
            c => out.push(c),
        }
    }
    let out = out.trim_start_matches('.').to_string();
    if out.is_empty() {
        "upload".to_string()
    } else if out.len() > 240 {
        out[..240].to_string()
    } else {
        out
    }
}

fn unique_upload_path(root: &Path, filename: &str) -> PathBuf {
    let base = root.join(filename);
    if !base.exists() {
        return base;
    }
    let stem = Path::new(filename)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "upload".to_string());
    let ext = Path::new(filename)
        .extension()
        .map(|s| {
            let e = s.to_string_lossy().to_string();
            format!(".{}", e)
        })
        .unwrap_or_default();
    for n in 1..=9999 {
        let candidate = root.join(format!("{}_{}{}", stem, n, ext));
        if !candidate.exists() {
            return candidate;
        }
    }
    // Overflow fallback: use timestamp-style suffix.
    let fallback = root.join(format!(
        "{}_{}{}",
        stem,
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0),
        ext
    ));
    fallback
}

pub(crate) fn uploads_dir(state: &State<'_, AppState>) -> AppResult<PathBuf> {
    let inner = state.inner.lock()?;
    let base = PathBuf::from(&inner.hermes_home);
    let dir = base.join("uploads");
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

#[tauri::command]
pub fn upload_file_local(
    state: State<'_, AppState>,
    input: UploadFileLocalInput,
) -> Result<UploadFileLocalResult, AppError> {
    if !is_valid_session_id(&input.session_id) {
        return Err(AppError::InvalidRequest("Invalid session_id".to_string()));
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&input.data)
        .map_err(|e| AppError::InvalidRequest(format!("Invalid base64 data: {}", e)))?;
    if bytes.len() > UPLOAD_MAX_BYTES {
        return Err(AppError::InvalidRequest(format!(
            "Upload exceeds {} MiB cap",
            UPLOAD_MAX_BYTES / (1024 * 1024)
        )));
    }

    let uploads_root = uploads_dir(&state)?;
    let session_dir = uploads_root.join(&input.session_id);
    fs::create_dir_all(&session_dir)?;

    let filename = sanitize_filename(&input.name);
    let target = unique_upload_path(&session_dir, &filename);
    fs::write(&target, &bytes)?;

    Ok(UploadFileLocalResult {
        ok: true,
        filename: target.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or(filename),
        path: target.to_string_lossy().to_string(),
        size: bytes.len(),
        mime_type: input.mime_type,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn sanitize_filename_strips_path_separators() {
        assert_eq!(sanitize_filename("foo/bar.txt"), "foo_bar.txt");
        assert_eq!(sanitize_filename("foo\\bar.txt"), "foo_bar.txt");
    }

    #[test]
    fn sanitize_filename_replaces_special_characters() {
        assert_eq!(sanitize_filename("a:b*c?d\"e<f>g|h"), "a_b_c_d_e_f_g_h");
    }

    #[test]
    fn sanitize_filename_trims_leading_dots() {
        assert_eq!(sanitize_filename("...hidden"), "hidden");
    }

    #[test]
    fn unique_path_without_collision() {
        let tmp = tempfile::TempDir::new().unwrap();
        let p = unique_upload_path(tmp.path(), "foo.txt");
        assert_eq!(p, tmp.path().join("foo.txt"));
    }

    #[test]
    fn unique_path_with_collision() {
        let tmp = tempfile::TempDir::new().unwrap();
        fs::File::create(tmp.path().join("foo.txt")).unwrap();
        let p = unique_upload_path(tmp.path(), "foo.txt");
        assert_eq!(p, tmp.path().join("foo_1.txt"));
    }

    #[test]
    fn valid_session_id_accepted() {
        assert!(is_valid_session_id("sess_123-ABC"));
    }

    #[test]
    fn invalid_session_id_rejected() {
        assert!(!is_valid_session_id(""));
        assert!(!is_valid_session_id("a b"));
        assert!(!is_valid_session_id("foo/bar"));
    }

    #[test]
    fn base64_decoding_roundtrip() {
        let text = "hello world";
        let encoded = base64::engine::general_purpose::STANDARD.encode(text.as_bytes());
        let decoded = base64::engine::general_purpose::STANDARD.decode(&encoded).unwrap();
        assert_eq!(String::from_utf8(decoded).unwrap(), text);
    }
}
