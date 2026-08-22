// Web search/extract OS-level helpers: long-timeout external HTTP proxy and
// full-text cache storage under $HERMES_HOME/cache/web.

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands::api_proxy::{validate_external_url, ApiRequestResult};
use crate::error::AppError;
use crate::state::AppState;

const DEFAULT_WEB_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_WEB_REDIRECTS: usize = 5;
const DEFAULT_MAX_BYTES: usize = 10 * 1024 * 1024; // 10 MB
const MAX_STORE_BYTES: usize = 2 * 1024 * 1024; // 2 MB stored-file cap

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebProviderRequestInput {
    pub path: String,
    #[serde(default)]
    pub method: Option<String>,
    #[serde(default)]
    pub headers: Option<HashMap<String, String>>,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub timeout_seconds: Option<u64>,
    #[serde(default)]
    pub max_bytes: Option<usize>,
    #[serde(default)]
    pub follow_redirects: Option<bool>,
}

fn build_web_client(timeout: Duration) -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(timeout)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("valid web provider HTTP client")
}

fn build_request(
    client: &reqwest::Client,
    method: &str,
    url: reqwest::Url,
    headers: &Option<HashMap<String, String>>,
    body: &Option<String>,
) -> reqwest::RequestBuilder {
    let mut req = client.request(method.parse().unwrap_or(reqwest::Method::GET), url);
    if let Some(ref headers) = headers {
        for (key, value) in headers {
            req = req.header(key.as_str(), value.as_str());
        }
    }
    if let Some(ref body) = body {
        req = req.body(body.clone());
    }
    req
}

async fn read_response_limited(
    response: reqwest::Response,
    limit: usize,
) -> Result<String, AppError> {
    if response
        .content_length()
        .is_some_and(|length| length > limit as u64)
    {
        return Err(AppError::InvalidRequest(format!(
            "Response body exceeds {} byte limit",
            limit
        )));
    }

    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| AppError::ProxyError(e.to_string()))?;
        if bytes.len() + chunk.len() > limit {
            return Err(AppError::InvalidRequest(format!(
                "Response body exceeds {} byte limit",
                limit
            )));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

async fn next_redirect_url(
    current: &reqwest::Url,
    response: &reqwest::Response,
) -> Result<reqwest::Url, AppError> {
    let location = response
        .headers()
        .get(reqwest::header::LOCATION)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| {
            AppError::InvalidRequest("Redirect missing Location header".to_string())
        })?;
    let next = current.join(location)?;
    validate_external_url(next.as_str()).await
}

pub async fn web_provider_request_impl(
    input: WebProviderRequestInput,
) -> Result<ApiRequestResult, AppError> {
    let timeout = input
        .timeout_seconds
        .map(|s| Duration::from_secs(s))
        .unwrap_or(DEFAULT_WEB_TIMEOUT);
    let max_bytes = input.max_bytes.unwrap_or(DEFAULT_MAX_BYTES);
    let follow_redirects = input.follow_redirects.unwrap_or(false);

    let mut target_url = validate_external_url(&input.path).await?;
    let client = build_web_client(timeout);
    let method = input.method.as_deref().unwrap_or("GET");

    for redirect_count in 0..=MAX_WEB_REDIRECTS {
        let req = build_request(&client, method, target_url.clone(), &input.headers, &input.body);
        let response = req.send().await.map_err(|e| {
            let is_timeout = e.is_timeout();
            return AppError::ProxyError(if is_timeout {
                format!("Request to {} timed out after {}s", input.path, timeout.as_secs())
            } else {
                e.to_string()
            });
        })?;

        if follow_redirects && response.status().is_redirection() {
            if redirect_count >= MAX_WEB_REDIRECTS {
                return Err(AppError::InvalidRequest(
                    "Too many redirects".to_string(),
                ));
            }
            target_url = next_redirect_url(&target_url, &response).await?;
            continue;
        }

        let status = response.status().as_u16();
        let status_text = response
            .status()
            .canonical_reason()
            .unwrap_or("")
            .to_string();
        let res_headers: HashMap<String, String> = response
            .headers()
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string()))
            .collect();
        let body = read_response_limited(response, max_bytes).await?;

        return Ok(ApiRequestResult {
            ok: (200..300).contains(&status),
            status,
            status_text,
            headers: res_headers,
            body,
        });
    }

    Err(AppError::InvalidRequest("Too many redirects".to_string()))
}

/// Generic external HTTP request for web search/extract providers.
/// Supports longer timeouts, larger response bodies, and optional revalidated redirects.
#[tauri::command]
pub async fn web_provider_request(
    input: WebProviderRequestInput,
) -> Result<ApiRequestResult, AppError> {
    web_provider_request_impl(input).await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebStoreFullTextInput {
    pub file_name: String,
    pub content: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebStoreFullTextResult {
    pub path: String,
    pub stored_chars: usize,
    pub truncated: bool,
}

fn sanitize_filename_segment(name: &str) -> String {
    name.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' {
                c
            } else {
                '_'
            }
        })
        .collect::<String>()
        .trim_matches(|c| c == '.' || c == '/')
        .to_string()
}

