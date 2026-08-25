//! Tauri IPC wrappers for the pure tool-kit resolvers.
//!
//! Registration in `src/main.rs` (via `generate_handler!`) is performed by a
//! separate task; these functions are the command bodies.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use crate::error::AppResult;
use crate::schema::tool::{CustomToolset, PlatformToolsResult, ToolConfigLike};
use crate::toolkit::{platform, toolsets};

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ToolsetsResolveInput {
    pub names: Vec<String>,
    #[serde(default)]
    pub custom_toolsets: BTreeMap<String, CustomToolset>,
    #[serde(default)]
    pub disabled: Vec<String>,
    #[serde(default)]
    pub registry_toolsets: Vec<String>,
    #[serde(default)]
    pub is_gui_session: bool,
    #[serde(default)]
    pub kanban_worker: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolsetsResolveOutput {
    pub tools: Vec<String>,
}

/// `toolsets_resolve` — resolve a set of toolset keys into tool names.
#[tauri::command]
pub fn toolsets_resolve(input: ToolsetsResolveInput) -> AppResult<ToolsetsResolveOutput> {
    let registry: BTreeSet<String> = input.registry_toolsets.into_iter().collect();
    let tools = toolsets::resolve_multiple_toolsets(
        &input.names,
        &input.custom_toolsets,
        &input.disabled,
        &registry,
        input.is_gui_session,
        input.kanban_worker,
    );
    Ok(ToolsetsResolveOutput {
        tools: tools.into_iter().collect(),
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformToolsResolveInput {
    pub config: ToolConfigLike,
    pub platform: String,
    #[serde(default)]
    pub opts: Option<platform::PlatformOpts>,
}

/// `platform_tools_resolve` — resolve effective enabled toolsets for a platform.
#[tauri::command]
pub fn platform_tools_resolve(input: PlatformToolsResolveInput) -> AppResult<PlatformToolsResult> {
    let opts = input.opts.unwrap_or_default();
    Ok(platform::get_platform_tools(
        &input.config,
        &input.platform,
        &opts,
    ))
}

// ---------------------------------------------------------------------------
// tools_dispatch — Rust IPC fallback for OS-level tools.
//
// `packages/agent-tools/src/dispatch.ts` routes tools in its `RUST_IPC_TOOLS`
// allow-list here when a Tauri invoker is present. The response shape matches
// the TS `normalizeRustResult` contract: `{ content: string, isError: bool }`.
// Tool-level failures are returned as `Ok(output { is_error: true })` so the TS
// caller receives a clean `ToolResult` instead of an IPC exception.
// ---------------------------------------------------------------------------

/// Maximum bytes accepted for `file_read` / `file_write` / `file_grep`.
const TOOL_FILE_MAX_BYTES: u64 = 1_000_000;
/// Maximum results returned by `file_search` / `file_grep`.
const TOOL_SEARCH_MAX_RESULTS: usize = 100;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolsDispatchInput {
    pub name: String,
    #[serde(default)]
    pub args: serde_json::Value,
    #[serde(default)]
    pub session_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolsDispatchOutput {
    pub content: String,
    pub is_error: bool,
}

impl ToolsDispatchOutput {
    fn ok(content: impl Into<String>) -> Self {
        Self {
            content: content.into(),
            is_error: false,
        }
    }

    fn error(message: impl Into<String>) -> Self {
        Self {
            content: message.into(),
            is_error: true,
        }
    }
}

fn unavailable_message(name: &str) -> String {
    format!(
        "tool '{name}' is not available through Rust tools_dispatch (no backing command; use the managed runtime or a native TS handler)"
    )
}

/// `tools_dispatch` — execute an OS-level tool through Rust IPC.
#[tauri::command]
pub async fn tools_dispatch(
    state: tauri::State<'_, crate::state::AppState>,
    input: ToolsDispatchInput,
) -> AppResult<ToolsDispatchOutput> {
    let args = input.args;
    let result = match input.name.as_str() {
        "file_list" => file_list_dispatch(&state, &args),
        "file_read" => file_read_dispatch(&args),
        "file_write" => file_write_dispatch(&args),
        "file_search" => file_search_dispatch(&args),
        "file_grep" => file_grep_dispatch(&args),
        "terminal_run" => terminal_run_dispatch(&args).await,
        "desktop_preview" => desktop_preview_dispatch(&state, &args),
        other => Err(unavailable_message(other)),
    };
    Ok(match result {
        Ok(content) => ToolsDispatchOutput::ok(content),
        Err(message) => ToolsDispatchOutput::error(message),
    })
}

fn arg_str(args: &serde_json::Value, key: &str) -> Result<String, String> {
    args.get(key)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| format!("missing string argument '{key}'"))
}

fn arg_u64(args: &serde_json::Value, key: &str) -> Option<u64> {
    args.get(key).and_then(|v| v.as_u64())
}

fn file_list_dispatch(
    state: &tauri::State<'_, crate::state::AppState>,
    args: &serde_json::Value,
) -> Result<String, String> {
    let path = args
        .get("path")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| ".".to_string());
    let input = crate::commands::fs::FsListInput { path };
    let response = crate::commands::fs::fs_list(state.clone(), input)
        .map_err(|e| format!("file_list failed: {e}"))?;
    serde_json::to_string(&response).map_err(|e| format!("file_list serialization failed: {e}"))
}

fn file_read_dispatch(args: &serde_json::Value) -> Result<String, String> {
    let path = arg_str(args, "path")?;
    let meta = std::fs::metadata(&path).map_err(|e| format!("file_read: {e}"))?;
    if !meta.is_file() {
        return Err(format!("file_read: '{path}' is not a regular file"));
    }
    if meta.len() > TOOL_FILE_MAX_BYTES {
        return Err(format!(
            "file_read: '{path}' exceeds the {} byte limit",
            TOOL_FILE_MAX_BYTES
        ));
    }
    let bytes = std::fs::read(&path).map_err(|e| format!("file_read: {e}"))?;
    // Apply optional line offset/limit on the text view, mirroring the tool's
    // `offset` / `limit` arguments.
    let text = String::from_utf8_lossy(&bytes);
    let offset = arg_u64(args, "offset").unwrap_or(0) as usize;
    let limit = arg_u64(args, "limit").map(|l| l as usize);
    let mut lines: Vec<&str> = text.lines().skip(offset).collect();
    if let Some(limit) = limit {
        lines.truncate(limit);
    }
    Ok(lines.join("\n"))
}

fn file_write_dispatch(args: &serde_json::Value) -> Result<String, String> {
    let path = arg_str(args, "path")?;
    let content = arg_str(args, "content")?;
    if content.len() as u64 > TOOL_FILE_MAX_BYTES {
        return Err(format!(
            "file_write: content exceeds the {} byte limit",
            TOOL_FILE_MAX_BYTES
        ));
    }
    if let Some(parent) = std::path::Path::new(&path).parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|e| format!("file_write: {e}"))?;
        }
    }
    std::fs::write(&path, content.as_bytes()).map_err(|e| format!("file_write: {e}"))?;
    Ok(format!("wrote {} bytes to {path}", content.len()))
}

