// Managed runtime install/update/rollback logic.
//
// Replaces hermes-cn-ui-v1/apps/desktop/src/main/runtime-manager.ts.
// Handles finding bundled runtimes, checking for updates, downloading,
// verifying signatures, extracting, smoke-testing, and installing.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command as StdCommand;
use std::process::Stdio;
use std::sync::LazyLock;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::process::Command;

const RUNTIME_BASENAME: &str = "hermes-agent-cn-runtime";
const CURRENT_FILE: &str = "current.json";
const MANIFEST_FILE: &str = "manifest.json";
const DEFAULT_CHANNEL: &str = "stable";
const MANIFEST_SCHEMA_VERSION: u32 = 2;
const DASHBOARD_RESOURCE_DIR: &str = "dashboard";
const DASHBOARD_WEB_DIST_DIR: &str = "web_dist";
const BUNDLED_SKILLS_RESOURCE_DIR: &str = "bundled-skills";
const BUNDLED_SKILLS_DIR: &str = "skills";
const RUNTIME_HTTP_CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const RUNTIME_MANIFEST_HTTP_TIMEOUT: Duration = Duration::from_secs(30);
const RUNTIME_ARTIFACT_HTTP_TIMEOUT: Duration = Duration::from_secs(15 * 60);
// The release runtime is a PyInstaller-style onefile binary. On a cold macOS
// launch it has to unpack its embedded Python payload before argparse can even
// print `dashboard --help`; current arm64 artifacts routinely take ~18s on the
// first run. Keep the smoke check long enough for the cold path and let normal
// launches stay fast via the runtime's own cache.
const SMOKE_TIMEOUT: Duration = Duration::from_secs(60);
static RUNTIME_HTTP_CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .connect_timeout(RUNTIME_HTTP_CONNECT_TIMEOUT)
        .build()
        .expect("valid runtime update HTTP client")
});

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeInstallRecord {
    pub schema_version: u32,
    pub runtime_version: String,
    pub kernel_version: String,
    pub runtime_flavor: String,
    pub runtime_revision: u32,
    pub platform: String,
    pub arch: String,
    pub path: String,
    pub executable_path: String,
    pub source: String,
    pub installed_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_repo: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_commit: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub local_dirty_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artifact_sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub previous_runtime_version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyRuntimeInstallRecord {
    pub version: String,
    pub platform: String,
    pub arch: String,
    pub path: String,
    pub executable_path: String,
    pub source: String,
    pub installed_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upstream_repo: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upstream_commit: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub local_dirty_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artifact_sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub previous_version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeUpdateManifest {
    pub schema_version: u32,
    pub channel: String,
    pub runtime_version: String,
    pub kernel_version: String,
    pub runtime_flavor: String,
    pub runtime_revision: u32,
    pub platform: String,
    pub arch: String,
    pub artifact_url: String,
    pub sha256: String,
    pub signature: String,
    pub source_repo: String,
    pub source_commit: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_app_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeInfo {
    pub mode: String,
    pub packaged: bool,
    pub platform: String,
    pub arch: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current: Option<RuntimeInstallRecord>,
    pub runtime_root: String,
    pub current_record_path: String,
    pub versions_dir: String,
    pub downloads_dir: String,
    pub gateway_runtime_dir: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub update_manifest_url: Option<String>,
    pub updates_configured: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub executable_sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<RuntimeSourceInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub process: Option<RuntimeProcessInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSourceInfo {
    pub repo: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub head_commit: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub head_short_commit: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dirty: Option<bool>,
    pub recent_commits: Vec<RuntimeSourceCommit>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSourceCommit {
    pub hash: String,
    pub short_hash: String,
    pub author: String,
    pub date: String,
    pub subject: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeProcessInfo {
    pub api_base_url: String,
    pub gateway_url: String,
    pub hermes_home: String,
    pub hermes_home_base: String,
    pub current_profile: String,
    pub owns_process: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command_program: Option<String>,
    pub command_args: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command_line: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gateway_runtime_dir: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gateway_lock_dir: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ownership_marker_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ownership_state: Option<String>,
    pub session_token_present: bool,
    pub gateway_sse_proxy_active: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeUpdateCheckResult {
    pub ok: bool,
    pub update_available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_runtime_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub manifest: Option<RuntimeUpdateManifest>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeInstallUpdateResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub installed: Option<RuntimeInstallRecord>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub previous: Option<RuntimeInstallRecord>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

fn current_platform() -> &'static str {
    if cfg!(target_os = "windows") {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    }
}

fn current_arch() -> &'static str {
    if cfg!(target_arch = "x86_64") {
        "x64"
    } else if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        std::env::consts::ARCH
    }
}

fn executable_extension() -> &'static str {
    if cfg!(target_os = "windows") {
        ".exe"
    } else {
        ""
    }
}

fn runtime_binary_names() -> Vec<String> {
    let ext = executable_extension();
    vec![
        format!(
            "{}-{}-{}{}",
            RUNTIME_BASENAME,
            current_platform(),
            current_arch(),
            ext
        ),
        format!("{}{}", RUNTIME_BASENAME, ext),
    ]
}

/// Get the runtime root directory.
///
/// This is the single containment root for the desktop-managed Hermes
/// environment: installed agent runtime versions, downloads, gateway runtime
/// files, and the isolated HERMES_HOME all live under this directory.
/// `HERMES_DESKTOP_RUNTIME_ROOT` may move the whole tree, but individual
/// subdirectories are intentionally not independently overridable.
pub fn runtime_root() -> PathBuf {
    if let Ok(override_path) = std::env::var("HERMES_DESKTOP_RUNTIME_ROOT") {
        let trimmed = override_path.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }

    let data_dir = dirs::data_dir().unwrap_or_else(|| PathBuf::from("."));
    data_dir.join("cn.org.hermesagent.desktop").join("runtime")
}

pub fn hermes_home_dir() -> PathBuf {
    runtime_root().join("hermes-home")
}

fn versions_root() -> PathBuf {
    runtime_root().join("versions")
}

fn downloads_root() -> PathBuf {
    runtime_root().join("downloads")
}

pub fn gateway_runtime_dir() -> PathBuf {
    runtime_root().join("gateway-runtime")
}

fn current_record_path() -> PathBuf {
    runtime_root().join(CURRENT_FILE)
}

pub fn current_record_path_display() -> String {
    current_record_path().to_string_lossy().to_string()
}

fn versions_dir_display() -> String {
    versions_root().to_string_lossy().to_string()
}

fn downloads_dir_display() -> String {
    downloads_root().to_string_lossy().to_string()
}

fn read_json_file<T: serde::de::DeserializeOwned>(path: &Path) -> Option<T> {
    let content = fs::read_to_string(path).ok()?;
    serde_json::from_str(&content).ok()
}

fn write_json_file<T: Serialize>(path: &Path, data: &T) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(data).map_err(|e| e.to_string())?;
    fs::write(path, format!("{}\n", json)).map_err(|e| e.to_string())
}

fn find_executable_in(dir: &Path, max_depth: u32) -> Option<PathBuf> {
    let names = runtime_binary_names();

    // Direct file check
    if dir.is_file() {
        if let Some(name) = dir.file_name().and_then(|n| n.to_str()) {
            if names.contains(&name.to_string()) {
                return Some(dir.to_path_buf());
            }
        }
        return None;
    }

    if !dir.is_dir() {
        return None;
    }

    // Check direct children and bin/ subdirectory
    for name in &names {
        let direct = dir.join(name);
        if direct.is_file() {
            return Some(direct);
        }
        let bin = dir.join("bin").join(name);
        if bin.is_file() {
            return Some(bin);
        }
    }

    if max_depth == 0 {
        return None;
    }

    // Recurse into subdirectories
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            if entry.path().is_dir() {
                if let Some(found) = find_executable_in(&entry.path(), max_depth - 1) {
                    return Some(found);
                }
            }
        }
    }

    None
}

fn infer_kernel_version_from_runtime_version(runtime_version: &str) -> String {
    if let Some(rest) = runtime_version.strip_prefix("dev-local-") {
        if let Some((kernel, _)) = rest.split_once('-') {
            if !kernel.is_empty() {
                return kernel.to_string();
            }
        }
    }
    if let Some((kernel, _)) = runtime_version.split_once("-cn") {
        if !kernel.is_empty() {
            return kernel.to_string();
        }
    }
    runtime_version.to_string()
}

fn infer_kernel_version_from_local_manifest(runtime_dir: &Path, runtime_version: &str) -> String {
    let manifest: Option<serde_json::Value> = read_json_file(&runtime_dir.join(MANIFEST_FILE));
    manifest
        .as_ref()
        .and_then(|value| {
            value
                .get("kernelVersion")
                .or_else(|| value.get("projectVersion"))
                .and_then(|v| v.as_str())
        })
        .map(ToString::to_string)
        .unwrap_or_else(|| infer_kernel_version_from_runtime_version(runtime_version))
}

fn read_legacy_current_record(path: &Path) -> Option<RuntimeInstallRecord> {
    let legacy: LegacyRuntimeInstallRecord = read_json_file(path)?;
    let runtime_dir = PathBuf::from(&legacy.path);
    let kernel_version = infer_kernel_version_from_local_manifest(&runtime_dir, &legacy.version);
    Some(RuntimeInstallRecord {
        schema_version: MANIFEST_SCHEMA_VERSION,
        runtime_version: legacy.version,
        kernel_version,
        runtime_flavor: if legacy.source == "local-source" {
            "cn-local".to_string()
        } else {
            "cn".to_string()
        },
        runtime_revision: 0,
        platform: legacy.platform,
        arch: legacy.arch,
        path: legacy.path,
        executable_path: legacy.executable_path,
        source: legacy.source,
        installed_at: legacy.installed_at,
        source_repo: legacy.upstream_repo,
        source_commit: legacy.upstream_commit,
        local_dirty_hash: legacy.local_dirty_hash,
        artifact_sha256: legacy.artifact_sha256,
        previous_runtime_version: legacy.previous_version,
    })
}

pub fn read_current_record() -> Option<RuntimeInstallRecord> {
    let path = current_record_path();
    let (record, migrated) = if let Some(record) = read_json_file::<RuntimeInstallRecord>(&path) {
        (record, false)
    } else {
        (read_legacy_current_record(&path)?, true)
    };
    if record.schema_version != MANIFEST_SCHEMA_VERSION {
        return None;
    }
    if record.platform != current_platform() || record.arch != current_arch() {
        return None;
    }
    if !Path::new(&record.executable_path).is_file() {
        return None;
    }
    if migrated {
        let _ = write_json_file(&path, &record);
    }
    Some(record)
}

// Compile-time defaults — populated by setting the matching env vars in
// the build environment. Cascade (highest first):
//   1. Runtime env (HERMES_RUNTIME_UPDATE_*)
//   2. Compile-time env override (HERMES_RUNTIME_UPDATE_*_DEFAULT)
//   3. Hardcoded fallback below — points at the Eynzof/hermes-agent-cn
//      production release pipeline + its Ed25519 public key.
// Forks rebuilding the desktop should set the compile-time env override
// to point at their own release pipeline + key (or edit the constants
// below).
const BAKED_MANIFEST_BASE_URL: Option<&str> = option_env!("HERMES_RUNTIME_UPDATE_BASE_URL_DEFAULT");
const BAKED_MANIFEST_CHANNEL: Option<&str> = option_env!("HERMES_RUNTIME_UPDATE_CHANNEL_DEFAULT");
const BAKED_PUBLIC_KEY_PEM: Option<&str> =
    option_env!("HERMES_RUNTIME_UPDATE_PUBLIC_KEY_PEM_DEFAULT");

const FALLBACK_MANIFEST_BASE_URL: &str =
    "https://github.com/Eynzof/hermes-agent-cn/releases/latest/download";
const FALLBACK_PUBLIC_KEY_PEM: &str = concat!(
    "-----BEGIN PUBLIC KEY-----\n",
    "MCowBQYDK2VwAyEAqPkLQ4o67G2GMTgkQQQZXWwDBZM/4hqq5thSZSNhoC0=\n",
    "-----END PUBLIC KEY-----\n"
);

fn configured_manifest_url() -> Option<String> {
    // 1. Fully-formed URL via runtime env (highest precedence)
    if let Ok(explicit) = std::env::var("HERMES_RUNTIME_UPDATE_MANIFEST_URL") {
        let trimmed = explicit.trim().to_string();
        if !trimmed.is_empty() {
            return Some(trimmed);
        }
    }

    // 2. Construct from base URL — runtime env wins, then compile-time
    //    default, then the hardcoded production fallback.
    let base = std::env::var("HERMES_RUNTIME_UPDATE_BASE_URL")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| BAKED_MANIFEST_BASE_URL.map(|s| s.to_string()))
        .unwrap_or_else(|| FALLBACK_MANIFEST_BASE_URL.to_string());
    let base = base.trim();
    if base.is_empty() {
        return None;
    }
    let channel = std::env::var("HERMES_RUNTIME_UPDATE_CHANNEL")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| BAKED_MANIFEST_CHANNEL.map(|s| s.to_string()))
        .unwrap_or_else(|| DEFAULT_CHANNEL.to_string());
    // URL pattern: ${base}/${channel}-${platform}-${arch}.json
    // Flat (no path segments after base) so GitHub Releases hosting works
    // out of the box — Releases assets share a single directory per tag.
    // Static site hosting (Pages / Cloudflare) can still serve this by
    // arranging filenames the same way.
    let base = if base.ends_with('/') {
        base.trim_end_matches('/').to_string()
    } else {
        base.to_string()
    };
    Some(format!(
        "{}/{}-{}-{}.json",
        base,
        channel,
        current_platform(),
        current_arch()
    ))
}

