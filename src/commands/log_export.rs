use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LogSnapshotFormat {
    Log,
    Jsonl,
}

impl LogSnapshotFormat {
    fn extension(self) -> &'static str {
        match self {
            LogSnapshotFormat::Log => "log",
            LogSnapshotFormat::Jsonl => "jsonl",
        }
    }

    fn filter_label(self) -> &'static str {
        match self {
            LogSnapshotFormat::Log => "日志文件",
            LogSnapshotFormat::Jsonl => "JSON Lines 日志",
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportLogSnapshotInput {
    pub file_name: String,
    pub content: String,
    pub format: LogSnapshotFormat,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportLogSnapshotResult {
    pub ok: bool,
    pub canceled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    pub bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[tauri::command]
pub async fn export_log_snapshot(
    app: tauri::AppHandle,
    input: ExportLogSnapshotInput,
) -> AppResult<ExportLogSnapshotResult> {
    let Some(path) =
        choose_log_save_path(app, safe_file_name(&input.file_name, input.format)).await?
    else {
        return Ok(ExportLogSnapshotResult {
            ok: false,
            canceled: true,
            path: None,
            bytes: 0,
            error: None,
        });
    };

    let path = ensure_extension(path, input.format);
    let bytes = input.content.len() as u64;
    let write_path = path.clone();
    let content = input.content;

    let write_result =
        tauri::async_runtime::spawn_blocking(move || fs::write(&write_path, content))
            .await
            .map_err(|e| AppError::Internal(e.to_string()))?;

    match write_result {
        Ok(()) => Ok(ExportLogSnapshotResult {
            ok: true,
            canceled: false,
            path: Some(path.to_string_lossy().to_string()),
            bytes,
            error: None,
        }),
        Err(err) => Ok(ExportLogSnapshotResult {
            ok: false,
            canceled: false,
            path: Some(path.to_string_lossy().to_string()),
            bytes: 0,
            error: Some(err.to_string()),
        }),
    }
}

async fn choose_log_save_path(
    app: tauri::AppHandle,
    file_name: String,
) -> AppResult<Option<PathBuf>> {
    use tauri_plugin_dialog::DialogExt;

    let format = if file_name.to_lowercase().ends_with(".jsonl") {
        LogSnapshotFormat::Jsonl
    } else {
        LogSnapshotFormat::Log
    };
    let extensions = [format.extension()];
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("导出 Hermes 日志")
        .set_file_name(file_name)
        .add_filter(format.filter_label(), &extensions)
        .save_file(move |path| {
            let result = path.and_then(|p| p.as_path().map(|path| path.to_path_buf()));
            let _ = tx.send(result);
        });
    rx.await.map_err(|e| AppError::Internal(e.to_string()))
}

fn safe_file_name(file_name: &str, format: LogSnapshotFormat) -> String {
    let mut cleaned = file_name
        .trim()
        .chars()
        .map(|ch| match ch {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            ch if ch.is_control() => '_',
            ch => ch,
        })
        .collect::<String>();

    if cleaned.is_empty() || cleaned == "." || cleaned == ".." {
        cleaned = "hermes-logs".to_string();
    }

    let extension = format.extension();
    let suffix = format!(".{extension}");
    if !cleaned.to_lowercase().ends_with(&suffix) {
        cleaned.push('.');
        cleaned.push_str(extension);
    }
    cleaned
}

fn ensure_extension(mut path: PathBuf, format: LogSnapshotFormat) -> PathBuf {
    let extension = format.extension();
    let has_extension = path
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case(extension));
    if !has_extension {
        path.set_extension(extension);
    }
    path
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_file_name_removes_path_separators_and_adds_extension() {
        assert_eq!(
            safe_file_name("../bad:name", LogSnapshotFormat::Log),
            ".._bad_name.log"
        );
        assert_eq!(
            safe_file_name("gateway.JSONL", LogSnapshotFormat::Jsonl),
            "gateway.JSONL"
        );
    }

    #[test]
    fn ensure_extension_replaces_missing_or_different_extension() {
        assert_eq!(
            ensure_extension(PathBuf::from("/tmp/hermes"), LogSnapshotFormat::Jsonl),
            PathBuf::from("/tmp/hermes.jsonl")
        );
        assert_eq!(
            ensure_extension(PathBuf::from("/tmp/hermes.txt"), LogSnapshotFormat::Log),
            PathBuf::from("/tmp/hermes.log")
        );
    }
}
