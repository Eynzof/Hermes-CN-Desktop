use tauri::State;

use crate::error::AppResult;
use crate::state::AppState;
use crate::state_db::{
    exec, fts_search, query, search_meta, StateDbFtsSearchRequest, StateDbQueryRequest,
    StateDbSearchMeta,
};

fn hermes_home(state: &State<'_, AppState>) -> AppResult<String> {
    let inner = state.inner.lock()?;
    if inner.hermes_home.is_empty() {
        return Err(crate::error::AppError::NotReady);
    }
    Ok(inner.hermes_home.clone())
}

#[tauri::command]
pub fn state_db_query(
    state: State<'_, AppState>,
    request: StateDbQueryRequest,
) -> AppResult<Vec<std::collections::HashMap<String, serde_json::Value>>> {
    query(&hermes_home(&state)?, request)
}

#[tauri::command]
pub fn state_db_exec(state: State<'_, AppState>, request: StateDbQueryRequest) -> AppResult<i64> {
    exec(&hermes_home(&state)?, request)
}

#[tauri::command]
pub fn state_db_fts_search(
    state: State<'_, AppState>,
    request: StateDbFtsSearchRequest,
) -> AppResult<Vec<std::collections::HashMap<String, serde_json::Value>>> {
    fts_search(&hermes_home(&state)?, request)
}

#[tauri::command]
pub fn state_db_search_meta(state: State<'_, AppState>) -> AppResult<StateDbSearchMeta> {
    search_meta(&hermes_home(&state)?)
}
