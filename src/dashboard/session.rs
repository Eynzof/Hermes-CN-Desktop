//! In-memory dashboard auth session store with HMAC-SHA256 signed tokens.
//!
//! This is the Rust port of `packages/dashboard/src/auth/crypto.ts` and
//! `packages/dashboard/src/auth/session-store.ts`.  It mirrors the TS token
//! format `"<id>.<hmac_sha256_hex(id)>"` byte-for-byte so Rust and TS can be
//! interchangeable (the desktop shell serves the Rust path; browser-only
//! dev keeps the TS twin).
//!
//! The secret is a raw byte string (UTF-8 of the configured secret string or a
//! random 32-byte hex string).  Signature/token comparisons use
//! `subtle::ConstantTimeEq` so they are constant-time.

use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};

use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

type HmacSha256 = Hmac<Sha256>;

/// Hex-encode a byte slice as lowercase hex (mirrors TS `toHex`).
pub fn to_hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        use std::fmt::Write;
        let _ = write!(s, "{:02x}", b);
    }
    s
}

/// SHA-256 digest of `message`, hex-encoded (mirrors TS `digestSha256`).
pub fn digest_sha256_hex(message: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(message.as_bytes());
    to_hex(&hasher.finalize())
}

/// HMAC-SHA256 of `message` under `secret` (raw key bytes), hex-encoded.
///
/// Mirrors TS `hmac(message, secret)` which keys HMAC with `encodeText(secret)`.
pub fn hmac_sha256_hex(message: &str, secret: &[u8]) -> String {
    let mut mac = HmacSha256::new_from_slice(secret).expect("HMAC accepts any key size");
    mac.update(message.as_bytes());
    to_hex(&mac.finalize().into_bytes())
}

/// Random bytes hex-encoded (mirrors TS `randomHex(bytes)`).
pub fn random_hex(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    getrandom::fill(&mut buf).expect("getrandom failed to produce randomness");
    to_hex(&buf)
}

/// A stored dashboard auth session (mirrors TS `Session`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    /// Stable session id (the access token's signed payload).
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    /// Short-lived bearer token presented to local handlers.
    pub access_token: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refresh_token: Option<String>,
    /// Epoch milliseconds; `None` means no expiry.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<i64>,
}

/// The subject + scopes resolved from a verified access token (mirrors TS
/// `TokenPrincipal`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TokenPrincipal {
    pub sub: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scopes: Option<Vec<String>>,
}

/// Input to `InMemorySessionStore::create_session` (mirrors TS
/// `CreateSessionInput`).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CreateSessionInput {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sub: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refresh_token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scopes: Option<Vec<String>>,
}

/// Internal stored session = visible `Session` + the principal it maps to.
#[derive(Debug, Clone)]
struct StoredSession {
    session: Session,
    principal: TokenPrincipal,
}

/// In-memory session store with HMAC-signed access tokens.
///
/// A stable secret makes token verification deterministic across restarts.
/// The default (no secret) is random-per-process and suitable only for tests.
pub struct InMemorySessionStore {
    secret: Vec<u8>,
    sessions: HashMap<String, StoredSession>,
    revoked: HashSet<String>,
}

impl InMemorySessionStore {
    /// Build a store. When `secret` is `None`, a random 32-byte hex secret is
    /// generated (matching the TS default `options.secret ?? randomHex(32)`).
    pub fn new(secret: Option<&str>) -> Self {
        let secret: Vec<u8> = match secret {
            Some(s) => s.as_bytes().to_vec(),
            None => random_hex(32).into_bytes(),
        };
        Self {
            secret,
            sessions: HashMap::new(),
            revoked: HashSet::new(),
        }
    }

    /// HMAC-SHA256 hex signature of `session_id` under this store's secret
    /// (mirrors TS `sign(sessionId)`).
    pub fn sign(&self, session_id: &str) -> String {
        hmac_sha256_hex(session_id, &self.secret)
    }

    /// The raw secret bytes (the HMAC key).
    pub fn secret(&self) -> &[u8] {
        &self.secret
    }

