//! Loopback browser companion for the packaged desktop UI.
//!
//! The browser never receives the Core dashboard token or OAuth cookies. It
//! authenticates to this process with a separate process-lifetime bearer token;
//! Rust then forwards REST and the official `/api/ws` protocol using the live
//! desktop connection state.

use std::convert::Infallible;
use std::net::Ipv4Addr;
use std::sync::LazyLock;
use std::time::Duration;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper::header::{
    HeaderName, HeaderValue, ACCESS_CONTROL_ALLOW_HEADERS, ACCESS_CONTROL_ALLOW_METHODS,
    ACCESS_CONTROL_ALLOW_ORIGIN, AUTHORIZATION, CACHE_CONTROL, CONNECTION, CONTENT_SECURITY_POLICY,
    CONTENT_TYPE, HOST, ORIGIN, SEC_WEBSOCKET_ACCEPT, SEC_WEBSOCKET_KEY, SEC_WEBSOCKET_VERSION,
    UPGRADE, VARY,
};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use serde::Serialize;
use tauri::Manager;
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::handshake::derive_accept_key;
use tokio_tungstenite::tungstenite::protocol::{CloseFrame, Role};
use tokio_tungstenite::tungstenite::{Message, Utf8Bytes};
use tokio_tungstenite::WebSocketStream;

use crate::commands::api_proxy::{
    api_request_from_state, upload_file_impl, ApiRequestInput, ApiRequestResult, UploadFileInput,
};
use crate::commands::ws_proxy::connect_gateway_stream;
use crate::error::AppError;
use crate::state::{AppState, AppStateInner, BrowserCompanionHandle, DashboardAuth};

const PREFERRED_PORT: u16 = 9546;
const MAX_REQUEST_BYTES: u64 = 100 * 1024 * 1024;
const COMPANION_TOKEN_HEADER: &str = "x-hermes-browser-token";

type CompanionBody = Full<Bytes>;

static PROXY_HTTP_CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(180))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("valid browser companion HTTP client")
});

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenBrowserCompanionResult {
    pub ok: bool,
    pub url: String,
    pub port: u16,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserRuntimeConfig {
    platform: &'static str,
    api_base_url: String,
    gateway_url: String,
    session_token: String,
    current_profile: String,
    connection_mode: String,
    backend_ready: bool,
    guide_state: String,
    managed_runtime_desired_state: String,
    managed_runtime_lifecycle_state: String,
    portable: bool,
    browser_companion: bool,
}

#[tauri::command]
pub async fn open_browser_companion(
    app: tauri::AppHandle,
) -> Result<OpenBrowserCompanionResult, AppError> {
    let existing = {
        let state = app.state::<AppState>();
        let existing = state.inner.lock()?.browser_companion.clone();
        existing
    };

    let handle = match existing {
        Some(handle) => handle,
        None => start_companion_server(&app).await?,
    };

    let companion_origin = format!("http://127.0.0.1:{}", handle.port);
    // In `tauri dev` the frontend assets are intentionally not embedded. Use
    // the live Vite page there, while keeping API/WS on the companion origin.
    // Debug bundles and release builds have web/dist and stay same-origin.
    let page_origin = if cfg!(dev) {
        current_dev_page_origin(&app)?
    } else {
        companion_origin.clone()
    };
    let launch_url = format!(
        "{}/#hermes-browser-origin={}&hermes-browser-token={}",
        page_origin.trim_end_matches('/'),
        urlencoding::encode(&companion_origin),
        urlencoding::encode(&handle.token),
    );

    open::that(&launch_url)
        .map_err(|error| AppError::Internal(format!("无法打开系统浏览器: {error}")))?;

    Ok(OpenBrowserCompanionResult {
        ok: true,
        url: page_origin,
        port: handle.port,
    })
}

fn current_dev_page_origin(app: &tauri::AppHandle) -> Result<String, AppError> {
    let window = app
        .get_webview_window(crate::tray::MAIN_WINDOW_LABEL)
        .ok_or_else(|| AppError::Internal("无法读取社区桌面版主窗口".to_string()))?;
    let current_url = window
        .url()
        .map_err(|error| AppError::Internal(format!("无法读取社区桌面版当前地址: {error}")))?;
    loopback_page_origin(&current_url).ok_or_else(|| {
        AppError::Internal(format!(
            "社区桌面版当前地址不是本机 HTTP 地址: {current_url}"
        ))
    })
}

fn loopback_page_origin(current_url: &url::Url) -> Option<String> {
    let origin = current_url.origin().ascii_serialization();
    is_loopback_origin(&origin).then_some(origin)
}

async fn start_companion_server(
    app: &tauri::AppHandle,
) -> Result<BrowserCompanionHandle, AppError> {
    let listener = match TcpListener::bind((Ipv4Addr::LOCALHOST, PREFERRED_PORT)).await {
        Ok(listener) => listener,
        Err(_) => TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .map_err(|error| {
                AppError::Internal(format!("浏览器伴生服务无法监听本机端口: {error}"))
            })?,
    };
    let port = listener
        .local_addr()
        .map_err(|error| AppError::Internal(format!("无法读取浏览器伴生端口: {error}")))?
        .port();
    let token = generate_companion_token()?;
    let handle = BrowserCompanionHandle { port, token };

    {
        let state = app.state::<AppState>();
        state.inner.lock()?.browser_companion = Some(handle.clone());
    }

    let server_app = app.clone();
    let server_token = handle.token.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = serve(listener, server_app, server_token, port).await {
            log::error!("Browser companion server stopped: {error}");
        }
    });

    Ok(handle)
}

fn generate_companion_token() -> Result<String, AppError> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes)
        .map_err(|error| AppError::Internal(format!("无法生成浏览器伴生令牌: {error}")))?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

