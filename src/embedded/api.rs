//! Embedded-mode REST dispatch (report Phase 4 延伸 / §3.7 Hard FFI).
//!
//! `api_request` in embedded mode never touches reqwest or an ASGI bridge.
//! Every proxy-pass route is looked up in the FFI registry (`ffi.rs`) and
//! dispatched directly to `hermes_embedded.api.handle_rpc(method, params, ctx)`
//! through the unified pyo3 call wrapper (`call.rs`). Routes without an FFI
//! entry are a hard error — embedded mode must NOT silently fall back to HTTP.
//!
//! Local desktop routes (`/__hermes_session_log/…`, `/__hermes_cron_runs/…`)
//! are handled by the existing Rust-side readers (session_log/cron_runs) before
//! this module runs; they never reach Python or a socket.

use std::collections::HashMap;

use crate::commands::api_proxy::{ApiRequestInput, ApiRequestResult};
use crate::embedded::{ffi, ready_runtime};
use crate::error::{AppError, AppResult};

/// Dispatch one REST request in embedded mode.
///
/// `hermes_home` / `session_token` / `profile` substitute the HTTP headers and
/// cookies the old proxy injected (report §4 Phase 4 延伸 design): the FFI ctx
/// carries them instead of `Authorization` / `X-Hermes-Session-Token` headers.
pub async fn embedded_rest_request(
    hermes_home: &str,
    session_token: Option<&str>,
    profile: &str,
    input: &ApiRequestInput,
) -> AppResult<ApiRequestResult> {
    let _runtime = ready_runtime()?;

    let path = url_path(&input.path);
    if ffi::LOCAL_INTERCEPT_PREFIXES
        .iter()
        .any(|prefix| path.starts_with(prefix))
    {
        return Err(AppError::InvalidRequest(format!(
            "route {path} is a local desktop route and must be handled by the \
             Rust-side reader, not the embedded REST path"
        )));
    }

    let entry = ffi::entry_for_route(&path).ok_or_else(|| AppError::EmbeddedPython {
        msg: format!(
            "embedded mode has no FFI entry for route {path}; refusing to fall \
             back to HTTP (Hard FFI coverage gate)"
        ),
        traceback: None,
    })?;

    let params = request_params(input, &path);
    let ctx = request_ctx(hermes_home, session_token, profile, &path);
    let result = crate::embedded::call::call_handle_rpc_blocking(entry.python_func, &params, &ctx)?;

    let mut headers = HashMap::new();
    headers.insert("content-type".to_string(), "application/json".to_string());
    Ok(ApiRequestResult {
        ok: true,
        status: 200,
        status_text: "OK".to_string(),
        headers,
        body: result.to_string(),
    })
}

/// Normalized URL path (strip query string) — mirrors api_proxy::url_path.
fn url_path(path: &str) -> String {
    if let Ok(url) = url::Url::parse(&format!("http://x{}", path)) {
        url.path().to_string()
    } else {
        path.split('?').next().unwrap_or(path).to_string()
    }
}

/// Build the `params` argument: parsed JSON body (if any) merged with the
/// normalized path and HTTP method so Python handlers can route precisely.
fn request_params(input: &ApiRequestInput, path: &str) -> String {
    let mut params = match input.body.as_deref() {
        Some(body) if !body.trim().is_empty() => {
            serde_json::from_str::<serde_json::Value>(body).unwrap_or(serde_json::Value::Null)
        }
        _ => serde_json::Value::Null,
    };
    if let serde_json::Value::Object(map) = &mut params {
        map.insert(
            "path".to_string(),
            serde_json::Value::String(path.to_string()),
        );
        map.insert(
            "method".to_string(),
            serde_json::Value::String(input.method.clone().unwrap_or_else(|| "GET".to_string())),
        );
    } else {
        params = serde_json::json!({
            "path": path,
            "method": input.method.clone().unwrap_or_else(|| "GET".to_string()),
            "body": params,
        });
    }
    params.to_string()
}

/// Build the `ctx` argument: hermes home + session token + profile substitute
/// the HTTP headers/cookies the old proxy injected.
fn request_ctx(
    hermes_home: &str,
    session_token: Option<&str>,
    profile: &str,
    path: &str,
) -> String {
    serde_json::json!({
        "path": path,
        "hermesHome": hermes_home,
        "sessionToken": session_token,
        "profile": profile,
    })
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_path_strips_query() {
        assert_eq!(url_path("/api/version?x=1"), "/api/version");
        assert_eq!(url_path("/api/status"), "/api/status");
    }

    #[test]
    fn request_params_merges_body_and_meta() {
        let input = ApiRequestInput {
            path: "/api/session/abc".into(),
            method: Some("GET".into()),
            headers: None,
            body: Some(r#"{"mode":"resume"}"#.into()),
        };
        let params: serde_json::Value =
            serde_json::from_str(&request_params(&input, "/api/session/abc")).unwrap();
        assert_eq!(params["mode"], "resume");
        assert_eq!(params["path"], "/api/session/abc");
        assert_eq!(params["method"], "GET");
    }

    #[test]
    fn request_params_wraps_non_object_body() {
        let input = ApiRequestInput {
            path: "/api/prompt".into(),
            method: Some("POST".into()),
            headers: None,
            body: Some("42".into()),
        };
        let params: serde_json::Value =
            serde_json::from_str(&request_params(&input, "/api/prompt")).unwrap();
        assert_eq!(params["body"], 42);
        assert_eq!(params["method"], "POST");
    }

    #[test]
    fn request_ctx_carries_contract_fields() {
        let ctx: serde_json::Value =
            serde_json::from_str(&request_ctx("/home/h", Some("tok"), "work", "/api/status"))
                .unwrap();
        assert_eq!(ctx["hermesHome"], "/home/h");
        assert_eq!(ctx["sessionToken"], "tok");
        assert_eq!(ctx["profile"], "work");
        assert_eq!(ctx["path"], "/api/status");
    }
}