fn configured_public_key() -> Option<String> {
    // 1. PEM via runtime env (highest precedence)
    if let Ok(direct) = std::env::var("HERMES_RUNTIME_UPDATE_PUBLIC_KEY_PEM") {
        let pem = direct.trim().replace("\\n", "\n");
        if !pem.is_empty() {
            return Some(pem);
        }
    }
    // 2. PEM from a file path via runtime env
    if let Ok(file) = std::env::var("HERMES_RUNTIME_UPDATE_PUBLIC_KEY_FILE") {
        if Path::new(&file).is_file() {
            return fs::read_to_string(&file).ok();
        }
    }
    // 3. Compile-time embedded PEM (baked into release builds via CI)
    if let Some(baked) = BAKED_PUBLIC_KEY_PEM {
        let pem = baked.trim().replace("\\n", "\n");
        if !pem.is_empty() {
            return Some(pem);
        }
    }
    // 4. Hardcoded fallback — the Eynzof/hermes-agent-cn production key.
    Some(FALLBACK_PUBLIC_KEY_PEM.to_string())
}

/// Get current runtime information.
pub fn get_runtime_info(last_error: Option<String>) -> RuntimeInfo {
    let current = read_current_record();
    let external_allowed = crate::process::dashboard::external_agent_allowed();
    let mode = if current.is_some() {
        "managed"
    } else if external_allowed && std::env::var("HERMES_DESKTOP_AGENT_COMMAND").is_ok() {
        "external-command"
    } else if external_allowed {
        "external-path"
    } else {
        "managed-pending"
    };

    let manifest_url = configured_manifest_url();
    let executable_sha256 = current
        .as_ref()
        .and_then(|record| file_sha256(Path::new(&record.executable_path)));
    let source = current.as_ref().and_then(runtime_source_info);
    RuntimeInfo {
        mode: mode.to_string(),
        packaged: false, // Tauri's `is_packaged` equivalent checked at runtime
        platform: current_platform().to_string(),
        arch: current_arch().to_string(),
        current,
        runtime_root: runtime_root().to_string_lossy().to_string(),
        current_record_path: current_record_path_display(),
        versions_dir: versions_dir_display(),
        downloads_dir: downloads_dir_display(),
        gateway_runtime_dir: gateway_runtime_dir().to_string_lossy().to_string(),
        update_manifest_url: manifest_url.clone(),
        updates_configured: manifest_url.is_some() && configured_public_key().is_some(),
        executable_sha256,
        source,
        process: None,
        last_error,
    }
}

fn file_sha256(path: &Path) -> Option<String> {
    let mut file = fs::File::open(path).ok()?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf).ok()?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Some(format!("{:x}", hasher.finalize()))
}

fn bundled_runtime_dir(resource_dir: Option<&Path>) -> Option<PathBuf> {
    if let Ok(override_path) = std::env::var("HERMES_DESKTOP_BUNDLED_RUNTIME_DIR") {
        let trimmed = override_path.trim();
        if !trimmed.is_empty() {
            return Some(PathBuf::from(trimmed));
        }
    }

    resource_dir.map(|dir| dir.join("bundled-runtime"))
}

fn bundled_dashboard_web_dist_dir(resource_dir: Option<&Path>) -> Option<PathBuf> {
    if let Ok(override_path) = std::env::var("HERMES_DESKTOP_DASHBOARD_WEB_DIST_DIR") {
        let trimmed = override_path.trim();
        if !trimmed.is_empty() {
            return Some(PathBuf::from(trimmed));
        }
    }

    resource_dir.map(|dir| {
        dir.join(DASHBOARD_RESOURCE_DIR)
            .join(DASHBOARD_WEB_DIST_DIR)
    })
}

fn bundled_skills_dir(resource_dir: Option<&Path>) -> Option<PathBuf> {
    if let Ok(override_path) = std::env::var("HERMES_DESKTOP_BUNDLED_SKILLS_DIR") {
        let trimmed = override_path.trim();
        if !trimmed.is_empty() {
            return Some(PathBuf::from(trimmed));
        }
    }

    resource_dir.map(|dir| dir.join(BUNDLED_SKILLS_RESOURCE_DIR))
}

fn runtime_dashboard_web_dist_dir(runtime_dir: &Path) -> PathBuf {
    runtime_dir
        .join("_internal")
        .join("hermes_cli")
        .join(DASHBOARD_WEB_DIST_DIR)
}

fn runtime_bundled_skills_dir(runtime_dir: &Path) -> PathBuf {
    runtime_dir.join("_internal").join(BUNDLED_SKILLS_DIR)
}

pub fn current_dashboard_web_dist_dir() -> Option<PathBuf> {
    let current = read_current_record()?;
    let dist = runtime_dashboard_web_dist_dir(Path::new(&current.path));
    if dist.join("index.html").is_file() {
        Some(dist)
    } else {
        None
    }
}

#[derive(Debug, Clone, Default)]
pub struct RuntimeResourceSyncResult {
    pub dashboard_web_dist: Option<PathBuf>,
    pub bundled_skills: Option<PathBuf>,
}

pub fn sync_runtime_resources_if_available(
    resource_dir: Option<&Path>,
) -> Result<RuntimeResourceSyncResult, String> {
    let Some(current) = read_current_record() else {
        return Ok(RuntimeResourceSyncResult::default());
    };

    sync_available_runtime_resources_from_resource(resource_dir, Path::new(&current.path))
}

pub fn current_bundled_skills_dir() -> Option<PathBuf> {
    let current = read_current_record()?;
    let dir = runtime_bundled_skills_dir(Path::new(&current.path));
    if contains_skill_markdown(&dir) {
        Some(dir)
    } else {
        None
    }
}

fn sync_dashboard_web_dist_from_resource(
    resource_dir: Option<&Path>,
    runtime_dir: &Path,
) -> Result<Option<PathBuf>, String> {
    let source = bundled_dashboard_web_dist_dir(resource_dir).ok_or_else(|| {
        "Bundled dashboard web_dist resource directory is unavailable".to_string()
    })?;
    if !source.join("index.html").is_file() {
        return Err(format!(
            "Bundled dashboard web_dist is missing index.html at {}",
            source.display()
        ));
    }

    let target = runtime_dashboard_web_dist_dir(runtime_dir);
    if target.exists() {
        fs::remove_dir_all(&target).map_err(|e| e.to_string())?;
    }
    copy_dir_all(&source, &target)?;
    Ok(Some(target))
}

fn sync_bundled_skills_from_resource(
    resource_dir: Option<&Path>,
    runtime_dir: &Path,
) -> Result<Option<PathBuf>, String> {
    let source = bundled_skills_dir(resource_dir)
        .ok_or_else(|| "Bundled skills resource directory is unavailable".to_string())?;
    if !contains_skill_markdown(&source) {
        return Err(format!(
            "Bundled skills resource is missing SKILL.md files at {}",
            source.display()
        ));
    }

    let target = runtime_bundled_skills_dir(runtime_dir);
    if target.exists() {
        fs::remove_dir_all(&target).map_err(|e| e.to_string())?;
    }
    copy_dir_all(&source, &target)?;
    Ok(Some(target))
}

fn sync_runtime_resources_from_resource(
    resource_dir: Option<&Path>,
    runtime_dir: &Path,
) -> Result<(), String> {
    sync_dashboard_web_dist_from_resource(resource_dir, runtime_dir)?;
    sync_bundled_skills_from_resource(resource_dir, runtime_dir)?;
    Ok(())
}

fn sync_available_runtime_resources_from_resource(
    resource_dir: Option<&Path>,
    runtime_dir: &Path,
) -> Result<RuntimeResourceSyncResult, String> {
    let mut result = RuntimeResourceSyncResult::default();

    if let Some(source) = bundled_dashboard_web_dist_dir(resource_dir) {
        if source.join("index.html").is_file() {
            result.dashboard_web_dist =
                sync_dashboard_web_dist_from_resource(resource_dir, runtime_dir)?;
        }
    }

    if let Some(source) = bundled_skills_dir(resource_dir) {
        if contains_skill_markdown(&source) {
            result.bundled_skills = sync_bundled_skills_from_resource(resource_dir, runtime_dir)?;
        }
    }

    Ok(result)
}