async fn serve(
    listener: TcpListener,
    app: tauri::AppHandle,
    token: String,
    port: u16,
) -> Result<(), AppError> {
    loop {
        let (stream, _) = listener
            .accept()
            .await
            .map_err(|error| AppError::Internal(format!("浏览器伴生连接失败: {error}")))?;
        let io = TokioIo::new(stream);
        let request_app = app.clone();
        let request_token = token.clone();
        tauri::async_runtime::spawn(async move {
            let service = service_fn(move |request| {
                let app = request_app.clone();
                let token = request_token.clone();
                async move { handle_request(request, app, token, port).await }
            });
            if let Err(error) = http1::Builder::new()
                .serve_connection(io, service)
                .with_upgrades()
                .await
            {
                log::debug!("Browser companion connection ended: {error}");
            }
        });
    }
}

/// True when the desktop is running the in-process embedded runtime (Hard FFI).
///
/// This mirrors the checks used by `api_proxy` / `ws_proxy`: the `embedded`
/// flag is authoritative, and the placeholder `embedded://local` URL covers the
/// connection-switch window where the flag is not yet flipped. When true, the
/// browser companion must route REST through the FFI (`api_request_from_state`
/// / `upload_file_impl`) and the gateway through the in-memory embedded
/// transport — never reqwest/tungstenite against `embedded://`.
fn is_embedded_state(inner: &AppStateInner) -> bool {
    inner.embedded || inner.api_base_url == crate::embedded::EMBEDDED_API_BASE_URL
}

async fn handle_request(
    mut request: Request<Incoming>,
    app: tauri::AppHandle,
    token: String,
    port: u16,
) -> Result<Response<CompanionBody>, Infallible> {
    if !valid_host(request.headers().get(HOST), port) {
        return Ok(text_response(StatusCode::FORBIDDEN, "Forbidden host"));
    }

    let cors_origin = request
        .headers()
        .get(ORIGIN)
        .and_then(|value| value.to_str().ok())
        .filter(|origin| is_loopback_origin(origin))
        .and_then(|origin| HeaderValue::from_str(origin).ok());
    if request.headers().contains_key(ORIGIN) && cors_origin.is_none() {
        return Ok(text_response(StatusCode::FORBIDDEN, "Forbidden origin"));
    }

    if request.method() == Method::OPTIONS {
        return Ok(with_cors(
            empty_response(StatusCode::NO_CONTENT),
            cors_origin.as_ref(),
        ));
    }

    let path = request.uri().path().to_string();
    if path == "/api/ws" {
        if !has_companion_token(&request, &token) {
            return Ok(with_cors(
                text_response(StatusCode::UNAUTHORIZED, "Unauthorized"),
                cors_origin.as_ref(),
            ));
        }
        return Ok(websocket_upgrade(&mut request, app));
    }

    if path == "/__hermes_runtime" {
        if !has_companion_token(&request, &token) {
            return Ok(with_cors(
                text_response(StatusCode::UNAUTHORIZED, "Unauthorized"),
                cors_origin.as_ref(),
            ));
        }
        let response = match runtime_config_response(&app, &token, port) {
            Ok(response) => response,
            Err(error) => text_response(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string()),
        };
        return Ok(with_cors(response, cors_origin.as_ref()));
    }

    if path.starts_with("/api/") || path.starts_with("/__hermes_") {
        if !has_companion_token(&request, &token) {
            return Ok(with_cors(
                text_response(StatusCode::UNAUTHORIZED, "Unauthorized"),
                cors_origin.as_ref(),
            ));
        }
        let response = if path == "/api/upload" {
            let embedded = app
                .state::<AppState>()
                .inner
                .lock()
                .map(|inner| is_embedded_state(&inner))
                .unwrap_or(false);
            if embedded {
                // Embedded mode has zero HTTP: parse the multipart body and hand
                // it to upload_file_impl, whose embedded branch dispatches the
                // FFI handle_upload (same path as the Tauri upload_file command).
                proxy_embedded_upload(request, &app).await
            } else {
                // Non-embedded: keep the legacy direct multipart upload to the
                // real dashboard, byte-for-byte identical.
                proxy_http(request, &app).await
            }
        } else {
            proxy_desktop_api(request, &app).await
        };
        return Ok(with_cors(response, cors_origin.as_ref()));
    }

    Ok(serve_asset(&app, &path))
}

async fn proxy_desktop_api(
    request: Request<Incoming>,
    app: &tauri::AppHandle,
) -> Response<CompanionBody> {
    let method = request.method().as_str().to_string();
    let path = request
        .uri()
        .path_and_query()
        .map(|value| value.as_str())
        .unwrap_or("/")
        .to_string();
    let headers = request
        .headers()
        .iter()
        .filter(|(name, _)| should_forward_request_header(name.as_str()))
        .filter_map(|(name, value)| {
            value
                .to_str()
                .ok()
                .map(|value| (name.as_str().to_string(), value.to_string()))
        })
        .collect();
    let body = match request
        .into_body()
        .collect()
        .await
        .map(|collected| collected.to_bytes())
    {
        Ok(body) if body.len() as u64 <= MAX_REQUEST_BYTES => body,
        Ok(_) => return text_response(StatusCode::PAYLOAD_TOO_LARGE, "Request body too large"),
        Err(error) => return text_response(StatusCode::BAD_REQUEST, &error.to_string()),
    };
    let body = if body.is_empty() {
        None
    } else {
        match String::from_utf8(body.to_vec()) {
            Ok(body) => Some(body),
            Err(_) => return text_response(StatusCode::BAD_REQUEST, "Request body must be UTF-8"),
        }
    };
    let state = app.state::<AppState>();
    let result = match api_request_from_state(
        app,
        ApiRequestInput {
            path,
            method: Some(method),
            headers: Some(headers),
            body,
        },
        &state,
    )
    .await
    {
        Ok(result) => result,
        Err(error) => return text_response(StatusCode::BAD_GATEWAY, &error.to_string()),
    };

    api_result_response(result)
}

