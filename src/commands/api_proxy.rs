// HTTP proxy commands: api_request, external_request, upload_file.
//
// Replaces the Electron ipcMain handlers at
// hermes-cn-ui-v1/apps/desktop/src/main/main.ts lines 532-650.
//
// api_request is the most complex: it intercepts certain routes locally
// (session logs, archive, runtime update) and proxies everything else
// to the hermes dashboard with auth header injection.

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::LazyLock;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::cron_runs;
use crate::error::AppError;
use crate::process::dashboard::{build_gateway_url, fetch_session_token};
use crate::session_archive;
use crate::session_log;
use crate::state::AppState;

const SESSION_LOG_ROUTE_PREFIX: &str = "/__hermes_session_log/";
const EXTERNAL_TIMEOUT: Duration = Duration::from_secs(15);
const DASHBOARD_PROXY_TIMEOUT: Duration = Duration::from_secs(30);
const UPLOAD_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_UPLOAD_BYTES: usize = 100 * 1024 * 1024;
const MAX_UPLOAD_BASE64_LEN: usize = MAX_UPLOAD_BYTES.div_ceil(3) * 4;
static DASHBOARD_PROXY_HTTP_CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .timeout(DASHBOARD_PROXY_TIMEOUT)
        .build()
        .expect("valid dashboard proxy HTTP client")
});
static UPLOAD_HTTP_CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .timeout(UPLOAD_TIMEOUT)
        .build()
        .expect("valid upload HTTP client")
});
static EXTERNAL_HTTP_CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .timeout(EXTERNAL_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("valid external HTTP client")
});

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiRequestInput {
    pub path: String,
    #[serde(default)]
    pub method: Option<String>,
    #[serde(default)]
    pub headers: Option<HashMap<String, String>>,
    #[serde(default)]
    pub body: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiRequestResult {
    pub ok: bool,
    pub status: u16,
    pub status_text: String,
    pub headers: HashMap<String, String>,
    pub body: String,
}

fn json_result(status: u16, status_text: &str, body: serde_json::Value) -> ApiRequestResult {
    let mut headers = HashMap::new();
    headers.insert("content-type".to_string(), "application/json".to_string());
    ApiRequestResult {
        ok: (200..300).contains(&status),
        status,
        status_text: status_text.to_string(),
        headers,
        body: serde_json::to_string(&body).unwrap_or_default(),
    }
}

/// Extract the URL path component (strip query string).
fn url_path(path: &str) -> String {
    if let Ok(url) = url::Url::parse(&format!("http://x{}", path)) {
        url.path().to_string()
    } else {
        path.split('?').next().unwrap_or(path).to_string()
    }
}

fn upload_limit_error() -> AppError {
    AppError::InvalidRequest(format!(
        "upload_file exceeds {} MiB limit",
        MAX_UPLOAD_BYTES / 1024 / 1024
    ))
}

fn ensure_upload_base64_size(encoded_len: usize) -> Result<(), AppError> {
    if encoded_len > MAX_UPLOAD_BASE64_LEN {
        return Err(upload_limit_error());
    }
    Ok(())
}

fn ensure_upload_decoded_size(decoded_len: usize) -> Result<(), AppError> {
    if decoded_len > MAX_UPLOAD_BYTES {
        return Err(upload_limit_error());
    }
    Ok(())
}

fn is_blocked_external_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let octets = v4.octets();
            v4.is_private()
                || v4.is_loopback()
                || v4.is_link_local()
                || v4.is_broadcast()
                || v4.is_unspecified()
                || octets[0] == 0
                || (octets[0] == 100 && (64..=127).contains(&octets[1]))
        }
        IpAddr::V6(v6) => {
            let first = v6.segments()[0];
            v6.is_loopback()
                || v6.is_unspecified()
                || (first & 0xfe00) == 0xfc00
                || (first & 0xffc0) == 0xfe80
                || v6
                    .to_ipv4_mapped()
                    .is_some_and(|v4| is_blocked_external_ip(IpAddr::V4(v4)))
        }
    }
}

fn is_allowed_local_external_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.is_loopback() || v4.is_unspecified(),
        IpAddr::V6(v6) => {
            v6.is_loopback()
                || v6.is_unspecified()
                || v6
                    .to_ipv4_mapped()
                    .is_some_and(|v4| v4.is_loopback() || v4.is_unspecified())
        }
    }
}

