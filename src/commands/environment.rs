use tauri::State;

use crate::environment;
use crate::error::AppError;
use crate::state::AppState;

#[tauri::command]
pub async fn environment_check(
    state: State<'_, AppState>,
) -> Result<environment::EnvironmentCheckResult, AppError> {
    let input = {
        let inner = state.inner.lock()?;
        environment::EnvironmentCheckInput::from_state(&inner)
    };
    // Re-resolve PATH so 刷新检查 picks up freshly installed tools without an
    // app restart. Non-forced: the resolver throttles the login-shell probe
    // so the page's 60s auto-refetch stays cheap.
    let _ = tauri::async_runtime::spawn_blocking(|| {
        crate::path_resolver::refresh_blocking(crate::path_resolver::SHELL_PROBE_TIMEOUT, false)
    })
    .await;
    Ok(environment::collect_environment_check(input).await)
}
