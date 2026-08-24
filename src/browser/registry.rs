//! Backend precedence algorithm (mirrors `packages/browser/src/registry.ts`).
//!
//! The TS `BrowserProviderRegistry` owns the runtime provider objects; this pure
//! function encodes only the 4-step precedence so it can be tested independently
//! and reused as a single source of truth in the future Rust sidecar.

use crate::browser::types::BrowserBackendKind;

/// Result of resolving the active backend.
#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedBackend {
    pub kind: BrowserBackendKind,
    pub reason: String,
}

/// Resolve the active browser backend following the Core precedence:
///   1. explicit CDP URL override -> cdp backend
///   2. explicit configured backend (if available and not local)
///   3. legacy preference walk: browser-use -> browserbase -> camofox
///   4. local fallback
///
/// `config_backend` is the config's `backend`; `cdp_url` is the *effective* CDP
/// URL (already combined from options/config/env); `configured_backend` is the
/// optional explicit override; `available` reports provider availability.
pub fn resolve_backend(
    config_backend: BrowserBackendKind,
    cdp_url: Option<&str>,
    configured_backend: Option<BrowserBackendKind>,
    available: &dyn Fn(BrowserBackendKind) -> bool,
) -> Result<ResolvedBackend, String> {
    // 1. CDP URL override
    if cdp_url.is_some() && available(BrowserBackendKind::Cdp) {
        return Ok(ResolvedBackend {
            kind: BrowserBackendKind::Cdp,
            reason: "cdp_url_override".to_string(),
        });
    }

    // 2. Explicit configured backend (if available and not local)
    let configured = configured_backend.unwrap_or(config_backend);
    if configured != BrowserBackendKind::Local && available(configured) {
        return Ok(ResolvedBackend {
            kind: configured,
            reason: "configured_backend".to_string(),
        });
    }

    // 3. Legacy preference walk
    for kind in [
        BrowserBackendKind::BrowserUse,
        BrowserBackendKind::Browserbase,
        BrowserBackendKind::Camofox,
    ] {
        if available(kind) {
            return Ok(ResolvedBackend {
                kind,
                reason: "legacy_preference".to_string(),
            });
        }
    }

    // 4. Local fallback
    if available(BrowserBackendKind::Local) {
        return Ok(ResolvedBackend {
            kind: BrowserBackendKind::Local,
            reason: "local_fallback".to_string(),
        });
    }

    Err("No browser provider is available".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    // Build an availability predicate from a set of always-available kinds.
    fn available_from(kinds: &[BrowserBackendKind]) -> impl Fn(BrowserBackendKind) -> bool {
        let set = kinds.iter().copied().collect::<Vec<_>>();
        move |kind| set.contains(&kind)
    }

    #[test]
    fn prefers_cdp_url_override_over_configured_backend() {
        let available = available_from(&[
            BrowserBackendKind::Cdp,
            BrowserBackendKind::Browserbase,
            BrowserBackendKind::Local,
        ]);
        let resolved = resolve_backend(
            BrowserBackendKind::Browserbase,
            Some("ws://127.0.0.1:9222/devtools/browser/abc"),
            None,
            &available,
        )
        .unwrap();
        assert_eq!(resolved.kind, BrowserBackendKind::Cdp);
        assert_eq!(resolved.reason, "cdp_url_override");
    }

    #[test]
    fn uses_explicit_configured_backend_when_available() {
        let available =
            available_from(&[BrowserBackendKind::Browserbase, BrowserBackendKind::Local]);
        let resolved =
            resolve_backend(BrowserBackendKind::Browserbase, None, None, &available).unwrap();
        assert_eq!(resolved.kind, BrowserBackendKind::Browserbase);
        assert_eq!(resolved.reason, "configured_backend");
    }

    #[test]
    fn falls_back_through_legacy_preference_order() {
        let available =
            available_from(&[BrowserBackendKind::BrowserUse, BrowserBackendKind::Local]);
        let resolved = resolve_backend(BrowserBackendKind::Local, None, None, &available).unwrap();
        assert_eq!(resolved.kind, BrowserBackendKind::BrowserUse);
        assert_eq!(resolved.reason, "legacy_preference");
    }

    #[test]
    fn falls_back_to_local_when_nothing_else_is_available() {
        let available = available_from(&[BrowserBackendKind::Local]);
        let resolved =
            resolve_backend(BrowserBackendKind::Browserbase, None, None, &available).unwrap();
        assert_eq!(resolved.kind, BrowserBackendKind::Local);
        assert_eq!(resolved.reason, "local_fallback");
    }

    #[test]
    fn throws_when_no_provider_is_available() {
        let available = available_from(&[]);
        let err = resolve_backend(BrowserBackendKind::Local, None, None, &available).unwrap_err();
        assert_eq!(err, "No browser provider is available");
    }

    #[test]
    fn env_hints_influence_availability() {
        let available =
            available_from(&[BrowserBackendKind::Browserbase, BrowserBackendKind::Local]);
        let resolved =
            resolve_backend(BrowserBackendKind::Browserbase, None, None, &available).unwrap();
        assert_eq!(resolved.kind, BrowserBackendKind::Browserbase);
        assert_eq!(resolved.reason, "configured_backend");
    }
}