fn is_allowed_local_external_domain(host: &str) -> bool {
    let lower_host = host.trim_end_matches('.').to_ascii_lowercase();
    lower_host == "localhost" || lower_host.ends_with(".localhost")
}

fn is_allowed_local_external_url(url: &url::Url) -> bool {
    match url.host() {
        Some(url::Host::Domain(host)) => is_allowed_local_external_domain(host),
        Some(url::Host::Ipv4(ip)) => is_allowed_local_external_ip(IpAddr::V4(ip)),
        Some(url::Host::Ipv6(ip)) => is_allowed_local_external_ip(IpAddr::V6(ip)),
        None => false,
    }
}

fn validate_external_url_shape(raw: &str) -> Result<url::Url, AppError> {
    let url = url::Url::parse(raw)?;
    let is_local_url = is_allowed_local_external_url(&url);
    if url.scheme() != "https" && !(url.scheme() == "http" && is_local_url) {
        return Err(AppError::InvalidRequest(
            "external_request only allows https URLs; http is only allowed for local URLs"
                .to_string(),
        ));
    }

    match url.host().ok_or_else(|| {
        AppError::InvalidRequest("external_request URL must include a host".to_string())
    })? {
        url::Host::Domain(_) => {}
        url::Host::Ipv4(ip) => {
            let ip = IpAddr::V4(ip);
            if !is_allowed_local_external_ip(ip) && is_blocked_external_ip(ip) {
                return Err(AppError::InvalidRequest(
                    "external_request refuses private or local IP targets".to_string(),
                ));
            }
        }
        url::Host::Ipv6(ip) => {
            let ip = IpAddr::V6(ip);
            if !is_allowed_local_external_ip(ip) && is_blocked_external_ip(ip) {
                return Err(AppError::InvalidRequest(
                    "external_request refuses private or local IP targets".to_string(),
                ));
            }
        }
    }

    Ok(url)
}

