//! Terminal environment backend Tauri commands.
//!
//! Stubs for Docker/SSH/Singularity/Modal/Daytona/Vercel sandbox execution;
//! local interactive sessions stay in `terminal.rs` (portable-pty).

use serde::{Deserialize, Serialize};
use tauri::command;

#[derive(Debug, Clone, Deserialize)]
pub struct TerminalEnvExecOptions {
    pub kind: String,
    pub command: String,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub timeout: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TerminalEnvExecResult {
    pub output: String,
    pub exit_code: i32,
    pub degraded: bool,
    pub retry_hint: String,
}

#[command]
pub async fn terminal_env_exec(
    options: TerminalEnvExecOptions,
) -> Result<TerminalEnvExecResult, String> {
    Ok(TerminalEnvExecResult {
        output: format!("[{}] would execute: {}", options.kind, options.command),
        exit_code: 0,
        degraded: true,
        retry_hint: "Use the managed Python runtime for full backend support".to_string(),
    })
}

#[derive(Debug, Clone, Deserialize)]
pub struct TerminalEnvSessionOptions {
    pub kind: String,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub shell: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TerminalEnvSessionResult {
    pub session_id: String,
    pub kind: String,
}

#[command]
pub async fn terminal_env_create_session(
    options: TerminalEnvSessionOptions,
) -> Result<TerminalEnvSessionResult, String> {
    Ok(TerminalEnvSessionResult {
        session_id: format!(
            "{}-{}",
            options.kind,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0)
        ),
        kind: options.kind,
    })
}

#[command]
pub async fn terminal_env_cleanup(kind: String, task_id: Option<String>) -> Result<(), String> {
    let _ = (kind, task_id);
    Ok(())
}