/// Build an HTTP response from an `ApiRequestResult` envelope, mirroring how the
/// desktop IPC surface returns `{ status, headers, body }` to the renderer.
/// Shared by `proxy_desktop_api` and the embedded upload branch.
fn api_result_response(result: ApiRequestResult) -> Response<CompanionBody> {
    let mut response = Response::new(Full::new(Bytes::from(result.body)));
    *response.status_mut() =
        StatusCode::from_u16(result.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    for (name, value) in result.headers {
        if !should_forward_response_header(&name) {
            continue;
        }
        let Ok(name) = HeaderName::from_bytes(name.as_bytes()) else {
            continue;
        };
        let Ok(value) = HeaderValue::from_str(&value) else {
            continue;
        };
        response.headers_mut().append(name, value);
    }
    response
}

/// Embedded-mode `/api/upload` for the browser companion.
///
/// The browser frontend has no Tauri bridge, so it POSTs a multipart form
/// (`session_id` + `file`) to the companion origin. In embedded mode there is
/// zero HTTP: parse the multipart body here, base64-encode the file bytes, and
/// hand it to `upload_file_impl` — the same FFI `handle_upload` path the Tauri
/// `upload_file` command uses (its embedded branch never touches reqwest).
async fn proxy_embedded_upload(
    request: Request<Incoming>,
    app: &tauri::AppHandle,
) -> Response<CompanionBody> {
    let (hermes_home, session_token) = {
        let state = app.state::<AppState>();
        let inner = match state.inner.lock() {
            Ok(inner) => inner,
            Err(error) => {
                return text_response(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string())
            }
        };
        (inner.hermes_home.clone(), inner.session_token.clone())
    };
    let content_type = request
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string();
    let body = match request
        .into_body()
        .collect()
        .await
        .map(|collected| collected.to_bytes())
    {
        Ok(body) if body.len() as u64 <= MAX_REQUEST_BYTES => body,
        Ok(_) => return text_response(StatusCode::PAYLOAD_TOO_LARGE, "Request body too large"),
        Err(error) => return text_response(StatusCode::BAD_REQUEST, &error.to_string()),
    };
    let input = match parse_embedded_upload_body(&body, &content_type) {
        Ok(input) => input,
        Err(error) => return text_response(StatusCode::BAD_REQUEST, &error.to_string()),
    };
    let result = match upload_file_impl(
        input,
        crate::embedded::EMBEDDED_API_BASE_URL,
        session_token.as_deref(),
        &hermes_home,
    )
    .await
    {
        Ok(result) => result,
        Err(error) => return text_response(StatusCode::BAD_GATEWAY, &error.to_string()),
    };
    api_result_response(result)
}

/// Parse a multipart/form-data upload body into the FFI `UploadFileInput`
/// contract. The browser sends `session_id` and `file` fields; the file bytes
/// are base64-encoded here because the embedded `handle_upload` FFI expects
/// `{ session_id, name, type, data }` with base64 `data`.
fn parse_embedded_upload_body(
    body: &[u8],
    content_type: &str,
) -> Result<UploadFileInput, AppError> {
    let boundary = parse_multipart_boundary(content_type)
        .filter(|boundary| !boundary.is_empty())
        .ok_or_else(|| {
            AppError::InvalidRequest("multipart boundary missing from Content-Type".to_string())
        })?;
    let mut session_id: Option<String> = None;
    let mut file_name: Option<String> = None;
    let mut file_type: Option<String> = None;
    let mut file_data: Option<Vec<u8>> = None;

    for part in split_multipart_parts(body, &boundary) {
        if part.is_empty() {
            continue;
        }
        let (headers, content) = split_part_headers(part)?;
        let disposition = headers
            .iter()
            .find(|(name, _)| name == "content-disposition")
            .map(|(_, value)| value.as_str())
            .unwrap_or("");
        let (name, filename) = parse_disposition_name_and_filename(disposition);
        match name.as_deref() {
            Some("session_id") => {
                session_id = Some(String::from_utf8(content.to_vec()).map_err(|error| {
                    AppError::InvalidRequest(format!(
                        "multipart session_id is not valid UTF-8: {error}"
                    ))
                })?);
            }
            Some("file") => {
                file_name = filename;
                file_type = headers
                    .iter()
                    .find(|(name, _)| name == "content-type")
                    .map(|(_, value)| value.clone());
                file_data = Some(content.to_vec());
            }
            _ => {}
        }
    }

    let session_id = session_id.ok_or_else(|| {
        AppError::InvalidRequest("multipart upload missing session_id field".to_string())
    })?;
    let file_name = file_name.filter(|name| !name.is_empty()).ok_or_else(|| {
        AppError::InvalidRequest("multipart upload missing file field".to_string())
    })?;
    let file_data = file_data.ok_or_else(|| {
        AppError::InvalidRequest("multipart upload missing file field".to_string())
    })?;
    let data = base64::engine::general_purpose::STANDARD.encode(&file_data);
    Ok(UploadFileInput {
        session_id,
        name: file_name,
        r#type: file_type,
        data,
    })
}

/// Extract the `boundary=...` parameter from a `multipart/form-data`
/// Content-Type value (quoted or bare, case-insensitive key).
fn parse_multipart_boundary(content_type: &str) -> Option<String> {
    for parameter in content_type.split(';').skip(1) {
        let parameter = parameter.trim();
        let Some((key, value)) = parameter.split_once('=') else {
            continue;
        };
        if !key.trim().eq_ignore_ascii_case("boundary") {
            continue;
        }
        let value = value.trim();
        if value.len() >= 2 && value.starts_with('"') && value.ends_with('"') {
            return Some(value[1..value.len() - 1].to_string());
        }
        return Some(value.to_string());
    }
    None
}

/// Split a multipart body into part payloads (headers + content) using the
/// RFC 2046 boundary rule: only `--boundary` tokens at offset 0 or preceded by
/// a line feed delimit parts, so binary file content that happens to contain
/// the boundary token is not truncated.
fn split_multipart_parts<'a>(body: &'a [u8], boundary: &str) -> Vec<&'a [u8]> {
    let delimiter = format!("--{boundary}");
    let delimiter = delimiter.as_bytes();
    let mut parts = Vec::new();
    let mut search_from = 0;
    while let Some(relative) = find_subslice(&body[search_from..], delimiter) {
        let boundary_at = search_from + relative;
        if !is_multipart_boundary_at(body, boundary_at, delimiter) {
            search_from = boundary_at + 1;
            continue;
        }
        let part_start = boundary_at + delimiter.len();
        if body[part_start..].starts_with(b"--") {
            break; // closing `--boundary--`
        }
        let mut end = body.len();
        let mut scan = part_start;
        while let Some(relative) = find_subslice(&body[scan..], delimiter) {
            let next_at = scan + relative;
            if is_multipart_boundary_at(body, next_at, delimiter) {
                end = next_at;
                break;
            }
            scan = next_at + 1;
        }
        let mut chunk = &body[part_start..end];
        if chunk.starts_with(b"\r\n") {
            chunk = &chunk[2..];
        } else if chunk.starts_with(b"\n") {
            chunk = &chunk[1..];
        }
        if chunk.ends_with(b"\r\n") {
            chunk = &chunk[..chunk.len() - 2];
        } else if chunk.ends_with(b"\n") {
            chunk = &chunk[..chunk.len() - 1];
        }
        parts.push(chunk);
        search_from = end;
    }
    parts
}

