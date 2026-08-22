// UI layer hot update (Track B) — signed web-dist zip swap.
//
// The webview React app (`web/dist`) is normally embedded in the desktop
// binary. This module adds an independent "UI channel": a signed manifest +
// zip are downloaded, verified (Ed25519 over a 10-field payload reusing the
// kernel's baked public key), extracted into the writable app-data tree under
// `runtime_root()/ui/versions/<v>/`, smoke-checked, and activated atomically
// by rewriting `ui/current.json`. The custom `hermesui:` URI scheme handler
// (src/main.rs) serves that tree to the window, guarded by the signed
// `appVersionFloor` gate and falling back to the embedded bundle.
//
// The kernel track (runtime.rs) is untouched; ~90% of the primitives
// (extract_zip guards, sha256, Ed25519 verification, safe version segments,
// cross-device copy fallback) are reused from `crate::process::runtime`.
//
// Disk layout (mirrors runtime.rs's versions/<v>/ + current.json):
//   runtime_root()/ui/
//     current.json                 UiInstallRecord (camelCase)
//     versions/<safe(uiVersion)>/  extracted web/dist
//       index.html
//       assets/...
//       manifest.json              archived signed UiUpdateManifest
//     downloads/<uiVersion>.zip

use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::LazyLock;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::process::runtime;

const UI_SCHEMA_VERSION: u32 = 1;
const UI_CURRENT_FILE: &str = "current.json";
const UI_MANIFEST_FILE: &str = "manifest.json";
const UI_DEFAULT_CHANNEL: &str = "stable";
/// Hardcoded fallback base URL for the UI update channel (same host layout as
/// the runtime channel, `/ui` sub-path). Overridable at runtime via
/// `HERMES_UI_UPDATE_MANIFEST_URL` / `HERMES_UI_UPDATE_BASE_URL` and at build
/// time via `HERMES_UI_UPDATE_BASE_URL_DEFAULT`.
const UI_FALLBACK_MANIFEST_BASE_URL: &str = "https://desktop.hermesagent.org.cn/ui";
const UI_BAKED_MANIFEST_BASE_URL: Option<&str> = option_env!("HERMES_UI_UPDATE_BASE_URL_DEFAULT");
const UI_BAKED_MANIFEST_CHANNEL: Option<&str> = option_env!("HERMES_UI_UPDATE_CHANNEL_DEFAULT");
const UI_MANIFEST_HTTP_TIMEOUT: Duration = Duration::from_secs(30);
const UI_ARTIFACT_HTTP_TIMEOUT: Duration = Duration::from_secs(15 * 60);
/// Extra staging marker so concurrent installs (guarded by the command layer)
/// still never collide on the same tempdir prefix.
const UI_STAGING_PREFIX: &str = ".installing-ui-";

static UI_HTTP_CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .user_agent("hermes-agent-cn-desktop-ui-update")
        .build()
        .expect("valid UI update HTTP client")
});

/// Signed UI update manifest. Field order is load-bearing: the Ed25519
/// payload joins exactly these ten fields with `\n` (see
/// [`ui_signature_payload`]), matching the Core signing pipeline.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiUpdateManifest {
    pub schema_version: u32,
    pub channel: String,
    pub ui_version: String,
    /// Minimum desktop shell version this UI package requires. Signed gate —
    /// the `hermesui:` handler refuses to serve a package whose floor is above
    /// the running shell, so a bad UI can never brick the window.
    pub app_version_floor: String,
    pub platform: String,
    pub arch: String,
    pub artifact_url: String,
    pub sha256: String,
    pub signature: String,
    pub source_repo: String,
    pub source_commit: String,
}

/// Persisted activation record — `ui/current.json`. camelCase, mirrors
/// `RuntimeInstallRecord`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiInstallRecord {
    pub schema_version: u32,
    pub ui_version: String,
    pub app_version_floor: String,
    pub channel: String,
    pub path: String,
    pub sha256: String,
    pub source: String,
    pub installed_at: String,
    pub previous_ui_version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiUpdateCheckResult {
    pub ok: bool,
    pub update_available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_ui_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub manifest: Option<UiUpdateManifest>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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

/// Payload emitted on `ui-update-ready` after a successful install/rollback so
/// the renderer can `location.reload()` as a belt-and-suspenders fallback.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiUpdateReadyPayload {
    pub ui_version: String,
}

// ───────────────────────────── disk layout ────────────────────────────────

pub(crate) fn ui_root() -> PathBuf {
    runtime::runtime_root().join("ui")
}

fn ui_versions_root() -> PathBuf {
    ui_root().join("versions")
}

fn ui_current_record_path() -> PathBuf {
    ui_root().join(UI_CURRENT_FILE)
}

fn ui_downloads_root() -> PathBuf {
    ui_root().join("downloads")
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

/// Create `path` under `ui_root()` and verify it cannot escape the UI root
/// (mirrors runtime.rs's `ensure_managed_subdir`).
fn ensure_ui_subdir(path: &Path, label: &str) -> Result<PathBuf, String> {
    fs::create_dir_all(path).map_err(|error| {
        format!(
            "Failed to create managed UI {label} directory {}: {}",
            path.display(),
            error
        )
    })?;
    let canonical_root = ui_root().canonicalize().map_err(|error| {
        format!(
            "Failed to validate UI root {}: {}",
            ui_root().display(),
            error
        )
    })?;
    let canonical_path = path.canonicalize().map_err(|error| {
        format!(
            "Failed to validate managed UI {label} directory {}: {}",
            path.display(),
            error
        )
    })?;
    if canonical_path == canonical_root || !canonical_path.starts_with(&canonical_root) {
        return Err(format!(
            "Managed UI {label} directory escapes UI root: {}",
            canonical_path.display()
        ));
    }
    Ok(canonical_path)
}

/// Remove an existing installed UI version directory, refusing symlinks and
/// non-directories (mirrors `remove_existing_runtime_target`).
fn remove_existing_ui_target(target: &Path) -> Result<(), String> {
    let metadata = match fs::symlink_metadata(target) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(format!(
                "Failed to inspect existing UI target {}: {}",
                target.display(),
                error
            ));
        }
    };
    if metadata.file_type().is_symlink() {
        return Err(format!(
            "Refusing to replace symlinked UI target {}",
            target.display()
        ));
    }
    if !metadata.is_dir() {
        return Err(format!(
            "Existing UI target is not a directory: {}",
            target.display()
        ));
    }
    let versions = ensure_ui_subdir(&ui_versions_root(), "versions")?;
    let canonical_target = target.canonicalize().map_err(|error| {
        format!(
            "Failed to validate existing UI target {}: {}",
            target.display(),
            error
        )
    })?;
    if !canonical_target.starts_with(&versions) {
        return Err(format!(
            "Existing UI target escapes versions directory: {}",
            canonical_target.display()
        ));
    }
    fs::remove_dir_all(target)
        .map_err(|error| format!("Failed to remove existing UI target: {error}"))
}

