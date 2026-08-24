//! Local-first dashboard request router (port of `router.ts`).
//!
//! A tiny, testable router that mirrors the FastAPI path registry.  It has no
//! server or HTTP dependencies; handlers are pure functions that return JSON.
//!
//! Router semantics match the package router exactly:
//! - exact match key is `"<METHOD> <path>"` with the method uppercased;
//! - prefix matching only when the path equals the prefix or starts with
//!   `prefix + "/"` (boundary-aware);
//! - an exact match always wins over a registered prefix;
//! - `handle` returns a 404-shaped value when no handler matches.
//!   The package router does *not* strip query string — this router does not
//!   either (the web router `web/src/lib/dashboard-router.ts` does that).

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

/// The request context handed to every handler (mirrors `DashboardRequestContext`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RequestContext {
    pub path: String,
    pub method: String,
    pub body: serde_json::Value,
    pub headers: HashMap<String, String>,
}

/// Error produced by a handler.
#[derive(Debug, Clone, thiserror::Error)]
pub enum HandlerError {
    #[error("handler error: {0}")]
    Internal(String),
}

/// A route handler. Handlers are pure (no I/O) like the TS handlers.
pub trait Handler: Send + Sync {
    fn handle(&self, ctx: RequestContext) -> Result<serde_json::Value, HandlerError>;
}

/// Adapter that turns a synchronous `Fn(RequestContext) -> serde_json::Value`
/// closure into a [`Handler`].
pub struct FnHandler<F>(pub F);

impl<F> Handler for FnHandler<F>
where
    F: Fn(RequestContext) -> serde_json::Value + Send + Sync,
{
    fn handle(&self, ctx: RequestContext) -> Result<serde_json::Value, HandlerError> {
        Ok((self.0)(ctx))
    }
}

/// Blanket impl so a closure returning `Result<Value, HandlerError>` can be
/// registered directly.
impl<F> Handler for F
where
    F: Fn(RequestContext) -> Result<serde_json::Value, HandlerError> + Send + Sync,
{
    fn handle(&self, ctx: RequestContext) -> Result<serde_json::Value, HandlerError> {
        self(ctx)
    }
}

/// Kind of a registered route.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RouteKind {
    Exact,
    Prefix,
}

/// Snapshot of a registered route (mirrors `router.routes()`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RouteInfo {
    pub method: String,
    pub path: String,
    pub kind: RouteKind,
}

struct ExactEntry<'a> {
    method: String,
    path: String,
    handler: Box<dyn Handler + 'a>,
}

struct PrefixEntry<'a> {
    method: String,
    path: String,
    handler: Box<dyn Handler + 'a>,
}

/// The local-first dashboard router.
pub struct DashboardRouter<'a> {
    exact: Vec<ExactEntry<'a>>,
    prefix: Vec<PrefixEntry<'a>>,
}

impl<'a> DashboardRouter<'a> {
    pub fn new() -> Self {
        Self {
            exact: Vec::new(),
            prefix: Vec::new(),
        }
    }

    /// Register a handler for an exact path and method. `method` defaults to
    /// "GET" when the caller omits it (use [`register`](Self::register) with an
    /// explicit method string, or [`register_get`](Self::register_get)).
    pub fn register<H>(&mut self, path: &str, method: &str, handler: H) -> &mut Self
    where
        H: Handler + 'a,
    {
        let method = method.to_uppercase();
        if let Some(entry) = self
            .exact
            .iter_mut()
            .find(|e| e.method == method && e.path == path)
        {
            entry.handler = Box::new(handler);
        } else {
            self.exact.push(ExactEntry {
                method,
                path: path.to_string(),
                handler: Box::new(handler),
            });
        }
        self
    }

    /// Register an exact GET handler (mirrors TS default method).
    pub fn register_get<H>(&mut self, path: &str, handler: H) -> &mut Self
    where
        H: Handler + 'a,
    {
        self.register(path, "GET", handler)
    }

    /// Register a prefix handler. Chosen when no exact match exists and the
    /// request path starts with the registered prefix.
    pub fn register_prefix<H>(&mut self, path: &str, method: &str, handler: H) -> &mut Self
    where
        H: Handler + 'a,
    {
        self.prefix.push(PrefixEntry {
            method: method.to_uppercase(),
            path: path.to_string(),
            handler: Box::new(handler),
        });
        self
    }

    /// Look up a handler for a request. Exact match wins; otherwise the first
    /// matching prefix handler is returned.
    pub fn resolve(&self, path: &str, method: &str) -> Option<&dyn Handler> {
        let method = method.to_uppercase();
        if let Some(entry) = self
            .exact
            .iter()
            .find(|e| e.method == method && e.path == path)
        {
            return Some(entry.handler.as_ref());
        }
        for entry in &self.prefix {
            if entry.method == method
                && (path == entry.path || path.starts_with(&format!("{}/", entry.path)))
            {
                return Some(entry.handler.as_ref());
            }
        }
        None
    }

