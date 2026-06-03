use std::collections::{HashSet, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use regex::Regex;
use serde::{Deserialize, Serialize};
use std::sync::LazyLock;
use tauri::State;

use crate::commands::runtime_manager;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

static PROFILE_NAME_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$").expect("valid profile name regex")
});

const PROFILE_DIRS: &[&str] = &[
    "memories",
    "sessions",
    "skills",
    "skins",
    "logs",
    "plans",
    "workspace",
    "cron",
    "home",
];

const MIGRATABLE_ENTRIES: &[(&str, CopyEntryKind, bool)] = &[
    ("config.yaml", CopyEntryKind::File, false),
    (".env", CopyEntryKind::File, true),
    ("auth.json", CopyEntryKind::File, true),
    (".anthropic_oauth.json", CopyEntryKind::File, true),
    ("SOUL.md", CopyEntryKind::File, false),
    ("memories/MEMORY.md", CopyEntryKind::File, false),
    ("memories/USER.md", CopyEntryKind::File, false),
    ("skills", CopyEntryKind::Directory, false),
    ("plugins", CopyEntryKind::Directory, false),
    ("skins", CopyEntryKind::Directory, false),
    ("agent-hooks", CopyEntryKind::Directory, false),
    ("scripts", CopyEntryKind::Directory, false),
];