/// Write full extracted text to $HERMES_HOME/cache/web/<file_name>.
/// Caps at 2 MB and returns the stored path.
#[tauri::command]
pub async fn web_store_full_text(
    input: WebStoreFullTextInput,
    state: State<'_, AppState>,
) -> Result<WebStoreFullTextResult, AppError> {
    let hermes_home = {
        let inner = state.inner.lock()?;
        inner.hermes_home.clone()
    };

    let safe_name = sanitize_filename_segment(&input.file_name);
    if safe_name.is_empty() {
        return Err(AppError::InvalidRequest(
            "web_store_full_text: empty file name".to_string(),
        ));
    }

    let dir = PathBuf::from(&hermes_home).join("cache").join("web");
    std::fs::create_dir_all(&dir)?;

    let path = dir.join(&safe_name);
    let original_len = input.content.len();
    let content = if original_len > MAX_STORE_BYTES {
        let marker = format!("\n\n[... stored copy truncated at {} chars]", MAX_STORE_BYTES);
        let take = MAX_STORE_BYTES.saturating_sub(marker.len());
        format!("{}{}", &input.content[..take], marker)
    } else {
        input.content
    };

    std::fs::write(&path, &content)?;

    Ok(WebStoreFullTextResult {
        path: path.to_string_lossy().into_owned(),
        stored_chars: content.len(),
        truncated: original_len > MAX_STORE_BYTES,
    })
}

// Core helpers exposed for Rust integration tests.
pub async fn web_request_impl_test(
    url: &str,
    method: &str,
    body: Option<&str>,
    timeout_seconds: u64,
) -> Result<ApiRequestResult, AppError> {
    let input = WebProviderRequestInput {
        path: url.to_string(),
        method: Some(method.to_string()),
        headers: None,
        body: body.map(|s| s.to_string()),
        timeout_seconds: Some(timeout_seconds),
        max_bytes: None,
        follow_redirects: Some(false),
    };
    web_provider_request_impl(input).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::api_proxy::validate_external_url_shape;
    use pretty_assertions::assert_eq;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[test]
    fn validate_external_url_shape_accepts_https() {
        let url = validate_external_url_shape("https://api.example.com/v1/search").unwrap();
        assert_eq!(url.host_str(), Some("api.example.com"));
    }

    #[test]
    fn sanitize_filename_removes_path_injection() {
        let safe = sanitize_filename_segment("../etc/passwd");
        assert!(!safe.contains('/'));
        assert!(!safe.contains(".."));
    }

    #[tokio::test]
    async fn web_provider_request_forwards_body_and_headers() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/search"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"ok": true})))
            .expect(1)
            .mount(&server)
            .await;

        let input = WebProviderRequestInput {
            path: format!("{}/search", server.uri()),
            method: Some("POST".to_string()),
            headers: Some(HashMap::from([("X-Test".to_string(), "1".to_string())])),
            body: Some(r#"{"q":"hello"}"#.to_string()),
            timeout_seconds: None,
            max_bytes: None,
            follow_redirects: Some(false),
        };
        let result = web_provider_request_impl(input).await.unwrap();
        assert!(result.ok);
        assert_eq!(result.status, 200);
        assert!(result.body.contains("ok"));
    }

    #[tokio::test]
    async fn web_provider_request_caps_response_size() {
        let server = MockServer::start().await;
        let big = "x".repeat(DEFAULT_MAX_BYTES + 1000);
        Mock::given(method("GET"))
            .and(path("/big"))
            .respond_with(ResponseTemplate::new(200).set_body_string(big))
            .expect(1)
            .mount(&server)
            .await;

        let input = WebProviderRequestInput {
            path: format!("{}/big", server.uri()),
            method: None,
            headers: None,
            body: None,
            timeout_seconds: None,
            max_bytes: Some(100),
            follow_redirects: Some(false),
        };
        let err = web_provider_request_impl(input).await.unwrap_err();
        assert!(err.to_string().contains("exceeds"));
    }

    #[tokio::test]
    async fn web_provider_request_follows_and_revalidates_redirects() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/redirect"))
            .respond_with(
                ResponseTemplate::new(302).insert_header("Location", format!("{}/final", server.uri())),
            )
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/final"))
            .respond_with(ResponseTemplate::new(200).set_body_string("ok"))
            .expect(1)
            .mount(&server)
            .await;

        let input = WebProviderRequestInput {
            path: format!("{}/redirect", server.uri()),
            method: None,
            headers: None,
            body: None,
            timeout_seconds: None,
            max_bytes: None,
            follow_redirects: Some(true),
        };
        let result = web_provider_request_impl(input).await.unwrap();
        assert!(result.ok);
        assert_eq!(result.body, "ok");
    }
}
