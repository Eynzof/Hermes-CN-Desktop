//! Thin CLI wrapper commands.
//!
//! Spawns the managed `hermes` binary for commands that have no desktop UI
//! equivalent (e.g. `version`, `completion`). The webview never spawns shells
//! directly — all stdio goes through Rust.

use std::process::Stdio;

use serde::{Deserialize, Serialize};
use tokio::io::AsyncReadExt;
use tokio::process::Command;

use crate::error::AppError;
use crate::process::runtime;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliSpawnInput {
    pub argv: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliSpawnResult {
    pub ok: bool,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CliResolvedFlags {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub toolsets: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resume: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skills: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub yolo: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub continue_session: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_file: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub oneshot: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage_file: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliResolveInput {
    pub argv: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliResolveResult {
    pub command: String,
    pub positional: Vec<String>,
    pub flags: CliResolvedFlags,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub one_shot_prompt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage_file: Option<String>,
}

/// Spawn the managed `hermes` binary with the supplied arguments.
///
/// If no managed runtime is installed, returns an error result. Stdout/stderr
/// are captured and returned as UTF-8 (lossy for invalid bytes).
#[tauri::command]
pub async fn cli_spawn(input: CliSpawnInput) -> Result<CliSpawnResult, AppError> {
    let info = runtime::get_runtime_info(None);
    let executable = match info.current {
        Some(record) => record.executable_path,
        None => {
            return Ok(CliSpawnResult {
                ok: false,
                exit_code: None,
                stdout: String::new(),
                stderr: String::new(),
                error: Some("Managed runtime not installed".to_string()),
            });
        }
    };

    let mut child = Command::new(&executable)
        .args(&input.argv)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null())
        .spawn()
        .map_err(|err| AppError::Internal(format!("failed to spawn hermes CLI: {err}")))?;

    let mut stdout_pipe = child
        .stdout
        .take()
        .ok_or_else(|| AppError::Internal("missing stdout".to_string()))?;
    let mut stderr_pipe = child
        .stderr
        .take()
        .ok_or_else(|| AppError::Internal("missing stderr".to_string()))?;

    let mut stdout_bytes = Vec::new();
    let mut stderr_bytes = Vec::new();

    let (stdout_res, stderr_res, status_res) = tokio::join!(
        async { stdout_pipe.read_to_end(&mut stdout_bytes).await },
        async { stderr_pipe.read_to_end(&mut stderr_bytes).await },
        async { child.wait().await },
    );

    stdout_res.map_err(|err| AppError::Internal(format!("stdout read failed: {err}")))?;
    stderr_res.map_err(|err| AppError::Internal(format!("stderr read failed: {err}")))?;

    let stdout = String::from_utf8_lossy(&stdout_bytes).to_string();
    let stderr = String::from_utf8_lossy(&stderr_bytes).to_string();

    let exit_code = match status_res {
        Ok(status) => status.code(),
        Err(err) => {
            return Ok(CliSpawnResult {
                ok: false,
                exit_code: None,
                stdout,
                stderr,
                error: Some(format!("wait failed: {err}")),
            });
        }
    };

    let ok = exit_code == Some(0);
    let error = if ok {
        None
    } else {
        stderr
            .lines()
            .next()
            .map(|s| s.to_string())
            .or_else(|| Some("hermes CLI failed".to_string()))
    };

    Ok(CliSpawnResult {
        ok,
        exit_code,
        stdout,
        stderr,
        error,
    })
}

/// Parse a `hermes <cmd>` style argv into a structured result.
///
/// Mirrors the frontend `parseCliArgv` and gives the Rust side a way to resolve
/// CLI commands passed from the OS (deep links, Console quick-actions) without
/// spawning a managed runtime.
#[tauri::command]
pub fn cli_resolve_command(input: CliResolveInput) -> Result<CliResolveResult, AppError> {
    let argv = input.argv;
    let mut positional: Vec<String> = Vec::new();
    let mut flags = CliResolvedFlags::default();
    let mut one_shot_prompt: Option<String> = None;
    let mut usage_file: Option<String> = None;

    let mut i = 0;
    while i < argv.len() {
        let tok = &argv[i];

        // Split `--flag=value` / `-f=value` forms into key + inline value.
        let (key, mut eq_value) = if let Some(eq) = tok.find('=') {
            (tok[..eq].to_string(), Some(tok[eq + 1..].to_string()))
        } else {
            (tok.clone(), None)
        };

        let mut consume_value = || {
            if let Some(value) = eq_value.take() {
                i += 1;
                Some(value)
            } else if let Some(next) = argv.get(i + 1) {
                if !next.starts_with('-') {
                    i += 2;
                    Some(next.clone())
                } else {
                    i += 1;
                    None
                }
            } else {
                i += 1;
                None
            }
        };

        if key == "-z" || key == "--oneshot" {
            i += 1;
            let rest = argv[i..].join(" ");
            one_shot_prompt = Some(rest.clone());
            flags.oneshot = Some(rest);
            break;
        }
        if key == "-q" {
            flags.oneshot = Some("".to_string());
            i += 1;
            continue;
        }
        if key == "--usage-file" {
            let value = consume_value().unwrap_or_default();
            usage_file = Some(value.clone());
            flags.usage_file = Some(value);
            continue;
        }
        if key == "-m" || key == "--model" {
            flags.model = consume_value();
            continue;
        }
        if key == "--provider" {
            flags.provider = consume_value();
            continue;
        }
        if key == "--reasoning" {
            flags.reasoning = consume_value();
            continue;
        }
        if key == "-t" || key == "--toolsets" || key == "--tools" {
            flags.toolsets = consume_value();
            continue;
        }
        if key == "-r" || key == "--resume" {
            flags.resume = consume_value();
            continue;
        }
        if key == "-s" || key == "--skills" {
            flags.skills = consume_value();
            continue;
        }
        if key == "-p" || key == "--profile" {
            flags.profile = consume_value();
            continue;
        }
        if key == "-w" || key == "--worktree" {
            flags.worktree = consume_value();
            continue;
        }
        if key == "--yolo" {
            flags.yolo = Some(true);
            i += 1;
            continue;
        }
        if key == "-c" || key == "--continue" {
            flags.continue_session = consume_value();
            continue;
        }
        if key == "--in" {
            flags.input_file = consume_value();
            continue;
        }
        if key.starts_with('-') {
            // Unknown flag: consume value if present, otherwise boolean.
            let _ = consume_value();
            continue;
        }
        positional.push(tok.clone());
        i += 1;
    }

    // When the binary name is followed by a real subcommand, treat the
    // subcommand as the canonical command; otherwise keep the binary token
    // (e.g. `hermes -z prompt` has no subcommand).
    let command =
        if positional.len() >= 2 && positional.first().map(|s| s.as_str()) == Some("hermes") {
            positional.remove(0);
            positional.remove(0)
        } else if !positional.is_empty() {
            positional.remove(0)
        } else {
            String::new()
        };

    Ok(CliResolveResult {
        command,
        positional,
        flags,
        one_shot_prompt,
        usage_file,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cli_spawn_input_serializes_camel_case() {
        let input = CliSpawnInput {
            argv: vec!["version".to_string(), "--json".to_string()],
        };
        let json = serde_json::to_string(&input).unwrap();
        assert!(json.contains("\"argv\""));
        assert!(json.contains("version"));
    }

    #[test]
    fn cli_spawn_result_reports_failure_without_runtime() {
        let result = CliSpawnResult {
            ok: false,
            exit_code: None,
            stdout: String::new(),
            stderr: String::new(),
            error: Some("Managed runtime not installed".to_string()),
        };
        assert!(!result.ok);
        assert!(result.error.is_some());
    }

    #[test]
    fn cli_resolve_command_extracts_command_and_flags() {
        let result = cli_resolve_command(CliResolveInput {
            argv: vec![
                "hermes".to_string(),
                "chat".to_string(),
                "-m".to_string(),
                "gpt-4".to_string(),
                "--provider".to_string(),
                "openai".to_string(),
                "--yolo".to_string(),
                "hello".to_string(),
                "world".to_string(),
            ],
        })
        .unwrap();
        assert_eq!(result.command, "chat");
        assert_eq!(result.positional, vec!["hello", "world"]);
        assert_eq!(result.flags.model, Some("gpt-4".to_string()));
        assert_eq!(result.flags.provider, Some("openai".to_string()));
        assert_eq!(result.flags.yolo, Some(true));
    }

    #[test]
    fn cli_resolve_command_extracts_oneshot_prompt() {
        let result = cli_resolve_command(CliResolveInput {
            argv: vec![
                "hermes".to_string(),
                "--usage-file=/tmp/usage.json".to_string(),
                "-z".to_string(),
                "write".to_string(),
                "a".to_string(),
                "test".to_string(),
            ],
        })
        .unwrap();
        assert_eq!(result.command, "hermes");
        assert_eq!(result.one_shot_prompt.as_deref(), Some("write a test"));
        assert_eq!(result.usage_file.as_deref(), Some("/tmp/usage.json"));
        assert_eq!(result.flags.oneshot.as_deref(), Some("write a test"));
    }

    #[test]
    fn cli_resolve_command_treats_lonely_dash_q_as_oneshot() {
        let result = cli_resolve_command(CliResolveInput {
            argv: vec!["hermes".to_string(), "-q".to_string()],
        })
        .unwrap();
        assert_eq!(result.flags.oneshot, Some("".to_string()));
    }
}