const SECRET_FILES: &[&str] = &[".env", "auth.json", ".anthropic_oauth.json"];

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CopyEntryKind {
    File,
    Directory,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ConfigMigrationScanInput {
    #[serde(default)]
    pub manual_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConfigMigrationCopyEntry {
    pub path: String,
    pub kind: CopyEntryKind,
    pub size_bytes: Option<u64>,
    pub contains_secrets: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConfigMigrationCandidate {
    pub id: String,
    pub label: String,
    pub path: String,
    pub source_kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub distro: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile_name: Option<String>,
    pub recommended_target_profile: String,
    pub has_config: bool,
    pub has_env: bool,
    pub has_auth: bool,
    pub has_skills: bool,
    pub has_memories: bool,
    pub copy_entries: Vec<ConfigMigrationCopyEntry>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConfigMigrationScanResult {
    pub desktop_hermes_home: String,
    pub current_profile: String,
    pub candidates: Vec<ConfigMigrationCandidate>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigMigrationImportInput {
    pub source_path: String,
    #[serde(default)]
    pub target_profile_name: Option<String>,
    #[serde(default)]
    pub recommended_target_profile: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ConfigMigrationImportResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_profile_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hermes_home: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_base_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gateway_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_token: Option<String>,
    pub imported_entries: Vec<String>,
    pub warnings: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone)]
struct SourceHint {
    path: PathBuf,
    source_kind: String,
    distro: Option<String>,
    profile_name: Option<String>,
}

fn is_valid_profile_name(name: &str) -> bool {
    PROFILE_NAME_RE.is_match(name)
}

fn active_profile_sticky_path(base: &Path) -> PathBuf {
    base.join("active_profile")
}

fn write_active_profile_sticky(base: &Path, profile: &str) -> AppResult<()> {
    let path = active_profile_sticky_path(base);
    if profile == "default" {
        match fs::remove_file(&path) {
            Ok(_) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.into()),
        }
    } else {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(path, format!("{}\n", profile))?;
        Ok(())
    }
}

fn profile_hermes_home(base: &Path, profile: &str) -> PathBuf {
    if profile == "default" {
        base.to_path_buf()
    } else {
        base.join("profiles").join(profile)
    }
}

fn normalize_for_compare(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

fn same_path(a: &Path, b: &Path) -> bool {
    normalize_for_compare(a) == normalize_for_compare(b)
}

fn entry_path(root: &Path, rel: &str) -> PathBuf {
    rel.split('/')
        .fold(root.to_path_buf(), |acc, part| acc.join(part))
}

fn is_nonempty_dir(path: &Path) -> bool {
    fs::read_dir(path)
        .map(|mut entries| entries.next().is_some())
        .unwrap_or(false)
}

fn has_migratable_content(path: &Path) -> bool {
    MIGRATABLE_ENTRIES.iter().any(|(rel, kind, _)| {
        let candidate = entry_path(path, rel);
        match kind {
            CopyEntryKind::File => candidate.is_file(),
            CopyEntryKind::Directory => candidate.is_dir() && is_nonempty_dir(&candidate),
        }
    })
}

fn profile_has_existing_config(path: &Path) -> bool {
    has_migratable_content(path)
}

fn summarize_entry(
    root: &Path,
    rel: &str,
    kind: CopyEntryKind,
    contains_secrets: bool,
) -> Option<ConfigMigrationCopyEntry> {
    let path = entry_path(root, rel);
    match kind {
        CopyEntryKind::File => {
            if !path.is_file() {
                return None;
            }
            Some(ConfigMigrationCopyEntry {
                path: rel.to_string(),
                kind,
                size_bytes: fs::metadata(&path).ok().map(|m| m.len()),
                contains_secrets,
            })
        }
        CopyEntryKind::Directory => {
            if !path.is_dir() || !is_nonempty_dir(&path) {
                return None;
            }
            Some(ConfigMigrationCopyEntry {
                path: rel.to_string(),
                kind,
                size_bytes: directory_size(&path).ok(),
                contains_secrets,
            })
        }
    }
}

fn directory_size(path: &Path) -> std::io::Result<u64> {
    let mut total = 0u64;
    let mut queue = VecDeque::from([path.to_path_buf()]);
    while let Some(dir) = queue.pop_front() {
        for entry in fs::read_dir(dir)? {
            let entry = entry?;
            let meta = fs::symlink_metadata(entry.path())?;
            if meta.file_type().is_symlink() {
                continue;
            }
            if meta.is_dir() {
                queue.push_back(entry.path());
            } else if meta.is_file() {
                total = total.saturating_add(meta.len());
            }
        }
    }
    Ok(total)
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
        if out.len() >= 28 {
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
        "imported".to_string()
    } else {
        out
    }
}

fn recommended_target_profile(
    path: &Path,
    source_kind: &str,
    distro: Option<&str>,
    profile_name: Option<&str>,
) -> String {
    if let Some(profile) = profile_name.filter(|name| *name != "default") {
        return sanitize_profile_name(profile);
    }
    if source_kind == "wsl" {
        if let Some(distro) = distro {
            return sanitize_profile_name(&format!("wsl-{}", distro));
        }
        return "wsl-imported".to_string();
    }
    if path.file_name().and_then(|n| n.to_str()) == Some(".hermes") {
        return "imported".to_string();
    }
    sanitize_profile_name(
        path.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("imported"),
    )
}

fn candidate_id(path: &Path) -> String {
    let raw = path.to_string_lossy();
    let mut id = String::from("src-");
    for ch in raw.chars() {
        if ch.is_ascii_alphanumeric() {
            id.push(ch.to_ascii_lowercase());
        } else if !id.ends_with('-') {
            id.push('-');
        }
        if id.len() >= 80 {
            break;
        }
    }
    id.trim_end_matches('-').to_string()
}

fn source_label(hint: &SourceHint) -> String {
    match (
        hint.source_kind.as_str(),
        hint.distro.as_deref(),
        hint.profile_name.as_deref(),
    ) {
        ("wsl", Some(distro), Some(profile)) if profile != "default" => {
            format!("WSL {} · profile {}", distro, profile)
        }
        ("wsl", Some(distro), _) => format!("WSL {} · default", distro),
        (_, _, Some(profile)) if profile != "default" => format!("Hermes profile {}", profile),
        ("manual", _, _) => "手动选择的 Hermes 配置".to_string(),
        _ => "本机 Hermes 配置".to_string(),
    }
}

fn build_candidate(hint: SourceHint) -> Option<ConfigMigrationCandidate> {
    if !hint.path.is_dir() || !has_migratable_content(&hint.path) {
        return None;
    }

    let copy_entries: Vec<_> = MIGRATABLE_ENTRIES
        .iter()
        .filter_map(|(rel, kind, secret)| summarize_entry(&hint.path, rel, *kind, *secret))
        .collect();

    let has_memories = entry_path(&hint.path, "memories/MEMORY.md").is_file()
        || entry_path(&hint.path, "memories/USER.md").is_file();

    let mut warnings = Vec::new();
    if hint.source_kind == "wsl" {
        warnings.push(
            "这是 WSL 内的配置。API Key 和模型配置可以迁移，但 Linux 专属命令、MCP 路径或 shell 脚本可能需要手动调整。".to_string(),
        );
    }

    Some(ConfigMigrationCandidate {
        id: candidate_id(&hint.path),
        label: source_label(&hint),
        path: hint.path.to_string_lossy().to_string(),
        source_kind: hint.source_kind.clone(),
        distro: hint.distro.clone(),
        profile_name: hint.profile_name.clone(),
        recommended_target_profile: recommended_target_profile(
            &hint.path,
            &hint.source_kind,
            hint.distro.as_deref(),
            hint.profile_name.as_deref(),
        ),
        has_config: entry_path(&hint.path, "config.yaml").is_file(),
        has_env: entry_path(&hint.path, ".env").is_file(),
        has_auth: entry_path(&hint.path, "auth.json").is_file()
            || entry_path(&hint.path, ".anthropic_oauth.json").is_file(),
        has_skills: entry_path(&hint.path, "skills").is_dir()
            && is_nonempty_dir(&entry_path(&hint.path, "skills")),
        has_memories,
        copy_entries,
        warnings,
    })
}

fn add_root_and_profiles(
    hints: &mut Vec<SourceHint>,
    root: PathBuf,
    source_kind: &str,
    distro: Option<String>,
) {
    hints.push(SourceHint {
        path: root.clone(),
        source_kind: source_kind.to_string(),
        distro: distro.clone(),
        profile_name: Some("default".to_string()),
    });

    let profiles_root = root.join("profiles");
    if let Ok(entries) = fs::read_dir(profiles_root) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let Some(name) = path
                .file_name()
                .and_then(|n| n.to_str())
                .map(ToOwned::to_owned)
            else {
                continue;
            };
            if !is_valid_profile_name(&name) {
                continue;
            }
            hints.push(SourceHint {
                path,
                source_kind: source_kind.to_string(),
                distro: distro.clone(),
                profile_name: Some(name),
            });
        }
    }
}

fn collect_native_hints(
    input: Option<&ConfigMigrationScanInput>,
) -> (Vec<SourceHint>, Vec<String>) {
    let mut hints = Vec::new();
    let mut warnings = Vec::new();

    if let Some(raw) = std::env::var_os("HERMES_HOME") {
        let path = PathBuf::from(raw);
        if !path.as_os_str().is_empty() {
            add_root_and_profiles(&mut hints, path, "env", None);
        }
    }

    if let Some(home) = dirs::home_dir() {
        add_root_and_profiles(&mut hints, home.join(".hermes"), "native", None);
    }

    if let Some(manual) = input.and_then(|i| i.manual_path.as_deref()) {
        let trimmed = manual.trim();
        if !trimmed.is_empty() {
            let path = PathBuf::from(trimmed);
            if path.is_dir() {
                add_root_and_profiles(&mut hints, path, "manual", None);
            } else {
                warnings.push(format!("手动选择的目录不存在或不可访问：{}", trimmed));
            }
        }
    }

    (hints, warnings)
}

#[cfg(target_os = "windows")]
fn collect_wsl_hints() -> (Vec<SourceHint>, Vec<String>) {
    let mut hints = Vec::new();
    let mut warnings = Vec::new();
    let output = match std::process::Command::new("wsl.exe")
        .args(["-l", "-q"])
        .output()
    {
        Ok(output) => output,
        Err(_) => return (hints, warnings),
    };
    if !output.status.success() {
        warnings.push("WSL distro 列表读取失败，已跳过 WSL 配置扫描。".to_string());
        return (hints, warnings);
    }
    let stdout = decode_command_output(&output.stdout);
    for distro in parse_wsl_distros(&stdout) {
        let home_output = std::process::Command::new("wsl.exe")
            .args(["-d", &distro, "sh", "-lc", "printf '%s' \"$HOME\""])
            .output();
        let Ok(home_output) = home_output else {
            warnings.push(format!("WSL {} 的 HOME 读取失败，已跳过。", distro));
            continue;
        };
        if !home_output.status.success() {
            warnings.push(format!("WSL {} 的 HOME 读取失败，已跳过。", distro));
            continue;
        }
        let home = decode_command_output(&home_output.stdout);
        let Some(path) = wsl_linux_path_to_unc(&distro, home.trim()) else {
            warnings.push(format!(
                "WSL {} 的 HOME 路径无法映射到 Windows：{}",
                distro,
                home.trim()
            ));
            continue;
        };
        add_root_and_profiles(&mut hints, path.join(".hermes"), "wsl", Some(distro));
    }
    (hints, warnings)
}

#[cfg(not(target_os = "windows"))]
fn collect_wsl_hints() -> (Vec<SourceHint>, Vec<String>) {
    (Vec::new(), Vec::new())
}

fn filter_hints(
    hints: Vec<SourceHint>,
    desktop_base: &Path,
    current_home: &Path,
) -> Vec<SourceHint> {
    let mut seen = HashSet::new();
    let mut filtered = Vec::new();
    for hint in hints {
        if same_path(&hint.path, desktop_base) || same_path(&hint.path, current_home) {
            continue;
        }
        let key = normalize_for_compare(&hint.path)
            .to_string_lossy()
            .to_string();
        if seen.insert(key) {
            filtered.push(hint);
        }
    }
    filtered
}

#[tauri::command]
pub async fn config_migration_scan(
    input: Option<ConfigMigrationScanInput>,
    state: State<'_, AppState>,
) -> Result<ConfigMigrationScanResult, AppError> {
    let (desktop_hermes_home, current_profile, current_home) = {
        let inner = state.inner.lock()?;
        (
            inner.hermes_home_base.clone(),
            inner.current_profile.clone(),
            inner.hermes_home.clone(),
        )
    };

    let desktop_base = PathBuf::from(&desktop_hermes_home);
    let current_home = PathBuf::from(&current_home);
    let (mut hints, mut warnings) = collect_native_hints(input.as_ref());
    let (wsl_hints, wsl_warnings) = collect_wsl_hints();
    hints.extend(wsl_hints);
    warnings.extend(wsl_warnings);

    let candidates = filter_hints(hints, &desktop_base, &current_home)
        .into_iter()
        .filter_map(build_candidate)
        .collect();

    Ok(ConfigMigrationScanResult {
        desktop_hermes_home,
        current_profile,
        candidates,
        warnings,
    })
}

fn ensure_profile_dirs(profile_dir: &Path) -> AppResult<()> {
    fs::create_dir_all(profile_dir)?;
    for subdir in PROFILE_DIRS {
        fs::create_dir_all(profile_dir.join(subdir))?;
    }
    Ok(())
}

fn unique_profile_name(base: &Path, preferred: &str) -> String {
    let sanitized = sanitize_profile_name(preferred);
    if !profile_has_existing_config(&profile_hermes_home(base, &sanitized)) {
        return sanitized;
    }
    for index in 2..=99 {
        let suffix = format!("-{}", index);
        let limit = 31usize.saturating_sub(suffix.len());
        let stem = sanitized.chars().take(limit).collect::<String>();
        let candidate = format!("{}{}", stem.trim_end_matches('-'), suffix);
        if !profile_has_existing_config(&profile_hermes_home(base, &candidate)) {
            return candidate;
        }
    }
    format!("imported-{}", unix_timestamp())
}

fn choose_target_profile(
    base: &Path,
    current_profile: &str,
    current_home: &Path,
    source: &Path,
    requested: Option<&str>,
    preferred: Option<&str>,
) -> String {
    if let Some(requested) = requested.map(str::trim).filter(|s| !s.is_empty()) {
        return unique_profile_name(base, requested);
    }
    if !profile_has_existing_config(current_home) {
        return current_profile.to_string();
    }
    let preferred = preferred
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| recommended_target_profile(source, "native", None, None));
    unique_profile_name(base, &preferred)
}

fn unix_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn should_skip_nested(name: &str) -> bool {
    name == "__pycache__"
        || name.ends_with(".pyc")
        || name.ends_with(".pyo")
        || name.ends_with(".sock")
        || name.ends_with(".tmp")
}

fn copy_file_preserving_metadata(src: &Path, dst: &Path) -> AppResult<()> {
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::copy(src, dst)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = fs::metadata(src) {
            let mode = meta.permissions().mode() & 0o777;
            let _ = fs::set_permissions(dst, fs::Permissions::from_mode(mode));
        }
    }
    Ok(())
}

