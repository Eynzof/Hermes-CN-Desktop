// Local-first dashboard summary endpoints.
//
// Mirrors the fork-only Python routes that are config-derived and safe to serve
// from the desktop shell without the managed Python runtime:
//   GET /api/mcp-servers
//   GET/PUT /api/profiles/active
//   GET /api/memory/providers/{name}/status
//   GET /api/providers/oauth

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands::profiles::{read_active_profile_sticky, write_active_profile_sticky};
use crate::error::{AppError, AppResult};
use crate::state::AppState;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerSummary {
    pub name: String,
    pub enabled: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServersResponse {
    pub summary: McpServersSummary,
    pub servers: Vec<McpServerSummary>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServersSummary {
    pub total: usize,
    pub enabled: usize,
}

fn hermes_home_base(state: &State<'_, AppState>) -> AppResult<String> {
    let inner = state.inner.lock()?;
    Ok(inner.hermes_home_base.clone())
}

fn read_config_yaml(state: &State<'_, AppState>) -> AppResult<serde_yaml::Value> {
    let base = hermes_home_base(state)?;
    let path = PathBuf::from(&base).join("config.yaml");
    if !path.exists() {
        return Ok(serde_yaml::Value::Mapping(serde_yaml::Mapping::new()));
    }
    let text = fs::read_to_string(&path)?;
    serde_yaml::from_str(&text)
        .map_err(|e| AppError::FileError(format!("Failed to parse config.yaml: {}", e)))
}

/// GET /api/mcp-servers
#[tauri::command]
pub fn mcp_servers_summary(state: State<'_, AppState>) -> Result<McpServersResponse, AppError> {
    let config = read_config_yaml(&state)?;
    let servers = config
        .get("mcp_servers")
        .and_then(|v| v.as_mapping())
        .map(|m| {
            m.iter()
                .map(|(k, v)| {
                    let name = k.as_str().unwrap_or("unknown").to_string();
                    let enabled = v.get("enabled").and_then(|e| e.as_bool()).unwrap_or(true);
                    McpServerSummary { name, enabled }
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let total = servers.len();
    let enabled = servers.iter().filter(|s| s.enabled).count();

    Ok(McpServersResponse {
        summary: McpServersSummary { total, enabled },
        servers,
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveProfileResponse {
    pub name: String,
    pub active: String,
    pub current: String,
}

/// GET /api/profiles/active
#[tauri::command]
pub fn active_profile_get(state: State<'_, AppState>) -> Result<ActiveProfileResponse, AppError> {
    let base = hermes_home_base(&state)?;
    let active = read_active_profile_sticky(&base);
    let current = {
        let inner = state.inner.lock()?;
        inner.current_profile.clone()
    };
    Ok(ActiveProfileResponse {
        name: active.clone(),
        active: active.clone(),
        current,
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveProfileSetInput {
    pub name: String,
}

/// PUT /api/profiles/active
#[tauri::command]
pub fn active_profile_set(
    state: State<'_, AppState>,
    input: ActiveProfileSetInput,
) -> Result<ActiveProfileResponse, AppError> {
    let base = hermes_home_base(&state)?;
    let name = input.name.trim();
    if name.is_empty() {
        return Err(AppError::InvalidRequest("Profile name cannot be empty".to_string()));
    }
    write_active_profile_sticky(&base, name);
    let inner = state.inner.lock()?;
    let current = inner.current_profile.clone();
    Ok(ActiveProfileResponse {
        name: name.to_string(),
        active: name.to_string(),
        current,
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryProviderRuntimeStatusResponse {
    pub provider: String,
    pub active: bool,
    pub configured: bool,
    pub reachable: bool,
    pub healthy: bool,
    pub endpoint: String,
    pub console_url: String,
    pub version: String,
    pub checked_at: String,
    pub error: String,
    pub details: Option<serde_json::Value>,
}

/// GET /api/memory/providers/{name}/status
#[tauri::command]
pub fn memory_provider_status(
    state: State<'_, AppState>,
    provider: String,
) -> Result<MemoryProviderRuntimeStatusResponse, AppError> {
    let config = read_config_yaml(&state)?;
    let active = config
        .get("memory")
        .and_then(|m| m.get("provider"))
        .and_then(|p| p.as_str())
        .map(|p| p == provider)
        .unwrap_or(false);

    let configured = config
        .get("memory")
        .and_then(|m| m.get("providers"))
        .and_then(|p| p.get(&provider))
        .is_some();

    Ok(MemoryProviderRuntimeStatusResponse {
        provider,
        active,
        configured,
        reachable: false,
        healthy: false,
        endpoint: String::new(),
        console_url: String::new(),
        version: String::new(),
        checked_at: String::new(),
        error: "In-process status probe not implemented in v1".to_string(),
        details: None,
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthProviderSummary {
    pub id: String,
    pub name: String,
    pub flow: Option<String>,
    pub cli_command: Option<String>,
    pub docs_url: Option<String>,
    pub status: OAuthProviderStatus,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthProviderStatus {
    pub logged_in: bool,
    pub source: Option<String>,
    pub source_label: Option<String>,
    pub token_preview: Option<String>,
    pub expires_at: Option<String>,
    pub has_refresh_token: Option<bool>,
    pub last_refresh: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthProvidersResponse {
    pub providers: Vec<OAuthProviderSummary>,
}

fn display_name_for_provider(id: &str) -> String {
    match id {
        "anthropic" => "Anthropic".to_string(),
        "openai" => "OpenAI".to_string(),
        "google" => "Google".to_string(),
        "alibaba" => "Alibaba".to_string(),
        "deepseek" => "DeepSeek".to_string(),
        "kimi" => "Kimi".to_string(),
        _ => id.to_string(),
    }
}

/// GET /api/providers/oauth
///
/// v1 in-process status sniffer: inspects config.yaml env entries for provider
/// API keys and returns a minimal OAuthProvider-compatible shape. This matches
/// the frozen `OAuthProvidersResponse` schema so hooks can validate the result.
#[tauri::command]
pub fn oauth_providers_status(
    state: State<'_, AppState>,
    _refresh: Option<bool>,
) -> Result<OAuthProvidersResponse, AppError> {
    let config = read_config_yaml(&state)?;
    let env = config.get("env").and_then(|v| v.as_mapping());

    let known = ["anthropic", "openai", "google", "alibaba", "deepseek", "kimi"];
    let providers: Vec<OAuthProviderSummary> = known
        .iter()
        .map(|id| {
            let key = format!("{}_API_KEY", id.to_uppercase());
            let configured = env
                .and_then(|m| m.get(&serde_yaml::Value::String(key)))
                .and_then(|v| v.as_str())
                .map(|s| !s.is_empty())
                .unwrap_or(false);
            let source = if configured { Some("env".to_string()) } else { None };
            OAuthProviderSummary {
                id: id.to_string(),
                name: display_name_for_provider(id),
                flow: None,
                cli_command: None,
                docs_url: None,
                status: OAuthProviderStatus {
                    logged_in: configured,
                    source,
                    source_label: None,
                    token_preview: None,
                    expires_at: None,
                    has_refresh_token: None,
                    last_refresh: None,
                    error: None,
                },
            }
        })
        .collect();

    Ok(OAuthProvidersResponse { providers })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_yaml;

    fn sample_config() -> serde_yaml::Value {
        serde_yaml::from_str(
            r#"
mcp_servers:
  filesystem:
    enabled: true
    command: npx
  fetch:
    enabled: false
    command: node
memory:
  provider: hindsight
  providers:
    hindsight:
      url: http://localhost:8000
env:
  ANTHROPIC_API_KEY: sk-xxx
"#,
        )
        .unwrap()
    }

    #[test]
    fn mcp_servers_parsed_from_yaml() {
        let config = sample_config();
        let servers = config
            .get("mcp_servers")
            .and_then(|v| v.as_mapping())
            .unwrap();
        assert_eq!(servers.len(), 2);
    }

    #[test]
    fn memory_active_provider_detected() {
        let config = sample_config();
        let active = config
            .get("memory")
            .and_then(|m| m.get("provider"))
            .and_then(|p| p.as_str())
            .unwrap();
        assert_eq!(active, "hindsight");
    }

    #[test]
    fn oauth_status_uses_env_mapping() {
        let config = sample_config();
        let env = config.get("env").and_then(|v| v.as_mapping()).unwrap();
        let key = env.get(&serde_yaml::Value::String("ANTHROPIC_API_KEY".to_string()));
        assert!(key.is_some());
    }

    #[test]
    fn oauth_provider_summary_matches_wire_shape() {
        let summary = OAuthProviderSummary {
            id: "anthropic".to_string(),
            name: "Anthropic".to_string(),
            flow: None,
            cli_command: None,
            docs_url: None,
            status: OAuthProviderStatus {
                logged_in: true,
                source: Some("env".to_string()),
                source_label: None,
                token_preview: None,
                expires_at: None,
                has_refresh_token: None,
                last_refresh: None,
                error: None,
            },
        };
        let json = serde_json::to_value(&summary).unwrap();
        assert_eq!(json["id"], "anthropic");
        assert_eq!(json["status"]["loggedIn"], true);
    }

    #[test]
    fn memory_status_serializes_empty_strings_for_missing_fields() {
        let status = MemoryProviderRuntimeStatusResponse {
            provider: "hindsight".to_string(),
            active: false,
            configured: false,
            reachable: false,
            healthy: false,
            endpoint: String::new(),
            console_url: String::new(),
            version: String::new(),
            checked_at: String::new(),
            error: "probe not implemented".to_string(),
            details: None,
        };
        let json = serde_json::to_value(&status).unwrap();
        assert_eq!(json["endpoint"], "");
        assert_eq!(json["error"], "probe not implemented");
    }
}
