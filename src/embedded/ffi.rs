//! FFI surface registry — the data source for the Hard FFI coverage gate
//! (report §4 Phase 4 延伸, §8 success criteria 9).
//!
//! Every REST route the api_proxy used to forward over HTTP, and every
//! JSON-RPC method the gateway dispatched over WS, is registered here with its
//! `hermes_embedded.api` direct-call function. The registry is both:
//! - the runtime lookup table (`covered_route` / `entry_for_route`), and
//! - the CI gate source: `assert_full_coverage` fails unless every proxy-pass
//!   route has a direct FFI entry, so "hot path only" regressions are caught
//!   mechanically.
//!
//! This is the No-HTTP contract: routes not listed here have no in-process
//! transport at all and therefore must not be called in embedded mode.

/// One REST route → FFI function mapping. `pattern` is a prefix match on the
/// request path (`/api/version` matches exactly; `/api/session/` matches every
/// session sub-route).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FfiRouteEntry {
    /// Path prefix, e.g. `/api/version` or `/api/session/`.
    pub pattern: &'static str,
    /// Python function in `hermes_embedded.api`.
    pub python_func: &'static str,
    /// Human description (used in docs/coverage reports).
    pub description: &'static str,
}

/// Full REST → FFI mapping (report §4 mapping table). Order matters only for
/// lookup — patterns are checked longest-first so `/api/session/` wins over a
/// hypothetical `/api/session` exact entry.
pub static REST_FFI_SURFACE: &[FfiRouteEntry] = &[
    FfiRouteEntry {
        pattern: "/api/version",
        python_func: "get_version",
        description: "GET /api/version — backend version string",
    },
    FfiRouteEntry {
        pattern: "/api/gateway",
        python_func: "get_gateway_config",
        description: "GET /api/gateway — gateway runtime config",
    },
    FfiRouteEntry {
        pattern: "/api/status",
        python_func: "get_status",
        description: "GET /api/status — dashboard status",
    },
    FfiRouteEntry {
        pattern: "/api/config",
        python_func: "get_config",
        description: "GET /api/config — config view",
    },
    FfiRouteEntry {
        pattern: "/api/session/",
        python_func: "handle_session",
        description: "/api/session/* — list/get/create/resume",
    },
    FfiRouteEntry {
        pattern: "/api/prompt",
        python_func: "handle_prompt",
        description: "/api/prompt — submit/abort",
    },
    FfiRouteEntry {
        pattern: "/api/model/",
        python_func: "handle_model",
        description: "/api/model/* — list/get/set model",
    },
    FfiRouteEntry {
        pattern: "/api/skills",
        python_func: "handle_skills",
        description: "/api/skills — skill routes",
    },
    FfiRouteEntry {
        pattern: "/api/tools/toolsets",
        python_func: "handle_tools",
        description: "/api/tools/toolsets",
    },
    FfiRouteEntry {
        pattern: "/api/mcp",
        python_func: "handle_mcp",
        description: "/api/mcp",
    },
    FfiRouteEntry {
        pattern: "/api/cron/",
        python_func: "handle_cron",
        description: "/api/cron/*",
    },
    FfiRouteEntry {
        pattern: "/api/messaging/",
        python_func: "handle_messaging",
        description: "/api/messaging/*",
    },
    FfiRouteEntry {
        pattern: "/api/pairing/",
        python_func: "handle_pairing",
        description: "/api/pairing/*",
    },
    FfiRouteEntry {
        pattern: "/api/git/",
        python_func: "handle_git",
        description: "/api/git/*",
    },
    FfiRouteEntry {
        pattern: "/api/profiles/",
        python_func: "handle_profiles",
        description: "/api/profiles/*",
    },
    FfiRouteEntry {
        pattern: "/api/analytics/",
        python_func: "handle_analytics",
        description: "/api/analytics/*",
    },
    // ── Real frontend surface (refactor_plan.md Phase A) ──────────────────
    // Longer exact patterns so longest-match beats the short prefixes above
    // (/api/mcp-servers wins over /api/mcp, /api/config/schema over /api/config,
    // /api/gateway/restart over /api/gateway).
    FfiRouteEntry {
        pattern: "/api/sessions",
        python_func: "handle_sessions",
        description: "/api/sessions* — plural session family (list/detail/messages/search/delete)",
    },
    FfiRouteEntry {
        pattern: "/api/profiles",
        python_func: "handle_profiles_exact",
        description: "GET/POST /api/profiles — exact list/create (not /api/profiles/ subroutes)",
    },
    FfiRouteEntry {
        pattern: "/api/env",
        python_func: "handle_env",
        description: "/api/env* — env vars (list/set/remove/reveal)",
    },
    FfiRouteEntry {
        pattern: "/api/fs/list",
        python_func: "handle_fs",
        description: "/api/fs/list — directory listing",
    },
    FfiRouteEntry {
        pattern: "/api/logs",
        python_func: "handle_logs",
        description: "/api/logs — log tail",
    },
    FfiRouteEntry {
        pattern: "/api/media",
        python_func: "handle_media",
        description: "/api/media* — media data-url fetch",
    },
    FfiRouteEntry {
        pattern: "/api/memory",
        python_func: "handle_memory",
        description: "/api/memory* — memory providers/status/reset",
    },
    FfiRouteEntry {
        pattern: "/api/mcp-servers",
        python_func: "handle_mcp_servers",
        description: "/api/mcp-servers — MCP health summary (longer than /api/mcp)",
    },
    FfiRouteEntry {
        pattern: "/api/providers/oauth",
        python_func: "handle_oauth_providers",
        description: "/api/providers/oauth* — OAuth providers",
    },
    FfiRouteEntry {
        pattern: "/api/audio",
        python_func: "handle_audio",
        description: "/api/audio/* — transcribe/speak/voices",
    },
    FfiRouteEntry {
        pattern: "/api/upload",
        python_func: "handle_upload",
        description: "POST /api/upload — attachment store (FFI branch of upload_file)",
    },
    FfiRouteEntry {
        pattern: "/api/config/schema",
        python_func: "handle_config_schema",
        description: "GET /api/config/schema — config schema (longer than /api/config)",
    },
    FfiRouteEntry {
        pattern: "/api/gateway/restart",
        python_func: "handle_gateway_restart",
        description: "POST /api/gateway/restart — gateway restart action (longer than /api/gateway)",
    },
];