// ─────────────────────────── manifest URL cascade ──────────────────────────

/// UI manifest URL cascade (mirrors runtime.rs's `configured_manifest_url`):
/// `HERMES_UI_UPDATE_MANIFEST_URL` (full URL) > `HERMES_UI_UPDATE_BASE_URL` +
/// `HERMES_UI_UPDATE_CHANNEL` > compile-time `*_DEFAULT` bakes > hardcoded
/// fallback. File name pattern: `${base}/${channel}-${platform}-${arch}.json`.
pub(crate) fn ui_manifest_url() -> Option<String> {
    if let Ok(explicit) = std::env::var("HERMES_UI_UPDATE_MANIFEST_URL") {
        let trimmed = explicit.trim().to_string();
        if !trimmed.is_empty() {
            return Some(trimmed);
        }
    }
    let base = std::env::var("HERMES_UI_UPDATE_BASE_URL")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| UI_BAKED_MANIFEST_BASE_URL.map(|s| s.to_string()))
        .unwrap_or_else(|| UI_FALLBACK_MANIFEST_BASE_URL.to_string());
    let base = base.trim();
    if base.is_empty() {
        return None;
    }
    let channel = std::env::var("HERMES_UI_UPDATE_CHANNEL")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| UI_BAKED_MANIFEST_CHANNEL.map(|s| s.to_string()))
        .unwrap_or_else(|| UI_DEFAULT_CHANNEL.to_string());
    let base = if base.ends_with('/') {
        base.trim_end_matches('/').to_string()
    } else {
        base.to_string()
    };
    Some(format!(
        "{}/{}-{}-{}.json",
        base,
        channel,
        runtime::current_platform(),
        runtime::current_arch()
    ))
}

// ───────────────────────────── signature payload ───────────────────────────

