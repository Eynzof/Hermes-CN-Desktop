//! Signed desktop-shell updates powered by the official Tauri updater.
//!
//! The Cloudflare control plane is the only discovery source. Once a device is
//! authorised it receives an immutable Cloudflare mirror URL plus the matching
//! GitHub Release URL. Download requests never inherit the control-plane bearer
//! token, and only transport/429/5xx failures are eligible for GitHub fallback.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sysinfo::{ProcessRefreshKind, RefreshKind, System, UpdateKind};
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_updater::{Error as UpdaterError, Update, Updater, UpdaterExt};
use url::Url;

use crate::error::AppError;
use crate::process::dashboard;
use crate::state::AppState;
use crate::update_config::UpdateConfig;
use crate::version_compatibility::CompatibilityMatrix;

pub const APP_UPDATE_PROGRESS_EVENT: &str = "app-update-progress";
const SHELL_UPDATE_TOKEN_ENV: &str = "HERMES_SHELL_UPDATE_TOKEN";
const MANIFEST_SOURCE: &str = "cloudflare-control";
const PRIMARY_DOWNLOAD_SOURCE: &str = "cloudflare-cache";
const FALLBACK_DOWNLOAD_SOURCE: &str = "github-release";
const PRIMARY_DOWNLOAD_HOSTS: &[&str] = &[
    "hot-update-download-staging.hermesagent.org.cn",
    "dl-desktop.hermesagent.org.cn",
];
const UPDATER_CACHE_DIR: &str = "desktop-updater-cache";
const PENDING_RECORD_FILE: &str = "pending.json";
#[cfg(target_os = "windows")]
const PENDING_PACKAGE_FILE: &str = "pending-update.exe";
#[cfg(not(target_os = "windows"))]
const PENDING_PACKAGE_FILE: &str = "pending-update.bin";
#[cfg(target_os = "windows")]
const WINDOWS_NSIS_INSTALL_ARGS: [&str; 4] = ["/P", "/R", "/UPDATE", "/ARGS"];
const MAX_UPDATER_BYTES: u64 = 480 * 1024 * 1024;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellUpdateMetadata {
    pub schema_version: u32,
    #[serde(default)]
    pub release_id: String,
    #[serde(default)]
    pub channel: String,
    #[serde(default)]
    pub github_release_tag: String,
    #[serde(default)]
    pub github_fallback_url: String,
    #[serde(default)]
    pub sha256: String,
    pub size: u64,
    #[serde(default)]
    pub bundled_core_version: String,
    #[serde(default)]
    pub bundled_runtime_version: String,
    pub runtime_revision: u32,
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
    pub manifest_source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateDownloadResult {
    pub ok: bool,
    pub ready: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub release_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub manifest_source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub download_source: Option<String>,
    pub fallback_used: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdatePendingResult {
    pub ready: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub release_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub download_source: Option<String>,
    pub fallback_used: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateInstallResult {
    pub ok: bool,
    pub install_started: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub manifest_source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub download_source: Option<String>,
    pub fallback_used: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateProgressPayload {
    pub phase: String,
    pub percent: u8,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub manifest_source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub download_source: Option<String>,
    pub fallback_used: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PendingUpdateRecord {
    schema_version: u32,
    version: String,
    release_id: String,
    sha256: String,
    size: u64,
    download_source: String,
    fallback_used: bool,
    downloaded_at: u64,
}

struct DownloadOutcome {
    bytes: Vec<u8>,
    source: &'static str,
    fallback_used: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ClientUpdateEvent<'a> {
    channel: &'a str,
    event: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    release_id: Option<&'a str>,
    app_version: &'a str,
    manifest_source: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    download_source: Option<&'a str>,
    fallback_used: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error_code: Option<&'a str>,
}

fn emit_progress(
    app: &AppHandle,
    phase: &str,
    percent: u8,
    message: impl Into<String>,
    download_source: Option<&str>,
    fallback_used: bool,
) {
    let _ = app.emit(
        APP_UPDATE_PROGRESS_EVENT,
        AppUpdateProgressPayload {
            phase: phase.to_string(),
            percent,
            message: message.into(),
            manifest_source: Some(MANIFEST_SOURCE.to_string()),
            download_source: download_source.map(str::to_string),
            fallback_used,
        },
    );
}

fn read_trimmed_env(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn resolved_device_token(device_id: &str) -> Result<String, String> {
    match crate::update_config::read_device_token(device_id) {
        Ok(Some(token)) => Ok(token),
        Ok(None) => read_trimmed_env(SHELL_UPDATE_TOKEN_ENV)
            .ok_or_else(|| "内测设备令牌未配置，请重新导入邀请配置".to_string()),
        Err(credential_error) => read_trimmed_env(SHELL_UPDATE_TOKEN_ENV).ok_or(credential_error),
    }
}

fn expected_release_id(version: &str) -> Result<String, String> {
    let target = match std::env::consts::OS {
        "windows" => "windows",
        "macos" => "darwin",
        "linux" => "linux",
        other => return Err(format!("当前系统不支持 Desktop updater：{other}")),
    };
    let arch = match std::env::consts::ARCH {
        "x86" => "i686",
        "x86_64" => "x86_64",
        "arm" => "armv7",
        "aarch64" => "aarch64",
        other => return Err(format!("当前架构不支持 Desktop updater：{other}")),
    };
    Ok(format!("desktop-{version}-{target}-{arch}"))
}

fn random_installation_id() -> Result<String, String> {
    let mut bytes = [0_u8; 16];
    getrandom::fill(&mut bytes).map_err(|error| format!("生成 installation ID 失败：{error}"))?;
    Ok(format!(
        "installation-{}",
        bytes
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    ))
}

fn resolved_config() -> Result<UpdateConfig, String> {
    let mut config = crate::update_config::load().config;
    if config.channel == "stable" && config.device_id.trim().len() < 16 {
        config.device_id = random_installation_id()?;
        crate::update_config::save(&config)?;
    }
    Ok(config)
}

fn updater_endpoint(config: &UpdateConfig) -> Result<(Url, Duration), String> {
    let endpoint = config
        .shell_updater_endpoint
        .trim()
        .replace("{{channel}}", &config.channel);
    if endpoint.is_empty() {
        return Err("壳更新未配置：请导入邀请配置，或设置 shellUpdaterEndpoint".to_string());
    }
    crate::update_config::validate_shell_updater_endpoint(&endpoint)?;
    let endpoint = Url::parse(&endpoint)
        .map_err(|error| format!("shellUpdaterEndpoint 不是有效 URL：{error}"))?;
    if endpoint.scheme() != "https" {
        return Err("shellUpdaterEndpoint 必须使用 https".to_string());
    }
    Ok((endpoint, Duration::from_secs(config.timeout_seconds)))
}

fn events_endpoint(config: &UpdateConfig) -> Result<Url, String> {
    let raw = config
        .shell_updater_endpoint
        .trim()
        .replace("{{channel}}", &config.channel);
    let mut endpoint = Url::parse(&raw).map_err(|error| format!("事件端点无效：{error}"))?;
    if !endpoint.path().contains("/v1/check/") {
        return Err("无法从更新检查地址推导 /v1/events".to_string());
    }
    endpoint.set_path("/v1/events");
    endpoint.set_query(None);
    endpoint.set_fragment(None);
    Ok(endpoint)
}

async fn send_event(
    config: &UpdateConfig,
    event: &str,
    release_id: Option<&str>,
    download_source: Option<&str>,
    fallback_used: bool,
    error_code: Option<&str>,
) -> Result<(), String> {
    let endpoint = events_endpoint(config)?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(config.timeout_seconds.min(5)))
        .build()
        .map_err(|error| format!("更新事件客户端初始化失败：{error}"))?;
    let mut request = client.post(endpoint).json(&ClientUpdateEvent {
        channel: &config.channel,
        event,
        release_id,
        app_version: env!("CARGO_PKG_VERSION"),
        manifest_source: MANIFEST_SOURCE,
        download_source,
        fallback_used,
        error_code,
    });
    if config.channel == "stable" {
        request = request.header("X-Installation-Id", &config.device_id);
    } else {
        let token = resolved_device_token(&config.device_id)?;
        request = request
            .bearer_auth(token)
            .header("X-Device-Id", &config.device_id);
    }
    let response = request
        .send()
        .await
        .map_err(|error| format!("更新事件发送失败：{error}"))?;
    if response.status().as_u16() != 204 {
        return Err(format!("更新事件接口返回 HTTP {}", response.status()));
    }
    Ok(())
}

fn report_event(
    config: UpdateConfig,
    event: &'static str,
    release_id: Option<String>,
    download_source: Option<String>,
    fallback_used: bool,
) {
    tauri::async_runtime::spawn(async move {
        if let Err(error) = send_event(
            &config,
            event,
            release_id.as_deref(),
            download_source.as_deref(),
            fallback_used,
            None,
        )
        .await
        {
            log::debug!("best-effort update event failed: {error}");
        }
    });
}

fn build_updater(app: &AppHandle) -> Result<(Updater, UpdateConfig), String> {
    let config = resolved_config()?;
    let (endpoint, timeout) = updater_endpoint(&config)?;
    let mut builder = app
        .updater_builder()
        .endpoints(vec![endpoint])
        .map_err(|error| format!("更新端点配置失败：{error}"))?
        .timeout(timeout);

    if config.channel == "stable" {
        builder = builder
            .header("X-Installation-Id", config.device_id.clone())
            .map_err(|error| format!("更新 installation ID 配置失败：{error}"))?;
    } else {
        if config.device_id.trim().is_empty() {
            return Err("内测邀请缺少 device ID，请重新导入邀请配置".to_string());
        }
        let token = resolved_device_token(&config.device_id)?;
        builder = builder
            .header("Authorization", format!("Bearer {token}"))
            .and_then(|builder| builder.header("X-Device-Id", config.device_id.clone()))
            .map_err(|error| format!("更新认证头配置失败：{error}"))?;
    }

    let updater = builder
        .build()
        .map_err(|error| format!("Tauri updater 初始化失败：{error}"))?;
    Ok((updater, config))
}

fn parse_update_metadata(raw_json: &serde_json::Value) -> Result<ShellUpdateMetadata, String> {
    let value = raw_json
        .get("metadata")
        .ok_or_else(|| "更新响应缺少 metadata".to_string())?
        .clone();
    let metadata: ShellUpdateMetadata = serde_json::from_value(value)
        .map_err(|error| format!("更新 metadata 格式无效：{error}"))?;
    if metadata.schema_version != 2 {
        return Err(format!(
            "更新 metadata schemaVersion 必须为 2，当前是 {}",
            metadata.schema_version
        ));
    }
    if metadata.release_id.trim().is_empty() {
        return Err("更新 metadata 缺少 releaseId".to_string());
    }
    if metadata.channel.trim().is_empty() {
        return Err("更新 metadata 缺少 channel".to_string());
    }
    if metadata.github_release_tag.trim().is_empty() {
        return Err("更新 metadata 缺少 githubReleaseTag".to_string());
    }
    if metadata.sha256.len() != 64 || !metadata.sha256.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return Err("更新 metadata 的 sha256 无效".to_string());
    }
    if metadata.size == 0 || metadata.size > MAX_UPDATER_BYTES {
        return Err(format!(
            "更新资产大小必须在 1 到 {MAX_UPDATER_BYTES} 字节之间"
        ));
    }
    if metadata.bundled_core_version.trim().is_empty() {
        return Err("更新 metadata 缺少 bundledCoreVersion".to_string());
    }
    if metadata.bundled_runtime_version.trim().is_empty() {
        return Err("更新 metadata 缺少 bundledRuntimeVersion".to_string());
    }
    validate_github_fallback_url(&metadata)?;
    Ok(metadata)
}

fn validate_github_fallback_url(metadata: &ShellUpdateMetadata) -> Result<Url, String> {
    let url = Url::parse(&metadata.github_fallback_url)
        .map_err(|error| format!("githubFallbackUrl 无效：{error}"))?;
    if url.scheme() != "https"
        || url.host_str() != Some("github.com")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("githubFallbackUrl 必须是无凭据、无查询参数的 GitHub HTTPS 直链".to_string());
    }
    let segments = url
        .path_segments()
        .map(|items| items.collect::<Vec<_>>())
        .unwrap_or_default();
    let valid = segments.len() == 6
        && segments[0] == "Eynzof"
        && segments[1] == "Hermes-CN-Desktop"
        && segments[2] == "releases"
        && segments[3] == "download"
        && segments[4] == metadata.github_release_tag
        && !segments[5].is_empty()
        && !segments[5].contains('%');
    if !valid {
        return Err(
            "githubFallbackUrl 必须指向 Eynzof/Hermes-CN-Desktop 的固定 tag 单层资产".to_string(),
        );
    }
    Ok(url)
}

fn validate_primary_download_url(
    primary: &Url,
    metadata: &ShellUpdateMetadata,
) -> Result<(), String> {
    let fallback = validate_github_fallback_url(metadata)?;
    let primary_segments = primary
        .path_segments()
        .map(|items| items.collect::<Vec<_>>())
        .unwrap_or_default();
    let fallback_segments = fallback
        .path_segments()
        .map(|items| items.collect::<Vec<_>>())
        .unwrap_or_default();
    let valid = primary.scheme() == "https"
        && PRIMARY_DOWNLOAD_HOSTS.contains(&primary.host_str().unwrap_or_default())
        && primary.username().is_empty()
        && primary.password().is_none()
        && primary.query().is_none()
        && primary.fragment().is_none()
        && primary_segments.len() == 2
        && fallback_segments.len() == 6
        && primary_segments[0] == metadata.github_release_tag
        && primary_segments[1] == fallback_segments[5]
        && !primary_segments[1].contains('%');
    if !valid {
        return Err(
            "更新主下载 URL 必须指向 Hermes Cloudflare 镜像中的同一固定 tag/资产".to_string(),
        );
    }
    Ok(())
}

fn validate_update_target(
    target_desktop_version: &str,
    raw_json: &serde_json::Value,
    expected_channel: &str,
) -> Result<ShellUpdateMetadata, String> {
    let metadata = parse_update_metadata(raw_json)?;
    if metadata.channel != expected_channel {
        return Err(format!(
            "更新 channel 不匹配：请求 {expected_channel}，响应 {}",
            metadata.channel
        ));
    }
    if metadata.github_release_tag != format!("v{target_desktop_version}") {
        return Err("githubReleaseTag 与目标 Desktop 版本不一致".to_string());
    }
    let expected_release_id = expected_release_id(target_desktop_version)?;
    if metadata.release_id != expected_release_id {
        return Err(format!(
            "releaseId 与目标平台不一致：期望 {expected_release_id}，实际 {}",
            metadata.release_id
        ));
    }
    let matrix = CompatibilityMatrix::parse_embedded()?;
    matrix.check(target_desktop_version, &metadata.bundled_core_version)?;
    matrix.check(target_desktop_version, &metadata.bundled_runtime_version)?;
    Ok(metadata)
}

fn no_update_result(channel: &str) -> AppUpdateCheckResult {
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
        channel: Some(channel.to_string()),
        manifest_source: Some(MANIFEST_SOURCE.to_string()),
        ..Default::default()
    }
}

fn check_failure(error: impl Into<String>) -> AppUpdateCheckResult {
    AppUpdateCheckResult {
        ok: false,
        current_version: Some(env!("CARGO_PKG_VERSION").to_string()),
        manifest_source: Some(MANIFEST_SOURCE.to_string()),
        error: Some(error.into()),
        ..Default::default()
    }
}

fn checked_update_result(update: &Update, channel: &str) -> AppUpdateCheckResult {
    let current_version = env!("CARGO_PKG_VERSION").to_string();
    let matrix = match CompatibilityMatrix::parse_embedded() {
        Ok(matrix) => matrix,
        Err(error) => return check_failure(error),
    };
    let expected_core_series = matrix.expected_core_series(&update.version);
    match validate_update_target(&update.version, &update.raw_json, channel) {
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
            manifest_source: Some(MANIFEST_SOURCE.to_string()),
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
            manifest_source: Some(MANIFEST_SOURCE.to_string()),
            notes: update.body.clone(),
            error: Some(error),
            ..Default::default()
        },
    }
}

fn fallback_allowed(error: &UpdaterError) -> bool {
    match error {
        UpdaterError::Reqwest(_) => true,
        UpdaterError::Network(message) => {
            let status = message
                .rsplit_once("status:")
                .and_then(|(_, value)| value.split_whitespace().next())
                .and_then(|value| value.parse::<u16>().ok());
            match status {
                Some(429) => true,
                Some(code) => (500..=599).contains(&code),
                None => true,
            }
        }
        _ => false,
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn validate_downloaded_bytes(bytes: &[u8], metadata: &ShellUpdateMetadata) -> Result<(), String> {
    if bytes.len() as u64 != metadata.size {
        return Err(format!(
            "更新资产大小不匹配：期望 {}，实际 {}",
            metadata.size,
            bytes.len()
        ));
    }
    let actual = sha256_hex(bytes);
    if !actual.eq_ignore_ascii_case(&metadata.sha256) {
        return Err(format!(
            "更新资产 SHA-256 不匹配：期望 {}，实际 {actual}",
            metadata.sha256
        ));
    }
    Ok(())
}

async fn download_from(
    app: &AppHandle,
    update: &Update,
    source: &'static str,
    fallback_used: bool,
) -> Result<Vec<u8>, UpdaterError> {
    let progress_app = app.clone();
    let finish_app = app.clone();
    let mut downloaded = 0_u64;
    let mut last_reported = 8_u8;
    update
        .download(
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
                        format!("已从 {source} 下载 {} MiB", downloaded / 1_048_576),
                        Some(source),
                        fallback_used,
                    );
                }
            },
            move || {
                emit_progress(
                    &finish_app,
                    "verify-signature",
                    92,
                    "下载完成，Tauri 签名验证通过",
                    Some(source),
                    fallback_used,
                );
            },
        )
        .await
}

