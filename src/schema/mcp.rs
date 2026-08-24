//! Serde mirror of `@hermes/protocol/src/mcp.ts` plus the MCP stdio process
//! args/events used by `src/commands/mcp.rs`.
//!
//! Most wire names are `camelCase` (`toolCount`, `childId`, `graceMs`).

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::schema::util;

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum McpTransportType {
    Stdio,
    Sse,
    Http,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub enum McpServerStatus {
    #[serde(rename = "pending")]
    Pending,
    #[serde(rename = "connecting")]
    Connecting,
    #[serde(rename = "connected")]
    Connected,
    #[serde(rename = "failed")]
    Failed,
    #[serde(rename = "disabled")]
    Disabled,
    #[serde(rename = "needs-auth")]
    NeedsAuth,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct McpServerTools {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub include: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exclude: Option<Vec<String>>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct McpServerConfig {
    pub name: String,
    pub transport: McpTransportType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub args: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env: Option<HashMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub headers: Option<HashMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tools: Option<McpServerTools>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lazy: Option<bool>,
    #[serde(
        default = "util::default_true",
        skip_serializing_if = "util::is_default_true"
    )]
    pub enabled: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct McpServerEntry {
    pub name: String,
    pub config: McpServerConfig,
    pub status: McpServerStatus,
    #[serde(default)]
    pub tool_count: usize,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct McpTestResult {
    pub ok: bool,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<String>>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct McpToolCallRequest {
    pub server: String,
    pub tool: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arguments: Option<serde_json::Value>,
}

// ── MCP stdio process bridge command args/events ─────────────────────────────

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct McpStdioDataEvent {
    pub child_id: String,
    pub bytes: Vec<u8>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct McpStdioExitEvent {
    pub child_id: String,
    pub code: Option<i32>,
    pub stderr_tail: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct McpStdioSpawnArgs {
    pub name: String,
    pub command: String,
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct McpStdioWriteArgs {
    pub child_id: String,
    pub bytes: Vec<u8>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct McpStdioKillArgs {
    pub child_id: String,
    pub grace_ms: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mcp_stdio_spawn_args_round_trips() {
        let v = serde_json::json!({
            "name": "filesystem",
            "command": "npx",
            "args": ["-y", "@modelcontextprotocol/server-filesystem"],
            "env": {"NODE_ENV": "production"},
            "cwd": "/workspace"
        });
        let a: McpStdioSpawnArgs = serde_json::from_value(v.clone()).unwrap();
        assert_eq!(a.name, "filesystem");
        assert_eq!(a.env["NODE_ENV"], "production");
        assert_eq!(serde_json::to_value(&a).unwrap(), v);
    }

    #[test]
    fn mcp_stdio_spawn_args_defaults_env_empty() {
        let a: McpStdioSpawnArgs = serde_json::from_value(serde_json::json!({
            "name": "filesystem", "command": "npx", "args": []
        }))
        .unwrap();
        assert!(a.env.is_empty());
        assert_eq!(a.cwd, None);
    }

    #[test]
    fn mcp_stdio_data_and_exit_events_round_trip() {
        let v = serde_json::json!({ "childId": "c1", "bytes": [1, 2, 3] });
        let e: McpStdioDataEvent = serde_json::from_value(v.clone()).unwrap();
        assert_eq!(e.child_id, "c1");
        assert_eq!(e.bytes, vec![1, 2, 3]);
        assert_eq!(serde_json::to_value(&e).unwrap(), v);

        let v2 = serde_json::json!({ "childId": "c1", "code": null, "stderrTail": "" });
        let e2: McpStdioExitEvent = serde_json::from_value(v2.clone()).unwrap();
        assert_eq!(e2.code, None);
        assert_eq!(serde_json::to_value(&e2).unwrap(), v2);
    }

    #[test]
    fn mcp_server_config_round_trips_camel_case() {
        let v = serde_json::json!({
            "name": "fs",
            "transport": "stdio",
            "command": "npx",
            "args": ["-y", "server"],
            "tools": { "include": ["read_file"], "exclude": [] },
            "lazy": true,
            "enabled": false
        });
        let c: McpServerConfig = serde_json::from_value(v.clone()).unwrap();
        assert_eq!(c.transport, McpTransportType::Stdio);
        assert_eq!(c.enabled, false);
        assert_eq!(
            c.tools.as_ref().unwrap().include,
            Some(vec!["read_file".to_string()])
        );
        assert_eq!(serde_json::to_value(&c).unwrap(), v);
    }

    #[test]
    fn mcp_server_entry_round_trips() {
        let v = serde_json::json!({
            "name": "fs",
            "config": {"name": "fs", "transport": "stdio"},
            "status": "connected",
            "toolCount": 3,
            "error": null
        });
        let e: McpServerEntry = serde_json::from_value(v.clone()).unwrap();
        assert_eq!(e.status, McpServerStatus::Connected);
        assert_eq!(e.tool_count, 3);
        assert_eq!(serde_json::to_value(&e).unwrap(), v);
    }
}
