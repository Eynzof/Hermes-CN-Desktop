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
    Ok(environment::collect_environment_check(input).await)
}