fn copy_dir_filtered(src: &Path, dst: &Path, warnings: &mut Vec<String>) -> AppResult<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if should_skip_nested(&name_str) {
            continue;
        }
        let src_path = entry.path();
        let dst_path = dst.join(&name);
        let meta = fs::symlink_metadata(entry.path())?;
        if dst_path.exists() {
            if meta.is_dir() && dst_path.is_dir() {
                copy_dir_filtered(&src_path, &dst_path, warnings)?;
            } else {
                warnings.push(format!("目标已存在，已跳过：{}", dst_path.display()));
            }
            continue;
        }
        if meta.file_type().is_symlink() {
            if src_path.is_file() {
                copy_file_preserving_metadata(&src_path, &dst_path)?;
            } else {
                warnings.push(format!("已跳过目录符号链接：{}", src_path.display()));
            }
        } else if meta.is_dir() {
            copy_dir_filtered(&src_path, &dst_path, warnings)?;
        } else if meta.is_file() {
            copy_file_preserving_metadata(&src_path, &dst_path)?;
        }
    }
    Ok(())
}

fn copy_migratable_entries(source: &Path, staging: &Path) -> AppResult<(Vec<String>, Vec<String>)> {
    let mut imported = Vec::new();
    let mut warnings = Vec::new();
    for (rel, kind, _) in MIGRATABLE_ENTRIES {
        let src = entry_path(source, rel);
        if !src.exists() {
            continue;
        }
        let dst = entry_path(staging, rel);
        let meta = fs::symlink_metadata(&src)?;
        if meta.file_type().is_symlink() && src.is_dir() {
            warnings.push(format!("已跳过目录符号链接：{}", src.display()));
            continue;
        }
        match kind {
            CopyEntryKind::File => {
                if src.is_file() {
                    copy_file_preserving_metadata(&src, &dst)?;
                    imported.push((*rel).to_string());
                }
            }
            CopyEntryKind::Directory => {
                if src.is_dir() && is_nonempty_dir(&src) {
                    copy_dir_filtered(&src, &dst, &mut warnings)?;
                    imported.push((*rel).to_string());
                }
            }
        }
    }
    Ok((imported, warnings))
}

