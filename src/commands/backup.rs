use std::collections::BTreeSet;
use std::fs;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::State;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use crate::commands::restart::{self, RespawnOutcome};
use crate::error::{AppError, AppResult};
use crate::state::AppState;

const BACKUP_SCHEMA_VERSION: u32 = 1;
const BACKUP_KIND: &str = "hermes-profile-backup";
const MAX_BACKUP_ZIP_FILES: usize = 50_000;
const MAX_BACKUP_TOTAL_BYTES: u64 = 2 * 1024 * 1024 * 1024; // 2 GiB
const MAX_BACKUP_MANIFEST_BYTES: u64 = 1024 * 1024;
#[allow(dead_code)]
const SECRET_FILES: &[&str] = &[".env", "auth.json", ".anthropic_oauth.json"];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum BackupEntryKind {
    File,
    Directory,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct BackupManifestEntry {
    path: String,
    kind: BackupEntryKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    size_bytes: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct BackupManifest {
    schema_version: u32,
    kind: String,
    source_profile_name: String,
    exported_at: u64,
    desktop_version: String,
    includes_secrets: bool,
    includes_sessions: bool,
    entries: Vec<BackupManifestEntry>,
}

#[derive(Debug, Clone)]
struct PlannedBackupEntry {
    source_path: PathBuf,
    zip_path: String,
    manifest_entry: BackupManifestEntry,
    #[cfg(unix)]
    mode: Option<u32>,
}

#[derive(Debug, Clone, Default)]
struct BackupArchiveStats {
    file_count: usize,
    total_bytes: u64,
    entries: Vec<BackupManifestEntry>,
    top_level_entries: Vec<String>,
    warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct BackupExportResult {
    pub ok: bool,
    pub canceled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hermes_home: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backup_path: Option<String>,
    pub file_count: usize,
    pub total_bytes: u64,
    pub warnings: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct BackupImportResult {
    pub ok: bool,
    pub canceled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_profile_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hermes_home: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backup_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_base_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gateway_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_token: Option<String>,
    pub imported_entries: Vec<String>,
    pub file_count: usize,
    pub total_bytes: u64,
    pub warnings: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recovered_previous_profile: Option<bool>,
}

fn unix_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn suggested_backup_file_name(profile: &str) -> String {
    format!(
        "hermes-backup-{}-{}.zip",
        sanitize_profile_name(profile),
        unix_timestamp()
    )
}

fn zip_error(err: zip::result::ZipError) -> AppError {
    AppError::FileError(err.to_string())
}

fn ensure_zip_extension(mut path: PathBuf) -> PathBuf {
    let is_zip = path
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("zip"));
    if !is_zip {
        path.set_extension("zip");
    }
    path
}

fn path_to_zip_rel(path: &Path) -> String {
    path.components()
        .filter_map(|component| match component {
            Component::Normal(part) => Some(part.to_string_lossy().replace('\\', "/")),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

fn same_path(a: &Path, b: &Path) -> bool {
    if a == b {
        return true;
    }
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

fn should_skip_profile_root_entry(profile: &str, name: &str) -> bool {
    name == ".backup-import-staging"
        || name == ".migration-staging"
        || (profile == "default" && matches!(name, "profiles" | "active_profile"))
}

fn should_skip_nested_entry(name: &str) -> bool {
    name == "__pycache__"
        || name.ends_with(".pyc")
        || name.ends_with(".pyo")
        || name.ends_with(".sock")
        || name.ends_with(".tmp")
}

#[cfg(unix)]
fn unix_mode(meta: &fs::Metadata) -> Option<u32> {
    use std::os::unix::fs::PermissionsExt;
    Some(meta.permissions().mode() & 0o777)
}

fn collect_backup_entries(
    root: &Path,
    current: &Path,
    profile: &str,
    backup_path: &Path,
    entries: &mut Vec<PlannedBackupEntry>,
    warnings: &mut Vec<String>,
) -> AppResult<()> {
    let mut children = fs::read_dir(current)?.collect::<Result<Vec<_>, _>>()?;
    children.sort_by_key(|entry| entry.file_name());

    for entry in children {
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        let path = entry.path();
        let at_root = same_path(current, root);

        if at_root && should_skip_profile_root_entry(profile, &name_str) {
            continue;
        }
        if should_skip_nested_entry(&name_str) {
            continue;
        }
        if same_path(&path, backup_path) {
            warnings.push(format!("已跳过备份输出文件自身：{}", path.display()));
            continue;
        }

        let meta = fs::symlink_metadata(&path)?;
        if meta.file_type().is_symlink() {
            warnings.push(format!("已跳过符号链接：{}", path.display()));
            continue;
        }

        let rel = path
            .strip_prefix(root)
            .map_err(|e| AppError::FileError(e.to_string()))?;
        let rel = path_to_zip_rel(rel);
        if rel.is_empty() {
            continue;
        }

        if meta.is_dir() {
            entries.push(PlannedBackupEntry {
                source_path: path.clone(),
                zip_path: format!("profile/{}/", rel),
                manifest_entry: BackupManifestEntry {
                    path: rel,
                    kind: BackupEntryKind::Directory,
                    size_bytes: None,
                },
                #[cfg(unix)]
                mode: unix_mode(&meta),
            });
            collect_backup_entries(root, &path, profile, backup_path, entries, warnings)?;
        } else if meta.is_file() {
            entries.push(PlannedBackupEntry {
                source_path: path,
                zip_path: format!("profile/{}", rel),
                manifest_entry: BackupManifestEntry {
                    path: rel,
                    kind: BackupEntryKind::File,
                    size_bytes: Some(meta.len()),
                },
                #[cfg(unix)]
                mode: unix_mode(&meta),
            });
        }
    }

    Ok(())
}

fn zip_options_for_entry(_entry: &PlannedBackupEntry) -> SimpleFileOptions {
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    #[cfg(unix)]
    {
        if let Some(mode) = _entry.mode {
            return options.unix_permissions(mode);
        }
    }
    options
}

fn export_profile_backup_to_path(
    home: &Path,
    profile: &str,
    backup_path: &Path,
) -> AppResult<BackupArchiveStats> {
    if !home.is_dir() {
        return Err(AppError::FileError(format!(
            "HERMES_HOME 不存在或不是目录：{}",
            home.display()
        )));
    }

    let mut planned = Vec::new();
    let mut warnings = Vec::new();
    collect_backup_entries(
        home,
        home,
        profile,
        backup_path,
        &mut planned,
        &mut warnings,
    )?;

    let entries = planned
        .iter()
        .map(|entry| entry.manifest_entry.clone())
        .collect();
    let stats = BackupArchiveStats {
        warnings,
        file_count: planned
            .iter()
            .filter(|entry| entry.manifest_entry.kind == BackupEntryKind::File)
            .count(),
        total_bytes: planned
            .iter()
            .filter_map(|entry| entry.manifest_entry.size_bytes)
            .fold(0u64, u64::saturating_add),
        entries,
        ..Default::default()
    };

    let manifest = BackupManifest {
        schema_version: BACKUP_SCHEMA_VERSION,
        kind: BACKUP_KIND.to_string(),
        source_profile_name: profile.to_string(),
        exported_at: unix_timestamp(),
        desktop_version: env!("CARGO_PKG_VERSION").to_string(),
        includes_secrets: true,
        includes_sessions: true,
        entries: stats.entries.clone(),
    };

    if let Some(parent) = backup_path.parent() {
        fs::create_dir_all(parent)?;
    }
    let file = fs::File::create(backup_path)?;
    let mut zip = ZipWriter::new(file);
    let manifest_options =
        SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    zip.start_file("manifest.json", manifest_options)
        .map_err(zip_error)?;
    let manifest_json =
        serde_json::to_vec_pretty(&manifest).map_err(|e| AppError::Internal(e.to_string()))?;
    zip.write_all(&manifest_json)?;

    for entry in &planned {
        let options = zip_options_for_entry(entry);
        match entry.manifest_entry.kind {
            BackupEntryKind::Directory => {
                zip.add_directory(&entry.zip_path, options)
                    .map_err(zip_error)?;
            }
            BackupEntryKind::File => {
                zip.start_file(&entry.zip_path, options)
                    .map_err(zip_error)?;
                let mut source = fs::File::open(&entry.source_path)?;
                std::io::copy(&mut source, &mut zip)?;
            }
        }
    }

    zip.finish().map_err(zip_error)?;
    Ok(stats)
}

fn read_manifest_from_archive<R: Read + std::io::Seek>(
    archive: &mut ZipArchive<R>,
) -> AppResult<BackupManifest> {
    let mut manifest_file = archive
        .by_name("manifest.json")
        .map_err(|_| AppError::InvalidRequest("备份包缺少 manifest.json".to_string()))?;
    if manifest_file.size() > MAX_BACKUP_MANIFEST_BYTES {
        return Err(AppError::InvalidRequest("备份包 manifest 过大".to_string()));
    }
    let mut manifest_json = String::new();
    manifest_file.read_to_string(&mut manifest_json)?;
    let manifest: BackupManifest = serde_json::from_str(&manifest_json)
        .map_err(|e| AppError::InvalidRequest(format!("备份包 manifest 无效：{}", e)))?;
    if manifest.schema_version != BACKUP_SCHEMA_VERSION || manifest.kind != BACKUP_KIND {
        return Err(AppError::InvalidRequest(
            "这不是受支持的 Hermes profile 备份包".to_string(),
        ));
    }
    Ok(manifest)
}

fn read_backup_manifest(zip_path: &Path) -> AppResult<BackupManifest> {
    let file = fs::File::open(zip_path)?;
    let mut archive = ZipArchive::new(file).map_err(zip_error)?;
    read_manifest_from_archive(&mut archive)
}

fn profile_relative_path(enclosed: &Path) -> AppResult<Option<PathBuf>> {
    let mut components = enclosed.components();
    match components.next() {
        Some(Component::Normal(prefix)) if prefix == "profile" => {}
        _ => {
            return Err(AppError::InvalidRequest(format!(
                "备份包包含 profile 目录外的条目：{}",
                enclosed.display()
            )))
        }
    }

    let mut rel = PathBuf::new();
    for component in components {
        match component {
            Component::Normal(part) => rel.push(part),
            _ => {
                return Err(AppError::InvalidRequest(format!(
                    "备份包条目路径无效：{}",
                    enclosed.display()
                )))
            }
        }
    }

    if rel.as_os_str().is_empty() {
        Ok(None)
    } else {
        Ok(Some(rel))
    }
}

fn top_level_name(rel: &Path) -> Option<String> {
    rel.components().find_map(|component| match component {
        Component::Normal(part) => Some(part.to_string_lossy().to_string()),
        _ => None,
    })
}

fn extract_profile_backup_to_staging(
    zip_path: &Path,
    staging: &Path,
) -> AppResult<(BackupManifest, BackupArchiveStats)> {
    let file = fs::File::open(zip_path)?;
    let mut archive = ZipArchive::new(file).map_err(zip_error)?;
    if archive.len() > MAX_BACKUP_ZIP_FILES {
        return Err(AppError::InvalidRequest(format!(
            "备份包条目数过多（{} / {}）",
            archive.len(),
            MAX_BACKUP_ZIP_FILES
        )));
    }

    let manifest = read_manifest_from_archive(&mut archive)?;
    fs::create_dir_all(staging)?;
    let staging_root = staging
        .canonicalize()
        .unwrap_or_else(|_| staging.to_path_buf());
    let mut stats = BackupArchiveStats::default();
    let mut top_level = BTreeSet::new();

    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(zip_error)?;
        if entry.name() == "manifest.json" {
            continue;
        }

        let enclosed = entry.enclosed_name().ok_or_else(|| {
            AppError::InvalidRequest(format!("备份包包含不安全路径：{}", entry.name()))
        })?;
        let Some(rel) = profile_relative_path(&enclosed)? else {
            continue;
        };
        if let Some(top) = top_level_name(&rel) {
            top_level.insert(top);
        }

        #[cfg(unix)]
        let mode = entry.unix_mode();
        #[cfg(unix)]
        let is_symlink = mode.map(|m| (m & 0o170000) == 0o120000).unwrap_or(false);
        #[cfg(not(unix))]
        let is_symlink = false;
        if is_symlink {
            return Err(AppError::InvalidRequest(format!(
                "备份包包含符号链接条目：{}",
                entry.name()
            )));
        }

        let out_path = staging_root.join(&rel);
        if !out_path.starts_with(&staging_root) {
            return Err(AppError::InvalidRequest(format!(
                "备份包条目逃逸目标目录：{}",
                entry.name()
            )));
        }

        if entry.is_dir() {
            fs::create_dir_all(&out_path)?;
            stats.entries.push(BackupManifestEntry {
                path: path_to_zip_rel(&rel),
                kind: BackupEntryKind::Directory,
                size_bytes: None,
            });
            continue;
        }

        stats.total_bytes = stats.total_bytes.saturating_add(entry.size());
        if stats.total_bytes > MAX_BACKUP_TOTAL_BYTES {
            return Err(AppError::InvalidRequest(format!(
                "备份包超过大小限制（{} MiB）",
                MAX_BACKUP_TOTAL_BYTES / 1024 / 1024
            )));
        }
        stats.file_count += 1;
        stats.entries.push(BackupManifestEntry {
            path: path_to_zip_rel(&rel),
            kind: BackupEntryKind::File,
            size_bytes: Some(entry.size()),
        });

        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut out_file = fs::File::create(&out_path)?;
        std::io::copy(&mut entry, &mut out_file)?;

        #[cfg(unix)]
        if let Some(mode) = mode {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&out_path, fs::Permissions::from_mode(mode & 0o777))?;
        }
    }

    stats.top_level_entries = top_level.into_iter().collect();
    if stats.file_count == 0 && stats.entries.is_empty() {
        return Err(AppError::InvalidRequest(
            "备份包中没有可恢复的 profile 文件".to_string(),
        ));
    }
    Ok((manifest, stats))
}

fn sanitize_profile_name(raw: &str) -> String {
    let mut out = String::new();
    let mut last_sep = false;
    for ch in raw.trim().to_ascii_lowercase().chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch);
            last_sep = false;
        } else if (matches!(ch, '-' | '_') || ch.is_ascii_whitespace() || ch == '.')
            && !last_sep
            && !out.is_empty()
        {
            out.push('-');
            last_sep = true;
        }
        if out.len() >= 24 {
            break;
        }
    }
    while out.ends_with('-') || out.ends_with('_') {
        out.pop();
    }
    if out.is_empty()
        || !out
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphanumeric())
    {
        "profile".to_string()
    } else {
        out
    }
}

fn restored_profile_preference(source_profile: &str) -> String {
    let stem = sanitize_profile_name(source_profile);
    let mut preferred = format!("restored-{}", stem);
    if preferred.len() > 32 {
        preferred.truncate(32);
        while preferred.ends_with('-') || preferred.ends_with('_') {
            preferred.pop();
        }
    }
    preferred
}

fn profile_hermes_home(base: &Path, profile: &str) -> PathBuf {
    if profile == "default" {
        base.to_path_buf()
    } else {
        base.join("profiles").join(profile)
    }
}

fn unique_profile_name(base: &Path, preferred: &str) -> String {
    let sanitized = sanitize_profile_name(preferred);
    if !profile_hermes_home(base, &sanitized).exists() {
        return sanitized;
    }
    for index in 2..=99 {
        let suffix = format!("-{}", index);
        let limit = 32usize.saturating_sub(suffix.len());
        let stem = sanitized.chars().take(limit).collect::<String>();
        let candidate = format!("{}{}", stem.trim_end_matches('-'), suffix);
        if !profile_hermes_home(base, &candidate).exists() {
            return candidate;
        }
    }
    format!("restored-{}", unix_timestamp())
}

fn active_profile_sticky_path(base: &Path) -> PathBuf {
    base.join("active_profile")
}

fn write_active_profile_sticky(base: &Path, profile: &str) -> AppResult<()> {
    let path = active_profile_sticky_path(base);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, format!("{}\n", profile))?;
    Ok(())
}

