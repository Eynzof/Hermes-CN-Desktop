use std::net::Ipv4Addr;
use std::process::Command;
use std::sync::OnceLock;
use std::time::Duration;

use serde::Serialize;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use url::Url;

use crate::commands::wanderminds_id::access_token_for_portal;
use crate::error::{AppError, AppResult};

const DEFAULT_INFERENCE_BASE_URL: &str = "https://inference-staging.wanderminds.ai";
const INFERENCE_HOST: &str = "inference-staging.wanderminds.ai";
const PORTAL_AUDIENCE: &str = "https://portal.wanderminds.ai/api";
const TOKEN_PATH: &str = "/v1/token";
const MAX_HEADER_BYTES: usize = 8192;
const READ_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TokenBrokerConfig {
    pub endpoint: String,
    pub capability: String,
    pub inference_base_url: String,
}

#[derive(Serialize)]
struct BrokerTokenResponse {
    access_token: String,
    expires_at: u64,
    token_type: &'static str,
    inference_base_url: String,
}

#[derive(Serialize)]
struct BrokerErrorResponse {
    code: &'static str,
    message: &'static str,
    retryable: bool,
}

#[derive(Debug, PartialEq, Eq)]
enum RequestValidation {
    Authorized,
    MethodNotAllowed,
    NotFound,
    Unauthorized,
}

fn config_cell() -> &'static OnceLock<TokenBrokerConfig> {
    static CONFIG: OnceLock<TokenBrokerConfig> = OnceLock::new();
    &CONFIG
}

fn random_capability() -> AppResult<String> {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};

    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes)
        .map_err(|error| AppError::Internal(format!("generate Wander broker secret: {error}")))?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

fn configured_inference_base_url() -> AppResult<String> {
    let raw = std::env::var("WANDER_INFERENCE_BASE_URL")
        .unwrap_or_else(|_| DEFAULT_INFERENCE_BASE_URL.to_string());
    validate_inference_base_url(&raw)
}

fn validate_inference_base_url(raw: &str) -> AppResult<String> {
    let parsed = Url::parse(raw)
        .map_err(|error| AppError::InvalidRequest(format!("Wander inference URL 无效: {error}")))?;
    let host = parsed
        .host_str()
        .ok_or_else(|| AppError::InvalidRequest("Wander inference URL 缺少主机名".to_string()))?;
    let allowed_path = matches!(parsed.path(), "" | "/" | "/v1");
    let secure = parsed.scheme() == "https"
        && host == INFERENCE_HOST
        && parsed.port_or_known_default() == Some(443);
    let local_dev = cfg!(debug_assertions)
        && parsed.scheme() == "http"
        && matches!(host, "127.0.0.1" | "localhost");
    if (!secure && !local_dev) || !allowed_path {
        return Err(AppError::InvalidRequest(
            "Wander inference URL 不在允许的主机或路径内".to_string(),
        ));
    }
    if !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err(AppError::InvalidRequest(
            "Wander inference URL 不得包含凭据、查询参数或片段".to_string(),
        ));
    }
    Ok(raw.trim_end_matches('/').to_string())
}

pub fn broker_config() -> Option<TokenBrokerConfig> {
    config_cell().get().cloned()
}

/// Inject the process-local capability into the desktop-owned managed Core.
/// The values are never written to HERMES_HOME or an environment file.
pub fn configure_managed_core(command: &mut Command) {
    let Some(config) = broker_config() else {
        return;
    };
    command
        .env("WANDER_TOKEN_BROKER_URL", &config.endpoint)
        .env("WANDER_TOKEN_BROKER_SECRET", &config.capability)
        .env("WANDER_INFERENCE_BASE_URL", &config.inference_base_url)
        .env("WANDER_PORTAL_AUDIENCE", PORTAL_AUDIENCE);
}