async fn validate_external_url(raw: &str) -> Result<url::Url, AppError> {
    let url = validate_external_url_shape(raw)?;

    if let Some(url::Host::Domain(host)) = url.host() {
        if is_allowed_local_external_domain(host) {
            return Ok(url);
        }
        let port = url.port_or_known_default().ok_or_else(|| {
            AppError::InvalidRequest("external_request URL must include a port".to_string())
        })?;
        let resolved = tokio::net::lookup_host((host, port)).await.map_err(|e| {
            AppError::InvalidRequest(format!("external_request DNS lookup failed: {}", e))
        })?;
        for addr in resolved {
            if is_blocked_external_ip(addr.ip()) {
                return Err(AppError::InvalidRequest(
                    "external_request refuses hosts resolving to private or local IPs".to_string(),
                ));
            }
        }
    }

    Ok(url)
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    #[test]
    fn url_path_strips_query_string() {
        assert_eq!(url_path("/api/foo?bar=1&baz=2"), "/api/foo");
    }

    #[test]
    fn url_path_passes_through_without_query() {
        assert_eq!(url_path("/api/foo"), "/api/foo");
    }

    #[test]
    fn url_path_handles_empty_path() {
        assert_eq!(url_path(""), "/");
    }

    #[test]
    fn url_path_handles_root() {
        assert_eq!(url_path("/"), "/");
    }

    #[test]
    fn json_result_2xx_is_ok() {
        let r = json_result(200, "OK", serde_json::json!({"x": 1}));
        assert!(r.ok);
        assert_eq!(r.status, 200);
        assert_eq!(r.status_text, "OK");
        assert_eq!(
            r.headers.get("content-type"),
            Some(&"application/json".to_string())
        );
        assert_eq!(r.body, "{\"x\":1}");
    }

    #[test]
    fn json_result_4xx_is_not_ok() {
        let r = json_result(404, "Not Found", serde_json::json!({"message": "nope"}));
        assert!(!r.ok);
        assert_eq!(r.status, 404);
    }

    #[test]
    fn json_result_5xx_is_not_ok() {
        let r = json_result(503, "Down", serde_json::json!(null));
        assert!(!r.ok);
        assert_eq!(r.status, 503);
    }

    #[test]
    fn json_result_boundary_300_is_not_ok() {
        // 300..399 redirects are explicitly not "ok" by this convention.
        let r = json_result(301, "Moved", serde_json::json!(null));
        assert!(!r.ok);
    }

    #[test]
    fn upload_base64_limit_is_checked_before_decode() {
        assert!(ensure_upload_base64_size(MAX_UPLOAD_BASE64_LEN).is_ok());
        let err = ensure_upload_base64_size(MAX_UPLOAD_BASE64_LEN + 1).unwrap_err();
        assert!(matches!(err, AppError::InvalidRequest(msg) if msg.contains("100 MiB")));
    }

    #[test]
    fn upload_decoded_limit_is_checked_after_decode() {
        assert!(ensure_upload_decoded_size(MAX_UPLOAD_BYTES).is_ok());
        let err = ensure_upload_decoded_size(MAX_UPLOAD_BYTES + 1).unwrap_err();
        assert!(matches!(err, AppError::InvalidRequest(msg) if msg.contains("100 MiB")));
    }

    #[test]
    fn external_url_shape_requires_https() {
        let err = validate_external_url_shape("http://api.example.com/models").unwrap_err();
        assert!(err.to_string().contains("only allows https"));
    }

    #[test]
    fn external_url_shape_accepts_local_http_targets() {
        for raw in [
            "http://localhost:1234/v1/models",
            "http://service.localhost:1234/v1/models",
            "http://127.0.0.1:1234/v1/models",
            "http://0.0.0.0:1234/v1/models",
            "http://[::1]:1234/v1/models",
        ] {
            let url = validate_external_url_shape(raw).unwrap();
            assert_eq!(url.scheme(), "http");
        }
    }

    #[tokio::test]
    async fn external_url_allows_localhost_without_dns_rejection() {
        let url = validate_external_url("http://localhost:1234/v1/models")
            .await
            .unwrap();
        assert_eq!(url.host_str(), Some("localhost"));
    }

    #[test]
    fn external_url_shape_rejects_private_ip_literals() {
        for raw in [
            "https://10.0.0.1/status",
            "https://172.16.0.1/status",
            "https://192.168.1.1/status",
            "https://169.254.169.254/latest/meta-data",
            "https://[fc00::1]/status",
            "https://[fe80::1]/status",
        ] {
            let err = validate_external_url_shape(raw).unwrap_err();
            assert!(
                err.to_string().contains("private or local")
                    || err.to_string().contains("localhost"),
                "unexpected error for {raw}: {err}"
            );
        }
    }

    #[test]
    fn external_url_shape_accepts_public_https_hosts() {
        let url = validate_external_url_shape("https://api.example.com/v1/models").unwrap();
        assert_eq!(url.scheme(), "https");
        assert_eq!(url.host_str(), Some("api.example.com"));
    }
}

/// Core implementation of `api_request` with no Tauri State dependency.
/// Exposed for integration tests; production callers go through the
/// `#[tauri::command]` wrapper below.
pub async fn api_request_impl(
    input: ApiRequestInput,
    api_base_url: &str,
    session_token: Option<&str>,
    hermes_home: &str,
) -> Result<ApiRequestResult, AppError> {
    api_request_impl_with_home_base(input, api_base_url, session_token, hermes_home, hermes_home)
        .await
}