async fn download_with_fallback(
    app: &AppHandle,
    update: &Update,
    metadata: &ShellUpdateMetadata,
) -> Result<DownloadOutcome, String> {
    validate_primary_download_url(&update.download_url, metadata)?;
    let mut primary = update.clone();
    primary.headers.clear();
    emit_progress(
        app,
        "download",
        8,
        format!("正在通过 Cloudflare 缓存下载 Desktop {}…", update.version),
        Some(PRIMARY_DOWNLOAD_SOURCE),
        false,
    );
    match download_from(app, &primary, PRIMARY_DOWNLOAD_SOURCE, false).await {
        Ok(bytes) => {
            validate_downloaded_bytes(&bytes, metadata)?;
            return Ok(DownloadOutcome {
                bytes,
                source: PRIMARY_DOWNLOAD_SOURCE,
                fallback_used: false,
            });
        }
        Err(error) if fallback_allowed(&error) => {
            emit_progress(
                app,
                "fallback",
                8,
                format!("Cloudflare 下载失败（{error}），改用 GitHub Release 直链"),
                Some(FALLBACK_DOWNLOAD_SOURCE),
                true,
            );
        }
        Err(error) => {
            return Err(format!(
                "Cloudflare 下载或签名验证失败，已禁止回退：{error}"
            ));
        }
    }

    let mut fallback = update.clone();
    fallback.headers.clear();
    fallback.download_url = validate_github_fallback_url(metadata)?;
    let bytes = download_from(app, &fallback, FALLBACK_DOWNLOAD_SOURCE, true)
        .await
        .map_err(|error| format!("GitHub Release 回退下载失败：{error}"))?;
    validate_downloaded_bytes(&bytes, metadata)?;
    Ok(DownloadOutcome {
        bytes,
        source: FALLBACK_DOWNLOAD_SOURCE,
        fallback_used: true,
    })
}

