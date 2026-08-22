use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use crate::error::{AppError, AppResult};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadContextFilesInput {
    pub paths: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextFileEntry {
    pub path: String,
    pub content: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadContextFilesResult {
    pub results: Vec<ContextFileEntry>,
}

/// Read a batch of text files from disk.  Missing files are reported with
/// `content: null` rather than raising an error so the context-file loader can
/// probe candidate paths cheaply.  Other I/O errors are surfaced as `FileError`.
#[tauri::command]
pub async fn read_context_files(input: ReadContextFilesInput) -> AppResult<ReadContextFilesResult> {
    Ok(ReadContextFilesResult {
        results: input
            .paths
            .into_iter()
            .map(read_one)
            .collect::<AppResult<_>>()?,
    })
}

fn read_one(raw: String) -> AppResult<ContextFileEntry> {
    let path = PathBuf::from(raw.trim());
    match std::fs::read_to_string(&path) {
        Ok(content) => Ok(ContextFileEntry {
            path: path.to_string_lossy().to_string(),
            content: Some(content),
        }),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(ContextFileEntry {
            path: path.to_string_lossy().to_string(),
            content: None,
        }),
        Err(err) => Err(AppError::FileError(format!(
            "Failed to read {}: {err}",
            path.display()
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn reads_existing_files_and_reports_missing() {
        let dir = tempfile::tempdir().expect("tempdir");
        let existing = dir.path().join("AGENTS.md");
        {
            let mut file = std::fs::File::create(&existing).expect("create");
            writeln!(file, "project rules").expect("write");
        }
        let missing = dir.path().join("NONE.md");

        let result = read_context_files(ReadContextFilesInput {
            paths: vec![
                existing.to_string_lossy().to_string(),
                missing.to_string_lossy().to_string(),
            ],
        });
        let result = tauri::async_runtime::block_on(result).expect("command ok");

        assert_eq!(result.results.len(), 2);
        assert_eq!(
            result.results[0].path.to_lowercase(),
            existing.to_string_lossy().to_string().to_lowercase()
        );
        assert_eq!(
            result.results[0].content.as_deref(),
            Some("project rules\n")
        );
        assert_eq!(
            result.results[1].path.to_lowercase(),
            missing.to_string_lossy().to_string().to_lowercase()
        );
        assert!(result.results[1].content.is_none());
    }

    #[test]
    fn ignores_whitespace_in_input_paths() {
        let dir = tempfile::tempdir().expect("tempdir");
        let file = dir.path().join("CLAUDE.md");
        std::fs::write(&file, "claude context").expect("write");

        let result = tauri::async_runtime::block_on(read_context_files(ReadContextFilesInput {
            paths: vec![format!("  {}  ", file.to_string_lossy())],
        }))
        .expect("command ok");

        assert_eq!(result.results.len(), 1);
        assert_eq!(result.results[0].content.as_deref(), Some("claude context"));
    }
}
