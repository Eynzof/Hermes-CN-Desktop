//! User-facing update transaction. Legacy component APIs remain available.
use std::fs;
use std::sync::{LazyLock, Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, State};

use super::{app_update, runtime_manager};
use crate::connection::ConnectionMode;
use crate::error::AppError;
use crate::process::{runtime, ui_update};
use crate::state::AppState;
use crate::update_activity::{Activity, MaintenanceGuard};
use crate::update_operation::UpdateOperation;

const EVENT: &str = "software-update-state";
static APP: OnceLock<AppHandle> = OnceLock::new();
static UI_ACK: LazyLock<tokio::sync::Notify> = LazyLock::new(tokio::sync::Notify::new);
static RECORD: LazyLock<Mutex<Option<UpdateRecord>>> = LazyLock::new(|| Mutex::new(None));

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateTarget {
    pub kind: String,
    pub version: String,
    pub current_version: String,
    pub notes: Option<String>,
    pub published_at: Option<String>,
    pub size: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateIssue {
    pub code: String,
    pub message: String,
    pub detail: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SoftwareUpdateState {
    pub phase: String,
    pub current_version: String,
    pub channel: String,
    pub custom_source: bool,
    pub development: bool,
    pub checked_at: Option<u64>,
    pub targets: Vec<UpdateTarget>,
    pub progress: Option<f64>,
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
    pub current_component: Option<String>,
    pub error: Option<UpdateIssue>,
    pub warnings: Vec<UpdateIssue>,
    pub activities: Vec<Activity>,
    pub activity_error: Option<String>,
    pub download_source: Option<String>,
    pub reload_required: bool,
    pub completed_at: Option<u64>,
}

impl Default for SoftwareUpdateState {
    fn default() -> Self {
        Self {
            phase: "idle".into(),
            current_version: env!("CARGO_PKG_VERSION").into(),
            channel: "stable".into(),
            custom_source: false,
            development: cfg!(debug_assertions),
            checked_at: None,
            targets: vec![],
            progress: None,
            downloaded_bytes: 0,
            total_bytes: None,
            current_component: None,
            error: None,
            warnings: vec![],
            activities: vec![],
            activity_error: None,
            download_source: None,
            reload_required: false,
            completed_at: None,
        }
    }
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateRecord {
    state: SoftwareUpdateState,
    fingerprint: String,
    shell: Option<app_update::ShellCandidate>,
    runtime: Option<runtime::RuntimeUpdateManifest>,
    ui: Option<ui_update::UiUpdateManifest>,
    prepared: Vec<String>,
    #[serde(default)]
    awaiting_ui: bool,
    previous_ui: Option<ui_update::UiInstallRecord>,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn record_path() -> std::path::PathBuf {
    runtime::runtime_root().join("software-update.json")
}

fn load_record() -> UpdateRecord {
    let mut record: UpdateRecord = fs::read(record_path())
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default();
    if matches!(record.state.phase.as_str(), "checking" | "downloading") {
        record.state.phase = if record.state.targets.is_empty() {
            "idle"
        } else {
            "available"
        }
        .into();
    }
    if record.state.phase == "applying"
        && record
            .shell
            .as_ref()
            .is_some_and(|s| s.version == env!("CARGO_PKG_VERSION"))
    {
        record.state.phase = "completed".into();
        record.state.completed_at = Some(now());
        // The full package may leave independently published components behind.
        record.state.checked_at = None;
    } else if record.state.phase == "applying" && !record.awaiting_ui {
        record.state.phase = "error".into();
        record.state.error = Some(issue("更新过程被中断，请重新检查后继续".into()));
    }
    record.state.current_version = env!("CARGO_PKG_VERSION").into();
    record.state.development = cfg!(debug_assertions);
    record
}

fn read_record() -> UpdateRecord {
    RECORD
        .lock()
        .unwrap()
        .get_or_insert_with(load_record)
        .clone()
}

fn change(persist: bool, update: impl FnOnce(&mut UpdateRecord)) -> SoftwareUpdateState {
    let mut store = RECORD.lock().unwrap();
    let record = store.get_or_insert_with(load_record);
    update(record);
    if persist {
        let write = || -> Result<(), String> {
            fs::create_dir_all(runtime::runtime_root()).map_err(|e| e.to_string())?;
            let mut file = tempfile::NamedTempFile::new_in(runtime::runtime_root())
                .map_err(|e| e.to_string())?;
            serde_json::to_writer(file.as_file_mut(), record).map_err(|e| e.to_string())?;
            file.persist(record_path()).map_err(|e| e.to_string())?;
            Ok(())
        };
        if let Err(error) = write() {
            record.state.phase = "error".into();
            record.state.error = Some(UpdateIssue {
                code: "storage_failed".into(),
                message: "无法保存更新状态，请检查磁盘空间后重试。".into(),
                detail: error,
            });
        }
    }
    let state = record.state.clone();
    drop(store);
    if let Some(app) = APP.get() {
        let _ = app.emit(EVENT, &state);
    }
    state
}

// Call before creating the WebView: an unacknowledged UI must never prevent
// the recovery screen from loading after a process interruption.
pub fn initialize(app: AppHandle) {
    let _ = APP.set(app);
    let record = read_record();
    if record.awaiting_ui {
        let result = ui_update::restore_ui_record(record.previous_ui.as_ref());
        change(true, |r| {
            r.awaiting_ui = false;
            r.state.reload_required = false;
        });
        fail(match result {
            Ok(()) => "界面更新确认被中断，已恢复原界面".into(),
            Err(error) => format!("界面更新中断，恢复失败：{error}"),
        });
    }
}

fn persisted(update: impl FnOnce(&mut UpdateRecord)) -> Result<SoftwareUpdateState, String> {
    let state = change(true, update);
    if let Some(error) = &state.error {
        if error.code == "storage_failed" {
            return Err(error.detail.clone());
        }
    }
    Ok(state)
}

fn issue(detail: String) -> UpdateIssue {
    let lower = detail.to_lowercase();
    let (code, message) =
        if lower.contains("signature") || lower.contains("签名") || lower.contains("sha-256") || lower.contains("sha256") {
            (
                "verification_failed",
                "更新包验证未通过，请重新下载；当前版本仍可使用。",
            )
        } else if lower.contains("版本已发生变化") || lower.contains("撤回") {
            ("candidate_changed", "此更新已调整或暂时撤回，请重新检查。")
        } else if lower.contains("任务") {
            (
                "activity_unavailable",
                "暂时无法安全应用更新，请查看任务状态。",
            )
        } else if lower.contains("未配置") || lower.contains("not configured") {
            (
                "source_unconfigured",
                "当前环境尚未配置更新服务，可在高级更新选项中查看。",
            )
        } else if lower.contains("compatible")
            || lower.contains("compatibility")
            || lower.contains("不兼容")
        {
            ("incompatible", "此更新暂不适用于当前版本，请等待兼容更新。")
        } else {
            (
                "update_failed",
                "更新未完成，请稍后重试；详细原因可在高级选项中查看。",
            )
        };
    UpdateIssue {
        code: code.into(),
        message: message.into(),
        detail,
    }
}

fn fail(error: String) -> SoftwareUpdateState {
    change(true, |r| {
        r.state.phase = "error".into();
        r.state.error = Some(issue(error));
    })
}

fn source_fingerprint() -> String {
    let config = crate::update_config::load().config;
    format!(
        "{:x}",
        Sha256::digest(format!(
            "{}|{:?}|{:?}",
            serde_json::to_string(&config).unwrap_or_default(),
            runtime::configured_manifest_url(),
            ui_update::ui_manifest_url()
        ))
    )
}

fn managed_running(state: &State<'_, AppState>) -> Result<bool, String> {
    let inner = state.inner.lock().map_err(|e| e.to_string())?;
    Ok(inner.connection_mode == ConnectionMode::Managed
        && inner
            .dashboard_handle
            .as_ref()
            .is_some_and(|h| h.owns_process))
}

pub(crate) fn maintenance(
    state: &State<'_, AppState>,
) -> Result<Option<MaintenanceGuard>, AppError> {
    if managed_running(state).map_err(AppError::RuntimeUnavailable)? {
        return MaintenanceGuard::begin()
            .map(Some)
            .map_err(AppError::RuntimeUnavailable);
    }
    Ok(None)
}

pub fn download_progress(bytes: u64, total: Option<u64>) {
    change(false, |r| {
        if r.state.phase != "downloading" {
            return;
        }
        r.state.downloaded_bytes = bytes;
        r.state.total_bytes = total;
        r.state.progress = total
            .filter(|n| *n > 0)
            .map(|n| (bytes as f64 / n as f64 * 100.).min(100.));
    });
}

pub fn app_progress(_percent: u8, source: Option<&str>) {
    change(false, |r| {
        if r.state.phase == "downloading" {
            r.state.download_source = source.map(str::to_string);
        }
    });
}

#[tauri::command]
pub fn software_update_snapshot(app: AppHandle, state: State<'_, AppState>) -> SoftwareUpdateState {
    let _ = APP.set(app);
    let fingerprint = source_fingerprint();
    let config = crate::update_config::load().config;
    let activity = if managed_running(&state).unwrap_or(false) {
        crate::update_activity::snapshot()
    } else {
        Ok(vec![])
    };
    change(false, |r| {
        if !crate::update_operation::busy()
            && !r.fingerprint.is_empty()
            && r.fingerprint != fingerprint
        {
            *r = UpdateRecord::default();
        }
        r.state.channel = config.channel.clone();
        r.state.custom_source = (!config.shell_updater_endpoint.is_empty()
            && config.shell_updater_endpoint
                != crate::update_config::DEFAULT_SHELL_UPDATE_ENDPOINT)
            || config.runtime_base_url != crate::update_config::DEFAULT_RUNTIME_BASE_URL
            || !config.runtime_manifest_url.is_empty();
        match activity {
            Ok(activities) => {
                r.state.activities = activities;
                r.state.activity_error = None;
            }
            Err(error) => {
                r.state.activities.clear();
                r.state.activity_error = Some(error);
            }
        }
        if r.state.phase == "waiting"
            && r.state.activities.is_empty()
            && r.state.activity_error.is_none()
        {
            r.state.phase = "ready".into();
        } else if r.state.phase == "ready"
            && (!r.state.activities.is_empty() || r.state.activity_error.is_some())
        {
            r.state.phase = "waiting".into();
        }
    })
}

#[tauri::command]
pub async fn software_update_check(
    app: AppHandle,
    state: State<'_, AppState>,
    component: Option<String>,
) -> Result<SoftwareUpdateState, String> {
    let _operation = UpdateOperation::begin()?;
    let _ = APP.set(app.clone());
    let component = component.as_deref().unwrap_or("all");
    if !["all", "app", "runtime", "ui"].contains(&component) {
        return Err("未知的更新组件".into());
    }
    change(false, |r| {
        r.state.phase = "checking".into();
        r.state.error = None;
    });
    let mut record = UpdateRecord {
        fingerprint: source_fingerprint(),
        ..Default::default()
    };
    record.state.channel = crate::update_config::load().config.channel;
    if component == "all" || component == "app" {
        match app_update::selected_candidate(&app).await {
            Ok(Some(candidate)) => {
                record.state.targets.push(UpdateTarget {
                    kind: "app".into(),
                    version: candidate.version.clone(),
                    current_version: env!("CARGO_PKG_VERSION").into(),
                    notes: candidate.notes.clone(),
                    published_at: candidate.published_at.clone(),
                    size: Some(candidate.metadata.size),
                });
                record.shell = Some(candidate);
            }
            Ok(None) => {}
            Err(error) => record.state.warnings.push(issue(error)),
        }
    }
    let managed = state
        .inner
        .lock()
        .map_err(|e| e.to_string())?
        .connection_mode
        == ConnectionMode::Managed;
    if record.shell.is_none() && managed && (component == "all" || component == "runtime") {
        let check = runtime::check_runtime_update().await;
        if check.ok && check.update_available {
            if let Some(candidate) = check.manifest {
                record.state.targets.push(UpdateTarget {
                    kind: "runtime".into(),
                    version: candidate.runtime_version.clone(),
                    current_version: check.current_runtime_version.unwrap_or_default(),
                    notes: None,
                    published_at: candidate.created_at.clone(),
                    size: None,
                });
                record.runtime = Some(candidate);
            }
        } else if !check.ok {
            record
                .state
                .warnings
                .push(issue(check.error.unwrap_or_default()));
        }
    }
    if record.shell.is_none() && (component == "all" || component == "ui") {
        let check = ui_update::check_ui_update().await;
        if check.ok && check.update_available {
            if let Some(candidate) = check.manifest {
                record.state.targets.push(UpdateTarget {
                    kind: "ui".into(),
                    version: candidate.ui_version.clone(),
                    current_version: check.current_ui_version.unwrap_or_default(),
                    notes: None,
                    published_at: None,
                    size: None,
                });
                record.ui = Some(candidate);
            }
        } else if !check.ok {
            record
                .state
                .warnings
                .push(issue(check.error.unwrap_or_default()));
        }
    }
    record.fingerprint = source_fingerprint();
    record.state.checked_at = Some(now());
    record.state.phase = if record.state.targets.is_empty() {
        if record.state.warnings.is_empty() {
            "idle"
        } else {
            "error"
        }
    } else {
        "available"
    }
    .into();
    if record.state.phase == "error" {
        record.state.error = record.state.warnings.first().cloned();
    }
    Ok(change(true, |r| *r = record))
}

async fn revalidate(app: &AppHandle, record: &UpdateRecord) -> Result<(), String> {
    if record.fingerprint != source_fingerprint() {
        return Err("更新来源或版本已发生变化，请重新检查".into());
    }
    if let Some(expected) = &record.shell {
        let candidate = app_update::selected_candidate(app).await?;
        if !candidate
            .is_some_and(|c| c.version == expected.version && c.metadata == expected.metadata)
        {
            return Err("更新版本已发生变化或已撤回".into());
        }
    }
    if let Some(expected) = &record.runtime {
        let check = runtime::check_runtime_update().await;
        if !check.ok {
            return Err(check.error.unwrap_or_default());
        }
        if !check.manifest.is_some_and(|c| c == *expected) {
            return Err("内核更新版本已发生变化或已撤回".into());
        }
    }
    if let Some(expected) = &record.ui {
        let check = ui_update::check_ui_update().await;
        if !check.ok {
            return Err(check.error.unwrap_or_default());
        }
        if !check.manifest.is_some_and(|c| c == *expected) {
            return Err("界面更新版本已发生变化或已撤回".into());
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn software_update_download(app: AppHandle) -> Result<SoftwareUpdateState, String> {
    let _operation = UpdateOperation::begin()?;
    let record = read_record();
    if record.state.targets.is_empty() {
        return Err("请先检查更新".into());
    }
    persisted(|r| {
        r.state.phase = "downloading".into();
        r.state.error = None;
        r.state.progress = None;
    })?;
    let work = async {
        revalidate(&app, &record).await?;
        if let Some(candidate) = &record.shell {
            change(false, |r| r.state.current_component = Some("app".into()));
            let result = app_update::run_download(&app, Some(candidate)).await;
            if !result.ok {
                return Err(result.error.unwrap_or_default());
            }
            persisted(|r| {
                r.prepared = vec!["app".into()];
                r.state.download_source = result.download_source;
            })?;
        }
        if let Some(candidate) = &record.runtime {
            change(false, |r| {
                r.state.current_component = Some("runtime".into());
                r.state.progress = None;
            });
            runtime::prepare_runtime_update(candidate).await?;
            persisted(|r| {
                if !r.prepared.iter().any(|k| k == "runtime") {
                    r.prepared.push("runtime".into());
                }
            })?;
        }
        if let Some(candidate) = &record.ui {
            change(false, |r| {
                r.state.current_component = Some("ui".into());
                r.state.progress = None;
            });
            ui_update::prepare_ui_update(candidate).await?;
            persisted(|r| {
                if !r.prepared.iter().any(|k| k == "ui") {
                    r.prepared.push("ui".into());
                }
            })?;
        }
        Ok::<(), String>(())
    };
    tokio::select! {
        result = work => Ok(match result {
            Ok(()) => change(true, |r| { r.state.phase = "ready".into(); r.state.progress = Some(100.); }),
            Err(error) => fail(error),
        }),
        _ = crate::update_operation::cancelled() => Ok(change(true, |r| { r.state.phase = "available".into(); r.state.progress = None; r.state.error = None; })),
    }
}

#[tauri::command]
pub fn software_update_cancel() -> SoftwareUpdateState {
    if read_record().state.phase == "downloading" {
        crate::update_operation::cancel();
    }
    read_record().state
}

async fn apply_runtime(
    app: &AppHandle,
    state: &State<'_, AppState>,
    candidate: runtime::RuntimeUpdateManifest,
) -> Result<(), String> {
    let expected_kernel = candidate.kernel_version.clone();
    let result = runtime::apply_prepared_runtime(candidate).await;
    if !result.ok {
        return Err(result.error.unwrap_or_default());
    }
    let running = managed_running(state)?;
    let sync =
        runtime::sync_runtime_resources_if_available(app.path().resource_dir().ok().as_deref());
    let result = match sync {
        Ok(_) if running => match runtime_manager::restart_dashboard(state).await {
            Ok(()) => verify_running_kernel(state, &expected_kernel).await,
            Err(error) => Err(error.to_string()),
        },
        Ok(_) => Ok(()),
        Err(error) => Err(error),
    };
    if let Err(error) = result {
        let rollback = runtime::rollback_runtime();
        if rollback.ok {
            if running {
                runtime_manager::restart_dashboard(state)
                    .await
                    .map_err(|e| format!("更新失败：{error}；旧内核恢复失败：{e}"))?;
            }
            return Err(format!("更新失败，已恢复原内核：{error}"));
        }
        return Err(format!(
            "更新失败：{error}；恢复失败：{}",
            rollback.error.unwrap_or_default()
        ));
    }
    Ok(())
}

async fn verify_running_kernel(state: &State<'_, AppState>, expected: &str) -> Result<(), String> {
    let base_url = state
        .inner
        .lock()
        .map_err(|e| e.to_string())?
        .api_base_url
        .clone();
    let version: serde_json::Value = reqwest::Client::new()
        .get(format!("{base_url}/api/version"))
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    if version.get("version").and_then(|v| v.as_str()) != Some(expected) {
        return Err(format!("启动的内核版本与更新目标 {expected} 不一致"));
    }
    Ok(())
}

#[tauri::command]
pub async fn software_update_apply(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<SoftwareUpdateState, String> {
    let _operation = UpdateOperation::begin()?;
    let record = read_record();
    if record.state.targets.is_empty()
        || record
            .state
            .targets
            .iter()
            .any(|t| !record.prepared.contains(&t.kind))
    {
        return Err("请先完成更新下载".into());
    }
    if cfg!(debug_assertions) && (record.shell.is_some() || record.ui.is_some()) {
        return Ok(fail(
            "开发运行版使用本地界面，请使用安装包验收应用及界面更新".into(),
        ));
    }
    if let Err(error) = revalidate(&app, &record).await {
        return Ok(fail(error));
    }
    let _maintenance = match maintenance(&state) {
        Ok(guard) => guard,
        Err(error) => {
            return Ok(change(true, |r| {
                r.state.phase = "waiting".into();
                r.state.activity_error = Some(error.to_string());
            }))
        }
    };
    persisted(|r| {
        r.state.phase = "applying".into();
        r.state.error = None;
        r.state.reload_required = false;
    })?;
    if let Some(candidate) = &record.shell {
        let result = app_update::run_install(&app, &state, Some(candidate)).await;
        return Ok(if result.ok {
            read_record().state
        } else {
            fail(result.error.unwrap_or_default())
        });
    }
    if let Some(candidate) = record.runtime.clone() {
        if let Err(error) = apply_runtime(&app, &state, candidate).await {
            return Ok(fail(error));
        }
        persisted(|r| {
            r.runtime = None;
            r.state.targets.retain(|t| t.kind != "runtime");
            r.prepared.retain(|k| k != "runtime");
        })?;
    }
    if let Some(candidate) = record.ui {
        let previous = ui_update::ui_current_record();
        persisted(|r| {
            r.previous_ui = previous.clone();
            r.awaiting_ui = true;
        })?;
        let result = ui_update::apply_prepared_ui(candidate);
        if !result.ok {
            change(true, |r| r.awaiting_ui = false);
            return Ok(fail(result.error.unwrap_or_default()));
        }
        let snapshot = change(true, |r| r.state.reload_required = true);
        tokio::spawn(async move {
            // Keep the shared operation lock until the rendered build has
            // acknowledged, so advanced actions cannot replace this rollback.
            let _operation = _operation;
            tokio::select! {
                _ = tokio::time::sleep(std::time::Duration::from_secs(45)) => {},
                _ = UI_ACK.notified() => {},
            }
            let record = read_record();
            if record.awaiting_ui {
                let restored = ui_update::restore_ui_record(record.previous_ui.as_ref());
                change(true, |r| {
                    r.awaiting_ui = false;
                    r.state.reload_required = false;
                });
                fail(match restored {
                    Ok(()) => "新版界面未能正常启动，已恢复原界面".into(),
                    Err(error) => format!("界面启动和恢复失败：{error}"),
                });
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.eval("window.location.reload()");
                }
            }
        });
        return Ok(snapshot);
    }
    Ok(change(true, |r| {
        r.state.phase = "completed".into();
        r.state.completed_at = Some(now());
    }))
}

#[tauri::command]
pub fn software_update_acknowledge(source_commit: String) -> SoftwareUpdateState {
    change(true, |r| {
        if r.awaiting_ui
            && r.ui.as_ref().is_some_and(|u| {
                u.ui_version == ui_update::effective_ui_version()
                    && source_commit.len() >= 7
                    && u.source_commit.starts_with(&source_commit)
            })
        {
            r.awaiting_ui = false;
            r.state.reload_required = false;
            UI_ACK.notify_one();
            r.state.phase = "completed".into();
            r.state.completed_at = Some(now());
        }
    })
}

#[tauri::command]
pub async fn software_update_rollback(
    app: AppHandle,
    state: State<'_, AppState>,
    component: String,
) -> Result<SoftwareUpdateState, String> {
    let _operation = UpdateOperation::begin()?;
    if !["runtime", "ui"].contains(&component.as_str()) {
        return Err("此组件不支持本地回退".into());
    }
    let _maintenance = maintenance(&state).map_err(|e| e.to_string())?;
    persisted(|r| {
        r.state.phase = "applying".into();
        r.state.error = None;
    })?;
    if component == "runtime" {
        if state
            .inner
            .lock()
            .map_err(|e| e.to_string())?
            .connection_mode
            != ConnectionMode::Managed
        {
            return Ok(fail("外部内核由目标设备管理".into()));
        }
        let running = managed_running(&state)?;
        let result = runtime::rollback_runtime();
        if !result.ok {
            return Ok(fail(result.error.unwrap_or_default()));
        }
        if running {
            if let Err(error) = runtime_manager::restart_dashboard(&state).await {
                return Ok(fail(error.to_string()));
            }
        }
    } else {
        let result = ui_update::rollback_ui_update();
        if !result.ok {
            return Ok(fail(result.error.unwrap_or_default()));
        }
    }
    let _ = APP.set(app);
    Ok(change(true, |r| {
        *r = UpdateRecord::default();
        r.state.phase = "completed".into();
        r.state.completed_at = Some(now());
        r.state.reload_required = component == "ui";
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn verification_failures_have_user_message_and_keep_diagnostic() {
        let issue = issue("SHA-256 mismatch: expected a, got b".into());
        assert_eq!(issue.code, "verification_failed");
        assert!(!issue.message.contains("SHA"));
        assert!(issue.detail.contains("expected a"));
    }
}