    /// The secret as a UTF-8 string (used by the static opaque-token check).
    /// The secret is always a valid UTF-8 string: either a user-supplied `&str`
    /// or the hex string from [`random_hex`].
    pub fn secret_str(&self) -> String {
        String::from_utf8_lossy(&self.secret).into_owned()
    }

    /// Create a session.
    ///
    /// Session id precedence: explicit `id` → `sub` → random 16-byte hex.
    /// Access token is `` `${id}.${sign(id)}` ``.
    pub fn create_session(&mut self, input: CreateSessionInput) -> Session {
        let id = input
            .id
            .clone()
            .or_else(|| input.sub.clone())
            .unwrap_or_else(|| random_hex(16));
        let access_token = format!("{}.{}", id, self.sign(&id));
        let principal = TokenPrincipal {
            sub: input.sub.clone().unwrap_or_else(|| id.clone()),
            scopes: Some(
                input
                    .scopes
                    .clone()
                    .unwrap_or_else(|| vec!["dashboard".to_string()]),
            ),
        };
        let session = Session {
            id: id.clone(),
            display_name: input.display_name,
            email: input.email,
            access_token: access_token.clone(),
            refresh_token: input.refresh_token,
            expires_at: input.expires_at,
        };
        self.sessions.insert(
            id.clone(),
            StoredSession {
                session: session.clone(),
                principal,
            },
        );
        session
    }

    /// Look up a stored session by id. Returns `None` if the id is unknown or
    /// has been revoked.
    pub fn get_session(&self, session_id: &str) -> Option<&Session> {
        if self.revoked.contains(session_id) {
            return None;
        }
        self.sessions.get(session_id).map(|s| &s.session)
    }

    /// Verify an access token of the form `id.signature`.
    ///
    /// Returns the session's principal when the token is signed correctly,
    /// not revoked, and (if `expires_at` is set) not expired relative to
    /// `now_ms`.  Signature comparison is constant-time.
    pub fn verify_access_token(&self, token: &str, now_ms: i64) -> Option<TokenPrincipal> {
        let dot = token.find('.')?;
        if dot == 0 {
            return None;
        }
        let session_id = &token[..dot];
        let signature = &token[dot + 1..];
        if self.revoked.contains(session_id) {
            return None;
        }
        let expected = self.sign(session_id);
        if expected.as_bytes().ct_eq(signature.as_bytes()).unwrap_u8() == 0 {
            return None;
        }
        let stored = self.sessions.get(session_id)?;
        if let Some(expires_at) = stored.session.expires_at {
            if expires_at < now_ms {
                return None;
            }
        }
        Some(stored.principal.clone())
    }

    /// Revoke a session id (idempotent).
    pub fn revoke_session(&mut self, session_id: &str) {
        self.revoked.insert(session_id.to_string());
    }
}

