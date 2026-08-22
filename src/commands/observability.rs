use serde::{Deserialize, Serialize};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetryConfig {
    pub enabled: bool,
    pub endpoint: Option<String>,
    pub sample_rate: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObservabilitySetConfigArgs {
    pub config_json: String,
}

static TELEMETRY_CONFIG: std::sync::Mutex<Option<TelemetryConfig>> = std::sync::Mutex::new(None);

#[tauri::command]
pub async fn observability_get_config() -> Result<TelemetryConfig, String> {
    let c = TELEMETRY_CONFIG.lock().map_err(|e| e.to_string())?;
    Ok(c.clone().unwrap_or(TelemetryConfig { enabled: false, endpoint: None, sample_rate: 1.0 }))
}

#[tauri::command]
pub async fn observability_set_config(args: ObservabilitySetConfigArgs) -> Result<(), String> {
    let parsed: TelemetryConfig = serde_json::from_str(&args.config_json).map_err(|e| e.to_string())?;
    let mut c = TELEMETRY_CONFIG.lock().map_err(|e| e.to_string())?;
    *c = Some(parsed);
    Ok(())
}
