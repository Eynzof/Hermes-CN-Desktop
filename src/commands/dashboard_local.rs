//! Local-first dashboard commands.
//!
//! These commands implement the OS-level side of the web-dashboard migration:
//! status, version, and environment reads that the frontend can resolve without
//! hitting the managed Python dashboard.

use serde::{Deserialize, Serialize};

use crate::error::AppError;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DashboardLocalStatusInput {
    #[serde(default)]
    pub connection_mode: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DashboardLocalStatus {
    pub ok: bool,
    pub platform: String,
    pub version: String,
    pub connection_mode: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DashboardLocalEnv {
    pub env: Vec<(String, String)>,
}

fn host_platform() -> &'static str {
    #[cfg(target_os = "windows")]
    {
        "windows"
    }
    #[cfg(target_os = "macos")]
    {
        "macos"
    }
    #[cfg(target_os = "linux")]
    {
        "linux"
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        "unknown"
    }
}

/// Return the local dashboard status without contacting a remote dashboard.
#[tauri::command]
pub fn dashboard_local_status(input: DashboardLocalStatusInput) -> Result<DashboardLocalStatus, AppError> {
    Ok(DashboardLocalStatus {
        ok: true,
        platform: host_platform().to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        connection_mode: input.connection_mode.unwrap_or_else(|| "managed".to_string()),
    })
}

/// Return a redacted list of environment variables relevant to the dashboard.
#[tauri::command]
pub fn dashboard_local_env() -> Result<DashboardLocalEnv, AppError> {
    let mut env: Vec<(String, String)> = std::env::vars()
        .filter(|(k, _)| {
            let k = k.to_lowercase();
            k.starts_with("hermes_") || k.starts_with("hermes-") || k == "home" || k == "userprofile"
        })
        .map(|(k, v)| (k, v))
        .collect();
    env.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(DashboardLocalEnv { env })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dashboard_local_status_returns_managed_mode_by_default() {
        let status = dashboard_local_status(DashboardLocalStatusInput { connection_mode: None }).unwrap();
        assert!(status.ok);
        assert_eq!(status.connection_mode, "managed");
        assert!(!status.version.is_empty());
        assert!(!status.platform.is_empty());
    }

    #[test]
    fn dashboard_local_status_uses_override_mode() {
        let status = dashboard_local_status(DashboardLocalStatusInput {
            connection_mode: Some("remote".to_string()),
        })
        .unwrap();
        assert_eq!(status.connection_mode, "remote");
    }

    #[test]
    fn dashboard_local_env_lists_hermes_vars() {
        std::env::set_var("HERMES_DASHBOARD_TEST_FLAG", "1");
        let result = dashboard_local_env().unwrap();
        assert!(result.env.iter().any(|(k, _)| k == "HERMES_DASHBOARD_TEST_FLAG"));
    }
}
