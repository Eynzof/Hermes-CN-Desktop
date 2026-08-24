//! Tauri command wrappers for the dashboard auth session/token core.
//!
//! v1 keeps sessions in memory via the process-global store in
//! `crate::dashboard::session`. The secret is read from
//! `HERMES_DESKTOP_SESSION_SECRET` / `HERMES_DASHBOARD_SESSION_SECRET` or a
//! random per-process secret when neither is present (matching the TS default).
//!
//! NOTE: The commands accept `tauri::State<AppState>` per the repo convention,
//! but this phase does not add a field to `AppStateInner` (out of scope), so the
//! store is a process-global singleton. A later phase can move the store into
//! `AppState` once `AppStateInner` gains a `dashboard_session_secret` field.

use std::sync::Mutex;

use tauri::State;

use crate::dashboard::session::{
    global_session_store, CreateSessionInput, InMemorySessionStore, Session, TokenPrincipal,
};
use crate::dashboard::token::verify_opaque_token;
use crate::error::AppError;
use crate::state::AppState;

/// Create a new dashboard auth session (HMAC-signed access token).
#[tauri::command]
pub fn dashboard_session_create(
    input: CreateSessionInput,
    _state: State<'_, AppState>,
) -> Result<Session, AppError> {
    do_create_session(global_session_store(), input)
}

/// Verify a session access token of the form `id.signature`.
#[tauri::command]
pub fn dashboard_session_verify(
    token: String,
    _state: State<'_, AppState>,
) -> Result<Option<TokenPrincipal>, AppError> {
    do_verify_session(global_session_store(), token)
}

/// Revoke a session id (idempotent).
#[tauri::command]
pub fn dashboard_session_revoke(
    session_id: String,
    _state: State<'_, AppState>,
) -> Result<(), AppError> {
    do_revoke_session(global_session_store(), session_id)
}

/// Verify an opaque bearer token against the static token secret.
#[tauri::command]
pub fn dashboard_token_verify(
    token: String,
    _state: State<'_, AppState>,
) -> Result<Option<TokenPrincipal>, AppError> {
    do_token_verify(global_session_store(), token)
}

fn do_create_session(
    store: &Mutex<InMemorySessionStore>,
    input: CreateSessionInput,
) -> Result<Session, AppError> {
    let mut guard = store.lock()?;
    Ok(guard.create_session(input))
}

fn do_verify_session(
    store: &Mutex<InMemorySessionStore>,
    token: String,
) -> Result<Option<TokenPrincipal>, AppError> {
    let guard = store.lock()?;
    Ok(guard.verify_access_token(&token, now_ms()))
}

fn do_revoke_session(
    store: &Mutex<InMemorySessionStore>,
    session_id: String,
) -> Result<(), AppError> {
    let mut guard = store.lock()?;
    guard.revoke_session(&session_id);
    Ok(())
}

fn do_token_verify(
    store: &Mutex<InMemorySessionStore>,
    token: String,
) -> Result<Option<TokenPrincipal>, AppError> {
    let guard = store.lock()?;
    let secret = guard.secret_str();
    Ok(verify_opaque_token(&token, &secret))
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    fn fresh_store() -> Mutex<InMemorySessionStore> {
        Mutex::new(InMemorySessionStore::new(Some("test-secret")))
    }

    #[test]
    fn create_session_returns_signed_session() {
        let store = fresh_store();
        let session = do_create_session(
            &store,
            CreateSessionInput {
                sub: Some("user-1".to_string()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(session.id, "user-1");
        assert!(session.access_token.contains('.'));
    }

    #[test]
    fn verify_session_roundtrips_token() {
        let store = fresh_store();
        let session = do_create_session(
            &store,
            CreateSessionInput {
                sub: Some("user-1".to_string()),
                ..Default::default()
            },
        )
        .unwrap();
        let principal = do_verify_session(&store, session.access_token.clone()).unwrap();
        assert_eq!(principal.unwrap().sub, "user-1");
    }

    #[test]
    fn verify_session_rejects_tampered_token() {
        let store = fresh_store();
        let session = do_create_session(
            &store,
            CreateSessionInput {
                sub: Some("user-1".to_string()),
                ..Default::default()
            },
        )
        .unwrap();
        let tampered = session.access_token.replace("user-1.", "other.");
        assert!(do_verify_session(&store, tampered).unwrap().is_none());
    }

    #[test]
    fn revoke_session_invalidates_token() {
        let store = fresh_store();
        let session = do_create_session(
            &store,
            CreateSessionInput {
                sub: Some("user-1".to_string()),
                ..Default::default()
            },
        )
        .unwrap();
        do_revoke_session(&store, "user-1".to_string()).unwrap();
        assert!(do_verify_session(&store, session.access_token)
            .unwrap()
            .is_none());
    }

    #[test]
    fn token_verify_accepts_prefix_and_rejects_others() {
        let store = fresh_store();
        let secret = store.lock().unwrap().secret_str();
        assert!(do_token_verify(&store, format!("{secret}local"))
            .unwrap()
            .is_some());
        assert!(do_token_verify(&store, "bad".to_string())
            .unwrap()
            .is_none());
    }
}
