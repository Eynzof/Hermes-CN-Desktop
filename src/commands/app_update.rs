//! Unified self-update — one button updates BOTH the desktop shell and the
//! backend kernel to the same version.
//!
//! Flow (see `docs/hot-update.md` §2):
//!
//! ```text
//! app_update_check   → fetch unified manifest (releaseManifestUrl) →
//!                      same-version validation (desktop == kernel) → result
//!
//! app_update_install → guards (managed + try_begin_restart + in-flight)
//!    ├─ [1] runtime::install_runtime_update(Some(embedded track-A manifest))
//!    │        (download + sha256 + Ed25519 + extract + smoke + record)
//!    ├─ [2] respawn_managed_dashboard → GET /api/version == manifest.version
//!    │        (fail → rollback_runtime + respawn + abort)
//!    ├─ [3] stage desktop installer (download + sha256 + Authenticode best-effort)
//!    ├─ [4] write pending-app-update.json + detached apply-desktop-update.mjs
//!    └─ app.exit(0) → updater waits for exit → silent install → relaunch
//! ```
//!
//! Progress is streamed to the renderer as `app-update-progress` events
//! (`{ phase, percent, message }`).

use std::cmp::Ordering;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, State};

use crate::error::AppError;
use crate::process::runtime;
use crate::state::AppState;
use crate::unified_manifest::{UnifiedReleaseManifest, UNIFIED_MANIFEST_SCHEMA_VERSION};

pub const APP_UPDATE_PROGRESS_EVENT: &str = "app-update-progress";
const PENDING_APP_UPDATE_FILE: &str = "pending-app-update.json";
const UPDATER_DIR: &str = "updater";
const UPDATER_SCRIPT_FILE: &str = "apply-desktop-update.mjs";
const DEFAULT_HTTP_TIMEOUT: Duration = Duration::from_secs(30);
const ARTIFACT_HTTP_TIMEOUT: Duration = Duration::from_secs(15 * 60);

/// The detached updater script, embedded so packaged builds are fully
/// self-contained (no repo files needed at update time).
const APPLY_DESKTOP_UPDATE_SOURCE: &str = include_str!("../../scripts/apply-desktop-update.mjs");

static APP_UPDATE_HTTP_CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .user_agent("hermes-agent-cn-desktop-unified-update")
        .build()
        .expect("valid app-update HTTP client")
});

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateCheckResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest_version: Option<String>,
    pub update_available: bool,
    pub same_version: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub manifest: Option<UnifiedReleaseManifest>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateInstallResult {
    pub ok: bool,
    pub backend_installed: bool,
    pub frontend_staged: bool,
    pub backend_verified: bool,
    pub frontend_installed: bool,
    pub restarted: bool,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PendingAppUpdateMarker {
    pub schema_version: u32,
    pub pid: u32,
    pub installer_path: String,
    pub target_version: String,
    pub kind: String,
    pub exe_path: String,
    pub timeout_ms: u64,
    pub created_at: String,
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

/// Numeric semver comparison on the `major.minor.patch` core (ignores
/// prerelease/build suffixes for ordering decisions). Returns `None` when
/// either side is not a parseable version.
fn compare_versions(left: &str, right: &str) -> Option<Ordering> {
    fn parse(v: &str) -> Option<Vec<u32>> {
        let core = v.trim().trim_start_matches('v').split(['-', '+']).next()?;
        let parts: Vec<u32> = core
            .split('.')
            .map(|p| p.parse::<u32>().ok())
            .collect::<Option<Vec<u32>>>()?;
        if parts.is_empty() {
            None
        } else {
            Some(parts)
        }
    }
    let a = parse(left)?;
    let b = parse(right)?;
    for i in 0..a.len().max(b.len()) {
        let av = a.get(i).copied().unwrap_or(0);
        let bv = b.get(i).copied().unwrap_or(0);
        if av != bv {
            return Some(av.cmp(&bv));
        }
    }
    Some(Ordering::Equal)
}

fn now_rfc3339() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let hh = rem / 3_600;
    let mm = (rem % 3_600) / 60;
    let ss = rem % 60;
    let (year, month, day) = civil_from_days(days);
    format!("{year:04}-{month:02}-{day:02}T{hh:02}:{mm:02}:{ss:02}Z")
}

/// Days since 1970-01-01 → proleptic Gregorian `(year, month, day)`, adapted
/// from Howard Hinnant's `civil_from_days` (mirrors runtime.rs).
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { year + 1 } else { year };
    (year, month as u32, day)
}

