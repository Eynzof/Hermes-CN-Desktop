//! Shared with Core's hermes_cli.update_activity; lock covers admission and apply.
use std::fs::{self, File, OpenOptions};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use fs2::FileExt;
use serde::{Deserialize, Serialize};
use sysinfo::{Pid, System};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Activity {
    pub id: String,
    pub kind: String,
    #[serde(default)]
    pub session_id: String,
    pub pid: u32,
    pub started: Option<f64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Maintenance {
    pid: u32,
    started: Option<f64>,
    expires: u64,
}

#[derive(Default, Serialize, Deserialize)]
struct Registry {
    entries: Vec<Activity>,
    maintenance: Option<Maintenance>,
}

pub fn root() -> PathBuf {
    crate::process::runtime::runtime_root().join("update-activity")
}

fn lock() -> Result<File, String> {
    fs::create_dir_all(root()).map_err(|e| e.to_string())?;
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(root().join("activity.lock"))
        .map_err(|e| e.to_string())?;
    file.lock_exclusive().map_err(|e| e.to_string())?;
    Ok(file)
}

fn alive(system: &System, pid: u32, started: Option<f64>) -> bool {
    system
        .process(Pid::from_u32(pid))
        .is_some_and(|p| started.is_none_or(|start| p.start_time().abs_diff(start as u64) <= 1))
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn read() -> Result<Registry, String> {
    let path = root().join("activity.json");
    let mut registry: Registry = serde_json::from_str(
        &fs::read_to_string(path)
            .map_err(|_| "当前内核尚未提供任务状态，请先停止内核再应用更新".to_string())?,
    )
    .map_err(|e| format!("无法读取内核任务状态：{e}"))?;
    let system = System::new_all();
    registry
        .entries
        .retain(|e| alive(&system, e.pid, e.started));
    if registry
        .maintenance
        .as_ref()
        .is_some_and(|m| m.expires <= now() || !alive(&system, m.pid, m.started))
    {
        registry.maintenance = None;
    }
    Ok(registry)
}

fn write(registry: &Registry) -> Result<(), String> {
    // Readers hold the same lock, so truncation is never visible to Core.
    fs::write(
        root().join("activity.json"),
        serde_json::to_vec(registry).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}

pub fn snapshot() -> Result<Vec<Activity>, String> {
    let _lock = lock()?;
    Ok(read()?.entries)
}

pub struct MaintenanceGuard;
impl MaintenanceGuard {
    pub fn begin() -> Result<Self, String> {
        let _lock = lock()?;
        let mut registry = read()?;
        if !registry.entries.is_empty() {
            return Err("仍有任务正在运行，请在任务结束后应用更新".into());
        }
        if registry.maintenance.is_some() {
            return Err("已有更新正在生效".into());
        }
        registry.maintenance = Some(Maintenance {
            pid: std::process::id(),
            started: None,
            expires: now() + 300,
        });
        write(&registry)?;
        Ok(Self)
    }
}
impl Drop for MaintenanceGuard {
    fn drop(&mut self) {
        if let Ok(_lock) = lock() {
            if let Ok(mut registry) = read() {
                if registry
                    .maintenance
                    .as_ref()
                    .is_some_and(|m| m.pid == std::process::id())
                {
                    registry.maintenance = None;
                    let _ = write(&registry);
                }
            }
        }
    }
}
