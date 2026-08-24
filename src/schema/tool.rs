//! Shared serde mirrors of the `@hermes/agent-tools` TypeScript types.
//!
//! Conventions (matching `src/schema/mod.rs`):
//! - `#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]`
//! - `#[serde(rename_all = "camelCase")]`
//! - `BTreeMap` for map-shaped fields (deterministic ordering)
//! - `Option<T>` + `#[serde(default)]` for optional / missing-tolerant fields
//! - No `deny_unknown_fields` (TS object shapes are open by default)

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// The `type` discriminator of an OpenAI-format tool definition.
pub const TOOL_TYPE_FUNCTION: &str = "function";

/// An OpenAI-format tool definition returned to the model.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ToolDefinition {
    /// Always `"function"` in the OpenAI wire shape.
    pub r#type: String,
    pub function: ToolFunction,
}

impl ToolDefinition {
    /// True when this is an OpenAI `function` tool definition.
    pub fn is_function(&self) -> bool {
        self.r#type == TOOL_TYPE_FUNCTION
    }
}

/// The `function` object nested inside a `ToolDefinition`.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ToolFunction {
    pub name: String,
    pub description: String,
    pub parameters: ToolParameterSchema,
}

/// A JSON-schema-shaped parameter definition (OpenAI function style).
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ToolParameterSchema {
    pub r#type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub properties: Option<BTreeMap<String, serde_json::Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub required: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub additional_properties: Option<serde_json::Value>,
    /// Passthrough for the TS index signature (`[key: string]: unknown`).
    #[serde(flatten, default)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

/// Static toolset definition (mirror of `ToolsetDef` in `types.ts`).
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ToolsetDef {
    pub description: String,
    /// Direct tool names belonging to this toolset.
    pub tools: Vec<String>,
    /// Other toolset keys to include recursively.
    pub includes: Vec<String>,
    /// High-level category this toolset belongs to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    /// Optional filter tags surfaced in the catalog.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
    /// Whether this is a posture/coding toolset.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub posture: Option<bool>,
    /// Source module hint (informational).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub module: Option<String>,
    /// True for workflow-gated toolsets not enabled by `all`/`*`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workflow_gate: Option<bool>,
}

/// Custom toolset persisted in config.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CustomToolset {
    pub name: String,
    pub tools: Vec<String>,
    pub includes: Vec<String>,
    pub description: String,
}

/// Human-readable metadata for a tool category.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ToolCategory {
    pub id: String,
    pub label_zh: String,
    pub label_en: String,
    pub icon: String,
    pub description: String,
    /// Toolset keys that belong to this category.
    pub toolsets: Vec<String>,
    /// Alternative names users may type.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub aliases: Option<Vec<String>>,
}

/// The `agent` block of a config object (mirror of `agent?: { disabled_toolsets }`).
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub disabled_toolsets: Option<Vec<String>>,
}

/// Minimal config shape consumed by `platform-config.ts`.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ToolConfigLike {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub platform_toolsets: Option<BTreeMap<String, Vec<String>>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub known_plugin_toolsets: Option<BTreeMap<String, Vec<String>>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub known_builtin_toolsets: Option<BTreeMap<String, Vec<String>>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<AgentConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom_toolsets: Option<BTreeMap<String, CustomToolset>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mcp_servers: Option<BTreeMap<String, serde_json::Value>>,
}

/// Shape returned by `getPlatformTools` / `platform_tools_resolve`.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct PlatformToolsResult {
    pub platform: String,
    pub enabled: Vec<String>,
    pub disabled: Vec<String>,
    pub known_plugin_toolsets: BTreeMap<String, Vec<String>>,
    pub known_builtin_toolsets: BTreeMap<String, Vec<String>>,
}

/// Result shape returned by every tool handler.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ToolResult {
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_error: Option<bool>,
}