fn file_search_dispatch(args: &serde_json::Value) -> Result<String, String> {
    let query = arg_str(args, "query")?.to_lowercase();
    let root = args
        .get("path")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| ".".to_string());
    let mut matches: Vec<String> = Vec::new();
    for entry in walkdir::WalkDir::new(&root)
        .follow_links(false)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        if !entry.file_type().is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_lowercase();
        if name.contains(&query) {
            matches.push(entry.path().to_string_lossy().to_string());
            if matches.len() >= TOOL_SEARCH_MAX_RESULTS {
                break;
            }
        }
    }
    serde_json::to_string(&matches).map_err(|e| format!("file_search serialization failed: {e}"))
}

fn file_grep_dispatch(args: &serde_json::Value) -> Result<String, String> {
    let pattern = arg_str(args, "pattern")?;
    let regex =
        regex::Regex::new(&pattern).map_err(|e| format!("file_grep: invalid regex: {e}"))?;
    let root = args
        .get("path")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| ".".to_string());
    let mut lines_out: Vec<String> = Vec::new();
    'outer: for entry in walkdir::WalkDir::new(&root)
        .follow_links(false)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        let Ok(meta) = std::fs::metadata(path) else {
            continue;
        };
        if meta.len() > TOOL_FILE_MAX_BYTES {
            continue;
        }
        let Ok(content) = std::fs::read_to_string(path) else {
            continue;
        };
        for (idx, line) in content.lines().enumerate() {
            if regex.is_match(line) {
                lines_out.push(format!(
                    "{}:{}:{}",
                    path.to_string_lossy(),
                    idx + 1,
                    line.chars().take(200).collect::<String>()
                ));
                if lines_out.len() >= TOOL_SEARCH_MAX_RESULTS {
                    break 'outer;
                }
            }
        }
    }
    Ok(lines_out.join("\n"))
}

