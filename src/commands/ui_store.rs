use tauri::State;

use crate::error::AppResult;
use crate::state::AppState;
use crate::ui_store::{
    self, UiEventInput, UiStoreRemoveKvInput, UiStoreSetKvInput, UiStoreSnapshot, UiTurnStats,
    UiTurnStatsQuery,
};

fn hermes_home(state: &State<'_, AppState>) -> AppResult<String> {
    let inner = state.inner.lock()?;
    Ok(inner.hermes_home.clone())
}

#[tauri::command]
pub fn ui_store_snapshot(state: State<'_, AppState>) -> AppResult<UiStoreSnapshot> {
    ui_store::snapshot(&hermes_home(&state)?)
}

#[tauri::command]
pub fn ui_store_set_kv(state: State<'_, AppState>, input: UiStoreSetKvInput) -> AppResult<bool> {
    ui_store::set_kv(&hermes_home(&state)?, input)?;
    Ok(true)
}

#[tauri::command]
pub fn ui_store_remove_kv(
    state: State<'_, AppState>,
    input: UiStoreRemoveKvInput,
) -> AppResult<bool> {
    ui_store::remove_kv(&hermes_home(&state)?, input)?;
    Ok(true)
}

#[tauri::command]
pub fn ui_store_record_turn_stats(
    state: State<'_, AppState>,
    input: UiTurnStats,
) -> AppResult<bool> {
    ui_store::record_turn_stats(&hermes_home(&state)?, input)?;
    Ok(true)
}

#[tauri::command]
pub fn ui_store_get_turn_stats(
    state: State<'_, AppState>,
    input: UiTurnStatsQuery,
) -> AppResult<Vec<UiTurnStats>> {
    ui_store::get_turn_stats(&hermes_home(&state)?, &input.session_id)
}

#[tauri::command]
pub fn ui_store_record_event(state: State<'_, AppState>, input: UiEventInput) -> AppResult<bool> {
    ui_store::record_event(&hermes_home(&state)?, input)?;
    Ok(true)
}
