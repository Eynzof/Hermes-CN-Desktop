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
}
