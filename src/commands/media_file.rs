// Local-first media helpers.
//
// Provides `media_data_url` for authenticated base64 data-URL thumbnails and a
// `media_file_url` helper for the custom protocol URL that Rust can stream.
// Full custom-protocol Range streaming is intentionally left as a thin command
// surface in v1; the data-URL path covers chat-image thumbnails today.

use std::fs;
use std::path::{Path, PathBuf};

use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::state::AppState;

const MEDIA_DATA_URL_MAX_BYTES: u64 = 25 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES: &[&str] = &["image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp"];
const ALLOWED_VIDEO_TYPES: &[&str] = &["video/mp4", "video/webm", "video/ogg"];

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaDataUrlInput {
    pub path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaDataUrlResult {
    pub ok: bool,
    pub data_url: String,
    pub mime_type: String,
    pub size: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaFileUrlInput {
    pub path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaFileUrlResult {
    pub url: String,
}

pub fn resolve_media_path(raw: &str) -> AppResult<PathBuf> {
    let decoded = urlencoding::decode(raw).map_err(|e| AppError::InvalidRequest(e.to_string()))?;
    let expanded = if let Some(rest) = decoded.strip_prefix("~") {
        dirs::home_dir()
            .map(|h| {
                if rest.is_empty() {
                    h
                } else {
                    h.join(rest.trim_start_matches('/').trim_start_matches('\\'))
                }
            })
            .unwrap_or_else(|| PathBuf::from(decoded.as_ref()))
    } else {
        PathBuf::from(decoded.as_ref())
    };

    let candidate = if expanded.is_absolute() {
        expanded
    } else {
        std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")).join(expanded)
    };

    fs::canonicalize(&candidate).map_err(|e| AppError::FileError(format!("Cannot resolve media path: {}", e)))
}

pub fn mime_from_path(path: &Path) -> Option<&'static str> {
    match path.extension().and_then(|e| e.to_str()) {
        Some("png") => Some("image/png"),
        Some("jpg") | Some("jpeg") => Some("image/jpeg"),
        Some("gif") => Some("image/gif"),
        Some("webp") => Some("image/webp"),
        Some("bmp") => Some("image/bmp"),
        Some("mp4") => Some("video/mp4"),
        Some("webm") => Some("video/webm"),
        Some("ogv") | Some("ogg") => Some("video/ogg"),
        _ => None,
    }
}

pub fn allowed_mime(mime: &str) -> bool {
    ALLOWED_IMAGE_TYPES.contains(&mime) || ALLOWED_VIDEO_TYPES.contains(&mime)
}

/// Return a base64 data URL for a local media file. Mirrors `GET /api/media`.
#[tauri::command]
pub fn media_data_url(_state: State<'_, AppState>, input: MediaDataUrlInput) -> Result<MediaDataUrlResult, AppError> {
    let resolved = resolve_media_path(&input.path)?;
    let meta = fs::metadata(&resolved)?;
    if !meta.is_file() {
        return Err(AppError::FileError("Not a regular file".to_string()));
    }
    if meta.len() > MEDIA_DATA_URL_MAX_BYTES {
        return Err(AppError::InvalidRequest(
            format!("Media file exceeds {} MiB cap", MEDIA_DATA_URL_MAX_BYTES / (1024 * 1024))
        ));
    }

    let mime = mime_from_path(&resolved).unwrap_or("application/octet-stream");
    if !allowed_mime(mime) {
        return Err(AppError::InvalidRequest("Unsupported media type".to_string()));
    }

    let bytes = fs::read(&resolved)?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    let data_url = format!("data:{};base64,{}", mime, b64);

    Ok(MediaDataUrlResult {
        ok: true,
        data_url,
        mime_type: mime.to_string(),
        size: bytes.len() as u64,
    })
}

/// Return a custom-protocol URL that the webview can request for streaming.
#[tauri::command]
pub fn media_file_url(_state: State<'_, AppState>, input: MediaFileUrlInput) -> Result<MediaFileUrlResult, AppError> {
    let resolved = resolve_media_path(&input.path)?;
    let resolved_str = resolved.to_string_lossy().to_string();
    let encoded = urlencoding::encode(&resolved_str);
    Ok(MediaFileUrlResult {
        url: format!("hermes-media://file?path={}", encoded),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn resolves_absolute_path() {
        let tmp = tempfile::TempDir::new().unwrap();
        let file = tmp.path().join("image.png");
        fs::File::create(&file).unwrap();
        let resolved = resolve_media_path(&file.to_string_lossy()).unwrap();
        assert_eq!(resolved, file.canonicalize().unwrap());
    }

    #[test]
    fn mime_from_path_png() {
        assert_eq!(mime_from_path(Path::new("foo.png")), Some("image/png"));
    }

    #[test]
    fn allowed_mime_accepts_image() {
        assert!(allowed_mime("image/webp"));
        assert!(!allowed_mime("application/pdf"));
    }

    #[test]
    fn produces_data_url_for_png() {
        let tmp = tempfile::TempDir::new().unwrap();
        let file = tmp.path().join("image.png");
        let mut f = fs::File::create(&file).unwrap();
        // Minimal PNG header: 8 signature + 4 len + 4 IHDR + 4 width + 4 height + 5 bit depth...
        let mut header = vec![
            0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
            0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
            0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
            0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
            0xde,
        ];
        // Add a trailing chunk to make it a valid-ish PNG.
        header.extend_from_slice(&[0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
        f.write_all(&header).unwrap();

        let result = media_data_url_impl(&file.to_string_lossy()).unwrap();
        assert!(result.data_url.starts_with("data:image/png;base64,"));
        assert_eq!(result.mime_type, "image/png");
    }

    fn media_data_url_impl(path: &str) -> AppResult<MediaDataUrlResult> {
        let resolved = resolve_media_path(path)?;
        let meta = fs::metadata(&resolved)?;
        if !meta.is_file() {
            return Err(AppError::FileError("Not a regular file".to_string()));
        }
        let mime = mime_from_path(&resolved).unwrap_or("application/octet-stream");
        let bytes = fs::read(&resolved)?;
        let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
        Ok(MediaDataUrlResult {
            ok: true,
            data_url: format!("data:{};base64,{}", mime, b64),
            mime_type: mime.to_string(),
            size: bytes.len() as u64,
        })
    }
}
