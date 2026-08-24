//! Narrow Tauri command wrappers for the Rust gateway core (sessions + ledger).
//!
//! Session state is held in a process-global `GatewayState` until it can be
//! moved into `AppStateInner` (that wiring belongs to the task owning
//! `src/state.rs`). Delivery commands open the SQLite ledger per call using the
//! `hermes_home` from `AppState`.

use std::sync::{Mutex, OnceLock};

use tauri::State;

use crate::error::{AppError, AppResult};
use crate::gateway::delivery::{DeliveryLedger, DeliveryRow, OutboundPayload};
use crate::gateway::session::{GatewaySession, InboundMessageEvent, RouteDecision, SessionSource};
use crate::gateway::GatewayState;
use crate::state::AppState;

static GATEWAY_STATE: OnceLock<Mutex<GatewayState>> = OnceLock::new();

fn gateway_state() -> &'static Mutex<GatewayState> {
    GATEWAY_STATE.get_or_init(|| Mutex::new(GatewayState::new()))
}

/// Route an inbound gateway event through the session store + multiplexer.
#[tauri::command]
pub fn gateway_session_route(event: InboundMessageEvent) -> AppResult<RouteDecision> {
    let mut state = gateway_state()
        .lock()
        .map_err(|_| AppError::StateLockPoisoned)?;
    let state = &mut *state;
    Ok(state.multiplexer.route(&event, &mut state.sessions))
}

/// Ensure a session exists for the given source (reusing by key when present).
#[tauri::command]
pub fn gateway_session_ensure(source: SessionSource) -> AppResult<GatewaySession> {
    let mut state = gateway_state()
        .lock()
        .map_err(|_| AppError::StateLockPoisoned)?;
    Ok(state.sessions.ensure(&source))
}

/// Refresh `lastActiveAt` for a session id.
#[tauri::command]
pub fn gateway_session_touch(session_id: String) -> AppResult<()> {
    let mut state = gateway_state()
        .lock()
        .map_err(|_| AppError::StateLockPoisoned)?;
    state.sessions.touch(&session_id);
    Ok(())
}

/// Evict idle sessions. `now_ms` defaults to the current wall clock when absent.
#[tauri::command]
pub fn gateway_session_evict_idle(now_ms: Option<i64>) -> AppResult<usize> {
    let mut state = gateway_state()
        .lock()
        .map_err(|_| AppError::StateLockPoisoned)?;
    let now = now_ms.unwrap_or_else(|| {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0)
    });
    Ok(state.sessions.evict_idle_sessions(now))
}

/// Mark a session as busy (affects subsequent `route` busy-mode decisions).
#[tauri::command]
pub fn gateway_session_mark_busy(session_id: String, busy: bool) -> AppResult<()> {
    let mut state = gateway_state()
        .lock()
        .map_err(|_| AppError::StateLockPoisoned)?;
    state.multiplexer.mark_busy(&session_id, busy);
    Ok(())
}

fn hermes_home(state: &State<'_, AppState>) -> AppResult<String> {
    let inner = state.inner.lock()?;
    Ok(inner.hermes_home.clone())
}

/// Begin a new delivery row (SQLite-persisted).
#[tauri::command]
pub fn gateway_delivery_begin(
    state: State<'_, AppState>,
    session_id: String,
    platform: String,
    chat_id: String,
    payload: OutboundPayload,
) -> AppResult<DeliveryRow> {
    let home = hermes_home(&state)?;
    let mut ledger = DeliveryLedger::sqlite(&home)?;
    ledger.begin(&session_id, &platform, &chat_id, &payload)
}

/// Mark a delivery row as delivered.
#[tauri::command]
pub fn gateway_delivery_ack(state: State<'_, AppState>, row_id: String) -> AppResult<()> {
    let home = hermes_home(&state)?;
    let mut ledger = DeliveryLedger::sqlite(&home)?;
    ledger.ack(&row_id)
}

/// Mark a delivery row as failed (incrementing attempts).
#[tauri::command]
pub fn gateway_delivery_fail(
    state: State<'_, AppState>,
    row_id: String,
    error: Option<String>,
) -> AppResult<()> {
    let home = hermes_home(&state)?;
    let mut ledger = DeliveryLedger::sqlite(&home)?;
    ledger.fail(&row_id, error.as_deref())
}

/// Recover stale pending/sending rows at boot (prefixes them with the recycle
/// glyph and fails rows past freshness/attempt limits).
#[tauri::command]
pub fn gateway_delivery_redeliver_on_boot(
    state: State<'_, AppState>,
) -> AppResult<Vec<DeliveryRow>> {
    let home = hermes_home(&state)?;
    let mut ledger = DeliveryLedger::sqlite(&home)?;
    ledger.redeliver_on_boot()
}

/// Dedupe check for a media path within a session.
#[tauri::command]
pub fn gateway_delivery_dedupe_media(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
    explicit: bool,
) -> AppResult<bool> {
    let home = hermes_home(&state)?;
    let ledger = DeliveryLedger::sqlite(&home)?;
    ledger.dedupe_media(&session_id, &path, explicit)
}

/// List delivery rows for a session.
#[tauri::command]
pub fn gateway_delivery_list_for_session(
    state: State<'_, AppState>,
    session_id: String,
) -> AppResult<Vec<DeliveryRow>> {
    let home = hermes_home(&state)?;
    let ledger = DeliveryLedger::sqlite(&home)?;
    ledger.list_for_session(&session_id)
}
