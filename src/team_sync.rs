//! Team enterprise configuration synchronisation.
//!
//! The Team launcher exposes the same manifest used by WorkBuddy at
//! `/api/workbuddy/sync`.  Hermes stores the result in its native
//! `config.yaml`/`skills` layout and keeps the device token in a private file
//! under the profile home.

use std::fs;
use std::io::{Cursor, Write};
use std::path::{Path, PathBuf};

use reqwest::Url;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zip::ZipArchive;

use crate::model_registry::{
    apply_managed_providers, clear_default_model_if_managed, managed_provider_id,
    migrate_legacy_config, set_default_model, ApiMode, ManagedModel, ManagedNamespace,
    ManagedProvider,
};

const TOKEN_FILE: &str = ".team-device-token";
const INVALID_TOKEN_FILE: &str = ".team-device-token-invalid";
const STATE_FILE: &str = ".team-sync-state.json";
const MAX_MANIFEST: usize = 10 * 1024 * 1024;
const MAX_SKILL: usize = 100 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TeamModel {
    pub id: String,
    pub name: String,
    pub vendor: Option<String>,
    pub url: String,
    pub model_type: Option<String>,
    pub max_input_tokens: Option<u64>,
    /// 下发清单显式声明该模型走 Anthropic Messages 协议。
    pub use_custom_protocol: Option<bool>,
    pub supports_tool_call: Option<bool>,
    pub supports_images: Option<bool>,
    pub supports_reasoning: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TeamSkill {
    pub id: String,
    pub workbuddy_id: Option<String>,
    pub name: String,
    pub version: Option<String>,
    pub sha256: String,
    pub size: Option<u64>,
    pub download_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TeamManifest {
    pub cleanup_only: bool,
    pub models: Vec<TeamModel>,
    pub default_model: Option<String>,
    pub skills: Vec<TeamSkill>,
}

#[derive(Debug, Deserialize)]
struct TeamManifestEnvelope {
    success: Option<bool>,
    message: Option<String>,
    data: Option<TeamManifest>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct SyncState {
    models: Vec<String>,
    skills: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamSyncStatus {
    pub configured: bool,
    pub invalidated: bool,
    pub synced_models: usize,
    pub synced_skills: usize,
}

fn token_path(home: &Path) -> PathBuf {
    home.join(TOKEN_FILE)
}

fn server_url() -> String {
    std::env::var("HERMES_TEAM_SERVER_URL")
        .unwrap_or_else(|_| crate::brand_generated::BRAND_TEAM_SERVICE_URL.to_string())
}

fn atomic_write(path: &Path, data: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "invalid target path".to_string())?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let tmp = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    tmp.as_file().write_all(data).map_err(|e| e.to_string())?;
    tmp.as_file().sync_all().ok();
    tmp.persist(path).map_err(|e| e.error.to_string())?;
    Ok(())
}

fn read_token(home: &Path) -> Option<String> {
    fs::read_to_string(token_path(home))
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn read_sync_state(home: &Path) -> Option<SyncState> {
    fs::read(home.join(STATE_FILE))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
}

fn status_for_home(home: &Path) -> TeamSyncStatus {
    let state = read_sync_state(home);
    TeamSyncStatus {
        // A token file is written before the network sync begins. Do not call
        // that a configured device unless the matching sync state was also
        // committed; otherwise one failed first-run attempt suppresses the
        // onboarding dialog forever.
        configured: read_token(home).is_some() && state.is_some(),
        invalidated: home.join(INVALID_TOKEN_FILE).is_file(),
        synced_models: state.as_ref().map_or(0, |value| value.models.len()),
        synced_skills: state.as_ref().map_or(0, |value| value.skills.len()),
    }
}

/// 判断模型是否走 Anthropic Messages 协议。
///
/// 与 `web/src/lib/enterprise-sync.ts` 的 `usesAnthropicMessages` 保持一致：
/// 清单显式声明优先，旧清单没有该字段时回退到两个 Messages-only 的品牌别名。
fn uses_anthropic_messages(model: &TeamModel) -> bool {
    if model.use_custom_protocol == Some(true) {
        return true;
    }
    let id = model.id.trim().to_ascii_lowercase();
    id == "claude-opus-4-8" || id == "kimi-k3"
}

/// Anthropic SDK 自己会补 `/v1/messages`。Team proxy 的地址是按 OpenAI 客户端
/// 习惯带 `/v1` 后缀发布的，这里要去掉，否则会拼出 `/v1/v1/messages`。
fn anthropic_base_url(base_url: &str) -> String {
    let trimmed = base_url.trim_end_matches('/');
    trimmed
        .strip_suffix("/v1")
        .or_else(|| trimmed.strip_suffix("/V1"))
        .unwrap_or(trimmed)
        .to_string()
}

/// 把下发清单翻译成受管 provider 列表。
fn team_providers(token: &str, manifest: &TeamManifest) -> Vec<ManagedProvider> {
    let fallback_base = format!(
        "{}/api/workbuddy/proxy/v1",
        server_url().trim_end_matches('/')
    );
    manifest
        .models
        .iter()
        .filter(|model| !model.id.trim().is_empty())
        .map(|model| {
            let anthropic = uses_anthropic_messages(model);
            let raw_base = if model.url.trim().is_empty() {
                fallback_base.clone()
            } else {
                model.url.trim().to_string()
            };
            let display_name = model.name.trim();
            ManagedProvider {
                id: managed_provider_id(ManagedNamespace::Team, &model.id),
                namespace: ManagedNamespace::Team,
                name: if display_name.is_empty() {
                    model.id.clone()
                } else {
                    display_name.to_string()
                },
                base_url: if anthropic {
                    anthropic_base_url(&raw_base)
                } else {
                    raw_base
                },
                api_key: token.to_string(),
                api_mode: if anthropic {
                    ApiMode::AnthropicMessages
                } else {
                    ApiMode::ChatCompletions
                },
                model: model.id.clone(),
                models: vec![ManagedModel {
                    id: model.id.clone(),
                    context_length: model.max_input_tokens,
                    supports_tools: Some(model.supports_tool_call.unwrap_or(true)),
                    supports_vision: Some(model.supports_images.unwrap_or(false)),
                    supports_reasoning: Some(model.supports_reasoning.unwrap_or(false)),
                }],
                extra: Vec::new(),
            }
        })
        .collect()
}

fn read_config(path: &Path) -> Result<serde_yaml::Value, String> {
    if path.exists() {
        serde_yaml::from_slice(&fs::read(path).map_err(|e| e.to_string())?)
            .map_err(|e| format!("parse config.yaml: {e}"))
    } else {
        Ok(serde_yaml::Value::Mapping(Default::default()))
    }
}

fn write_config(path: &Path, config: &serde_yaml::Value) -> Result<(), String> {
    let out = serde_yaml::to_string(config).map_err(|e| e.to_string())?;
    atomic_write(path, out.as_bytes())
}

fn merge_config(home: &Path, token: &str, manifest: &TeamManifest) -> Result<(), String> {
    let path = home.join("config.yaml");
    let mut config = read_config(&path)?;

    migrate_legacy_config(&mut config, crate::brand_generated::BRAND_PROVIDER_KEY);

    let providers = team_providers(token, manifest);
    apply_managed_providers(&mut config, &[ManagedNamespace::Team], &providers)?;

    // 全局默认模型。旧实现在这里写的是一个**标量字符串**，而且值是 provider id
    // 而非模型名 —— Core 的 _get_model_config() 对标量会退化成
    // {"default": <str>} 并丢掉 provider/base_url/api_key，于是每个回落到全局
    // 默认的会话都进了猜测链路，最终打到别的模型上。这里必须写映射。
    match manifest
        .default_model
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .and_then(|id| providers.iter().find(|p| p.model == id))
    {
        Some(provider) => set_default_model(&mut config, provider, &provider.model)?,
        // 清单没给默认模型，或给的模型不在清单里：清掉指向本命名空间的陈旧默认值，
        // 不要留一个指向已消失 provider 的引用。
        None => clear_default_model_if_managed(&mut config, &[ManagedNamespace::Team]),
    }

    write_config(&path, &config)
}

async fn fetch_manifest(client: &reqwest::Client, token: &str) -> Result<TeamManifest, String> {
    let url = format!("{}/api/workbuddy/sync", server_url().trim_end_matches('/'));
    let response = client
        .get(url)
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = response.status();
    let bytes = response.bytes().await.map_err(|e| e.to_string())?;
    if bytes.len() > MAX_MANIFEST {
        return Err("Team manifest is too large".into());
    }
    parse_manifest_response(status, &bytes)
}

fn parse_manifest_response(
    status: reqwest::StatusCode,
    bytes: &[u8],
) -> Result<TeamManifest, String> {
    // The launcher treats both unauthorized and forbidden responses as an
    // invalid/revoked device token.  Check the status before decoding the
    // body because gateways sometimes return plain text or an empty body.
    if matches!(
        status,
        reqwest::StatusCode::UNAUTHORIZED | reqwest::StatusCode::FORBIDDEN
    ) {
        return Err("Team device token was rejected".into());
    }
    let env: TeamManifestEnvelope =
        serde_json::from_slice(bytes).map_err(|e| format!("parse Team manifest: {e}"))?;
    if !status.is_success() || env.success == Some(false) {
        return Err(env.message.unwrap_or_else(|| {
            format!("Team manifest request failed (HTTP {})", status.as_u16())
        }));
    }
    env.data
        .ok_or_else(|| "Team manifest did not contain data".into())
}

async fn sync_skills(
    client: &reqwest::Client,
    home: &Path,
    token: &str,
    skills: &[TeamSkill],
) -> Result<(), String> {
    let root = home.join("skills");
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    for skill in skills {
        let id = skill.workbuddy_id.as_deref().unwrap_or(&skill.id);
        if id.is_empty() || id.contains("..") || id.contains('/') || id.contains('\\') {
            return Err("unsafe Team skill id".into());
        }
        let response = client
            .get(resolve_url(&skill.download_url)?)
            .bearer_auth(token)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let status = response.status();
        if matches!(
            status,
            reqwest::StatusCode::UNAUTHORIZED | reqwest::StatusCode::FORBIDDEN
        ) {
            return Err("Team device token was rejected".into());
        }
        if !status.is_success() {
            return Err(format!(
                "Team skill download failed (HTTP {})",
                status.as_u16()
            ));
        }
        let bytes = response.bytes().await.map_err(|e| e.to_string())?;
        if bytes.len() > MAX_SKILL {
            return Err("Team skill archive is too large".into());
        }
        let mut hasher = Sha256::new();
        hasher.update(&bytes);
        let digest = hasher.finalize();
        let actual = digest
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        if actual != skill.sha256.trim().to_lowercase() {
            return Err(format!("skill {} checksum mismatch", skill.id));
        }
        let dest = root.join(id);
        let staging = root.join(format!(".{id}.staging"));
        let _ = fs::remove_dir_all(&staging);
        fs::create_dir_all(&staging).map_err(|e| e.to_string())?;
        let mut zip = ZipArchive::new(Cursor::new(bytes)).map_err(|e| e.to_string())?;
        for i in 0..zip.len() {
            let mut file = zip.by_index(i).map_err(|e| e.to_string())?;
            let name = file.name().replace('\\', "/");
            if name.starts_with('/') || name.split('/').any(|p| p == "..") {
                return Err("unsafe skill archive path".into());
            }
            let out = staging.join(&name);
            if file.is_dir() {
                fs::create_dir_all(&out).map_err(|e| e.to_string())?;
            } else {
                if let Some(p) = out.parent() {
                    fs::create_dir_all(p).map_err(|e| e.to_string())?;
                }
                let mut f = fs::File::create(&out).map_err(|e| e.to_string())?;
                std::io::copy(&mut file, &mut f).map_err(|e| e.to_string())?;
            }
        }
        let _ = fs::remove_dir_all(&dest);
        fs::rename(staging, dest).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn resolve_url(reference: &str) -> Result<Url, String> {
    let parsed = Url::parse(reference)
        .or_else(|_| {
            Url::parse(&format!(
                "{}/{}",
                server_url().trim_end_matches('/'),
                reference.trim_start_matches('/')
            ))
        })
        .map_err(|e| e.to_string())?;
    let base = Url::parse(&server_url()).map_err(|e| e.to_string())?;
    if parsed.scheme() != base.scheme()
        || parsed.host_str() != base.host_str()
        || parsed.port_or_known_default() != base.port_or_known_default()
    {
        return Err("Team skill download must stay on the configured Team server".into());
    }
    Ok(parsed)
}

pub async fn sync_home(home: &Path, token: &str) -> Result<TeamSyncStatus, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(90))
        .build()
        .map_err(|e| e.to_string())?;
    let manifest = fetch_manifest(&client, token).await?;
    if manifest.cleanup_only {
        return Err("Team device is disabled".into());
    }
    let previous: SyncState = fs::read(home.join(STATE_FILE))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    // Download skills before exposing the new providers in config.yaml. A
    // failed download should leave the currently running model configuration
    // intact instead of publishing a half-applied enterprise sync.
    sync_skills(&client, home, token, &manifest.skills).await?;
    merge_config(home, token, &manifest)?;
    let current: std::collections::HashSet<String> = manifest
        .skills
        .iter()
        .map(|s| s.workbuddy_id.clone().unwrap_or_else(|| s.id.clone()))
        .collect();
    for old in previous.skills {
        if current.contains(&old)
            || old.is_empty()
            || old.contains("..")
            || old.contains('/')
            || old.contains('\\')
        {
            continue;
        }
        let _ = fs::remove_dir_all(home.join("skills").join(old));
    }
    let state = SyncState {
        models: manifest.models.iter().map(|m| m.id.clone()).collect(),
        skills: manifest.skills.iter().map(|s| s.id.clone()).collect(),
    };
    atomic_write(
        &home.join(STATE_FILE),
        serde_json::to_vec_pretty(&state)
            .map_err(|e| e.to_string())?
            .as_slice(),
    )?;
    Ok(TeamSyncStatus {
        configured: true,
        invalidated: false,
        synced_models: state.models.len(),
        synced_skills: state.skills.len(),
    })
}

#[tauri::command]
pub async fn get_team_device_token_status(
    state: tauri::State<'_, crate::state::AppState>,
) -> Result<TeamSyncStatus, crate::error::AppError> {
    let home = { state.inner.lock()?.hermes_home.clone() };
    Ok(status_for_home(Path::new(&home)))
}

#[tauri::command]
pub async fn set_team_device_token(
    state: tauri::State<'_, crate::state::AppState>,
    token: String,
) -> Result<TeamSyncStatus, crate::error::AppError> {
    let home = { state.inner.lock()?.hermes_home.clone() };
    let token = token.trim();
    if token.is_empty() {
        return Err(crate::error::AppError::InvalidRequest(
            "device token is empty".into(),
        ));
    }
    let home = Path::new(&home);
    let token_file = token_path(home);
    let previous_token = fs::read(&token_file).ok();
    atomic_write(&token_file, token.as_bytes()).map_err(crate::error::AppError::FileError)?;
    let result = match sync_home(home, token).await {
        Ok(result) => result,
        Err(error) => {
            if let Some(previous) = previous_token {
                let _ = atomic_write(&token_file, &previous);
            } else {
                let _ = fs::remove_file(&token_file);
            }
            return Err(crate::error::AppError::ProxyError(error));
        }
    };
    let _ = fs::remove_file(home.join(INVALID_TOKEN_FILE));
    // The managed runtime reads config.yaml at process start. Restart it so a
    // first-time token takes effect immediately, matching the WorkBuddy
    // launcher's "sync before launch" behaviour.
    if let Err(error) = crate::commands::runtime_manager::restart_dashboard(&state).await {
        log::warn!("Team sync succeeded but dashboard restart failed: {error}");
    }
    Ok(result)
}

#[tauri::command]
pub async fn clear_team_device_token(
    state: tauri::State<'_, crate::state::AppState>,
) -> Result<(), crate::error::AppError> {
    let home = { state.inner.lock()?.hermes_home.clone() };
    let _ = fs::remove_file(token_path(Path::new(&home)));
    let _ = fs::remove_file(Path::new(&home).join(INVALID_TOKEN_FILE));
    let _ = clear_managed(Path::new(&home));
    if let Err(error) = crate::commands::runtime_manager::restart_dashboard(&state).await {
        log::warn!("Team device unbind succeeded but dashboard restart failed: {error}");
    }
    Ok(())
}

fn clear_managed(home: &Path) -> Result<(), String> {
    let config_path = home.join("config.yaml");
    if config_path.exists() {
        let mut config = read_config(&config_path)?;
        // 解绑设备时把本命名空间清空即可；账号 provider 与用户自定义 provider
        // 不属于 Team 的管辖范围。
        apply_managed_providers(&mut config, &[ManagedNamespace::Team], &[])?;
        clear_default_model_if_managed(&mut config, &[ManagedNamespace::Team]);
        migrate_legacy_config(&mut config, crate::brand_generated::BRAND_PROVIDER_KEY);
        write_config(&config_path, &config)?;
    }
    if let Ok(state) = fs::read(home.join(STATE_FILE))
        .and_then(|b| serde_json::from_slice::<SyncState>(&b).map_err(std::io::Error::other))
    {
        for id in state.skills {
            if !id.is_empty() && !id.contains("..") && !id.contains('/') && !id.contains('\\') {
                let _ = fs::remove_dir_all(home.join("skills").join(id));
            }
        }
    }
    let _ = fs::remove_file(home.join(STATE_FILE));
    Ok(())
}

pub async fn sync_if_configured(home: &str) -> Result<(), String> {
    if let Some(token) = read_token(Path::new(home)) {
        match sync_home(Path::new(home), &token).await {
            Ok(_) => {
                let _ = fs::remove_file(Path::new(home).join(INVALID_TOKEN_FILE));
                Ok(())
            }
            Err(error) => {
                if error.contains("rejected") || error.contains("disabled") {
                    let _ = fs::remove_file(token_path(Path::new(home)));
                    let _ = clear_managed(Path::new(home));
                    let _ = atomic_write(&Path::new(home).join(INVALID_TOKEN_FILE), b"invalid\n");
                }
                Err(error)
            }
        }
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn team_sync_uses_a_valid_branded_team_service() {
        let url = Url::parse(crate::brand_generated::BRAND_TEAM_SERVICE_URL).unwrap();
        assert_eq!(url.scheme(), "https");
        assert!(url.host_str().is_some_and(|host| !host.is_empty()));
    }

    #[test]
    fn manifest_error_preserves_the_server_message() {
        let error = parse_manifest_response(
            reqwest::StatusCode::BAD_REQUEST,
            br#"{"success":false,"message":"device is disabled"}"#,
        )
        .unwrap_err();

        assert_eq!(error, "device is disabled");
    }

    #[test]
    fn unauthorized_manifest_is_reported_as_a_rejected_token() {
        let error = parse_manifest_response(
            reqwest::StatusCode::UNAUTHORIZED,
            br#"{"success":false,"message":"valid device bearer token required"}"#,
        )
        .unwrap_err();

        assert_eq!(error, "Team device token was rejected");
    }

    #[test]
    fn forbidden_manifest_is_reported_as_a_rejected_token_even_without_json() {
        let error =
            parse_manifest_response(reqwest::StatusCode::FORBIDDEN, b"forbidden").unwrap_err();

        assert_eq!(error, "Team device token was rejected");
    }

    #[test]
    fn status_requires_both_token_and_committed_sync_state() {
        let temp = tempfile::TempDir::new().unwrap();
        let home = temp.path();

        atomic_write(&token_path(home), b"wbd_test").unwrap();
        assert!(!status_for_home(home).configured);

        atomic_write(
            &home.join(STATE_FILE),
            serde_json::to_vec(&SyncState {
                models: vec!["model-a".into(), "model-b".into()],
                skills: vec!["skill-a".into()],
            })
            .unwrap()
            .as_slice(),
        )
        .unwrap();

        let status = status_for_home(home);
        assert!(status.configured);
        assert_eq!(status.synced_models, 2);
        assert_eq!(status.synced_skills, 1);
    }

    #[test]
    fn status_ignores_stale_state_without_a_token() {
        let temp = tempfile::TempDir::new().unwrap();
        let home = temp.path();
        atomic_write(
            &home.join(STATE_FILE),
            serde_json::to_vec(&SyncState {
                models: vec!["model-a".into()],
                skills: vec![],
            })
            .unwrap()
            .as_slice(),
        )
        .unwrap();

        let status = status_for_home(home);
        assert!(!status.configured);
        assert_eq!(status.synced_models, 1);
    }

    #[test]
    fn status_reports_a_token_invalidated_during_startup_sync() {
        let temp = tempfile::TempDir::new().unwrap();
        let home = temp.path();
        atomic_write(&home.join(INVALID_TOKEN_FILE), b"invalid\n").unwrap();

        let status = status_for_home(home);
        assert!(!status.configured);
        assert!(status.invalidated);
    }

    #[test]
    fn managed_provider_keeps_stable_key_and_uses_manifest_display_name() {
        let temp = tempfile::TempDir::new().unwrap();
        let home = temp.path();
        merge_config(
            home,
            "wbd_test",
            &TeamManifest {
                models: vec![TeamModel {
                    id: "mdl_opaque_id".into(),
                    name: "rightcodegpt".into(),
                    url: "https://team.example/api/workbuddy/proxy/v1".into(),
                    ..Default::default()
                }],
                ..Default::default()
            },
        )
        .unwrap();

        let config: serde_yaml::Value =
            serde_yaml::from_slice(&fs::read(home.join("config.yaml")).unwrap()).unwrap();
        let provider = &config["providers"]["custom:team-mdl_opaque_id"];
        assert_eq!(
            provider["provider_key"].as_str(),
            Some("custom:team-mdl_opaque_id")
        );
        assert_eq!(provider["name"].as_str(), Some("rightcodegpt"));
        assert_eq!(provider["model"].as_str(), Some("mdl_opaque_id"));
    }

    #[test]
    fn default_model_is_written_as_a_mapping_not_a_provider_id_scalar() {
        // 回归 R2：旧实现写 `model: custom:team-<id>` 标量，Core 会把它当成
        // 模型名并丢掉 provider/base_url/api_key，导致会话打到别的模型上。
        let temp = tempfile::TempDir::new().unwrap();
        let home = temp.path();
        merge_config(
            home,
            "wbd_test",
            &TeamManifest {
                models: vec![TeamModel {
                    id: "deepseek-v4-pro".into(),
                    name: "DeepSeek V4 Pro".into(),
                    url: "https://team.example/api/workbuddy/proxy/v1".into(),
                    ..Default::default()
                }],
                default_model: Some("deepseek-v4-pro".into()),
                ..Default::default()
            },
        )
        .unwrap();

        let config: serde_yaml::Value =
            serde_yaml::from_slice(&fs::read(home.join("config.yaml")).unwrap()).unwrap();
        let model = config["model"]
            .as_mapping()
            .expect("model must be a mapping, never a scalar");
        assert_eq!(model["default"].as_str(), Some("deepseek-v4-pro"));
        assert_eq!(
            model["provider"].as_str(),
            Some("custom:team-deepseek-v4-pro")
        );
        assert_eq!(model["api_key"].as_str(), Some("wbd_test"));
    }

    #[test]
    fn dotted_model_ids_produce_dot_free_provider_ids() {
        // 回归 R3：含点的 provider id 会被桌面端剥掉 custom: 前缀，
        // Core 的精确键查表随即落空。
        let temp = tempfile::TempDir::new().unwrap();
        let home = temp.path();
        merge_config(
            home,
            "wbd_test",
            &TeamManifest {
                models: vec![TeamModel {
                    id: "glm-5.2".into(),
                    name: "GLM 5.2".into(),
                    url: "https://team.example/api/workbuddy/proxy/v1".into(),
                    ..Default::default()
                }],
                ..Default::default()
            },
        )
        .unwrap();

        let config: serde_yaml::Value =
            serde_yaml::from_slice(&fs::read(home.join("config.yaml")).unwrap()).unwrap();
        let providers = config["providers"].as_mapping().unwrap();
        let key = providers.keys().next().unwrap().as_str().unwrap();
        assert_eq!(key, "custom:team-glm-5-2");
        assert!(!key.contains('.'));
        // 但真实模型名必须保留原样的点。
        assert_eq!(providers[key]["model"].as_str(), Some("glm-5.2"));
    }

    #[test]
    fn anthropic_models_get_messages_mode_and_a_stripped_base_url() {
        let temp = tempfile::TempDir::new().unwrap();
        let home = temp.path();
        merge_config(
            home,
            "wbd_test",
            &TeamManifest {
                models: vec![TeamModel {
                    id: "claude-opus-4-8".into(),
                    name: "Claude".into(),
                    url: "https://team.example/api/workbuddy/proxy/v1".into(),
                    ..Default::default()
                }],
                ..Default::default()
            },
        )
        .unwrap();

        let config: serde_yaml::Value =
            serde_yaml::from_slice(&fs::read(home.join("config.yaml")).unwrap()).unwrap();
        let provider = &config["providers"]["custom:team-claude-opus-4-8"];
        assert_eq!(provider["api_mode"].as_str(), Some("anthropic_messages"));
        assert_eq!(provider["transport"].as_str(), Some("anthropic_messages"));
        // Anthropic SDK 自己补 /v1/messages，base_url 不能再带 /v1。
        assert_eq!(
            provider["base_url"].as_str(),
            Some("https://team.example/api/workbuddy/proxy")
        );
    }

    #[test]
    fn sync_removes_models_that_left_the_manifest() {
        let temp = tempfile::TempDir::new().unwrap();
        let home = temp.path();
        let model = |id: &str| TeamModel {
            id: id.into(),
            name: id.into(),
            url: "https://team.example/api/workbuddy/proxy/v1".into(),
            ..Default::default()
        };

        merge_config(
            home,
            "wbd_test",
            &TeamManifest {
                models: vec![model("a"), model("b")],
                ..Default::default()
            },
        )
        .unwrap();
        merge_config(
            home,
            "wbd_test",
            &TeamManifest {
                models: vec![model("b")],
                ..Default::default()
            },
        )
        .unwrap();

        let config: serde_yaml::Value =
            serde_yaml::from_slice(&fs::read(home.join("config.yaml")).unwrap()).unwrap();
        let providers = config["providers"].as_mapping().unwrap();
        assert!(!providers.contains_key(serde_yaml::Value::from("custom:team-a")));
        assert!(providers.contains_key(serde_yaml::Value::from("custom:team-b")));
    }

    #[test]
    fn sync_never_touches_user_written_providers() {
        let temp = tempfile::TempDir::new().unwrap();
        let home = temp.path();
        atomic_write(
            &home.join("config.yaml"),
            b"providers:\n  custom:my-own:\n    api_key: sk-mine\n    base_url: https://mine/v1\n",
        )
        .unwrap();

        merge_config(
            home,
            "wbd_test",
            &TeamManifest {
                models: vec![TeamModel {
                    id: "a".into(),
                    name: "A".into(),
                    url: "https://team.example/api/workbuddy/proxy/v1".into(),
                    ..Default::default()
                }],
                ..Default::default()
            },
        )
        .unwrap();

        let config: serde_yaml::Value =
            serde_yaml::from_slice(&fs::read(home.join("config.yaml")).unwrap()).unwrap();
        assert_eq!(
            config["providers"]["custom:my-own"]["api_key"].as_str(),
            Some("sk-mine")
        );
    }

    #[test]
    fn sync_migrates_a_legacy_config_in_place() {
        let temp = tempfile::TempDir::new().unwrap();
        let home = temp.path();
        // 旧写入方留下的形态：team_managed 列表条目 + 标量 model:。
        atomic_write(
            &home.join("config.yaml"),
            b"custom_providers:\n  - name: Old\n    provider_key: team-old\n    team_managed: true\nmodel: custom:team-old\n",
        )
        .unwrap();

        merge_config(
            home,
            "wbd_test",
            &TeamManifest {
                models: vec![TeamModel {
                    id: "new".into(),
                    name: "New".into(),
                    url: "https://team.example/api/workbuddy/proxy/v1".into(),
                    ..Default::default()
                }],
                ..Default::default()
            },
        )
        .unwrap();

        let config: serde_yaml::Value =
            serde_yaml::from_slice(&fs::read(home.join("config.yaml")).unwrap()).unwrap();
        // 遗留列表条目已清除，不会与新 providers: map 条目重复。
        assert!(config
            .as_mapping()
            .unwrap()
            .get("custom_providers")
            .is_none());
        assert!(config["providers"]["custom:team-new"].is_mapping());
        // 标量 model: 已被丢弃，且没有被重新写成标量。
        assert!(!config["model"].is_string());
    }
}