/// A multipart delimiter must begin a line and be followed by either a line
/// ending or the closing `--`. Merely finding `\n--boundary` is insufficient:
/// arbitrary binary content can contain that prefix followed by other bytes.
fn is_multipart_boundary_at(body: &[u8], at: usize, delimiter: &[u8]) -> bool {
    if at > body.len() || !body[at..].starts_with(delimiter) {
        return false;
    }
    if at != 0 && body[at - 1] != b'\n' {
        return false;
    }
    let suffix = &body[at + delimiter.len()..];
    suffix.starts_with(b"--") || suffix.starts_with(b"\r\n") || suffix.starts_with(b"\n")
}

/// Lowercased header name → value pairs parsed from one multipart part.
type MultipartPartHeaders = Vec<(String, String)>;

/// Split one part payload into its header list and content bytes.
fn split_part_headers(part: &[u8]) -> Result<(MultipartPartHeaders, &[u8]), AppError> {
    let separator_len = if let Some(separator) = find_subslice(part, b"\r\n\r\n") {
        let header_bytes = &part[..separator];
        (separator, 4, header_bytes)
    } else if let Some(separator) = find_subslice(part, b"\n\n") {
        let header_bytes = &part[..separator];
        (separator, 2, header_bytes)
    } else {
        return Err(AppError::InvalidRequest(
            "multipart part missing header separator".to_string(),
        ));
    };
    let (separator, separator_len, header_bytes) = separator_len;
    let content = &part[separator + separator_len..];
    let header_text = std::str::from_utf8(header_bytes).map_err(|error| {
        AppError::InvalidRequest(format!("multipart headers are not valid UTF-8: {error}"))
    })?;
    let mut headers = Vec::new();
    for line in header_text.split("\r\n").flat_map(|line| line.split('\n')) {
        if let Some((name, value)) = line.split_once(':') {
            headers.push((name.trim().to_ascii_lowercase(), value.trim().to_string()));
        }
    }
    Ok((headers, content))
}

/// Extract `name="..."` and `filename="..."` from a Content-Disposition value.
fn parse_disposition_name_and_filename(disposition: &str) -> (Option<String>, Option<String>) {
    let mut name = None;
    let mut filename = None;
    for parameter in disposition.split(';').skip(1) {
        let parameter = parameter.trim();
        if let Some(value) = parameter.strip_prefix("name=") {
            name = parse_parameter_value(value.trim());
        } else if let Some(value) = parameter.strip_prefix("filename=") {
            filename = parse_parameter_value(value.trim());
        }
    }
    (name, filename)
}

/// Parse a quoted or bare multipart parameter value.
fn parse_parameter_value(value: &str) -> Option<String> {
    if value.len() >= 2 && value.starts_with('"') && value.ends_with('"') {
        let inner = &value[1..value.len() - 1];
        Some(inner.replace("\\\"", "\"").replace("\\\\", "\\"))
    } else {
        Some(value.to_string())
    }
}

/// First occurrence of `needle` in `haystack` (byte-level).
fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() {
        return Some(0);
    }
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn valid_host(value: Option<&HeaderValue>, port: u16) -> bool {
    let Some(host) = value.and_then(|value| value.to_str().ok()) else {
        return false;
    };
    host == format!("127.0.0.1:{port}") || host == format!("localhost:{port}")
}

fn is_loopback_origin(origin: &str) -> bool {
    let Ok(url) = url::Url::parse(origin) else {
        return false;
    };
    if url.scheme() != "http" {
        return false;
    }
    match url.host_str() {
        Some("localhost") => true,
        Some(host) => host
            .parse::<std::net::IpAddr>()
            .is_ok_and(|ip| ip.is_loopback()),
        None => false,
    }
}

fn has_companion_token(request: &Request<Incoming>, expected: &str) -> bool {
    let bearer = request
        .headers()
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "));
    let explicit = request
        .headers()
        .get(COMPANION_TOKEN_HEADER)
        .and_then(|value| value.to_str().ok());
    let query = request.uri().query().and_then(|query| {
        url::form_urlencoded::parse(query.as_bytes())
            .find(|(key, _)| key == "token")
            .map(|(_, value)| value.into_owned())
    });
    bearer == Some(expected) || explicit == Some(expected) || query.as_deref() == Some(expected)
}

fn runtime_config_response(
    app: &tauri::AppHandle,
    token: &str,
    port: u16,
) -> Result<Response<CompanionBody>, AppError> {
    let state = app.state::<AppState>();
    let inner = state.inner.lock()?;
    let control = crate::desktop_control::read();
    let installed = crate::process::runtime::read_current_record().is_some();
    let managed_running = inner.connection_mode == crate::connection::ConnectionMode::Managed
        && inner
            .dashboard_handle
            .as_ref()
            .is_some_and(|handle| handle.owns_process);
    let lifecycle =
        crate::desktop_control::managed_runtime_lifecycle_state(installed, managed_running);
    let origin = format!("http://127.0.0.1:{port}");
    let payload = BrowserRuntimeConfig {
        platform: "web",
        api_base_url: origin.clone(),
        gateway_url: format!(
            "ws://127.0.0.1:{port}/api/ws?token={}",
            urlencoding::encode(token)
        ),
        session_token: token.to_string(),
        current_profile: inner.current_profile.clone(),
        connection_mode: inner.connection_mode.as_str().to_string(),
        backend_ready: inner.dashboard_handle.is_some() && !inner.api_base_url.trim().is_empty(),
        guide_state: control.guide_state.as_str().to_string(),
        managed_runtime_desired_state: control.managed_runtime_desired_state.as_str().to_string(),
        managed_runtime_lifecycle_state: lifecycle.to_string(),
        portable: crate::process::runtime::portable_mode_active(),
        browser_companion: true,
    };
    json_response(StatusCode::OK, &payload)
}

