use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use crate::error::{AppError, AppResult};

const MEMORY_FILE_NAME: &str = "MEMORY.md";
const USER_FILE_NAME: &str = "USER.md";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadMemoryFilesInput {
    /// Workspace root to read from. Defaults to the current working directory.
    pub workspace_root: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MemoryFileEntry {
    pub name: String,
    pub path: String,
    pub exists: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReadMemoryFilesResult {
    pub workspace_root: String,
    pub files: Vec<MemoryFileEntry>,
}

fn resolve_workspace_root(input: &ReadMemoryFilesInput) -> AppResult<PathBuf> {
    match &input.workspace_root {
        Some(raw) => {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                return Err(AppError::InvalidRequest(
                    "workspace_root cannot be empty".to_string(),
                ));
            }
            Ok(PathBuf::from(trimmed))
        }
        None => std::env::current_dir().map_err(|e| AppError::FileError(e.to_string())),
    }
}

fn read_one(workspace: &Path, name: &str) -> MemoryFileEntry {
    let path = workspace.join(name);
    let exists = path.exists();
    let content = if exists {
        std::fs::read_to_string(&path).ok()
    } else {
        None
    };
    MemoryFileEntry {
        name: name.to_string(),
        path: path.to_string_lossy().to_string(),
        exists,
        content,
    }
}

/// Read `MEMORY.md` and `USER.md` from a workspace root.
///
/// Missing files are reported with `exists: false` and `content: null` so the
/// caller can decide whether to treat them as empty. Other I/O errors are
/// surfaced as `FileError`.
#[tauri::command]
pub async fn read_memory_files(input: ReadMemoryFilesInput) -> AppResult<ReadMemoryFilesResult> {
    let workspace_root = resolve_workspace_root(&input)?;
    if !workspace_root.exists() {
        return Err(AppError::FileError(format!(
            "workspace root does not exist: {}",
            workspace_root.display()
        )));
    }

    let files = vec![
        read_one(&workspace_root, MEMORY_FILE_NAME),
        read_one(&workspace_root, USER_FILE_NAME),
    ];

    Ok(ReadMemoryFilesResult {
        workspace_root: workspace_root.to_string_lossy().to_string(),
        files,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;
    use std::io::Write;

    #[test]
    fn reads_existing_files_and_reports_missing() {
        let dir = tempfile::tempdir().expect("tempdir");
        let memory = dir.path().join(MEMORY_FILE_NAME);
        {
            let mut file = std::fs::File::create(&memory).expect("create MEMORY.md");
            writeln!(file, "project memory").expect("write MEMORY.md");
        }
        // USER.md intentionally missing

        let result = read_memory_files(ReadMemoryFilesInput {
            workspace_root: Some(dir.path().to_string_lossy().to_string()),
        });
        let result = tauri::async_runtime::block_on(result).expect("command ok");

        assert_eq!(result.workspace_root, dir.path().to_string_lossy());
        assert_eq!(result.files.len(), 2);
        assert_eq!(result.files[0].name, MEMORY_FILE_NAME);
        assert!(result.files[0].exists);
        assert_eq!(result.files[0].content.as_deref(), Some("project memory\n"));
        assert_eq!(result.files[1].name, USER_FILE_NAME);
        assert!(!result.files[1].exists);
        assert!(result.files[1].content.is_none());
    }

    #[test]
    fn falls_back_to_current_directory_when_workspace_root_is_omitted() {
        let result = read_memory_files(ReadMemoryFilesInput {
            workspace_root: None,
        });
        let result = tauri::async_runtime::block_on(result).expect("command ok");
        assert_eq!(
            result.workspace_root,
            std::env::current_dir()
                .unwrap()
                .to_string_lossy()
                .to_string()
        );
        assert_eq!(result.files.len(), 2);
    }

    #[test]
    fn errors_on_missing_workspace_root() {
        let dir = tempfile::tempdir().expect("tempdir");
        let missing = dir.path().join("does_not_exist");
        let result = tauri::async_runtime::block_on(read_memory_files(ReadMemoryFilesInput {
            workspace_root: Some(missing.to_string_lossy().to_string()),
        }));
        assert!(matches!(result, Err(AppError::FileError(_))));
    }

    #[test]
    fn errors_on_empty_workspace_root() {
        let result = tauri::async_runtime::block_on(read_memory_files(ReadMemoryFilesInput {
            workspace_root: Some("   ".to_string()),
        }));
        assert!(matches!(result, Err(AppError::InvalidRequest(_))));
    }
}