    /// Dispatch a request to a handler, or return a 404-shaped JSON value.
    pub fn handle(&self, ctx: RequestContext) -> serde_json::Value {
        match self.resolve(&ctx.path, &ctx.method) {
            Some(handler) => handler
                .handle(ctx)
                .unwrap_or_else(|e| serde_json::json!({ "ok": false, "error": e.to_string() })),
            None => serde_json::json!({
                "ok": false,
                "status": 404,
                "error": format!("no handler for {} {}", ctx.method, ctx.path)
            }),
        }
    }

    /// Remove an exact handler.
    pub fn unregister(&mut self, path: &str, method: &str) -> &mut Self {
        let method = method.to_uppercase();
        self.exact
            .retain(|e| !(e.method == method && e.path == path));
        self
    }

    /// Clear every registered handler.
    pub fn clear(&mut self) -> &mut Self {
        self.exact.clear();
        self.prefix.clear();
        self
    }

    /// Snapshot of routes (exact first, then prefix, in registration order).
    pub fn routes(&self) -> Vec<RouteInfo> {
        let mut out: Vec<RouteInfo> = self
            .exact
            .iter()
            .map(|e| RouteInfo {
                method: e.method.clone(),
                path: e.path.clone(),
                kind: RouteKind::Exact,
            })
            .collect();
        out.extend(self.prefix.iter().map(|e| RouteInfo {
            method: e.method.clone(),
            path: e.path.clone(),
            kind: RouteKind::Prefix,
        }));
        out
    }
}

impl<'a> Default for DashboardRouter<'a> {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ctx(overrides: impl FnOnce(&mut RequestContext)) -> RequestContext {
        let mut c = RequestContext {
            path: "/api/test".to_string(),
            method: "GET".to_string(),
            body: serde_json::Value::Null,
            headers: HashMap::new(),
        };
        overrides(&mut c);
        c
    }

    #[test]
    fn registers_and_resolves_handler_for_specific_method() {
        let mut router = DashboardRouter::new();
        router.register("/api/x", "GET", FnHandler(|_| json!({ "via": "get" })));
        router.register("/api/x", "POST", FnHandler(|_| json!({ "via": "post" })));

        let get = router.handle(ctx(|c| c.path = "/api/x".into()));
        assert_eq!(get, json!({ "via": "get" }));
        let post = router.handle(ctx(|c| {
            c.path = "/api/x".into();
            c.method = "POST".into();
        }));
        assert_eq!(post, json!({ "via": "post" }));
    }

    #[test]
    fn method_is_case_insensitive_on_registration_and_dispatch() {
        let mut router = DashboardRouter::new();
        router.register("/api/x", "post", FnHandler(|_| json!({ "ok": true })));
        assert!(router.resolve("/api/x", "POST").is_some());
        assert!(router.resolve("/api/x", "post").is_some());
    }

    #[test]
    fn defaults_method_to_get() {
        let mut router = DashboardRouter::new();
        router.register_get("/api/x", FnHandler(|_| json!({ "ok": true })));
        assert!(router.resolve("/api/x", "GET").is_some());
        assert!(router.resolve("/api/x", "GET").is_some());
        assert!(router.resolve("/api/x", "POST").is_none());
    }

    #[test]
    fn returns_undefined_when_path_exists_but_method_does_not() {
        let mut router = DashboardRouter::new();
        router.register("/api/x", "GET", FnHandler(|_| json!({})));
        assert!(router.resolve("/api/x", "DELETE").is_none());
    }

    #[test]
    fn resolves_prefix_routes_for_nested_paths_only() {
        let mut router = DashboardRouter::new();
        router.register_prefix(
            "/api/memory",
            "GET",
            FnHandler(|_| json!({ "memory": true })),
        );
        assert!(router.resolve("/api/memory", "GET").is_some());
        assert!(router
            .resolve("/api/memory/providers/foo/status", "GET")
            .is_some());
        // Sibling path must NOT match the prefix.
        assert!(router.resolve("/api/memory2", "GET").is_none());
        assert!(router.resolve("/api/memories", "GET").is_none());
    }

    #[test]
    fn prefix_resolution_is_method_scoped() {
        let mut router = DashboardRouter::new();
        router.register_prefix("/api/memory", "POST", FnHandler(|_| json!({})));
        assert!(router.resolve("/api/memory/x", "POST").is_some());
        assert!(router.resolve("/api/memory/x", "GET").is_none());
    }

