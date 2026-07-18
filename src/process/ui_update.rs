// UI hot-update channel (Track B of the hot-update plan).
//
// Delivers signed zips of the Tauri webview frontend (`web/dist`) into a
// writable versions tree under `runtime_root()/ui/`, served to the window by
// the `hermesui` custom URI scheme registered in main.rs. The embedded
// `frontendDist` stays in the binary as the never-brick fallback: the window
// only loads from the writable tree when an installed override passes every
// gate (schema, platform, signed appVersionFloor, index.html present).
//
// The engine deliberately mirrors process/runtime.rs — same Ed25519 trust key,
// same sha256 + signature double check, same extract_zip guardrails, same
// `versions/<v>/ + current.json` pointer layout, same single-step rollback.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::process::runtime::{
    self, chrono_now, configured_public_key, current_arch, current_platform, desktop_app_version,
    emit_stage, extract_zip, file_sha256, is_version_downgrade, parse_runtime_semver,
    safe_version_segment, StageSink, RUNTIME_ARTIFACT_HTTP_TIMEOUT, RUNTIME_HTTP_CLIENT,
    RUNTIME_MANIFEST_HTTP_TIMEOUT,
};
use crate::update_stage::UpdateStage;

const UI_SUBDIR: &str = "ui";
const UI_CURRENT_FILE: &str = "current.json";
const UI_MANIFEST_FILE: &str = "manifest.json";
/// Install-record schema for `ui/current.json`.
const UI_RECORD_SCHEMA_VERSION: u32 = 1;
/// UI update-manifest schemas this client accepts.
const SUPPORTED_UI_MANIFEST_SCHEMA_VERSIONS: [u32; 1] = [1];
const DEFAULT_UI_CHANNEL: &str = "stable";