async fn fetch_unified_manifest(manifest_url: &str) -> Result<UnifiedReleaseManifest, String> {
    let response = APP_UPDATE_HTTP_CLIENT
        .get(manifest_url)
        .timeout(DEFAULT_HTTP_TIMEOUT)
        .send()
        .await
        .map_err(|e| format!("检查更新失败：{}", e))?;
    if !response.status().is_success() {
        return Err(format!(
            "检查更新失败：服务返回异常（{}）",
            response.status().as_u16()
        ));
    }
    let manifest: UnifiedReleaseManifest = response
        .json()
        .await
        .map_err(|e| format!("更新清单格式异常：{}", e))?;
    if manifest.schema_version != UNIFIED_MANIFEST_SCHEMA_VERSION {
        return Err(format!(
            "统一清单 schemaVersion 为 {}，期望 {}",
            manifest.schema_version, UNIFIED_MANIFEST_SCHEMA_VERSION
        ));
    }
    Ok(manifest)
}

async fn download_file(url: &str, dest: &Path) -> Result<(), String> {
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("无法创建下载目录：{}", e))?;
    }
    let response = APP_UPDATE_HTTP_CLIENT
        .get(url)
        .timeout(ARTIFACT_HTTP_TIMEOUT)
        .send()
        .await
        .map_err(|e| format!("下载失败：{}", e))?;
    if !response.status().is_success() {
        return Err(format!("下载失败：HTTP {}", response.status().as_u16()));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("下载失败：{}", e))?;
    fs::write(dest, bytes).map_err(|e| format!("保存安装包失败：{}", e))?;
    Ok(())
}

fn file_sha256_hex(path: &Path) -> Result<String, String> {
    let bytes = fs::read(path).map_err(|e| format!("读取文件失败：{}", e))?;
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    Ok(format!("{:x}", hasher.finalize()))
}

fn verify_file_sha256(path: &Path, expected: &str) -> Result<(), String> {
    let actual = file_sha256_hex(path)?;
    if !actual.eq_ignore_ascii_case(expected.trim()) {
        return Err(format!(
            "安装包 sha256 不匹配：期望 {}，实际 {}",
            expected.trim(),
            actual
        ));
    }
    Ok(())
}

/// Windows Authenticode check, best-effort: a signature claiming corruption
/// (`HashMismatch`/`Invalid`/`UnknownError`) aborts the install; unsigned
/// dev builds and `Valid` signatures pass. On non-Windows this is a no-op
/// (macOS Gatekeeper/notarization is enforced by the OS at first launch).
fn verify_authenticode_best_effort(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::process::Command;
        let escaped = path.to_string_lossy().replace('\'', "''");
        let script = format!(
            "$s = Get-AuthenticodeSignature -FilePath '{escaped}'; \
             if ($null -eq $s.Status) {{ exit 0 }}; \
             if ($s.Status -in @('HashMismatch','Invalid','UnknownError')) {{ exit 2 }}; \
             exit 0"
        );
        match Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .output()
        {
            Ok(out) if out.status.success() => Ok(()),
            Ok(out) => Err(format!(
                "安装包签名校验失败：{}",
                String::from_utf8_lossy(&out.stderr).trim()
            )),
            Err(e) => Err(format!("无法执行签名校验：{}", e)),
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = path;
        Ok(())
    }
}

