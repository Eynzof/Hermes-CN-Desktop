//! Desktop shell update support.
//!
//! The desktop app uses the landing-site `latest.json` as the public update
//! manifest. Checking an update only reads that manifest; installing an update
//! re-reads it, selects the current platform installer, downloads it, verifies
//! its required SHA-256 digest, and opens the installer with the OS.

use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};

use crate::brand_generated::{
    BRAND_APP_NAME, BRAND_UPDATE_MANIFEST_URL as DESKTOP_UPDATE_MANIFEST_URL,
};

const DESKTOP_UPDATE_TIMEOUT: Duration = Duration::from_secs(10);
const DESKTOP_INSTALL_TIMEOUT: Duration = Duration::from_secs(20 * 60);
pub const DESKTOP_UPDATE_PROGRESS_EVENT: &str = "desktop-update-progress";

static DESKTOP_UPDATE_HTTP_CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .timeout(DESKTOP_UPDATE_TIMEOUT)
        .redirect(https_only_redirect_policy())
        .user_agent("hermes-agent-cn-desktop-update-check")
        .build()
        .expect("valid desktop update HTTP client")
});

static DESKTOP_INSTALL_HTTP_CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .timeout(DESKTOP_INSTALL_TIMEOUT)
        .redirect(https_only_redirect_policy())
        .user_agent("hermes-agent-cn-desktop-update-install")
        .build()
        .expect("valid desktop update install HTTP client")
});

static DESKTOP_UPDATE_INSTALL_LOCK: LazyLock<tokio::sync::Mutex<()>> =
    LazyLock::new(|| tokio::sync::Mutex::new(()));

