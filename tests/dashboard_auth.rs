//! Repo-root integration tests for the dashboard auth/session/token core.
//!
//! These exercise only the `pub` API of `hermes_agent_cn::dashboard`, with no
//! network or filesystem access. They pin the HMAC golden vectors (RFC 4231),
//! the `id.signature` token format, revocation, expiry, and opaque-token
//! verification.

use hermes_agent_cn::dashboard::session::{
    digest_sha256_hex, hmac_sha256_hex, random_hex, CreateSessionInput, InMemorySessionStore,
};
use hermes_agent_cn::dashboard::token::{verify_opaque_token, TokenAuthProvider};

#[test]
fn hmac_matches_rfc4231_test_case_1() {
    let key = "\u{000b}".repeat(20);
    assert_eq!(
        hmac_sha256_hex("Hi There", key.as_bytes()),
        "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7"
    );
}

#[test]
fn hmac_matches_quick_brown_fox_vector() {
    assert_eq!(
        hmac_sha256_hex("The quick brown fox jumps over the lazy dog", b"key"),
        "f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8"
    );
}

#[test]
fn digest_sha256_matches_fips_abc_vector() {
    assert_eq!(
        digest_sha256_hex("abc"),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
}

#[test]
fn random_hex_shape_matches_ts_random_hex() {
    let hex = random_hex(16);
    assert_eq!(hex.len(), 32);
    assert!(hex
        .chars()
        .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
}

#[test]
fn create_session_builds_id_signature_token() {
    let mut store = InMemorySessionStore::new(Some("test-secret"));
    let session = store.create_session(CreateSessionInput {
        sub: Some("user-1".to_string()),
        ..Default::default()
    });
    assert_eq!(session.id, "user-1");
    let expected_sig = hmac_sha256_hex("user-1", b"test-secret");
    assert_eq!(session.access_token, format!("user-1.{expected_sig}"));
}

#[test]
fn verify_access_token_returns_principal() {
    let mut store = InMemorySessionStore::new(Some("test-secret"));
    let session = store.create_session(CreateSessionInput {
        sub: Some("user-1".to_string()),
        scopes: Some(vec!["dashboard".to_string(), "admin".to_string()]),
        ..Default::default()
    });
    let principal = store.verify_access_token(&session.access_token, 0).unwrap();
    assert_eq!(principal.sub, "user-1");
    assert_eq!(
        principal.scopes,
        Some(vec!["dashboard".to_string(), "admin".to_string()])
    );
}

#[test]
fn verify_access_token_rejects_tampered_and_forged_tokens() {
    let mut store = InMemorySessionStore::new(Some("test-secret"));
    let session = store.create_session(CreateSessionInput {
        sub: Some("user-1".to_string()),
        ..Default::default()
    });
    // Tampered session id.
    let tampered = session.access_token.replacen("user-1.", "user-2.", 1);
    assert!(store.verify_access_token(&tampered, 0).is_none());
    // Forged valid signature for an unknown session id.
    let forged = format!("ghost.{}", hmac_sha256_hex("ghost", b"test-secret"));
    assert!(store.verify_access_token(&forged, 0).is_none());
    // Malformed tokens.
    assert!(store.verify_access_token("", 0).is_none());
    assert!(store.verify_access_token("no-dot", 0).is_none());
    assert!(store.verify_access_token(".sig", 0).is_none());
    assert!(store.verify_access_token("user-1.", 0).is_none());
}

#[test]
fn revoke_session_invalidates_both_get_and_verify() {
    let mut store = InMemorySessionStore::new(Some("test-secret"));
    let session = store.create_session(CreateSessionInput {
        sub: Some("user-1".to_string()),
        ..Default::default()
    });
    assert!(store.get_session("user-1").is_some());
    assert!(store
        .verify_access_token(&session.access_token, 0)
        .is_some());

    store.revoke_session("user-1");
    assert!(store.get_session("user-1").is_none());
    assert!(store
        .verify_access_token(&session.access_token, 0)
        .is_none());
    // Revoking an unknown id is a no-op.
    store.revoke_session("ghost");
}

#[test]
fn verify_access_token_respects_expiry() {
    let mut store = InMemorySessionStore::new(Some("test-secret"));
    let expires_at = 1_735_693_200_000_i64; // 2025-01-01T01:00:00Z
    let session = store.create_session(CreateSessionInput {
        sub: Some("user-1".to_string()),
        expires_at: Some(expires_at),
        ..Default::default()
    });
    assert!(store
        .verify_access_token(&session.access_token, 1_735_689_600_000_i64)
        .is_some());
    assert!(store
        .verify_access_token(&session.access_token, 1_735_696_800_000_i64)
        .is_none());
}

#[test]
fn keep_sessions_isolated_across_instances() {
    let mut store_a = InMemorySessionStore::new(Some("test-secret"));
    let store_b = InMemorySessionStore::new(Some("test-secret"));
    let session = store_a.create_session(CreateSessionInput {
        sub: Some("u".to_string()),
        ..Default::default()
    });
    assert!(store_b.get_session("u").is_none());
    assert!(store_b
        .verify_access_token(&session.access_token, 0)
        .is_none());
}

#[test]
fn verify_opaque_token_defaults_to_service_principal() {
    let principal = verify_opaque_token("hsk-local", "hsk-").expect("should accept");
    assert_eq!(principal.sub, "service");
    assert!(principal.scopes.is_none());
    assert!(verify_opaque_token("other", "hsk-").is_none());
    assert!(verify_opaque_token("hsk", "hsk-").is_none());
}

#[test]
fn token_auth_provider_verifies_token_and_session() {
    let mut store = InMemorySessionStore::new(Some("test-secret"));
    let provider = TokenAuthProvider::new("hsk-");
    let session = store.create_session(CreateSessionInput {
        sub: Some("service".to_string()),
        display_name: Some("Service Account".to_string()),
        scopes: Some(vec!["dashboard".to_string()]),
        ..Default::default()
    });
    let verified = provider
        .verify_session("hsk-whatever", &store)
        .expect("should verify session");
    assert_eq!(verified.id, session.id);
    assert_eq!(verified.display_name.as_deref(), Some("Service Account"));
    assert_eq!(verified.access_token, "hsk-whatever");
    // A token that does not match the prefix is rejected.
    assert!(provider.verify_session("wrong-prefix", &store).is_none());
}