/// Fetch `GET /api/version` from the (freshly respawned) managed dashboard and
/// compare it against the manifest version. Returns `false` (not an error) when
/// the dashboard responds but reports a different version — the caller rolls
/// back the runtime.
async fn verify_backend_version(api_base_url: &str, expected: &str) -> Result<bool, String> {
    // Embedded Hard FFI — zero HTTP (refactor_report.md §3.7): the version is
    // read straight from Python `get_version` through pyo3, never from a
    // `GET /api/version` HTTP call (there is no HTTP endpoint to fetch).
    if api_base_url == crate::embedded::EMBEDDED_API_BASE_URL {
        let actual = crate::embedded::get_backend_version_async()
            .await
            .map_err(|e| format!("后端版本读取失败：{}", e))?;
        return Ok(actual.trim().trim_start_matches('v') == expected.trim().trim_start_matches('v'));
    }
    let url = format!("{}/api/version", api_base_url.trim_end_matches('/'));
    let response = APP_UPDATE_HTTP_CLIENT
        .get(&url)
        .timeout(DEFAULT_HTTP_TIMEOUT)
        .send()
        .await
        .map_err(|e| format!("后端探活失败：{}", e))?;
    if !response.status().is_success() {
        return Err(format!("后端探活 HTTP {}", response.status().as_u16()));
    }
    let json: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("后端探活响应解析失败：{}", e))?;
    let actual = json
        .get("version")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "后端探活响应缺少 version 字段".to_string())?;
    Ok(actual.trim().trim_start_matches('v') == expected.trim().trim_start_matches('v'))
}

fn desktop_asset_extension(kind: &str) -> &'static str {
    match kind {
        "nsis" => ".exe",
        "dmg" => ".dmg",
        "zip" | "portable" => ".zip",
        "deb" => ".deb",
        "appimage" => ".AppImage",
        _ => ".bin",
    }
}

fn write_pending_marker(marker: &PendingAppUpdateMarker) -> Result<PathBuf, String> {
    let path = runtime::runtime_root().join(PENDING_APP_UPDATE_FILE);
    let body = serde_json::to_string_pretty(marker).map_err(|e| e.to_string())?;
    fs::write(&path, format!("{}\n", body)).map_err(|e| format!("写入更新标记失败：{}", e))?;
    Ok(path)
}

/// Write the embedded updater script to the runtime tree and launch it
/// detached (survives the app exit). Uses the bundled runtime `node` when
/// present, falling back to the system `node` for dev.
fn spawn_detached_updater(script_path: &Path, marker_path: &Path) -> Result<(), String> {
    let node = runtime::current_node_binary().unwrap_or_else(|| PathBuf::from("node"));
    let mut cmd = std::process::Command::new(&node);
    cmd.arg(script_path).arg(marker_path);
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        const DETACHED_PROCESS: u32 = 0x00000008;
        cmd.creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("无法启动更新器（node 不可用？）：{}", e))?;
    std::thread::sleep(Duration::from_millis(800));
    match child.try_wait() {
        Ok(Some(status)) => Err(format!("更新器过早退出：{}", status)),
        Ok(None) => {
            std::thread::spawn(move || {
                let _ = child.wait();
            });
            Ok(())
        }
        Err(e) => Err(format!("更新器状态检查失败：{}", e)),
    }
}

fn install_failure(error: String) -> AppUpdateInstallResult {
    AppUpdateInstallResult {
        ok: false,
        error: Some(error),
        ..Default::default()
    }
}

/// Clear the in-flight guard. Must run on every exit path of
/// [`app_update_install`] (except the final `app.exit(0)`, where the process
/// dies anyway).
fn clear_in_flight(state: &State<'_, AppState>) {
    if let Ok(mut inner) = state.inner.lock() {
        inner.app_update_in_flight = false;
    }
}

#[tauri::command]
pub async fn app_update_check(app: AppHandle) -> AppUpdateCheckResult {
    let config = crate::update_config::load().config;
    let manifest_url = config.release_manifest_url.trim().to_string();
    if manifest_url.is_empty() {
        return AppUpdateCheckResult {
            ok: false,
            error: Some("更新清单 URL 未配置".to_string()),
            ..Default::default()
        };
    }
    emit_progress(&app, "check-manifest", 1, "检查统一更新清单…");
    let manifest = match fetch_unified_manifest(&manifest_url).await {
        Ok(m) => m,
        Err(e) => {
            return AppUpdateCheckResult {
                ok: false,
                error: Some(e),
                ..Default::default()
            }
        }
    };
    let current_version = env!("CARGO_PKG_VERSION").to_string();
    let latest_version = manifest.normalized_version();
    let same_version = manifest.same_version();
    let update_available = match (&latest_version, same_version) {
        (Some(latest), true) => {
            compare_versions(latest, &current_version) == Some(Ordering::Greater)
        }
        _ => false,
    };
    AppUpdateCheckResult {
        ok: true,
        current_version: Some(current_version),
        latest_version,
        update_available,
        same_version,
        manifest: Some(manifest),
        error: None,
    }
}

