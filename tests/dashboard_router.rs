//! Repo-root integration tests for the dashboard router + status/auth routes.
//!
//! These exercise only the `pub` API of `hermes_agent_cn::dashboard`.

use std::collections::HashMap;
use std::sync::Mutex;

use hermes_agent_cn::dashboard::router::{
    DashboardRouter, FnHandler, RequestContext, RouteInfo, RouteKind,
};
use hermes_agent_cn::dashboard::routes::{
    register_auth_routes, register_status_routes, ProviderRef, StatusOpts,
};
use hermes_agent_cn::dashboard::session::InMemorySessionStore;
use serde_json::json;

fn get(router: &DashboardRouter<'_>, path: &str) -> serde_json::Value {
    router.handle(RequestContext {
        path: path.to_string(),
        method: "GET".to_string(),
        body: serde_json::Value::Null,
        headers: HashMap::new(),
    })
}

fn post(router: &DashboardRouter<'_>, path: &str, body: serde_json::Value) -> serde_json::Value {
    router.handle(RequestContext {
        path: path.to_string(),
        method: "POST".to_string(),
        body,
        headers: HashMap::new(),
    })
}

#[test]
fn router_resolves_exact_and_prefix_routes() {
    let mut router = DashboardRouter::new();
    router.register("/api/status", "GET", FnHandler(|_| json!({ "ok": true })));
    router.register_prefix(
        "/api/memory",
        "GET",
        FnHandler(|_| json!({ "memory": true })),
    );

    assert!(router.resolve("/api/status", "GET").is_some());
    assert!(router.resolve("/api/memory", "GET").is_some());
    assert!(router
        .resolve("/api/memory/providers/foo/status", "GET")
        .is_some());
    // Boundary-aware: sibling paths do not match the prefix.
    assert!(router.resolve("/api/memory2", "GET").is_none());
    // Method-scoped.
    assert!(router.resolve("/api/status", "POST").is_none());
}

#[test]
fn router_returns_404_shaped_result_for_unmatched_route() {
    let router = DashboardRouter::new();
    let result = get(&router, "/api/nope");
    assert_eq!(
        result,
        json!({
            "ok": false,
            "status": 404,
            "error": "no handler for GET /api/nope",
        })
    );
}

#[test]
fn router_tracks_routes_in_registration_order() {
    let mut router = DashboardRouter::new();
    router.register("/api/status", "GET", FnHandler(|_| json!({})));
    router.register("/api/login", "POST", FnHandler(|_| json!({})));
    router.register_prefix("/api/memory", "GET", FnHandler(|_| json!({})));
    assert_eq!(
        router.routes(),
        vec![
            RouteInfo {
                method: "GET".into(),
                path: "/api/status".into(),
                kind: RouteKind::Exact
            },
            RouteInfo {
                method: "POST".into(),
                path: "/api/login".into(),
                kind: RouteKind::Exact
            },
            RouteInfo {
                method: "GET".into(),
                path: "/api/memory".into(),
                kind: RouteKind::Prefix
            },
        ]
    );
}

#[test]
fn status_routes_render_defaults_and_overrides() {
    let mut router = DashboardRouter::new();
    register_status_routes(&mut router, StatusOpts::default());
    assert_eq!(
        get(&router, "/api/status"),
        json!({ "ok": true, "platform": "desktop", "version": "0.0.0", "connection_mode": "managed" })
    );
    assert_eq!(get(&router, "/api/health"), json!({ "ok": true }));

    let mut router = DashboardRouter::new();
    register_status_routes(
        &mut router,
        StatusOpts {
            version: "0.8.0-rc4".into(),
            connection_mode: "remote".into(),
        },
    );
    assert_eq!(
        get(&router, "/api/version"),
        json!({ "version": "0.8.0-rc4", "platform": "desktop" })
    );
    assert_eq!(get(&router, "/api/status")["connection_mode"], "remote");
}

#[test]
fn auth_routes_providers_and_me() {
    let providers = vec![ProviderRef::token("hsk-")];
    let store = Mutex::new(InMemorySessionStore::new(Some("route-secret")));
    let mut router = DashboardRouter::new();
    register_auth_routes(&mut router, &store, &providers);

    let providers_result = get(&router, "/api/auth/providers");
    assert_eq!(providers_result["providers"][0]["name"], "token");
    assert_eq!(providers_result["providers"][0]["supportsToken"], true);

    let me = get(&router, "/api/auth/me");
    assert_eq!(me["ok"], true);
    assert_eq!(me["user"]["sub"], "desktop-local");
}

#[test]
fn auth_token_login_creates_session_and_logout_revokes_it() {
    let providers = vec![ProviderRef::token("hsk-")];
    let store = Mutex::new(InMemorySessionStore::new(Some("route-secret")));
    let mut router = DashboardRouter::new();
    register_auth_routes(&mut router, &store, &providers);

    let login = post(
        &router,
        "/api/auth/token-login",
        json!({ "token": "hsk-local" }),
    );
    assert_eq!(login["ok"], true);
    assert_eq!(login["session"]["id"], "service");

    let session_id = login["session"]["id"].as_str().unwrap();
    let logout = post(
        &router,
        "/api/auth/logout",
        json!({ "session_id": session_id }),
    );
    assert_eq!(logout, json!({ "ok": true }));
    let guard = store.lock().unwrap();
    assert!(guard.get_session(session_id).is_none());
}

#[test]
fn auth_password_login_and_refresh_flow() {
    let mut users = HashMap::new();
    users.insert("admin".to_string(), "admin-hash".to_string());
    let providers = vec![
        ProviderRef::basic(users, Box::new(|p, h| p == h)),
        ProviderRef::token("hsk-"),
    ];
    let store = Mutex::new(InMemorySessionStore::new(Some("route-secret")));
    let mut router = DashboardRouter::new();
    register_auth_routes(&mut router, &store, &providers);

    let login = post(
        &router,
        "/api/auth/password-login",
        json!({ "username": "admin", "password": "admin-hash" }),
    );
    assert_eq!(login["ok"], true);
    assert_eq!(login["session"]["id"], "basic:admin");

    // No provider refreshes in this fixture -> invalid refresh token.
    let refresh = post(
        &router,
        "/api/auth/refresh",
        json!({ "refresh_token": "rt-bad" }),
    );
    assert_eq!(
        refresh,
        json!({ "ok": false, "error": "invalid refresh token" })
    );
}