fn install_staging(staging: &Path, target: &Path, warnings: &mut Vec<String>) -> AppResult<()> {
    ensure_profile_dirs(target)?;
    for entry in fs::read_dir(staging)? {
        let entry = entry?;
        let dst = target.join(entry.file_name());
        let src = entry.path();
        let meta = fs::symlink_metadata(entry.path())?;
        if dst.exists() {
            if meta.is_dir() && dst.is_dir() {
                copy_dir_filtered(&src, &dst, warnings)?;
            } else {
                warnings.push(format!("目标已存在，已跳过：{}", dst.display()));
            }
            continue;
        }
        if fs::rename(&src, &dst).is_err() {
            if meta.is_dir() {
                copy_dir_filtered(&src, &dst, warnings)?;
            } else {
                copy_file_preserving_metadata(&src, &dst)?;
            }
        }
    }
    Ok(())
}

fn harden_secret_permissions(target: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(target, fs::Permissions::from_mode(0o700));
        for rel in SECRET_FILES {
            let path = target.join(rel);
            if path.is_file() {
                let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
            }
        }
    }
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn decode_command_output(bytes: &[u8]) -> String {
    if bytes.len() >= 2 && bytes.iter().filter(|b| **b == 0).count() > bytes.len() / 4 {
        let units: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
            .filter(|unit| *unit != 0)
            .collect();
        String::from_utf16_lossy(&units)
    } else {
        String::from_utf8_lossy(bytes).replace('\0', "")
    }
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn parse_wsl_distros(stdout: &str) -> Vec<String> {
    stdout
        .lines()
        .map(|line| line.trim().trim_end_matches('\r').trim_matches('\0'))
        .map(|line| line.trim_start_matches('*').trim())
        .filter(|line| !line.is_empty() && !line.contains("Windows Subsystem"))
        .map(ToOwned::to_owned)
        .collect()
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn wsl_linux_path_to_unc(distro: &str, linux_path: &str) -> Option<PathBuf> {
    let trimmed = linux_path.trim();
    if !trimmed.starts_with('/') {
        return None;
    }
    let rest = trimmed.trim_start_matches('/').replace('/', "\\");
    Some(PathBuf::from(format!(
        r"\\wsl.localhost\{}\{}",
        distro, rest
    )))
}

#[tauri::command]
pub async fn config_migration_import(
    input: ConfigMigrationImportInput,
    state: State<'_, AppState>,
) -> Result<ConfigMigrationImportResult, AppError> {
    let source = PathBuf::from(input.source_path.trim());
    if !source.is_dir() || !has_migratable_content(&source) {
        return Ok(ConfigMigrationImportResult {
            ok: false,
            error: Some(format!(
                "来源不是可迁移的 Hermes 配置目录：{}",
                source.display()
            )),
            ..Default::default()
        });
    }

    let (base, current_profile, current_home) = {
        let inner = state.inner.lock()?;
        (
            PathBuf::from(&inner.hermes_home_base),
            inner.current_profile.clone(),
            PathBuf::from(&inner.hermes_home),
        )
    };

    if same_path(&source, &base) || same_path(&source, &current_home) {
        return Ok(ConfigMigrationImportResult {
            ok: false,
            error: Some("不能从桌面端当前正在使用的 hermes-home 迁移到自身。".to_string()),
            ..Default::default()
        });
    }

    let target_profile = choose_target_profile(
        &base,
        &current_profile,
        &current_home,
        &source,
        input.target_profile_name.as_deref(),
        input.recommended_target_profile.as_deref(),
    );
    let target_home = profile_hermes_home(&base, &target_profile);
    let staging_parent = base.join(".migration-staging");
    fs::create_dir_all(&staging_parent)?;
    let staging = staging_parent.join(format!("{}-{}", target_profile, unix_timestamp()));
    if staging.exists() {
        fs::remove_dir_all(&staging)?;
    }
    fs::create_dir_all(&staging)?;

    let (imported_entries, mut warnings) = match copy_migratable_entries(&source, &staging) {
        Ok(result) => result,
        Err(err) => {
            let _ = fs::remove_dir_all(&staging);
            return Ok(ConfigMigrationImportResult {
                ok: false,
                error: Some(format!("复制到临时目录失败：{}", err)),
                ..Default::default()
            });
        }
    };

    if imported_entries.is_empty() {
        let _ = fs::remove_dir_all(&staging);
        return Ok(ConfigMigrationImportResult {
            ok: false,
            error: Some("没有发现可迁移的配置文件。".to_string()),
            ..Default::default()
        });
    }

    if let Err(err) = install_staging(&staging, &target_home, &mut warnings) {
        let _ = fs::remove_dir_all(&staging);
        return Ok(ConfigMigrationImportResult {
            ok: false,
            error: Some(format!("安装迁移配置失败：{}", err)),
            imported_entries,
            warnings,
            ..Default::default()
        });
    }
    let _ = fs::remove_dir_all(&staging);
    harden_secret_permissions(&target_home);

    if let Err(err) = write_active_profile_sticky(&base, &target_profile) {
        return Ok(ConfigMigrationImportResult {
            ok: false,
            error: Some(format!("写入 active_profile 失败：{}", err)),
            target_profile_name: Some(target_profile),
            hermes_home: Some(target_home.to_string_lossy().to_string()),
            imported_entries,
            warnings,
            ..Default::default()
        });
    }

    {
        let mut inner = state.inner.lock()?;
        inner.hermes_home = target_home.to_string_lossy().to_string();
        inner.current_profile = target_profile.clone();
    }

    if let Err(err) = runtime_manager::restart_dashboard(&state).await {
        return Ok(ConfigMigrationImportResult {
            ok: false,
            error: Some(format!("配置已迁移，但 dashboard 重启失败：{}", err)),
            target_profile_name: Some(target_profile),
            hermes_home: Some(target_home.to_string_lossy().to_string()),
            imported_entries,
            warnings,
            ..Default::default()
        });
    }

    let (api_base_url, gateway_url, session_token) = {
        let inner = state.inner.lock()?;
        (
            inner.api_base_url.clone(),
            inner.gateway_url.clone(),
            inner.session_token.clone(),
        )
    };

    Ok(ConfigMigrationImportResult {
        ok: true,
        target_profile_name: Some(target_profile),
        hermes_home: Some(target_home.to_string_lossy().to_string()),
        api_base_url: Some(api_base_url),
        gateway_url: Some(gateway_url),
        session_token,
        imported_entries,
        warnings,
        error: None,
    })
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

    #[test]
    fn sanitize_profile_name_keeps_safe_profile_ids() {
        assert_eq!(sanitize_profile_name("Ubuntu 22.04"), "ubuntu-22-04");
        assert_eq!(sanitize_profile_name("../bad"), "bad");
        assert_eq!(sanitize_profile_name(""), "imported");
    }

    #[test]
    fn parse_wsl_distros_handles_star_and_blank_lines() {
        let raw = "  Ubuntu\r\n* Debian\r\n\r\n";
        assert_eq!(parse_wsl_distros(raw), vec!["Ubuntu", "Debian"]);
    }

    #[test]
    fn decode_command_output_handles_utf16le_wsl_output() {
        let raw: Vec<u8> = "Ubuntu\r\n"
            .encode_utf16()
            .flat_map(|unit| unit.to_le_bytes())
            .collect();
        assert_eq!(decode_command_output(&raw), "Ubuntu\r\n");
    }

    #[test]
    fn wsl_linux_path_maps_to_unc_path() {
        let mapped = wsl_linux_path_to_unc("Ubuntu", "/home/alice").unwrap();
        assert_eq!(
            mapped.to_string_lossy(),
            r"\\wsl.localhost\Ubuntu\home\alice"
        );
        assert!(wsl_linux_path_to_unc("Ubuntu", "relative/path").is_none());
    }

    #[test]
    fn has_migratable_content_detects_config_files() {
        let tmp = TempDir::new().unwrap();
        assert!(!has_migratable_content(tmp.path()));
        write(&tmp.path().join("config.yaml"), "model: test\n");
        assert!(has_migratable_content(tmp.path()));
    }

    #[test]
    fn build_candidate_summarizes_expected_files_without_secret_values() {
        let tmp = TempDir::new().unwrap();
        write(&tmp.path().join("config.yaml"), "model: test\n");
        write(&tmp.path().join(".env"), "OPENAI_API_KEY=secret\n");
        write(&tmp.path().join("memories/MEMORY.md"), "remember\n");
        let candidate = build_candidate(SourceHint {
            path: tmp.path().to_path_buf(),
            source_kind: "native".to_string(),
            distro: None,
            profile_name: Some("default".to_string()),
        })
        .unwrap();
        assert!(candidate.has_config);
        assert!(candidate.has_env);
        assert!(candidate.has_memories);
        assert!(candidate
            .copy_entries
            .iter()
            .any(|entry| entry.path == ".env" && entry.contains_secrets));
    }

    #[test]
    fn filter_hints_excludes_desktop_home_and_deduplicates() {
        let tmp = TempDir::new().unwrap();
        let desktop = tmp.path().join("desktop");
        let source = tmp.path().join("source");
        fs::create_dir_all(&desktop).unwrap();
        fs::create_dir_all(&source).unwrap();
        let hints = vec![
            SourceHint {
                path: desktop.clone(),
                source_kind: "native".into(),
                distro: None,
                profile_name: None,
            },
            SourceHint {
                path: source.clone(),
                source_kind: "native".into(),
                distro: None,
                profile_name: None,
            },
            SourceHint {
                path: source.clone(),
                source_kind: "env".into(),
                distro: None,
                profile_name: None,
            },
        ];
        let filtered = filter_hints(hints, &desktop, &desktop);
        assert_eq!(filtered.len(), 1);
        assert!(same_path(&filtered[0].path, &source));
    }

    #[test]
    fn choose_target_uses_current_profile_when_empty() {
        let tmp = TempDir::new().unwrap();
        let base = tmp.path().join("base");
        let current = base.clone();
        fs::create_dir_all(&current).unwrap();
        let source = tmp.path().join("source/.hermes");
        assert_eq!(
            choose_target_profile(&base, "default", &current, &source, None, None),
            "default"
        );
    }

    #[test]
    fn choose_target_creates_unique_import_profile_when_current_has_config() {
        let tmp = TempDir::new().unwrap();
        let base = tmp.path().join("base");
        let current = base.clone();
        write(&current.join("config.yaml"), "model: old\n");
        write(
            &base.join("profiles/imported/config.yaml"),
            "model: old imported\n",
        );
        let source = tmp.path().join("source/.hermes");
        assert_eq!(
            choose_target_profile(&base, "default", &current, &source, None, None),
            "imported-2"
        );
    }

    #[test]
    fn copy_migratable_entries_excludes_runtime_state() {
        let tmp = TempDir::new().unwrap();
        let source = tmp.path().join("source");
        let staging = tmp.path().join("staging");
        write(&source.join("config.yaml"), "model: test\n");
        write(&source.join("sessions/session.json"), "{}\n");
        write(&source.join("state.db"), "db\n");
        let (imported, warnings) = copy_migratable_entries(&source, &staging).unwrap();
        assert!(warnings.is_empty());
        assert_eq!(imported, vec!["config.yaml"]);
        assert!(staging.join("config.yaml").exists());
        assert!(!staging.join("sessions/session.json").exists());
        assert!(!staging.join("state.db").exists());
    }

    #[test]
    fn install_staging_does_not_overwrite_existing_files() {
        let tmp = TempDir::new().unwrap();
        let staging = tmp.path().join("staging");
        let target = tmp.path().join("target");
        write(&staging.join("config.yaml"), "new\n");
        write(&target.join("config.yaml"), "old\n");
        let mut warnings = Vec::new();
        install_staging(&staging, &target, &mut warnings).unwrap();
        assert_eq!(
            fs::read_to_string(target.join("config.yaml")).unwrap(),
            "old\n"
        );
        assert!(warnings
            .iter()
            .any(|warning| warning.contains("目标已存在")));
    }

    #[test]
    fn install_staging_does_not_overwrite_nested_directory_files() {
        let tmp = TempDir::new().unwrap();
        let staging = tmp.path().join("staging");
        let target = tmp.path().join("target");
        write(&staging.join("skills/demo/SKILL.md"), "new\n");
        write(&staging.join("skills/demo/extra.md"), "extra\n");
        write(&target.join("skills/demo/SKILL.md"), "old\n");
        let mut warnings = Vec::new();

        install_staging(&staging, &target, &mut warnings).unwrap();

        assert_eq!(
            fs::read_to_string(target.join("skills/demo/SKILL.md")).unwrap(),
            "old\n"
        );
        assert_eq!(
            fs::read_to_string(target.join("skills/demo/extra.md")).unwrap(),
            "extra\n"
        );
        assert!(warnings
            .iter()
            .any(|warning| warning.contains("目标已存在")));
    }

    #[test]
    fn staging_copy_failure_does_not_create_target_files() {
        let tmp = TempDir::new().unwrap();
        let source = tmp.path().join("missing-source");
        let staging = tmp.path().join("staging");
        let result = copy_migratable_entries(&source, &staging);
        assert!(result.unwrap().0.is_empty());
        assert!(!staging.join("config.yaml").exists());
    }
}