#[tauri::command]
pub async fn app_update_install(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<AppUpdateInstallResult, AppError> {
    // Guard 1 — managed mode only (updating someone else's backend is unsafe).
    {
        let inner = match state.inner.lock() {
            Ok(inner) => inner,
            Err(_) => return Ok(install_failure("应用状态锁不可用".to_string())),
        };
        if let Err(e) = crate::connection::require_managed_mode(inner.connection_mode, "应用更新")
        {
            return Ok(install_failure(e.to_string()));
        }
    }
    // Guard 2 — no concurrent app updates.
    {
        let mut inner = match state.inner.lock() {
            Ok(inner) => inner,
            Err(_) => return Ok(install_failure("应用状态锁不可用".to_string())),
        };
        if inner.app_update_in_flight {
            return Ok(install_failure("已有应用更新正在进行，请稍候".to_string()));
        }
        inner.app_update_in_flight = true;
    }
    // Guard 3 — the dashboard-restart guard (profile switch / YOLO / runtime
    // update all serialize through this).
    match crate::commands::restart::try_begin_restart(&state) {
        Ok(true) => {}
        Ok(false) => {
            clear_in_flight(&state);
            return Ok(install_failure("已有内核重启操作正在进行".to_string()));
        }
        Err(e) => {
            clear_in_flight(&state);
            return Ok(install_failure(e.to_string()));
        }
    }

    let result = run_install(&app, &state).await;

    crate::commands::restart::end_restart(&state);
    clear_in_flight(&state);
    Ok(result)
}

async fn run_install(app: &AppHandle, state: &State<'_, AppState>) -> AppUpdateInstallResult {
    // --- Fetch + validate the unified manifest ---
    let config = crate::update_config::load().config;
    let manifest_url = config.release_manifest_url.trim().to_string();
    emit_progress(
        app,
        "check-manifest",
        2,
        format!("读取统一更新清单 {}", manifest_url),
    );
    let manifest = match fetch_unified_manifest(&manifest_url).await {
        Ok(m) => m,
        Err(e) => return install_failure(e),
    };
    let version = match manifest.normalized_version() {
        Some(v) => v,
        None => return install_failure("统一清单缺少版本号".to_string()),
    };
    if !manifest.same_version() {
        return install_failure(
            manifest
                .same_version_error()
                .unwrap_or_else(|| "前后端版本不一致".to_string()),
        );
    }
    let runtime_asset = manifest.runtime_update_manifest().cloned();
    let desktop_asset = manifest.current_desktop_asset().cloned();
    let (Some(runtime_manifest), Some(desktop_asset)) = (runtime_asset, desktop_asset) else {
        return install_failure("当前平台缺少 runtime 或桌面端安装包产物".to_string());
    };

    let mut result = AppUpdateInstallResult::default();

    // --- [1] Install the backend (track-A engine: download + sha256 +
    // ---     Ed25519 + extract + smoke + current.json record) ---
    emit_progress(app, "download-runtime", 8, "下载并安装后端内核…");
    let install = runtime::install_runtime_update(Some(runtime_manifest)).await;
    if !install.ok {
        return install_failure(
            install
                .error
                .unwrap_or_else(|| "后端内核安装失败".to_string()),
        );
    }
    result.backend_installed = true;

    // --- [2] Restart the managed dashboard and verify the backend version ---
    let (host, port) = crate::commands::restart::host_and_port();
    let (hermes_home, recovery_home) = {
        let inner = match state.inner.lock() {
            Ok(inner) => inner,
            Err(_) => {
                let _ = runtime::rollback_runtime();
                return install_failure("应用状态锁不可用".to_string());
            }
        };
        (inner.hermes_home.clone(), inner.hermes_home_base.clone())
    };

    emit_progress(app, "respawn-backend", 45, "重启后端内核…");
    let respawn = crate::commands::restart::respawn_managed_dashboard(
        state,
        &host,
        port,
        &hermes_home,
        &recovery_home,
    )
    .await;

    let api_base_url = match respawn {
        Ok(r) => r.api_base_url,
        Err(e) => {
            let _ = runtime::rollback_runtime();
            return install_failure(format!("后端重启失败：{}，已回滚内核", e));
        }
    };
    let Some(api_base_url) = api_base_url else {
        let _ = runtime::rollback_runtime();
        return install_failure("后端重启后未就绪，已回滚内核".to_string());
    };
    result.restarted = true;

    emit_progress(app, "verify-backend", 60, "校验后端版本…");
    match verify_backend_version(&api_base_url, &version).await {
        Ok(true) => result.backend_verified = true,
        Ok(false) => {
            let _ = runtime::rollback_runtime();
            let _ = crate::commands::restart::respawn_managed_dashboard(
                state,
                &host,
                port,
                &recovery_home,
                &recovery_home,
            )
            .await;
            return install_failure(format!("后端版本探活失败（期望 {}），已回滚内核", version));
        }
        Err(e) => {
            let _ = runtime::rollback_runtime();
            let _ = crate::commands::restart::respawn_managed_dashboard(
                state,
                &host,
                port,
                &recovery_home,
                &recovery_home,
            )
            .await;
            return install_failure(format!("{}，已回滚内核", e));
        }
    }

    // --- [3] Stage the desktop installer ---
    emit_progress(app, "download-desktop", 72, "下载桌面端安装包…");
    let ext = desktop_asset_extension(&desktop_asset.kind);
    let staging_path = runtime::downloads_root().join(format!("desktop-update-{version}{ext}"));
    if let Err(e) = download_file(&desktop_asset.url, &staging_path).await {
        return install_failure(e);
    }
    emit_progress(app, "verify-desktop", 85, "校验桌面端安装包…");
    if let Err(e) = verify_file_sha256(&staging_path, &desktop_asset.sha256) {
        return install_failure(e);
    }
    if let Err(e) = verify_authenticode_best_effort(&staging_path) {
        return install_failure(e);
    }
    result.frontend_staged = true;

    // --- [4] Marker + detached updater + exit ---
    emit_progress(app, "stage-frontend", 92, "准备应用重启…");
    let updater_dir = runtime::runtime_root().join(UPDATER_DIR);
    if let Err(e) = fs::create_dir_all(&updater_dir) {
        return install_failure(format!("无法创建更新器目录：{}", e));
    }
    let updater_script = updater_dir.join(UPDATER_SCRIPT_FILE);
    if let Err(e) = fs::write(&updater_script, APPLY_DESKTOP_UPDATE_SOURCE) {
        return install_failure(format!("写入更新器脚本失败：{}", e));
    }

    let marker = PendingAppUpdateMarker {
        schema_version: 1,
        pid: std::process::id(),
        installer_path: staging_path.to_string_lossy().to_string(),
        target_version: version.clone(),
        kind: desktop_asset.kind.clone(),
        exe_path: std::env::current_exe()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default(),
        timeout_ms: 120_000,
        created_at: now_rfc3339(),
    };
    let marker_path = match write_pending_marker(&marker) {
        Ok(p) => p,
        Err(e) => return install_failure(e),
    };

    match spawn_detached_updater(&updater_script, &marker_path) {
        Ok(()) => {
            result.frontend_installed = true;
            result.ok = true;
            emit_progress(app, "relaunch-app", 98, "正在退出并安装新版桌面端…");
            // Give the detached child a moment to be fully spawned (it will
            // outlive us), then exit so the installer can replace the exe.
            tokio::time::sleep(Duration::from_millis(1500)).await;
            app.exit(0);
            result
        }
        Err(e) => install_failure(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;
    use tempfile::TempDir;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn sample_manifest(version: &str) -> UnifiedReleaseManifest {
        serde_json::from_value(serde_json::json!({
            "schemaVersion": 1,
            "version": version,
            "minAppVersion": "0.7.0",
            "assets": {
                crate::unified_manifest::platform_asset_key(): {
                    "desktop": {
                        "kind": "nsis",
                        "fileName": "Hermes.Agent.CN.Desktop_setup.exe",
                        "url": "https://example.com/setup.exe",
                        "sha256": "abc",
                        "size": 1
                    },
                    "runtime": {
                        "kind": "runtime",
                        "fileName": "r.zip",
                        "url": "https://example.com/r.zip",
                        "sha256": "def",
                        "size": 2,
                        "kernelVersion": version,
                        "manifest": {
                            "schemaVersion": 2,
                            "channel": "stable",
                            "runtimeVersion": version,
                            "kernelVersion": version,
                            "runtimeFlavor": "cn",
                            "runtimeRevision": 0,
                            "platform": crate::process::runtime::current_platform(),
                            "arch": crate::process::runtime::current_arch(),
                            "artifactUrl": "https://example.com/r.zip",
                            "sha256": "def",
                            "signature": "ZmFrZXNpZw==",
                            "sourceRepo": "Eynzof/Hermes-CN-Core",
                            "sourceCommit": "deadbeef"
                        }
                    }
                }
            }
        }))
        .unwrap()
    }

    #[test]
    fn compare_versions_orders_numerically() {
        assert_eq!(compare_versions("0.8.0", "0.7.0"), Some(Ordering::Greater));
        assert_eq!(compare_versions("0.7.0", "0.8.0"), Some(Ordering::Less));
        assert_eq!(compare_versions("0.8.0", "0.8.0"), Some(Ordering::Equal));
        assert_eq!(compare_versions("v0.8.0", "0.8.0"), Some(Ordering::Equal));
        assert_eq!(compare_versions("0.10.0", "0.9.9"), Some(Ordering::Greater));
        assert_eq!(
            compare_versions("0.8.0-beta.1", "0.8.0"),
            Some(Ordering::Equal)
        );
        assert_eq!(compare_versions("abc", "0.8.0"), None);
    }

    #[test]
    fn desktop_asset_extension_maps_kinds() {
        assert_eq!(desktop_asset_extension("nsis"), ".exe");
        assert_eq!(desktop_asset_extension("dmg"), ".dmg");
        assert_eq!(desktop_asset_extension("zip"), ".zip");
        assert_eq!(desktop_asset_extension("unknown"), ".bin");
    }

    #[test]
    fn sha256_hex_matches_known_digest() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("f.bin");
        fs::write(&path, b"hello").unwrap();
        assert_eq!(
            file_sha256_hex(&path).unwrap(),
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
        );
    }

    #[test]
    fn verify_file_sha256_rejects_mismatch() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("f.bin");
        fs::write(&path, b"hello").unwrap();
        let err = verify_file_sha256(&path, "deadbeef").unwrap_err();
        assert!(err.contains("sha256 不匹配"), "{}", err);
    }

    #[test]
    fn marker_round_trip_json() {
        let marker = PendingAppUpdateMarker {
            schema_version: 1,
            pid: 4242,
            installer_path: r"C:\tmp\setup.exe".to_string(),
            target_version: "0.8.0".to_string(),
            kind: "nsis".to_string(),
            exe_path: r"C:\Program Files\Hermes Agent CN Desktop.exe".to_string(),
            timeout_ms: 120_000,
            created_at: "2026-01-01T00:00:00Z".to_string(),
        };
        let json = serde_json::to_string(&marker).unwrap();
        let parsed: PendingAppUpdateMarker = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.pid, 4242);
        assert_eq!(parsed.kind, "nsis");
        assert_eq!(parsed.target_version, "0.8.0");
    }

    #[tokio::test]
    async fn fetch_unified_manifest_parses_same_version() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/latest.json"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::to_value(sample_manifest("0.8.0")).unwrap()),
            )
            .mount(&server)
            .await;
        let manifest = fetch_unified_manifest(&format!("{}/latest.json", server.uri()))
            .await
            .unwrap();
        assert!(manifest.same_version());
        assert_eq!(manifest.normalized_version().as_deref(), Some("0.8.0"));
    }

    #[tokio::test]
    async fn fetch_unified_manifest_rejects_bad_schema() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/latest.json"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "schemaVersion": 99,
                "version": "0.8.0",
                "assets": {}
            })))
            .mount(&server)
            .await;
        let err = fetch_unified_manifest(&format!("{}/latest.json", server.uri()))
            .await
            .unwrap_err();
        assert!(err.contains("schemaVersion"), "{}", err);
    }

    #[tokio::test]
    async fn fetch_unified_manifest_reports_http_error() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/latest.json"))
            .respond_with(ResponseTemplate::new(404))
            .mount(&server)
            .await;
        let err = fetch_unified_manifest(&format!("{}/latest.json", server.uri()))
            .await
            .unwrap_err();
        assert!(err.contains("404"), "{}", err);
    }

    #[tokio::test]
    async fn verify_backend_version_matches() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/version"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "version": "0.8.0"
            })))
            .mount(&server)
            .await;
        assert_eq!(
            verify_backend_version(&server.uri(), "0.8.0")
                .await
                .unwrap(),
            true
        );
        assert_eq!(
            verify_backend_version(&server.uri(), "0.7.0")
                .await
                .unwrap(),
            false
        );
    }

    #[tokio::test]
    async fn verify_backend_version_reports_missing_field() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/version"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({})))
            .mount(&server)
            .await;
        let err = verify_backend_version(&server.uri(), "0.8.0")
            .await
            .unwrap_err();
        assert!(err.contains("version"), "{}", err);
    }

    #[test]
    fn verify_backend_version_embedded_mode_dispatches_through_ffi_without_reqwest() {
        // With EMBEDDED_API_BASE_URL the version check must go through the
        // embedded FFI (pyo3 `get_version`), never through reqwest GET
        // /api/version. In default builds the embedded runtime is not
        // initialized, so the error is the embedded-runtime message — the old
        // reqwest scheme failure must be gone (same flip as upload_file).
        let rt = tokio::runtime::Runtime::new().unwrap();
        let err = rt
            .block_on(verify_backend_version(
                crate::embedded::EMBEDDED_API_BASE_URL,
                "0.8.0",
            ))
            .expect_err("embedded version check must not fall back to reqwest");
        assert!(
            !err.contains("scheme") && !err.contains("builder") && !err.contains("http"),
            "embedded version check must dispatch through FFI, got: {err}"
        );
    }

    #[test]
    fn write_pending_marker_lands_in_runtime_root() {
        let dir = TempDir::new().unwrap();
        std::env::set_var("HERMES_DESKTOP_RUNTIME_ROOT", dir.path());
        let marker = PendingAppUpdateMarker {
            schema_version: 1,
            pid: 1,
            installer_path: "x.exe".to_string(),
            target_version: "0.8.0".to_string(),
            kind: "nsis".to_string(),
            exe_path: "y.exe".to_string(),
            timeout_ms: 100,
            created_at: "t".to_string(),
        };
        let path = write_pending_marker(&marker).unwrap();
        assert!(path.ends_with(PENDING_APP_UPDATE_FILE));
        assert!(path.is_file());
        let parsed: PendingAppUpdateMarker =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(parsed.target_version, "0.8.0");
        std::env::remove_var("HERMES_DESKTOP_RUNTIME_ROOT");
    }

    #[test]
    fn embedded_updater_script_is_valid_js_smoke() {
        // The embedded source must at least mention the marker arg and the
        // APP_UPDATE_DONE sentinel we rely on in logs.
        assert!(APPLY_DESKTOP_UPDATE_SOURCE.contains("markerPath"));
        assert!(APPLY_DESKTOP_UPDATE_SOURCE.contains("APP_UPDATE_DONE"));
        assert!(APPLY_DESKTOP_UPDATE_SOURCE.contains("HERMES_APP_UPDATED"));
    }
}
