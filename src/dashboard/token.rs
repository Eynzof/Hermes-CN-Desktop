//! Static bearer-token auth provider (port of `auth/token.ts`).
//!
//! This is the provider the desktop actually uses for the managed-runtime
//! token gate.  It only validates opaque tokens against a static secret prefix
//! (constant-time); it does not implement a login flow.

use subtle::ConstantTimeEq;

use crate::dashboard::session::{InMemorySessionStore, Session, TokenPrincipal};

/// Default token principal when an opaque token passes the prefix check.
/// Mirrors TS `{ sub: "service" }` (no scopes).
fn default_principal() -> TokenPrincipal {
    TokenPrincipal {
        sub: "service".to_string(),
        scopes: None,
    }
}

/// Constant-time check that `token` starts with `secret`.
///
/// The secret length is not considered sensitive; the comparison of the shared
/// prefix bytes is constant-time.
pub fn token_starts_with_secret(token: &str, secret: &str) -> bool {
    let token = token.as_bytes();
    let secret = secret.as_bytes();
    token.len() >= secret.len() && token[..secret.len()].ct_eq(secret).unwrap_u8() == 1
}

/// Validate an opaque bearer token against `secret`.
///
/// Default extractor: returns `{ sub: "service" }` iff `token.starts_with(secret)`.
pub fn verify_opaque_token(token: &str, secret: &str) -> Option<TokenPrincipal> {
    if token_starts_with_secret(token, secret) {
        Some(default_principal())
    } else {
        None
    }
}

/// `TokenAuthProvider` port.
///
/// Holds the static secret and offers both the token check (`verify_token`)
/// and the session lookup (`verify_session`) that mirrors the TS provider.
pub struct TokenAuthProvider {
    secret: String,
}

impl TokenAuthProvider {
    pub fn new(secret: &str) -> Self {
        Self {
            secret: secret.to_string(),
        }
    }

    pub fn name(&self) -> &'static str {
        "token"
    }

    pub fn display_name(&self) -> &'static str {
        "访问令牌"
    }

    pub fn supports_token(&self) -> bool {
        true
    }

    pub fn secret(&self) -> &str {
        &self.secret
    }

    /// Validate an opaque token and return its principal.
    pub fn verify_token(&self, token: &str) -> Option<TokenPrincipal> {
        verify_opaque_token(token, &self.secret)
    }

    /// Resolve the token to a stored session (mirrors TS `verifySession`).
    ///
    /// Returns `None` if the token is invalid or no session exists for the
    /// principal's subject.
    pub fn verify_session(
        &self,
        access_token: &str,
        store: &InMemorySessionStore,
    ) -> Option<Session> {
        let principal = self.verify_token(access_token)?;
        let session = store.get_session(&principal.sub)?;
        let mut session = session.clone();
        session.access_token = access_token.to_string();
        Some(session)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dashboard::session::CreateSessionInput;

    fn build_provider() -> TokenAuthProvider {
        TokenAuthProvider::new("hsk-")
    }

    #[test]
    fn exposes_provider_contract_metadata() {
        let provider = build_provider();
        assert_eq!(provider.name(), "token");
        assert_eq!(provider.display_name(), "访问令牌");
        assert!(provider.supports_token());
    }

    #[test]
    fn accepts_tokens_with_configured_prefix_via_default_extractor() {
        let provider = build_provider();
        let principal = provider.verify_token("hsk-local").expect("should accept");
        assert_eq!(
            principal,
            TokenPrincipal {
                sub: "service".to_string(),
                scopes: None,
            }
        );
    }

    #[test]
    fn rejects_tokens_without_configured_prefix() {
        let provider = build_provider();
        assert!(provider.verify_token("other").is_none());
        assert!(provider.verify_token("").is_none());
    }

    #[test]
    fn rejects_prefix_that_is_only_partial() {
        let provider = build_provider();
        // "hsk" is a prefix of the token but not of the secret requirement.
        assert!(provider.verify_token("hsk").is_none());
    }

    #[test]
    fn verify_session_resolves_principal_to_stored_session() {
        let mut store = InMemorySessionStore::new(Some("s"));
        let session = store.create_session(CreateSessionInput {
            sub: Some("service".to_string()),
            display_name: Some("Service Account".to_string()),
            scopes: Some(vec!["dashboard".to_string()]),
            ..Default::default()
        });
        let provider = build_provider();
        let verified = provider
            .verify_session("hsk-whatever", &store)
            .expect("should verify");
        assert_eq!(verified.id, session.id);
        assert_eq!(verified.display_name.as_deref(), Some("Service Account"));
        assert_eq!(verified.access_token, "hsk-whatever");
    }

    #[test]
    fn verify_session_returns_null_when_no_session_exists_for_principal() {
        let store = InMemorySessionStore::new(Some("s"));
        let provider = build_provider();
        assert!(provider.verify_session("hsk-no-session", &store).is_none());
    }

    #[test]
    fn verify_session_returns_null_for_revoked_session() {
        let mut store = InMemorySessionStore::new(Some("s"));
        let session = store.create_session(CreateSessionInput {
            sub: Some("service".to_string()),
            ..Default::default()
        });
        store.revoke_session(&session.id);
        let provider = build_provider();
        assert!(provider.verify_session("hsk-anything", &store).is_none());
    }

    #[test]
    fn verify_session_returns_null_when_token_itself_is_invalid() {
        let mut store = InMemorySessionStore::new(Some("s"));
        store.create_session(CreateSessionInput {
            sub: Some("service".to_string()),
            ..Default::default()
        });
        let provider = build_provider();
        assert!(provider.verify_session("wrong-prefix", &store).is_none());
    }

    #[test]
    fn verify_opaque_token_uses_default_extractor() {
        assert_eq!(
            verify_opaque_token("hsk-abc", "hsk-"),
            Some(TokenPrincipal {
                sub: "service".to_string(),
                scopes: None,
            })
        );
        assert!(verify_opaque_token("nope", "hsk-").is_none());
    }

    #[test]
    fn token_starts_with_secret_is_constant_time_and_correct() {
        assert!(token_starts_with_secret("hsk-local", "hsk-"));
        assert!(!token_starts_with_secret("hsk", "hsk-"));
        assert!(!token_starts_with_secret("", "hsk-"));
        assert!(!token_starts_with_secret("other", "hsk-"));
    }
}