async fn proxy_http(request: Request<Incoming>, app: &tauri::AppHandle) -> Response<CompanionBody> {
    let (base_url, auth) = {
        let state = app.state::<AppState>();
        let inner = match state.inner.lock() {
            Ok(inner) => inner,
            Err(error) => {
                return text_response(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string())
            }
        };
        (inner.api_base_url.clone(), inner.dashboard_auth())
    };
    if base_url.trim().is_empty() {
        return text_response(StatusCode::SERVICE_UNAVAILABLE, "Hermes Core 尚未就绪");
    }

    let method = match reqwest::Method::from_bytes(request.method().as_str().as_bytes()) {
        Ok(method) => method,
        Err(_) => return text_response(StatusCode::BAD_REQUEST, "Unsupported method"),
    };
    let path = request
        .uri()
        .path_and_query()
        .map(|value| value.as_str())
        .unwrap_or("/")
        .to_string();
    let target = format!("{}{}", base_url.trim_end_matches('/'), path);
    let request_headers = request.headers().clone();
    let body = match request
        .into_body()
        .collect()
        .await
        .map(|collected| collected.to_bytes())
    {
        Ok(body) if body.len() as u64 <= MAX_REQUEST_BYTES => body,
        Ok(_) => return text_response(StatusCode::PAYLOAD_TOO_LARGE, "Request body too large"),
        Err(error) => return text_response(StatusCode::BAD_REQUEST, &error.to_string()),
    };

    let mut upstream = match &auth {
        DashboardAuth::Token(_) => PROXY_HTTP_CLIENT.request(method, &target),
        DashboardAuth::Oauth(session) => session.client().request(method, &target),
    };
    if let DashboardAuth::Token(Some(real_token)) = &auth {
        upstream = upstream
            .header(AUTHORIZATION.as_str(), format!("Bearer {real_token}"))
            .header("x-hermes-session-token", real_token);
    }
    for (name, value) in &request_headers {
        if should_forward_request_header(name.as_str()) {
            upstream = upstream.header(name.as_str(), value.as_bytes());
        }
    }
    if !body.is_empty() {
        upstream = upstream.body(body);
    }

    let result = match upstream.send().await {
        Ok(result) => result,
        Err(error) => return text_response(StatusCode::BAD_GATEWAY, &error.to_string()),
    };
    if let DashboardAuth::Oauth(session) = &auth {
        if session.take_dirty() {
            crate::oauth_session::persist_if_dirty(&base_url, session);
        }
    }

    let status = result.status();
    let headers = result.headers().clone();
    let body = match result.bytes().await {
        Ok(body) => body,
        Err(error) => return text_response(StatusCode::BAD_GATEWAY, &error.to_string()),
    };
    let mut response = Response::new(Full::new(body));
    *response.status_mut() = status;
    for (name, value) in &headers {
        if should_forward_response_header(name.as_str()) {
            response.headers_mut().append(name.clone(), value.clone());
        }
    }
    response
}

fn should_forward_request_header(name: &str) -> bool {
    !matches!(
        name.to_ascii_lowercase().as_str(),
        "authorization"
            | "x-hermes-session-token"
            | COMPANION_TOKEN_HEADER
            | "host"
            | "content-length"
            | "connection"
            | "origin"
            | "accept-encoding"
            | "upgrade"
    )
}

fn should_forward_response_header(name: &str) -> bool {
    !matches!(
        name.to_ascii_lowercase().as_str(),
        "content-length"
            | "connection"
            | "transfer-encoding"
            | "set-cookie"
            | "access-control-allow-origin"
            | "access-control-allow-headers"
            | "access-control-allow-methods"
    )
}

fn websocket_upgrade(
    request: &mut Request<Incoming>,
    app: tauri::AppHandle,
) -> Response<CompanionBody> {
    let key = request
        .headers()
        .get(SEC_WEBSOCKET_KEY)
        .and_then(|value| value.to_str().ok());
    let version_ok = request
        .headers()
        .get(SEC_WEBSOCKET_VERSION)
        .is_some_and(|value| value == "13");
    let upgrade_ok = request
        .headers()
        .get(UPGRADE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.eq_ignore_ascii_case("websocket"));
    let connection_ok = request
        .headers()
        .get(CONNECTION)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| {
            value
                .split(',')
                .any(|part| part.trim().eq_ignore_ascii_case("upgrade"))
        });
    let Some(key) = key.filter(|_| version_ok && upgrade_ok && connection_ok) else {
        return text_response(StatusCode::BAD_REQUEST, "Invalid WebSocket upgrade");
    };

    let accept = derive_accept_key(key.as_bytes());
    let on_upgrade = hyper::upgrade::on(request);
    tauri::async_runtime::spawn(async move {
        let upgraded = match on_upgrade.await {
            Ok(upgraded) => upgraded,
            Err(error) => {
                log::debug!("Browser companion WebSocket upgrade failed: {error}");
                return;
            }
        };
        let client =
            WebSocketStream::from_raw_socket(TokioIo::new(upgraded), Role::Server, None).await;
        if let Err(error) = relay_websocket(client, app).await {
            log::debug!("Browser companion WebSocket relay ended: {error}");
        }
    });

    Response::builder()
        .status(StatusCode::SWITCHING_PROTOCOLS)
        .header(UPGRADE, "websocket")
        .header(CONNECTION, "Upgrade")
        .header(SEC_WEBSOCKET_ACCEPT, accept)
        .body(Full::new(Bytes::new()))
        .expect("valid WebSocket upgrade response")
}

