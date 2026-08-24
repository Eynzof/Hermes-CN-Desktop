//! Integration tests for the Rust gateway session module (pub API).
//!
//! Exercises `build_session_key`, `session_id_from_key` (golden parity) and the
//! `SessionStore` / `SessionMultiplexer` public surface.

use std::collections::HashSet;

use hermes_agent_cn::gateway::session::{
    build_session_key, session_id_from_key, BusyMode, ChatType, GatewaySession,
    InboundMessageEvent, MessagePart, RouteDecision, SessionMultiplexer, SessionMultiplexerOptions,
    SessionSource, SessionStore, DEFAULT_PROFILE,
};

fn source(chat_id: &str, user_id: &str) -> SessionSource {
    SessionSource {
        platform: "telegram".to_string(),
        chat_id: chat_id.to_string(),
        chat_type: ChatType::Dm,
        user_id: user_id.to_string(),
        thread_id: None,
        scope_id: None,
        profile: None,
    }
}

fn event(text: &str, user_id: &str) -> InboundMessageEvent {
    InboundMessageEvent {
        id: "e1".to_string(),
        platform: "telegram".to_string(),
        chat_id: "c1".to_string(),
        chat_type: ChatType::Dm,
        user_id: user_id.to_string(),
        username: None,
        thread_id: None,
        scope_id: None,
        parts: vec![MessagePart::Text {
            text: text.to_string(),
        }],
        raw: None,
        received_at: 0,
    }
}

#[test]
fn builds_byte_identical_session_key() {
    let mut s = source("99", "");
    assert_eq!(
        build_session_key(&s, DEFAULT_PROFILE),
        "agent:main:telegram:dm:99"
    );
    s.user_id = "42".to_string();
    assert_eq!(
        build_session_key(&s, DEFAULT_PROFILE),
        "agent:main:telegram:dm:99:42"
    );
}

#[test]
fn session_id_from_key_matches_golden_python_parity_vectors() {
    let cases = [
        ("agent:main:telegram:dm:99", "sess_00003339f7e4"),
        ("agent:main:telegram:dm:99:42", "sess_000046d72dd4"),
        ("agent:main:telegram:dm:c1:u1", "sess_000049236de4"),
        ("agent:main:telegram:group:g1", "sess_0000e4d13e72"),
    ];
    for (key, expected) in cases {
        assert_eq!(session_id_from_key(key), expected);
    }
}

#[test]
fn ensure_creates_and_reuses_sessions_by_key() {
    let mut store = SessionStore::new();
    let a = store.ensure(&source("c1", "u1"));
    let b = store.ensure(&source("c1", "u1"));
    assert_eq!(a.session_id, b.session_id);
    assert_eq!(store.get(&a.session_id).unwrap().session_key, a.session_key);
    assert_eq!(
        store.get_by_key(&a.session_key).unwrap().session_id,
        a.session_id
    );
}

#[test]
fn store_evicts_recently_active_cap() {
    let mut store = SessionStore::new();
    let mut ids = Vec::new();
    for i in 0..140 {
        let session = store.ensure(&source(&format!("c{}", i), &format!("u{}", i)));
        ids.push(session.session_id);
    }
    assert_eq!(ids.iter().filter(|id| store.get(id).is_some()).count(), 127);
}

#[test]
fn evict_idle_sessions_removes_only_stale() {
    let mut store = SessionStore::new();
    let old = store.ensure(&source("old", "u"));
    // A session older than the 1h TTL is removed (strict `>` threshold).
    let removed = store.evict_idle_sessions(old.last_active_at + 3600_000 + 1);
    assert_eq!(removed, 1);
    assert!(store.get(&old.session_id).is_none());

    // A session within the TTL is retained.
    let fresh = store.ensure(&source("fresh", "u"));
    let removed = store.evict_idle_sessions(fresh.last_active_at + 10);
    assert_eq!(removed, 0);
    assert!(store.get(&fresh.session_id).is_some());
}

#[test]
fn multiplexer_routes_slash_queue_and_admin_drop() {
    let mut store = SessionStore::new();
    let admins = HashSet::from(["admin".to_string()]);
    let mut mux = SessionMultiplexer::new(SessionMultiplexerOptions {
        busy_mode: BusyMode::Queue,
        admin_user_ids: Some(admins),
    });

    let slash = mux.route(&event("/help", "admin"), &mut store);
    assert!(matches!(slash, RouteDecision::Slash { command, .. } if command == "help"));

    let session = store.ensure(&source("c1", "admin"));
    mux.mark_busy(&session.session_id, true);
    let queued = mux.route(&event("hi", "admin"), &mut store);
    assert_eq!(
        queued,
        RouteDecision::Queue {
            session_id: session.session_id.clone()
        }
    );

    let unauthorized = mux.route(&event("hi", "user"), &mut store);
    assert_eq!(
        unauthorized,
        RouteDecision::DropAuth {
            reason: "unauthorized".to_string()
        }
    );
}

#[test]
fn gateway_session_serde_round_trip() {
    let session = GatewaySession {
        session_id: "sess_00003339f7e4".to_string(),
        session_key: "agent:main:telegram:dm:99".to_string(),
        platform: "telegram".to_string(),
        chat_id: "99".to_string(),
        chat_type: ChatType::Dm,
        user_id: "".to_string(),
        thread_id: None,
        scope_id: None,
        profile: None,
        title: None,
        model_override: None,
        created_at: 1,
        last_active_at: 1,
        restart_interrupted: None,
    };
    let json = serde_json::to_value(&session).unwrap();
    let round: GatewaySession = serde_json::from_value(json.clone()).unwrap();
    assert_eq!(round, session);
    assert_eq!(json["sessionId"], "sess_00003339f7e4");
}