/// Shape returned by the public tool-call dispatcher.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallOutcome {
    pub name: String,
    pub arguments: serde_json::Value,
    pub result: ToolResult,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    #[test]
    fn tool_definition_round_trips() {
        let json = serde_json::json!({
            "type": "function",
            "function": {
                "name": "todo",
                "description": "Manage a persistent todo list.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "action": { "type": "string", "enum": ["add", "list"] },
                        "content": { "type": "string" }
                    },
                    "required": ["action"],
                    "additionalProperties": false
                }
            }
        });
        let def: ToolDefinition = serde_json::from_value(json.clone()).unwrap();
        assert!(def.is_function());
        assert_eq!(def.function.name, "todo");
        let round: serde_json::Value = serde_json::to_value(&def).unwrap();
        assert_eq!(round, json);
    }

    #[test]
    fn tool_parameter_schema_keeps_extra_fields() {
        let json = serde_json::json!({
            "type": "object",
            "properties": { "a": { "type": "string" } },
            "required": ["a"],
            "additionalProperties": false,
            "customExtra": { "deep": true }
        });
        let schema: ToolParameterSchema = serde_json::from_value(json.clone()).unwrap();
        assert_eq!(schema.r#type, "object");
        assert_eq!(
            schema.extra.get("customExtra").cloned(),
            Some(serde_json::json!({"deep": true}))
        );
        let round: serde_json::Value = serde_json::to_value(&schema).unwrap();
        assert_eq!(round, json);
    }

    #[test]
    fn toolset_def_round_trips() {
        let json = serde_json::json!({
            "description": "Core reasoning & control tools",
            "tools": ["todo", "clarify"],
            "includes": [],
            "category": "orchestration",
            "workflowGate": true
        });
        let def: ToolsetDef = serde_json::from_value(json.clone()).unwrap();
        assert_eq!(def.workflow_gate, Some(true));
        assert_eq!(def.category.as_deref(), Some("orchestration"));
        let round: serde_json::Value = serde_json::to_value(&def).unwrap();
        assert_eq!(round, json);
    }

    #[test]
    fn custom_toolset_round_trips() {
        let json = serde_json::json!({
            "name": "ops",
            "tools": ["terminal_run"],
            "includes": ["core"],
            "description": "ops bundle"
        });
        let def: CustomToolset = serde_json::from_value(json.clone()).unwrap();
        let round: serde_json::Value = serde_json::to_value(&def).unwrap();
        assert_eq!(round, json);
    }

    #[test]
    fn tool_config_like_round_trips_camel_case() {
        let json = serde_json::json!({
            "platformToolsets": { "cli": ["hermes_cli"] },
            "knownPluginToolsets": { "p": ["x"] },
            "knownBuiltinToolsets": { "b": ["y"] },
            "agent": { "disabledToolsets": ["web"] },
            "customToolsets": {
                "ops": { "name": "ops", "tools": [], "includes": [], "description": "" }
            },
            "mcpServers": { "s": { "url": "http://localhost" } }
        });
        let cfg: ToolConfigLike = serde_json::from_value(json.clone()).unwrap();
        assert_eq!(
            cfg.platform_toolsets.as_ref().unwrap().get("cli"),
            Some(&vec!["hermes_cli".to_string()])
        );
        let round: serde_json::Value = serde_json::to_value(&cfg).unwrap();
        assert_eq!(round, json);
    }

    #[test]
    fn platform_tools_result_round_trips() {
        let json = serde_json::json!({
            "platform": "cli",
            "enabled": ["core", "file"],
            "disabled": ["web"],
            "knownPluginToolsets": {},
            "knownBuiltinToolsets": {}
        });
        let res: PlatformToolsResult = serde_json::from_value(json.clone()).unwrap();
        let round: serde_json::Value = serde_json::to_value(&res).unwrap();
        assert_eq!(round, json);
    }

    #[test]
    fn tool_call_outcome_round_trips() {
        let json = serde_json::json!({
            "name": "todo",
            "arguments": { "action": "add", "content": "x" },
            "result": { "content": "todo add: x" },
            "durationMs": 42
        });
        let out: ToolCallOutcome = serde_json::from_value(json.clone()).unwrap();
        assert_eq!(out.duration_ms, Some(42));
        let round: serde_json::Value = serde_json::to_value(&out).unwrap();
        assert_eq!(round, json);
    }

    #[test]
    fn tool_category_round_trips() {
        let json = serde_json::json!({
            "id": "orchestration",
            "labelZh": "编排",
            "labelEn": "Orchestration",
            "icon": "🧭",
            "description": "Orchestration tools",
            "toolsets": ["core"],
            "aliases": ["todo"]
        });
        let cat: ToolCategory = serde_json::from_value(json.clone()).unwrap();
        let round: serde_json::Value = serde_json::to_value(&cat).unwrap();
        assert_eq!(round, json);
    }
}