async fn relay_websocket<S>(
    mut client: WebSocketStream<S>,
    app: tauri::AppHandle,
) -> Result<(), AppError>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let state = app.state::<AppState>();
    let embedded = state
        .inner
        .lock()
        .map(|inner| is_embedded_state(&inner))
        .unwrap_or(false);
    if embedded {
        // Embedded mode has no WebSocket: relay through the in-memory embedded
        // transport (open/send/close mirror gateway_ws_open/send/close).
        // Never reach connect_gateway_stream, which would build a tungstenite
        // URL against the embedded:// placeholder.
        return relay_embedded_websocket(client, app).await;
    }

    let mut upstream = match connect_gateway_stream(&app, &state).await {
        Ok(upstream) => upstream,
        Err(error) => {
            let reason = Utf8Bytes::from(error.to_string().chars().take(100).collect::<String>());
            let _ = client
                .send(Message::Close(Some(CloseFrame {
                    code: tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode::Error,
                    reason,
                })))
                .await;
            return Err(error);
        }
    };
    let mut keepalive = tokio::time::interval(Duration::from_secs(10));
    keepalive.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    loop {
        tokio::select! {
            item = client.next() => match item {
                Some(Ok(Message::Close(frame))) => {
                    let _ = upstream.send(Message::Close(frame)).await;
                    break;
                }
                Some(Ok(Message::Frame(_))) => {}
                Some(Ok(message)) => {
                    if upstream.send(message).await.is_err() { break; }
                }
                Some(Err(error)) => return Err(AppError::GatewayWs(error.to_string())),
                None => break,
            },
            item = upstream.next() => match item {
                Some(Ok(Message::Close(frame))) => {
                    let _ = client.send(Message::Close(frame)).await;
                    break;
                }
                Some(Ok(Message::Frame(_))) => {}
                Some(Ok(message)) => {
                    if client.send(message).await.is_err() { break; }
                }
                Some(Err(error)) => return Err(AppError::GatewayWs(error.to_string())),
                None => break,
            },
            _ = keepalive.tick() => {
                if upstream.send(Message::Ping(Default::default())).await.is_err() { break; }
            }
        }
    }

    let _ = client.close(None).await;
    let _ = upstream.close(None).await;
    Ok(())
}

/// Generate a unique connection id for a browser-companion embedded gateway
/// session. The id tags every `gateway-ws-message` event so a stale relay can
/// never deliver into a different connection's socket.
fn new_browser_companion_connection_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT_ID: AtomicU64 = AtomicU64::new(1);
    let sequence = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    format!("browser-companion-{sequence}-{nanos}")
}

/// Embedded-mode gateway relay for the browser companion.
///
/// Mirrors the webview `gateway_ws_open`/`send`/`close` contract (ws_proxy.rs):
/// open an in-memory embedded gateway session, dispatch browser JSON-RPC frames
/// via `dispatch_frame`, and forward inbound `gateway-ws-message` events back to
/// the browser socket. The embedded transport emits events both to the Tauri
/// emitter and to the in-process broadcast bus (`embedded::events::subscribe`);
/// the browser companion consumes the bus and filters by its own connection id.
///
/// Note: the embedded transport currently keeps a single active gateway session
/// (`AppStateInner::embedded_gateway`), so opening this relay replaces the
/// webview's session, exactly like a webview reconnect does. The webview's
/// gateway client reconnects automatically; this is a transport-level property
/// (one in-memory RustBridgeTransport), not something the companion can fix.
async fn relay_embedded_websocket<S>(
    mut client: WebSocketStream<S>,
    app: tauri::AppHandle,
) -> Result<(), AppError>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let state = app.state::<AppState>();
    let connection_id = new_browser_companion_connection_id();
    let mut events = crate::embedded::events::subscribe();

    if let Err(error) =
        crate::embedded::transport::open_embedded_gateway(&app, &state, connection_id.clone())
    {
        let reason = Utf8Bytes::from(error.to_string().chars().take(100).collect::<String>());
        let _ = client
            .send(Message::Close(Some(CloseFrame {
                code: tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode::Error,
                reason,
            })))
            .await;
        return Err(error);
    }

    loop {
        tokio::select! {
            item = client.next() => match item {
                Some(Ok(Message::Close(_))) => break,
                Some(Ok(Message::Frame(_))) => {}
                // No network half-open in embedded mode; answer the browser's
                // control frames locally instead of relaying them to Python.
                Some(Ok(Message::Ping(payload))) => {
                    if client.send(Message::Pong(payload)).await.is_err() { break; }
                }
                Some(Ok(Message::Pong(_))) => {}
                Some(Ok(Message::Binary(_))) => {
                    // The JSON-RPC gateway speaks text frames only; ignore binary.
                }
                Some(Ok(Message::Text(text))) => {
                    if let Err(error) = crate::embedded::transport::dispatch_frame(
                        &app,
                        &state,
                        &connection_id,
                        text.to_string(),
                    )
                    .await
                    {
                        log::debug!(
                            "Browser companion embedded gateway dispatch failed: {error}"
                        );
                        break;
                    }
                }
                Some(Err(error)) => return Err(AppError::GatewayWs(error.to_string())),
                None => break,
            },
            event = events.recv() => match event {
                Ok(event) if event.connection_id == connection_id => {
                    // wire_data() delivers RPC responses as raw JSON-RPC frames
                    // and everything else as {method:"event"} — same contract as
                    // the webview relay shim.
                    let frame = event.wire_data();
                    if client.send(Message::Text(Utf8Bytes::from(frame))).await.is_err() {
                        break;
                    }
                }
                Ok(_) => {}
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                    log::debug!("Browser companion embedded event bus lagged; skipping");
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            },
        }
    }

    let _ = crate::embedded::transport::close_embedded_gateway(&app, &state, &connection_id);
    let _ = client.close(None).await;
    Ok(())
}

fn resolve_asset(app: &tauri::AppHandle, path: &str) -> Option<tauri::Asset> {
    app.asset_resolver()
        .get(path.to_string())
        .or_else(|| app.asset_resolver().get(format!("/{path}")))
}