fn updater_cache_dir() -> PathBuf {
    crate::process::runtime::runtime_root().join(UPDATER_CACHE_DIR)
}

fn pending_record_path() -> PathBuf {
    updater_cache_dir().join(PENDING_RECORD_FILE)
}

fn pending_package_path() -> PathBuf {
    updater_cache_dir().join(PENDING_PACKAGE_FILE)
}

fn validate_cache_dir(path: &Path) -> Result<(), String> {
    let runtime_root = crate::process::runtime::runtime_root();
    if path.file_name().and_then(|name| name.to_str()) != Some(UPDATER_CACHE_DIR)
        || path.parent() != Some(runtime_root.as_path())
    {
        return Err("拒绝操作非本应用 updater 缓存目录".to_string());
    }
    Ok(())
}

fn clear_pending_cache() -> Result<(), String> {
    let dir = updater_cache_dir();
    validate_cache_dir(&dir)?;
    if dir.exists() {
        fs::remove_dir_all(&dir)
            .map_err(|error| format!("清理 updater 缓存失败 {}：{error}", dir.display()))?;
    }
    Ok(())
}

fn persist_pending(
    version: &str,
    metadata: &ShellUpdateMetadata,
    outcome: &DownloadOutcome,
) -> Result<(), String> {
    let dir = updater_cache_dir();
    validate_cache_dir(&dir)?;
    fs::create_dir_all(&dir)
        .map_err(|error| format!("创建 updater 缓存失败 {}：{error}", dir.display()))?;
    let package_tmp = dir.join("pending-update.bin.tmp");
    fs::write(&package_tmp, &outcome.bytes)
        .map_err(|error| format!("写入 updater 缓存失败：{error}"))?;
    fs::rename(&package_tmp, pending_package_path())
        .map_err(|error| format!("替换 updater 包失败：{error}"))?;

    let record = PendingUpdateRecord {
        schema_version: 1,
        version: version.to_string(),
        release_id: metadata.release_id.clone(),
        sha256: metadata.sha256.to_ascii_lowercase(),
        size: metadata.size,
        download_source: outcome.source.to_string(),
        fallback_used: outcome.fallback_used,
        downloaded_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs(),
    };
    let record_tmp = dir.join("pending.json.tmp");
    let body = serde_json::to_vec_pretty(&record)
        .map_err(|error| format!("序列化 updater 缓存记录失败：{error}"))?;
    fs::write(&record_tmp, body).map_err(|error| format!("写入 updater 缓存记录失败：{error}"))?;
    fs::rename(&record_tmp, pending_record_path())
        .map_err(|error| format!("替换 updater 缓存记录失败：{error}"))?;
    Ok(())
}

