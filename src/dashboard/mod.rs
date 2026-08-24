//! Local-first dashboard layer: HMAC session store, static token provider,
//! request router, and status/auth route handlers.
//!
//! This is the Rust port of `packages/dashboard/src/...` (see
//! `plans/rust-rewrite-dashboard.md`). The TS implementation remains the
//! browser-only fallback; Rust is selected when a Tauri runtime is present.

pub mod router;
pub mod routes;
pub mod session;
pub mod token;