/// JSON-RPC methods handled directly by `hermes_embedded.api.handle_rpc`
/// (gateway path). Frames still arrive in JSON-RPC shape and events still flow
/// out through the Rust-backed transport, but no WS/TCP is involved.
///
/// This is the full set of methods the frontend gateway client sends
/// (web/src/lib/gateway-client.ts) — the registry is the coverage contract for
/// the embedded gateway, so an unregistered method fails loudly instead of
/// falling back to any transport.
pub static GATEWAY_FFI_METHODS: &[&str] = &[
    "session.create",
    "session.resume",
    "session.list",
    "session.close",
    "session.compress",
    "session.interrupt",
    "session.title",
    "session.usage",
    "prompt.submit",
    "prompt.abort",
    "setup.status",
    "model.info",
    "model.list",
    "model.options",
    "provider.models",
    "provider.probe",
    "command.dispatch",
    "complete.path",
    "complete.slash",
    "config.set",
    "file.attach",
    "image.attach",
    "gateway.disconnected",
];

/// Route patterns the api_proxy used to forward over HTTP but which are now
/// handled **locally in Rust** in embedded mode (no Python involved) — session
/// log reads, cron run listings, etc. They are deliberately NOT in the REST FFI
/// surface; they must never reach Python or HTTP.
pub static LOCAL_INTERCEPT_PREFIXES: &[&str] = &[
    "/__hermes_session_log/",
    "/__hermes_cron_runs/",
    // Managed-runtime update is orchestrated locally (payload replace +
    // restart); it is not an FFI REST entry in the reference milestone.
    "/api/hermes/update",
];
/// The `/api/ws` gateway endpoint maps to the in-memory RustBridgeTransport
/// (transport.rs), not to any REST handler.
pub const GATEWAY_WS_ROUTE: &str = "/api/ws";

