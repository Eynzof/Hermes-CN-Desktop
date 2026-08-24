//! Security helpers: shared SSRF / URL-safety guards.
//!
//! `src/security/url.rs` consolidates the browser `packages/browser/src/ssrf.ts`
//! guard with the existing `commands/api_proxy.rs` `is_blocked_external_ip` /
//! `validate_external_url` helpers so that browser, api_proxy, and context_refs
//! all use one authoritative implementation.

pub mod url;
pub use url::*;
