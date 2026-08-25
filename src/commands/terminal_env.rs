//! Terminal environment backend Tauri commands.
//!
//! Stubs for Docker/SSH/Singularity/Modal/Daytona/Vercel sandbox execution;
//! local interactive sessions stay in `terminal.rs` (portable-pty). The
//! `terminal_backends` command surfaces backend availability so the settings
//! UI can show which sandbox backends are configured; real exec stays in the
//! managed Python runtime.

use serde::{Deserialize, Serialize};
use tauri::command;

/// Backend descriptor surfaced to the settings UI (P1-11).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalBackendInfo {
    pub kind: String,
    pub name: String,
    /// True when the backend binary/CLI is present on PATH.
    pub available: bool,
    /// Human-readable config hint (e.g. SSH target).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config: Option<String>,
}

fn binary_on_path(binary: &str) -> bool {
    let path = std::env::var_os("PATH").unwrap_or_default();
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(binary);
        if candidate.is_file() {
            return true;
        }
        #[cfg(target_os = "windows")]
        {
            for ext in ["exe", "cmd", "bat"] {
                if dir.join(format!("{binary}.{ext}")).is_file() {
                    return true;
                }
            }
        }
    }
    false
}

/// The 7 Python `tools/environments/` backends.
pub fn known_terminal_backends() -> Vec<TerminalBackendInfo> {
    let docker = binary_on_path("docker");
    let ssh = binary_on_path("ssh");
    vec![
        TerminalBackendInfo {
            kind: "local".into(),
            name: "Local".into(),
            available: true,
            config: None,
        },
        TerminalBackendInfo {
            kind: "docker".into(),
            name: "Docker".into(),
            available: docker,
            config: docker.then(|| "docker CLI detected".into()),
        },
        TerminalBackendInfo {
            kind: "ssh".into(),
            name: "SSH".into(),
            available: ssh,
            config: ssh.then(|| "ssh CLI detected".into()),
        },
        TerminalBackendInfo {
            kind: "singularity".into(),
            name: "Singularity".into(),
            available: binary_on_path("singularity"),
            config: None,
        },
        TerminalBackendInfo {
            kind: "modal".into(),
            name: "Modal".into(),
            available: binary_on_path("modal"),
            config: None,
        },
        TerminalBackendInfo {
            kind: "daytona".into(),
            name: "Daytona".into(),
            available: binary_on_path("daytona"),
            config: None,
        },
        TerminalBackendInfo {
            kind: "vercel".into(),
            name: "Vercel Sandbox".into(),
            available: binary_on_path("vercel"),
            config: None,
        },
    ]
}

/// `terminal_backends` — list available terminal/sandbox backends.
#[command]
pub fn terminal_backends() -> Vec<TerminalBackendInfo> {
    known_terminal_backends()
}

/// `terminal_backend_status` — status of one backend by kind.
#[command]
pub fn terminal_backend_status(kind: String) -> Result<TerminalBackendInfo, String> {
    known_terminal_backends()
        .into_iter()
        .find(|b| b.kind == kind)
        .ok_or_else(|| format!("unknown terminal backend '{kind}'"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backends_cover_the_seven_environments() {
        let backends = known_terminal_backends();
        assert_eq!(backends.len(), 7);
        let kinds: Vec<&str> = backends.iter().map(|b| b.kind.as_str()).collect();
        for expected in [
            "local",
            "docker",
            "ssh",
            "singularity",
            "modal",
            "daytona",
            "vercel",
        ] {
            assert!(kinds.contains(&expected), "missing {expected}");
        }
        assert!(backends[0].available); // local is always available
    }

    #[test]
    fn status_resolves_known_kind_and_rejects_unknown() {
        assert_eq!(
            terminal_backend_status("docker".into()).unwrap().kind,
            "docker"
        );
        assert!(terminal_backend_status("nope".into()).is_err());
    }
}

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
