//! Status/health/version and auth route handlers (port of `routes/status.ts`
//! and `routes/auth.ts`).
//!
//! Route handlers are pure (no I/O); auth handlers that mutate the session
//! store lock the `Mutex<InMemorySessionStore>` provided at registration.

use std::collections::HashMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::dashboard::router::{DashboardRouter, FnHandler, RequestContext};
use crate::dashboard::session::{
    CreateSessionInput, InMemorySessionStore, Session, TokenPrincipal,
};
use crate::dashboard::token::verify_opaque_token;

type VerifyTokenFn = Box<dyn Fn(&str) -> Option<TokenPrincipal> + Send + Sync>;
type CompletePasswordLoginFn =
    Box<dyn Fn(&str, &str, &mut InMemorySessionStore) -> Option<Session> + Send + Sync>;
type RefreshSessionFn =
    Box<dyn Fn(&str, &mut InMemorySessionStore) -> Option<Session> + Send + Sync>;
type VerifyPasswordFn = Box<dyn Fn(&str, &str) -> bool + Send + Sync>;

/// Options for [`register_status_routes`].
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StatusOpts {
    #[serde(default = "default_version")]
    pub version: String,
    /// `"managed"`, `"local"` or `"remote"`.
    #[serde(default = "default_connection_mode")]
    pub connection_mode: String,
}

impl Default for StatusOpts {
    fn default() -> Self {
        Self {
            version: default_version(),
            connection_mode: default_connection_mode(),
        }
    }
}

fn default_version() -> String {
    "0.0.0".to_string()
}

fn default_connection_mode() -> String {
    "managed".to_string()
}

/// A provider descriptor + injected callbacks used by [`register_auth_routes`].
///
/// Mirrors the TS `DashboardAuthProvider` contract but only for the parts Rust
/// implements in this phase: static token validation, password login, and
/// session refresh (Basic/OIDC remain TS-side in the browser-only path).
pub struct ProviderRef {
    pub name: String,
    pub display_name: String,
    pub supports_password: bool,
    pub supports_token: bool,
    pub supports_refresh: bool,
    pub verify_token: Option<VerifyTokenFn>,
    pub complete_password_login: Option<CompletePasswordLoginFn>,
    pub refresh_session: Option<RefreshSessionFn>,
}

impl ProviderRef {
    /// Build a token provider descriptor (mirrors `TokenAuthProvider`).
    pub fn token(secret: &str) -> Self {
        let secret = secret.to_string();
        Self {
            name: "token".to_string(),
            display_name: "访问令牌".to_string(),
            supports_password: false,
            supports_token: true,
            supports_refresh: false,
            verify_token: Some(Box::new(move |token| verify_opaque_token(token, &secret))),
            complete_password_login: None,
            refresh_session: None,
        }
    }

    /// Build a password provider descriptor (mirrors `BasicAuthProvider`).
    pub fn basic(users: HashMap<String, String>, verify_password: VerifyPasswordFn) -> Self {
        Self {
            name: "basic".to_string(),
            display_name: "用户名 / 密码".to_string(),
            supports_password: true,
            supports_token: false,
            supports_refresh: false,
            verify_token: None,
            complete_password_login: Some(Box::new(move |username, password, store| {
                let hash = users.get(username)?;
                if !verify_password(password, hash) {
                    return None;
                }
                Some(store.create_session(CreateSessionInput {
                    sub: Some(format!("basic:{username}")),
                    display_name: Some(username.to_string()),
                    scopes: Some(vec!["dashboard".to_string()]),
                    ..Default::default()
                }))
            })),
            refresh_session: None,
        }
    }
}

/// Register `/api/status`, `/api/health` and `/api/version`.
pub fn register_status_routes<'a>(router: &mut DashboardRouter<'a>, opts: StatusOpts) {
    let status_version = opts.version.clone();
    let status_connection_mode = opts.connection_mode.clone();
    let version_version = opts.version.clone();

    router.register(
        "/api/status",
        "GET",
        FnHandler(move |_| {
            serde_json::json!({
                "ok": true,
                "platform": "desktop",
                "version": status_version,
                "connection_mode": status_connection_mode,
            })
        }),
    );

    router.register(
        "/api/health",
        "GET",
        FnHandler(|_| serde_json::json!({ "ok": true })),
    );

    router.register(
        "/api/version",
        "GET",
        FnHandler(move |_| {
            serde_json::json!({
                "version": version_version,
                "platform": "desktop",
            })
        }),
    );
}