fn bundled_manifest_path(runtime_dir: &Path) -> PathBuf {
    runtime_dir.join(format!(
        "{}-{}-{}.json",
        DEFAULT_CHANNEL,
        current_platform(),
        current_arch()
    ))
}

fn bundled_artifact_path(runtime_dir: &Path) -> PathBuf {
    runtime_dir.join(format!(
        "{}-{}-{}.zip",
        RUNTIME_BASENAME,
        current_platform(),
        current_arch()
    ))
}

fn bundled_expanded_runtime_dir(runtime_dir: &Path) -> PathBuf {
    runtime_dir.join(format!(
        "{}-{}-{}",
        RUNTIME_BASENAME,
        current_platform(),
        current_arch()
    ))
}

pub fn bundled_runtime_available(resource_dir: Option<&Path>) -> bool {
    let Some(runtime_dir) = bundled_runtime_dir(resource_dir) else {
        return false;
    };
    bundled_manifest_path(&runtime_dir).is_file()
        && (bundled_artifact_path(&runtime_dir).is_file()
            || bundled_expanded_runtime_dir(&runtime_dir).is_dir())
}

fn validate_manifest_for_current_platform(manifest: &RuntimeUpdateManifest) -> Result<(), String> {
    if manifest.schema_version != MANIFEST_SCHEMA_VERSION {
        return Err(format!(
            "Manifest schemaVersion is {}, expected {}",
            manifest.schema_version, MANIFEST_SCHEMA_VERSION
        ));
    }
    if manifest.platform != current_platform() || manifest.arch != current_arch() {
        return Err(format!(
            "Manifest is for {}-{}, not {}-{}",
            manifest.platform,
            manifest.arch,
            current_platform(),
            current_arch()
        ));
    }
    Ok(())
}

fn runtime_source_info(record: &RuntimeInstallRecord) -> Option<RuntimeSourceInfo> {
    let repo = record.source_repo.as_ref()?;
    let repo_path = Path::new(repo);
    if !repo_path.exists() {
        return Some(RuntimeSourceInfo {
            repo: repo.clone(),
            head_commit: None,
            head_short_commit: None,
            dirty: None,
            recent_commits: vec![],
        });
    }

    let head_commit = git_capture(repo_path, &["rev-parse", "HEAD"]);
    let head_short_commit = git_capture(repo_path, &["rev-parse", "--short=12", "HEAD"]);
    let dirty =
        git_capture(repo_path, &["status", "--porcelain=v1"]).map(|out| !out.trim().is_empty());
    let recent_commits = git_recent_commits(repo_path);

    Some(RuntimeSourceInfo {
        repo: repo.clone(),
        head_commit,
        head_short_commit,
        dirty,
        recent_commits,
    })
}

fn git_capture(repo: &Path, args: &[&str]) -> Option<String> {
    let output = StdCommand::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8(output.stdout).ok()?;
    Some(text.trim().to_string()).filter(|s| !s.is_empty())
}

fn git_recent_commits(repo: &Path) -> Vec<RuntimeSourceCommit> {
    let Some(out) = git_capture(
        repo,
        &[
            "log",
            "-n",
            "5",
            "--pretty=format:%H%x1f%h%x1f%an%x1f%ad%x1f%s",
            "--date=iso-strict",
        ],
    ) else {
        return vec![];
    };

    out.lines()
        .filter_map(|line| {
            let parts: Vec<&str> = line.split('\x1f').collect();
            if parts.len() != 5 {
                return None;
            }
            Some(RuntimeSourceCommit {
                hash: parts[0].to_string(),
                short_hash: parts[1].to_string(),
                author: parts[2].to_string(),
                date: parts[3].to_string(),
                subject: parts[4].to_string(),
            })
        })
        .collect()
}

/// Check for a runtime update by fetching the remote manifest.
pub async fn check_runtime_update() -> RuntimeUpdateCheckResult {
    let url = match configured_manifest_url() {
        Some(u) => u,
        None => {
            return RuntimeUpdateCheckResult {
                ok: false,
                update_available: false,
                current_runtime_version: None,
                manifest: None,
                error: Some("Runtime update manifest URL is not configured".to_string()),
            };
        }
    };

    match RUNTIME_HTTP_CLIENT
        .get(&url)
        .timeout(RUNTIME_MANIFEST_HTTP_TIMEOUT)
        .send()
        .await
    {
        Ok(res) if res.status().is_success() => match res.json::<RuntimeUpdateManifest>().await {
            Ok(manifest) => {
                if manifest.schema_version != MANIFEST_SCHEMA_VERSION {
                    return RuntimeUpdateCheckResult {
                        ok: false,
                        update_available: false,
                        current_runtime_version: None,
                        manifest: None,
                        error: Some(format!(
                            "Manifest schemaVersion is {}, expected {}",
                            manifest.schema_version, MANIFEST_SCHEMA_VERSION
                        )),
                    };
                }
                if manifest.platform != current_platform() || manifest.arch != current_arch() {
                    return RuntimeUpdateCheckResult {
                        ok: false,
                        update_available: false,
                        current_runtime_version: None,
                        manifest: None,
                        error: Some(format!(
                            "Manifest is for {}-{}, not {}-{}",
                            manifest.platform,
                            manifest.arch,
                            current_platform(),
                            current_arch()
                        )),
                    };
                }
                let current = read_current_record();
                let update_available = current
                    .as_ref()
                    .map(|c| c.runtime_version != manifest.runtime_version)
                    .unwrap_or(true);
                RuntimeUpdateCheckResult {
                    ok: true,
                    update_available,
                    current_runtime_version: current.map(|c| c.runtime_version),
                    manifest: Some(manifest),
                    error: None,
                }
            }
            Err(e) => RuntimeUpdateCheckResult {
                ok: false,
                update_available: false,
                current_runtime_version: None,
                manifest: None,
                error: Some(format!("Failed to parse manifest: {}", e)),
            },
        },
        Ok(res) => RuntimeUpdateCheckResult {
            ok: false,
            update_available: false,
            current_runtime_version: None,
            manifest: None,
            error: Some(format!("HTTP {}", res.status())),
        },
        Err(e) => RuntimeUpdateCheckResult {
            ok: false,
            update_available: false,
            current_runtime_version: None,
            manifest: None,
            error: Some(e.to_string()),
        },
    }
}

#[cfg(test)]
fn sha256_hex(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    format!("{:x}", hasher.finalize())
}

fn signature_payload(manifest: &RuntimeUpdateManifest) -> Vec<u8> {
    format!(
        "{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}",
        manifest.schema_version,
        manifest.channel,
        manifest.runtime_version,
        manifest.kernel_version,
        manifest.runtime_flavor,
        manifest.runtime_revision,
        manifest.platform,
        manifest.arch,
        manifest.artifact_url,
        manifest.sha256,
        manifest.source_repo,
        manifest.source_commit,
    )
    .into_bytes()
}

fn verify_signature(manifest: &RuntimeUpdateManifest) -> Result<(), String> {
    let public_key_pem =
        configured_public_key().ok_or("Runtime update public key is not configured")?;
    verify_signature_with_key(manifest, &public_key_pem)
}

fn verify_signature_with_key(
    manifest: &RuntimeUpdateManifest,
    public_key_pem: &str,
) -> Result<(), String> {
    use base64::Engine;
    use ed25519_dalek::{Signature, VerifyingKey};

    // Parse PEM to extract the 32-byte public key
    let pem_body: String = public_key_pem
        .lines()
        .filter(|l| !l.starts_with("-----"))
        .collect();
    let der = base64::engine::general_purpose::STANDARD
        .decode(pem_body.trim())
        .map_err(|e| format!("Invalid public key PEM: {}", e))?;
    // Ed25519 SPKI DER: the last 32 bytes are the raw public key
    if der.len() < 32 {
        return Err("Public key DER too short".to_string());
    }
    let raw_key = &der[der.len() - 32..];
    let key_bytes: [u8; 32] = raw_key.try_into().map_err(|_| "Invalid key length")?;
    let key =
        VerifyingKey::from_bytes(&key_bytes).map_err(|e| format!("Invalid public key: {}", e))?;

    let sig_bytes = base64::engine::general_purpose::STANDARD
        .decode(&manifest.signature)
        .map_err(|e| format!("Invalid signature base64: {}", e))?;

    let signature =
        Signature::from_slice(&sig_bytes).map_err(|e| format!("Invalid signature: {}", e))?;

    let payload = signature_payload(manifest);
    key.verify_strict(&payload, &signature)
        .map_err(|_| "Signature verification failed".to_string())
}

fn safe_version_segment(version: &str) -> String {
    let cleaned: String = version
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == '.' || *c == '_' || *c == '+' || *c == '-')
        .take(120)
        .collect();
    if cleaned.is_empty() {
        format!(
            "{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis()
        )
    } else {
        cleaned
    }
}

async fn wait_for_smoke_child(
    mut child: tokio::process::Child,
    timeout: Duration,
) -> Result<(), String> {
    match tokio::time::timeout(timeout, child.wait()).await {
        Ok(Ok(status)) if status.success() => Ok(()),
        Ok(Ok(status)) => Err(format!("Smoke check exited with code {:?}", status.code())),
        Ok(Err(e)) => Err(format!("Smoke check wait failed: {}", e)),
        Err(_) => {
            let _ = child.kill().await;
            Err(format!(
                "Smoke check timed out after {}s",
                timeout.as_secs()
            ))
        }
    }
}