    #[test]
    fn prefers_exact_match_over_registered_prefix() {
        let mut router = DashboardRouter::new();
        router.register_prefix(
            "/api/memory",
            "GET",
            FnHandler(|_| json!({ "kind": "prefix" })),
        );
        router.register(
            "/api/memory",
            "GET",
            FnHandler(|_| json!({ "kind": "exact" })),
        );
        assert!(router.resolve("/api/memory", "GET").is_some());
        let val = router.handle(ctx(|c| c.path = "/api/memory".into()));
        assert_eq!(val, json!({ "kind": "exact" }));
    }

    #[test]
    fn uses_first_matching_prefix_handler() {
        let mut router = DashboardRouter::new();
        router.register_prefix("/api", "GET", FnHandler(|_| json!({ "which": "api" })));
        router.register_prefix(
            "/api/deep",
            "GET",
            FnHandler(|_| json!({ "which": "deep" })),
        );
        let val = router.handle(ctx(|c| c.path = "/api/deep/x".into()));
        assert_eq!(val, json!({ "which": "api" }));
    }

    #[test]
    fn handle_passes_request_context_through() {
        let mut router = DashboardRouter::new();
        router.register(
            "/api/echo",
            "GET",
            FnHandler(|c: RequestContext| {
                json!({
                    "echo": c.path,
                    "method": c.method,
                    "body": c.body,
                    "header": c.headers.get("x-test").cloned(),
                })
            }),
        );
        let result = router.handle(ctx(|c| {
            c.path = "/api/echo".into();
            c.body = json!({ "a": 1 });
            c.headers.insert("x-test".to_string(), "yes".to_string());
        }));
        assert_eq!(
            result,
            json!({
                "echo": "/api/echo",
                "method": "GET",
                "body": { "a": 1 },
                "header": "yes",
            })
        );
    }

    #[test]
    fn handle_returns_404_shaped_result_with_method_and_path() {
        let router = DashboardRouter::new();
        let result = router.handle(ctx(|c| {
            c.path = "/api/nope".into();
            c.method = "POST".into();
        }));
        assert_eq!(
            result,
            json!({
                "ok": false,
                "status": 404,
                "error": "no handler for POST /api/nope",
            })
        );
    }

    #[test]
    fn unregister_removes_only_the_exact_method_handler() {
        let mut router = DashboardRouter::new();
        router.register("/api/x", "GET", FnHandler(|_| json!({ "a": 1 })));
        router.register("/api/x", "POST", FnHandler(|_| json!({ "a": 2 })));
        router.unregister("/api/x", "GET");
        assert!(router.resolve("/api/x", "GET").is_none());
        assert!(router.resolve("/api/x", "POST").is_some());
    }

    #[test]
    fn routes_snapshots_exact_and_prefix_registrations() {
        let mut router = DashboardRouter::new();
        router.register("/api/status", "GET", FnHandler(|_| json!({})));
        router.register("/api/login", "POST", FnHandler(|_| json!({})));
        router.register_prefix("/api/memory", "GET", FnHandler(|_| json!({})));
        router.register_prefix("/api/ws", "WS", FnHandler(|_| json!({})));
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
                RouteInfo {
                    method: "WS".into(),
                    path: "/api/ws".into(),
                    kind: RouteKind::Prefix
                },
            ]
        );
    }

    #[test]
    fn register_and_register_prefix_are_chainable() {
        let mut router = DashboardRouter::new();
        let _ = router
            .register("/api/a", "GET", FnHandler(|_| json!({})))
            .register_prefix("/api/b", "GET", FnHandler(|_| json!({})))
            .unregister("/api/a", "GET");
        assert!(router.resolve("/api/a", "GET").is_none());
        assert!(router.resolve("/api/b/x", "GET").is_some());
    }

    #[test]
    fn clear_removes_exact_and_prefix_handlers() {
        let mut router = DashboardRouter::new();
        router.register("/api/a", "GET", FnHandler(|_| json!({})));
        router.register_prefix("/api/b", "GET", FnHandler(|_| json!({})));
        router.clear();
        assert!(router.resolve("/api/a", "GET").is_none());
        assert!(router.resolve("/api/b/x", "GET").is_none());
        assert!(router.routes().is_empty());
    }

    #[test]
    fn blanket_handler_impl_accepts_result_returning_closure() {
        let mut router = DashboardRouter::new();
        router.register(
            "/api/err",
            "GET",
            |_c| -> Result<serde_json::Value, HandlerError> { Ok(json!({ "ok": true })) },
        );
        let result = router.handle(ctx(|c| c.path = "/api/err".into()));
        assert_eq!(result, json!({ "ok": true }));
    }
}