/// Core implementation variant used by the Tauri command so local desktop
/// intercepts can read both the active profile home and the profile root.
pub async fn api_request_impl_with_home_base(
    input: ApiRequestInput,
    api_base_url: &str,
    session_token: Option<&str>,
    hermes_home: &str,
    hermes_home_base: &str,
) -> Result<ApiRequestResult, AppError> {
    let method = input.method.as_deref().unwrap_or("GET");
    let path = &input.path;
    let url_p = url_path(path);

    // 1. Session log intercept
    if let Some(rest) = url_p.strip_prefix(SESSION_LOG_ROUTE_PREFIX) {
        let session_id = urlencoding::decode(rest).unwrap_or_default().to_string();
        let (status, body) = session_log::handle_session_log_request(&session_id, hermes_home);
        let status_text = if status == 200 { "OK" } else { "Not Found" };
        return Ok(json_result(status, status_text, body));
    }

    // 2. Session archive intercept
    if let Some((status, body)) = session_archive::handle_archive_request(path, method, hermes_home)
    {
        let status_text = if status == 200 { "OK" } else { "Error" };
        return Ok(json_result(status, status_text, body));
    }

    // 3. Cron run history intercept (desktop-local, read-only)
    if let Some((status, body)) =
        cron_runs::handle_cron_runs_request(path, method, hermes_home_base)
    {
        let status_text = if status == 200 { "OK" } else { "Error" };
        return Ok(json_result(status, status_text, body));
    }

    // 4. Runtime update intercept
    if url_p == "/api/hermes/update" && method.to_uppercase() == "POST" {
        let result = crate::process::runtime::install_runtime_update(None).await;
        let status = if result.ok { 200 } else { 503 };
        let status_text = if result.ok {
            "OK"
        } else {
            "Runtime Update Failed"
        };
        let body = serde_json::to_value(&result).unwrap_or_default();
        return Ok(json_result(status, status_text, body));
    }

    // 5. Proxy to dashboard
    let full_url = if path.starts_with("http://") || path.starts_with("https://") {
        // Validate same origin
        let base = url::Url::parse(api_base_url)?;
        let target = url::Url::parse(path)?;
        if target.origin() != base.origin() {
            return Err(AppError::OriginViolation(
                base.origin().ascii_serialization(),
            ));
        }
        path.to_string()
    } else {
        let base = api_base_url.trim_end_matches('/');
        let p = if path.starts_with('/') {
            path.to_string()
        } else {
            format!("/{}", path)
        };
        format!("{}{}", base, p)
    };

    let mut req = DASHBOARD_PROXY_HTTP_CLIENT
        .request(method.parse().unwrap_or(reqwest::Method::GET), &full_url);

    // Inject auth headers
    if let Some(token) = session_token {
        req = req
            .header("Authorization", format!("Bearer {}", token))
            .header("X-Hermes-Session-Token", token);
    }

    // Forward caller headers (don't override auth)
    if let Some(ref headers) = input.headers {
        for (key, value) in headers {
            let lower = key.to_lowercase();
            if lower != "authorization" && lower != "x-hermes-session-token" {
                req = req.header(key.as_str(), value.as_str());
            }
        }
    }

    if let Some(ref body) = input.body {
        req = req.body(body.clone());
    }

    let res = req.send().await?;
    let status = res.status().as_u16();
    let status_text = res.status().canonical_reason().unwrap_or("").to_string();
    let res_headers: HashMap<String, String> = res
        .headers()
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string()))
        .collect();
    let raw_body = res.text().await.unwrap_or_default();

    // 6. Post-process: filter archived sessions
    let body = session_archive::filter_archived_from_response(path, method, hermes_home, &raw_body);

    Ok(ApiRequestResult {
        ok: (200..300).contains(&status),
        status,
        status_text,
        headers: res_headers,
        body,
    })
}

/// The main API proxy command. Handles local route intercepts and proxies
/// to the dashboard for everything else.
#[tauri::command]
pub async fn api_request(
    input: ApiRequestInput,
    state: State<'_, AppState>,
) -> Result<ApiRequestResult, AppError> {
    let (api_base_url, session_token, hermes_home, hermes_home_base) = {
        let inner = state.inner.lock()?;
        (
            inner.api_base_url.clone(),
            inner.session_token.clone(),
            inner.hermes_home.clone(),
            inner.hermes_home_base.clone(),
        )
    };

    let first = api_request_impl_with_home_base(
        input.clone(),
        &api_base_url,
        session_token.as_deref(),
        &hermes_home,
        &hermes_home_base,
    )
    .await?;
    if first.status != 401 {
        return Ok(first);
    }

    // Dashboard session tokens are process-local. If the dashboard restarts
    // while the Tauri process remains alive, the cached token becomes stale and
    // every proxied request fails with 401. Refresh from the dashboard HTML and
    // retry once so ordinary UI reads recover without requiring an app restart.
    let fresh_token = match std::env::var("HERMES_DESKTOP_SESSION_TOKEN").ok() {
        Some(token) => Some(token),
        None => fetch_session_token(&api_base_url).await,
    };
    if fresh_token.is_none() || fresh_token == session_token {
        return Ok(first);
    }

    let fresh_gateway_url = build_gateway_url(&api_base_url, fresh_token.as_deref());
    {
        let mut inner = state.inner.lock()?;
        inner.session_token = fresh_token.clone();
        inner.gateway_url = fresh_gateway_url;
    }

    api_request_impl_with_home_base(
        input,
        &api_base_url,
        fresh_token.as_deref(),
        &hermes_home,
        &hermes_home_base,
    )
    .await
}

