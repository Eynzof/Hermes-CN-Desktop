use serde::{Deserialize, Serialize};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LspProcessStatus {
    pub process_key: String,
    pub alive: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspSpawnArgs {
    pub server_id: String,
    pub command: String,
    pub args: Vec<String>,
    pub cwd: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspWriteArgs {
    pub process_key: String,
    pub bytes_base64: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspShutdownArgs {
    pub process_key: String,
}

#[derive(Deserialize)]
pub struct LspProbeArgs {
    pub name: String,
}

static LSP_PROCESSES: std::sync::LazyLock<
    std::sync::Mutex<std::collections::HashMap<String, std::process::Child>>,
> = std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));

#[tauri::command]
pub async fn lsp_spawn(args: LspSpawnArgs) -> Result<LspProcessStatus, String> {
    let mut cmd = std::process::Command::new(&args.command);
    cmd.args(&args.args).stdin(std::process::Stdio::piped());
    if let Some(cwd) = &args.cwd {
        cmd.current_dir(cwd);
    }
    let child = cmd.spawn().map_err(|e| format!("spawn failed: {e}"))?;
    let key = format!("{}-{}", args.server_id, std::process::id());
    let mut map = LSP_PROCESSES.lock().map_err(|e| e.to_string())?;
    map.insert(key.clone(), child);
    Ok(LspProcessStatus { process_key: key, alive: true })
}

#[tauri::command]
pub async fn lsp_write_stdin(args: LspWriteArgs) -> Result<(), String> {
    use base64::Engine;
    let mut map = LSP_PROCESSES.lock().map_err(|e| e.to_string())?;
    let child = map
        .get_mut(&args.process_key)
        .ok_or_else(|| "unknown process".to_string())?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&args.bytes_base64)
        .map_err(|e| e.to_string())?;
    use std::io::Write;
    let stdin = child.stdin.as_mut().ok_or_else(|| "stdin closed".to_string())?;
    stdin.write_all(&bytes).map_err(|e| e.to_string())?;
    stdin.flush().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn lsp_shutdown(args: LspShutdownArgs) -> Result<(), String> {
    let mut map = LSP_PROCESSES.lock().map_err(|e| e.to_string())?;
    if let Some(mut child) = map.remove(&args.process_key) {
        let _ = child.kill();
    }
    Ok(())
}

#[tauri::command]
pub async fn lsp_probe_binary(args: LspProbeArgs) -> Result<bool, String> {
    // v1: best-effort probe via `command --version` without external crates.
    let output = std::process::Command::new(&args.name).arg("--version").output();
    Ok(output.is_ok())
}

#[tauri::command]
pub async fn lsp_status() -> Result<Vec<LspProcessStatus>, String> {
    let mut map = LSP_PROCESSES.lock().map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for (key, child) in map.iter_mut() {
        out.push(LspProcessStatus {
            process_key: key.clone(),
            alive: child.try_wait().map(|o| o.is_none()).unwrap_or(false),
        });
    }
    Ok(out)
}
