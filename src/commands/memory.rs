use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};
use tauri::State;
use tokio::task;

use crate::error::{AppError, AppResult};
use crate::state::AppState;

const ENTRY_DELIMITER: &str = "\n§\n";
const DEFAULT_MEMORY_CHAR_LIMIT: usize = 2200;
const MIN_MEMORY_CHAR_LIMIT: usize = 1;
const DEFAULT_USER_CHAR_LIMIT: usize = 1375;
const MIN_USER_CHAR_LIMIT: usize = 1;

#[derive(Debug, Deserialize)]
struct HermesConfig {
    memory: Option<MemoryConfig>,
}

#[derive(Debug, Deserialize)]
struct MemoryConfig {
    memory_char_limit: Option<i64>,
    user_char_limit: Option<i64>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MemoryEntry {
    pub index: usize,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MemoryFileInfo {
    pub content: String,
    pub exists: bool,
    pub last_modified: Option<u64>,
    pub char_count: usize,
    pub char_limit: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentMemoryInfo {
    pub content: String,
    pub exists: bool,
    pub last_modified: Option<u64>,
    pub entries: Vec<MemoryEntry>,
    pub char_count: usize,
    pub char_limit: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MemoryStats {
    pub total_sessions: usize,
    pub total_messages: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MemoryInfo {
    pub memory: AgentMemoryInfo,
    pub user: MemoryFileInfo,
    pub stats: MemoryStats,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MemoryMutationResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

fn memory_dir(home: &Path) -> PathBuf {
    home.join("memories")
}

fn memory_path(home: &Path) -> PathBuf {
    memory_dir(home).join("MEMORY.md")
}

fn user_path(home: &Path) -> PathBuf {
    memory_dir(home).join("USER.md")
}

fn configured_user_char_limit(home: &Path) -> usize {
    let configured = fs::read_to_string(home.join("config.yaml"))
        .ok()
        .and_then(|raw| serde_yaml::from_str::<HermesConfig>(&raw).ok())
        .and_then(|config| config.memory)
        .and_then(|memory| memory.user_char_limit)
        .and_then(|limit| usize::try_from(limit).ok());

    // No upper clamp: the Python backend (MemoryStore in tools/memory_tool.py)
    // accepts whatever value the user configures, so the Desktop must not
    // silently cap it. Only guard against zero/negative via MIN.
    configured
        .unwrap_or(DEFAULT_USER_CHAR_LIMIT)
        .max(MIN_USER_CHAR_LIMIT)
}

fn configured_memory_char_limit(home: &Path) -> usize {
    let configured = fs::read_to_string(home.join("config.yaml"))
        .ok()
        .and_then(|raw| serde_yaml::from_str::<HermesConfig>(&raw).ok())
        .and_then(|config| config.memory)
        .and_then(|memory| memory.memory_char_limit)
        .and_then(|limit| usize::try_from(limit).ok());

    // No upper clamp: the Python backend (MemoryStore in tools/memory_tool.py)
    // accepts whatever value the user configures, so the Desktop must not
    // silently cap it. Only guard against zero/negative via MIN.
    configured
        .unwrap_or(DEFAULT_MEMORY_CHAR_LIMIT)
        .max(MIN_MEMORY_CHAR_LIMIT)
}

fn char_count(content: &str) -> usize {
    content.chars().count()
}

fn unix_modified(path: &Path) -> Option<u64> {
    let modified = fs::metadata(path).ok()?.modified().ok()?;
    modified
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|d| d.as_secs())
}

fn read_file_safe(path: &Path, limit: usize) -> MemoryFileInfo {
    match fs::read_to_string(path) {
        Ok(content) => MemoryFileInfo {
            char_count: char_count(&content),
            content,
            exists: true,
            last_modified: unix_modified(path),
            char_limit: limit,
        },
        Err(_) => MemoryFileInfo {
            content: String::new(),
            exists: false,
            last_modified: None,
            char_count: 0,
            char_limit: limit,
        },
    }
}

fn parse_memory_entries(content: &str) -> Vec<MemoryEntry> {
    if content.trim().is_empty() {
        return Vec::new();
    }
    content
        .split(ENTRY_DELIMITER)
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .enumerate()
        .map(|(index, content)| MemoryEntry {
            index,
            content: content.to_string(),
        })
        .collect()
}

fn serialize_entries(entries: &[MemoryEntry]) -> String {
    entries
        .iter()
        .map(|entry| entry.content.trim())
        .filter(|entry| !entry.is_empty())
        .collect::<Vec<_>>()
        .join(ENTRY_DELIMITER)
}

fn write_file_safe(path: &Path, content: &str) -> AppResult<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp_path = path.with_extension("tmp");
    fs::write(&tmp_path, content)?;
    if path.exists() {
        fs::remove_file(path)?;
    }
    fs::rename(tmp_path, path)?;
    Ok(())
}

fn active_hermes_home(state: &State<'_, AppState>) -> AppResult<PathBuf> {
    let inner = state.inner.lock()?;
    if inner.connection_mode == crate::connection::ConnectionMode::Remote {
        return Err(AppError::InvalidRequest(
            "远程记忆编辑需要远端 Hermes Agent 提供记忆读写 API；当前桌面端不会读取内置内核的 Memory。".to_string(),
        ));
    }
    if inner.hermes_home.trim().is_empty() {
        return Err(AppError::NotReady);
    }
    Ok(PathBuf::from(inner.hermes_home.clone()))
}

fn read_memory_from_home(home: &Path) -> MemoryInfo {
    let memory_char_limit = configured_memory_char_limit(home);
    let mem_file = read_file_safe(&memory_path(home), memory_char_limit);
    let user_char_limit = configured_user_char_limit(home);
    let user_file = read_file_safe(&user_path(home), user_char_limit);
    let entries = parse_memory_entries(&mem_file.content);

    MemoryInfo {
        memory: AgentMemoryInfo {
            content: mem_file.content,
            exists: mem_file.exists,
            last_modified: mem_file.last_modified,
            entries,
            char_count: mem_file.char_count,
            char_limit: mem_file.char_limit,
        },
        user: user_file,
        // The React route enriches these with /api/sessions data when the
        // dashboard is available. Keep a stable shape for offline/early boot.
        stats: MemoryStats {
            total_sessions: 0,
            total_messages: 0,
        },
    }
}

async fn run_memory_io<T, F>(work: F) -> AppResult<T>
where
    T: Send + 'static,
    F: FnOnce() -> AppResult<T> + Send + 'static,
{
    task::spawn_blocking(work)
        .await
        .map_err(|err| AppError::Internal(format!("memory task failed: {}", err)))?
}

#[tauri::command]
pub async fn read_memory(state: State<'_, AppState>) -> AppResult<MemoryInfo> {
    let home = active_hermes_home(&state)?;
    run_memory_io(move || Ok(read_memory_from_home(&home))).await
}

#[tauri::command]
pub async fn add_memory_entry(
    content: String,
    state: State<'_, AppState>,
) -> AppResult<MemoryMutationResult> {
    let trimmed = content.trim().to_string();
    if trimmed.is_empty() {
        return Ok(MemoryMutationResult {
            success: false,
            error: Some("记忆内容不能为空".to_string()),
        });
    }

    let home = active_hermes_home(&state)?;
    run_memory_io(move || {
        let path = memory_path(&home);
        let memory_char_limit = configured_memory_char_limit(&home);
        let existing = read_file_safe(&path, memory_char_limit);
        let mut entries = parse_memory_entries(&existing.content);
        entries.push(MemoryEntry {
            index: entries.len(),
            content: trimmed,
        });
        let next = serialize_entries(&entries);
        if char_count(&next) > memory_char_limit {
            return Ok(MemoryMutationResult {
                success: false,
                error: Some(format!(
                    "超过记忆上限（{} / {} 字符）",
                    char_count(&next),
                    memory_char_limit
                )),
            });
        }

        write_file_safe(&path, &next)?;
        Ok(MemoryMutationResult {
            success: true,
            error: None,
        })
    })
    .await
}

#[tauri::command]
pub async fn update_memory_entry(
    index: usize,
    content: String,
    state: State<'_, AppState>,
) -> AppResult<MemoryMutationResult> {
    let next_content = content.trim().to_string();
    let home = active_hermes_home(&state)?;
    run_memory_io(move || {
        let path = memory_path(&home);
        let memory_char_limit = configured_memory_char_limit(&home);
        let existing = read_file_safe(&path, memory_char_limit);
        let mut entries = parse_memory_entries(&existing.content);

        if index >= entries.len() {
            return Ok(MemoryMutationResult {
                success: false,
                error: Some("没有找到这条记忆".to_string()),
            });
        }

        entries[index].content = next_content;
        let next = serialize_entries(&entries);
        if char_count(&next) > memory_char_limit {
            return Ok(MemoryMutationResult {
                success: false,
                error: Some(format!(
                    "超过记忆上限（{} / {} 字符）",
                    char_count(&next),
                    memory_char_limit
                )),
            });
        }

        write_file_safe(&path, &next)?;
        Ok(MemoryMutationResult {
            success: true,
            error: None,
        })
    })
    .await
}

#[tauri::command]
pub async fn remove_memory_entry(index: usize, state: State<'_, AppState>) -> AppResult<bool> {
    let home = active_hermes_home(&state)?;
    run_memory_io(move || {
        let path = memory_path(&home);
        let memory_char_limit = configured_memory_char_limit(&home);
        let existing = read_file_safe(&path, memory_char_limit);
        let mut entries = parse_memory_entries(&existing.content);

        if index >= entries.len() {
            return Ok(false);
        }

        entries.remove(index);
        write_file_safe(&path, &serialize_entries(&entries))?;
        Ok(true)
    })
    .await
}

#[tauri::command]
pub async fn write_user_profile(
    content: String,
    state: State<'_, AppState>,
) -> AppResult<MemoryMutationResult> {
    let home = active_hermes_home(&state)?;
    let user_char_limit = configured_user_char_limit(&home);
    let count = char_count(&content);
    if count > user_char_limit {
        return Ok(MemoryMutationResult {
            success: false,
            error: Some(format!(
                "超过用户画像上限（{} / {} 字符）",
                count, user_char_limit
            )),
        });
    }

    run_memory_io(move || {
        write_file_safe(&user_path(&home), &content)?;
        Ok(MemoryMutationResult {
            success: true,
            error: None,
        })
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    #[test]
    fn parses_memory_entries_with_section_delimiter() {
        let entries = parse_memory_entries(" first \n§\n\nsecond\n\n§\n  ");
        assert_eq!(
            entries,
            vec![
                MemoryEntry {
                    index: 0,
                    content: "first".to_string()
                },
                MemoryEntry {
                    index: 1,
                    content: "second".to_string()
                },
            ]
        );
    }

    #[test]
    fn serializes_entries_without_empty_items() {
        let content = serialize_entries(&[
            MemoryEntry {
                index: 0,
                content: " alpha ".to_string(),
            },
            MemoryEntry {
                index: 1,
                content: "".to_string(),
            },
            MemoryEntry {
                index: 2,
                content: "beta".to_string(),
            },
        ]);
        assert_eq!(content, "alpha\n§\nbeta");
    }

    #[test]
    fn counts_unicode_characters_not_bytes() {
        assert_eq!(char_count("中文🙂"), 3);
    }

    #[test]
    fn reads_default_and_configured_memory_limits() {
        let home = tempfile::tempdir().unwrap();
        assert_eq!(
            configured_memory_char_limit(home.path()),
            DEFAULT_MEMORY_CHAR_LIMIT
        );

        fs::write(
            home.path().join("config.yaml"),
            "memory:\n  memory_char_limit: 6400\n",
        )
        .unwrap();
        assert_eq!(configured_memory_char_limit(home.path()), 6400);
    }

    #[test]
    fn honors_user_configured_memory_limit_above_previous_max() {
        // Regression test: the Desktop used to clamp memory_char_limit at
        // MAX_MEMORY_CHAR_LIMIT (8000), but the Python backend (hermes-agent-cn
        // runtime) has no such cap. A user who sets memory_char_limit: 20000 in
        // config.yaml would see the MEMORY header rendered by the backend with
        // 20000 but the Desktop's own read_memory command would return 8000.
        // After fixing the clamping, configured values up to at least 20000
        // must pass through unchanged.
        let home = tempfile::tempdir().unwrap();
        fs::write(
            home.path().join("config.yaml"),
            "memory:
  memory_char_limit: 20000
",
        )
        .unwrap();
        assert_eq!(configured_memory_char_limit(home.path()), 20000);

        fs::write(
            home.path().join("config.yaml"),
            "memory:
  memory_char_limit: 0
",
        )
        .unwrap();
        assert_eq!(
            configured_memory_char_limit(home.path()),
            MIN_MEMORY_CHAR_LIMIT
        );
    }

    #[test]
    fn reads_default_and_configured_user_limits() {
        let home = tempfile::tempdir().unwrap();
        assert_eq!(
            configured_user_char_limit(home.path()),
            DEFAULT_USER_CHAR_LIMIT
        );

        fs::write(
            home.path().join("config.yaml"),
            "memory:
  user_char_limit: 10000
",
        )
        .unwrap();
        assert_eq!(configured_user_char_limit(home.path()), 10000);
    }

    #[test]
    fn honors_user_configured_user_limit_above_previous_default() {
        // Regression test: the Desktop used to hardcode USER_CHAR_LIMIT at 1375
        // regardless of what the user set in config.yaml. The Python backend
        // (MemoryStore in tools/memory_tool.py) reads user_char_limit from config
        // directly via agent_init.py. After fixing, the Desktop must also read
        // the configured value and pass it through unchanged.
        let home = tempfile::tempdir().unwrap();
        fs::write(
            home.path().join("config.yaml"),
            "memory:
  user_char_limit: 10000
",
        )
        .unwrap();
        assert_eq!(configured_user_char_limit(home.path()), 10000);

        // Zero should be clamped to MIN
        fs::write(
            home.path().join("config.yaml"),
            "memory:
  user_char_limit: 0
",
        )
        .unwrap();
        assert_eq!(configured_user_char_limit(home.path()), MIN_USER_CHAR_LIMIT);
    }

    #[test]
    fn honors_both_limits_from_same_config() {
        // Integration-style test: config with both memory_char_limit and
        // user_char_limit must produce correct values from both readers.
        let home = tempfile::tempdir().unwrap();
        fs::write(
            home.path().join("config.yaml"),
            "memory:
  memory_char_limit: 20000
  user_char_limit: 10000
",
        )
        .unwrap();
        assert_eq!(configured_memory_char_limit(home.path()), 20000);
        assert_eq!(configured_user_char_limit(home.path()), 10000);
    }

    #[test]
    fn read_memory_returns_configured_limits() {
        // End-to-end regression test: read_memory_from_home() must return
        // char_limit values matching the configured limits, not hardcoded
        // defaults (8000 for memory, 1375 for user). This was the bug:
        // the Desktop used to clamp memory_char_limit at 8000 and hardcode
        // user_char_limit at 1375 instead of reading from config.yaml.
        let home = tempfile::tempdir().unwrap();

        // Create config with non-default limits
        fs::write(
            home.path().join("config.yaml"),
            "memory:
  memory_char_limit: 20000
  user_char_limit: 10000
",
        )
        .unwrap();

        // Create the memory directory and files so read_memory_from_home
        // can read them (the function calls read_file_safe which reads
        // from disk).
        let mem_dir = home.path().join("memories");
        fs::create_dir_all(&mem_dir).unwrap();
        fs::write(mem_dir.join("MEMORY.md"), "some memory content").unwrap();
        fs::write(mem_dir.join("USER.md"), "some user profile").unwrap();

        let info = read_memory_from_home(home.path());

        // The memory char_limit must come from config (20000), not 8000
        assert_eq!(
            info.memory.char_limit, 20000,
            "memory char_limit should read from config, not hardcoded max"
        );
        // The user char_limit must come from config (10000), not 1375
        assert_eq!(
            info.user.char_limit, 10000,
            "user char_limit should read from config, not hardcoded default"
        );
    }
}