// Compile-time defaults, mirroring the runtime channel's cascade
// (HERMES_RUNTIME_UPDATE_*). Trust key is shared with the runtime channel.
const BAKED_UI_MANIFEST_BASE_URL: Option<&str> = option_env!("HERMES_UI_UPDATE_BASE_URL_DEFAULT");
const BAKED_UI_MANIFEST_CHANNEL: Option<&str> = option_env!("HERMES_UI_UPDATE_CHANNEL_DEFAULT");
const FALLBACK_UI_MANIFEST_BASE_URL: &str = "https://desktop.hermesagent.org.cn/ui";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiUpdateManifest {
    pub schema_version: u32,
    pub channel: String,
    pub ui_version: String,
    /// Minimum desktop shell version this UI bundle is compatible with.
    /// Signed (payload field #4) — the safety core of the whole channel: a UI
    /// that calls invoke commands the installed shell doesn't have is refused
    /// here and the window keeps serving the embedded bundle.
    pub app_version_floor: String,
    pub platform: String,
    pub arch: String,
    pub artifact_url: String,
    pub sha256: String,
    pub signature: String,
    pub source_repo: String,
    pub source_commit: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiInstallRecord {
    pub schema_version: u32,
    pub ui_version: String,
    pub app_version_floor: String,
    pub channel: String,
    pub platform: String,
    pub arch: String,
    pub path: String,
    pub sha256: String,
    pub source: String,
    pub installed_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub previous_ui_version: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiUpdateCheckResult {
    pub ok: bool,
    pub update_available: bool,
    #[serde(default)]
    pub downgrade_blocked: bool,
    /// The manifest's signed appVersionFloor is above this desktop build.
    #[serde(default)]
    pub floor_blocked: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub required_app_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_ui_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub manifest: Option<UiUpdateManifest>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl UiUpdateCheckResult {
    fn failure(error: String) -> Self {
        UiUpdateCheckResult {
            ok: false,
            update_available: false,
            downgrade_blocked: false,
            floor_blocked: false,
            required_app_version: None,
            current_ui_version: None,
            manifest: None,
            error: Some(error),
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiInstallUpdateResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub installed: Option<UiInstallRecord>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub previous: Option<UiInstallRecord>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl UiInstallUpdateResult {
    fn failure(error: String) -> Self {
        UiInstallUpdateResult {
            ok: false,
            installed: None,
            previous: None,
            error: Some(error),
        }
    }
}

// ---------------------------------------------------------------------------
// Disk layout
// ---------------------------------------------------------------------------

pub fn ui_root() -> PathBuf {
    runtime::runtime_root().join(UI_SUBDIR)
}

fn ui_versions_root() -> PathBuf {
    ui_root().join("versions")
}

fn ui_downloads_root() -> PathBuf {
    ui_root().join("downloads")
}

fn ui_current_record_path() -> PathBuf {
    ui_root().join(UI_CURRENT_FILE)
}

fn read_json_file<T: serde::de::DeserializeOwned>(path: &Path) -> Option<T> {
    let text = fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

fn write_json_file<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create {}: {}", parent.display(), e))?;
    }
    let json = serde_json::to_string_pretty(value)
        .map_err(|e| format!("Failed to serialize {}: {}", path.display(), e))?;
    fs::write(path, json + "\n").map_err(|e| format!("Failed to write {}: {}", path.display(), e))
}

pub fn read_ui_current_record() -> Option<UiInstallRecord> {
    let record: UiInstallRecord = read_json_file(&ui_current_record_path())?;
    if record.schema_version != UI_RECORD_SCHEMA_VERSION {
        return None;
    }
    if record.platform != current_platform() || record.arch != current_arch() {
        return None;
    }
    if !Path::new(&record.path).join("index.html").is_file() {
        return None;
    }
    Some(record)
}

/// True when `floor` allows this desktop build. Unparseable floors REFUSE the
/// bundle — unlike the kernel's minAppVersion (where a bad value only skips a
/// gate on an otherwise-verified artifact), a UI bundle whose floor cannot be
/// evaluated could call invoke commands this shell doesn't have.
fn floor_allows_current_app(floor: &str) -> bool {
    match (
        parse_runtime_semver(floor),
        parse_runtime_semver(desktop_app_version()),
    ) {
        (Some(floor), Some(app)) => floor <= app,
        _ => false,
    }
}

/// The directory the `hermesui` protocol should serve, or None to fall back
/// to the embedded bundle. Every gate is re-checked on read so a bad override
/// can never outlive its welcome: record schema/platform, signed floor vs the
/// CURRENT shell version (an app downgrade re-locks newer UI bundles), and
/// index.html presence.
pub fn active_ui_dir() -> Option<PathBuf> {
    let record = read_ui_current_record()?;
    if !floor_allows_current_app(&record.app_version_floor) {
        log::warn!(
            "installed UI {} requires desktop >= {} (current {}); serving embedded bundle",
            record.ui_version,
            record.app_version_floor,
            desktop_app_version()
        );
        return None;
    }
    Some(PathBuf::from(record.path))
}

// ---------------------------------------------------------------------------
// Request-path sanitizing for the hermesui protocol handler
// ---------------------------------------------------------------------------

/// Normalize a hermesui request path into a safe relative path. Returns None
/// for anything that could escape the served directory: absolute paths,
/// `..`/`.` segments, backslashes, NUL, or empty segments after decoding.
/// An empty path resolves to `index.html` (SPA entry).
pub fn sanitize_ui_request_path(raw_path: &str) -> Option<String> {
    let path = raw_path.split(['?', '#']).next().unwrap_or("");
    let decoded = urlencoding::decode(path).ok()?;
    let decoded = decoded.trim_start_matches('/');
    if decoded.is_empty() {
        return Some("index.html".to_string());
    }
    if decoded.contains('\0') || decoded.contains('\\') {
        return None;
    }
    let mut segments = Vec::new();
    for segment in decoded.split('/') {
        if segment.is_empty() || segment == "." || segment == ".." {
            return None;
        }
        segments.push(segment);
    }
    Some(segments.join("/"))
}

// ---------------------------------------------------------------------------
// Manifest URL + signature
// ---------------------------------------------------------------------------

fn configured_ui_manifest_url() -> Option<String> {
    if let Ok(explicit) = std::env::var("HERMES_UI_UPDATE_MANIFEST_URL") {
        let trimmed = explicit.trim().to_string();
        if !trimmed.is_empty() {
            return Some(trimmed);
        }
    }
    let base = std::env::var("HERMES_UI_UPDATE_BASE_URL")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| BAKED_UI_MANIFEST_BASE_URL.map(|s| s.to_string()))
        .unwrap_or_else(|| FALLBACK_UI_MANIFEST_BASE_URL.to_string());
    let base = base.trim().trim_end_matches('/').to_string();
    if base.is_empty() {
        return None;
    }
    let channel = std::env::var("HERMES_UI_UPDATE_CHANNEL")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| BAKED_UI_MANIFEST_CHANNEL.map(|s| s.to_string()))
        .unwrap_or_else(|| DEFAULT_UI_CHANNEL.to_string());
    Some(format!(
        "{}/{}-{}-{}.json",
        base,
        channel,
        current_platform(),
        current_arch()
    ))
}

// Signed payload, one field per line. Field ORDER is a cross-language
// contract with scripts/sign_ui_manifest.py — change both together, guarded
// by the order-lock tests below.
fn ui_signature_payload(manifest: &UiUpdateManifest) -> Vec<u8> {
    format!(
        "{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}",
        manifest.schema_version,
        manifest.channel,
        manifest.ui_version,
        manifest.app_version_floor,
        manifest.platform,
        manifest.arch,
        manifest.artifact_url,
        manifest.sha256,
        manifest.source_repo,
        manifest.source_commit,
    )
    .into_bytes()
}

fn validate_ui_manifest(manifest: &UiUpdateManifest) -> Result<String, String> {
    if !SUPPORTED_UI_MANIFEST_SCHEMA_VERSIONS.contains(&manifest.schema_version) {
        return Err(format!(
            "UI manifest schemaVersion is {}, expected one of {:?}",
            manifest.schema_version, SUPPORTED_UI_MANIFEST_SCHEMA_VERSIONS
        ));
    }
    if manifest.app_version_floor.trim().is_empty() {
        return Err("UI manifest requires a non-empty appVersionFloor".to_string());
    }
    if manifest.platform != current_platform() || manifest.arch != current_arch() {
        return Err(format!(
            "UI manifest is for {}-{}, not {}-{}",
            manifest.platform,
            manifest.arch,
            current_platform(),
            current_arch()
        ));
    }
    safe_version_segment(&manifest.ui_version)
}

fn verify_ui_signature(manifest: &UiUpdateManifest) -> Result<(), String> {
    use base64::Engine;
    use ed25519_dalek::pkcs8::DecodePublicKey;
    use ed25519_dalek::{Signature, VerifyingKey};

    let public_key_pem = configured_public_key().ok_or("UI update public key is not configured")?;
    let key = VerifyingKey::from_public_key_pem(public_key_pem.trim())
        .map_err(|e| format!("Invalid public key PEM: {}", e))?;
    let sig_bytes = base64::engine::general_purpose::STANDARD
        .decode(&manifest.signature)
        .map_err(|e| format!("Invalid signature base64: {}", e))?;
    let signature =
        Signature::from_slice(&sig_bytes).map_err(|e| format!("Invalid signature: {}", e))?;
    let payload = ui_signature_payload(manifest);
    key.verify_strict(&payload, &signature)
        .map_err(|_| "UI manifest signature verification failed".to_string())
}

// ---------------------------------------------------------------------------
// check / install / rollback
// ---------------------------------------------------------------------------

pub async fn check_ui_update() -> UiUpdateCheckResult {
    let url = match configured_ui_manifest_url() {
        Some(u) => u,
        None => {
            return UiUpdateCheckResult::failure(
                "UI update manifest URL is not configured".to_string(),
            )
        }
    };

    let manifest: UiUpdateManifest = match RUNTIME_HTTP_CLIENT
        .get(&url)
        .timeout(RUNTIME_MANIFEST_HTTP_TIMEOUT)
        .send()
        .await
    {
        Ok(res) if res.status().is_success() => match res.json().await {
            Ok(m) => m,
            Err(e) => {
                return UiUpdateCheckResult::failure(format!("Failed to parse UI manifest: {}", e))
            }
        },
        Ok(res) => return UiUpdateCheckResult::failure(format!("HTTP {}", res.status())),
        Err(e) => return UiUpdateCheckResult::failure(e.to_string()),
    };

    if let Err(e) = validate_ui_manifest(&manifest) {
        return UiUpdateCheckResult::failure(e);
    }

    let current = read_ui_current_record();
    let (update_available, downgrade_blocked) = match current.as_ref() {
        None => (true, false),
        Some(c) if c.ui_version == manifest.ui_version => (false, false),
        Some(c) if is_version_downgrade(&manifest.ui_version, &c.ui_version) => (false, true),
        Some(_) => (true, false),
    };
    let floor_blocked = !floor_allows_current_app(&manifest.app_version_floor);
    UiUpdateCheckResult {
        ok: true,
        update_available,
        downgrade_blocked,
        floor_blocked,
        required_app_version: floor_blocked.then(|| manifest.app_version_floor.clone()),
        current_ui_version: current.map(|c| c.ui_version),
        manifest: Some(manifest),
        error: None,
    }
}

/// UI-specific smoke check: index.html parses as UTF-8 and at least one asset
/// it references exists on disk. Catches truncated/mispacked bundles before
/// they are activated (the runtime channel's `dashboard --help` equivalent).
fn smoke_check_ui_dir(dir: &Path) -> Result<(), String> {
    let index_path = dir.join("index.html");
    let bytes =
        fs::read(&index_path).map_err(|e| format!("UI bundle has no readable index.html: {e}"))?;
    let html = String::from_utf8(bytes)
        .map_err(|_| "UI bundle index.html is not valid UTF-8".to_string())?;

    let mut referenced_any = false;
    for capture in html.split(['"', '\'']) {
        let reference = capture.trim_start_matches("./").trim_start_matches('/');
        if !(reference.starts_with("assets/") || reference.starts_with("static/")) {
            continue;
        }
        referenced_any = true;
        if let Some(safe) = sanitize_ui_request_path(reference) {
            if dir.join(safe).is_file() {
                return Ok(());
            }
        }
    }
    if referenced_any {
        return Err("UI bundle index.html references assets that are missing on disk".to_string());
    }
    // An index.html with no asset references at all is suspicious for a Vite
    // build, but not provably broken — allow it (inline-everything builds).
    Ok(())
}

pub async fn install_ui_update(
    manifest: Option<UiUpdateManifest>,
    stage_sink: Option<StageSink<'_>>,
) -> UiInstallUpdateResult {
    let resolved = match manifest {
        Some(m) => m,
        None => {
            let check = check_ui_update().await;
            match check.manifest {
                Some(m) => m,
                None => {
                    return UiInstallUpdateResult::failure(
                        check
                            .error
                            .unwrap_or_else(|| "No UI manifest available".into()),
                    )
                }
            }
        }
    };

    if let Err(e) = verify_ui_signature(&resolved) {
        return UiInstallUpdateResult::failure(e);
    }
    let version_segment = match validate_ui_manifest(&resolved) {
        Ok(segment) => segment,
        Err(e) => return UiInstallUpdateResult::failure(e),
    };

    // Signed floor gate: refuse bundles demanding a newer shell. check
    // surfaces this as a flag; install re-enforces for direct callers.
    if !floor_allows_current_app(&resolved.app_version_floor) {
        return UiInstallUpdateResult::failure(format!(
            "此界面更新要求桌面端版本 ≥ {}（当前 {}），请先升级桌面应用",
            resolved.app_version_floor,
            desktop_app_version()
        ));
    }
    if let Some(current) = read_ui_current_record() {
        if is_version_downgrade(&resolved.ui_version, &current.ui_version) {
            return UiInstallUpdateResult::failure(format!(
                "已拒绝降级安装：更新源提供的界面 {} 低于当前已安装的 {}",
                resolved.ui_version, current.ui_version
            ));
        }
    }

    match url::Url::parse(&resolved.artifact_url) {
        Ok(u) if u.scheme() == "https" => {}
        Ok(u) => {
            return UiInstallUpdateResult::failure(format!(
                "artifact_url must be https, got {}",
                u.scheme()
            ))
        }
        Err(e) => return UiInstallUpdateResult::failure(format!("Invalid artifact_url: {}", e)),
    }

    emit_stage(
        stage_sink,
        UpdateStage::Downloading {
            new_version: resolved.ui_version.clone(),
        },
    );
    let artifact = match RUNTIME_HTTP_CLIENT
        .get(&resolved.artifact_url)
        .timeout(RUNTIME_ARTIFACT_HTTP_TIMEOUT)
        .send()
        .await
    {
        Ok(res) if res.status().is_success() => match res.bytes().await {
            Ok(b) => b.to_vec(),
            Err(e) => return UiInstallUpdateResult::failure(format!("Download failed: {}", e)),
        },
        Ok(res) => {
            return UiInstallUpdateResult::failure(format!("Download HTTP {}", res.status()))
        }
        Err(e) => return UiInstallUpdateResult::failure(format!("Download failed: {}", e)),
    };

    let zip_path = ui_downloads_root().join(format!("{version_segment}.zip"));
    if let Some(parent) = zip_path.parent() {
        if let Err(e) = fs::create_dir_all(parent) {
            return UiInstallUpdateResult::failure(format!("Failed to create downloads dir: {e}"));
        }
    }
    if let Err(e) = fs::write(&zip_path, &artifact) {
        return UiInstallUpdateResult::failure(format!("Failed to write zip: {}", e));
    }

    install_ui_zip(resolved, &zip_path, "update", stage_sink).await
}

pub(crate) async fn install_ui_zip(
    resolved: UiUpdateManifest,
    zip_path: &Path,
    source: &str,
    stage_sink: Option<StageSink<'_>>,
) -> UiInstallUpdateResult {
    let version_segment = match validate_ui_manifest(&resolved) {
        Ok(segment) => segment,
        Err(e) => return UiInstallUpdateResult::failure(e),
    };

    emit_stage(
        stage_sink,
        UpdateStage::Verifying {
            new_version: resolved.ui_version.clone(),
        },
    );
    let digest = match file_sha256(zip_path) {
        Some(d) => d,
        None => {
            return UiInstallUpdateResult::failure(format!(
                "UI artifact not readable: {}",
                zip_path.display()
            ))
        }
    };
    if digest != resolved.sha256.to_lowercase() {
        return UiInstallUpdateResult::failure(format!(
            "SHA-256 mismatch: expected {}, got {}",
            resolved.sha256, digest
        ));
    }

    emit_stage(
        stage_sink,
        UpdateStage::Extracting {
            new_version: resolved.ui_version.clone(),
        },
    );
    let versions_root = ui_versions_root();
    if let Err(e) = fs::create_dir_all(&versions_root) {
        return UiInstallUpdateResult::failure(format!("Failed to create UI versions dir: {e}"));
    }
    let staging = match tempfile::Builder::new()
        .prefix(".staging-")
        .tempdir_in(&versions_root)
    {
        Ok(d) => d,
        Err(e) => {
            return UiInstallUpdateResult::failure(format!("Failed to create staging dir: {e}"))
        }
    };
    if let Err(e) = extract_zip(zip_path, staging.path()) {
        return UiInstallUpdateResult::failure(format!("Failed to extract: {}", e));
    }

    // Zips may wrap everything in a single top-level dir; serve its contents.
    let content_root =
        single_child_dir(staging.path()).unwrap_or_else(|| staging.path().to_path_buf());

    emit_stage(
        stage_sink,
        UpdateStage::SmokeChecking {
            new_version: resolved.ui_version.clone(),
        },
    );
    if let Err(e) = smoke_check_ui_dir(&content_root) {
        return UiInstallUpdateResult::failure(format!("UI smoke check failed: {}", e));
    }

    emit_stage(
        stage_sink,
        UpdateStage::Installing {
            new_version: resolved.ui_version.clone(),
        },
    );
    let target = versions_root.join(&version_segment);
    if target.exists() {
        if let Err(e) = fs::remove_dir_all(&target) {
            return UiInstallUpdateResult::failure(format!(
                "Failed to clear existing UI version dir: {e}"
            ));
        }
    }
    if let Err(e) = fs::rename(&content_root, &target) {
        if let Err(e2) = runtime::copy_dir_all(&content_root, &target) {
            return UiInstallUpdateResult::failure(format!(
                "Failed to install UI bundle: rename={}, copy={}",
                e, e2
            ));
        }
    }
    if !target.join("index.html").is_file() {
        return UiInstallUpdateResult::failure("index.html disappeared after install".to_string());
    }

    let previous = read_ui_current_record();
    let installed = UiInstallRecord {
        schema_version: UI_RECORD_SCHEMA_VERSION,
        ui_version: resolved.ui_version.clone(),
        app_version_floor: resolved.app_version_floor.clone(),
        channel: resolved.channel.clone(),
        platform: current_platform().to_string(),
        arch: current_arch().to_string(),
        path: target.to_string_lossy().to_string(),
        sha256: resolved.sha256.clone(),
        source: source.to_string(),
        installed_at: chrono_now(),
        previous_ui_version: previous.as_ref().map(|p| p.ui_version.clone()),
    };

    let _ = write_json_file(&target.join(UI_MANIFEST_FILE), &resolved);
    // current.json is written LAST: a crash anywhere above leaves the active
    // pointer untouched and the window keeps serving the previous bundle.
    if let Err(e) = write_json_file(&ui_current_record_path(), &installed) {
        return UiInstallUpdateResult::failure(e);
    }

    UiInstallUpdateResult {
        ok: true,
        installed: Some(installed),
        previous,
        error: None,
    }
}

fn single_child_dir(dir: &Path) -> Option<PathBuf> {
    let mut entries = fs::read_dir(dir).ok()?.filter_map(|e| e.ok());
    let first = entries.next()?;
    if entries.next().is_some() {
        return None;
    }
    let path = first.path();
    path.is_dir().then_some(path)
}

/// Repoint `ui/current.json` at the previous UI version. Pure disk operation
/// (no network); the previous tree is integrity-gated on index.html presence.
pub fn rollback_ui_update() -> UiInstallUpdateResult {
    let current = match read_ui_current_record() {
        Some(c) => c,
        None => return UiInstallUpdateResult::failure("No current UI record".to_string()),
    };
    let prev_version = match &current.previous_ui_version {
        Some(v) => v.clone(),
        None => {
            return UiInstallUpdateResult::failure("No previous UI version recorded".to_string())
        }
    };
    let prev_segment = match safe_version_segment(&prev_version) {
        Ok(s) => s,
        Err(e) => {
            return UiInstallUpdateResult::failure(format!("Invalid previous UI version: {e}"))
        }
    };
    let prev_path = ui_versions_root().join(prev_segment);
    if !prev_path.join("index.html").is_file() {
        return UiInstallUpdateResult::failure(format!(
            "Previous UI bundle is missing or incomplete: {}",
            prev_path.display()
        ));
    }
    let prev_manifest: Option<UiUpdateManifest> = read_json_file(&prev_path.join(UI_MANIFEST_FILE));

    let installed = UiInstallRecord {
        schema_version: UI_RECORD_SCHEMA_VERSION,
        ui_version: prev_version.clone(),
        app_version_floor: prev_manifest
            .as_ref()
            .map(|m| m.app_version_floor.clone())
            .unwrap_or_else(|| current.app_version_floor.clone()),
        channel: current.channel.clone(),
        platform: current_platform().to_string(),
        arch: current_arch().to_string(),
        path: prev_path.to_string_lossy().to_string(),
        sha256: prev_manifest
            .as_ref()
            .map(|m| m.sha256.clone())
            .unwrap_or_default(),
        source: "rollback".to_string(),
        installed_at: chrono_now(),
        previous_ui_version: Some(current.ui_version.clone()),
    };
    if let Err(e) = write_json_file(&ui_current_record_path(), &installed) {
        return UiInstallUpdateResult::failure(e);
    }
    UiInstallUpdateResult {
        ok: true,
        installed: Some(installed),
        previous: Some(current),
        error: None,
    }
}

/// Remove the installed override entirely, returning the window to the
/// embedded bundle on next load. Used as the escape hatch when both installed
/// versions misbehave.
pub fn reset_ui_to_embedded() -> Result<(), String> {
    let path = ui_current_record_path();
    if path.exists() {
        fs::remove_file(&path)
            .map_err(|e| format!("Failed to remove {}: {}", path.display(), e))?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// hermesui protocol serving
// ---------------------------------------------------------------------------

pub struct UiResponse {
    pub status: u16,
    pub mime: &'static str,
    pub cache_control: &'static str,
    pub body: Vec<u8>,
}

fn mime_for_path(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("") {
        "html" => "text/html",
        "js" | "mjs" => "text/javascript",
        "css" => "text/css",
        "json" | "map" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "wasm" => "application/wasm",
        "txt" => "text/plain",
        _ => "application/octet-stream",
    }
}

fn cache_control_for(path: &str) -> &'static str {
    // index.html must revalidate every load or the webview would keep serving
    // a stale entry after a version switch; Vite assets are content-hashed
    // and safely immutable.
    if path == "index.html" {
        "no-cache"
    } else {
        "public, max-age=31536000, immutable"
    }
}

fn ui_response(path: &str, body: Vec<u8>) -> UiResponse {
    UiResponse {
        status: 200,
        mime: mime_for_path(path),
        cache_control: cache_control_for(path),
        body,
    }
}

/// Read `safe_path` from the override dir with canonical-containment
/// enforcement — a symlink pointing outside the bundle serves nothing.
fn read_override_file(dir: &Path, safe_path: &str) -> Option<Vec<u8>> {
    let candidate = dir.join(safe_path);
    let canonical_dir = dir.canonicalize().ok()?;
    let canonical = candidate.canonicalize().ok()?;
    if !canonical.starts_with(&canonical_dir) {
        log::warn!(
            "hermesui request escaped the UI bundle via symlink: {}",
            candidate.display()
        );
        return None;
    }
    fs::read(&canonical).ok()
}

fn embedded_asset(app: &tauri::AppHandle, safe_path: &str) -> Option<Vec<u8>> {
    app.asset_resolver()
        .get(format!("/{safe_path}"))
        .map(|asset| asset.bytes().to_vec())
}

/// Resolve a hermesui request. Precedence per file: gated override dir →
/// embedded bundle → SPA index fallback (either source) → 404. The embedded
/// bundle is always reachable, so a broken override degrades per-file instead
/// of white-screening the window.
pub fn serve_ui_request(app: &tauri::AppHandle, uri_path: &str) -> UiResponse {
    let Some(safe_path) = sanitize_ui_request_path(uri_path) else {
        return UiResponse {
            status: 404,
            mime: "text/plain",
            cache_control: "no-cache",
            body: b"not found".to_vec(),
        };
    };

    let override_dir = active_ui_dir();
    if let Some(dir) = override_dir.as_deref() {
        if let Some(body) = read_override_file(dir, &safe_path) {
            return ui_response(&safe_path, body);
        }
    }
    if let Some(body) = embedded_asset(app, &safe_path) {
        return ui_response(&safe_path, body);
    }

    // SPA route fallback: extension-less paths (e.g. /settings on reload)
    // resolve to the entry point of whichever source is active.
    let last_segment = safe_path.rsplit('/').next().unwrap_or("");
    if !last_segment.contains('.') {
        if let Some(dir) = override_dir.as_deref() {
            if let Some(body) = read_override_file(dir, "index.html") {
                return ui_response("index.html", body);
            }
        }
        if let Some(body) = embedded_asset(app, "index.html") {
            return ui_response("index.html", body);
        }
    }

    UiResponse {
        status: 404,
        mime: "text/plain",
        cache_control: "no-cache",
        body: b"not found".to_vec(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;
    use ed25519_dalek::{Signer, SigningKey};
    use pretty_assertions::assert_eq;
    use serial_test::serial;
    use tempfile::TempDir;

    fn test_keypair() -> (SigningKey, String) {
        use ed25519_dalek::pkcs8::EncodePublicKey;
        let signing_key = SigningKey::from_bytes(&[11u8; 32]);
        let pem = signing_key
            .verifying_key()
            .to_public_key_pem(ed25519_dalek::pkcs8::spki::der::pem::LineEnding::LF)
            .unwrap();
        (signing_key, pem)
    }

    fn fixture_manifest() -> UiUpdateManifest {
        UiUpdateManifest {
            schema_version: 1,
            channel: "stable".to_string(),
            ui_version: "0.7.1".to_string(),
            app_version_floor: "0.7.0".to_string(),
            platform: current_platform().to_string(),
            arch: current_arch().to_string(),
            artifact_url: "https://example.com/ui.zip".to_string(),
            sha256: "deadbeef".to_string(),
            signature: String::new(),
            source_repo: "owner/repo".to_string(),
            source_commit: "abc123".to_string(),
            created_at: None,
        }
    }

    fn sign(key: &SigningKey, m: &mut UiUpdateManifest) {
        let sig = key.sign(&ui_signature_payload(m));
        m.signature = base64::engine::general_purpose::STANDARD.encode(sig.to_bytes());
    }

    #[test]
    fn ui_signature_payload_field_order_is_locked() {
        // Cross-language contract with scripts/sign_ui_manifest.py.
        let mut m = fixture_manifest();
        m.platform = "linux".to_string();
        m.arch = "x64".to_string();
        let payload = String::from_utf8(ui_signature_payload(&m)).unwrap();
        assert_eq!(
            payload.split('\n').collect::<Vec<_>>(),
            vec![
                "1",                          // schema_version
                "stable",                     // channel
                "0.7.1",                      // ui_version
                "0.7.0",                      // app_version_floor
                "linux",                      // platform
                "x64",                        // arch
                "https://example.com/ui.zip", // artifact_url
                "deadbeef",                   // sha256
                "owner/repo",                 // source_repo
                "abc123",                     // source_commit
            ]
        );
    }

    #[test]
    #[serial]
    fn ui_signature_roundtrip_and_floor_tampering_detection() {
        let (key, pem) = test_keypair();
        std::env::set_var("HERMES_RUNTIME_UPDATE_PUBLIC_KEY_PEM", pem);
        let mut m = fixture_manifest();
        sign(&key, &mut m);
        verify_ui_signature(&m).expect("should verify");

        // appVersionFloor is signed — lowering it (to sneak an incompatible
        // bundle past an old shell) must break the signature.
        let mut tampered = m.clone();
        tampered.app_version_floor = "0.0.1".to_string();
        assert!(verify_ui_signature(&tampered).is_err());
        std::env::remove_var("HERMES_RUNTIME_UPDATE_PUBLIC_KEY_PEM");
    }

    #[test]
    fn floor_gate_blocks_newer_requirements_and_unparseable_floors() {
        assert!(floor_allows_current_app("0.0.1"));
        assert!(floor_allows_current_app(desktop_app_version()));
        assert!(!floor_allows_current_app("999.0.0"));
        // Unlike the kernel gate, an unevaluable floor REFUSES the bundle.
        assert!(!floor_allows_current_app("not-a-version"));
        assert!(!floor_allows_current_app(""));
    }

    #[test]
    fn validate_ui_manifest_gates_schema_floor_and_platform() {
        assert!(validate_ui_manifest(&fixture_manifest()).is_ok());

        let mut wrong_schema = fixture_manifest();
        wrong_schema.schema_version = 2;
        assert!(validate_ui_manifest(&wrong_schema).is_err());

        let mut empty_floor = fixture_manifest();
        empty_floor.app_version_floor = "  ".to_string();
        assert!(validate_ui_manifest(&empty_floor).is_err());

        let mut wrong_platform = fixture_manifest();
        wrong_platform.platform = "some-other-os".to_string();
        assert!(validate_ui_manifest(&wrong_platform).is_err());

        let mut bad_version = fixture_manifest();
        bad_version.ui_version = "../escape".to_string();
        assert!(validate_ui_manifest(&bad_version).is_err());
    }

    #[test]
    fn sanitize_rejects_traversal_and_normalizes_entry() {
        assert_eq!(sanitize_ui_request_path("").as_deref(), Some("index.html"));
        assert_eq!(sanitize_ui_request_path("/").as_deref(), Some("index.html"));
        assert_eq!(
            sanitize_ui_request_path("/assets/app.js").as_deref(),
            Some("assets/app.js")
        );
        assert_eq!(
            sanitize_ui_request_path("/assets/app.js?v=1#frag").as_deref(),
            Some("assets/app.js")
        );
        assert_eq!(sanitize_ui_request_path("/../secret"), None);
        assert_eq!(sanitize_ui_request_path("/a/../../b"), None);
        assert_eq!(sanitize_ui_request_path("/a//b"), None);
        assert_eq!(sanitize_ui_request_path("/./a"), None);
        assert_eq!(sanitize_ui_request_path("/a\\b"), None);
        // URL-encoded traversal must not survive decoding.
        assert_eq!(sanitize_ui_request_path("/%2e%2e/secret"), None);
        assert_eq!(sanitize_ui_request_path("/a%2f..%2fb"), None);
    }

    #[test]
    fn smoke_check_requires_utf8_index_with_existing_assets() {
        let tmp = TempDir::new().unwrap();
        // Missing index.html
        assert!(smoke_check_ui_dir(tmp.path()).is_err());

        // Non-UTF-8 index
        fs::write(tmp.path().join("index.html"), [0xff, 0xfe, 0x00]).unwrap();
        assert!(smoke_check_ui_dir(tmp.path()).is_err());

        // References an asset that is missing
        fs::write(
            tmp.path().join("index.html"),
            r#"<script src="/assets/app.js"></script>"#,
        )
        .unwrap();
        assert!(smoke_check_ui_dir(tmp.path()).is_err());

        // Asset exists → passes
        fs::create_dir_all(tmp.path().join("assets")).unwrap();
        fs::write(tmp.path().join("assets").join("app.js"), "console.log(1)").unwrap();
        assert!(smoke_check_ui_dir(tmp.path()).is_ok());
    }

    #[test]
    #[serial]
    fn active_ui_dir_enforces_floor_and_index_presence() {
        let tmp = TempDir::new().unwrap();
        std::env::set_var("HERMES_DESKTOP_RUNTIME_ROOT", tmp.path());

        let bundle = ui_versions_root().join("0.7.1");
        fs::create_dir_all(&bundle).unwrap();
        fs::write(bundle.join("index.html"), "<html></html>").unwrap();

        let mut record = UiInstallRecord {
            schema_version: UI_RECORD_SCHEMA_VERSION,
            ui_version: "0.7.1".to_string(),
            app_version_floor: "0.0.1".to_string(),
            channel: "stable".to_string(),
            platform: current_platform().to_string(),
            arch: current_arch().to_string(),
            path: bundle.to_string_lossy().to_string(),
            sha256: "deadbeef".to_string(),
            source: "update".to_string(),
            installed_at: "2026-07-18T00:00:00.000Z".to_string(),
            previous_ui_version: None,
        };
        write_json_file(&ui_current_record_path(), &record).unwrap();
        assert_eq!(active_ui_dir(), Some(bundle.clone()));

        // Floor above the current shell → override is ignored (embedded).
        record.app_version_floor = "999.0.0".to_string();
        write_json_file(&ui_current_record_path(), &record).unwrap();
        assert_eq!(active_ui_dir(), None);

        // index.html vanished → override is ignored.
        record.app_version_floor = "0.0.1".to_string();
        write_json_file(&ui_current_record_path(), &record).unwrap();
        fs::remove_file(bundle.join("index.html")).unwrap();
        assert_eq!(active_ui_dir(), None);

        std::env::remove_var("HERMES_DESKTOP_RUNTIME_ROOT");
    }

    #[test]
    #[serial]
    fn rollback_repoints_to_previous_bundle_and_back() {
        let tmp = TempDir::new().unwrap();
        std::env::set_var("HERMES_DESKTOP_RUNTIME_ROOT", tmp.path());

        for (version, floor) in [("0.7.1", "0.0.1"), ("0.7.2", "0.0.1")] {
            let dir = ui_versions_root().join(version);
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join("index.html"), "<html></html>").unwrap();
            let mut manifest = fixture_manifest();
            manifest.ui_version = version.to_string();
            manifest.app_version_floor = floor.to_string();
            write_json_file(&dir.join(UI_MANIFEST_FILE), &manifest).unwrap();
        }
        let current = UiInstallRecord {
            schema_version: UI_RECORD_SCHEMA_VERSION,
            ui_version: "0.7.2".to_string(),
            app_version_floor: "0.0.1".to_string(),
            channel: "stable".to_string(),
            platform: current_platform().to_string(),
            arch: current_arch().to_string(),
            path: ui_versions_root()
                .join("0.7.2")
                .to_string_lossy()
                .to_string(),
            sha256: "deadbeef".to_string(),
            source: "update".to_string(),
            installed_at: "2026-07-18T00:00:00.000Z".to_string(),
            previous_ui_version: Some("0.7.1".to_string()),
        };
        write_json_file(&ui_current_record_path(), &current).unwrap();

        let result = rollback_ui_update();
        assert!(result.ok, "unexpected error: {:?}", result.error);
        let restored = result.installed.unwrap();
        assert_eq!(restored.ui_version, "0.7.1");
        assert_eq!(restored.source, "rollback");
        // Single-step back-and-forth: the rollback records the rolled-away
        // version as its own previous.
        assert_eq!(restored.previous_ui_version.as_deref(), Some("0.7.2"));

        // Reset escape hatch removes the pointer entirely.
        reset_ui_to_embedded().unwrap();
        assert!(read_ui_current_record().is_none());

        std::env::remove_var("HERMES_DESKTOP_RUNTIME_ROOT");
    }
}