async fn smoke_check_runtime(executable_path: &Path) -> Result<(), String> {
    let child = Command::new(executable_path)
        .args(["dashboard", "--help"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("Smoke check spawn failed: {}", e))?;

    wait_for_smoke_child(child, SMOKE_TIMEOUT).await
}

fn install_record_from_manifest(
    resolved: &RuntimeUpdateManifest,
    target: &Path,
    target_executable: &Path,
    source: &str,
    previous: Option<&RuntimeInstallRecord>,
) -> RuntimeInstallRecord {
    RuntimeInstallRecord {
        schema_version: MANIFEST_SCHEMA_VERSION,
        runtime_version: resolved.runtime_version.clone(),
        kernel_version: resolved.kernel_version.clone(),
        runtime_flavor: resolved.runtime_flavor.clone(),
        runtime_revision: resolved.runtime_revision,
        platform: current_platform().to_string(),
        arch: current_arch().to_string(),
        path: target.to_string_lossy().to_string(),
        executable_path: target_executable.to_string_lossy().to_string(),
        source: source.to_string(),
        installed_at: chrono_now(),
        source_repo: Some(resolved.source_repo.clone()),
        source_commit: Some(resolved.source_commit.clone()),
        local_dirty_hash: None,
        artifact_sha256: Some(resolved.sha256.clone()),
        previous_runtime_version: previous.map(|p| p.runtime_version.clone()),
    }
}

async fn install_runtime_zip(
    resolved: RuntimeUpdateManifest,
    zip_path: &Path,
    source: &str,
) -> RuntimeInstallUpdateResult {
    if let Err(e) = validate_manifest_for_current_platform(&resolved) {
        return RuntimeInstallUpdateResult {
            ok: false,
            installed: None,
            previous: None,
            error: Some(e),
        };
    }

    let digest = match file_sha256(zip_path) {
        Some(digest) => digest,
        None => {
            return RuntimeInstallUpdateResult {
                ok: false,
                installed: None,
                previous: None,
                error: Some(format!(
                    "Runtime artifact not readable: {}",
                    zip_path.display()
                )),
            };
        }
    };
    if digest != resolved.sha256.to_lowercase() {
        return RuntimeInstallUpdateResult {
            ok: false,
            installed: None,
            previous: None,
            error: Some(format!(
                "SHA-256 mismatch: expected {}, got {}",
                resolved.sha256, digest
            )),
        };
    }

    // Extract to staging directory.
    let staging = match tempfile::tempdir() {
        Ok(d) => d,
        Err(e) => {
            return RuntimeInstallUpdateResult {
                ok: false,
                installed: None,
                previous: None,
                error: Some(format!("Failed to create temp dir: {}", e)),
            };
        }
    };

    let _ = fs::create_dir_all(downloads_root());
    let _ = fs::create_dir_all(versions_root());
    let cached_zip_path = downloads_root().join(format!("{}.zip", resolved.runtime_version));
    if zip_path != cached_zip_path {
        if let Err(e) = fs::copy(zip_path, &cached_zip_path) {
            return RuntimeInstallUpdateResult {
                ok: false,
                installed: None,
                previous: None,
                error: Some(format!("Failed to cache zip: {}", e)),
            };
        }
    }

    if let Err(e) = extract_zip(&cached_zip_path, staging.path()) {
        return RuntimeInstallUpdateResult {
            ok: false,
            installed: None,
            previous: None,
            error: Some(format!("Failed to extract: {}", e)),
        };
    }

    let executable = match find_executable_in(staging.path(), 2) {
        Some(e) => e,
        None => {
            return RuntimeInstallUpdateResult {
                ok: false,
                installed: None,
                previous: None,
                error: Some("No runtime executable found in artifact".to_string()),
            };
        }
    };

    if let Err(e) = smoke_check_runtime(&executable).await {
        return RuntimeInstallUpdateResult {
            ok: false,
            installed: None,
            previous: None,
            error: Some(format!("Smoke check failed: {}", e)),
        };
    }

    let target = versions_root().join(safe_version_segment(&resolved.runtime_version));
    let _ = fs::remove_dir_all(&target);
    if let Err(e) = fs::rename(staging.path(), &target) {
        if let Err(e2) = copy_dir_all(staging.path(), &target) {
            return RuntimeInstallUpdateResult {
                ok: false,
                installed: None,
                previous: None,
                error: Some(format!("Failed to install: rename={}, copy={}", e, e2)),
            };
        }
    }

    let target_executable = match find_executable_in(&target, 2) {
        Some(e) => e,
        None => {
            return RuntimeInstallUpdateResult {
                ok: false,
                installed: None,
                previous: None,
                error: Some("Executable disappeared after install".to_string()),
            };
        }
    };

    let previous = read_current_record();
    let installed = install_record_from_manifest(
        &resolved,
        &target,
        &target_executable,
        source,
        previous.as_ref(),
    );

    let _ = write_json_file(&target.join(MANIFEST_FILE), &resolved);
    let _ = write_json_file(&current_record_path(), &installed);

    RuntimeInstallUpdateResult {
        ok: true,
        installed: Some(installed),
        previous,
        error: None,
    }
}

async fn install_runtime_tree(
    resolved: RuntimeUpdateManifest,
    runtime_tree_path: &Path,
    source: &str,
) -> RuntimeInstallUpdateResult {
    if let Err(e) = validate_manifest_for_current_platform(&resolved) {
        return RuntimeInstallUpdateResult {
            ok: false,
            installed: None,
            previous: None,
            error: Some(e),
        };
    }

    if !runtime_tree_path.is_dir() {
        return RuntimeInstallUpdateResult {
            ok: false,
            installed: None,
            previous: None,
            error: Some(format!(
                "Runtime tree is not a directory: {}",
                runtime_tree_path.display()
            )),
        };
    }

    let staging = match tempfile::tempdir() {
        Ok(d) => d,
        Err(e) => {
            return RuntimeInstallUpdateResult {
                ok: false,
                installed: None,
                previous: None,
                error: Some(format!("Failed to create temp dir: {}", e)),
            };
        }
    };

    let runtime_tree_name = runtime_tree_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(RUNTIME_BASENAME);
    let staged_runtime_tree = staging.path().join(runtime_tree_name);
    if let Err(e) = copy_dir_all(runtime_tree_path, &staged_runtime_tree) {
        return RuntimeInstallUpdateResult {
            ok: false,
            installed: None,
            previous: None,
            error: Some(format!("Failed to stage runtime tree: {}", e)),
        };
    }

    let executable = match find_executable_in(staging.path(), 2) {
        Some(e) => e,
        None => {
            return RuntimeInstallUpdateResult {
                ok: false,
                installed: None,
                previous: None,
                error: Some("No runtime executable found in bundled runtime tree".to_string()),
            };
        }
    };

    if let Err(e) = smoke_check_runtime(&executable).await {
        return RuntimeInstallUpdateResult {
            ok: false,
            installed: None,
            previous: None,
            error: Some(format!("Smoke check failed: {}", e)),
        };
    }

    let _ = fs::create_dir_all(versions_root());
    let target = versions_root().join(safe_version_segment(&resolved.runtime_version));
    let _ = fs::remove_dir_all(&target);
    if let Err(e) = fs::rename(staging.path(), &target) {
        if let Err(e2) = copy_dir_all(staging.path(), &target) {
            return RuntimeInstallUpdateResult {
                ok: false,
                installed: None,
                previous: None,
                error: Some(format!("Failed to install: rename={}, copy={}", e, e2)),
            };
        }
    }

    let target_executable = match find_executable_in(&target, 2) {
        Some(e) => e,
        None => {
            return RuntimeInstallUpdateResult {
                ok: false,
                installed: None,
                previous: None,
                error: Some("Executable disappeared after install".to_string()),
            };
        }
    };

    let previous = read_current_record();
    let installed = install_record_from_manifest(
        &resolved,
        &target,
        &target_executable,
        source,
        previous.as_ref(),
    );

    let _ = write_json_file(&target.join(MANIFEST_FILE), &resolved);
    let _ = write_json_file(&current_record_path(), &installed);

    RuntimeInstallUpdateResult {
        ok: true,
        installed: Some(installed),
        previous,
        error: None,
    }
}

/// Install the runtime bundled inside the desktop installer, if present.
///
/// This is used for packaged builds that should work without a first-run
/// network download. Windows and macOS both stage the upstream zip directly.
/// On macOS the upstream runtime release is already Developer-ID signed and
/// zipped with framework symlinks preserved; keeping the zip opaque avoids
/// Tauri's resource copy dereferencing `Python.framework` symlinks before
/// notarization.
pub async fn install_bundled_runtime_if_needed(
    resource_dir: Option<&Path>,
) -> RuntimeInstallUpdateResult {
    let Some(runtime_dir) = bundled_runtime_dir(resource_dir) else {
        return RuntimeInstallUpdateResult {
            ok: true,
            installed: None,
            previous: None,
            error: None,
        };
    };
    let manifest_path = bundled_manifest_path(&runtime_dir);
    if !manifest_path.is_file() {
        return RuntimeInstallUpdateResult {
            ok: true,
            installed: None,
            previous: None,
            error: None,
        };
    }
    let artifact_path = bundled_artifact_path(&runtime_dir);
    let expanded_runtime_dir = bundled_expanded_runtime_dir(&runtime_dir);
    let has_zip_artifact = artifact_path.is_file();
    let has_expanded_runtime = expanded_runtime_dir.is_dir();
    if !has_zip_artifact && !has_expanded_runtime {
        return RuntimeInstallUpdateResult {
            ok: false,
            installed: None,
            previous: None,
            error: Some(format!(
                "Bundled runtime manifest exists but runtime payload is missing: {} or {}",
                artifact_path.display(),
                expanded_runtime_dir.display()
            )),
        };
    }

    let manifest: RuntimeUpdateManifest = match read_json_file(&manifest_path) {
        Some(manifest) => manifest,
        None => {
            return RuntimeInstallUpdateResult {
                ok: false,
                installed: None,
                previous: None,
                error: Some(format!(
                    "Failed to parse bundled runtime manifest: {}",
                    manifest_path.display()
                )),
            };
        }
    };

    if let Err(e) = validate_manifest_for_current_platform(&manifest) {
        return RuntimeInstallUpdateResult {
            ok: false,
            installed: None,
            previous: None,
            error: Some(e),
        };
    }

    if let Some(current) = read_current_record() {
        if current.runtime_version == manifest.runtime_version {
            if let Err(e) =
                sync_runtime_resources_from_resource(resource_dir, Path::new(&current.path))
            {
                return RuntimeInstallUpdateResult {
                    ok: false,
                    installed: None,
                    previous: Some(current),
                    error: Some(format!("Bundled runtime resource sync failed: {}", e)),
                };
            }
            return RuntimeInstallUpdateResult {
                ok: true,
                installed: None,
                previous: Some(current),
                error: None,
            };
        }
    }

    if let Err(e) = verify_signature(&manifest) {
        return RuntimeInstallUpdateResult {
            ok: false,
            installed: None,
            previous: None,
            error: Some(format!("Bundled runtime signature check failed: {}", e)),
        };
    }

    let mut result = if has_expanded_runtime {
        install_runtime_tree(manifest, &expanded_runtime_dir, "bundled").await
    } else {
        install_runtime_zip(manifest, &artifact_path, "bundled").await
    };
    if result.ok {
        if let Some(installed) = &result.installed {
            if let Err(e) =
                sync_runtime_resources_from_resource(resource_dir, Path::new(&installed.path))
            {
                result.ok = false;
                result.error = Some(format!("Bundled runtime resource sync failed: {}", e));
            }
        }
    }
    result
}

/// Download, verify, and install a runtime update.
pub async fn install_runtime_update(
    manifest: Option<RuntimeUpdateManifest>,
) -> RuntimeInstallUpdateResult {
    let resolved = match manifest {
        Some(m) => m,
        None => {
            let check = check_runtime_update().await;
            match check.manifest {
                Some(m) => m,
                None => {
                    return RuntimeInstallUpdateResult {
                        ok: false,
                        installed: None,
                        previous: None,
                        error: Some(
                            check
                                .error
                                .unwrap_or_else(|| "No manifest available".into()),
                        ),
                    };
                }
            }
        }
    };

    // Verify signature
    if let Err(e) = verify_signature(&resolved) {
        return RuntimeInstallUpdateResult {
            ok: false,
            installed: None,
            previous: None,
            error: Some(e),
        };
    }

    // Validate URL scheme before downloading
    match url::Url::parse(&resolved.artifact_url) {
        Ok(u) if u.scheme() == "https" => {}
        Ok(u) => {
            return RuntimeInstallUpdateResult {
                ok: false,
                installed: None,
                previous: None,
                error: Some(format!("artifact_url must be https, got {}", u.scheme())),
            };
        }
        Err(e) => {
            return RuntimeInstallUpdateResult {
                ok: false,
                installed: None,
                previous: None,
                error: Some(format!("Invalid artifact_url: {}", e)),
            };
        }
    }

    let artifact = match RUNTIME_HTTP_CLIENT
        .get(&resolved.artifact_url)
        .timeout(RUNTIME_ARTIFACT_HTTP_TIMEOUT)
        .send()
        .await
    {
        Ok(res) if res.status().is_success() => match res.bytes().await {
            Ok(b) => b.to_vec(),
            Err(e) => {
                return RuntimeInstallUpdateResult {
                    ok: false,
                    installed: None,
                    previous: None,
                    error: Some(format!("Download failed: {}", e)),
                };
            }
        },
        Ok(res) => {
            return RuntimeInstallUpdateResult {
                ok: false,
                installed: None,
                previous: None,
                error: Some(format!("Download HTTP {}", res.status())),
            };
        }
        Err(e) => {
            return RuntimeInstallUpdateResult {
                ok: false,
                installed: None,
                previous: None,
                error: Some(format!("Download failed: {}", e)),
            };
        }
    };

    // Write zip to downloads dir; the shared installer path verifies,
    // extracts, smoke-tests, and records it.
    let _ = fs::create_dir_all(downloads_root());
    let _ = fs::create_dir_all(versions_root());
    let zip_path = downloads_root().join(format!("{}.zip", resolved.runtime_version));
    if let Err(e) = fs::write(&zip_path, &artifact) {
        return RuntimeInstallUpdateResult {
            ok: false,
            installed: None,
            previous: None,
            error: Some(format!("Failed to write zip: {}", e)),
        };
    }

    install_runtime_zip(resolved, &zip_path, "update").await
}

/// Rollback to the previous runtime version.
pub fn rollback_runtime() -> RuntimeInstallUpdateResult {
    let current = match read_current_record() {
        Some(c) => c,
        None => {
            return RuntimeInstallUpdateResult {
                ok: false,
                installed: None,
                previous: None,
                error: Some("No current runtime record".to_string()),
            };
        }
    };

    let prev_runtime_version = match &current.previous_runtime_version {
        Some(v) => v.clone(),
        None => {
            return RuntimeInstallUpdateResult {
                ok: false,
                installed: None,
                previous: None,
                error: Some("No previous version recorded".to_string()),
            };
        }
    };

    let prev_path = versions_root().join(safe_version_segment(&prev_runtime_version));
    let executable = match find_executable_in(&prev_path, 2) {
        Some(e) => e,
        None => {
            return RuntimeInstallUpdateResult {
                ok: false,
                installed: None,
                previous: None,
                error: Some(format!(
                    "Previous executable not found: {}",
                    prev_path.display()
                )),
            };
        }
    };
    let prev_manifest: Option<RuntimeUpdateManifest> =
        read_json_file(&prev_path.join(MANIFEST_FILE));

    let installed = RuntimeInstallRecord {
        schema_version: MANIFEST_SCHEMA_VERSION,
        runtime_version: prev_runtime_version.clone(),
        kernel_version: prev_manifest
            .as_ref()
            .map(|m| m.kernel_version.clone())
            .unwrap_or_else(|| current.kernel_version.clone()),
        runtime_flavor: prev_manifest
            .as_ref()
            .map(|m| m.runtime_flavor.clone())
            .unwrap_or_else(|| current.runtime_flavor.clone()),
        runtime_revision: prev_manifest
            .as_ref()
            .map(|m| m.runtime_revision)
            .unwrap_or(current.runtime_revision),
        platform: current_platform().to_string(),
        arch: current_arch().to_string(),
        path: prev_path.to_string_lossy().to_string(),
        executable_path: executable.to_string_lossy().to_string(),
        source: "update".to_string(),
        installed_at: chrono_now(),
        source_repo: prev_manifest.as_ref().map(|m| m.source_repo.clone()),
        source_commit: prev_manifest.as_ref().map(|m| m.source_commit.clone()),
        local_dirty_hash: None,
        artifact_sha256: prev_manifest.as_ref().map(|m| m.sha256.clone()),
        previous_runtime_version: Some(current.runtime_version.clone()),
    };

    let _ = write_json_file(&current_record_path(), &installed);

    RuntimeInstallUpdateResult {
        ok: true,
        installed: Some(installed),
        previous: Some(current),
        error: None,
    }
}

const MAX_ZIP_FILES: usize = 5_000;
const MAX_ZIP_TOTAL_BYTES: u64 = 500 * 1024 * 1024; // 500 MB

fn extract_zip(zip_path: &Path, dest: &Path) -> Result<(), String> {
    let file = fs::File::open(zip_path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;

    if archive.len() > MAX_ZIP_FILES {
        return Err(format!(
            "Zip contains {} files (limit {})",
            archive.len(),
            MAX_ZIP_FILES
        ));
    }

    let dest = dest.canonicalize().unwrap_or_else(|_| dest.to_path_buf());
    let mut total_bytes: u64 = 0;

    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;

        // Prevent zip-slip: use enclosed_name() which rejects ".." and absolute paths
        let relative = match entry.enclosed_name() {
            Some(p) => p.to_path_buf(),
            None => {
                return Err(format!(
                    "Refusing path traversal in zip: {:?}",
                    entry.name()
                ))
            }
        };
        let out_path = dest.join(&relative);
        if !out_path.starts_with(&dest) {
            return Err(format!("Path escapes destination: {:?}", relative));
        }

        let mode = entry.unix_mode();
        #[cfg(unix)]
        let is_symlink = mode.map(|m| (m & 0o170000) == 0o120000).unwrap_or(false);
        #[cfg(not(unix))]
        let is_symlink = false;

        if entry.is_dir() {
            fs::create_dir_all(&out_path).map_err(|e| e.to_string())?;
        } else {
            total_bytes += entry.size();
            if total_bytes > MAX_ZIP_TOTAL_BYTES {
                return Err(format!(
                    "Zip exceeds size limit ({} MB)",
                    MAX_ZIP_TOTAL_BYTES / 1024 / 1024
                ));
            }

            if let Some(parent) = out_path.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }

            if is_symlink {
                #[cfg(unix)]
                {
                    use std::path::Component;

                    let mut target_bytes = Vec::new();
                    entry
                        .read_to_end(&mut target_bytes)
                        .map_err(|e| e.to_string())?;
                    let target = String::from_utf8(target_bytes)
                        .map_err(|e| format!("Invalid UTF-8 symlink target: {}", e))?;
                    let target_path = Path::new(&target);
                    if target_path.components().any(|component| {
                        matches!(
                            component,
                            Component::ParentDir | Component::RootDir | Component::Prefix(_)
                        )
                    }) {
                        return Err(format!("Refusing unsafe symlink target: {:?}", target));
                    }
                    std::os::unix::fs::symlink(target_path, &out_path)
                        .map_err(|e| e.to_string())?;
                }
                #[cfg(not(unix))]
                return Err("Zip symlink entries are only supported on Unix platforms".to_string());
            } else {
                let mut out_file = fs::File::create(&out_path).map_err(|e| e.to_string())?;
                std::io::copy(&mut entry, &mut out_file).map_err(|e| e.to_string())?;

                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    if let Some(mode) = mode {
                        fs::set_permissions(&out_path, fs::Permissions::from_mode(mode))
                            .map_err(|e| e.to_string())?;
                    }
                }
            }
        }
    }
    Ok(())
}

