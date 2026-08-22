//! Profile operations Tauri commands (export/import/distribution helpers).

use serde::{Deserialize, Serialize};
use tauri::command;

#[derive(Debug, Clone, Deserialize)]
pub struct ExportProfileRequest {
    pub name: String,
    pub dest: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ExportProfileResponse {
    pub path: String,
}

#[command]
pub async fn export_profile(request: ExportProfileRequest) -> Result<ExportProfileResponse, String> {
    Ok(ExportProfileResponse {
        path: format!("{}\\{}.tar.gz", request.dest, request.name),
    })
}

#[derive(Debug, Clone, Deserialize)]
pub struct ImportProfileRequest {
    pub archive_path: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ImportProfileResponse {
    pub name: String,
    pub root: String,
}

#[command]
pub async fn import_profile(request: ImportProfileRequest) -> Result<ImportProfileResponse, String> {
    Ok(ImportProfileResponse {
        name: request.name.clone(),
        root: format!("~/.hermes/profiles/{}", request.name),
    })
}

#[derive(Debug, Clone, Deserialize)]
pub struct DistributionRequest {
    pub source: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct DistributionInfoResponse {
    pub name: String,
    pub version: String,
    pub description: String,
}

#[command]
pub async fn distribution_info(request: DistributionRequest) -> Result<DistributionInfoResponse, String> {
    Ok(DistributionInfoResponse {
        name: request.source.clone(),
        version: "0.0.0".to_string(),
        description: "stub distribution".to_string(),
    })
}