/// Process-global session store used by the Tauri commands.
///
/// v1 keeps sessions in memory. The secret is read from
/// `HERMES_DESKTOP_SESSION_SECRET` / `HERMES_DASHBOARD_SESSION_SECRET`, or a
/// random per-process secret when neither is present (matching the TS default).
pub fn global_session_store() -> &'static Mutex<InMemorySessionStore> {
    static STORE: OnceLock<Mutex<InMemorySessionStore>> = OnceLock::new();
    STORE.get_or_init(|| {
        let secret = std::env::var("HERMES_DESKTOP_SESSION_SECRET")
            .ok()
            .or_else(|| std::env::var("HERMES_DASHBOARD_SESSION_SECRET").ok())
            .filter(|s| !s.is_empty());
        Mutex::new(InMemorySessionStore::new(secret.as_deref()))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- auth/crypto.test.ts parity -------------------------------------

    #[test]
    fn to_hex_formats_uint8array_as_lowercase_hex() {
        assert_eq!(to_hex(&[0x00, 0x0f, 0x10, 0xff]), "000f10ff");
    }

    #[test]
    fn to_hex_accepts_empty_slice() {
        assert_eq!(to_hex(&[]), "");
    }

    #[test]
    fn to_hex_zero_pads_single_nibbles() {
        assert_eq!(to_hex(&[0x01, 0x0a]), "010a");
    }

    #[test]
    fn hmac_matches_rfc4231_test_case1() {
        // 20-byte key 0x0b…, data "Hi There".
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
    fn hmac_is_deterministic_for_same_message_and_secret() {
        let first = hmac_sha256_hex("session-id-1", b"test-secret");
        let second = hmac_sha256_hex("session-id-1", b"test-secret");
        assert_eq!(
            first,
            "37d64e66ad849bd6505cc891d19a77d720884ab257a99543dabbbc661c8224fd"
        );
        assert_eq!(second, first);
    }

    #[test]
    fn hmac_produces_different_signatures_for_different_secrets() {
        let a = hmac_sha256_hex("message", b"secret-a");
        let b = hmac_sha256_hex("message", b"secret-b");
        assert_ne!(a, b);
    }

    #[test]
    fn hmac_produces_different_signatures_for_different_messages() {
        let a = hmac_sha256_hex("message-1", b"secret");
        let b = hmac_sha256_hex("message-2", b"secret");
        assert_ne!(a, b);
    }

    #[test]
    fn hmac_returns_64_lowercase_hex_chars() {
        let sig = hmac_sha256_hex("any message", b"any secret");
        assert_eq!(sig.len(), 64);
        assert!(sig
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
    }

    #[test]
    fn digest_sha256_matches_fips_abc_vector() {
        assert_eq!(
            digest_sha256_hex("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn digest_sha256_matches_empty_string_vector() {
        assert_eq!(
            digest_sha256_hex(""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn digest_sha256_is_deterministic() {
        let a = digest_sha256_hex("hermes dashboard");
        let b = digest_sha256_hex("hermes dashboard");
        assert_eq!(
            a,
            "597404656ec00583c227b90ce8b20280f362c129d0527b10fa9fd34cc62c2398"
        );
        assert_eq!(b, a);
    }

    #[test]
    fn digest_sha256_differs_across_inputs() {
        assert_ne!(
            digest_sha256_hex("hermes dashboard"),
            digest_sha256_hex("hermes desktop")
        );
    }

    #[test]
    fn random_hex_returns_twice_requested_byte_count() {
        assert_eq!(random_hex(4).len(), 8);
        assert_eq!(random_hex(1).len(), 2);
        assert!(random_hex(4).chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn random_hex_defaults_to_32_hex_chars() {
        let r = random_hex(16);
        assert_eq!(r.len(), 32);
        assert!(r.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn random_hex_produces_distinct_values_across_calls() {
        assert_ne!(random_hex(8), random_hex(8));
    }

    // ---- auth/session-store.test.ts parity ------------------------------

    #[test]
    fn store_signs_access_tokens_deterministically_with_fixed_secret() {
        let mut store = InMemorySessionStore::new(Some("test-secret"));
        let session = store.create_session(CreateSessionInput {
            sub: Some("user-1".to_string()),
            ..Default::default()
        });
        assert_eq!(session.id, "user-1");
        assert_eq!(
            session.access_token,
            format!("user-1.{}", hmac_sha256_hex("user-1", b"test-secret"))
        );
        // Same id in a store with the same secret signs identically.
        let mut store2 = InMemorySessionStore::new(Some("test-secret"));
        let session2 = store2.create_session(CreateSessionInput {
            sub: Some("user-1".to_string()),
            ..Default::default()
        });
        assert_eq!(session2.access_token, session.access_token);
    }

    #[test]
    fn store_signs_differently_with_different_secret() {
        let mut a = InMemorySessionStore::new(Some("s1"));
        let mut b = InMemorySessionStore::new(Some("s2"));
        let sa = a.create_session(CreateSessionInput {
            sub: Some("u".to_string()),
            ..Default::default()
        });
        let sb = b.create_session(CreateSessionInput {
            sub: Some("u".to_string()),
            ..Default::default()
        });
        assert_ne!(sa.access_token, sb.access_token);
    }

    #[test]
    fn store_defaults_session_id_to_subject() {
        let mut store = InMemorySessionStore::new(Some("s"));
        let session = store.create_session(CreateSessionInput {
            sub: Some("subject-1".to_string()),
            display_name: Some("S".to_string()),
            ..Default::default()
        });
        assert_eq!(session.id, "subject-1");
    }

    #[test]
    fn store_prefers_explicit_id_over_subject() {
        let mut store = InMemorySessionStore::new(Some("s"));
        let session = store.create_session(CreateSessionInput {
            id: Some("explicit-id".to_string()),
            sub: Some("subject-1".to_string()),
            ..Default::default()
        });
        assert_eq!(session.id, "explicit-id");
    }

    #[test]
    fn store_generates_random_id_when_neither_given() {
        let mut store = InMemorySessionStore::new(Some("s"));
        let session = store.create_session(CreateSessionInput {
            display_name: Some("No Sub".to_string()),
            ..Default::default()
        });
        assert!(!session.id.is_empty());
        assert_ne!(session.id, "No Sub");
        assert!(session.id.len() >= 16);
    }

    #[test]
    fn store_passes_through_refresh_token_and_expiry() {
        let mut store = InMemorySessionStore::new(Some("s"));
        let expires_at = 1_800_000_000_000_i64; // 2030-01-01T00:00:00Z
        let session = store.create_session(CreateSessionInput {
            sub: Some("u".to_string()),
            refresh_token: Some("rt-1".to_string()),
            expires_at: Some(expires_at),
            ..Default::default()
        });
        assert_eq!(session.refresh_token.as_deref(), Some("rt-1"));
        assert_eq!(session.expires_at, Some(expires_at));
    }

    #[test]
    fn store_verifies_tokens_and_returns_principal_with_default_scopes() {
        let mut store = InMemorySessionStore::new(Some("s"));
        let session = store.create_session(CreateSessionInput {
            sub: Some("user-1".to_string()),
            ..Default::default()
        });
        let principal = store
            .verify_access_token(&session.access_token, 0)
            .expect("token should verify");
        assert_eq!(
            principal,
            TokenPrincipal {
                sub: "user-1".to_string(),
                scopes: Some(vec!["dashboard".to_string()]),
            }
        );
    }

    #[test]
    fn store_keeps_custom_scopes_on_principal() {
        let mut store = InMemorySessionStore::new(Some("s"));
        let session = store.create_session(CreateSessionInput {
            sub: Some("u".to_string()),
            scopes: Some(vec!["admin".to_string(), "dashboard".to_string()]),
            ..Default::default()
        });
        let principal = store
            .verify_access_token(&session.access_token, 0)
            .expect("token should verify");
        assert_eq!(
            principal.scopes,
            Some(vec!["admin".to_string(), "dashboard".to_string()])
        );
    }

    #[test]
    fn store_rejects_malformed_tokens() {
        let mut store = InMemorySessionStore::new(Some("s"));
        store.create_session(CreateSessionInput {
            sub: Some("user-1".to_string()),
            ..Default::default()
        });
        assert!(store.verify_access_token("", 0).is_none());
        assert!(store.verify_access_token("no-dot", 0).is_none());
        assert!(store.verify_access_token(".sig", 0).is_none());
        assert!(store.verify_access_token("user-1.", 0).is_none());
        assert!(store.verify_access_token("user-1.deadbeef", 0).is_none());
    }

    #[test]
    fn store_rejects_tokens_for_sessions_that_do_not_exist() {
        let store = InMemorySessionStore::new(Some("s"));
        let forged = format!("ghost.{}", hmac_sha256_hex("ghost", b"s"));
        assert!(store.verify_access_token(&forged, 0).is_none());
    }

    #[test]
    fn store_rejects_tokens_signed_for_different_session_id() {
        let mut store = InMemorySessionStore::new(Some("s"));
        store.create_session(CreateSessionInput {
            sub: Some("user-1".to_string()),
            ..Default::default()
        });
        let token = format!("user-2.{}", hmac_sha256_hex("user-1", b"s"));
        assert!(store.verify_access_token(&token, 0).is_none());
    }

    #[test]
    fn store_returns_null_for_expired_session() {
        let mut store = InMemorySessionStore::new(Some("s"));
        let past = 1_735_689_599_000_i64; // 2024-12-31T23:59:59Z
        let session = store.create_session(CreateSessionInput {
            sub: Some("u".to_string()),
            expires_at: Some(past),
            ..Default::default()
        });
        assert!(store
            .verify_access_token(&session.access_token, 1_735_689_600_000_i64)
            .is_none());
    }

    #[test]
    fn store_accepts_token_before_expiry_and_rejects_after() {
        let mut store = InMemorySessionStore::new(Some("s"));
        let now = 1_735_689_600_000_i64; // 2025-01-01T00:00:00Z
        let expires_at = 1_735_693_200_000_i64; // 2025-01-01T01:00:00Z
        let session = store.create_session(CreateSessionInput {
            sub: Some("u".to_string()),
            expires_at: Some(expires_at),
            ..Default::default()
        });
        assert!(store
            .verify_access_token(&session.access_token, now)
            .is_some());
        assert!(store
            .verify_access_token(&session.access_token, 1_735_696_800_000_i64) // 02:00
            .is_none());
    }

    #[test]
    fn store_get_session_returns_stored_session_with_access_token() {
        let mut store = InMemorySessionStore::new(Some("s"));
        let session = store.create_session(CreateSessionInput {
            sub: Some("u".to_string()),
            display_name: Some("U".to_string()),
            ..Default::default()
        });
        let stored = store.get_session("u").expect("session should exist");
        assert_eq!(stored.id, "u");
        assert_eq!(stored.display_name.as_deref(), Some("U"));
        assert_eq!(stored.access_token, session.access_token);
    }

    #[test]
    fn store_get_session_returns_null_for_unknown_sessions() {
        let store = InMemorySessionStore::new(Some("s"));
        assert!(store.get_session("nope").is_none());
    }

    #[test]
    fn revoke_session_makes_get_and_verify_null() {
        let mut store = InMemorySessionStore::new(Some("s"));
        let session = store.create_session(CreateSessionInput {
            sub: Some("u".to_string()),
            ..Default::default()
        });
        store.revoke_session("u");
        assert!(store.get_session("u").is_none());
        assert!(store
            .verify_access_token(&session.access_token, 0)
            .is_none());
    }

    #[test]
    fn revoking_unknown_session_is_noop() {
        let mut store = InMemorySessionStore::new(Some("s"));
        store.revoke_session("ghost");
        let session = store.create_session(CreateSessionInput {
            sub: Some("u".to_string()),
            ..Default::default()
        });
        assert!(store.get_session("u").is_some());
        assert!(store
            .verify_access_token(&session.access_token, 0)
            .is_some());
    }

    #[test]
    fn revoked_sessions_stay_revoked_even_with_valid_signature() {
        let mut store = InMemorySessionStore::new(Some("s"));
        let session = store.create_session(CreateSessionInput {
            sub: Some("u".to_string()),
            ..Default::default()
        });
        store.revoke_session("u");
        let token = format!("u.{}", hmac_sha256_hex("u", b"s"));
        assert_eq!(token, session.access_token);
        assert!(store.verify_access_token(&token, 0).is_none());
    }

    #[test]
    fn keeps_sessions_isolated_between_store_instances() {
        let mut store_a = InMemorySessionStore::new(Some("s"));
        let store_b = InMemorySessionStore::new(Some("s"));
        let a = store_a.create_session(CreateSessionInput {
            sub: Some("u".to_string()),
            ..Default::default()
        });
        assert!(store_b.get_session("u").is_none());
        assert!(store_b.verify_access_token(&a.access_token, 0).is_none());
    }
}