pub async fn start_token_broker() -> AppResult<TokenBrokerConfig> {
    if let Some(config) = broker_config() {
        return Ok(config);
    }

    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .await
        .map_err(|error| AppError::Internal(format!("bind Wander token broker: {error}")))?;
    let port = listener
        .local_addr()
        .map_err(|error| AppError::Internal(format!("read Wander broker address: {error}")))?
        .port();
    let config = TokenBrokerConfig {
        endpoint: format!("http://127.0.0.1:{port}{TOKEN_PATH}"),
        capability: random_capability()?,
        inference_base_url: configured_inference_base_url()?,
    };
    config_cell()
        .set(config.clone())
        .map_err(|_| AppError::Internal("Wander token broker already initialized".to_string()))?;

    let server_config = config.clone();
    tokio::spawn(async move {
        loop {
            match listener.accept().await {
                Ok((stream, peer)) if peer.ip().is_loopback() => {
                    let request_config = server_config.clone();
                    tokio::spawn(async move {
                        if let Err(error) = handle_connection(stream, &request_config).await {
                            log::debug!("Wander token broker request failed: {error}");
                        }
                    });
                }
                Ok((_stream, peer)) => {
                    log::warn!("Rejected non-loopback Wander broker peer: {peer}");
                }
                Err(error) => {
                    log::warn!("Wander token broker accept failed: {error}");
                    break;
                }
            }
        }
    });

    Ok(config)
}

async fn handle_connection(mut stream: TcpStream, config: &TokenBrokerConfig) -> AppResult<()> {
    let request = read_request_headers(&mut stream).await?;
    let expected_host = Url::parse(&config.endpoint)
        .ok()
        .and_then(|url| {
            url.host_str()
                .map(|host| format!("{host}:{}", url.port().unwrap_or(80)))
        })
        .ok_or_else(|| AppError::Internal("invalid Wander broker endpoint".to_string()))?;
    match validate_request(&request, &expected_host, &config.capability) {
        RequestValidation::Authorized => match access_token_for_portal().await {
            Ok((access_token, expires_at)) => {
                let body = serde_json::to_vec(&BrokerTokenResponse {
                    access_token,
                    expires_at,
                    token_type: "Bearer",
                    inference_base_url: config.inference_base_url.clone(),
                })
                .map_err(|error| {
                    AppError::Internal(format!("serialize Wander broker response: {error}"))
                })?;
                write_response(&mut stream, "200 OK", &body).await
            }
            Err(AppError::AuthSessionExpired(_)) => {
                write_error(
                    &mut stream,
                    "401 Unauthorized",
                    "login_required",
                    "请先登录 Wanderminds ID",
                    false,
                )
                .await
            }
            Err(error) => {
                log::warn!("Wander token broker could not resolve access token: {error}");
                write_error(
                    &mut stream,
                    "503 Service Unavailable",
                    "reauth_required",
                    "暂时无法刷新 Wanderminds ID 登录",
                    true,
                )
                .await
            }
        },
        RequestValidation::MethodNotAllowed => {
            write_error(
                &mut stream,
                "405 Method Not Allowed",
                "invalid_request",
                "请求方法不支持",
                false,
            )
            .await
        }
        RequestValidation::NotFound => {
            write_error(
                &mut stream,
                "404 Not Found",
                "invalid_request",
                "请求路径不存在",
                false,
            )
            .await
        }
        RequestValidation::Unauthorized => {
            write_error(
                &mut stream,
                "401 Unauthorized",
                "login_required",
                "Broker capability 无效",
                false,
            )
            .await
        }
    }
}

async fn read_request_headers(stream: &mut TcpStream) -> AppResult<String> {
    let mut bytes = Vec::with_capacity(1024);
    let mut chunk = [0_u8; 1024];
    loop {
        let read = tokio::time::timeout(READ_TIMEOUT, stream.read(&mut chunk))
            .await
            .map_err(|_| AppError::InvalidRequest("Wander broker 请求读取超时".to_string()))?
            .map_err(|error| {
                AppError::InvalidRequest(format!("读取 Wander broker 请求失败: {error}"))
            })?;
        if read == 0 {
            break;
        }
        bytes.extend_from_slice(&chunk[..read]);
        if bytes.windows(4).any(|window| window == b"\r\n\r\n") {
            break;
        }
        if bytes.len() >= MAX_HEADER_BYTES {
            return Err(AppError::InvalidRequest(
                "Wander broker 请求头过大".to_string(),
            ));
        }
    }
    if bytes.len() > MAX_HEADER_BYTES {
        return Err(AppError::InvalidRequest(
            "Wander broker 请求头过大".to_string(),
        ));
    }
    String::from_utf8(bytes)
        .map_err(|_| AppError::InvalidRequest("Wander broker 请求头不是 UTF-8".to_string()))
}