fn serve_asset(app: &tauri::AppHandle, request_path: &str) -> Response<CompanionBody> {
    let requested = normalize_asset_path(request_path);
    let asset = requested
        .as_deref()
        .and_then(|path| resolve_asset(app, path))
        .or_else(|| {
            requested
                .as_deref()
                .filter(|path| !path.rsplit('/').next().unwrap_or_default().contains('.'))
                .and_then(|_| resolve_asset(app, "index.html"))
        });
    let Some(asset) = asset else {
        return text_response(
            StatusCode::NOT_FOUND,
            "Browser UI assets are unavailable; start the desktop dev server.",
        );
    };

    let mime = asset.mime_type().to_string();
    let csp = asset.csp_header().map(str::to_string);
    let bytes = Bytes::copy_from_slice(asset.bytes());
    let mut response = Response::new(Full::new(bytes));
    response.headers_mut().insert(
        CONTENT_TYPE,
        HeaderValue::from_str(&mime)
            .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream")),
    );
    if let Some(csp) = csp.and_then(|value| HeaderValue::from_str(&value).ok()) {
        response.headers_mut().insert(CONTENT_SECURITY_POLICY, csp);
    }
    response
}

fn normalize_asset_path(request_path: &str) -> Option<String> {
    let path = request_path.trim_start_matches('/');
    if path.is_empty() {
        return Some("index.html".to_string());
    }
    if path.split('/').any(|part| part == "..") {
        return None;
    }
    Some(path.to_string())
}

fn json_response<T: Serialize>(
    status: StatusCode,
    value: &T,
) -> Result<Response<CompanionBody>, AppError> {
    let body = serde_json::to_vec(value)
        .map_err(|error| AppError::Internal(format!("序列化浏览器响应失败: {error}")))?;
    let mut response = Response::new(Full::new(Bytes::from(body)));
    *response.status_mut() = status;
    response
        .headers_mut()
        .insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    response
        .headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok(response)
}

fn text_response(status: StatusCode, message: &str) -> Response<CompanionBody> {
    let mut response = Response::new(Full::new(Bytes::copy_from_slice(message.as_bytes())));
    *response.status_mut() = status;
    response.headers_mut().insert(
        CONTENT_TYPE,
        HeaderValue::from_static("text/plain; charset=utf-8"),
    );
    response
}

fn empty_response(status: StatusCode) -> Response<CompanionBody> {
    let mut response = Response::new(Full::new(Bytes::new()));
    *response.status_mut() = status;
    response
}