fn read_pending_record() -> Result<Option<PendingUpdateRecord>, String> {
    let record_path = pending_record_path();
    let package_path = pending_package_path();
    if !record_path.is_file() || !package_path.is_file() {
        return Ok(None);
    }
    let record: PendingUpdateRecord = serde_json::from_slice(
        &fs::read(&record_path).map_err(|error| format!("读取 updater 缓存记录失败：{error}"))?,
    )
    .map_err(|error| format!("updater 缓存记录无效：{error}"))?;
    if record.schema_version != 1 {
        return Err("updater 缓存记录 schemaVersion 无效".to_string());
    }
    if record.version == env!("CARGO_PKG_VERSION") {
        clear_pending_cache()?;
        return Ok(None);
    }
    let size = fs::metadata(&package_path)
        .map_err(|error| format!("读取 updater 缓存文件信息失败：{error}"))?
        .len();
    if size != record.size || size == 0 || size > MAX_UPDATER_BYTES {
        return Err("updater 缓存包大小与记录不一致".to_string());
    }
    Ok(Some(record))
}

#[tauri::command]
pub fn app_update_pending() -> AppUpdatePendingResult {
    match read_pending_record() {
        Ok(Some(record)) => AppUpdatePendingResult {
            ready: true,
            version: Some(record.version),
            release_id: Some(record.release_id),
            download_source: Some(record.download_source),
            fallback_used: record.fallback_used,
            error: None,
        },
        Ok(None) => AppUpdatePendingResult::default(),
        Err(error) => AppUpdatePendingResult {
            error: Some(error),
            ..Default::default()
        },
    }
}

