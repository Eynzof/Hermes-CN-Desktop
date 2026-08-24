use serde::Deserialize;

use crate::schema::acp::AcpStatus;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpStartArgs {
    pub cwd: Option<String>,
}

static ACP_RUNNING: std::sync::Mutex<bool> = std::sync::Mutex::new(false);

#[tauri::command]
pub async fn acp_start(_args: AcpStartArgs) -> Result<AcpStatus, String> {
    let mut running = ACP_RUNNING.lock().map_err(|e| e.to_string())?;
    *running = true;
    Ok(AcpStatus {
        running: true,
        pid: None,
    })
}

#[tauri::command]
pub async fn acp_stop() -> Result<(), String> {
    let mut running = ACP_RUNNING.lock().map_err(|e| e.to_string())?;
    *running = false;
    Ok(())
}

#[tauri::command]
pub async fn acp_status() -> Result<AcpStatus, String> {
    let running = ACP_RUNNING.lock().map_err(|e| e.to_string())?;
    Ok(AcpStatus {
        running: *running,
        pid: None,
    })
}

#[tauri::command]
pub async fn acp_list_sessions() -> Result<Vec<String>, String> {
    Ok(vec![])
}
