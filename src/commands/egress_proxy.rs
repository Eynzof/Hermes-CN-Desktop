use crate::schema::egress::{
    EgressProxyDownloadArgs, EgressProxyImportSecretsArgs, EgressProxyRule,
    EgressProxySetRulesArgs, EgressProxyStartArgs, EgressProxyStatus,
};

static EGRESS_PORT: std::sync::Mutex<Option<u16>> = std::sync::Mutex::new(None);
static SECRETS: std::sync::Mutex<Option<serde_json::Value>> = std::sync::Mutex::new(None);

#[tauri::command]
pub async fn egress_proxy_start(args: EgressProxyStartArgs) -> Result<EgressProxyStatus, String> {
    let port = args.port.unwrap_or(8650);
    let mut p = EGRESS_PORT.lock().map_err(|e| e.to_string())?;
    *p = Some(port);
    Ok(EgressProxyStatus {
        running: true,
        port: Some(port),
        rules: vec![],
    })
}

#[tauri::command]
pub async fn egress_proxy_stop() -> Result<(), String> {
    let mut p = EGRESS_PORT.lock().map_err(|e| e.to_string())?;
    *p = None;
    Ok(())
}

#[tauri::command]
pub async fn egress_proxy_status() -> Result<EgressProxyStatus, String> {
    let p = EGRESS_PORT.lock().map_err(|e| e.to_string())?;
    Ok(EgressProxyStatus {
        running: p.is_some(),
        port: *p,
        rules: vec![],
    })
}

#[tauri::command]
pub async fn egress_proxy_set_rules(
    args: EgressProxySetRulesArgs,
) -> Result<EgressProxyStatus, String> {
    let parsed: Vec<EgressProxyRule> =
        serde_json::from_str(&args.rules_json).map_err(|e| e.to_string())?;
    let status = egress_proxy_status().await?;
    Ok(EgressProxyStatus {
        running: status.running,
        port: status.port,
        rules: parsed,
    })
}

#[tauri::command]
pub async fn egress_proxy_download(args: EgressProxyDownloadArgs) -> Result<String, String> {
    // v1 stub: echo back a JSON rule pack so the orchestrator can continue without real network access.
    Ok(format!("{{\"url\":\"{}\",\"rules\":[]}}", args.url))
}

#[tauri::command]
pub async fn egress_proxy_import_secrets(
    args: EgressProxyImportSecretsArgs,
) -> Result<serde_json::Value, String> {
    let parsed: serde_json::Value =
        serde_json::from_str(&args.secrets_json).map_err(|e| e.to_string())?;
    let mut s = SECRETS.lock().map_err(|e| e.to_string())?;
    *s = Some(parsed.clone());
    Ok(serde_json::json!({ "secrets": parsed, "importedAt": chrono::Utc::now().to_rfc3339() }))
}

#[tauri::command]
pub async fn egress_proxy_export_secrets() -> Result<serde_json::Value, String> {
    let s = SECRETS.lock().map_err(|e| e.to_string())?;
    let secrets = s.clone().unwrap_or(serde_json::json!({}));
    Ok(secrets)
}
