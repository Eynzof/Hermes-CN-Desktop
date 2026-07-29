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

fn merge_config(home: &Path, token: &str, manifest: &TeamManifest) -> Result<(), String> {
    let path = home.join("config.yaml");
    let mut config: serde_yaml::Value = if path.exists() {
        serde_yaml::from_slice(&fs::read(&path).map_err(|e| e.to_string())?)
            .map_err(|e| format!("parse config.yaml: {e}"))?
    } else {
        serde_yaml::Value::Mapping(Default::default())
    };
    let map = config
        .as_mapping_mut()
        .ok_or_else(|| "config.yaml root must be an object".to_string())?;
    let mut providers = map
        .remove(serde_yaml::Value::String("custom_providers".into()))
        .unwrap_or_else(|| serde_yaml::Value::Sequence(vec![]));
    let seq = providers
        .as_sequence_mut()
        .ok_or_else(|| "custom_providers must be a list".to_string())?;
    seq.retain(|v| v.get("team_managed").and_then(|x| x.as_bool()) != Some(true));
    let mut ids = Vec::new();
    for model in &manifest.models {
        if model.id.trim().is_empty() || model.url.trim().is_empty() {
            continue;
        }
        let name = format!(
            "team-{}",
            model.id.replace(
                |c: char| !c.is_ascii_alphanumeric() && c != '-' && c != '_',
                "-"
            )
        );
        let display_name = model.name.trim();
        let mut entry = serde_yaml::Mapping::new();
        entry.insert(
            "name".into(),
            if display_name.is_empty() {
                name.clone().into()
            } else {
                display_name.into()
            },
        );
        entry.insert("provider_key".into(), name.clone().into());
        entry.insert("base_url".into(), model.url.clone().into());
        entry.insert("api_key".into(), token.into());
        entry.insert("model".into(), model.id.clone().into());
        entry.insert("api_mode".into(), "chat_completions".into());
        entry.insert("team_managed".into(), true.into());
        if let Some(n) = model.max_input_tokens {
            entry.insert("context_length".into(), n.into());
        }
        seq.push(serde_yaml::Value::Mapping(entry));
        ids.push(model.id.clone());
    }
    map.insert(
        serde_yaml::Value::String("custom_providers".into()),
        providers,
    );
    if let Some(default) = manifest
        .default_model
        .as_deref()
        .filter(|s| !s.trim().is_empty())
    {
        map.insert(
            serde_yaml::Value::String("model".into()),
            format!(
                "custom:team-{}",
                default.replace(
                    |c: char| !c.is_ascii_alphanumeric() && c != '-' && c != '_',
                    "-"
                )
            )
            .into(),
        );
    }
    let out = serde_yaml::to_string(&config).map_err(|e| e.to_string())?;
    atomic_write(&path, out.as_bytes())?;
    let _ = ids;
    Ok(())
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
        let mut config: serde_yaml::Value =
            serde_yaml::from_slice(&fs::read(&config_path).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
        if let Some(map) = config.as_mapping_mut() {
            if let Some(providers) = map
                .get_mut("custom_providers")
                .and_then(|v| v.as_sequence_mut())
            {
                providers.retain(|v| v.get("team_managed").and_then(|x| x.as_bool()) != Some(true));
            }
            if map
                .get("model")
                .and_then(|v| v.as_str())
                .is_some_and(|v| v.starts_with("custom:team-"))
            {
                map.remove("model");
            }
            let out = serde_yaml::to_string(&config).map_err(|e| e.to_string())?;
            atomic_write(&config_path, out.as_bytes())?;
        }
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
    fn team_sync_defaults_to_the_team_service() {
        assert_eq!(
            crate::brand_generated::BRAND_TEAM_SERVICE_URL,
            "https://team.huanxingapi.com"
        );
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
        let provider = &config["custom_providers"][0];
        assert_eq!(
            provider["provider_key"].as_str(),
            Some("team-mdl_opaque_id")
        );
        assert_eq!(provider["name"].as_str(), Some("rightcodegpt"));
        assert_eq!(provider["model"].as_str(), Some("mdl_opaque_id"));
    }
}
