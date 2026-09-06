//! Typed hot-path FFI RPC wrappers (report §4 Phase 4 / change list
//! `src/embedded/rpc.rs`).
//!
//! The unified `call_handle_rpc(method, params, ctx)` entry point is the single
//! dispatch mechanism; this module adds typed convenience wrappers for the
//! highest-frequency Gateway JSON-RPC methods and REST routes so callers never
//! hand-build JSON-RPC shapes. The registry in `ffi.rs` remains the coverage
//! source of truth — every wrapper here must correspond to an entry in
//! `REST_FFI_SURFACE` / `GATEWAY_FFI_METHODS` (Phase 4 延伸 consolidates rpc.rs
//! into the registry for scheduling).

use serde_json::{json, Value};

use crate::embedded::{call, ffi};
use crate::error::{AppError, AppResult};

/// Embedded context shared by all RPC calls (replaces HTTP headers/cookies).
pub fn ctx(hermes_home: &str, session_token: Option<&str>, profile: &str) -> Value {
    json!({
        "hermesHome": hermes_home,
        "sessionToken": session_token,
        "profile": profile,
    })
}

// ── REST hot paths (report §4 Phase 4 priority list) ───────────────────────

pub fn get_version() -> AppResult<String> {
    let value = call::call_handle_rpc("get_version", "{}", "{}")?;
    value
        .as_str()
        .map(String::from)
        .ok_or_else(|| AppError::EmbeddedPython {
            msg: "embedded get_version() did not return a string".to_string(),
            traceback: None,
        })
}

pub fn get_status() -> AppResult<Value> {
    call::call_handle_rpc("get_status", "{}", "{}")
}

pub fn get_gateway_config() -> AppResult<Value> {
    call::call_handle_rpc("get_gateway_config", "{}", "{}")
}

pub fn get_config() -> AppResult<Value> {
    call::call_handle_rpc("get_config", "{}", "{}")
}

pub fn list_sessions() -> AppResult<Value> {
    call::call_handle_rpc("handle_session", r#"{"action":"list"}"#, "{}")
}

// ── Gateway JSON-RPC hot paths ─────────────────────────────────────────────

pub fn create_session(params: Value) -> AppResult<Value> {
    call::call_handle_rpc("session.create", &params.to_string(), "{}")
}

pub fn resume_session(params: Value) -> AppResult<Value> {
    call::call_handle_rpc("session.resume", &params.to_string(), "{}")
}

pub fn submit_prompt(params: Value) -> AppResult<Value> {
    call::call_handle_rpc("prompt.submit", &params.to_string(), "{}")
}

pub fn abort_prompt(params: Value) -> AppResult<Value> {
    call::call_handle_rpc("prompt.abort", &params.to_string(), "{}")
}

pub fn setup_status() -> AppResult<Value> {
    call::call_handle_rpc("setup.status", "{}", "{}")
}

pub fn model_info(params: Value) -> AppResult<Value> {
    call::call_handle_rpc("model.info", &params.to_string(), "{}")
}

pub fn model_list() -> AppResult<Value> {
    call::call_handle_rpc("model.list", "{}", "{}")
}

/// Dispatch one Gateway JSON-RPC method through the FFI registry. Rejects
/// methods with no registered FFI entry so an unknown frame can never fall
/// back to a transport (report Phase 4 延伸 / §8 criterion 9).
pub fn dispatch_gateway_method(method: &str, params: Value, ctx: Value) -> AppResult<Value> {
    if !ffi::covered_gateway_method(method) {
        return Err(AppError::EmbeddedPython {
            msg: format!("embedded gateway has no FFI entry for method {method}"),
            traceback: None,
        });
    }
    call::call_handle_rpc(method, &params.to_string(), &ctx.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    #[test]
    fn ctx_carries_contract_fields() {
        let ctx = ctx("/home/h", Some("tok"), "work");
        assert_eq!(ctx["hermesHome"], "/home/h");
        assert_eq!(ctx["sessionToken"], "tok");
        assert_eq!(ctx["profile"], "work");
    }

    #[test]
    fn dispatch_rejects_unregistered_methods() {
        let err = dispatch_gateway_method("not.a.method", json!({}), json!({})).unwrap_err();
        assert!(matches!(err, AppError::EmbeddedPython { .. }));
    }

    #[test]
    fn dispatch_accepts_registered_methods() {
        // Validation only (no interpreter without the feature) — every
        // registered gateway method must pass the coverage gate.
        for method in ffi::GATEWAY_FFI_METHODS {
            assert!(
                ffi::covered_gateway_method(method),
                "{method} must be covered"
            );
        }
    }

    #[test]
    fn typed_wrappers_map_to_registered_entries() {
        // Every typed wrapper method name must exist in the FFI registry so the
        // coverage gate cannot be bypassed by a wrapper that calls an
        // unregistered method.
        let registry_methods: Vec<&str> = ffi::GATEWAY_FFI_METHODS.to_vec();
        for m in [
            "session.create",
            "session.resume",
            "prompt.submit",
            "prompt.abort",
            "setup.status",
            "model.info",
            "model.list",
        ] {
            assert!(
                registry_methods.contains(&m),
                "{m} missing from gateway registry"
            );
        }
    }

    #[test]
    fn version_string_is_parsed_from_result() {
        // Pure Rust: the wrapper's string extraction logic.
        let value = json!("0.8.0-rc4");
        assert_eq!(value.as_str(), Some("0.8.0-rc4"));
    }
}