fn copy_dir_all(src: &Path, dst: &Path) -> AppResult<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        let meta = fs::symlink_metadata(&src_path)?;
        if meta.file_type().is_symlink() {
            return Err(AppError::FileError(format!(
                "恢复 staging 中出现符号链接：{}",
                src_path.display()
            )));
        }
        if meta.is_dir() {
            copy_dir_all(&src_path, &dst_path)?;
        } else if meta.is_file() {
            if let Some(parent) = dst_path.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::copy(&src_path, &dst_path)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let mode = meta.permissions().mode() & 0o777;
                let _ = fs::set_permissions(&dst_path, fs::Permissions::from_mode(mode));
            }
        }
    }
    Ok(())
}

fn install_staging_profile(staging: &Path, target: &Path) -> AppResult<()> {
    if target.exists() {
        return Err(AppError::FileError(format!(
            "目标 profile 已存在：{}",
            target.display()
        )));
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    match fs::rename(staging, target) {
        Ok(_) => Ok(()),
        Err(_) => {
            if let Err(err) = copy_dir_all(staging, target) {
                let _ = fs::remove_dir_all(target);
                return Err(err);
            }
            fs::remove_dir_all(staging)?;
            Ok(())
        }
    }
}

fn harden_secret_permissions(_target: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(_target, fs::Permissions::from_mode(0o700));
        for rel in SECRET_FILES {
            let path = _target.join(rel);
            if path.is_file() {
                let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
            }
        }
    }
}