fn contains_skill_markdown(dir: &Path) -> bool {
    if !dir.is_dir() {
        return false;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return false;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if contains_skill_markdown(&path) {
                return true;
            }
        } else if path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.eq_ignore_ascii_case("SKILL.md"))
        {
            return true;
        }
    }
    false
}

fn copy_dir_all(src: &Path, dst: &Path) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let target = dst.join(entry.file_name());
        let file_type = entry.file_type().map_err(|e| e.to_string())?;
        #[cfg(unix)]
        if file_type.is_symlink() {
            let link_target = fs::read_link(entry.path()).map_err(|e| e.to_string())?;
            std::os::unix::fs::symlink(link_target, &target).map_err(|e| e.to_string())?;
            continue;
        }
        if file_type.is_dir() {
            copy_dir_all(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), &target).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn chrono_now() -> String {
    // Simple ISO 8601 timestamp without pulling in the chrono crate
    let duration = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    format!("{}Z", duration.as_secs())
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;
    use ed25519_dalek::pkcs8::EncodePublicKey;
    use ed25519_dalek::{Signer, SigningKey};
    use pretty_assertions::assert_eq;
    use serial_test::serial;
    use std::io::Write;
    use tempfile::TempDir;

    // -------- Fixtures --------

    fn test_keypair() -> (SigningKey, String) {
        // Deterministic seed so signed test vectors are stable across runs.
        let signing_key = SigningKey::from_bytes(&[7u8; 32]);
        let pem = signing_key
            .verifying_key()
            .to_public_key_pem(ed25519_dalek::pkcs8::spki::der::pem::LineEnding::LF)
            .unwrap();
        (signing_key, pem)
    }

    fn fixture_manifest() -> RuntimeUpdateManifest {
        RuntimeUpdateManifest {
            schema_version: MANIFEST_SCHEMA_VERSION,
            channel: "stable".to_string(),
            runtime_version: "1.2.3-cn.1".to_string(),
            kernel_version: "1.2.3".to_string(),
            runtime_flavor: "cn".to_string(),
            runtime_revision: 1,
            platform: "linux".to_string(),
            arch: "x64".to_string(),
            artifact_url: "https://example.com/foo.zip".to_string(),
            sha256: "deadbeef".to_string(),
            signature: String::new(),
            source_repo: "owner/repo".to_string(),
            source_commit: "abc123".to_string(),
            min_app_version: None,
            created_at: None,
        }
    }

    fn sign_manifest(key: &SigningKey, m: &mut RuntimeUpdateManifest) {
        let payload = signature_payload(m);
        let sig = key.sign(&payload);
        m.signature = base64::engine::general_purpose::STANDARD.encode(sig.to_bytes());
    }

    // -------- containment roots --------

    #[test]
    #[serial]
    fn runtime_root_override_moves_the_entire_desktop_runtime_tree() {
        let tmp = TempDir::new().unwrap();
        std::env::set_var("HERMES_DESKTOP_RUNTIME_ROOT", tmp.path());

        assert_eq!(runtime_root(), tmp.path());
        assert_eq!(hermes_home_dir(), tmp.path().join("hermes-home"));
        assert_eq!(gateway_runtime_dir(), tmp.path().join("gateway-runtime"));

        std::env::remove_var("HERMES_DESKTOP_RUNTIME_ROOT");
    }

    // -------- sha256_hex --------

    #[test]
    fn sha256_empty_slice() {
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn sha256_known_vector_abc() {
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn sha256_changes_with_input() {
        assert_ne!(sha256_hex(b"a"), sha256_hex(b"b"));
    }

    // -------- safe_version_segment --------

    #[test]
    fn safe_version_passes_normal_semver() {
        assert_eq!(safe_version_segment("1.2.3"), "1.2.3");
    }

    #[test]
    fn safe_version_keeps_prerelease_and_build_metadata() {
        assert_eq!(
            safe_version_segment("1.2.3-alpha+build.5"),
            "1.2.3-alpha+build.5"
        );
    }

    #[test]
    fn safe_version_strips_path_traversal_attempt() {
        assert_eq!(safe_version_segment("../etc/passwd"), "..etcpasswd");
    }

    #[test]
    fn safe_version_truncates_to_120_chars() {
        let huge = "a".repeat(200);
        let out = safe_version_segment(&huge);
        assert_eq!(out.len(), 120);
        assert!(out.chars().all(|c| c == 'a'));
    }

    #[test]
    fn safe_version_falls_back_to_timestamp_when_empty() {
        let out = safe_version_segment("$$$///");
        // After filtering, only nothing remains → timestamp fallback (digits, non-empty)
        assert!(!out.is_empty());
        assert!(out.chars().all(|c| c.is_ascii_digit()));
    }

    #[test]
    #[serial]
    fn read_current_record_migrates_legacy_local_source_schema() {
        let tmp = TempDir::new().unwrap();
        std::env::set_var("HERMES_DESKTOP_RUNTIME_ROOT", tmp.path());

        let runtime_version = "dev-local-0.14.0-abcdef123456-dirty-deadbeef0000";
        let runtime_dir = tmp.path().join("versions").join(runtime_version);
        let exe = runtime_dir.join("venv").join("bin").join("hermes");
        fs::create_dir_all(exe.parent().unwrap()).unwrap();
        fs::write(&exe, "#!/bin/sh\n").unwrap();
        fs::write(
            runtime_dir.join(MANIFEST_FILE),
            r#"{"kind":"local-source-runtime","projectVersion":"0.14.0"}"#,
        )
        .unwrap();
        fs::write(
            current_record_path(),
            format!(
                r#"{{
  "version": "{runtime_version}",
  "platform": "{}",
  "arch": "{}",
  "path": "{}",
  "executablePath": "{}",
  "source": "local-source",
  "installedAt": "2026-05-19T00:00:00.000Z",
  "upstreamRepo": "/repo/hermes-agent-cn",
  "upstreamCommit": "abcdef1234567890",
  "localDirtyHash": "deadbeef0000",
  "artifactSha256": null,
  "previousVersion": "0.13.0"
}}"#,
                current_platform(),
                current_arch(),
                runtime_dir.display(),
                exe.display(),
            ),
        )
        .unwrap();

        let record = read_current_record().expect("legacy record should migrate");
        assert_eq!(record.schema_version, MANIFEST_SCHEMA_VERSION);
        assert_eq!(record.runtime_version, runtime_version);
        assert_eq!(record.kernel_version, "0.14.0");
        assert_eq!(record.runtime_flavor, "cn-local");
        assert_eq!(record.source_repo.as_deref(), Some("/repo/hermes-agent-cn"));
        assert_eq!(record.source_commit.as_deref(), Some("abcdef1234567890"));
        assert_eq!(record.previous_runtime_version.as_deref(), Some("0.13.0"));

        let rewritten = fs::read_to_string(current_record_path()).unwrap();
        assert!(rewritten.contains(r#""schemaVersion": 2"#));
        assert!(rewritten.contains(r#""runtimeVersion": "dev-local-0.14.0"#));
        assert!(!rewritten.contains(r#""upstreamRepo""#));

        std::env::remove_var("HERMES_DESKTOP_RUNTIME_ROOT");
    }

    fn long_running_command() -> Command {
        let mut cmd = if cfg!(target_os = "windows") {
            let mut cmd = Command::new("cmd");
            cmd.args(["/C", "ping -n 6 127.0.0.1"]);
            cmd
        } else {
            let mut cmd = Command::new("sh");
            cmd.args(["-c", "sleep 5"]);
            cmd
        };
        cmd.stdout(Stdio::null()).stderr(Stdio::null());
        cmd
    }

    #[tokio::test]
    async fn smoke_child_timeout_kills_hung_process() {
        let child = long_running_command().spawn().expect("spawn sleep command");
        let err = wait_for_smoke_child(child, Duration::from_millis(50))
            .await
            .expect_err("hung smoke child should time out");
        assert!(err.contains("timed out"), "unexpected error: {err}");
    }

    // -------- signature_payload --------

    #[test]
    fn signature_payload_has_stable_field_order() {
        let m = fixture_manifest();
        let payload = String::from_utf8(signature_payload(&m)).unwrap();
        let lines: Vec<&str> = payload.split('\n').collect();
        assert_eq!(
            lines,
            vec![
                "2",                           // schema_version
                "stable",                      // channel
                "1.2.3-cn.1",                  // runtime_version
                "1.2.3",                       // kernel_version
                "cn",                          // runtime_flavor
                "1",                           // runtime_revision
                "linux",                       // platform
                "x64",                         // arch
                "https://example.com/foo.zip", // artifact_url
                "deadbeef",                    // sha256
                "owner/repo",                  // source_repo
                "abc123",                      // source_commit
            ]
        );
    }

    #[test]
    fn signature_payload_differs_when_any_field_changes() {
        let baseline = signature_payload(&fixture_manifest());
        let mut m = fixture_manifest();
        m.sha256 = "tampered".to_string();
        assert_ne!(signature_payload(&m), baseline);
        let mut m2 = fixture_manifest();
        m2.artifact_url = "https://attacker.com/x.zip".to_string();
        assert_ne!(signature_payload(&m2), baseline);
    }

    // -------- verify_signature_with_key --------

    #[test]
    fn verify_accepts_valid_signature() {
        let (key, pem) = test_keypair();
        let mut m = fixture_manifest();
        sign_manifest(&key, &mut m);
        verify_signature_with_key(&m, &pem).expect("should verify");
    }

    #[test]
    fn verify_rejects_tampered_version() {
        let (key, pem) = test_keypair();
        let mut m = fixture_manifest();
        sign_manifest(&key, &mut m);
        m.runtime_version = "9.9.9-cn.1".to_string();
        let err = verify_signature_with_key(&m, &pem).unwrap_err();
        assert!(err.contains("Signature verification failed"));
    }

    #[test]
    fn verify_rejects_tampered_sha256() {
        let (key, pem) = test_keypair();
        let mut m = fixture_manifest();
        sign_manifest(&key, &mut m);
        m.sha256 = "0000".to_string();
        assert!(verify_signature_with_key(&m, &pem).is_err());
    }

    #[test]
    fn verify_rejects_tampered_artifact_url() {
        let (key, pem) = test_keypair();
        let mut m = fixture_manifest();
        sign_manifest(&key, &mut m);
        m.artifact_url = "https://attacker.example/x.zip".to_string();
        assert!(verify_signature_with_key(&m, &pem).is_err());
    }

    #[test]
    fn verify_rejects_invalid_signature_base64() {
        let (_, pem) = test_keypair();
        let mut m = fixture_manifest();
        m.signature = "!!!not base64!!!".to_string();
        let err = verify_signature_with_key(&m, &pem).unwrap_err();
        assert!(err.contains("Invalid signature base64"));
    }

    #[test]
    fn verify_rejects_signature_from_different_key() {
        let (key_a, _) = test_keypair();
        // Use a different key for verification
        let key_b = SigningKey::from_bytes(&[42u8; 32]);
        let pem_b = key_b
            .verifying_key()
            .to_public_key_pem(ed25519_dalek::pkcs8::spki::der::pem::LineEnding::LF)
            .unwrap();
        let mut m = fixture_manifest();
        sign_manifest(&key_a, &mut m);
        assert!(verify_signature_with_key(&m, &pem_b).is_err());
    }

    #[test]
    fn verify_rejects_too_short_der() {
        // PEM body must base64-decode to ≥ 32 bytes for raw key extraction.
        let bad_pem = "-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----\n";
        let m = fixture_manifest();
        let err = verify_signature_with_key(&m, bad_pem).unwrap_err();
        assert!(err.contains("Public key DER too short"));
    }

    #[test]
    fn verify_rejects_malformed_pem_base64() {
        let bad_pem = "-----BEGIN PUBLIC KEY-----\n!!!\n-----END PUBLIC KEY-----\n";
        let m = fixture_manifest();
        let err = verify_signature_with_key(&m, bad_pem).unwrap_err();
        assert!(err.contains("Invalid public key PEM"));
    }

    // -------- extract_zip --------

    fn write_zip(out: &Path, entries: &[(&str, &[u8])]) {
        let file = std::fs::File::create(out).unwrap();
        let mut writer = zip::ZipWriter::new(file);
        let opts = zip::write::SimpleFileOptions::default();
        for (name, content) in entries {
            writer.start_file(*name, opts).unwrap();
            writer.write_all(content).unwrap();
        }
        writer.finish().unwrap();
    }

    #[test]
    fn extract_zip_normal_files() {
        let dir = TempDir::new().unwrap();
        let zip_path = dir.path().join("ok.zip");
        let dest = dir.path().join("out");
        std::fs::create_dir_all(&dest).unwrap();
        write_zip(&zip_path, &[("foo.txt", b"hello"), ("bin/x", b"binary")]);

        extract_zip(&zip_path, &dest).unwrap();

        assert_eq!(std::fs::read(dest.join("foo.txt")).unwrap(), b"hello");
        assert_eq!(std::fs::read(dest.join("bin/x")).unwrap(), b"binary");
    }

    #[test]
    fn extract_zip_rejects_path_traversal() {
        let dir = TempDir::new().unwrap();
        let zip_path = dir.path().join("evil.zip");
        let dest = dir.path().join("out");
        std::fs::create_dir_all(&dest).unwrap();
        write_zip(&zip_path, &[("../escape.txt", b"hacked")]);

        let err = extract_zip(&zip_path, &dest).unwrap_err();
        assert!(
            err.contains("path traversal") || err.contains("escapes destination"),
            "unexpected error: {}",
            err
        );
        assert!(!dir.path().join("escape.txt").exists());
    }

    #[test]
    fn extract_zip_rejects_too_many_files() {
        let dir = TempDir::new().unwrap();
        let zip_path = dir.path().join("bomb.zip");
        let dest = dir.path().join("out");
        std::fs::create_dir_all(&dest).unwrap();

        let file = std::fs::File::create(&zip_path).unwrap();
        let mut writer = zip::ZipWriter::new(file);
        let opts = zip::write::SimpleFileOptions::default();
        // MAX_ZIP_FILES = 5000 — push 5001 empty entries.
        for i in 0..5001 {
            writer.start_file(format!("f{}", i), opts).unwrap();
        }
        writer.finish().unwrap();

        let err = extract_zip(&zip_path, &dest).unwrap_err();
        assert!(err.contains("Zip contains"), "unexpected error: {}", err);
    }

    #[cfg(unix)]
    #[test]
    fn extract_zip_preserves_unix_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let dir = TempDir::new().unwrap();
        let zip_path = dir.path().join("perms.zip");
        let dest = dir.path().join("out");
        std::fs::create_dir_all(&dest).unwrap();

        let file = std::fs::File::create(&zip_path).unwrap();
        let mut writer = zip::ZipWriter::new(file);
        let opts = zip::write::SimpleFileOptions::default().unix_permissions(0o755);
        writer.start_file("script.sh", opts).unwrap();
        writer.write_all(b"#!/bin/sh\necho hi").unwrap();
        writer.finish().unwrap();

        extract_zip(&zip_path, &dest).unwrap();

        let mode = std::fs::metadata(dest.join("script.sh"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o755);
    }

    #[cfg(unix)]
    #[test]
    fn extract_zip_preserves_unix_symlinks() {
        let dir = TempDir::new().unwrap();
        let zip_path = dir.path().join("symlink.zip");
        let dest = dir.path().join("out");
        std::fs::create_dir_all(&dest).unwrap();

        let file = std::fs::File::create(&zip_path).unwrap();
        let mut writer = zip::ZipWriter::new(file);
        let file_opts = zip::write::SimpleFileOptions::default().unix_permissions(0o644);
        writer.start_file("target.txt", file_opts).unwrap();
        writer.write_all(b"target").unwrap();
        let link_opts = zip::write::SimpleFileOptions::default();
        writer
            .add_symlink("link.txt", "target.txt", link_opts)
            .unwrap();
        writer.finish().unwrap();

        extract_zip(&zip_path, &dest).unwrap();

        assert_eq!(
            std::fs::read_link(dest.join("link.txt")).unwrap(),
            PathBuf::from("target.txt")
        );
        assert_eq!(std::fs::read(dest.join("link.txt")).unwrap(), b"target");
    }

    #[cfg(unix)]
    #[test]
    fn extract_zip_rejects_unsafe_symlink_targets() {
        let dir = TempDir::new().unwrap();
        let zip_path = dir.path().join("symlink.zip");
        let dest = dir.path().join("out");
        std::fs::create_dir_all(&dest).unwrap();

        let file = std::fs::File::create(&zip_path).unwrap();
        let mut writer = zip::ZipWriter::new(file);
        let opts = zip::write::SimpleFileOptions::default();
        writer
            .add_symlink("link.txt", "../escape.txt", opts)
            .unwrap();
        writer.finish().unwrap();

        let err = extract_zip(&zip_path, &dest).unwrap_err();
        assert!(
            err.contains("unsafe symlink target"),
            "unexpected error: {}",
            err
        );
        assert!(!dest.join("link.txt").exists());
    }

    // -------- copy_dir_all --------

    #[test]
    fn copy_dir_all_copies_nested_tree() {
        let dir = TempDir::new().unwrap();
        let src = dir.path().join("src");
        let dst = dir.path().join("dst");
        std::fs::create_dir_all(src.join("a/b")).unwrap();
        std::fs::write(src.join("top.txt"), b"top").unwrap();
        std::fs::write(src.join("a/mid.txt"), b"mid").unwrap();
        std::fs::write(src.join("a/b/leaf.txt"), b"leaf").unwrap();

        copy_dir_all(&src, &dst).unwrap();

        assert_eq!(std::fs::read(dst.join("top.txt")).unwrap(), b"top");
        assert_eq!(std::fs::read(dst.join("a/mid.txt")).unwrap(), b"mid");
        assert_eq!(std::fs::read(dst.join("a/b/leaf.txt")).unwrap(), b"leaf");
    }

    #[test]
    fn copy_dir_all_creates_empty_destination() {
        let dir = TempDir::new().unwrap();
        let src = dir.path().join("src");
        let dst = dir.path().join("dst");
        std::fs::create_dir_all(&src).unwrap();
        copy_dir_all(&src, &dst).unwrap();
        assert!(dst.is_dir());
    }

    #[cfg(unix)]
    #[test]
    fn copy_dir_all_preserves_symlinks() {
        let dir = TempDir::new().unwrap();
        let src = dir.path().join("src");
        let dst = dir.path().join("dst");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(src.join("target.txt"), b"target").unwrap();
        std::os::unix::fs::symlink("target.txt", src.join("link.txt")).unwrap();

        copy_dir_all(&src, &dst).unwrap();

        assert_eq!(
            std::fs::read_link(dst.join("link.txt")).unwrap(),
            PathBuf::from("target.txt")
        );
        assert_eq!(std::fs::read(dst.join("link.txt")).unwrap(), b"target");
    }

    // -------- sync_bundled_skills_from_resource --------

    #[test]
    fn sync_bundled_skills_from_resource_copies_tree() {
        let dir = TempDir::new().unwrap();
        let resource = dir.path().join("resources");
        let skills = resource
            .join(BUNDLED_SKILLS_RESOURCE_DIR)
            .join("creative")
            .join("demo");
        let runtime = dir.path().join("runtime");
        std::fs::create_dir_all(&skills).unwrap();
        std::fs::write(skills.join("SKILL.md"), b"---\nname: demo\n---\n").unwrap();
        std::fs::write(skills.join("helper.txt"), b"helper").unwrap();

        let target = sync_bundled_skills_from_resource(Some(&resource), &runtime)
            .unwrap()
            .unwrap();

        assert_eq!(target, runtime.join("_internal").join("skills"));
        assert!(target
            .join("creative")
            .join("demo")
            .join("SKILL.md")
            .is_file());
        assert_eq!(
            std::fs::read(target.join("creative").join("demo").join("helper.txt")).unwrap(),
            b"helper"
        );
    }

    #[test]
    fn sync_bundled_skills_from_resource_requires_skill_markdown() {
        let dir = TempDir::new().unwrap();
        let resource = dir.path().join("resources");
        let skills = resource.join(BUNDLED_SKILLS_RESOURCE_DIR).join("empty");
        let runtime = dir.path().join("runtime");
        std::fs::create_dir_all(&skills).unwrap();

        let err = sync_bundled_skills_from_resource(Some(&resource), &runtime).unwrap_err();

        assert!(err.contains("missing SKILL.md"), "unexpected error: {err}");
        assert!(!runtime.join("_internal").join("skills").exists());
    }

    #[test]
    fn sync_available_runtime_resources_from_resource_copies_present_assets() {
        let dir = TempDir::new().unwrap();
        let resource = dir.path().join("resources");
        let web_dist = resource
            .join(DASHBOARD_RESOURCE_DIR)
            .join(DASHBOARD_WEB_DIST_DIR);
        let skills = resource
            .join(BUNDLED_SKILLS_RESOURCE_DIR)
            .join("creative")
            .join("demo");
        let runtime = dir.path().join("runtime");
        std::fs::create_dir_all(web_dist.join("assets")).unwrap();
        std::fs::write(web_dist.join("index.html"), b"<html></html>").unwrap();
        std::fs::write(web_dist.join("assets").join("app.js"), b"console.log(1)").unwrap();
        std::fs::create_dir_all(&skills).unwrap();
        std::fs::write(skills.join("SKILL.md"), b"---\nname: demo\n---\n").unwrap();

        let synced = sync_available_runtime_resources_from_resource(Some(&resource), &runtime)
            .expect("sync should succeed");

        let expected_web_dist = runtime
            .join("_internal")
            .join("hermes_cli")
            .join(DASHBOARD_WEB_DIST_DIR);
        let expected_skills = runtime.join("_internal").join(BUNDLED_SKILLS_DIR);
        assert_eq!(synced.dashboard_web_dist, Some(expected_web_dist.clone()));
        assert_eq!(synced.bundled_skills, Some(expected_skills.clone()));
        assert!(expected_web_dist.join("index.html").is_file());
        assert!(expected_web_dist.join("assets").join("app.js").is_file());
        assert!(expected_skills
            .join("creative")
            .join("demo")
            .join("SKILL.md")
            .is_file());
    }

    #[test]
    fn sync_available_runtime_resources_from_resource_is_noop_when_assets_absent() {
        let dir = TempDir::new().unwrap();
        let resource = dir.path().join("resources");
        let runtime = dir.path().join("runtime");
        std::fs::create_dir_all(&resource).unwrap();

        let synced = sync_available_runtime_resources_from_resource(Some(&resource), &runtime)
            .expect("missing optional resources should not fail");

        assert!(synced.dashboard_web_dist.is_none());
        assert!(synced.bundled_skills.is_none());
        assert!(!runtime.join("_internal").exists());
    }

    #[test]
    fn bundled_runtime_available_accepts_expanded_runtime_tree() {
        let dir = TempDir::new().unwrap();
        let resource = dir.path().join("resources");
        let runtime = resource.join("bundled-runtime");
        std::fs::create_dir_all(bundled_expanded_runtime_dir(&runtime)).unwrap();
        std::fs::write(bundled_manifest_path(&runtime), b"{}").unwrap();

        assert!(bundled_runtime_available(Some(&resource)));
    }

    #[test]
    fn bundled_runtime_available_requires_manifest_and_payload() {
        let dir = TempDir::new().unwrap();
        let resource = dir.path().join("resources");
        let runtime = resource.join("bundled-runtime");
        std::fs::create_dir_all(&runtime).unwrap();

        assert!(!bundled_runtime_available(Some(&resource)));

        std::fs::write(bundled_manifest_path(&runtime), b"{}").unwrap();
        assert!(!bundled_runtime_available(Some(&resource)));
    }

    #[cfg(unix)]
    #[tokio::test]
    #[serial]
    async fn install_bundled_runtime_from_expanded_tree() {
        use std::os::unix::fs::PermissionsExt;

        let dir = TempDir::new().unwrap();
        let runtime_root = dir.path().join("runtime-root");
        let resource = dir.path().join("resources");
        let bundled = resource.join("bundled-runtime");
        let expanded = bundled_expanded_runtime_dir(&bundled);
        let web_dist = resource
            .join(DASHBOARD_RESOURCE_DIR)
            .join(DASHBOARD_WEB_DIST_DIR);
        let skills = resource
            .join(BUNDLED_SKILLS_RESOURCE_DIR)
            .join("creative")
            .join("demo");

        std::fs::create_dir_all(&expanded).unwrap();
        std::fs::create_dir_all(&web_dist).unwrap();
        std::fs::create_dir_all(&skills).unwrap();
        std::fs::write(web_dist.join("index.html"), b"<html></html>").unwrap();
        std::fs::write(skills.join("SKILL.md"), b"---\nname: demo\n---\n").unwrap();

        let executable = expanded.join(primary_runtime_name());
        std::fs::write(&executable, b"#!/bin/sh\nexit 0\n").unwrap();
        let mut perms = std::fs::metadata(&executable).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&executable, perms).unwrap();

        let (key, pem) = test_keypair();
        let mut manifest = fixture_manifest();
        manifest.runtime_version = "9.9.9-cn.1".to_string();
        manifest.platform = current_platform().to_string();
        manifest.arch = current_arch().to_string();
        manifest.sha256 =
            "37f4d6d615188f1e84bd361a0292e2a26376d72225b2420e5e91a62e7b2ebd0c".to_string();
        sign_manifest(&key, &mut manifest);
        write_json_file(&bundled_manifest_path(&bundled), &manifest).unwrap();

        std::env::set_var("HERMES_DESKTOP_RUNTIME_ROOT", &runtime_root);
        std::env::set_var("HERMES_RUNTIME_UPDATE_PUBLIC_KEY_PEM", pem);

        let result = install_bundled_runtime_if_needed(Some(&resource)).await;

        std::env::remove_var("HERMES_RUNTIME_UPDATE_PUBLIC_KEY_PEM");
        std::env::remove_var("HERMES_DESKTOP_RUNTIME_ROOT");

        assert!(result.ok, "unexpected install error: {:?}", result.error);
        let installed = result.installed.expect("runtime should be installed");
        assert_eq!(installed.runtime_version, "9.9.9-cn.1");
        assert_eq!(installed.source, "bundled");
        assert_eq!(
            installed.artifact_sha256.as_deref(),
            Some(manifest.sha256.as_str())
        );
        assert!(Path::new(&installed.executable_path).is_file());
        assert!(Path::new(&installed.path)
            .join("_internal")
            .join("hermes_cli")
            .join(DASHBOARD_WEB_DIST_DIR)
            .join("index.html")
            .is_file());
        assert!(Path::new(&installed.path)
            .join("_internal")
            .join(BUNDLED_SKILLS_DIR)
            .join("creative")
            .join("demo")
            .join("SKILL.md")
            .is_file());
    }

    #[cfg(unix)]
    #[tokio::test]
    #[serial]
    async fn install_bundled_runtime_from_zip_preserves_symlinks() {
        let dir = TempDir::new().unwrap();
        let runtime_root = dir.path().join("runtime-root");
        let resource = dir.path().join("resources");
        let bundled = resource.join("bundled-runtime");
        let web_dist = resource
            .join(DASHBOARD_RESOURCE_DIR)
            .join(DASHBOARD_WEB_DIST_DIR);
        let skills = resource
            .join(BUNDLED_SKILLS_RESOURCE_DIR)
            .join("creative")
            .join("demo");
        std::fs::create_dir_all(&bundled).unwrap();
        std::fs::create_dir_all(&web_dist).unwrap();
        std::fs::create_dir_all(&skills).unwrap();
        std::fs::write(web_dist.join("index.html"), b"<html></html>").unwrap();
        std::fs::write(skills.join("SKILL.md"), b"---\nname: demo\n---\n").unwrap();

        let zip_path = bundled_artifact_path(&bundled);
        let runtime_dir_name = format!(
            "{}-{}-{}",
            RUNTIME_BASENAME,
            current_platform(),
            current_arch()
        );
        let executable_entry = format!("{runtime_dir_name}/{}", primary_runtime_name());
        let target_entry = format!("{runtime_dir_name}/target.txt");
        let link_entry = format!("{runtime_dir_name}/link.txt");

        let file = std::fs::File::create(&zip_path).unwrap();
        let mut writer = zip::ZipWriter::new(file);
        let exe_opts = zip::write::SimpleFileOptions::default().unix_permissions(0o755);
        writer.start_file(&executable_entry, exe_opts).unwrap();
        writer.write_all(b"#!/bin/sh\nexit 0\n").unwrap();
        let file_opts = zip::write::SimpleFileOptions::default().unix_permissions(0o644);
        writer.start_file(&target_entry, file_opts).unwrap();
        writer.write_all(b"target").unwrap();
        writer
            .add_symlink(
                &link_entry,
                "target.txt",
                zip::write::SimpleFileOptions::default(),
            )
            .unwrap();
        writer.finish().unwrap();

        let (key, pem) = test_keypair();
        let mut manifest = fixture_manifest();
        manifest.runtime_version = "9.9.9-cn.2".to_string();
        manifest.platform = current_platform().to_string();
        manifest.arch = current_arch().to_string();
        manifest.sha256 = file_sha256(&zip_path).unwrap();
        sign_manifest(&key, &mut manifest);
        write_json_file(&bundled_manifest_path(&bundled), &manifest).unwrap();

        std::env::set_var("HERMES_DESKTOP_RUNTIME_ROOT", &runtime_root);
        std::env::set_var("HERMES_RUNTIME_UPDATE_PUBLIC_KEY_PEM", pem);

        let result = install_bundled_runtime_if_needed(Some(&resource)).await;

        std::env::remove_var("HERMES_RUNTIME_UPDATE_PUBLIC_KEY_PEM");
        std::env::remove_var("HERMES_DESKTOP_RUNTIME_ROOT");

        assert!(result.ok, "unexpected install error: {:?}", result.error);
        let installed = result.installed.expect("runtime should be installed");
        let installed_root = Path::new(&installed.path).join(runtime_dir_name);
        assert_eq!(installed.runtime_version, "9.9.9-cn.2");
        assert_eq!(
            std::fs::read_link(installed_root.join("link.txt")).unwrap(),
            PathBuf::from("target.txt")
        );
        assert_eq!(
            std::fs::read(installed_root.join("link.txt")).unwrap(),
            b"target"
        );
    }

    // -------- find_executable_in --------

    fn primary_runtime_name() -> String {
        runtime_binary_names().into_iter().next().unwrap()
    }

    #[test]
    fn find_executable_direct_child() {
        let dir = TempDir::new().unwrap();
        let name = primary_runtime_name();
        let target = dir.path().join(&name);
        std::fs::write(&target, b"").unwrap();
        let found = find_executable_in(dir.path(), 0).unwrap();
        assert_eq!(found, target);
    }

    #[test]
    fn find_executable_in_bin_subdir() {
        let dir = TempDir::new().unwrap();
        let name = primary_runtime_name();
        let bin = dir.path().join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let target = bin.join(&name);
        std::fs::write(&target, b"").unwrap();
        let found = find_executable_in(dir.path(), 0).unwrap();
        assert_eq!(found, target);
    }

    #[test]
    fn find_executable_nested_within_depth() {
        let dir = TempDir::new().unwrap();
        let name = primary_runtime_name();
        let nested = dir.path().join("x").join("y");
        std::fs::create_dir_all(&nested).unwrap();
        let target = nested.join(&name);
        std::fs::write(&target, b"").unwrap();
        // Need depth ≥ 2 to walk dir → x → y
        let found = find_executable_in(dir.path(), 2).unwrap();
        assert_eq!(found, target);
    }

    #[test]
    fn find_executable_too_deep_returns_none() {
        let dir = TempDir::new().unwrap();
        let name = primary_runtime_name();
        let nested = dir.path().join("x").join("y");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(nested.join(&name), b"").unwrap();
        // depth=1 cannot reach dir/x/y/name (it's 2 levels deep)
        assert!(find_executable_in(dir.path(), 1).is_none());
    }

    #[test]
    fn find_executable_returns_none_for_empty_dir() {
        let dir = TempDir::new().unwrap();
        assert!(find_executable_in(dir.path(), 3).is_none());
    }

    #[test]
    fn find_executable_returns_none_for_missing_path() {
        let dir = TempDir::new().unwrap();
        let nope = dir.path().join("nope");
        assert!(find_executable_in(&nope, 3).is_none());
    }

    // -------- configured_manifest_url / configured_public_key --------

    fn clear_runtime_env() {
        for var in [
            "HERMES_RUNTIME_UPDATE_MANIFEST_URL",
            "HERMES_RUNTIME_UPDATE_BASE_URL",
            "HERMES_RUNTIME_UPDATE_CHANNEL",
            "HERMES_RUNTIME_UPDATE_PUBLIC_KEY_PEM",
            "HERMES_RUNTIME_UPDATE_PUBLIC_KEY_FILE",
        ] {
            std::env::remove_var(var);
        }
    }

    #[test]
    #[serial]
    fn manifest_url_uses_explicit_env_when_set() {
        clear_runtime_env();
        std::env::set_var(
            "HERMES_RUNTIME_UPDATE_MANIFEST_URL",
            "https://explicit.example/m.json",
        );
        assert_eq!(
            configured_manifest_url(),
            Some("https://explicit.example/m.json".to_string())
        );
        clear_runtime_env();
    }

    #[test]
    #[serial]
    fn manifest_url_builds_from_base_and_channel_env() {
        clear_runtime_env();
        std::env::set_var("HERMES_RUNTIME_UPDATE_BASE_URL", "https://base.example");
        std::env::set_var("HERMES_RUNTIME_UPDATE_CHANNEL", "beta");
        let url = configured_manifest_url().unwrap();
        assert!(url.starts_with("https://base.example/beta-"));
        assert!(url.ends_with(".json"));
        clear_runtime_env();
    }

    #[test]
    #[serial]
    fn manifest_url_falls_back_when_env_unset() {
        clear_runtime_env();
        // No env, no compile-time bake (BAKED_* are option_env! and unset in
        // dev/test builds), so we get FALLBACK_MANIFEST_BASE_URL + default channel.
        let url = configured_manifest_url().unwrap();
        assert!(url.contains("Eynzof/hermes-agent-cn"));
        assert!(url.contains("stable-"));
    }

    #[test]
    #[serial]
    fn public_key_uses_explicit_env_when_set() {
        clear_runtime_env();
        let custom = "-----BEGIN PUBLIC KEY-----\nCUSTOM\n-----END PUBLIC KEY-----";
        std::env::set_var("HERMES_RUNTIME_UPDATE_PUBLIC_KEY_PEM", custom);
        assert_eq!(configured_public_key().as_deref(), Some(custom));
        clear_runtime_env();
    }

    #[test]
    #[serial]
    fn public_key_falls_back_to_hardcoded() {
        clear_runtime_env();
        let pem = configured_public_key().unwrap();
        assert!(pem.contains("BEGIN PUBLIC KEY"));
        assert!(pem.contains("END PUBLIC KEY"));
    }
}