async fn terminal_run_dispatch(args: &serde_json::Value) -> Result<String, String> {
    let command = arg_str(args, "command")?;
    let kind = args
        .get("kind")
        .and_then(|v| v.as_str())
        .unwrap_or("local")
        .to_string();
    let options = crate::commands::terminal_env::TerminalEnvExecOptions {
        kind,
        command,
        cwd: args.get("cwd").and_then(|v| v.as_str()).map(String::from),
        timeout: arg_u64(args, "timeout"),
    };
    let result = crate::commands::terminal_env::terminal_env_exec(options)
        .await
        .map_err(|e| format!("terminal_run failed: {e}"))?;
    Ok(result.output)
}

fn desktop_preview_dispatch(
    state: &tauri::State<'_, crate::state::AppState>,
    args: &serde_json::Value,
) -> Result<String, String> {
    let path = arg_str(args, "path")?;
    let input = crate::commands::preview::ReadFileDataUrlInput { path };
    crate::commands::preview::read_file_data_url(input, state.clone())
        .map_err(|e| format!("desktop_preview failed: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn toolsets_resolve_merges() {
        let input = ToolsetsResolveInput {
            names: vec!["core".to_string()],
            ..Default::default()
        };
        let out = toolsets_resolve(input).unwrap();
        assert!(out.tools.contains(&"todo".to_string()));
        assert!(out.tools.contains(&"clarify".to_string()));
    }

    #[test]
    fn platform_tools_resolve_defaults() {
        let input = PlatformToolsResolveInput {
            config: ToolConfigLike {
                platform_toolsets: Some(BTreeMap::from([(
                    "cli".to_string(),
                    vec!["hermes_cli".to_string()],
                )])),
                ..Default::default()
            },
            platform: "cli".to_string(),
            opts: None,
        };
        let out = platform_tools_resolve(input).unwrap();
        assert!(out.enabled.contains(&"hermes_cli".to_string()));
        assert!(out.enabled.contains(&"core".to_string()));
    }

    // -- tools_dispatch helpers -------------------------------------------------

    #[test]
    fn file_read_missing_path_returns_error() {
        let err = file_read_dispatch(&serde_json::json!({})).unwrap_err();
        assert!(err.contains("missing string argument 'path'"));
    }

    #[test]
    fn file_read_missing_file_returns_error() {
        let err = file_read_dispatch(&serde_json::json!({ "path": "/definitely/missing/file" }))
            .unwrap_err();
        assert!(err.contains("file_read:"));
    }

    #[test]
    fn file_write_round_trip() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("sub").join("hello.txt");
        let path_str = path.to_string_lossy().to_string();

        let ok = file_write_dispatch(&serde_json::json!({
            "path": path_str,
            "content": "hello world"
        }))
        .unwrap();
        assert!(ok.contains("wrote 11 bytes"));

        let read = file_read_dispatch(&serde_json::json!({ "path": path_str })).unwrap();
        assert_eq!(read, "hello world");
    }

    #[test]
    fn file_read_offset_limit() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("lines.txt");
        let path_str = path.to_string_lossy().to_string();
        std::fs::write(&path, "a\nb\nc\nd\n").unwrap();

        let read = file_read_dispatch(&serde_json::json!({
            "path": path_str,
            "offset": 1,
            "limit": 2
        }))
        .unwrap();
        assert_eq!(read, "b\nc");
    }

    #[test]
    fn file_grep_finds_match() {
        let dir = tempfile::TempDir::new().unwrap();
        std::fs::write(dir.path().join("a.txt"), "alpha\nbeta\n").unwrap();
        std::fs::write(dir.path().join("b.txt"), "gamma\n").unwrap();

        let out = file_grep_dispatch(&serde_json::json!({
            "pattern": "beta",
            "path": dir.path().to_string_lossy()
        }))
        .unwrap();
        assert!(out.contains("a.txt:2:beta"));
        assert!(!out.contains("b.txt"));
    }

    #[test]
    fn file_search_finds_by_name() {
        let dir = tempfile::TempDir::new().unwrap();
        std::fs::write(dir.path().join("Report.md"), "x").unwrap();
        std::fs::write(dir.path().join("notes.txt"), "y").unwrap();

        let out = file_search_dispatch(&serde_json::json!({
            "query": "report",
            "path": dir.path().to_string_lossy()
        }))
        .unwrap();
        let matches: Vec<String> = serde_json::from_str(&out).unwrap();
        assert_eq!(matches.len(), 1);
        assert!(matches[0].ends_with("Report.md"));
    }

    #[test]
    fn unknown_tool_maps_to_is_error() {
        let message = unavailable_message("nope");
        assert!(message.contains("not available through Rust tools_dispatch"));

        // ToolsDispatchOutput::error is what the command returns for unknown
        // names — verify it carries the honest gap message as an error result.
        let output = ToolsDispatchOutput::error(unavailable_message("nope"));
        assert!(output.is_error);
        assert!(output.content.contains("not available"));
    }
}