fn body_str<'a>(body: &'a serde_json::Value, key: &str) -> Option<&'a str> {
    body.get(key).and_then(|v| v.as_str())
}

fn session_summary_json(session: &Session) -> serde_json::Value {
    serde_json::json!({
        "id": session.id,
        "displayName": session.display_name,
    })
}

/// Register the auth routes against `router`.
///
/// `store` and `providers` are captured by reference, so the returned router's
/// lifetime is tied to them.
pub fn register_auth_routes<'a>(
    router: &mut DashboardRouter<'a>,
    store: &'a Mutex<InMemorySessionStore>,
    providers: &'a [ProviderRef],
) {
    router.register(
        "/api/auth/providers",
        "GET",
        FnHandler(move |_| {
            let list: Vec<serde_json::Value> = providers
                .iter()
                .map(|p| {
                    serde_json::json!({
                        "name": p.name,
                        "displayName": p.display_name,
                        "supportsPassword": p.supports_password,
                        "supportsToken": p.supports_token,
                    })
                })
                .collect();
            serde_json::json!({ "providers": list })
        }),
    );

    router.register(
        "/api/auth/me",
        "GET",
        FnHandler(|_| {
            serde_json::json!({
                "ok": true,
                "user": { "sub": "desktop-local", "name": "Desktop User" },
            })
        }),
    );

    router.register(
        "/api/auth/password-login",
        "POST",
        FnHandler(move |ctx: RequestContext| {
            let username = body_str(&ctx.body, "username").unwrap_or("");
            let password = body_str(&ctx.body, "password").unwrap_or("");

            let provider = providers
                .iter()
                .find(|p| p.supports_password && p.complete_password_login.is_some());

            let Some(provider) = provider else {
                return serde_json::json!({ "ok": false, "error": "password login is not configured" });
            };

            let mut guard = store.lock().expect("session store poisoned");
            let session =
                (provider.complete_password_login.as_ref().unwrap())(username, password, &mut guard);
            match session {
                Some(session) => serde_json::json!({ "ok": true, "session": session_summary_json(&session) }),
                None => serde_json::json!({ "ok": false, "error": "invalid username or password" }),
            }
        }),
    );

    router.register(
        "/api/auth/token-login",
        "POST",
        FnHandler(move |ctx: RequestContext| {
            let token = body_str(&ctx.body, "token").unwrap_or("");

            let provider = providers.iter().find(|p| p.supports_token);
            let Some(provider) = provider else {
                return serde_json::json!({ "ok": false, "error": "token login is not configured" });
            };
            let Some(verify_token) = &provider.verify_token else {
                return serde_json::json!({ "ok": false, "error": "token login is not configured" });
            };

            let Some(principal) = verify_token(token) else {
                return serde_json::json!({ "ok": false, "error": "invalid token" });
            };

            let scopes = principal
                .scopes
                .clone()
                .unwrap_or_else(|| vec!["dashboard".to_string()]);
            let session = {
                let mut guard = store.lock().expect("session store poisoned");
                guard.create_session(CreateSessionInput {
                    sub: Some(principal.sub.clone()),
                    display_name: Some(principal.sub.clone()),
                    scopes: Some(scopes),
                    ..Default::default()
                })
            };
            serde_json::json!({ "ok": true, "session": session_summary_json(&session) })
        }),
    );

    router.register(
        "/api/auth/logout",
        "POST",
        FnHandler(move |ctx: RequestContext| {
            if let Some(session_id) = body_str(&ctx.body, "session_id") {
                let mut guard = store.lock().expect("session store poisoned");
                guard.revoke_session(session_id);
            }
            serde_json::json!({ "ok": true })
        }),
    );

    router.register(
        "/api/auth/refresh",
        "POST",
        FnHandler(move |ctx: RequestContext| {
            let Some(refresh_token) = body_str(&ctx.body, "refresh_token") else {
                return serde_json::json!({ "ok": false, "error": "missing refresh token" });
            };

            for provider in providers.iter() {
                if let Some(refresh) = &provider.refresh_session {
                    let mut guard = store.lock().expect("session store poisoned");
                    if let Some(session) = refresh(refresh_token, &mut guard) {
                        return serde_json::json!({ "ok": true, "session": session });
                    }
                }
            }
            serde_json::json!({ "ok": false, "error": "invalid refresh token" })
        }),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    fn get(router: &DashboardRouter<'_>, path: &str) -> serde_json::Value {
        router.handle(RequestContext {
            path: path.to_string(),
            method: "GET".to_string(),
            body: serde_json::Value::Null,
            headers: HashMap::new(),
        })
    }

    fn post(
        router: &DashboardRouter<'_>,
        path: &str,
        body: serde_json::Value,
    ) -> serde_json::Value {
        router.handle(RequestContext {
            path: path.to_string(),
            method: "POST".to_string(),
            body,
            headers: HashMap::new(),
        })
    }

    // ---- routes/status.test.ts parity -----------------------------------

    #[test]
    fn status_registers_api_status_with_defaults() {
        let mut router = DashboardRouter::new();
        register_status_routes(&mut router, StatusOpts::default());
        assert_eq!(
            get(&router, "/api/status"),
            serde_json::json!({
                "ok": true,
                "platform": "desktop",
                "version": "0.0.0",
                "connection_mode": "managed",
            })
        );
    }

    #[test]
    fn status_reflects_configured_version_and_connection_mode() {
        let mut router = DashboardRouter::new();
        register_status_routes(
            &mut router,
            StatusOpts {
                version: "0.8.0-rc4".to_string(),
                connection_mode: "local".to_string(),
            },
        );
        let result = get(&router, "/api/status");
        assert_eq!(result["version"], "0.8.0-rc4");
        assert_eq!(result["connection_mode"], "local");
        assert_eq!(result["ok"], true);
        assert_eq!(result["platform"], "desktop");
    }

    #[test]
    fn status_supports_every_connection_mode_variant() {
        for mode in ["managed", "local", "remote"] {
            let mut router = DashboardRouter::new();
            register_status_routes(
                &mut router,
                StatusOpts {
                    version: "1.0.0".to_string(),
                    connection_mode: mode.to_string(),
                },
            );
            let result = get(&router, "/api/status");
            assert_eq!(result["connection_mode"], mode);
        }
    }

    #[test]
    fn status_registers_api_health() {
        let mut router = DashboardRouter::new();
        register_status_routes(&mut router, StatusOpts::default());
        assert_eq!(
            get(&router, "/api/health"),
            serde_json::json!({ "ok": true })
        );
    }

    #[test]
    fn status_registers_api_version_with_version_and_platform() {
        let mut router = DashboardRouter::new();
        register_status_routes(
            &mut router,
            StatusOpts {
                version: "0.8.0-rc4".to_string(),
                connection_mode: "remote".to_string(),
            },
        );
        assert_eq!(
            get(&router, "/api/version"),
            serde_json::json!({ "version": "0.8.0-rc4", "platform": "desktop" })
        );
    }

    #[test]
    fn status_does_not_register_unrelated_routes() {
        let mut router = DashboardRouter::new();
        register_status_routes(&mut router, StatusOpts::default());
        assert!(router.resolve("/api/status", "POST").is_none());
        assert!(router.resolve("/api/nonexistent", "GET").is_none());
    }

    // ---- routes/auth.test.ts parity -------------------------------------

    fn basic_and_token_providers() -> Vec<ProviderRef> {
        let mut users = HashMap::new();
        users.insert("admin".to_string(), "admin-hash".to_string());
        vec![
            ProviderRef::basic(users, Box::new(|password, hash| password == hash)),
            ProviderRef::token("hsk-"),
        ]
    }

    #[test]
    fn auth_providers_lists_provider_capabilities() {
        let store = ::std::sync::Mutex::new(InMemorySessionStore::new(Some("test-secret")));
        let providers = basic_and_token_providers();
        let mut router = DashboardRouter::new();
        register_auth_routes(&mut router, &store, &providers);
        let result = get(&router, "/api/auth/providers");
        let list = result["providers"].as_array().expect("providers array");
        let by_name: HashMap<&str, &serde_json::Value> = list
            .iter()
            .map(|p| (p["name"].as_str().unwrap(), p))
            .collect();
        assert_eq!(by_name["basic"]["supportsPassword"], true);
        assert_eq!(by_name["basic"]["supportsToken"], false);
        assert_eq!(by_name["token"]["supportsPassword"], false);
        assert_eq!(by_name["token"]["supportsToken"], true);
    }

    #[test]
    fn auth_me_returns_local_desktop_user() {
        let store = ::std::sync::Mutex::new(InMemorySessionStore::new(Some("test-secret")));
        let providers = basic_and_token_providers();
        let mut router = DashboardRouter::new();
        register_auth_routes(&mut router, &store, &providers);
        let result = get(&router, "/api/auth/me");
        assert_eq!(result["ok"], true);
        assert_eq!(result["user"]["sub"], "desktop-local");
        assert_eq!(result["user"]["name"], "Desktop User");
    }

    #[test]
    fn auth_password_login_succeeds_with_correct_credentials() {
        let store = ::std::sync::Mutex::new(InMemorySessionStore::new(Some("test-secret")));
        let providers = basic_and_token_providers();
        let mut router = DashboardRouter::new();
        register_auth_routes(&mut router, &store, &providers);
        let result = post(
            &router,
            "/api/auth/password-login",
            serde_json::json!({ "username": "admin", "password": "admin-hash" }),
        );
        assert_eq!(result["ok"], true);
        assert_eq!(result["session"]["displayName"], "admin");
        assert_eq!(result["session"]["id"], "basic:admin");
    }

    #[test]
    fn auth_password_login_rejects_wrong_credentials() {
        let store = ::std::sync::Mutex::new(InMemorySessionStore::new(Some("test-secret")));
        let providers = basic_and_token_providers();
        let mut router = DashboardRouter::new();
        register_auth_routes(&mut router, &store, &providers);
        let result = post(
            &router,
            "/api/auth/password-login",
            serde_json::json!({ "username": "admin", "password": "wrong" }),
        );
        assert_eq!(
            result,
            serde_json::json!({ "ok": false, "error": "invalid username or password" })
        );
    }

    #[test]
    fn auth_password_login_rejects_missing_or_non_string_fields() {
        let store = ::std::sync::Mutex::new(InMemorySessionStore::new(Some("test-secret")));
        let providers = basic_and_token_providers();
        let mut router = DashboardRouter::new();
        register_auth_routes(&mut router, &store, &providers);
        assert_eq!(
            post(
                &router,
                "/api/auth/password-login",
                serde_json::json!({ "username": "admin" })
            ),
            serde_json::json!({ "ok": false, "error": "invalid username or password" })
        );
        assert_eq!(
            post(
                &router,
                "/api/auth/password-login",
                serde_json::json!({ "username": 42, "password": 42 })
            ),
            serde_json::json!({ "ok": false, "error": "invalid username or password" })
        );
        assert_eq!(
            post(&router, "/api/auth/password-login", serde_json::Value::Null),
            serde_json::json!({ "ok": false, "error": "invalid username or password" })
        );
    }

    #[test]
    fn auth_password_login_fails_when_no_password_provider_configured() {
        let store = ::std::sync::Mutex::new(InMemorySessionStore::new(Some("test-secret")));
        let providers: Vec<ProviderRef> = Vec::new();
        let mut router = DashboardRouter::new();
        register_auth_routes(&mut router, &store, &providers);
        let result = post(
            &router,
            "/api/auth/password-login",
            serde_json::json!({ "username": "admin", "password": "x" }),
        );
        assert_eq!(
            result,
            serde_json::json!({ "ok": false, "error": "password login is not configured" })
        );
    }

    #[test]
    fn auth_token_login_succeeds_with_valid_token() {
        let store = ::std::sync::Mutex::new(InMemorySessionStore::new(Some("test-secret")));
        let providers = basic_and_token_providers();
        let mut router = DashboardRouter::new();
        register_auth_routes(&mut router, &store, &providers);
        let result = post(
            &router,
            "/api/auth/token-login",
            serde_json::json!({ "token": "hsk-local" }),
        );
        assert_eq!(result["ok"], true);
        assert_eq!(result["session"]["id"], "service");
        assert_eq!(result["session"]["displayName"], "service");
    }

    #[test]
    fn auth_token_login_rejects_invalid_tokens() {
        let store = ::std::sync::Mutex::new(InMemorySessionStore::new(Some("test-secret")));
        let providers = basic_and_token_providers();
        let mut router = DashboardRouter::new();
        register_auth_routes(&mut router, &store, &providers);
        assert_eq!(
            post(
                &router,
                "/api/auth/token-login",
                serde_json::json!({ "token": "bad" })
            ),
            serde_json::json!({ "ok": false, "error": "invalid token" })
        );
        assert_eq!(
            post(&router, "/api/auth/token-login", serde_json::json!({})),
            serde_json::json!({ "ok": false, "error": "invalid token" })
        );
    }

    #[test]
    fn auth_token_login_fails_when_no_token_provider_configured() {
        let store = ::std::sync::Mutex::new(InMemorySessionStore::new(Some("test-secret")));
        let providers: Vec<ProviderRef> = Vec::new();
        let mut router = DashboardRouter::new();
        register_auth_routes(&mut router, &store, &providers);
        let result = post(
            &router,
            "/api/auth/token-login",
            serde_json::json!({ "token": "hsk-x" }),
        );
        assert_eq!(
            result,
            serde_json::json!({ "ok": false, "error": "token login is not configured" })
        );
    }

    #[test]
    fn auth_logout_revokes_session_and_returns_ok() {
        let store = ::std::sync::Mutex::new(InMemorySessionStore::new(Some("test-secret")));
        let providers = basic_and_token_providers();
        let mut router = DashboardRouter::new();
        register_auth_routes(&mut router, &store, &providers);
        let login = post(
            &router,
            "/api/auth/password-login",
            serde_json::json!({ "username": "admin", "password": "admin-hash" }),
        );
        let session_id = login["session"]["id"].as_str().unwrap();
        let logout = post(
            &router,
            "/api/auth/logout",
            serde_json::json!({ "session_id": session_id }),
        );
        assert_eq!(logout, serde_json::json!({ "ok": true }));
        let guard = store.lock().unwrap();
        assert!(guard.get_session(session_id).is_none());
    }

    #[test]
    fn auth_logout_without_session_id_still_returns_ok() {
        let store = ::std::sync::Mutex::new(InMemorySessionStore::new(Some("test-secret")));
        let providers = basic_and_token_providers();
        let mut router = DashboardRouter::new();
        register_auth_routes(&mut router, &store, &providers);
        assert_eq!(
            post(&router, "/api/auth/logout", serde_json::json!({})),
            serde_json::json!({ "ok": true })
        );
        assert_eq!(
            post(&router, "/api/auth/logout", serde_json::Value::Null),
            serde_json::json!({ "ok": true })
        );
    }

    #[test]
    fn auth_refresh_succeeds_via_provider_refresh_session() {
        let provider = ProviderRef {
            name: "refreshable".to_string(),
            display_name: "Refreshable".to_string(),
            supports_password: false,
            supports_token: true,
            supports_refresh: true,
            verify_token: None,
            complete_password_login: None,
            refresh_session: Some(Box::new(
                |refresh_token: &str, _store: &mut InMemorySessionStore| {
                    if refresh_token == "rt-good" {
                        Some(Session {
                            id: "refreshed".to_string(),
                            display_name: Some("U".to_string()),
                            email: None,
                            access_token: "new-token".to_string(),
                            refresh_token: None,
                            expires_at: None,
                        })
                    } else {
                        None
                    }
                },
            )),
        };
        let store = ::std::sync::Mutex::new(InMemorySessionStore::new(Some("test-secret")));
        let providers = [provider];
        let mut router = DashboardRouter::new();
        register_auth_routes(&mut router, &store, &providers);
        let result = post(
            &router,
            "/api/auth/refresh",
            serde_json::json!({ "refresh_token": "rt-good" }),
        );
        assert_eq!(
            result,
            serde_json::json!({
                "ok": true,
                "session": { "id": "refreshed", "displayName": "U", "accessToken": "new-token" },
            })
        );
    }

    #[test]
    fn auth_refresh_rejects_unknown_refresh_tokens() {
        let store = ::std::sync::Mutex::new(InMemorySessionStore::new(Some("test-secret")));
        let providers = basic_and_token_providers();
        let mut router = DashboardRouter::new();
        register_auth_routes(&mut router, &store, &providers);
        assert_eq!(
            post(
                &router,
                "/api/auth/refresh",
                serde_json::json!({ "refresh_token": "rt-bad" })
            ),
            serde_json::json!({ "ok": false, "error": "invalid refresh token" })
        );
    }

    #[test]
    fn auth_refresh_requires_refresh_token_field() {
        let store = ::std::sync::Mutex::new(InMemorySessionStore::new(Some("test-secret")));
        let providers = basic_and_token_providers();
        let mut router = DashboardRouter::new();
        register_auth_routes(&mut router, &store, &providers);
        assert_eq!(
            post(&router, "/api/auth/refresh", serde_json::json!({})),
            serde_json::json!({ "ok": false, "error": "missing refresh token" })
        );
    }

    #[test]
    fn auth_refresh_fails_when_no_provider_refreshes() {
        let provider = ProviderRef {
            name: "no-refresh".to_string(),
            display_name: "No Refresh".to_string(),
            supports_password: false,
            supports_token: true,
            supports_refresh: false,
            verify_token: None,
            complete_password_login: None,
            refresh_session: None,
        };
        let store = ::std::sync::Mutex::new(InMemorySessionStore::new(Some("test-secret")));
        let providers = [provider];
        let mut router = DashboardRouter::new();
        register_auth_routes(&mut router, &store, &providers);
        assert_eq!(
            post(
                &router,
                "/api/auth/refresh",
                serde_json::json!({ "refresh_token": "rt" })
            ),
            serde_json::json!({ "ok": false, "error": "invalid refresh token" })
        );
    }

    #[test]
    fn auth_uses_first_provider_that_can_handle_password_login() {
        let first = ProviderRef {
            name: "first".to_string(),
            display_name: "First".to_string(),
            supports_password: true,
            supports_token: false,
            supports_refresh: false,
            verify_token: None,
            complete_password_login: Some(Box::new(|_, _, store| {
                Some(store.create_session(CreateSessionInput {
                    id: Some("first-session".to_string()),
                    sub: Some("first".to_string()),
                    ..Default::default()
                }))
            })),
            refresh_session: None,
        };
        let second = ProviderRef {
            name: "second".to_string(),
            display_name: "Second".to_string(),
            supports_password: true,
            supports_token: false,
            supports_refresh: false,
            verify_token: None,
            complete_password_login: Some(Box::new(|_, _, store| {
                Some(store.create_session(CreateSessionInput {
                    id: Some("second-session".to_string()),
                    ..Default::default()
                }))
            })),
            refresh_session: None,
        };
        let store = ::std::sync::Mutex::new(InMemorySessionStore::new(Some("test-secret")));
        let providers = [first, second];
        let mut router = DashboardRouter::new();
        register_auth_routes(&mut router, &store, &providers);
        let result = post(
            &router,
            "/api/auth/password-login",
            serde_json::json!({ "username": "u", "password": "p" }),
        );
        assert_eq!(result["session"]["id"], "first-session");
    }
}
