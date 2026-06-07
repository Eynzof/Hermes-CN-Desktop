use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

use crate::error::{AppError, AppResult};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilePickerResult {
    pub canceled: bool,
    pub paths: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspacePathInput {
    pub path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalUrlInput {
    pub url: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SimpleApiResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[tauri::command]
pub async fn pick_files(app: tauri::AppHandle) -> AppResult<FilePickerResult> {
    use tauri_plugin_dialog::DialogExt;

    let (tx, rx) = tokio::sync::oneshot::channel();

    app.dialog()
        .file()
        .set_title("选择附件")
        .pick_files(move |paths| {
            let result = match paths {
                Some(file_paths) => FilePickerResult {
                    canceled: false,
                    paths: file_paths
                        .iter()
                        .filter_map(|p| p.as_path().map(|pp| pp.to_string_lossy().to_string()))
                        .collect(),
                },
                None => FilePickerResult {
                    canceled: true,
                    paths: vec![],
                },
            };
            let _ = tx.send(result);
        });

    rx.await.map_err(|e| AppError::Internal(e.to_string()))
}

#[tauri::command]
pub async fn pick_directory(app: tauri::AppHandle) -> AppResult<FilePickerResult> {
    use tauri_plugin_dialog::DialogExt;

    let (tx, rx) = tokio::sync::oneshot::channel();

    app.dialog()
        .file()
        .set_title("选择工作区")
        .pick_folders(move |paths| {
            let result = match paths {
                Some(dir_paths) => FilePickerResult {
                    canceled: false,
                    paths: dir_paths
                        .iter()
                        .filter_map(|p| p.as_path().map(|pp| pp.to_string_lossy().to_string()))
                        .collect(),
                },
                None => FilePickerResult {
                    canceled: true,
                    paths: vec![],
                },
            };
            let _ = tx.send(result);
        });

    rx.await.map_err(|e| AppError::Internal(e.to_string()))
}

#[tauri::command]
pub fn create_workspace_project() -> AppResult<FilePickerResult> {
    let documents = dirs::document_dir()
        .or_else(dirs::home_dir)
        .unwrap_or_else(|| PathBuf::from("."));

    let base_name = "NewProject";
    let mut path = documents.join(base_name);

    for i in 0..100 {
        if i > 0 {
            path = documents.join(format!("{} {}", base_name, i + 1));
        }
        if !path.exists() {
            break;
        }
    }

    if path.exists() {
        path = documents.join(format!(
            "{} {}",
            base_name,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis()
        ));
    }

    fs::create_dir_all(&path)?;

    Ok(FilePickerResult {
        canceled: false,
        paths: vec![path.to_string_lossy().to_string()],
    })
}

/// Returns true when `s` looks like a `scheme://...` URL. A Windows drive path
/// such as `C:\Users\x` is intentionally NOT a URL (it has `:\`, not `://`).
fn looks_like_url(s: &str) -> bool {
    match s.find("://") {
        Some(idx) if idx > 0 => {
            let scheme = &s[..idx];
            scheme
                .chars()
                .next()
                .is_some_and(|c| c.is_ascii_alphabetic())
                && scheme
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
        }
        _ => false,
    }
}

/// Validate a user-supplied workspace path before handing it to the OS opener.
/// Rejects empty input and URL-like targets (so `open::that` can't be steered
/// into opening a browser / arbitrary shell target), and requires the path to
/// resolve to an accessible local filesystem entry.
fn validate_open_target(raw: &str) -> AppResult<PathBuf> {
    let path = raw.trim();
    if path.is_empty() {
        return Err(AppError::InvalidRequest("Empty path".to_string()));
    }
    if looks_like_url(path) {
        return Err(AppError::InvalidRequest(format!(
            "Refusing to open URL target: {path}"
        )));
    }
    let candidate = PathBuf::from(path);
    fs::metadata(&candidate)
        .map_err(|e| AppError::InvalidRequest(format!("Path is not accessible: {e}")))?;
    Ok(candidate)
}

fn validate_external_url(raw: &str) -> AppResult<String> {
    let target = raw.trim();
    if target.is_empty() {
        return Err(AppError::InvalidRequest("Empty URL".to_string()));
    }

    let parsed = url::Url::parse(target)
        .map_err(|e| AppError::InvalidRequest(format!("Invalid URL: {e}")))?;

    match parsed.scheme() {
        "http" | "https" => {
            if parsed.host().is_none() {
                return Err(AppError::InvalidRequest(
                    "URL must include a host".to_string(),
                ));
            }
        }
        "mailto" => {
            if parsed.path().trim().is_empty() {
                return Err(AppError::InvalidRequest(
                    "mailto URL must include an address".to_string(),
                ));
            }
        }
        "obsidian" => {
            if parsed.host_str().is_none() {
                return Err(AppError::InvalidRequest(
                    "obsidian URL must include an action".to_string(),
                ));
            }
        }
        scheme => {
            return Err(AppError::InvalidRequest(format!(
                "Refusing to open unsupported URL scheme: {scheme}"
            )));
        }
    }

    Ok(parsed.to_string())
}

#[tauri::command]
pub async fn open_workspace_path(input: WorkspacePathInput) -> AppResult<SimpleApiResult> {
    let target = validate_open_target(&input.path)?;

    open::that(&target).map_err(|e| AppError::FileError(format!("Failed to open: {}", e)))?;

    Ok(SimpleApiResult {
        ok: true,
        message: None,
    })
}

#[tauri::command]
pub async fn open_external_url(input: ExternalUrlInput) -> AppResult<SimpleApiResult> {
    let target = validate_external_url(&input.url)?;

    open::that(&target).map_err(|e| AppError::FileError(format!("Failed to open URL: {}", e)))?;

    Ok(SimpleApiResult {
        ok: true,
        message: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_url_targets() {
        for url in [
            "http://example.com",
            "https://example.com/path",
            "file:///etc/passwd",
            "ftp://host/file",
        ] {
            assert!(looks_like_url(url), "{url} should look like a URL");
            assert!(
                matches!(validate_open_target(url), Err(AppError::InvalidRequest(_))),
                "{url} should be rejected"
            );
        }
    }

    #[test]
    fn does_not_treat_filesystem_paths_as_urls() {
        assert!(!looks_like_url("/Users/enzo/project"));
        assert!(!looks_like_url("C:\\Users\\enzo\\project"));
        assert!(!looks_like_url("relative/dir"));
        assert!(!looks_like_url(""));
    }

    #[test]
    fn rejects_empty_and_missing_paths() {
        assert!(matches!(
            validate_open_target("   "),
            Err(AppError::InvalidRequest(_))
        ));
        assert!(matches!(
            validate_open_target("/no/such/path/hermes-xyz-404"),
            Err(AppError::InvalidRequest(_))
        ));
    }

    #[test]
    fn accepts_existing_directory() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().to_string_lossy().to_string();
        let resolved = validate_open_target(&path).expect("existing dir accepted");
        assert_eq!(resolved.as_path(), dir.path());
    }

    #[test]
    fn accepts_safe_external_urls() {
        assert_eq!(
            validate_external_url(" https://hermesagent.org.cn/path?q=1 ").unwrap(),
            "https://hermesagent.org.cn/path?q=1"
        );
        assert_eq!(
            validate_external_url("http://example.com").unwrap(),
            "http://example.com/"
        );
        assert_eq!(
            validate_external_url("mailto:hello@example.com").unwrap(),
            "mailto:hello@example.com"
        );
        assert_eq!(
            validate_external_url(
                "obsidian://open?vault=Hermes&file=Twitter%20%E6%97%B6%E9%97%B4%E7%BA%BF"
            )
            .unwrap(),
            "obsidian://open?vault=Hermes&file=Twitter%20%E6%97%B6%E9%97%B4%E7%BA%BF"
        );
    }

    #[test]
    fn rejects_unsafe_external_urls() {
        for raw in [
            "",
            "   ",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "tauri://localhost",
            "ftp://example.com/file",
            "mailto:",
            "obsidian:open",
        ] {
            assert!(
                matches!(validate_external_url(raw), Err(AppError::InvalidRequest(_))),
                "{raw:?} should be rejected"
            );
        }
    }
}