fn https_only_redirect_policy() -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::custom(|attempt| {
        if attempt.previous().len() >= 10 {
            attempt.error("too many desktop update redirects")
        } else if attempt.url().scheme() == "https" {
            attempt.follow()
        } else {
            attempt.stop()
        }
    })
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopUpdateAsset {
    pub label: Option<String>,
    pub platform: Option<String>,
    pub file_name: Option<String>,
    pub size: Option<u64>,
    pub sha256: Option<String>,
    pub url: Option<String>,
    pub versioned_url: Option<String>,
    pub source_url: Option<String>,
    pub baidu_pan_url: Option<String>,
    pub baidu_pan_code: Option<String>,
    pub quark_pan_url: Option<String>,
    pub quark_pan_code: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopUpdateManifest {
    pub repository: Option<String>,
    pub version: Option<String>,
    pub semver: Option<String>,
    pub published_at: Option<String>,
    pub source_url: Option<String>,
    pub updated_at: Option<String>,
    pub assets: Option<BTreeMap<String, DesktopUpdateAsset>>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopUpdateManifestFetchResult {
    pub ok: bool,
    pub manifest_url: String,
    pub manifest: Option<DesktopUpdateManifest>,
    pub error: Option<String>,
    pub checked_at_ms: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopInstallUpdateResult {
    pub ok: bool,
    pub manifest_url: String,
    pub asset: Option<DesktopUpdateAsset>,
    pub file_path: Option<String>,
    pub bytes_downloaded: u64,
    pub bytes_total: Option<u64>,
    pub launched: bool,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopInstallUpdateProgress {
    pub stage: &'static str,
    pub bytes_downloaded: u64,
    pub bytes_total: Option<u64>,
    pub percent: Option<u8>,
    pub file_name: Option<String>,
    pub message: Option<String>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn download_percent(bytes_downloaded: u64, bytes_total: Option<u64>) -> Option<u8> {
    let total = bytes_total?;
    if total == 0 {
        return None;
    }
    Some(((bytes_downloaded.saturating_mul(100) / total).min(100)) as u8)
}

fn emit_install_progress(
    app: Option<&AppHandle>,
    stage: &'static str,
    bytes_downloaded: u64,
    bytes_total: Option<u64>,
    file_name: Option<String>,
    message: Option<&str>,
) {
    let Some(app) = app else {
        return;
    };
    let _ = app.emit(
        DESKTOP_UPDATE_PROGRESS_EVENT,
        DesktopInstallUpdateProgress {
            stage,
            bytes_downloaded,
            bytes_total,
            percent: download_percent(bytes_downloaded, bytes_total),
            file_name,
            message: message.map(str::to_string),
        },
    );
}

async fn fetch_desktop_update_manifest_from(
    client: &reqwest::Client,
    manifest_url: &str,
) -> DesktopUpdateManifestFetchResult {
    let checked_at_ms = now_ms();
    let response = match client
        .get(manifest_url)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
    {
        Ok(response) => response,
        Err(error) => {
            return DesktopUpdateManifestFetchResult {
                ok: false,
                manifest_url: manifest_url.to_string(),
                manifest: None,
                error: Some(format!("检查更新失败：{}", error)),
                checked_at_ms,
            }
        }
    };

    let status = response.status();
    if !status.is_success() {
        return DesktopUpdateManifestFetchResult {
            ok: false,
            manifest_url: manifest_url.to_string(),
            manifest: None,
            error: Some(format!("检查更新失败：服务返回异常（{}）", status.as_u16())),
            checked_at_ms,
        };
    }

    match response.json::<DesktopUpdateManifest>().await {
        Ok(manifest) => DesktopUpdateManifestFetchResult {
            ok: true,
            manifest_url: manifest_url.to_string(),
            manifest: Some(manifest),
            error: None,
            checked_at_ms,
        },
        Err(error) => DesktopUpdateManifestFetchResult {
            ok: false,
            manifest_url: manifest_url.to_string(),
            manifest: None,
            error: Some(format!("检查更新失败：更新信息格式异常（{}）", error)),
            checked_at_ms,
        },
    }
}

#[tauri::command]
pub async fn desktop_check_update() -> DesktopUpdateManifestFetchResult {
    fetch_desktop_update_manifest_from(&DESKTOP_UPDATE_HTTP_CLIENT, DESKTOP_UPDATE_MANIFEST_URL)
        .await
}

#[tauri::command]
pub async fn desktop_install_update(app: AppHandle) -> DesktopInstallUpdateResult {
    let _install_guard = DESKTOP_UPDATE_INSTALL_LOCK.lock().await;
    install_desktop_update_from(
        &DESKTOP_UPDATE_HTTP_CLIENT,
        &DESKTOP_INSTALL_HTTP_CLIENT,
        DESKTOP_UPDATE_MANIFEST_URL,
        Some(&app),
    )
    .await
}

async fn install_desktop_update_from(
    manifest_client: &reqwest::Client,
    download_client: &reqwest::Client,
    manifest_url: &str,
    app: Option<&AppHandle>,
) -> DesktopInstallUpdateResult {
    emit_install_progress(app, "starting", 0, None, None, Some("正在读取更新清单"));
    let fetched = fetch_desktop_update_manifest_from(manifest_client, manifest_url).await;
    if !fetched.ok {
        if let Some(error) = fetched.error.as_deref() {
            emit_install_progress(app, "error", 0, None, None, Some(error));
        }
        return DesktopInstallUpdateResult {
            ok: false,
            manifest_url: fetched.manifest_url,
            asset: None,
            file_path: None,
            bytes_downloaded: 0,
            bytes_total: None,
            launched: false,
            error: fetched.error,
        };
    }

    let Some(manifest) = fetched.manifest else {
        return install_error(app, manifest_url, None, 0, None, "桌面端更新清单为空");
    };
    let Some(asset) = select_platform_asset(&manifest) else {
        return install_error(
            app,
            manifest_url,
            None,
            0,
            None,
            "更新清单中没有当前系统可用的安装包",
        );
    };
    let Some(download_url) = asset_download_url(&asset) else {
        return install_error(
            app,
            manifest_url,
            Some(asset),
            0,
            None,
            "安装包缺少 HTTPS 下载地址",
        );
    };
    let Some(expected_sha256) = asset.sha256.as_deref().and_then(valid_sha256) else {
        return install_error(
            app,
            manifest_url,
            Some(asset),
            0,
            None,
            "更新清单缺少有效的安装包 SHA-256",
        );
    };

    let raw_file_name = asset
        .file_name
        .clone()
        .or_else(|| url_file_name(&download_url))
        .unwrap_or_else(|| default_installer_file_name().to_string());
    let file_name = safe_file_name(&raw_file_name);
    let dir = desktop_update_download_dir();
    if let Err(err) = fs::create_dir_all(&dir) {
        return install_error(
            app,
            manifest_url,
            Some(asset),
            0,
            None,
            &format!("创建下载目录失败：{}", err),
        );
    }
    let file_path = dir.join(file_name);

    let downloaded = match download_installer(download_client, &download_url, &file_path, app).await
    {
        Ok(downloaded) => downloaded,
        Err(err) => {
            return install_error(
                app,
                manifest_url,
                Some(asset),
                err.bytes_downloaded,
                err.bytes_total,
                &err.message,
            )
        }
    };

    let progress_file_name = file_path
        .file_name()
        .and_then(|name| name.to_str())
        .map(str::to_string);
    emit_install_progress(
        app,
        "verifying",
        downloaded.bytes_downloaded,
        downloaded.bytes_total,
        progress_file_name.clone(),
        Some("正在校验安装包"),
    );

    let verification_path = downloaded.temp_path.clone();
    let actual_sha256 =
        match tokio::task::spawn_blocking(move || file_sha256(&verification_path)).await {
            Ok(Ok(actual)) => actual,
            Ok(Err(err)) => {
                remove_downloaded_installer(&downloaded.temp_path);
                return install_error(
                    app,
                    manifest_url,
                    Some(asset),
                    downloaded.bytes_downloaded,
                    downloaded.bytes_total,
                    &format!("读取安装包校验失败：{}", err),
                );
            }
            Err(err) => {
                remove_downloaded_installer(&downloaded.temp_path);
                return install_error(
                    app,
                    manifest_url,
                    Some(asset),
                    downloaded.bytes_downloaded,
                    downloaded.bytes_total,
                    &format!("安装包校验任务失败：{}", err),
                );
            }
        };
    if actual_sha256 != expected_sha256 {
        remove_downloaded_installer(&downloaded.temp_path);
        return install_error(
            app,
            manifest_url,
            Some(asset),
            downloaded.bytes_downloaded,
            downloaded.bytes_total,
            "安装包 SHA-256 校验失败，已删除下载文件",
        );
    }
    if let Err(err) = promote_downloaded_installer(&downloaded.temp_path, &file_path) {
        remove_downloaded_installer(&downloaded.temp_path);
        return install_error(
            app,
            manifest_url,
            Some(asset),
            downloaded.bytes_downloaded,
            downloaded.bytes_total,
            &format!("保存安装包失败：{}", err),
        );
    }

    emit_install_progress(
        app,
        "launching",
        downloaded.bytes_downloaded,
        downloaded.bytes_total,
        progress_file_name.clone(),
        Some(
            if should_exit_after_installer_launch(std::env::consts::OS) {
                "正在启动安装程序并重启应用"
            } else {
                "正在打开安装包"
            },
        ),
    );
    if let Err(err) = open::that(&file_path) {
        return install_error(
            app,
            manifest_url,
            Some(asset),
            downloaded.bytes_downloaded,
            downloaded.bytes_total,
            &format!("启动安装包失败：{}", err),
        );
    }

    emit_install_progress(
        app,
        "complete",
        downloaded.bytes_downloaded,
        downloaded.bytes_total,
        progress_file_name,
        Some(
            if should_exit_after_installer_launch(std::env::consts::OS) {
                "安装程序已启动，应用即将退出"
            } else {
                "安装包已打开"
            },
        ),
    );

    schedule_exit_after_installer_launch(app);

    DesktopInstallUpdateResult {
        ok: true,
        manifest_url: manifest_url.to_string(),
        asset: Some(asset),
        file_path: Some(file_path.to_string_lossy().to_string()),
        bytes_downloaded: downloaded.bytes_downloaded,
        bytes_total: downloaded.bytes_total,
        launched: true,
        error: None,
    }
}

fn should_exit_after_installer_launch(platform: &str) -> bool {
    platform == "windows"
}

fn schedule_exit_after_installer_launch(app: Option<&AppHandle>) {
    if !should_exit_after_installer_launch(std::env::consts::OS) {
        return;
    }
    let Some(app) = app.cloned() else {
        return;
    };

    tauri::async_runtime::spawn(async move {
        // Give the final progress event and IPC response time to reach the
        // renderer, then release the running executable for the NSIS installer.
        tokio::time::sleep(Duration::from_millis(350)).await;
        app.exit(0);
    });
}

fn install_error(
    app: Option<&AppHandle>,
    manifest_url: &str,
    asset: Option<DesktopUpdateAsset>,
    bytes_downloaded: u64,
    bytes_total: Option<u64>,
    message: &str,
) -> DesktopInstallUpdateResult {
    let file_name = asset.as_ref().and_then(|value| value.file_name.clone());
    emit_install_progress(
        app,
        "error",
        bytes_downloaded,
        bytes_total,
        file_name,
        Some(message),
    );
    DesktopInstallUpdateResult {
        ok: false,
        manifest_url: manifest_url.to_string(),
        asset,
        file_path: None,
        bytes_downloaded,
        bytes_total,
        launched: false,
        error: Some(message.to_string()),
    }
}

#[derive(Debug)]
struct DownloadedInstaller {
    temp_path: PathBuf,
    bytes_downloaded: u64,
    bytes_total: Option<u64>,
}

#[derive(Debug)]
struct DownloadInstallError {
    message: String,
    bytes_downloaded: u64,
    bytes_total: Option<u64>,
}

async fn download_installer(
    client: &reqwest::Client,
    url: &str,
    target: &Path,
    app: Option<&AppHandle>,
) -> Result<DownloadedInstaller, DownloadInstallError> {
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|err| DownloadInstallError {
            message: format!("安装包下载请求失败：{}", err),
            bytes_downloaded: 0,
            bytes_total: None,
        })?;
    let status = response.status();
    let bytes_total = response.content_length();
    if !status.is_success() {
        return Err(DownloadInstallError {
            message: format!("安装包下载返回 HTTP {}", status.as_u16()),
            bytes_downloaded: 0,
            bytes_total,
        });
    }

    let file_name = target
        .file_name()
        .and_then(|name| name.to_str())
        .map(str::to_string);
    emit_install_progress(
        app,
        "downloading",
        0,
        bytes_total,
        file_name.clone(),
        Some("正在下载安装包"),
    );

    let temp_path = target.with_extension(format!(
        "{}download",
        target
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| format!("{ext}."))
            .unwrap_or_default()
    ));
    let mut file = File::create(&temp_path).map_err(|err| DownloadInstallError {
        message: format!("创建安装包文件失败：{}", err),
        bytes_downloaded: 0,
        bytes_total,
    })?;
    let mut bytes_downloaded = 0_u64;
    let mut last_reported_percent = None;
    let mut last_reported_bytes = 0_u64;
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(chunk) => chunk,
            Err(err) => {
                drop(file);
                remove_downloaded_installer(&temp_path);
                return Err(DownloadInstallError {
                    message: format!("安装包下载中断：{}", err),
                    bytes_downloaded,
                    bytes_total,
                });
            }
        };
        if let Err(err) = file.write_all(&chunk) {
            drop(file);
            remove_downloaded_installer(&temp_path);
            return Err(DownloadInstallError {
                message: format!("写入安装包失败：{}", err),
                bytes_downloaded,
                bytes_total,
            });
        }
        bytes_downloaded = bytes_downloaded.saturating_add(chunk.len() as u64);
        let percent = download_percent(bytes_downloaded, bytes_total);
        let should_report = percent != last_reported_percent
            || (percent.is_none()
                && bytes_downloaded.saturating_sub(last_reported_bytes) >= 1024 * 1024);
        if should_report {
            emit_install_progress(
                app,
                "downloading",
                bytes_downloaded,
                bytes_total,
                file_name.clone(),
                Some("正在下载安装包"),
            );
            last_reported_percent = percent;
            last_reported_bytes = bytes_downloaded;
        }
    }
    if let Err(err) = file.flush() {
        drop(file);
        remove_downloaded_installer(&temp_path);
        return Err(DownloadInstallError {
            message: format!("刷新安装包文件失败：{}", err),
            bytes_downloaded,
            bytes_total,
        });
    }
    drop(file);
    Ok(DownloadedInstaller {
        temp_path,
        bytes_downloaded,
        bytes_total,
    })
}

fn promote_downloaded_installer(temp_path: &Path, target: &Path) -> std::io::Result<()> {
    if target.exists() {
        fs::remove_file(target)?;
    }
    fs::rename(temp_path, target)
}

fn desktop_update_download_dir() -> PathBuf {
    dirs::download_dir()
        .or_else(dirs::data_dir)
        .unwrap_or_else(std::env::temp_dir)
        .join(format!("{} Updates", BRAND_APP_NAME))
}

fn safe_file_name(input: &str) -> String {
    let cleaned = input
        .chars()
        .map(|ch| match ch {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            ch if ch.is_control() => '_',
            ch => ch,
        })
        .collect::<String>();
    let trimmed = cleaned.trim().trim_matches('.').trim();
    if trimmed.is_empty() {
        default_installer_file_name().to_string()
    } else {
        trimmed.to_string()
    }
}

fn default_installer_file_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "desktop-update-setup.exe"
    } else if cfg!(target_os = "macos") {
        "desktop-update.dmg"
    } else {
        "desktop-update"
    }
}