/// Concrete request paths the api_proxy proxy-pass would have forwarded over
/// HTTP (report §4 Phase 4 延伸 mapping table). This is the CI coverage-gate
/// input: every entry must either have an FFI entry (`covered_route`) or be
/// exempt as a local intercept / the gateway endpoint. Keeping it as concrete
/// paths (not patterns) makes the 1:1 correspondence greppable and
/// reviewable.
pub static PROXY_PASS_ROUTES: &[&str] = &[
    "/api/version",
    "/api/gateway",
    "/api/status",
    "/api/config",
    "/api/session/list",
    "/api/session/abc123",
    "/api/prompt",
    "/api/model/list",
    "/api/model/abc123",
    "/api/model/options",
    "/api/skills",
    "/api/tools/toolsets",
    "/api/mcp",
    "/api/cron/runs",
    "/api/messaging/list",
    "/api/pairing/status",
    "/api/git/status",
    "/api/profiles/active",
    "/api/analytics/summary",
    // Real frontend surface (refactor_plan.md Phase A). The coverage gate input
    // is now the routes the frontend actually calls, not a self-referential
    // subset — these must each resolve to an FFI entry.
    "/api/sessions",
    "/api/sessions/abc123",
    "/api/sessions/abc123/messages",
    "/api/sessions/search",
    "/api/profiles",
    "/api/env",
    "/api/env/reveal",
    "/api/fs/list",
    "/api/logs",
    "/api/media",
    "/api/media/file",
    "/api/memory",
    "/api/memory/provider",
    "/api/memory/providers/openviking/config",
    "/api/memory/providers/openviking/status",
    "/api/memory/providers/openviking/setup",
    "/api/memory/reset",
    "/api/mcp-servers",
    "/api/providers/oauth",
    "/api/providers/oauth/feishu/start",
    "/api/providers/oauth/feishu/submit",
    "/api/providers/oauth/sessions/sess1",
    "/api/audio/transcribe",
    "/api/audio/speak",
    "/api/audio/elevenlabs/voices",
    "/api/upload",
    "/api/config/schema",
    "/api/gateway/restart",
    // Local desktop routes (never forwarded, never FFI).
    "/__hermes_session_log/abc123",
    "/__hermes_cron_runs/default/job1",
    // Runtime update intercept handled locally in Rust.
    "/api/hermes/update",
    // Gateway endpoint handled by the in-memory transport.
    "/api/ws",
];

/// Longest-first sorted copy of `REST_FFI_SURFACE` for prefix lookup.
fn sorted_surface() -> Vec<&'static FfiRouteEntry> {
    let mut v: Vec<&'static FfiRouteEntry> = REST_FFI_SURFACE.iter().collect();
    v.sort_by_key(|e| std::cmp::Reverse(e.pattern.len()));
    v
}

/// Does this request path have a direct FFI entry?
pub fn covered_route(path: &str) -> bool {
    sorted_surface().iter().any(|e| path.starts_with(e.pattern))
}

/// The FFI entry for a route, if any (longest pattern wins).
pub fn entry_for_route(path: &str) -> Option<&'static FfiRouteEntry> {
    sorted_surface()
        .into_iter()
        .find(|e| path.starts_with(e.pattern))
}

/// Gateway JSON-RPC method → direct FFI support.
pub fn covered_gateway_method(method: &str) -> bool {
    GATEWAY_FFI_METHODS.contains(&method)
}

/// Coverage gate (report §8 success criteria 9 / §4 Phase 4 延伸):
/// every proxy-pass route must be registered. `proxy_pass_routes` should be
/// the api_proxy's forwarding allow-list; returns the list of uncovered
/// routes, empty when coverage is 100%.
pub fn uncovered_routes<'a>(proxy_pass_routes: &[&'a str]) -> Vec<&'a str> {
    let mut missing: Vec<&'a str> = Vec::new();
    for route in proxy_pass_routes {
        if *route == GATEWAY_WS_ROUTE {
            continue; // gateway endpoint, handled by the transport
        }
        if LOCAL_INTERCEPT_PREFIXES
            .iter()
            .any(|p| route.starts_with(p))
        {
            continue; // local interception, intentionally no FFI entry
        }
        if !covered_route(route) {
            missing.push(route);
        }
    }
    missing
}

