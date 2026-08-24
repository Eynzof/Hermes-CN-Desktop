//! Serde mirror of `@hermes/protocol/src/lsp.ts` plus the LSP process
//! spawn/status structs used by `src/commands/lsp.rs`.
//!
//! Wire shapes are `camelCase` (`serverId`, `processKey`, `bytesBase64`,
//! `waitMode`, `initializationOptions`).

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::schema::util;

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LspPosition {
    pub line: u32,
    pub character: u32,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LspRange {
    pub start: LspPosition,
    pub end: LspPosition,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LspDiagnostic {
    pub severity: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    pub message: String,
    pub range: LspRange,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LspServerConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub disabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env: Option<HashMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub initialization_options: Option<serde_json::Value>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LspConfig {
    #[serde(default = "util::default_true")]
    pub enabled: bool,
    #[serde(default = "default_wait_mode")]
    pub wait_mode: String,
    #[serde(default)]
    pub wait_timeout: u64,
    #[serde(default = "default_install_strategy")]
    pub install_strategy: String,
    #[serde(default)]
    pub idle_timeout: u64,
    #[serde(default)]
    pub servers: HashMap<String, LspServerConfig>,
}

fn default_wait_mode() -> String {
    "document".to_string()
}
fn default_install_strategy() -> String {
    "manual".to_string()
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LspServerStatus {
    pub server_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub binary: Option<String>,
    pub installed: bool,
}

/// Rust command type: a spawned LSP process + its liveness.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LspProcessStatus {
    pub process_key: String,
    pub alive: bool,
}

/// Rust command arg: `lsp_spawn`.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LspSpawnArgs {
    pub server_id: String,
    pub command: String,
    pub args: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
}

/// Rust command arg: `lsp_write_stdin`.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LspWriteArgs {
    pub process_key: String,
    pub bytes_base64: String,
}

/// Rust command arg: `lsp_shutdown`.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LspShutdownArgs {
    pub process_key: String,
}

/// Rust command arg: `lsp_probe_binary`.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LspProbeArgs {
    pub name: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lsp_process_status_round_trips() {
        let v = serde_json::json!({ "processKey": "k-1", "alive": true });
        let s: LspProcessStatus = serde_json::from_value(v.clone()).unwrap();
        assert_eq!(s.process_key, "k-1");
        assert_eq!(serde_json::to_value(&s).unwrap(), v);
    }

    #[test]
    fn lsp_spawn_args_round_trips_camel_case() {
        let v = serde_json::json!({
            "serverId": "rust",
            "command": "rust-analyzer",
            "args": ["--stdin"],
            "cwd": "/workspace"
        });
        let s: LspSpawnArgs = serde_json::from_value(v.clone()).unwrap();
        assert_eq!(s.server_id, "rust");
        assert_eq!(s.cwd.as_deref(), Some("/workspace"));
        assert_eq!(serde_json::to_value(&s).unwrap(), v);
    }

    #[test]
    fn lsp_spawn_args_omits_cwd_when_absent() {
        let s = LspSpawnArgs {
            server_id: "rust".into(),
            command: "rust-analyzer".into(),
            args: vec![],
            cwd: None,
        };
        let out = serde_json::to_value(&s).unwrap();
        assert!(out.get("cwd").is_none());
    }

    #[test]
    fn lsp_server_status_round_trips() {
        let v =
            serde_json::json!({ "serverId": "rust", "binary": "rust-analyzer", "installed": true });
        let s: LspServerStatus = serde_json::from_value(v.clone()).unwrap();
        assert_eq!(s.server_id, "rust");
        assert_eq!(s.installed, true);
        assert_eq!(serde_json::to_value(&s).unwrap(), v);
    }

    #[test]
    fn lsp_config_defaults_and_null_vs_missing() {
        let cfg: LspConfig = serde_json::from_value(serde_json::json!({})).unwrap();
        assert!(cfg.enabled);
        assert_eq!(cfg.wait_mode, "document");
        assert_eq!(cfg.install_strategy, "manual");
        assert_eq!(cfg.wait_timeout, 0);
        assert!(cfg.servers.is_empty());

        let v = serde_json::json!({
            "enabled": false,
            "waitMode": "full",
            "waitTimeout": 10,
            "installStrategy": "auto",
            "idleTimeout": 600,
            "servers": {
                "rust": { "disabled": true, "command": ["rust-analyzer"], "initializationOptions": {"x": 1} }
            }
        });
        let cfg: LspConfig = serde_json::from_value(v.clone()).unwrap();
        assert_eq!(cfg.wait_mode, "full");
        assert_eq!(
            cfg.servers["rust"].initialization_options,
            Some(serde_json::json!({"x": 1}))
        );
        assert_eq!(serde_json::to_value(&cfg).unwrap(), v);
    }

    #[test]
    fn lsp_diagnostic_round_trips() {
        let v = serde_json::json!({
            "severity": 1,
            "code": "E0308",
            "source": "rustc",
            "message": "mismatched types",
            "range": { "start": {"line": 0, "character": 0}, "end": {"line": 0, "character": 1} }
        });
        let d: LspDiagnostic = serde_json::from_value(v.clone()).unwrap();
        assert_eq!(d.severity, 1);
        assert_eq!(serde_json::to_value(&d).unwrap(), v);
    }
}