fn with_cors(
    mut response: Response<CompanionBody>,
    origin: Option<&HeaderValue>,
) -> Response<CompanionBody> {
    if let Some(origin) = origin {
        response
            .headers_mut()
            .insert(ACCESS_CONTROL_ALLOW_ORIGIN, origin.clone());
        response
            .headers_mut()
            .insert(VARY, HeaderValue::from_static("Origin"));
        response.headers_mut().insert(
            ACCESS_CONTROL_ALLOW_METHODS,
            HeaderValue::from_static("GET, POST, PUT, PATCH, DELETE, OPTIONS"),
        );
        response.headers_mut().insert(
            ACCESS_CONTROL_ALLOW_HEADERS,
            HeaderValue::from_static(
                "Authorization, Content-Type, X-Hermes-Session-Token, X-Hermes-Browser-Token, X-Hermes-Profile",
            ),
        );
    }
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_loopback_http_origins_are_allowed() {
        assert!(is_loopback_origin("http://localhost:9545"));
        assert!(is_loopback_origin("http://127.0.0.1:9546"));
        assert!(!is_loopback_origin("https://example.com"));
        assert!(!is_loopback_origin("http://example.com"));
    }

    #[test]
    fn browser_page_origin_follows_the_current_webview_port() {
        let url = url::Url::parse("http://localhost:9546/connection?tab=advanced#/health")
            .expect("valid dev URL");
        assert_eq!(
            loopback_page_origin(&url),
            Some("http://localhost:9546".to_string())
        );
    }

    #[test]
    fn browser_page_origin_rejects_non_loopback_pages() {
        let remote = url::Url::parse("https://example.com/connection").expect("valid remote URL");
        let local_https =
            url::Url::parse("https://localhost:9546/connection").expect("valid local URL");
        assert_eq!(loopback_page_origin(&remote), None);
        assert_eq!(loopback_page_origin(&local_https), None);
    }

    #[test]
    fn asset_paths_reject_parent_traversal_and_map_root() {
        assert_eq!(normalize_asset_path("/"), Some("index.html".to_string()));
        assert_eq!(
            normalize_asset_path("/assets/app.js"),
            Some("assets/app.js".to_string())
        );
        assert_eq!(normalize_asset_path("/../secret"), None);
    }

    #[test]
    fn host_must_match_the_loopback_listener() {
        let good = HeaderValue::from_static("127.0.0.1:9546");
        let localhost = HeaderValue::from_static("localhost:9546");
        let wrong = HeaderValue::from_static("example.com:9546");
        assert!(valid_host(Some(&good), 9546));
        assert!(valid_host(Some(&localhost), 9546));
        assert!(!valid_host(Some(&wrong), 9546));
    }

    #[test]
    fn embedded_state_detection_routes_upload_away_from_proxy_http() {
        // The /api/upload branch in handle_request consults is_embedded_state:
        // embedded -> proxy_embedded_upload (FFI, no reqwest);
        // non-embedded -> proxy_http (direct multipart to the real dashboard).
        let embedded = AppState::new();
        embedded.inner.lock().unwrap().embedded = true;
        embedded.inner.lock().unwrap().api_base_url =
            crate::embedded::EMBEDDED_API_BASE_URL.to_string();

        let placeholder_only = AppState::new();
        placeholder_only.inner.lock().unwrap().api_base_url =
            crate::embedded::EMBEDDED_API_BASE_URL.to_string();

        let plain = AppState::new();

        assert!(is_embedded_state(&embedded.inner.lock().unwrap()));
        assert!(is_embedded_state(&placeholder_only.inner.lock().unwrap()));
        assert!(!is_embedded_state(&plain.inner.lock().unwrap()));
    }

    #[test]
    fn embedded_ws_relay_decision_never_reaches_connect_gateway_stream() {
        // relay_websocket branches on is_embedded_state BEFORE calling
        // connect_gateway_stream. In embedded mode it returns
        // relay_embedded_websocket (in-memory transport), so no tungstenite URL
        // is ever built against the embedded:// placeholder.
        let embedded = AppState::new();
        embedded.inner.lock().unwrap().embedded = true;
        embedded.inner.lock().unwrap().api_base_url =
            crate::embedded::EMBEDDED_API_BASE_URL.to_string();
        let plain = AppState::new();

        assert!(is_embedded_state(&embedded.inner.lock().unwrap()));
        assert!(!is_embedded_state(&plain.inner.lock().unwrap()));
    }

    #[test]
    fn multipart_parser_extracts_session_and_file_as_base64() {
        use base64::Engine;
        let boundary = "X-UPLOAD-BOUNDARY";
        let body = format!(
            "--{boundary}\r\n\
             Content-Disposition: form-data; name=\"session_id\"\r\n\
             \r\n\
             sess-123\r\n\
             --{boundary}\r\n\
             Content-Disposition: form-data; name=\"file\"; filename=\"hello.txt\"\r\n\
             Content-Type: text/plain\r\n\
             \r\n\
             Hello, world!\r\n\
             --{boundary}--\r\n"
        );
        let input = parse_embedded_upload_body(
            body.as_bytes(),
            &format!("multipart/form-data; boundary={boundary}"),
        )
        .expect("valid multipart upload");
        assert_eq!(input.session_id, "sess-123");
        assert_eq!(input.name, "hello.txt");
        assert_eq!(input.r#type.as_deref(), Some("text/plain"));
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(&input.data)
            .expect("valid base64");
        assert_eq!(decoded, b"Hello, world!");
    }

    #[test]
    fn multipart_parser_accepts_lf_line_endings_and_quoted_boundary() {
        use base64::Engine;
        let boundary = "LF-BOUNDARY";
        let file_bytes = "\u{1}\u{2}\u{FF}";
        let body = format!(
            "--{boundary}\n\
             Content-Disposition: form-data; name=\"session_id\"\n\
             \n\
             s-9\n\
             --{boundary}\n\
             Content-Disposition: form-data; name=\"file\"; filename=\"data.bin\"\n\
             Content-Type: application/octet-stream\n\
             \n\
             {file_bytes}\n\
             --{boundary}--\n"
        );
        let input = parse_embedded_upload_body(
            body.as_bytes(),
            &format!("multipart/form-data; boundary=\"{boundary}\""),
        )
        .expect("valid LF multipart upload");
        assert_eq!(input.session_id, "s-9");
        assert_eq!(input.name, "data.bin");
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(&input.data)
            .expect("valid base64");
        assert_eq!(decoded, file_bytes.as_bytes());
    }

    #[test]
    fn multipart_splitter_ignores_boundary_tokens_inside_binary_content() {
        use base64::Engine;
        let boundary = "BOUND";
        // Neither token is a valid delimiter: one is not at line start and the
        // other has non-delimiter bytes immediately after the boundary value.
        let content = format!("prefix--{boundary}suffix\n--{boundary}still-data");
        let body = format!(
            "--{boundary}\r\n\
             Content-Disposition: form-data; name=\"session_id\"\r\n\
             \r\n\
             s-7\r\n\
             --{boundary}\r\n\
             Content-Disposition: form-data; name=\"file\"; filename=\"t.bin\"\r\n\
             \r\n\
             {content}\r\n\
             --{boundary}--\r\n"
        );
        let input = parse_embedded_upload_body(
            body.as_bytes(),
            &format!("multipart/form-data; boundary={boundary}"),
        )
        .expect("boundary token inside content must not split the part");
        assert_eq!(input.session_id, "s-7");
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(&input.data)
            .expect("valid base64");
        assert_eq!(decoded, content.as_bytes());
    }

    #[test]
    fn multipart_parser_rejects_missing_boundary() {
        let error = parse_embedded_upload_body(b"", "multipart/form-data").unwrap_err();
        assert!(matches!(error, AppError::InvalidRequest(_)));
    }

    #[test]
    fn multipart_parser_rejects_missing_file_or_session() {
        let boundary = "B";
        let only_session = format!(
            "--{boundary}\r\n\
             Content-Disposition: form-data; name=\"session_id\"\r\n\
             \r\n\
             s-1\r\n\
             --{boundary}--\r\n"
        );
        let error = parse_embedded_upload_body(
            only_session.as_bytes(),
            &format!("multipart/form-data; boundary={boundary}"),
        )
        .expect_err("missing file field");
        assert!(matches!(error, AppError::InvalidRequest(_)));

        let only_file = format!(
            "--{boundary}\r\n\
             Content-Disposition: form-data; name=\"file\"; filename=\"f.bin\"\r\n\
             \r\n\
             bytes\r\n\
             --{boundary}--\r\n"
        );
        let error = parse_embedded_upload_body(
            only_file.as_bytes(),
            &format!("multipart/form-data; boundary={boundary}"),
        )
        .expect_err("missing session_id field");
        assert!(matches!(error, AppError::InvalidRequest(_)));
    }

    #[test]
    fn browser_companion_connection_ids_are_unique_with_prefix() {
        let first = new_browser_companion_connection_id();
        let second = new_browser_companion_connection_id();
        assert!(first.starts_with("browser-companion-"));
        assert!(second.starts_with("browser-companion-"));
        assert_ne!(first, second);
    }

    #[tokio::test]
    async fn api_result_response_builds_http_response_from_envelope() {
        let mut headers = std::collections::HashMap::new();
        headers.insert("content-type".to_string(), "application/json".to_string());
        let result = ApiRequestResult {
            ok: true,
            status: 200,
            status_text: "OK".to_string(),
            headers,
            body: "{\"ok\":true}".to_string(),
        };
        let response = api_result_response(result);
        assert_eq!(response.status(), StatusCode::OK);
        let content_type = response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        let body = http_body_util::BodyExt::collect(response.into_body())
            .await
            .expect("collect body")
            .to_bytes();
        assert_eq!(body, Bytes::from_static(b"{\"ok\":true}"));
        assert_eq!(content_type.as_deref(), Some("application/json"));
    }
}