fn url_file_name(raw: &str) -> Option<String> {
    let url = url::Url::parse(raw).ok()?;
    url.path_segments()
        .and_then(|mut segments| segments.rfind(|s| !s.is_empty()))
        .map(urlencoding::decode)
        .and_then(Result::ok)
        .map(|cow| cow.into_owned())
}

fn asset_download_url(asset: &DesktopUpdateAsset) -> Option<String> {
    [
        asset.versioned_url.as_deref(),
        asset.url.as_deref(),
        asset.source_url.as_deref(),
    ]
    .into_iter()
    .flatten()
    .map(str::trim)
    .find_map(|raw| {
        let parsed = url::Url::parse(raw).ok()?;
        (parsed.scheme() == "https").then(|| raw.to_string())
    })
}

fn valid_sha256(value: &str) -> Option<String> {
    let value = value.trim();
    (value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .then(|| value.to_ascii_lowercase())
}

fn remove_downloaded_installer(path: &Path) {
    if let Err(err) = fs::remove_file(path) {
        if err.kind() != std::io::ErrorKind::NotFound {
            log::warn!(
                "failed to remove desktop update file {}: {}",
                path.display(),
                err
            );
        }
    }
}

fn select_platform_asset(manifest: &DesktopUpdateManifest) -> Option<DesktopUpdateAsset> {
    let assets = manifest.assets.as_ref()?;
    assets
        .iter()
        .filter_map(|(key, asset)| {
            let score = platform_asset_score(key, asset);
            (score > 0).then_some((score, asset.clone()))
        })
        .max_by_key(|(score, _)| *score)
        .map(|(_, asset)| asset)
}

fn platform_asset_score(key: &str, asset: &DesktopUpdateAsset) -> i32 {
    let haystack = [
        key.to_ascii_lowercase(),
        asset
            .platform
            .clone()
            .unwrap_or_default()
            .to_ascii_lowercase(),
        asset
            .file_name
            .clone()
            .unwrap_or_default()
            .to_ascii_lowercase(),
        asset.label.clone().unwrap_or_default().to_ascii_lowercase(),
        asset.url.clone().unwrap_or_default().to_ascii_lowercase(),
        asset
            .versioned_url
            .clone()
            .unwrap_or_default()
            .to_ascii_lowercase(),
    ]
    .join(" ");

    if cfg!(target_os = "windows") {
        if !haystack.contains(".exe") {
            return 0;
        }
        let platform_match = haystack.contains("windows") || haystack.contains("win32");
        let architecture_bonus = if haystack.contains("x64") || haystack.contains("x86_64") {
            10
        } else {
            0
        };
        let setup_bonus = if haystack.contains("setup.exe") { 5 } else { 0 };
        return if platform_match { 100 } else { 70 } + architecture_bonus + setup_bonus;
    } else if cfg!(target_os = "macos") {
        if !haystack.contains(".dmg") {
            return 0;
        }
        let arch_match = if cfg!(target_arch = "aarch64") {
            haystack.contains("arm64") || haystack.contains("aarch64") || haystack.contains("apple")
        } else {
            haystack.contains("x64") || haystack.contains("x86_64") || haystack.contains("intel")
        };
        if (haystack.contains("macos") || haystack.contains("darwin")) && arch_match {
            return 110;
        }
        if haystack.contains("macos") || haystack.contains("darwin") || haystack.ends_with(".dmg") {
            return 80;
        }
    }
    0
}

fn file_sha256(path: &Path) -> std::io::Result<String> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = [0_u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn test_client(timeout: Duration) -> reqwest::Client {
        reqwest::Client::builder().timeout(timeout).build().unwrap()
    }

    #[tokio::test]
    async fn fetch_manifest_successfully() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/latest.json"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "repository": "Eynzof/Hermes-CN-Desktop",
                "version": "v0.3.1",
                "semver": "0.3.1",
                "assets": {
                    "windows": {
                        "label": "Windows 安装包",
                        "fileName": "Hermes.Agent.CN.Desktop_0.3.1_x64-setup.exe",
                        "url": "https://desktop.hermesagent.org.cn/download/windows/latest.exe"
                    }
                }
            })))
            .mount(&server)
            .await;

        let result = fetch_desktop_update_manifest_from(
            &test_client(Duration::from_secs(1)),
            &format!("{}/latest.json", server.uri()),
        )
        .await;

        assert!(result.ok, "{:?}", result.error);
        let manifest = result.manifest.expect("manifest");
        assert_eq!(manifest.semver.as_deref(), Some("0.3.1"));
        assert_eq!(manifest.version.as_deref(), Some("v0.3.1"));
        assert!(manifest.assets.unwrap().contains_key("windows"));
    }

    #[tokio::test]
    async fn reports_http_error() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/latest.json"))
            .respond_with(ResponseTemplate::new(404))
            .mount(&server)
            .await;

        let result = fetch_desktop_update_manifest_from(
            &test_client(Duration::from_secs(1)),
            &format!("{}/latest.json", server.uri()),
        )
        .await;

        assert!(!result.ok);
        assert!(result.error.unwrap_or_default().contains("404"));
    }

    #[tokio::test]
    async fn reports_invalid_json() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/latest.json"))
            .respond_with(ResponseTemplate::new(200).set_body_string("{"))
            .mount(&server)
            .await;

        let result = fetch_desktop_update_manifest_from(
            &test_client(Duration::from_secs(1)),
            &format!("{}/latest.json", server.uri()),
        )
        .await;

        assert!(!result.ok);
        assert!(result.error.unwrap_or_default().contains("格式异常"));
    }

    #[tokio::test]
    async fn reports_timeout() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/latest.json"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_delay(Duration::from_millis(120))
                    .set_body_json(serde_json::json!({ "semver": "0.3.1" })),
            )
            .mount(&server)
            .await;

        let result = fetch_desktop_update_manifest_from(
            &test_client(Duration::from_millis(20)),
            &format!("{}/latest.json", server.uri()),
        )
        .await;

        assert!(!result.ok);
        assert!(result.error.unwrap_or_default().contains("检查更新失败"));
    }

    #[test]
    fn safe_file_name_removes_path_separators() {
        assert_eq!(safe_file_name("..\\bad/name?.exe"), "_bad_name_.exe");
        assert_eq!(safe_file_name("..."), default_installer_file_name());
    }

    #[test]
    fn url_file_name_decodes_last_segment() {
        assert_eq!(
            url_file_name("https://example.com/download/Hermes%20Setup.exe").as_deref(),
            Some("Hermes Setup.exe")
        );
    }

    #[test]
    fn asset_download_url_requires_https_and_prefers_versioned_asset() {
        let asset = DesktopUpdateAsset {
            versioned_url: Some("https://cdn.example.com/releases/v1/setup.exe".into()),
            url: Some("https://cdn.example.com/latest/setup.exe".into()),
            source_url: Some("https://github.com/example/setup.exe".into()),
            ..Default::default()
        };
        assert_eq!(
            asset_download_url(&asset).as_deref(),
            Some("https://cdn.example.com/releases/v1/setup.exe")
        );

        let insecure = DesktopUpdateAsset {
            url: Some("http://cdn.example.com/setup.exe".into()),
            ..Default::default()
        };
        assert_eq!(asset_download_url(&insecure), None);
    }

    #[test]
    fn validates_sha256_digest_format() {
        let uppercase = "A".repeat(64);
        assert_eq!(valid_sha256(&uppercase), Some("a".repeat(64)));
        assert_eq!(valid_sha256("abc"), None);
        assert_eq!(valid_sha256(&"z".repeat(64)), None);
    }

    #[test]
    fn calculates_bounded_download_percent() {
        assert_eq!(download_percent(50, Some(100)), Some(50));
        assert_eq!(download_percent(150, Some(100)), Some(100));
        assert_eq!(download_percent(1, Some(0)), None);
        assert_eq!(download_percent(1, None), None);
    }

    #[tokio::test]
    async fn downloads_installer_via_temporary_file() {
        let server = MockServer::start().await;
        let body = b"verified installer bytes";
        Mock::given(method("GET"))
            .and(path("/setup.exe"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(body))
            .mount(&server)
            .await;

        let temp = tempfile::TempDir::new().unwrap();
        let target = temp.path().join("setup.exe");
        let downloaded = download_installer(
            &test_client(Duration::from_secs(1)),
            &format!("{}/setup.exe", server.uri()),
            &target,
            None,
        )
        .await
        .expect("installer download");

        assert_eq!(downloaded.bytes_downloaded, body.len() as u64);
        assert!(!target.exists());
        assert_eq!(fs::read(&downloaded.temp_path).unwrap(), body);

        promote_downloaded_installer(&downloaded.temp_path, &target).unwrap();
        assert_eq!(fs::read(&target).unwrap(), body);
        assert!(!target.with_extension("exe.download").exists());
    }

    #[test]
    fn platform_asset_score_matches_current_platform() {
        let windows = DesktopUpdateAsset {
            file_name: Some("Hermes_0.3.8_x64-setup.exe".into()),
            ..Default::default()
        };
        let mac = DesktopUpdateAsset {
            file_name: Some("Hermes_0.3.8_aarch64.dmg".into()),
            platform: Some("macos-arm64".into()),
            ..Default::default()
        };
        if cfg!(target_os = "windows") {
            assert!(
                platform_asset_score("windows", &windows) > platform_asset_score("macos", &mac)
            );
        } else if cfg!(target_os = "macos") {
            assert!(
                platform_asset_score("macos", &mac) > platform_asset_score("windows", &windows)
            );
        }
    }

    #[test]
    fn platform_asset_score_rejects_non_installer_archives() {
        let archive = DesktopUpdateAsset {
            file_name: Some("Hermes_0.6.8_windows_x64.zip".into()),
            platform: Some("windows".into()),
            ..Default::default()
        };
        let installer = DesktopUpdateAsset {
            file_name: Some("Hermes_0.6.8_windows_x64-setup.exe".into()),
            platform: Some("windows".into()),
            ..Default::default()
        };
        if cfg!(target_os = "windows") {
            assert_eq!(platform_asset_score("windows-portable", &archive), 0);
            assert!(platform_asset_score("windows", &installer) > 0);
        }
    }

    #[test]
    fn only_windows_installer_launches_require_app_exit() {
        assert!(should_exit_after_installer_launch("windows"));
        assert!(!should_exit_after_installer_launch("macos"));
        assert!(!should_exit_after_installer_launch("linux"));
    }
}