/// Assert 100% coverage; returns an error listing uncovered routes.
pub fn assert_full_coverage(proxy_pass_routes: &[&str]) -> Result<(), String> {
    let missing = uncovered_routes(proxy_pass_routes);
    if missing.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "embedded FFI coverage gate failed: {} route(s) have no direct FFI entry: {}",
            missing.len(),
            missing.join(", ")
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    #[test]
    fn version_route_is_covered() {
        assert!(covered_route("/api/version"));
        let entry = entry_for_route("/api/version").unwrap();
        assert_eq!(entry.python_func, "get_version");
    }

    #[test]
    fn session_subroutes_match_prefix() {
        assert!(covered_route("/api/session/abc"));
        assert!(covered_route("/api/session/"));
        assert_eq!(
            entry_for_route("/api/session/abc").unwrap().python_func,
            "handle_session"
        );
    }

    #[test]
    fn unknown_route_is_uncovered() {
        assert!(!covered_route("/api/nonexistent"));
        assert!(entry_for_route("/api/nonexistent").is_none());
    }

    #[test]
    fn gateway_ws_route_is_not_a_rest_surface() {
        assert!(!covered_route("/api/ws"));
        assert!(!covered_gateway_method("not.a.method"));
    }

    #[test]
    fn gateway_methods_are_covered() {
        for m in GATEWAY_FFI_METHODS {
            assert!(covered_gateway_method(m), "{m} should be covered");
        }
    }

    #[test]
    fn coverage_gate_passes_for_full_route_list() {
        // Realistic request paths: prefix patterns get a concrete sub-path so
        // they match (e.g. /api/session/ → /api/session/abc).
        let routes: Vec<String> = REST_FFI_SURFACE
            .iter()
            .map(|e| {
                if e.pattern.ends_with('/') {
                    format!("{}x", e.pattern)
                } else {
                    e.pattern.to_string()
                }
            })
            .collect();
        let routes: Vec<&str> = routes.iter().map(|s| s.as_str()).collect();
        assert_eq!(uncovered_routes(&routes), Vec::<&str>::new());
        assert!(assert_full_coverage(&routes).is_ok());
    }

    #[test]
    fn proxy_pass_route_list_is_fully_covered() {
        // Success criteria 9: the api_proxy proxy-pass route list must map 1:1
        // to FFI entries (or be explicitly exempt as local/gateway).
        let missing = uncovered_routes(PROXY_PASS_ROUTES);
        assert!(
            missing.is_empty(),
            "proxy-pass routes missing FFI entries: {}",
            missing.join(", ")
        );
        assert!(assert_full_coverage(PROXY_PASS_ROUTES).is_ok());
    }

    #[test]
    fn every_ffi_entry_is_reachable_from_the_proxy_pass_list() {
        // Reverse direction: each FFI surface entry must correspond to at least
        // one concrete proxy-pass path, so dead registry entries are caught.
        for entry in REST_FFI_SURFACE {
            assert!(
                PROXY_PASS_ROUTES
                    .iter()
                    .any(|p| p.starts_with(entry.pattern)),
                "FFI entry {} has no concrete proxy-pass route",
                entry.pattern
            );
        }
    }

    #[test]
    fn coverage_gate_flags_missing_routes() {
        let routes = vec!["/api/version", "/api/does-not-exist", "/api/ws"];
        let missing = uncovered_routes(&routes);
        assert_eq!(missing, vec!["/api/does-not-exist"]);
        assert!(assert_full_coverage(&routes).is_err());
    }

    #[test]
    fn local_intercepts_are_exempt_from_ffi_coverage() {
        let routes = vec!["/__hermes_session_log/foo", "/__hermes_cron_runs/bar"];
        assert_eq!(uncovered_routes(&routes), Vec::<&str>::new());
    }

    #[test]
    fn surface_has_no_duplicate_prefixes_that_mask_each_other() {
        // Guards against a shorter pattern shadowing a longer one in lookup.
        let mut patterns: Vec<&str> = REST_FFI_SURFACE.iter().map(|e| e.pattern).collect();
        patterns.sort_unstable();
        patterns.dedup();
        assert_eq!(patterns.len(), REST_FFI_SURFACE.len());
    }
}
