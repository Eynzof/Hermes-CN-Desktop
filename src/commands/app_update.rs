//! Signed desktop-shell updates powered by the official Tauri updater.
//!
//! The shell and Core use independent version lines. A candidate response must
//! declare the Core bundled inside the target installer; the embedded
//! compatibility matrix decides whether that pair is installable. The current
//! Core is never modified before the signed shell installer starts.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_updater::{Update, Updater, UpdaterExt};
use url::Url;

use crate::error::AppError;
use crate::state::AppState;
use crate::version_compatibility::CompatibilityMatrix;

pub const APP_UPDATE_PROGRESS_EVENT: &str = "app-update-progress";
const SHELL_UPDATE_TOKEN_ENV: &str = "HERMES_SHELL_UPDATE_TOKEN";

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellUpdateMetadata {
    #[serde(default)]
    pub release_id: String,
    #[serde(default)]
    pub channel: String,
    #[serde(default)]
    pub bundled_core_version: String,
    #[serde(default)]
    pub bundled_runtime_version: String,
    #[serde(default)]
    pub runtime_revision: Option<u32>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateCheckResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest_version: Option<String>,
    pub update_available: bool,
    pub compatible: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_core_series: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_core_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_runtime_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub release_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateInstallResult {
    pub ok: bool,
    pub install_started: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateProgressPayload {
    pub phase: String,
    pub percent: u8,
    pub message: String,
}

fn emit_progress(app: &AppHandle, phase: &str, percent: u8, message: impl Into<String>) {
    let _ = app.emit(
        APP_UPDATE_PROGRESS_EVENT,
        AppUpdateProgressPayload {
            phase: phase.to_string(),
            percent,
            message: message.into(),
        },
    );
}

fn read_trimmed_env(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn updater_endpoint() -> Result<(Url, Duration), String> {
    let config = crate::update_config::load().config;
    let endpoint = config.shell_updater_endpoint.trim();
    if endpoint.is_empty() {
        return Err(
            "内测壳更新未配置：请设置 shellUpdaterEndpoint 或 HERMES_SHELL_UPDATE_ENDPOINT"
                .to_string(),
        );
    }
    let endpoint = Url::parse(endpoint)
        .map_err(|error| format!("shellUpdaterEndpoint 不是有效 URL：{error}"))?;
    if endpoint.scheme() != "https" {
        return Err("shellUpdaterEndpoint 必须使用 https".to_string());
    }
    Ok((endpoint, Duration::from_secs(config.timeout_seconds)))
}

fn build_updater(app: &AppHandle) -> Result<Updater, String> {
    let (endpoint, timeout) = updater_endpoint()?;
    let token = read_trimmed_env(SHELL_UPDATE_TOKEN_ENV)
        .ok_or_else(|| format!("内测设备令牌未配置：请设置 {SHELL_UPDATE_TOKEN_ENV}"))?;
    app.updater_builder()
        .endpoints(vec![endpoint])
        .map_err(|error| format!("更新端点配置失败：{error}"))?
        .header("Authorization", format!("Bearer {token}"))
        .map_err(|error| format!("更新认证头配置失败：{error}"))?
        .timeout(timeout)
        .build()
        .map_err(|error| format!("Tauri updater 初始化失败：{error}"))
}

fn parse_update_metadata(raw_json: &serde_json::Value) -> Result<ShellUpdateMetadata, String> {
    let value = raw_json
        .get("metadata")
        .ok_or_else(|| "更新响应缺少 metadata".to_string())?
        .clone();
    let metadata: ShellUpdateMetadata = serde_json::from_value(value)
        .map_err(|error| format!("更新 metadata 格式无效：{error}"))?;
    if metadata.release_id.trim().is_empty() {
        return Err("更新 metadata 缺少 releaseId".to_string());
    }
    if metadata.channel.trim().is_empty() {
        return Err("更新 metadata 缺少 channel".to_string());
    }
    if metadata.bundled_core_version.trim().is_empty() {
        return Err("更新 metadata 缺少 bundledCoreVersion".to_string());
    }
    if metadata.bundled_runtime_version.trim().is_empty() {
        return Err("更新 metadata 缺少 bundledRuntimeVersion".to_string());
    }
    Ok(metadata)
}

fn validate_update_target(
    target_desktop_version: &str,
    raw_json: &serde_json::Value,
) -> Result<ShellUpdateMetadata, String> {
    let metadata = parse_update_metadata(raw_json)?;
    let matrix = CompatibilityMatrix::parse_embedded()?;
    matrix.check(target_desktop_version, &metadata.bundled_core_version)?;
    matrix.check(target_desktop_version, &metadata.bundled_runtime_version)?;
    Ok(metadata)
}

fn no_update_result() -> AppUpdateCheckResult {
    let current_version = env!("CARGO_PKG_VERSION").to_string();
    let expected_core_series = CompatibilityMatrix::parse_embedded()
        .ok()
        .and_then(|matrix| matrix.expected_core_series(&current_version));
    AppUpdateCheckResult {
        ok: true,
        current_version: Some(current_version.clone()),
        latest_version: Some(current_version),
        update_available: false,
        compatible: true,
        expected_core_series,
        ..Default::default()
    }
}

fn check_failure(error: impl Into<String>) -> AppUpdateCheckResult {
    AppUpdateCheckResult {
        ok: false,
        current_version: Some(env!("CARGO_PKG_VERSION").to_string()),
        error: Some(error.into()),
        ..Default::default()
    }
}

fn checked_update_result(update: &Update) -> AppUpdateCheckResult {
    let current_version = env!("CARGO_PKG_VERSION").to_string();
    let matrix = match CompatibilityMatrix::parse_embedded() {
        Ok(matrix) => matrix,
        Err(error) => return check_failure(error),
    };
    let expected_core_series = matrix.expected_core_series(&update.version);
    match validate_update_target(&update.version, &update.raw_json) {
        Ok(metadata) => AppUpdateCheckResult {
            ok: true,
            current_version: Some(current_version),
            latest_version: Some(update.version.clone()),
            update_available: true,
            compatible: true,
            expected_core_series,
            target_core_version: Some(metadata.bundled_core_version),
            target_runtime_version: Some(metadata.bundled_runtime_version),
            release_id: Some(metadata.release_id),
            channel: Some(metadata.channel),
            notes: update.body.clone(),
            error: None,
        },
        Err(error) => AppUpdateCheckResult {
            ok: true,
            current_version: Some(current_version),
            latest_version: Some(update.version.clone()),
            update_available: false,
            compatible: false,
            expected_core_series,
            notes: update.body.clone(),
            error: Some(error),
            ..Default::default()
        },
    }
}

#[tauri::command]
pub async fn app_update_check(app: AppHandle) -> AppUpdateCheckResult {
    emit_progress(&app, "check", 1, "正在检查内测壳更新…");
    let updater = match build_updater(&app) {
        Ok(updater) => updater,
        Err(error) => return check_failure(error),
    };
    match updater.check().await {
        Ok(Some(update)) => checked_update_result(&update),
        Ok(None) => no_update_result(),
        Err(error) => check_failure(format!("检查更新失败：{error}")),
    }
}

#[tauri::command]
pub async fn app_update_install(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<AppUpdateInstallResult, AppError> {
    {
        let mut inner = state.inner.lock()?;
        if inner.app_update_in_flight {
            return Ok(AppUpdateInstallResult {
                ok: false,
                install_started: false,
                error: Some("已有壳更新正在进行，请稍候".to_string()),
            });
        }
        inner.app_update_in_flight = true;
    }

    let result = run_install(&app).await;
    if let Ok(mut inner) = state.inner.lock() {
        inner.app_update_in_flight = false;
    }
    Ok(result)
}

async fn run_install(app: &AppHandle) -> AppUpdateInstallResult {
    emit_progress(app, "check", 2, "重新确认候选版本与兼容矩阵…");
    let updater = match build_updater(app) {
        Ok(updater) => updater,
        Err(error) => return install_failure(error),
    };
    let update = match updater.check().await {
        Ok(Some(update)) => update,
        Ok(None) => return install_failure("当前已经是最新版本"),
        Err(error) => return install_failure(format!("检查更新失败：{error}")),
    };
    if let Err(error) = validate_update_target(&update.version, &update.raw_json) {
        return install_failure(error);
    }

    emit_progress(
        app,
        "download",
        8,
        format!("正在下载并校验 Desktop {}…", update.version),
    );
    let progress_app = app.clone();
    let finish_app = app.clone();
    let mut downloaded = 0_u64;
    let mut last_reported = 8_u8;
    let install = update
        .download_and_install(
            move |chunk_length, content_length| {
                downloaded = downloaded.saturating_add(chunk_length as u64);
                let percent = content_length
                    .filter(|total| *total > 0)
                    .map(|total| {
                        let ratio = downloaded.saturating_mul(82) / total;
                        8_u8.saturating_add(ratio.min(82) as u8)
                    })
                    .unwrap_or(last_reported);
                if percent >= last_reported.saturating_add(2) || percent >= 90 {
                    last_reported = percent;
                    emit_progress(
                        &progress_app,
                        "download",
                        percent,
                        format!("已下载 {} MiB", downloaded / 1_048_576),
                    );
                }
            },
            move || {
                emit_progress(
                    &finish_app,
                    "verify-signature",
                    92,
                    "下载完成，正在校验 Tauri 更新签名…",
                );
            },
        )
        .await;

    match install {
        Ok(()) => {
            emit_progress(app, "install", 100, "安装器已启动");
            AppUpdateInstallResult {
                ok: true,
                install_started: true,
                error: None,
            }
        }
        Err(error) => install_failure(format!("下载、签名校验或安装失败：{error}")),
    }
}

fn install_failure(error: impl Into<String>) -> AppUpdateInstallResult {
    AppUpdateInstallResult {
        ok: false,
        install_started: false,
        error: Some(error.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    fn raw_update(core: &str, runtime: &str) -> serde_json::Value {
        serde_json::json!({
            "version": "0.8.1-hotupdate.1",
            "url": "https://example.com/update.exe",
            "signature": "signed",
            "metadata": {
                "releaseId": "prototype-0001",
                "channel": "prototype",
                "bundledCoreVersion": core,
                "bundledRuntimeVersion": runtime,
                "runtimeRevision": 9
            }
        })
    }

    #[test]
    fn parses_required_tauri_metadata() {
        let metadata = parse_update_metadata(&raw_update("0.20.0", "0.20.0-cn.9")).unwrap();
        assert_eq!(metadata.release_id, "prototype-0001");
        assert_eq!(metadata.channel, "prototype");
        assert_eq!(metadata.bundled_core_version, "0.20.0");
        assert_eq!(metadata.runtime_revision, Some(9));
    }

    #[test]
    fn accepts_desktop_08_with_core_020() {
        let metadata =
            validate_update_target("0.8.1-hotupdate.1", &raw_update("0.20.0", "0.20.0-cn.9"))
                .unwrap();
        assert_eq!(metadata.bundled_runtime_version, "0.20.0-cn.9");
    }

    #[test]
    fn rejects_target_with_incompatible_core() {
        let error =
            validate_update_target("0.8.1-hotupdate.1", &raw_update("0.19.9", "0.19.9-cn.7"))
                .unwrap_err();
        assert!(error.contains("仅兼容 Core 0.20.x"));
    }

    #[test]
    fn rejects_missing_metadata() {
        let error = parse_update_metadata(&serde_json::json!({"version": "0.8.1"})).unwrap_err();
        assert_eq!(error, "更新响应缺少 metadata");
    }
}