#[tauri::command]
pub async fn app_update_check(app: AppHandle) -> AppUpdateCheckResult {
    emit_progress(
        &app,
        "check",
        1,
        "正在检查可下发的 Desktop 更新…",
        None,
        false,
    );
    let (updater, config) = match build_updater(&app) {
        Ok(value) => value,
        Err(error) => return check_failure(error),
    };
    let result = match updater.check().await {
        Ok(Some(update)) => checked_update_result(&update, &config.channel),
        Ok(None) => no_update_result(&config.channel),
        Err(error) => check_failure(format!("检查更新失败：{error}")),
    };
    report_event(config, "check", result.release_id.clone(), None, false);
    result
}

fn set_in_flight(state: &State<'_, AppState>) -> Result<(), String> {
    let mut inner = state
        .inner
        .lock()
        .map_err(|error| format!("更新状态锁失败：{error}"))?;
    if inner.app_update_in_flight {
        return Err("已有 Desktop 更新正在进行，请稍候".to_string());
    }
    inner.app_update_in_flight = true;
    Ok(())
}

fn clear_in_flight(state: &State<'_, AppState>) {
    if let Ok(mut inner) = state.inner.lock() {
        inner.app_update_in_flight = false;
    }
}

#[tauri::command]
pub async fn app_update_download(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<AppUpdateDownloadResult, AppError> {
    if let Err(error) = set_in_flight(&state) {
        return Ok(download_failure(error));
    }
    let result = run_download(&app).await;
    clear_in_flight(&state);
    Ok(result)
}

async fn run_download(app: &AppHandle) -> AppUpdateDownloadResult {
    emit_progress(app, "check", 2, "重新确认候选版本与兼容矩阵…", None, false);
    let (updater, config) = match build_updater(app) {
        Ok(value) => value,
        Err(error) => return download_failure(error),
    };
    let update = match updater.check().await {
        Ok(Some(update)) => update,
        Ok(None) => return download_failure("当前没有获准下载的更新"),
        Err(error) => return download_failure(format!("检查更新失败：{error}")),
    };
    let metadata = match validate_update_target(&update.version, &update.raw_json, &config.channel)
    {
        Ok(metadata) => metadata,
        Err(error) => return download_failure(error),
    };
    let outcome = match download_with_fallback(app, &update, &metadata).await {
        Ok(outcome) => outcome,
        Err(error) => return download_failure(error),
    };
    if let Err(error) = persist_pending(&update.version, &metadata, &outcome) {
        return download_failure(error);
    }
    if outcome.fallback_used {
        report_event(
            config.clone(),
            "fallback",
            Some(metadata.release_id.clone()),
            Some(outcome.source.to_string()),
            true,
        );
    }
    report_event(
        config,
        "download-success",
        Some(metadata.release_id.clone()),
        Some(outcome.source.to_string()),
        outcome.fallback_used,
    );
    emit_progress(
        app,
        "ready",
        96,
        "更新包已验证并缓存，可立即重启安装或稍后处理",
        Some(outcome.source),
        outcome.fallback_used,
    );
    AppUpdateDownloadResult {
        ok: true,
        ready: true,
        version: Some(update.version),
        release_id: Some(metadata.release_id),
        manifest_source: Some(MANIFEST_SOURCE.to_string()),
        download_source: Some(outcome.source.to_string()),
        fallback_used: outcome.fallback_used,
        error: None,
    }
}

#[tauri::command]
pub async fn app_update_install(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<AppUpdateInstallResult, AppError> {
    if let Err(error) = set_in_flight(&state) {
        return Ok(install_failure(error));
    }
    let result = run_install(&app, &state).await;
    clear_in_flight(&state);
    Ok(result)
}

async fn run_install(app: &AppHandle, state: &State<'_, AppState>) -> AppUpdateInstallResult {
    emit_progress(app, "check", 2, "安装前重新确认灰度授权…", None, false);
    let (updater, config) = match build_updater(app) {
        Ok(value) => value,
        Err(error) => return install_failure(error),
    };
    let update = match updater.check().await {
        Ok(Some(update)) => update,
        Ok(None) => return install_failure("当前没有获准安装的更新"),
        Err(error) => return install_failure(format!("检查更新失败：{error}")),
    };
    let metadata = match validate_update_target(&update.version, &update.raw_json, &config.channel)
    {
        Ok(metadata) => metadata,
        Err(error) => return install_failure(error),
    };

    let (bytes, source, fallback_used) = match read_pending_record() {
        Ok(Some(record))
            if record.version == update.version
                && record.release_id == metadata.release_id
                && record.sha256.eq_ignore_ascii_case(&metadata.sha256) =>
        {
            let bytes = match fs::read(pending_package_path()) {
                Ok(bytes) => bytes,
                Err(error) => return install_failure(format!("读取已缓存更新包失败：{error}")),
            };
            if let Err(error) = validate_downloaded_bytes(&bytes, &metadata) {
                return install_failure(error);
            }
            (bytes, record.download_source, record.fallback_used)
        }
        Ok(_) => {
            let outcome = match download_with_fallback(app, &update, &metadata).await {
                Ok(outcome) => outcome,
                Err(error) => return install_failure(error),
            };
            if let Err(error) = persist_pending(&update.version, &metadata, &outcome) {
                return install_failure(error);
            }
            (
                outcome.bytes,
                outcome.source.to_string(),
                outcome.fallback_used,
            )
        }
        Err(error) => return install_failure(error),
    };

    emit_progress(
        app,
        "stop-runtime",
        97,
        "正在停止本应用管理的 Runtime…",
        Some(&source),
        fallback_used,
    );
    if let Err(error) = stop_owned_runtime(state) {
        return install_failure(error);
    }
    if let Err(error) = stop_sibling_desktop_instances() {
        return install_failure(error);
    }
    if let Err(error) = send_event(
        &config,
        "install-start",
        Some(&metadata.release_id),
        Some(&source),
        fallback_used,
        None,
    )
    .await
    {
        log::debug!("best-effort install-start event failed: {error}");
    }
    emit_progress(
        app,
        "install",
        99,
        "正在启动系统安装器，应用即将退出…",
        Some(&source),
        fallback_used,
    );
    match launch_verified_update(&update, bytes) {
        Ok(()) => AppUpdateInstallResult {
            ok: true,
            install_started: true,
            manifest_source: Some(MANIFEST_SOURCE.to_string()),
            download_source: Some(source),
            fallback_used,
            error: None,
        },
        Err(error) => install_failure(error),
    }
}

#[cfg(target_os = "windows")]
fn launch_verified_update(_update: &Update, bytes: Vec<u8>) -> Result<(), String> {
    let installer = pending_package_path();
    let cached_size = fs::metadata(&installer)
        .map_err(|error| format!("读取 Windows updater 缓存失败：{error}"))?
        .len();
    if cached_size != bytes.len() as u64 {
        return Err(format!(
            "Windows updater 缓存大小不匹配：期望 {}，实际 {cached_size}",
            bytes.len()
        ));
    }

    // `tauri-plugin-updater` 2.10.1 ignores ShellExecuteW's return value and
    // exits the running app even when Windows did not start the installer.
    // The package has already passed the plugin's detached-signature check and
    // our size/SHA checks. Launch the owned persistent cache file directly so
    // CreateProcess errors are observable before the current app exits.
    drop(bytes);
    let _child = std::process::Command::new(&installer)
        .args(WINDOWS_NSIS_INSTALL_ARGS)
        .spawn()
        .map_err(|error| format!("启动 Windows updater 失败：{error}"))?;
    std::process::exit(0);
}

#[cfg(not(target_os = "windows"))]
fn launch_verified_update(update: &Update, bytes: Vec<u8>) -> Result<(), String> {
    update
        .install(bytes)
        .map_err(|error| format!("启动安装器失败：{error}"))
}

fn stop_owned_runtime(state: &State<'_, AppState>) -> Result<(), String> {
    let (relay, mut dashboard_handle, session_token) = {
        let mut inner = state
            .inner
            .lock()
            .map_err(|error| format!("停止 Runtime 时状态锁失败：{error}"))?;
        (
            inner.gateway_ws.take(),
            inner.dashboard_handle.take(),
            inner.session_token.clone(),
        )
    };
    if let Some(relay) = relay {
        relay.abort.store(true, Ordering::Relaxed);
        relay.notify.notify_waiters();
    }
    let stop_failed = dashboard_handle.as_mut().is_some_and(|handle| {
        handle.owns_process
            && !dashboard::terminate_owned_dashboard_tree(
                &handle.api_base_url,
                handle.child.as_mut(),
                handle.attached_pid,
                session_token.as_deref(),
            )
    });
    if stop_failed {
        if let Ok(mut inner) = state.inner.lock() {
            if inner.dashboard_handle.is_none() {
                inner.dashboard_handle = dashboard_handle;
            }
        }
        return Err("无法停止本应用管理的 Runtime，已取消安装".to_string());
    }
    Ok(())
}

fn executable_key(path: &Path) -> String {
    let path = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let value = path.to_string_lossy().to_string();
    if cfg!(target_os = "windows") {
        value.to_ascii_lowercase()
    } else {
        value
    }
}

fn process_snapshot() -> System {
    System::new_with_specifics(
        RefreshKind::nothing()
            .with_processes(ProcessRefreshKind::nothing().with_exe(UpdateKind::Always)),
    )
}

fn sibling_desktop_pids(executable: &Path) -> Vec<sysinfo::Pid> {
    let current_pid = sysinfo::get_current_pid().ok();
    let expected = executable_key(executable);
    process_snapshot()
        .processes()
        .iter()
        .filter_map(|(pid, process)| {
            if Some(*pid) == current_pid {
                return None;
            }
            process
                .exe()
                .filter(|path| executable_key(path) == expected)
                .map(|_| *pid)
        })
        .collect()
}

fn stop_sibling_desktop_instances() -> Result<(), String> {
    let executable = std::env::current_exe()
        .map_err(|error| format!("无法确认当前 Desktop 可执行文件：{error}"))?;
    let system = process_snapshot();
    let siblings = sibling_desktop_pids(&executable);
    for pid in &siblings {
        let process = system
            .process(*pid)
            .ok_or_else(|| format!("Desktop 实例 {pid} 在停止前已不可见"))?;
        if !process.kill() {
            return Err(format!(
                "无法停止同一可执行文件的 Desktop 实例 {pid}，已取消安装"
            ));
        }
    }
    if siblings.is_empty() {
        return Ok(());
    }

    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if sibling_desktop_pids(&executable).is_empty() {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err("等待其他 Desktop 实例退出超时，已取消安装".to_string());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

fn download_failure(error: impl Into<String>) -> AppUpdateDownloadResult {
    AppUpdateDownloadResult {
        manifest_source: Some(MANIFEST_SOURCE.to_string()),
        error: Some(error.into()),
        ..Default::default()
    }
}

fn install_failure(error: impl Into<String>) -> AppUpdateInstallResult {
    AppUpdateInstallResult {
        manifest_source: Some(MANIFEST_SOURCE.to_string()),
        error: Some(error.into()),
        ..Default::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    fn raw_update(core: &str, runtime: &str) -> serde_json::Value {
        let bytes = b"signed updater bytes";
        let release_id = expected_release_id("0.8.1-hotupdate.1").unwrap();
        serde_json::json!({
            "version": "0.8.1-hotupdate.1",
            "url": "https://dl-desktop.hermesagent.org.cn/v0.8.1-hotupdate.1/update.exe",
            "signature": "signed",
            "metadata": {
                "schemaVersion": 2,
                "releaseId": release_id,
                "channel": "prototype",
                "githubReleaseTag": "v0.8.1-hotupdate.1",
                "githubFallbackUrl": "https://github.com/Eynzof/Hermes-CN-Desktop/releases/download/v0.8.1-hotupdate.1/update.exe",
                "sha256": sha256_hex(bytes),
                "size": bytes.len(),
                "bundledCoreVersion": core,
                "bundledRuntimeVersion": runtime,
                "runtimeRevision": 9
            }
        })
    }

    #[test]
    fn parses_required_tauri_metadata() {
        let metadata = parse_update_metadata(&raw_update("0.20.0", "0.20.0-cn.9")).unwrap();
        assert_eq!(
            metadata.release_id,
            expected_release_id("0.8.1-hotupdate.1").unwrap()
        );
        assert_eq!(metadata.channel, "prototype");
        assert_eq!(metadata.bundled_core_version, "0.20.0");
        assert_eq!(metadata.runtime_revision, 9);
    }

    #[test]
    fn accepts_desktop_08_with_core_020() {
        let metadata = validate_update_target(
            "0.8.1-hotupdate.1",
            &raw_update("0.20.0", "0.20.0-cn.9"),
            "prototype",
        )
        .unwrap();
        assert_eq!(metadata.bundled_runtime_version, "0.20.0-cn.9");
    }

    #[test]
    fn rejects_target_with_incompatible_core() {
        let error = validate_update_target(
            "0.8.1-hotupdate.1",
            &raw_update("0.19.9", "0.19.9-cn.7"),
            "prototype",
        )
        .unwrap_err();
        assert!(error.contains("仅兼容 Core 0.20.x"));
    }

    #[test]
    fn rejects_channel_mismatch() {
        let error = validate_update_target(
            "0.8.1-hotupdate.1",
            &raw_update("0.20.0", "0.20.0-cn.9"),
            "canary",
        )
        .unwrap_err();
        assert!(error.contains("channel 不匹配"));
    }

    #[test]
    fn rejects_release_id_for_another_target() {
        let mut raw = raw_update("0.20.0", "0.20.0-cn.9");
        raw["metadata"]["releaseId"] = serde_json::json!("desktop-0.8.1-hotupdate.1-other-x86_64");
        let error = validate_update_target("0.8.1-hotupdate.1", &raw, "prototype").unwrap_err();
        assert!(error.contains("releaseId 与目标平台不一致"));
    }

    #[test]
    fn fallback_url_is_closed_to_the_fixed_repository() {
        let mut metadata = parse_update_metadata(&raw_update("0.20.0", "0.20.0-cn.9")).unwrap();
        metadata.github_fallback_url =
            "https://example.com/Eynzof/Hermes-CN-Desktop/releases/download/v0.8.1-hotupdate.1/update.exe"
                .to_string();
        assert!(validate_github_fallback_url(&metadata).is_err());
    }

    #[test]
    fn primary_url_is_closed_to_the_matching_cloudflare_asset() {
        let metadata = parse_update_metadata(&raw_update("0.20.0", "0.20.0-cn.9")).unwrap();
        let valid =
            Url::parse("https://dl-desktop.hermesagent.org.cn/v0.8.1-hotupdate.1/update.exe")
                .unwrap();
        validate_primary_download_url(&valid, &metadata).unwrap();
        let external = Url::parse("https://example.com/v0.8.1-hotupdate.1/update.exe").unwrap();
        assert!(validate_primary_download_url(&external, &metadata).is_err());
        let other_asset =
            Url::parse("https://dl-desktop.hermesagent.org.cn/v0.8.1-hotupdate.1/other.exe")
                .unwrap();
        assert!(validate_primary_download_url(&other_asset, &metadata).is_err());
    }

    #[test]
    fn fallback_only_accepts_429_and_5xx_http_statuses() {
        assert!(fallback_allowed(&UpdaterError::Network(
            "Download request failed with status: 429 Too Many Requests".to_string()
        )));
        assert!(fallback_allowed(&UpdaterError::Network(
            "Download request failed with status: 503 Service Unavailable".to_string()
        )));
        assert!(!fallback_allowed(&UpdaterError::Network(
            "Download request failed with status: 401 Unauthorized".to_string()
        )));
        assert!(!fallback_allowed(&UpdaterError::Network(
            "Download request failed with status: 403 Forbidden".to_string()
        )));
        assert!(!fallback_allowed(&UpdaterError::Network(
            "Download request failed with status: 404 Not Found".to_string()
        )));
    }

    #[test]
    fn validates_metadata_sha_and_size_after_signature() {
        let bytes = b"signed updater bytes";
        let metadata = parse_update_metadata(&raw_update("0.20.0", "0.20.0-cn.9")).unwrap();
        validate_downloaded_bytes(bytes, &metadata).unwrap();
        assert!(validate_downloaded_bytes(b"tampered", &metadata).is_err());
    }

    #[test]
    fn rejects_missing_metadata() {
        let error = parse_update_metadata(&serde_json::json!({"version": "0.8.1"})).unwrap_err();
        assert_eq!(error, "更新响应缺少 metadata");
    }
}