/// Proxy an HTTP request to an arbitrary external URL (15s timeout).
#[tauri::command]
pub async fn external_request(input: ApiRequestInput) -> Result<ApiRequestResult, AppError> {
    let target_url = validate_external_url(&input.path).await?;
    external_request_impl(input, target_url).await
}

/// Core implementation of `external_request` with validation already handled by
/// the caller. Exposed for integration tests so wiremock can exercise request
/// forwarding without loosening production URL validation.
pub async fn external_request_impl(
    input: ApiRequestInput,
    target_url: url::Url,
) -> Result<ApiRequestResult, AppError> {
    let method = input.method.as_deref().unwrap_or("GET");
    let display_url = target_url.as_str().to_string();
    let mut req =
        EXTERNAL_HTTP_CLIENT.request(method.parse().unwrap_or(reqwest::Method::GET), target_url);

    if let Some(ref headers) = input.headers {
        for (key, value) in headers {
            req = req.header(key.as_str(), value.as_str());
        }
    }

    if let Some(ref body) = input.body {
        req = req.body(body.clone());
    }

    match req.send().await {
        Ok(res) => {
            let status = res.status().as_u16();
            let status_text = res.status().canonical_reason().unwrap_or("").to_string();
            let headers: HashMap<String, String> = res
                .headers()
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string()))
                .collect();
            let body = res.text().await.unwrap_or_default();
            Ok(ApiRequestResult {
                ok: (200..300).contains(&status),
                status,
                status_text,
                headers,
                body,
            })
        }
        Err(e) => {
            let is_timeout = e.is_timeout();
            Ok(ApiRequestResult {
                ok: false,
                status: if is_timeout { 408 } else { 0 },
                status_text: if is_timeout {
                    "Request Timeout".to_string()
                } else {
                    "Network Error".to_string()
                },
                headers: HashMap::new(),
                body: if is_timeout {
                    format!("Request to {} timed out after 15s", display_url)
                } else {
                    e.to_string()
                },
            })
        }
    }
}

/// Core implementation of `upload_file` with no Tauri State dependency.
/// Exposed for integration tests.
pub async fn upload_file_impl(
    input: UploadFileInput,
    api_base_url: &str,
    session_token: Option<&str>,
) -> Result<ApiRequestResult, AppError> {
    use base64::Engine;

    ensure_upload_base64_size(input.data.len())?;
    let file_bytes = base64::engine::general_purpose::STANDARD
        .decode(&input.data)
        .map_err(|e| AppError::InvalidRequest(format!("Invalid base64: {}", e)))?;
    ensure_upload_decoded_size(file_bytes.len())?;

    let mime_type = input
        .r#type
        .as_deref()
        .unwrap_or("application/octet-stream");

    let file_part = reqwest::multipart::Part::bytes(file_bytes)
        .file_name(input.name.clone())
        .mime_str(mime_type)?;

    let form = reqwest::multipart::Form::new()
        .text("session_id", input.session_id)
        .part("file", file_part);

    let url = format!("{}/api/upload", api_base_url.trim_end_matches('/'));
    let mut req = UPLOAD_HTTP_CLIENT.post(&url).multipart(form);

    if let Some(token) = session_token {
        req = req
            .header("Authorization", format!("Bearer {}", token))
            .header("X-Hermes-Session-Token", token);
    }

    let res = req.send().await?;
    let status = res.status().as_u16();
    let status_text = res.status().canonical_reason().unwrap_or("").to_string();
    let headers: HashMap<String, String> = res
        .headers()
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string()))
        .collect();
    let body = res.text().await.unwrap_or_default();

    Ok(ApiRequestResult {
        ok: (200..300).contains(&status),
        status,
        status_text,
        headers,
        body,
    })
}

/// Upload a file to the dashboard's /api/upload endpoint.
/// The file data arrives as a base64-encoded string from the frontend.
#[tauri::command]
pub async fn upload_file(
    input: UploadFileInput,
    state: State<'_, AppState>,
) -> Result<ApiRequestResult, AppError> {
    let (api_base_url, session_token) = {
        let inner = state.inner.lock()?;
        (inner.api_base_url.clone(), inner.session_token.clone())
    };
    upload_file_impl(input, &api_base_url, session_token.as_deref()).await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadFileInput {
    pub session_id: String,
    pub name: String,
    #[serde(default)]
    pub r#type: Option<String>,
    /// Base64-encoded file content.
    pub data: String,
}