async fn choose_save_path(app: tauri::AppHandle, file_name: String) -> AppResult<Option<PathBuf>> {
    use tauri_plugin_dialog::DialogExt;

    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("导出 Hermes 备份")
        .set_file_name(file_name)
        .add_filter("Hermes 备份压缩包", &["zip"])
        .save_file(move |path| {
            let result = path.and_then(|p| p.as_path().map(|path| path.to_path_buf()));
            let _ = tx.send(result);
        });
    rx.await.map_err(|e| AppError::Internal(e.to_string()))
}

async fn choose_backup_zip(app: tauri::AppHandle) -> AppResult<Option<PathBuf>> {
    use tauri_plugin_dialog::DialogExt;

    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("选择 Hermes 备份压缩包")
        .add_filter("Hermes 备份压缩包", &["zip"])
        .pick_files(move |paths| {
            let result = paths.and_then(|paths| {
                paths
                    .first()
                    .and_then(|p| p.as_path().map(|path| path.to_path_buf()))
            });
            let _ = tx.send(result);
        });
    rx.await.map_err(|e| AppError::Internal(e.to_string()))
}

#[tauri::command]
pub async fn backup_export_profile(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<BackupExportResult, AppError> {
    let (profile_name, hermes_home) = {
        let inner = state.inner.lock()?;
        if inner.hermes_home.trim().is_empty() {
            return Err(AppError::NotReady);
        }
        (
            inner.current_profile.clone(),
            PathBuf::from(&inner.hermes_home),
        )
    };

    let Some(path) = choose_save_path(app, suggested_backup_file_name(&profile_name)).await? else {
        return Ok(BackupExportResult {
            ok: false,
            canceled: true,
            profile_name: Some(profile_name),
            hermes_home: Some(hermes_home.to_string_lossy().to_string()),
            ..Default::default()
        });
    };
    let path = ensure_zip_extension(path);
    let export_home = hermes_home.clone();
    let export_profile = profile_name.clone();
    let export_path = path.clone();
    let result = tokio::task::spawn_blocking(move || {
        export_profile_backup_to_path(&export_home, &export_profile, &export_path)
    })
    .await
    .map_err(|e| AppError::Internal(e.to_string()))?;

    match result {
        Ok(stats) => Ok(BackupExportResult {
            ok: true,
            canceled: false,
            profile_name: Some(profile_name),
            hermes_home: Some(hermes_home.to_string_lossy().to_string()),
            backup_path: Some(path.to_string_lossy().to_string()),
            file_count: stats.file_count,
            total_bytes: stats.total_bytes,
            warnings: stats.warnings,
            error: None,
        }),
        Err(err) => {
            let _ = fs::remove_file(&path);
            Ok(BackupExportResult {
                ok: false,
                canceled: false,
                profile_name: Some(profile_name),
                hermes_home: Some(hermes_home.to_string_lossy().to_string()),
                backup_path: Some(path.to_string_lossy().to_string()),
                error: Some(err.to_string()),
                ..Default::default()
            })
        }
    }
}

#[tauri::command]
pub async fn backup_import_profile(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<BackupImportResult, AppError> {
    let Some(zip_path) = choose_backup_zip(app).await? else {
        return Ok(BackupImportResult {
            ok: false,
            canceled: true,
            ..Default::default()
        });
    };

    let (base, previous_profile, previous_home) = {
        let inner = state.inner.lock()?;
        if inner.hermes_home_base.trim().is_empty() || inner.hermes_home.trim().is_empty() {
            return Err(AppError::NotReady);
        }
        (
            PathBuf::from(&inner.hermes_home_base),
            inner.current_profile.clone(),
            PathBuf::from(&inner.hermes_home),
        )
    };

    let manifest = match read_backup_manifest(&zip_path) {
        Ok(manifest) => manifest,
        Err(err) => {
            return Ok(BackupImportResult {
                ok: false,
                canceled: false,
                backup_path: Some(zip_path.to_string_lossy().to_string()),
                error: Some(err.to_string()),
                ..Default::default()
            })
        }
    };
    let preferred = restored_profile_preference(&manifest.source_profile_name);
    let target_profile = unique_profile_name(&base, &preferred);
    let target_home = profile_hermes_home(&base, &target_profile);
    let staging_parent = base.join(".backup-import-staging");
    let staging = staging_parent.join(format!("{}-{}", target_profile, unix_timestamp()));
    let zip_for_extract = zip_path.clone();
    let staging_for_extract = staging.clone();

    let extract_result = tokio::task::spawn_blocking(move || {
        if staging_for_extract.exists() {
            fs::remove_dir_all(&staging_for_extract)?;
        }
        extract_profile_backup_to_staging(&zip_for_extract, &staging_for_extract)
    })
    .await
    .map_err(|e| AppError::Internal(e.to_string()))?;

    let (_manifest, stats) = match extract_result {
        Ok(result) => result,
        Err(err) => {
            let _ = fs::remove_dir_all(&staging);
            return Ok(BackupImportResult {
                ok: false,
                canceled: false,
                target_profile_name: Some(target_profile),
                hermes_home: Some(target_home.to_string_lossy().to_string()),
                backup_path: Some(zip_path.to_string_lossy().to_string()),
                error: Some(err.to_string()),
                ..Default::default()
            });
        }
    };

    let imported_entries = stats.top_level_entries.clone();
    if let Err(err) = install_staging_profile(&staging, &target_home) {
        let _ = fs::remove_dir_all(&staging);
        return Ok(BackupImportResult {
            ok: false,
            canceled: false,
            target_profile_name: Some(target_profile),
            hermes_home: Some(target_home.to_string_lossy().to_string()),
            backup_path: Some(zip_path.to_string_lossy().to_string()),
            imported_entries,
            file_count: stats.file_count,
            total_bytes: stats.total_bytes,
            warnings: stats.warnings,
            error: Some(err.to_string()),
            ..Default::default()
        });
    }
    harden_secret_permissions(&target_home);

    if !restart::try_begin_restart(&state)? {
        return Ok(BackupImportResult {
            ok: false,
            canceled: false,
            target_profile_name: Some(target_profile),
            hermes_home: Some(target_home.to_string_lossy().to_string()),
            backup_path: Some(zip_path.to_string_lossy().to_string()),
            imported_entries,
            file_count: stats.file_count,
            total_bytes: stats.total_bytes,
            warnings: stats.warnings,
            error: Some("备份已恢复为新 profile，但运行时正在切换中，请稍后手动切换。".to_string()),
            ..Default::default()
        });
    }

    let (host, port) = restart::host_and_port();
    let target_home_string = target_home.to_string_lossy().to_string();
    let previous_home_string = previous_home.to_string_lossy().to_string();
    let respawn = restart::respawn_managed_dashboard(
        &state,
        &host,
        port,
        &target_home_string,
        &previous_home_string,
    )
    .await;
    restart::end_restart(&state);

    let base_result = |ok: bool,
                       api_base_url: Option<String>,
                       gateway_url: Option<String>,
                       session_token: Option<String>,
                       error: Option<String>,
                       recovered_previous_profile: Option<bool>| {
        BackupImportResult {
            ok,
            canceled: false,
            target_profile_name: Some(target_profile.clone()),
            hermes_home: Some(target_home.to_string_lossy().to_string()),
            backup_path: Some(zip_path.to_string_lossy().to_string()),
            api_base_url,
            gateway_url,
            session_token,
            imported_entries: imported_entries.clone(),
            file_count: stats.file_count,
            total_bytes: stats.total_bytes,
            warnings: stats.warnings.clone(),
            error,
            recovered_previous_profile,
        }
    };

    match respawn {
        Ok(respawn) => match respawn.outcome {
            RespawnOutcome::Spawned => {
                let sticky_warning =
                    write_active_profile_sticky(&base, &target_profile).err().map(|err| {
                        format!("已恢复并切换，但写入 active_profile 失败：{}", err)
                    });
                {
                    let mut inner = state.inner.lock()?;
                    inner.current_profile = target_profile.clone();
                }
                let mut result = base_result(
                    true,
                    respawn.api_base_url,
                    respawn.gateway_url,
                    respawn.session_token,
                    None,
                    None,
                );
                if let Some(warning) = sticky_warning {
                    result.warnings.push(warning);
                }
                Ok(result)
            }
            RespawnOutcome::Recovered { error } => Ok(base_result(
                false,
                respawn.api_base_url,
                respawn.gateway_url,
                respawn.session_token,
                Some(format!(
                    "备份已恢复为 profile {}，但启动失败：{}。已恢复到原 profile {}。",
                    target_profile, error, previous_profile
                )),
                Some(true),
            )),
            RespawnOutcome::Down {
                error,
                recovery_error,
            } => Ok(base_result(
                false,
                None,
                None,
                None,
                Some(format!(
                    "备份已恢复为 profile {}，但启动失败（{}），恢复原 profile {} 也失败（{}）。请重启桌面端。",
                    target_profile, error, previous_profile, recovery_error
                )),
                Some(false),
            )),
        },
        Err(err) => Ok(base_result(
            false,
            None,
            None,
            None,
            Some(format!("备份已恢复，但 dashboard 重启失败：{}", err)),
            Some(false),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;
    use tempfile::TempDir;

    fn write(path: &Path, content: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, content).unwrap();
    }

    fn zip_names(path: &Path) -> Vec<String> {
        let file = fs::File::open(path).unwrap();
        let mut archive = ZipArchive::new(file).unwrap();
        let mut names = (0..archive.len())
            .map(|i| archive.by_index(i).unwrap().name().to_string())
            .collect::<Vec<_>>();
        names.sort();
        names
    }

    #[test]
    fn export_default_profile_skips_profiles_sibling_and_includes_sessions() {
        let tmp = TempDir::new().unwrap();
        let home = tmp.path().join("hermes-home");
        let zip = tmp.path().join("backup.zip");
        write(&home.join("config.yaml"), "model: test\n");
        write(&home.join("sessions/session_1.json"), "{}\n");
        write(&home.join("profiles/other/config.yaml"), "model: other\n");
        write(&home.join("active_profile"), "other\n");

        let stats = export_profile_backup_to_path(&home, "default", &zip).unwrap();

        assert_eq!(stats.file_count, 2);
        let names = zip_names(&zip);
        assert!(names.contains(&"manifest.json".to_string()));
        assert!(names.contains(&"profile/config.yaml".to_string()));
        assert!(names.contains(&"profile/sessions/session_1.json".to_string()));
        assert!(!names
            .iter()
            .any(|name| name.starts_with("profile/profiles/")));
        assert!(!names.contains(&"profile/active_profile".to_string()));
    }

    #[test]
    fn export_skips_backup_output_file_when_saved_inside_profile() {
        let tmp = TempDir::new().unwrap();
        let home = tmp.path().join("home");
        let zip = home.join("self.zip");
        write(&home.join("config.yaml"), "model: test\n");
        write(&zip, "old\n");

        let stats = export_profile_backup_to_path(&home, "default", &zip).unwrap();

        assert!(stats
            .warnings
            .iter()
            .any(|warning| warning.contains("备份输出文件自身")));
        let names = zip_names(&zip);
        assert!(!names.contains(&"profile/self.zip".to_string()));
    }

    #[test]
    fn import_extracts_profile_payload_and_top_level_entries() {
        let tmp = TempDir::new().unwrap();
        let home = tmp.path().join("home");
        let zip = tmp.path().join("backup.zip");
        let staging = tmp.path().join("staging");
        write(&home.join("config.yaml"), "model: test\n");
        write(&home.join("sessions/session_1.json"), "{}\n");
        export_profile_backup_to_path(&home, "default", &zip).unwrap();

        let (manifest, stats) = extract_profile_backup_to_staging(&zip, &staging).unwrap();

        assert_eq!(manifest.source_profile_name, "default");
        assert_eq!(
            fs::read_to_string(staging.join("config.yaml")).unwrap(),
            "model: test\n"
        );
        assert!(staging.join("sessions/session_1.json").is_file());
        assert_eq!(stats.top_level_entries, vec!["config.yaml", "sessions"]);
    }

    #[test]
    fn import_rejects_path_outside_profile_payload() {
        let tmp = TempDir::new().unwrap();
        let zip_path = tmp.path().join("bad.zip");
        let file = fs::File::create(&zip_path).unwrap();
        let mut zip = ZipWriter::new(file);
        let manifest = BackupManifest {
            schema_version: BACKUP_SCHEMA_VERSION,
            kind: BACKUP_KIND.to_string(),
            source_profile_name: "default".to_string(),
            exported_at: 0,
            desktop_version: "test".to_string(),
            includes_secrets: true,
            includes_sessions: true,
            entries: vec![],
        };
        zip.start_file("manifest.json", SimpleFileOptions::default())
            .unwrap();
        zip.write_all(serde_json::to_string(&manifest).unwrap().as_bytes())
            .unwrap();
        zip.start_file("../evil.txt", SimpleFileOptions::default())
            .unwrap();
        zip.write_all(b"evil").unwrap();
        zip.finish().unwrap();

        let err =
            extract_profile_backup_to_staging(&zip_path, &tmp.path().join("staging")).unwrap_err();

        assert!(err.to_string().contains("不安全路径") || err.to_string().contains("profile"));
    }

    #[test]
    fn unique_profile_name_uses_restored_suffix() {
        let tmp = TempDir::new().unwrap();
        let base = tmp.path().join("base");
        fs::create_dir_all(base.join("profiles/restored-default")).unwrap();

        assert_eq!(
            unique_profile_name(&base, &restored_profile_preference("default")),
            "restored-default-2"
        );
    }

    #[cfg(unix)]
    #[test]
    fn harden_secret_permissions_sets_private_modes() {
        use std::os::unix::fs::PermissionsExt;

        let tmp = TempDir::new().unwrap();
        let target = tmp.path().join("profile");
        write(&target.join(".env"), "API_KEY=secret\n");
        harden_secret_permissions(&target);

        let dir_mode = fs::metadata(&target).unwrap().permissions().mode() & 0o777;
        let env_mode = fs::metadata(target.join(".env"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(dir_mode, 0o700);
        assert_eq!(env_mode, 0o600);
    }
}
