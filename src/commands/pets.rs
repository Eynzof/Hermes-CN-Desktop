//! Pet / Petdex Tauri commands.

use serde::{Deserialize, Serialize};
use tauri::command;

#[derive(Debug, Clone, Serialize)]
pub struct PetInfo {
    pub enabled: bool,
    pub slug: String,
    pub display_name: String,
}

#[command]
pub async fn pets_list() -> Result<Vec<PetInfo>, String> {
    Ok(vec![
        PetInfo {
            enabled: true,
            slug: "boba".to_string(),
            display_name: "Boba".to_string(),
        },
    ])
}

#[derive(Debug, Clone, Deserialize)]
pub struct PetSelectRequest {
    pub slug: String,
}

#[command]
pub async fn pet_select(request: PetSelectRequest) -> Result<(), String> {
    let _ = request;
    Ok(())
}

#[derive(Debug, Clone, Deserialize)]
pub struct PetHatchRequest {
    pub concept: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct PetHatchResponse {
    pub slug: String,
}

#[command]
pub async fn pet_hatch(request: PetHatchRequest) -> Result<PetHatchResponse, String> {
    let slug = request.concept.to_lowercase().replace(' ', "-");
    Ok(PetHatchResponse { slug })
}
