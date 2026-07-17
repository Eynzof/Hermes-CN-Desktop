use crate::coding_agents::{collect_coding_agents_check, CodingAgentsCheckResult};
use crate::error::AppError;

#[tauri::command]
pub async fn coding_agents_check() -> Result<CodingAgentsCheckResult, AppError> {
    // 与 environment_check 同款：先非强制刷新 PATH，让「刷新检测」能看到
    // 刚装好的 claude/codex 而无需重启应用（resolver 自带节流）。
    let _ = tauri::async_runtime::spawn_blocking(|| {
        crate::path_resolver::refresh_blocking(crate::path_resolver::SHELL_PROBE_TIMEOUT, false)
    })
    .await;
    let result = tauri::async_runtime::spawn_blocking(collect_coding_agents_check)
        .await
        .map_err(|err| AppError::Internal(format!("coding agents check join error: {err}")))?;
    Ok(result)
}
