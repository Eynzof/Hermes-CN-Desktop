use tauri::State;

use crate::environment;
use crate::error::AppError;
use crate::state::AppState;

#[tauri::command]
pub async fn environment_check(
    state: State<'_, AppState>,
) -> Result<environment::EnvironmentCheckResult, AppError> {
    let snapshot = {
        let inner = state.inner.lock()?;
        crate::state::AppStateInner {
            api_base_url: inner.api_base_url.clone(),
            gateway_url: inner.gateway_url.clone(),
            hermes_home: inner.hermes_home.clone(),
            hermes_home_base: inner.hermes_home_base.clone(),
            session_token: inner.session_token.clone(),
            current_profile: inner.current_profile.clone(),
            dashboard_handle: None,
            gateway_sse_stop: None,
            dashboard_restart_in_flight: inner.dashboard_restart_in_flight,
            last_runtime_error: inner.last_runtime_error.clone(),
            yolo_mode: inner.yolo_mode,
        }
    };
    Ok(environment::collect_environment_check(&snapshot).await)
}
