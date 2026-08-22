//! Persist global default model selection to `HERMES_HOME/config.yaml`.
//!
//! This command gives the React UI a stable, file-backed way to update the
//! default model without relying on the dashboard REST endpoint. It is the Rust
//! side of the `global` scope in the model-switching pipeline.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_yaml::Value;
use tauri::State;
use tokio::task;

use crate::error::{AppError, AppResult};
use crate::state::AppState;

const CONFIG_FILE: &str = "config.yaml";

#[derive(Debug, Clone, Deserialize)]
pub struct SetModelConfigRequest {
    pub model: String,
    pub provider: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetModelConfigResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

fn active_hermes_home(state: &State<'_, AppState>) -> AppResult<PathBuf> {
    let inner = state.inner.lock()?;
    if inner.connection_mode == crate::connection::ConnectionMode::Remote {
        return Err(AppError::InvalidRequest(
            "远程模式不支持修改默认模型；请通过所连后端的设置页面修改。".to_string(),
        ));
    }
    if inner.hermes_home.trim().is_empty() {
        return Err(AppError::NotReady);
    }
    Ok(PathBuf::from(inner.hermes_home.clone()))
}

fn write_file_safe(path: &Path, content: &str) -> AppResult<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp_path = path.with_extension("yaml.tmp");
    fs::write(&tmp_path, content)?;
    if path.exists() {
        fs::remove_file(path)?;
    }
    fs::rename(tmp_path, path)?;
    Ok(())
}

fn build_model_value(model: &str, provider: Option<&str>) -> Value {
    let mut map = serde_yaml::Mapping::new();
    map.insert(
        Value::String("default".to_string()),
        Value::String(model.to_string()),
    );
    if let Some(provider) = provider {
        map.insert(
            Value::String("provider".to_string()),
            Value::String(provider.to_string()),
        );
    }
    Value::Mapping(map)
}

fn update_config_model(config: &mut Value, model: &str, provider: Option<&str>) {
    if config.as_mapping_mut().is_none() {
        *config = Value::Mapping(serde_yaml::Mapping::new());
    }
    let root = config.as_mapping_mut().expect("mapping just ensured");

    // Remove a stale top-level `model` string so it does not override the
    // mapping we are about to write.
    if let Some(Value::String(_)) = root.get("model") {
        root.remove("model");
    }

    root.insert(
        Value::String("model".to_string()),
        build_model_value(model, provider),
    );
}

fn set_model_config_sync(home: &Path, model: &str, provider: Option<&str>) -> AppResult<()> {
    let path = home.join(CONFIG_FILE);
    let mut config: Value = if path.exists() {
        let raw = fs::read_to_string(&path)?;
        serde_yaml::from_str(&raw).unwrap_or_else(|_| Value::Mapping(serde_yaml::Mapping::new()))
    } else {
        Value::Mapping(serde_yaml::Mapping::new())
    };

    update_config_model(&mut config, model, provider);

    let raw = serde_yaml::to_string(&config)
        .map_err(|e| AppError::Internal(format!("serialize config.yaml: {}", e)))?;
    write_file_safe(&path, &raw)?;
    Ok(())
}

async fn run_config_io<T, F>(work: F) -> AppResult<T>
where
    T: Send + 'static,
    F: FnOnce() -> AppResult<T> + Send + 'static,
{
    task::spawn_blocking(work)
        .await
        .map_err(|err| AppError::Internal(format!("model config task failed: {}", err)))?
}

#[tauri::command]
pub async fn set_model_config(
    request: SetModelConfigRequest,
    state: State<'_, AppState>,
) -> AppResult<SetModelConfigResult> {
    let trimmed = request.model.trim().to_string();
    if trimmed.is_empty() {
        return Ok(SetModelConfigResult {
            success: false,
            error: Some("model cannot be empty".to_string()),
        });
    }

    let provider = request
        .provider
        .as_deref()
        .filter(|p| !p.trim().is_empty())
        .map(|p| p.to_string());
    let home = active_hermes_home(&state)?;
    run_config_io(move || set_model_config_sync(&home, &trimmed, provider.as_deref())).await?;

    Ok(SetModelConfigResult {
        success: true,
        error: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;
    use tempfile::TempDir;

    #[test]
    fn creates_config_with_model_mapping() {
        let home = TempDir::new().unwrap();
        set_model_config_sync(home.path(), "gpt-4o", Some("openai")).unwrap();

        let raw = fs::read_to_string(home.path().join(CONFIG_FILE)).unwrap();
        let config: Value = serde_yaml::from_str(&raw).unwrap();
        let model = config.get("model").unwrap().as_mapping().unwrap();
        assert_eq!(
            model.get(&Value::String("default".to_string())).unwrap(),
            &Value::String("gpt-4o".to_string())
        );
        assert_eq!(
            model.get(&Value::String("provider".to_string())).unwrap(),
            &Value::String("openai".to_string())
        );
    }

    #[test]
    fn overwrites_legacy_string_model() {
        let home = TempDir::new().unwrap();
        fs::write(home.path().join(CONFIG_FILE), "model: old-model\n").unwrap();
        set_model_config_sync(home.path(), "claude-opus", Some("anthropic")).unwrap();

        let raw = fs::read_to_string(home.path().join(CONFIG_FILE)).unwrap();
        let config: Value = serde_yaml::from_str(&raw).unwrap();
        assert!(config.get("model").unwrap().is_mapping());
        let model = config.get("model").unwrap().as_mapping().unwrap();
        assert_eq!(
            model.get(&Value::String("default".to_string())).unwrap(),
            &Value::String("claude-opus".to_string())
        );
    }

    #[test]
    fn omits_provider_when_none() {
        let home = TempDir::new().unwrap();
        set_model_config_sync(home.path(), "some-model", None).unwrap();

        let raw = fs::read_to_string(home.path().join(CONFIG_FILE)).unwrap();
        let config: Value = serde_yaml::from_str(&raw).unwrap();
        let model = config.get("model").unwrap().as_mapping().unwrap();
        assert!(!model.contains_key(&Value::String("provider".to_string())));
    }
}
