use serde::{Deserialize, Serialize};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexAppServerStatus {
    pub running: bool,
    pub binary_ok: bool,
    pub runtime: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexAppServerStartArgs {
    pub cwd: Option<String>,
    pub codex_home: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexAppServerRunTurnArgs {
    pub input: String,
    pub request_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexAppServerRespondArgs {
    pub request_id: String,
    pub result: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexApplyConfigTomlArgs {
    pub patch: String,
}

static CODEX_RUNNING: std::sync::Mutex<bool> = std::sync::Mutex::new(false);

#[tauri::command]
pub async fn codex_app_server_check() -> Result<bool, String> {
    // v1: best-effort probe for `codex` binary.
    let output = std::process::Command::new("codex").arg("--version").output();
    Ok(output.is_ok())
}

#[tauri::command]
pub async fn codex_app_server_start(_args: CodexAppServerStartArgs) -> Result<CodexAppServerStatus, String> {
    let mut running = CODEX_RUNNING.lock().map_err(|e| e.to_string())?;
    *running = true;
    Ok(CodexAppServerStatus { running: true, binary_ok: true, runtime: "codex_app_server".into() })
}

#[tauri::command]
pub async fn codex_app_server_stop() -> Result<(), String> {
    let mut running = CODEX_RUNNING.lock().map_err(|e| e.to_string())?;
    *running = false;
    Ok(())
}

#[tauri::command]
pub async fn codex_app_server_status() -> Result<CodexAppServerStatus, String> {
    let running = CODEX_RUNNING.lock().map_err(|e| e.to_string())?;
    Ok(CodexAppServerStatus { running: *running, binary_ok: true, runtime: "auto".into() })
}

#[tauri::command]
pub async fn codex_app_server_run_turn(args: CodexAppServerRunTurnArgs) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "finalText": format!("Codex turn {} stub", args.request_id),
        "projectedMessages": [],
        "toolIterations": 0,
        "interrupted": false,
    }))
}

#[tauri::command]
pub async fn codex_app_server_interrupt() -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub async fn codex_app_server_close() -> Result<(), String> {
    let mut running = CODEX_RUNNING.lock().map_err(|e| e.to_string())?;
    *running = false;
    Ok(())
}

#[tauri::command]
pub async fn codex_app_server_respond(_args: CodexAppServerRespondArgs) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub async fn codex_app_server_plugin_list() -> Result<Vec<String>, String> {
    Ok(vec![])
}

#[tauri::command]
pub async fn codex_app_server_apply_config_toml(_args: CodexApplyConfigTomlArgs) -> Result<(), String> {
    Ok(())
}