fn validate_request(request: &str, expected_host: &str, capability: &str) -> RequestValidation {
    let Some(headers) = request.split_once("\r\n\r\n").map(|parts| parts.0) else {
        return RequestValidation::Unauthorized;
    };
    let mut lines = headers.split("\r\n");
    let mut request_line = lines.next().unwrap_or_default().split_whitespace();
    let method = request_line.next().unwrap_or_default();
    let target = request_line.next().unwrap_or_default();
    let version = request_line.next().unwrap_or_default();
    if method != "GET" {
        return RequestValidation::MethodNotAllowed;
    }
    if target != TOKEN_PATH || version != "HTTP/1.1" || request_line.next().is_some() {
        return RequestValidation::NotFound;
    }

    let mut host = None;
    let mut authorization = None;
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            return RequestValidation::Unauthorized;
        };
        if name.eq_ignore_ascii_case("host") {
            host = Some(value.trim());
        } else if name.eq_ignore_ascii_case("authorization") {
            authorization = Some(value.trim());
        }
    }
    if host != Some(expected_host) {
        return RequestValidation::Unauthorized;
    }
    let expected = format!("Bearer {capability}");
    if !constant_time_eq(
        authorization.unwrap_or_default().as_bytes(),
        expected.as_bytes(),
    ) {
        return RequestValidation::Unauthorized;
    }
    RequestValidation::Authorized
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    let mut difference = left.len() ^ right.len();
    for index in 0..left.len().max(right.len()) {
        let left_byte = left.get(index).copied().unwrap_or(0);
        let right_byte = right.get(index).copied().unwrap_or(0);
        difference |= usize::from(left_byte ^ right_byte);
    }
    difference == 0
}

async fn write_error(
    stream: &mut TcpStream,
    status: &str,
    code: &'static str,
    message: &'static str,
    retryable: bool,
) -> AppResult<()> {
    let body = serde_json::to_vec(&BrokerErrorResponse {
        code,
        message,
        retryable,
    })
    .map_err(|error| AppError::Internal(format!("serialize Wander broker error: {error}")))?;
    write_response(stream, status, &body).await
}

async fn write_response(stream: &mut TcpStream, status: &str, body: &[u8]) -> AppResult<()> {
    let headers = format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream
        .write_all(headers.as_bytes())
        .await
        .and_then(|_| std::io::Result::Ok(()))
        .map_err(|error| AppError::Internal(format!("write Wander broker headers: {error}")))?;
    stream
        .write_all(body)
        .await
        .map_err(|error| AppError::Internal(format!("write Wander broker body: {error}")))?;
    let _ = stream.shutdown().await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_exact_host_path_method_and_capability() {
        let request = "GET /v1/token HTTP/1.1\r\nHost: 127.0.0.1:43123\r\nAuthorization: Bearer secret\r\n\r\n";
        assert_eq!(
            validate_request(request, "127.0.0.1:43123", "secret"),
            RequestValidation::Authorized
        );
        assert_eq!(
            validate_request(
                "POST /v1/token HTTP/1.1\r\nHost: 127.0.0.1:43123\r\nAuthorization: Bearer secret\r\n\r\n",
                "127.0.0.1:43123",
                "secret"
            ),
            RequestValidation::MethodNotAllowed
        );
        assert_eq!(
            validate_request(
                "GET /v1/token?leak=1 HTTP/1.1\r\nHost: 127.0.0.1:43123\r\nAuthorization: Bearer secret\r\n\r\n",
                "127.0.0.1:43123",
                "secret"
            ),
            RequestValidation::NotFound
        );
        assert_eq!(
            validate_request(request, "127.0.0.1:43123", "wrong"),
            RequestValidation::Unauthorized
        );
        assert_eq!(
            validate_request(request, "127.0.0.1:43124", "secret"),
            RequestValidation::Unauthorized
        );
    }

    #[test]
    fn inference_url_requires_https_except_debug_loopback() {
        assert_eq!(
            validate_inference_base_url("https://inference-staging.wanderminds.ai/").unwrap(),
            "https://inference-staging.wanderminds.ai"
        );
        assert!(validate_inference_base_url("http://example.com").is_err());
        assert!(validate_inference_base_url("https://user@example.com?q=1").is_err());
        assert!(validate_inference_base_url("https://attacker.example/v1").is_err());
        assert!(
            validate_inference_base_url("https://inference-staging.wanderminds.ai/proxy").is_err()
        );
    }

    #[test]
    fn capability_comparison_checks_content_and_length() {
        assert!(constant_time_eq(b"same", b"same"));
        assert!(!constant_time_eq(b"same", b"diff"));
        assert!(!constant_time_eq(b"same", b"same-longer"));
    }
}
