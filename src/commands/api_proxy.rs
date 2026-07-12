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

use futures_util::StreamExt;
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
const DASHBOARD_AUDIO_PROXY_TIMEOUT: Duration = Duration::from_secs(180);
const UPLOAD_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_UPLOAD_BYTES: usize = 100 * 1024 * 1024;
const MAX_UPLOAD_BASE64_LEN: usize = MAX_UPLOAD_BYTES.div_ceil(3) * 4;
const MAX_EXTERNAL_IMAGE_BYTES: usize = 20 * 1024 * 1024;
const MAX_EXTERNAL_IMAGE_REDIRECTS: usize = 5;
// Dashboard-facing clients never follow redirects: a gated dashboard answers
// unauthenticated requests with 401 JSON, but a misconfigured one could 302 →
// /login. Following that silently would turn a 401 into a 200 whose body is
// login-page HTML (and drop auth headers on a cross-host hop). Fail loud.
static DASHBOARD_PROXY_HTTP_CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .timeout(DASHBOARD_PROXY_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("valid dashboard proxy HTTP client")
});
static DASHBOARD_AUDIO_PROXY_HTTP_CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .timeout(DASHBOARD_AUDIO_PROXY_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("valid dashboard audio proxy HTTP client")
});
static UPLOAD_HTTP_CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .timeout(UPLOAD_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
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

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadExternalImageInput {
    pub url: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadExternalImageResult {
    pub final_url: String,
    pub filename: String,
    pub mime_type: String,
    pub data_base64: String,
    pub size: usize,
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

fn is_audio_api_path(path: &str) -> bool {
    url_path(path).starts_with("/api/audio/")
}

fn upload_limit_error() -> AppError {
    AppError::InvalidRequest(format!(
        "upload_file exceeds {} MiB limit",
        MAX_UPLOAD_BYTES / 1024 / 1024
    ))
}

fn external_image_limit_error() -> AppError {
    AppError::InvalidRequest(format!(
        "download_external_image exceeds {} MiB limit",
        MAX_EXTERNAL_IMAGE_BYTES / 1024 / 1024
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
    fn audio_api_path_matches_audio_routes_with_queries() {
        assert!(is_audio_api_path("/api/audio/transcribe"));
        assert!(is_audio_api_path("/api/audio/speak?debug=1"));
        assert!(!is_audio_api_path("/api/model/info"));
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

/// How the proxied dashboard request authenticates.
enum ProxyAuth<'a> {
    /// Legacy loopback/local/remote-token: inject Bearer + X-Hermes-Session-Token.
    Token(Option<&'a str>),
    /// Gated remote: use the cookie-aware session client, inject no headers.
    Oauth(&'a crate::oauth_session::OauthSession),
}

/// Core implementation variant used by the Tauri command so local desktop
/// intercepts can read both the active profile home and the profile root.
/// Token-auth entry point (loopback/local/remote-token + all existing tests).
pub async fn api_request_impl_with_home_base(
    input: ApiRequestInput,
    api_base_url: &str,
    session_token: Option<&str>,
    hermes_home: &str,
    hermes_home_base: &str,
) -> Result<ApiRequestResult, AppError> {
    api_request_impl_inner(
        input,
        api_base_url,
        ProxyAuth::Token(session_token),
        hermes_home,
        hermes_home_base,
    )
    .await
}

/// OAuth-auth entry point for gated remote gateways (cookie session client).
pub async fn api_request_impl_oauth(
    input: ApiRequestInput,
    api_base_url: &str,
    session: &crate::oauth_session::OauthSession,
    hermes_home: &str,
    hermes_home_base: &str,
) -> Result<ApiRequestResult, AppError> {
    api_request_impl_inner(
        input,
        api_base_url,
        ProxyAuth::Oauth(session),
        hermes_home,
        hermes_home_base,
    )
    .await
}

async fn api_request_impl_inner(
    input: ApiRequestInput,
    api_base_url: &str,
    auth: ProxyAuth<'_>,
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

    let is_audio = is_audio_api_path(path);
    let http_method = method.parse().unwrap_or(reqwest::Method::GET);
    let mut req = match &auth {
        ProxyAuth::Token(_) => {
            let client = if is_audio {
                &*DASHBOARD_AUDIO_PROXY_HTTP_CLIENT
            } else {
                &*DASHBOARD_PROXY_HTTP_CLIENT
            };
            client.request(http_method, &full_url)
        }
        ProxyAuth::Oauth(session) => {
            // One cookie-aware client (30s default); override per-request for
            // long-poll audio so streaming TTS/STT is not cut short.
            let mut b = session.client().request(http_method, &full_url);
            if is_audio {
                b = b.timeout(DASHBOARD_AUDIO_PROXY_TIMEOUT);
            }
            b
        }
    };

    // Inject auth headers (token mode only; oauth rides the cookie jar).
    if let ProxyAuth::Token(Some(token)) = &auth {
        req = req
            .header("Authorization", format!("Bearer {}", token))
            .header("X-Hermes-Session-Token", *token);
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
    app: tauri::AppHandle,
    input: ApiRequestInput,
    state: State<'_, AppState>,
) -> Result<ApiRequestResult, AppError> {
    let (api_base_url, auth, hermes_home, hermes_home_base, mode) = {
        let inner = state.inner.lock()?;
        (
            inner.api_base_url.clone(),
            inner.dashboard_auth(),
            inner.hermes_home.clone(),
            inner.hermes_home_base.clone(),
            inner.connection_mode,
        )
    };

    // Attached modes: the runtime-update intercept below manages the desktop
    // managed runtime, which is not what this shell is connected to.
    if mode != crate::connection::ConnectionMode::Managed
        && url_path(&input.path) == "/api/hermes/update"
        && input.method.as_deref().unwrap_or("GET").to_uppercase() == "POST"
    {
        return Ok(json_result(
            409,
            "Conflict",
            serde_json::json!({
                "ok": false,
                "error": "当前连接的不是本机内核，无法更新桌面端 managed runtime"
            }),
        ));
    }

    // OAuth remote: cookie-authed proxy. The server may rotate AT/RT on the
    // response (captured by the jar) — persist promptly. A 401 with a
    // session_expired/unauthenticated envelope means re-login is needed.
    if let crate::state::DashboardAuth::Oauth(session) = &auth {
        let result = api_request_impl_oauth(
            input,
            &api_base_url,
            session,
            &hermes_home,
            &hermes_home_base,
        )
        .await?;
        if session.take_dirty() {
            crate::oauth_session::persist_if_dirty(&api_base_url, session);
        }
        if result.status == 401 && is_auth_expired_body(&result.body) {
            emit_auth_expired(&app, &state, &api_base_url, &result.body);
        }
        return Ok(result);
    }

    let session_token = match &auth {
        crate::state::DashboardAuth::Token(t) => t.clone(),
        crate::state::DashboardAuth::Oauth(_) => None,
    };
    let first = api_request_impl_with_home_base(
        input.clone(),
        &api_base_url,
        session_token.as_deref(),
        &hermes_home,
        &hermes_home_base,
    )
    .await?;
    // Remote tokens are static (entered in Settings or via env); the
    // refresh-by-scraping-the-dashboard-HTML recovery below only applies to
    // managed runtime and loopback local CLI dashboards, whose token may
    // rotate on restart.
    if first.status != 401 || mode == crate::connection::ConnectionMode::Remote {
        return Ok(first);
    }

    // Dashboard session tokens are process-local. If the dashboard restarts
    // while the Tauri process remains alive, the cached token becomes stale and
    // every proxied request fails with 401. Refresh from the dashboard HTML and
    // retry once so ordinary UI reads recover without requiring an app restart.
    let fresh_token = match std::env::var("HERMES_DESKTOP_SESSION_TOKEN")
        .ok()
        .or_else(|| std::env::var("HERMES_DASHBOARD_SESSION_TOKEN").ok())
    {
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

/// True when a 401 body carries the gated-auth envelope signalling the remote
/// session is dead (needs re-login), vs a generic loopback `{detail:...}` 401.
fn is_auth_expired_body(body: &str) -> bool {
    let Ok(json) = serde_json::from_str::<serde_json::Value>(body) else {
        return false;
    };
    json.get("error")
        .and_then(|e| e.as_str())
        .map(|e| e == "session_expired" || e == "unauthenticated")
        .unwrap_or(false)
        || json.get("login_url").is_some()
}

/// Emit `connection-auth-expired` to the frontend so it can surface the
/// re-login banner. Debounced to 5s (a burst of 401s must not storm the UI).
fn emit_auth_expired(
    app: &tauri::AppHandle,
    state: &State<'_, AppState>,
    base_url: &str,
    body: &str,
) {
    use tauri::Emitter;
    {
        let mut inner = match state.inner.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        let now = std::time::Instant::now();
        if let Some(last) = inner.last_auth_expired_emit {
            if now.duration_since(last) < Duration::from_secs(5) {
                return;
            }
        }
        inner.last_auth_expired_emit = Some(now);
    }
    let json = serde_json::from_str::<serde_json::Value>(body).unwrap_or_default();
    let reason = json
        .get("error")
        .and_then(|e| e.as_str())
        .unwrap_or("unauthenticated")
        .to_string();
    let login_url = json
        .get("login_url")
        .and_then(|u| u.as_str())
        .map(String::from);
    let _ = app.emit(
        "connection-auth-expired",
        serde_json::json!({ "baseUrl": base_url, "reason": reason, "loginUrl": login_url }),
    );
}

/// Proxy an HTTP request to an arbitrary external URL (15s timeout).
#[tauri::command]
pub async fn external_request(input: ApiRequestInput) -> Result<ApiRequestResult, AppError> {
    let target_url = validate_external_url(&input.path).await?;
    external_request_impl(input, target_url).await
}

fn image_mime_from_magic(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G', b'\r', b'\n', 0x1a, b'\n']) {
        return Some("image/png");
    }
    if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        return Some("image/jpeg");
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some("image/gif");
    }
    if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    if bytes.starts_with(b"BM") {
        return Some("image/bmp");
    }
    if bytes.starts_with(b"II*\0") || bytes.starts_with(b"MM\0*") {
        return Some("image/tiff");
    }
    None
}

fn image_extension(mime: &str) -> &'static str {
    match mime
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "image/jpeg" | "image/jpg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/bmp" => "bmp",
        "image/tiff" => "tiff",
        "image/svg+xml" => "svg",
        "image/avif" => "avif",
        _ => "png",
    }
}

fn content_type_mime(headers: &reqwest::header::HeaderMap) -> Option<String> {
    headers
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(|value| {
            value
                .split(';')
                .next()
                .unwrap_or("")
                .trim()
                .to_ascii_lowercase()
        })
        .filter(|value| !value.is_empty())
}

fn filename_from_url(url: &url::Url, mime_type: &str) -> String {
    let ext = image_extension(mime_type);
    let candidate = url
        .path_segments()
        .and_then(|mut segments| segments.next_back())
        .map(str::trim)
        .filter(|segment| !segment.is_empty())
        .unwrap_or("external-image");
    let safe: String = candidate
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_') {
                ch
            } else {
                '_'
            }
        })
        .collect();
    let safe = safe.trim_matches('.').trim_matches('_');
    if safe.is_empty() {
        return format!("external-image.{ext}");
    }
    if safe.rsplit_once('.').is_some_and(|(_, suffix)| {
        (2..=8).contains(&suffix.len()) && suffix.chars().all(|ch| ch.is_ascii_alphanumeric())
    }) {
        safe.to_string()
    } else {
        format!("{safe}.{ext}")
    }
}

async fn read_response_limited(
    response: reqwest::Response,
    limit: usize,
) -> Result<Vec<u8>, AppError> {
    if response
        .content_length()
        .is_some_and(|length| length > limit as u64)
    {
        return Err(external_image_limit_error());
    }

    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| {
            AppError::InvalidRequest(format!("download_external_image failed: {}", e))
        })?;
        if bytes.len() + chunk.len() > limit {
            return Err(external_image_limit_error());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

async fn next_redirect_url(
    current: &url::Url,
    response: &reqwest::Response,
) -> Result<url::Url, AppError> {
    let location = response
        .headers()
        .get(reqwest::header::LOCATION)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| {
            AppError::InvalidRequest(
                "download_external_image redirect missing Location".to_string(),
            )
        })?;
    let next = current.join(location)?;
    validate_external_url(next.as_str()).await
}

pub async fn download_external_image_impl(
    input: DownloadExternalImageInput,
    mut target_url: url::Url,
) -> Result<DownloadExternalImageResult, AppError> {
    use base64::Engine;

    for redirect_count in 0..=MAX_EXTERNAL_IMAGE_REDIRECTS {
        let response = EXTERNAL_HTTP_CLIENT
            .get(target_url.clone())
            .header(
                reqwest::header::ACCEPT,
                "image/avif,image/webp,image/png,image/jpeg,image/gif,image/*;q=0.8,*/*;q=0.3",
            )
            .send()
            .await
            .map_err(|e| {
                AppError::InvalidRequest(format!(
                    "download_external_image failed for {}: {}",
                    input.url, e
                ))
            })?;

        if response.status().is_redirection() {
            if redirect_count >= MAX_EXTERNAL_IMAGE_REDIRECTS {
                return Err(AppError::InvalidRequest(
                    "download_external_image followed too many redirects".to_string(),
                ));
            }
            target_url = next_redirect_url(&target_url, &response).await?;
            continue;
        }

        if !response.status().is_success() {
            return Err(AppError::InvalidRequest(format!(
                "download_external_image returned HTTP {}",
                response.status().as_u16()
            )));
        }

        let header_mime = content_type_mime(response.headers());
        let bytes = read_response_limited(response, MAX_EXTERNAL_IMAGE_BYTES).await?;
        let magic_mime = image_mime_from_magic(&bytes).map(str::to_string);
        let mime_type = match (header_mime, magic_mime) {
            // Trust explicit image/* for formats not covered by the small magic
            // table (for example avif), but still reject empty bodies below.
            (Some(header), _) if header.starts_with("image/") => header,
            (_, Some(magic)) => magic,
            _ => {
                return Err(AppError::InvalidRequest(
                    "download_external_image URL did not return image content".to_string(),
                ));
            }
        };
        if bytes.is_empty() {
            return Err(AppError::InvalidRequest(
                "download_external_image returned an empty image".to_string(),
            ));
        }
        let filename = filename_from_url(&target_url, &mime_type);
        return Ok(DownloadExternalImageResult {
            final_url: target_url.to_string(),
            filename,
            mime_type,
            data_base64: base64::engine::general_purpose::STANDARD.encode(bytes.as_slice()),
            size: bytes.len(),
        });
    }

    Err(AppError::InvalidRequest(
        "download_external_image followed too many redirects".to_string(),
    ))
}

/// Download a public image URL for use as a composer attachment. URL validation
/// intentionally mirrors `external_request` and every redirect is revalidated.
#[tauri::command]
pub async fn download_external_image(
    input: DownloadExternalImageInput,
) -> Result<DownloadExternalImageResult, AppError> {
    let target_url = validate_external_url(&input.url).await?;
    download_external_image_impl(input, target_url).await
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
