use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

use crate::error::{AppError, AppResult};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportSessionJsonInput {
    pub file_name: String,
    pub content: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportSessionJsonResult {
    pub ok: bool,
    pub canceled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    pub bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[tauri::command]
pub async fn export_session_json(
    app: tauri::AppHandle,
    input: ExportSessionJsonInput,
) -> AppResult<ExportSessionJsonResult> {
    let Some(path) = choose_session_save_path(app, safe_file_name(&input.file_name)).await? else {
        return Ok(ExportSessionJsonResult {
            ok: false,
            canceled: true,
            path: None,
            bytes: 0,
            error: None,
        });
    };

    let path = ensure_json_extension(path);
    let bytes = input.content.len() as u64;
    let write_path = path.clone();
    let content = input.content;
    let write_result =
        tauri::async_runtime::spawn_blocking(move || fs::write(&write_path, content))
            .await
            .map_err(|error| AppError::Internal(error.to_string()))?;

    match write_result {
        Ok(()) => Ok(ExportSessionJsonResult {
            ok: true,
            canceled: false,
            path: Some(path.to_string_lossy().to_string()),
            bytes,
            error: None,
        }),
        Err(error) => Ok(ExportSessionJsonResult {
            ok: false,
            canceled: false,
            path: Some(path.to_string_lossy().to_string()),
            bytes: 0,
            error: Some(error.to_string()),
        }),
    }
}

async fn choose_session_save_path(
    app: tauri::AppHandle,
    file_name: String,
) -> AppResult<Option<PathBuf>> {
    use tauri_plugin_dialog::DialogExt;

    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("导出 Hermes 会话")
        .set_file_name(file_name)
        .add_filter("JSON 会话文件", &["json"])
        .save_file(move |path| {
            let result = path.and_then(|value| value.as_path().map(|path| path.to_path_buf()));
            let _ = tx.send(result);
        });
    rx.await
        .map_err(|error| AppError::Internal(error.to_string()))
}

fn safe_file_name(file_name: &str) -> String {
    let mut cleaned = file_name
        .trim()
        .chars()
        .map(|character| match character {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            character if character.is_control() => '_',
            character => character,
        })
        .collect::<String>();

    if cleaned.is_empty() || cleaned == "." || cleaned == ".." {
        cleaned = "session-export".to_string();
    }
    if !cleaned.to_lowercase().ends_with(".json") {
        cleaned.push_str(".json");
    }
    cleaned
}

fn ensure_json_extension(mut path: PathBuf) -> PathBuf {
    let has_json_extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("json"));
    if !has_json_extension {
        path.set_extension("json");
    }
    path
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_file_name_removes_path_characters_and_adds_extension() {
        assert_eq!(
            safe_file_name("session-bad/name:1"),
            "session-bad_name_1.json"
        );
        assert_eq!(safe_file_name("session-ok.JSON"), "session-ok.JSON");
        assert_eq!(safe_file_name(".."), "session-export.json");
    }

    #[test]
    fn ensure_json_extension_replaces_other_extension() {
        assert_eq!(
            ensure_json_extension(PathBuf::from("/tmp/session.txt")),
            PathBuf::from("/tmp/session.json")
        );
        assert_eq!(
            ensure_json_extension(PathBuf::from("/tmp/session.JSON")),
            PathBuf::from("/tmp/session.JSON")
        );
    }
}