/// UI manifest Ed25519 payload — ten fields, order locked, joined with `\n`
/// (mirrors the kernel payload shape; the Core signing script must produce the
/// exact same string).
pub(crate) fn ui_signature_payload(manifest: &UiUpdateManifest) -> Vec<u8> {
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

/// Verify the UI manifest signature with the same configured public key the
/// kernel track trusts (env > baked > fallback, see runtime.rs).
pub fn verify_ui_signature(manifest: &UiUpdateManifest) -> Result<(), String> {
    let public_key_pem = runtime::configured_public_key()
        .ok_or_else(|| "UI update public key is not configured".to_string())?;
    let payload = ui_signature_payload(manifest);
    runtime::verify_payload_signature(&payload, &manifest.signature, &public_key_pem)
}

// ───────────────────────────── version gates ───────────────────────────────

/// Parse the `major.minor.patch` core of a semver-ish string (ignores
/// prerelease/build suffixes).
fn semver_parts(version: &str) -> Option<(u64, u64, u64)> {
    let core = version.split(['-', '+']).next()?;
    let mut parts = core.split('.');
    let major = parts.next()?.trim().parse().ok()?;
    let minor = parts.next().unwrap_or("0").trim().parse().ok()?;
    let patch = parts.next().unwrap_or("0").trim().parse().ok()?;
    Some((major, minor, patch))
}

/// `desktop >= floor` comparison used by the signed `appVersionFloor` gate.
fn desktop_ge(floor: &str) -> bool {
    match (semver_parts(env!("CARGO_PKG_VERSION")), semver_parts(floor)) {
        (Some(desktop), Some(floor)) => desktop >= floor,
        // Unparsable floor fails closed (unless empty — a package that does
        // not declare a floor is fine for any shell).
        _ => floor.trim().is_empty(),
    }
}

// ─────────────────────────── current record queries ────────────────────────

/// Read the active UI install record, validating schema/platform/arch and that
/// `index.html` actually exists on disk (a broken record reads as absent and
/// the handler falls back to the embedded bundle).
pub(crate) fn ui_current_record() -> Option<UiInstallRecord> {
    let record = read_json_file::<UiInstallRecord>(&ui_current_record_path())?;
    if record.schema_version != UI_SCHEMA_VERSION {
        return None;
    }
    let index = Path::new(&record.path).join("index.html");
    if !index.is_file() {
        return None;
    }
    Some(record)
}

/// Resolve the current UI index.html path, when a valid record is active.
/// Used by the `hermesui:` scheme handler as an extra presence check.
pub fn ui_current_index_path() -> Option<PathBuf> {
    ui_current_record().map(|record| Path::new(&record.path).join("index.html"))
}

/// The signed `appVersionFloor` of the currently active UI package, when one
/// is installed. Consulted by the scheme handler's floor gate.
pub fn ui_app_version_floor() -> Option<String> {
    ui_current_record().map(|record| record.app_version_floor)
}

/// Version directory the `hermesui:` handler should serve from, or `None`
/// when there is no eligible hot-updated UI (valid record + index.html on disk
/// + signed floor gate satisfied).
///
/// `None` ⇒ the handler falls back to the embedded `frontendDist`.
pub fn ui_serving_version_dir() -> Option<PathBuf> {
    let record = ui_current_record()?;
    if !desktop_ge(&record.app_version_floor) {
        return None;
    }
    Some(PathBuf::from(&record.path))
}

// ─────────────────── serve-time path traversal guard ───────────────────────

/// Resolve a `hermesui:` request path to an absolute file inside `version_dir`.
///
/// Mirrors the zip-slip `enclosed_name()` guards from `runtime::extract_zip`:
/// absolute paths, `..` segments, root/prefix components and any resolution
/// that escapes the version dir (including symlinks pointing outside it) are
/// rejected. An empty path resolves to `index.html` (the window entry).
/// Pure and filesystem-agnostic enough to unit test directly.
pub fn resolve_ui_asset(version_dir: &Path, request_path: &str) -> Option<PathBuf> {
    let version_dir = version_dir
        .canonicalize()
        .unwrap_or_else(|_| version_dir.to_path_buf());
    let relative = request_path.trim_start_matches('/');
    if relative.is_empty() {
        let index = version_dir.join("index.html");
        return (index.is_file()).then_some(index);
    }
    let candidate = Path::new(relative);
    if candidate.is_absolute() {
        return None;
    }
    for component in candidate.components() {
        match component {
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => return None,
            Component::CurDir | Component::Normal(_) => {}
        }
    }
    let resolved = version_dir.join(candidate);
    if !resolved.starts_with(&version_dir) {
        return None;
    }
    if !resolved.is_file() {
        return None;
    }
    // Symlink escape guard: canonicalize the file and require it to stay
    // inside the version dir.
    if let Ok(canonical) = resolved.canonicalize() {
        if !canonical.starts_with(&version_dir) {
            return None;
        }
    }
    Some(resolved)
}

// ─────────────────────────────── smoke check ───────────────────────────────

/// UI-specific smoke check (replaces the kernel's `dashboard --help` probe):
/// `index.html` must parse as UTF-8 and reference at least one file that
/// actually exists under `assets/` (Vite content-hashed output). A package
/// that fails this is discarded and the current UI stays active.
fn ui_smoke_check(dist_dir: &Path) -> Result<(), String> {
    let index_path = dist_dir.join("index.html");
    let content = fs::read_to_string(&index_path).map_err(|e| {
        format!(
            "UI smoke check failed: index.html is not readable UTF-8 ({}): {}",
            index_path.display(),
            e
        )
    })?;
    let assets_root = dist_dir.join("assets");
    if !assets_root.is_dir() {
        return Err(format!(
            "UI smoke check failed: assets/ directory missing at {}",
            assets_root.display()
        ));
    }
    let mut found = false;
    let mut rest: &str = content.as_str();
    while let Some(pos) = rest.find("assets/") {
        let tail = &rest[pos + "assets/".len()..];
        let name: String = tail
            .chars()
            .take_while(|c| {
                !matches!(
                    c,
                    '"' | '\'' | ' ' | '<' | '>' | '(' | ')' | '`' | '\n' | '\r' | '\t'
                )
            })
            .collect();
        if !name.is_empty() && assets_root.join(&name).is_file() {
            found = true;
            break;
        }
        rest = tail;
    }
    if !found {
        return Err(
            "UI smoke check failed: index.html references no existing assets/ file".to_string(),
        );
    }
    Ok(())
}

// ─────────────────────────────── check / install ───────────────────────────

/// Fetch + verify the UI update manifest and report whether a newer UI package
/// is available.
pub async fn check_ui_update() -> UiUpdateCheckResult {
    let url = match ui_manifest_url() {
        Some(u) => u,
        None => {
            return UiUpdateCheckResult {
                ok: false,
                update_available: false,
                current_ui_version: None,
                manifest: None,
                error: Some("UI update manifest URL is not configured".to_string()),
            };
        }
    };

    match UI_HTTP_CLIENT
        .get(&url)
        .timeout(UI_MANIFEST_HTTP_TIMEOUT)
        .send()
        .await
    {
        Ok(res) if res.status().is_success() => match res.json::<UiUpdateManifest>().await {
            Ok(manifest) => {
                if manifest.schema_version != UI_SCHEMA_VERSION {
                    return err_check(format!(
                        "UI manifest schemaVersion is {}, expected {}",
                        manifest.schema_version, UI_SCHEMA_VERSION
                    ));
                }
                if manifest.platform != runtime::current_platform()
                    || manifest.arch != runtime::current_arch()
                {
                    return err_check(format!(
                        "UI manifest is for {}-{}, not {}-{}",
                        manifest.platform,
                        manifest.arch,
                        runtime::current_platform(),
                        runtime::current_arch()
                    ));
                }
                if let Err(e) = verify_ui_signature(&manifest) {
                    return err_check(format!("UI manifest signature verification failed: {e}"));
                }
                if !desktop_ge(&manifest.app_version_floor) {
                    return err_check(format!(
                        "UI package requires desktop >= {}, current {}",
                        manifest.app_version_floor,
                        env!("CARGO_PKG_VERSION")
                    ));
                }
                let current = ui_current_record();
                let update_available = current
                    .as_ref()
                    .map(|c| c.ui_version != manifest.ui_version)
                    .unwrap_or(true);
                UiUpdateCheckResult {
                    ok: true,
                    update_available,
                    current_ui_version: current.map(|c| c.ui_version),
                    manifest: Some(manifest),
                    error: None,
                }
            }
            Err(e) => err_check(format!("Failed to parse UI manifest: {e}")),
        },
        Ok(res) => err_check(format!("UI manifest HTTP {}", res.status())),
        Err(e) => err_check(e.to_string()),
    }
}

fn err_check(error: String) -> UiUpdateCheckResult {
    UiUpdateCheckResult {
        ok: false,
        update_available: false,
        current_ui_version: None,
        manifest: None,
        error: Some(error),
    }
}

/// Download → verify → extract → smoke-check → atomically activate a UI
/// update. Never touches the kernel runtime; on success the command layer
/// reloads the webview.
pub async fn install_ui_update() -> UiInstallUpdateResult {
    let check = check_ui_update().await;
    let manifest = match check.manifest {
        Some(m) => m,
        None => {
            return UiInstallUpdateResult {
                ok: false,
                installed: None,
                previous: None,
                error: Some(
                    check
                        .error
                        .unwrap_or_else(|| "No UI manifest available".to_string()),
                ),
            };
        }
    };

    // Defensive re-verify (check already verified; the manifest is the only
    // trust anchor we pass between the two calls).
    if let Err(e) = verify_ui_signature(&manifest) {
        return err_install(e);
    }
    let version_segment = match runtime::safe_version_segment(&manifest.ui_version) {
        Ok(segment) => segment,
        Err(e) => return err_install(e),
    };
    if !desktop_ge(&manifest.app_version_floor) {
        return err_install(format!(
            "UI package requires desktop >= {}, current {}",
            manifest.app_version_floor,
            env!("CARGO_PKG_VERSION")
        ));
    }

    // artifactUrl must be https (force-https, mirrors runtime.rs). Unit tests
    // exercise the full flow against a wiremock HTTP server, and the
    // dummy-server integration test / manual dev flow against a local server,
    // so allow an explicit http artifact ONLY when the caller opts in via env
    // AND the build is a test or debug (dev) build — release builds always
    // force https.
    let artifact_scheme = match url::Url::parse(&manifest.artifact_url) {
        Ok(url) => url.scheme().to_string(),
        Err(e) => return err_install(format!("Invalid artifact_url: {e}")),
    };
    let allow_http_artifact = artifact_scheme == "http"
        && (cfg!(test) || cfg!(debug_assertions))
        && std::env::var("HERMES_UI_UPDATE_ALLOW_HTTP_ARTIFACT").is_ok();
    if artifact_scheme != "https" && !allow_http_artifact {
        return err_install(format!("artifact_url must be https, got {artifact_scheme}"));
    }

    // Download the zip.
    let artifact = match UI_HTTP_CLIENT
        .get(&manifest.artifact_url)
        .timeout(UI_ARTIFACT_HTTP_TIMEOUT)
        .send()
        .await
    {
        Ok(res) if res.status().is_success() => match res.bytes().await {
            Ok(b) => b.to_vec(),
            Err(e) => return err_install(format!("Download failed: {e}")),
        },
        Ok(res) => return err_install(format!("Download HTTP {}", res.status())),
        Err(e) => return err_install(format!("Download failed: {e}")),
    };

    // Cache the zip under ui/downloads/<uiVersion>.zip and check sha256.
    let downloads = match ensure_ui_subdir(&ui_downloads_root(), "downloads") {
        Ok(d) => d,
        Err(e) => return err_install(e),
    };
    let zip_path = downloads.join(format!("{version_segment}.zip"));
    if let Err(e) = fs::write(&zip_path, &artifact) {
        return err_install(format!("Failed to write zip: {e}"));
    }
    let digest = match runtime::file_sha256(&zip_path) {
        Some(d) => d,
        None => return err_install(format!("UI artifact not readable: {}", zip_path.display())),
    };
    if digest != manifest.sha256.to_lowercase() {
        return err_install(format!(
            "SHA-256 mismatch: expected {}, got {}",
            manifest.sha256, digest
        ));
    }

    // Extract into a staging dir inside ui/versions (not system temp — keep
    // the same tree discipline as the runtime installer).
    let versions = match ensure_ui_subdir(&ui_versions_root(), "versions") {
        Ok(v) => v,
        Err(e) => return err_install(e),
    };
    let staging = match tempfile::Builder::new()
        .prefix(UI_STAGING_PREFIX)
        .tempdir_in(&versions)
    {
        Ok(dir) => dir,
        Err(e) => {
            return err_install(format!(
                "Failed to create UI staging dir in {}: {}",
                versions.display(),
                e
            ));
        }
    };
    if let Err(e) = runtime::extract_zip(&zip_path, staging.path()) {
        return err_install(format!("Failed to extract UI zip: {e}"));
    }

    // UI smoke check: UTF-8 index.html + a real assets/ reference.
    if let Err(e) = ui_smoke_check(staging.path()) {
        return err_install(e);
    }

    // Atomic activation: rename staging → versions/<v>/ with a cross-device
    // copy fallback, then archive the manifest and rewrite current.json.
    let target = versions.join(&version_segment);
    if let Err(e) = remove_existing_ui_target(&target) {
        return err_install(e);
    }
    if let Err(e) = fs::rename(staging.path(), &target) {
        if let Err(e2) = runtime::copy_dir_all(staging.path(), &target) {
            return err_install(format!("Failed to install UI: rename={e}, copy={e2}"));
        }
    }

    let previous = ui_current_record();
    let installed = UiInstallRecord {
        schema_version: UI_SCHEMA_VERSION,
        ui_version: manifest.ui_version.clone(),
        app_version_floor: manifest.app_version_floor.clone(),
        channel: manifest.channel.clone(),
        path: target.to_string_lossy().to_string(),
        sha256: manifest.sha256.clone(),
        source: "update".to_string(),
        installed_at: utc_now_rfc3339(),
        previous_ui_version: previous.as_ref().map(|p| p.ui_version.clone()),
    };

    let _ = write_json_file(&target.join(UI_MANIFEST_FILE), &manifest);
    let _ = write_json_file(&ui_current_record_path(), &installed);

    UiInstallUpdateResult {
        ok: true,
        installed: Some(installed),
        previous,
        error: None,
    }
}

/// Single-step rollback: repoint `current.json` at the previous on-disk
/// version (no network). Mirrors `rollback_runtime`.
pub fn rollback_ui_update() -> UiInstallUpdateResult {
    let current = match ui_current_record() {
        Some(c) => c,
        None => {
            return UiInstallUpdateResult {
                ok: false,
                installed: None,
                previous: None,
                error: Some("No current UI record".to_string()),
            };
        }
    };
    let prev_ui_version = match &current.previous_ui_version {
        Some(v) => v.clone(),
        None => {
            return UiInstallUpdateResult {
                ok: false,
                installed: None,
                previous: Some(current),
                error: Some("No previous UI version recorded".to_string()),
            };
        }
    };
    let prev_segment = match runtime::safe_version_segment(&prev_ui_version) {
        Ok(segment) => segment,
        Err(error) => {
            return UiInstallUpdateResult {
                ok: false,
                installed: None,
                previous: Some(current),
                error: Some(format!("Invalid previous UI version: {error}")),
            };
        }
    };
    let versions = ui_versions_root();
    if !versions.is_dir() {
        return UiInstallUpdateResult {
            ok: false,
            installed: None,
            previous: Some(current),
            error: Some("UI versions directory missing on disk".to_string()),
        };
    }
    let prev_dir = versions.join(&prev_segment);
    if !prev_dir.join("index.html").is_file() {
        return UiInstallUpdateResult {
            ok: false,
            installed: None,
            previous: Some(current),
            error: Some(format!(
                "Previous UI version not found on disk: {}",
                prev_dir.display()
            )),
        };
    }
    let prev_manifest: Option<UiUpdateManifest> = read_json_file(&prev_dir.join(UI_MANIFEST_FILE));
    let installed = UiInstallRecord {
        schema_version: UI_SCHEMA_VERSION,
        ui_version: prev_ui_version,
        app_version_floor: prev_manifest
            .as_ref()
            .map(|m| m.app_version_floor.clone())
            .unwrap_or_else(|| current.app_version_floor.clone()),
        channel: prev_manifest
            .as_ref()
            .map(|m| m.channel.clone())
            .unwrap_or_else(|| current.channel.clone()),
        path: prev_dir.to_string_lossy().to_string(),
        sha256: prev_manifest
            .as_ref()
            .map(|m| m.sha256.clone())
            .unwrap_or_else(|| current.sha256.clone()),
        source: "update".to_string(),
        installed_at: utc_now_rfc3339(),
        previous_ui_version: Some(current.ui_version.clone()),
    };
    let _ = write_json_file(&ui_current_record_path(), &installed);
    UiInstallUpdateResult {
        ok: true,
        installed: Some(installed),
        previous: Some(current),
        error: None,
    }
}

fn err_install(error: String) -> UiInstallUpdateResult {
    UiInstallUpdateResult {
        ok: false,
        installed: None,
        previous: None,
        error: Some(error),
    }
}

// ─────────────────────────── time formatting ───────────────────────────────

/// RFC 3339 UTC timestamp (`YYYY-MM-DDTHH:MM:SSZ`) without chrono, mirroring
/// runtime.rs's formatter so records stay parseable.
fn utc_now_rfc3339() -> String {
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

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;
    use ed25519_dalek::pkcs8::EncodePublicKey;
    use ed25519_dalek::{Signer, SigningKey};
    use pretty_assertions::assert_eq;
    use serial_test::serial;
    use sha2::{Digest, Sha256};
    use std::io::Write;
    use tempfile::TempDir;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    /// Recompute the sha256 hex of bytes (used to stamp test manifests).
    fn sha256_hex(data: &[u8]) -> String {
        let mut hasher = Sha256::new();
        hasher.update(data);
        format!("{:x}", hasher.finalize())
    }

    // ── test fixtures ────────────────────────────────────────────────────────

    fn test_keypair() -> (SigningKey, String) {
        let signing_key = SigningKey::from_bytes(&[9u8; 32]);
        let pem = signing_key
            .verifying_key()
            .to_public_key_pem(ed25519_dalek::pkcs8::spki::der::pem::LineEnding::LF)
            .unwrap();
        (signing_key, pem)
    }

    fn fixture_manifest() -> UiUpdateManifest {
        UiUpdateManifest {
            schema_version: UI_SCHEMA_VERSION,
            channel: "stable".to_string(),
            ui_version: "1.2.3".to_string(),
            app_version_floor: "0.1.0".to_string(),
            platform: runtime::current_platform().to_string(),
            arch: runtime::current_arch().to_string(),
            artifact_url: "https://example.com/ui.zip".to_string(),
            sha256: "deadbeef".to_string(),
            signature: String::new(),
            source_repo: "owner/repo".to_string(),
            source_commit: "abc123".to_string(),
        }
    }

    fn sign_ui_manifest(key: &SigningKey, manifest: &mut UiUpdateManifest) {
        let payload = ui_signature_payload(manifest);
        let sig = key.sign(&payload);
        manifest.signature = base64::engine::general_purpose::STANDARD.encode(sig.to_bytes());
    }

    /// Build a minimal web-dist zip: index.html referencing an assets/ file.
    fn make_ui_zip(dir: &Path, ui_version: &str) -> Vec<u8> {
        let zip_path = dir.join(format!("ui-{ui_version}.zip"));
        let file = std::fs::File::create(&zip_path).unwrap();
        let mut writer = zip::ZipWriter::new(file);
        let options: zip::write::SimpleFileOptions = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);

        writer.start_file("index.html", options).unwrap();
        writer
            .write_all(b"<!doctype html><html><head></head><body><script src=\"/assets/app-abc123.js\"></script></body></html>")
            .unwrap();
        writer.start_file("assets/app-abc123.js", options).unwrap();
        writer.write_all(b"console.log('ui')").unwrap();
        writer.finish().unwrap();
        std::fs::read(&zip_path).unwrap()
    }

    /// Point the UI manifest URL env at `url` for the duration of the test.
    /// Restores previous env state on drop so `#[serial]` tests stay isolated.
    struct UiManifestUrlEnv(String);

    impl UiManifestUrlEnv {
        fn set(url: &str) -> Self {
            let prev = std::env::var("HERMES_UI_UPDATE_MANIFEST_URL").unwrap_or_default();
            std::env::set_var("HERMES_UI_UPDATE_MANIFEST_URL", url);
            UiManifestUrlEnv(prev)
        }
    }

    impl Drop for UiManifestUrlEnv {
        fn drop(&mut self) {
            if self.0.is_empty() {
                std::env::remove_var("HERMES_UI_UPDATE_MANIFEST_URL");
            } else {
                std::env::set_var("HERMES_UI_UPDATE_MANIFEST_URL", &self.0);
            }
        }
    }

    // ── signature payload order lock ─────────────────────────────────────────

    #[test]
    fn ui_signature_payload_has_stable_field_order() {
        let manifest = fixture_manifest();
        let payload = String::from_utf8(ui_signature_payload(&manifest)).unwrap();
        let lines: Vec<&str> = payload.split('\n').collect();
        assert_eq!(
            lines,
            vec![
                "1",                          // schema_version
                "stable",                     // channel
                "1.2.3",                      // ui_version
                "0.1.0",                      // app_version_floor
                runtime::current_platform(),  // platform
                runtime::current_arch(),      // arch
                "https://example.com/ui.zip", // artifact_url
                "deadbeef",                   // sha256
                "owner/repo",                 // source_repo
                "abc123",                     // source_commit
            ]
        );
    }

    #[test]
    fn ui_signature_payload_differs_when_any_field_changes() {
        let baseline = ui_signature_payload(&fixture_manifest());
        let mut m = fixture_manifest();
        m.sha256 = "tampered".to_string();
        assert_ne!(ui_signature_payload(&m), baseline);
        let mut m2 = fixture_manifest();
        m2.artifact_url = "https://attacker.com/x.zip".to_string();
        assert_ne!(ui_signature_payload(&m2), baseline);
        let mut m3 = fixture_manifest();
        m3.app_version_floor = "9.9.9".to_string();
        assert_ne!(ui_signature_payload(&m3), baseline);
    }

    // ── signature verification ───────────────────────────────────────────────

    #[test]
    fn verify_ui_signature_accepts_valid_signature() {
        let (key, pem) = test_keypair();
        let mut manifest = fixture_manifest();
        sign_ui_manifest(&key, &mut manifest);
        let result = runtime::verify_payload_signature(
            &ui_signature_payload(&manifest),
            &manifest.signature,
            &pem,
        );
        assert!(result.is_ok());
    }

    #[test]
    fn verify_ui_signature_rejects_tampered_floor() {
        let (key, pem) = test_keypair();
        let mut manifest = fixture_manifest();
        sign_ui_manifest(&key, &mut manifest);
        manifest.app_version_floor = "0.0.1".to_string();
        let result = runtime::verify_payload_signature(
            &ui_signature_payload(&manifest),
            &manifest.signature,
            &pem,
        );
        assert!(result.is_err());
    }

    #[test]
    fn verify_ui_signature_rejects_kernel_payload() {
        // A signature produced over the kernel's 12-field payload must NOT
        // verify against the 10-field UI payload — the two tracks are sealed.
        let (key, pem) = test_keypair();
        let mut manifest = fixture_manifest();
        let kernel_payload = format!(
            "{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}",
            manifest.schema_version,
            manifest.channel,
            manifest.ui_version,
            "1.2.3", // kernel_version stand-in
            "cn",
            "1",
            manifest.platform,
            manifest.arch,
            manifest.artifact_url,
            manifest.sha256,
            manifest.source_repo,
            manifest.source_commit,
        );
        let sig = key.sign(kernel_payload.as_bytes());
        manifest.signature = base64::engine::general_purpose::STANDARD.encode(sig.to_bytes());
        let result = runtime::verify_payload_signature(
            &ui_signature_payload(&manifest),
            &manifest.signature,
            &pem,
        );
        assert!(result.is_err());
    }

    // ── appVersionFloor gate ─────────────────────────────────────────────────

    #[test]
    fn floor_gate_accepts_packages_below_or_equal_desktop() {
        // Floors at/below the current package version are servable.
        assert!(desktop_ge("0.0.1"));
        assert!(desktop_ge("")); // no floor declared → any shell
    }

    #[test]
    fn floor_gate_rejects_packages_above_desktop() {
        assert!(!desktop_ge("99.0.0"));
        // Use a floor clearly above the current package version.
        assert!(!desktop_ge("999.0.0"));
    }

    #[test]
    fn floor_gate_fails_closed_on_unparsable_floor() {
        assert!(!desktop_ge("not-a-version"));
    }

    #[test]
    #[serial]
    fn ui_serving_version_dir_respects_floor_gate() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        let old_root = std::env::var("HERMES_DESKTOP_RUNTIME_ROOT").unwrap_or_default();
        std::env::set_var("HERMES_DESKTOP_RUNTIME_ROOT", root);

        let versions = ui_versions_root();
        let dir = versions.join("0.5.0");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("index.html"), b"<html></html>").unwrap();

        // Floor above the shell → not eligible.
        let record = UiInstallRecord {
            schema_version: UI_SCHEMA_VERSION,
            ui_version: "0.5.0".to_string(),
            app_version_floor: "99.0.0".to_string(),
            channel: "stable".to_string(),
            path: dir.to_string_lossy().to_string(),
            sha256: "x".to_string(),
            source: "update".to_string(),
            installed_at: utc_now_rfc3339(),
            previous_ui_version: None,
        };
        write_json_file(&ui_current_record_path(), &record).unwrap();
        assert!(ui_serving_version_dir().is_none());

        // Floor satisfied → eligible.
        let mut ok_record = record;
        ok_record.app_version_floor = "0.1.0".to_string();
        write_json_file(&ui_current_record_path(), &ok_record).unwrap();
        assert_eq!(ui_serving_version_dir(), Some(dir));

        if old_root.is_empty() {
            std::env::remove_var("HERMES_DESKTOP_RUNTIME_ROOT");
        } else {
            std::env::set_var("HERMES_DESKTOP_RUNTIME_ROOT", old_root);
        }
    }

    // ── smoke check ──────────────────────────────────────────────────────────

    #[test]
    fn smoke_check_accepts_valid_index_html_with_assets() {
        let tmp = TempDir::new().unwrap();
        let dist = tmp.path().join("dist");
        std::fs::create_dir_all(dist.join("assets")).unwrap();
        std::fs::write(
            dist.join("index.html"),
            "<html><script src=\"/assets/app-abc123.js\"></script></html>",
        )
        .unwrap();
        std::fs::write(dist.join("assets").join("app-abc123.js"), b"x").unwrap();
        ui_smoke_check(&dist).expect("valid dist should pass");
    }

    #[test]
    fn smoke_check_rejects_missing_index_html() {
        let tmp = TempDir::new().unwrap();
        let dist = tmp.path().join("dist");
        std::fs::create_dir_all(dist.join("assets")).unwrap();
        let err = ui_smoke_check(&dist).unwrap_err();
        assert!(err.contains("index.html"));
    }

    #[test]
    fn smoke_check_rejects_index_html_without_real_asset() {
        let tmp = TempDir::new().unwrap();
        let dist = tmp.path().join("dist");
        std::fs::create_dir_all(dist.join("assets")).unwrap();
        // References an asset that does not exist on disk.
        std::fs::write(
            dist.join("index.html"),
            "<html><script src=\"/assets/missing.js\"></script></html>",
        )
        .unwrap();
        let err = ui_smoke_check(&dist).unwrap_err();
        assert!(err.contains("no existing assets/ file"));
    }

    #[test]
    fn smoke_check_rejects_missing_assets_dir() {
        let tmp = TempDir::new().unwrap();
        let dist = tmp.path().join("dist");
        std::fs::create_dir_all(&dist).unwrap();
        std::fs::write(
            dist.join("index.html"),
            "<html><script src=\"/assets/missing.js\"></script></html>",
        )
        .unwrap();
        let err = ui_smoke_check(&dist).unwrap_err();
        assert!(err.contains("assets/ directory missing"));
    }

    // ── resolve_ui_asset path-traversal guard ────────────────────────────────

    #[test]
    fn resolve_ui_asset_serves_index_and_nested_files() {
        let tmp = TempDir::new().unwrap();
        let version_dir = tmp.path().join("0.5.0");
        std::fs::create_dir_all(version_dir.join("assets")).unwrap();
        std::fs::write(version_dir.join("index.html"), b"<html>").unwrap();
        std::fs::write(version_dir.join("assets").join("app.js"), b"x").unwrap();

        // resolve_ui_asset canonicalizes the version dir; canonicalize the
        // expected paths too (Windows prefixes `\\?\` on canonical forms).
        let canonical = version_dir.canonicalize().unwrap();
        assert_eq!(
            resolve_ui_asset(&version_dir, ""),
            Some(canonical.join("index.html"))
        );
        assert_eq!(
            resolve_ui_asset(&version_dir, "/"),
            Some(canonical.join("index.html"))
        );
        assert_eq!(
            resolve_ui_asset(&version_dir, "/index.html"),
            Some(canonical.join("index.html"))
        );
        assert_eq!(
            resolve_ui_asset(&version_dir, "/assets/app.js"),
            Some(canonical.join("assets").join("app.js"))
        );
    }

    #[test]
    fn resolve_ui_asset_rejects_traversal() {
        let tmp = TempDir::new().unwrap();
        let version_dir = tmp.path().join("0.5.0");
        std::fs::create_dir_all(&version_dir).unwrap();
        std::fs::write(version_dir.join("index.html"), b"<html>").unwrap();

        assert_eq!(resolve_ui_asset(&version_dir, "/../secret.txt"), None);
        assert_eq!(resolve_ui_asset(&version_dir, ".."), None);
        assert_eq!(resolve_ui_asset(&version_dir, "/../../etc/passwd"), None);
        assert_eq!(resolve_ui_asset(&version_dir, "/assets/../../../x"), None);
        assert_eq!(resolve_ui_asset(&version_dir, "C:\\Windows\\win.ini"), None);
        assert_eq!(resolve_ui_asset(&version_dir, "/nonexistent.js"), None);
    }

    #[test]
    fn resolve_ui_asset_rejects_symlink_escape() {
        let tmp = TempDir::new().unwrap();
        let version_dir = tmp.path().join("0.5.0");
        let outside = tmp.path().join("outside");
        std::fs::create_dir_all(&version_dir).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(version_dir.join("index.html"), b"<html>").unwrap();
        std::fs::write(outside.join("secret.txt"), b"s").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(outside.join("secret.txt"), version_dir.join("leak.txt"))
            .unwrap();
        // The symlink itself resolves outside the version dir → refused.
        assert_eq!(resolve_ui_asset(&version_dir, "/leak.txt"), None);
    }

    // ── manifest URL cascade ─────────────────────────────────────────────────

    #[test]
    #[serial]
    fn ui_manifest_url_prefers_explicit_env() {
        let old_manifest = std::env::var("HERMES_UI_UPDATE_MANIFEST_URL").unwrap_or_default();
        let old_base = std::env::var("HERMES_UI_UPDATE_BASE_URL").unwrap_or_default();
        let old_channel = std::env::var("HERMES_UI_UPDATE_CHANNEL").unwrap_or_default();
        std::env::set_var(
            "HERMES_UI_UPDATE_MANIFEST_URL",
            "https://example.test/custom.json",
        );
        std::env::set_var("HERMES_UI_UPDATE_BASE_URL", "https://example.test/base");
        std::env::set_var("HERMES_UI_UPDATE_CHANNEL", "beta");
        assert_eq!(
            ui_manifest_url().as_deref(),
            Some("https://example.test/custom.json")
        );
        restore_env("HERMES_UI_UPDATE_MANIFEST_URL", &old_manifest);
        restore_env("HERMES_UI_UPDATE_BASE_URL", &old_base);
        restore_env("HERMES_UI_UPDATE_CHANNEL", &old_channel);
    }

    #[test]
    #[serial]
    fn ui_manifest_url_constructs_from_base_and_channel() {
        let old_manifest = std::env::var("HERMES_UI_UPDATE_MANIFEST_URL").unwrap_or_default();
        let old_base = std::env::var("HERMES_UI_UPDATE_BASE_URL").unwrap_or_default();
        let old_channel = std::env::var("HERMES_UI_UPDATE_CHANNEL").unwrap_or_default();
        std::env::remove_var("HERMES_UI_UPDATE_MANIFEST_URL");
        std::env::set_var("HERMES_UI_UPDATE_BASE_URL", "https://example.test/runtime/");
        std::env::set_var("HERMES_UI_UPDATE_CHANNEL", "canary");
        let expected = format!(
            "https://example.test/runtime/canary-{}-{}.json",
            runtime::current_platform(),
            runtime::current_arch()
        );
        assert_eq!(ui_manifest_url().as_deref(), Some(expected.as_str()));
        restore_env("HERMES_UI_UPDATE_MANIFEST_URL", &old_manifest);
        restore_env("HERMES_UI_UPDATE_BASE_URL", &old_base);
        restore_env("HERMES_UI_UPDATE_CHANNEL", &old_channel);
    }

    #[test]
    #[serial]
    fn ui_manifest_url_falls_back_to_hardcoded() {
        let old_manifest = std::env::var("HERMES_UI_UPDATE_MANIFEST_URL").unwrap_or_default();
        let old_base = std::env::var("HERMES_UI_UPDATE_BASE_URL").unwrap_or_default();
        let old_channel = std::env::var("HERMES_UI_UPDATE_CHANNEL").unwrap_or_default();
        std::env::remove_var("HERMES_UI_UPDATE_MANIFEST_URL");
        std::env::remove_var("HERMES_UI_UPDATE_BASE_URL");
        std::env::remove_var("HERMES_UI_UPDATE_CHANNEL");
        let expected = format!(
            "{}/stable-{}-{}.json",
            UI_FALLBACK_MANIFEST_BASE_URL,
            runtime::current_platform(),
            runtime::current_arch()
        );
        assert_eq!(ui_manifest_url().as_deref(), Some(expected.as_str()));
        restore_env("HERMES_UI_UPDATE_MANIFEST_URL", &old_manifest);
        restore_env("HERMES_UI_UPDATE_BASE_URL", &old_base);
        restore_env("HERMES_UI_UPDATE_CHANNEL", &old_channel);
    }

    fn restore_env(key: &str, prev: &str) {
        if prev.is_empty() {
            std::env::remove_var(key);
        } else {
            std::env::set_var(key, prev);
        }
    }

    // ── full install flow (wiremock) ─────────────────────────────────────────

    #[tokio::test]
    #[serial]
    async fn install_ui_update_downloads_verifies_and_activates() {
        let tmp = TempDir::new().unwrap();
        let old_root = std::env::var("HERMES_DESKTOP_RUNTIME_ROOT").unwrap_or_default();
        let old_key = std::env::var("HERMES_RUNTIME_UPDATE_PUBLIC_KEY_PEM").unwrap_or_default();
        let old_http = std::env::var("HERMES_UI_UPDATE_ALLOW_HTTP_ARTIFACT").unwrap_or_default();
        std::env::set_var("HERMES_DESKTOP_RUNTIME_ROOT", tmp.path());
        std::env::remove_var("HERMES_RUNTIME_UPDATE_PUBLIC_KEY_PEM");
        std::env::set_var("HERMES_UI_UPDATE_ALLOW_HTTP_ARTIFACT", "1");

        let (key, pem) = test_keypair();
        std::env::set_var("HERMES_RUNTIME_UPDATE_PUBLIC_KEY_PEM", &pem);

        let zip_bytes = make_ui_zip(tmp.path(), "2.0.0");
        let mut manifest = fixture_manifest();
        manifest.ui_version = "2.0.0".to_string();
        manifest.app_version_floor = "0.1.0".to_string();
        manifest.sha256 = sha256_hex(&zip_bytes);

        let server = MockServer::start().await;
        let zip_url = format!("{}/artifacts/ui-2.0.0.zip", server.uri());
        manifest.artifact_url = zip_url.clone();
        sign_ui_manifest(&key, &mut manifest);

        Mock::given(method("GET"))
            .and(path("/artifacts/ui-2.0.0.zip"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(zip_bytes.clone()))
            .mount(&server)
            .await;
        let manifest_json = serde_json::to_vec(&manifest).unwrap();
        Mock::given(method("GET"))
            .and(path("/ui/stable.json"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(manifest_json.clone()))
            .mount(&server)
            .await;

        let _env = UiManifestUrlEnv::set(&format!("{}/ui/stable.json", server.uri()));

        let result = install_ui_update().await;
        assert!(result.ok, "install failed: {:?}", result.error);
        let installed = result.installed.expect("installed record");
        assert_eq!(installed.ui_version, "2.0.0");
        assert_eq!(installed.previous_ui_version, None);
        assert_eq!(installed.source, "update");

        // current.json + archived manifest.json on disk.
        let current = ui_current_record().expect("current record readable");
        assert_eq!(current.ui_version, "2.0.0");
        let target_dir = ui_versions_root().join("2.0.0");
        assert!(target_dir.join("index.html").is_file());
        assert!(target_dir.join("assets").join("app-abc123.js").is_file());
        assert!(target_dir.join("manifest.json").is_file());

        // Second install of the same version records the previous version.
        let result2 = install_ui_update().await;
        assert!(result2.ok, "second install failed: {:?}", result2.error);
        let installed2 = result2.installed.expect("installed record 2");
        assert_eq!(installed2.previous_ui_version.as_deref(), Some("2.0.0"));

        restore_env("HERMES_DESKTOP_RUNTIME_ROOT", &old_root);
        restore_env("HERMES_RUNTIME_UPDATE_PUBLIC_KEY_PEM", &old_key);
        restore_env("HERMES_UI_UPDATE_ALLOW_HTTP_ARTIFACT", &old_http);
    }

    #[tokio::test]
    #[serial]
    async fn install_ui_update_rejects_sha256_mismatch() {
        let tmp = TempDir::new().unwrap();
        let old_root = std::env::var("HERMES_DESKTOP_RUNTIME_ROOT").unwrap_or_default();
        let old_key = std::env::var("HERMES_RUNTIME_UPDATE_PUBLIC_KEY_PEM").unwrap_or_default();
        let old_http = std::env::var("HERMES_UI_UPDATE_ALLOW_HTTP_ARTIFACT").unwrap_or_default();
        std::env::set_var("HERMES_DESKTOP_RUNTIME_ROOT", tmp.path());
        std::env::remove_var("HERMES_RUNTIME_UPDATE_PUBLIC_KEY_PEM");
        std::env::set_var("HERMES_UI_UPDATE_ALLOW_HTTP_ARTIFACT", "1");

        let (key, pem) = test_keypair();
        std::env::set_var("HERMES_RUNTIME_UPDATE_PUBLIC_KEY_PEM", &pem);

        let zip_bytes = make_ui_zip(tmp.path(), "2.0.1");
        let mut manifest = fixture_manifest();
        manifest.ui_version = "2.0.1".to_string();
        manifest.sha256 = "00deadbeef00".to_string(); // wrong on purpose

        let server = MockServer::start().await;
        let zip_url = format!("{}/artifacts/ui-2.0.1.zip", server.uri());
        manifest.artifact_url = zip_url.clone();
        sign_ui_manifest(&key, &mut manifest);

        Mock::given(method("GET"))
            .and(path("/artifacts/ui-2.0.1.zip"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(zip_bytes.clone()))
            .mount(&server)
            .await;
        let manifest_json = serde_json::to_vec(&manifest).unwrap();
        Mock::given(method("GET"))
            .and(path("/ui/stable.json"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(manifest_json.clone()))
            .mount(&server)
            .await;

        let _env = UiManifestUrlEnv::set(&format!("{}/ui/stable.json", server.uri()));

        let result = install_ui_update().await;
        assert!(!result.ok);
        assert!(result.error.unwrap().contains("SHA-256 mismatch"));
        assert!(ui_current_record().is_none());

        restore_env("HERMES_DESKTOP_RUNTIME_ROOT", &old_root);
        restore_env("HERMES_RUNTIME_UPDATE_PUBLIC_KEY_PEM", &old_key);
        restore_env("HERMES_UI_UPDATE_ALLOW_HTTP_ARTIFACT", &old_http);
    }

    // ── rollback ─────────────────────────────────────────────────────────────

    #[test]
    #[serial]
    fn rollback_ui_update_single_step_to_previous() {
        let tmp = TempDir::new().unwrap();
        let old_root = std::env::var("HERMES_DESKTOP_RUNTIME_ROOT").unwrap_or_default();
        std::env::set_var("HERMES_DESKTOP_RUNTIME_ROOT", tmp.path());

        let versions = ui_versions_root();
        let v1 = versions.join("1.0.0");
        let v2 = versions.join("2.0.0");
        std::fs::create_dir_all(v1.join("assets")).unwrap();
        std::fs::create_dir_all(v2.join("assets")).unwrap();
        std::fs::write(v1.join("index.html"), b"<html>v1").unwrap();
        std::fs::write(v2.join("index.html"), b"<html>v2").unwrap();

        let current = UiInstallRecord {
            schema_version: UI_SCHEMA_VERSION,
            ui_version: "2.0.0".to_string(),
            app_version_floor: "0.1.0".to_string(),
            channel: "stable".to_string(),
            path: v2.to_string_lossy().to_string(),
            sha256: "b".to_string(),
            source: "update".to_string(),
            installed_at: utc_now_rfc3339(),
            previous_ui_version: Some("1.0.0".to_string()),
        };
        write_json_file(&ui_current_record_path(), &current).unwrap();

        let result = rollback_ui_update();
        assert!(result.ok, "rollback failed: {:?}", result.error);
        let installed = result.installed.expect("installed");
        assert_eq!(installed.ui_version, "1.0.0");
        assert_eq!(installed.previous_ui_version.as_deref(), Some("2.0.0"));
        assert_eq!(
            ui_current_record().map(|r| r.ui_version).as_deref(),
            Some("1.0.0")
        );

        restore_env("HERMES_DESKTOP_RUNTIME_ROOT", &old_root);
    }

    #[test]
    #[serial]
    fn rollback_ui_update_fails_when_previous_missing_on_disk() {
        let tmp = TempDir::new().unwrap();
        let old_root = std::env::var("HERMES_DESKTOP_RUNTIME_ROOT").unwrap_or_default();
        std::env::set_var("HERMES_DESKTOP_RUNTIME_ROOT", tmp.path());

        let versions = ui_versions_root();
        let v2 = versions.join("2.0.0");
        std::fs::create_dir_all(v2.join("assets")).unwrap();
        std::fs::write(v2.join("index.html"), b"<html>v2").unwrap();

        let current = UiInstallRecord {
            schema_version: UI_SCHEMA_VERSION,
            ui_version: "2.0.0".to_string(),
            app_version_floor: "0.1.0".to_string(),
            channel: "stable".to_string(),
            path: v2.to_string_lossy().to_string(),
            sha256: "b".to_string(),
            source: "update".to_string(),
            installed_at: utc_now_rfc3339(),
            previous_ui_version: Some("1.0.0".to_string()),
        };
        write_json_file(&ui_current_record_path(), &current).unwrap();

        let result = rollback_ui_update();
        assert!(!result.ok);
        assert!(result.error.unwrap().contains("not found on disk"));

        restore_env("HERMES_DESKTOP_RUNTIME_ROOT", &old_root);
    }

    #[test]
    #[serial]
    fn rollback_ui_update_fails_without_previous_version() {
        let tmp = TempDir::new().unwrap();
        let old_root = std::env::var("HERMES_DESKTOP_RUNTIME_ROOT").unwrap_or_default();
        std::env::set_var("HERMES_DESKTOP_RUNTIME_ROOT", tmp.path());

        let versions = ui_versions_root();
        let v1 = versions.join("1.0.0");
        std::fs::create_dir_all(v1.join("assets")).unwrap();
        std::fs::write(v1.join("index.html"), b"<html>v1").unwrap();
        let current = UiInstallRecord {
            schema_version: UI_SCHEMA_VERSION,
            ui_version: "1.0.0".to_string(),
            app_version_floor: "0.1.0".to_string(),
            channel: "stable".to_string(),
            path: v1.to_string_lossy().to_string(),
            sha256: "a".to_string(),
            source: "update".to_string(),
            installed_at: utc_now_rfc3339(),
            previous_ui_version: None,
        };
        write_json_file(&ui_current_record_path(), &current).unwrap();

        let result = rollback_ui_update();
        assert!(!result.ok);
        assert!(result
            .error
            .unwrap()
            .contains("No previous UI version recorded"));

        restore_env("HERMES_DESKTOP_RUNTIME_ROOT", &old_root);
    }

    // ── misc ─────────────────────────────────────────────────────────────────

    #[test]
    fn utc_now_rfc3339_is_well_shaped() {
        let now = utc_now_rfc3339();
        assert_eq!(now.len(), 20);
        assert!(now.ends_with('Z'));
        assert_eq!(&now[4..5], "-");
        assert_eq!(&now[10..11], "T");
    }
}
