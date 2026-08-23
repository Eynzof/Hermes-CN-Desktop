use std::time::Duration;

use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use url::Url;

use crate::commands::wanderminds_id::access_token_for_portal;
use crate::error::AppError;

const DEFAULT_PORTAL_API_URL: &str = "https://portal-staging.wanderminds.ai";
const PORTAL_HOST: &str = "portal-staging.wanderminds.ai";
const HTTP_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PortalIpcError {
    pub code: String,
    pub message: String,
    pub request_id: String,
    pub retryable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub billing_url: Option<String>,
}

#[derive(Debug, Deserialize)]
struct PortalErrorBody {
    code: String,
    message: String,
    #[serde(default)]
    request_id: Option<String>,
    #[serde(default)]
    retryable: bool,
    #[serde(default)]
    billing_url: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedeemInviteInput {
    pub code: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateCheckoutInput {
    pub kind: String,
    pub plan_slug: Option<String>,
    pub idempotency_key: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrderInput {
    pub order_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageInput {
    pub cursor: Option<String>,
}

impl PortalIpcError {
    fn local(code: &str, message: impl Into<String>, retryable: bool) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
            request_id: "desktop-local".to_string(),
            retryable,
            billing_url: None,
        }
    }
}

fn map_local_error(error: AppError) -> PortalIpcError {
    match error {
        AppError::AuthSessionExpired(message) => {
            PortalIpcError::local("login_required", message, false)
        }
        other => PortalIpcError::local("relay_unavailable", other.to_string(), true),
    }
}

fn portal_api_base_url() -> Result<Url, PortalIpcError> {
    let raw = std::env::var("WANDER_PORTAL_API_URL")
        .unwrap_or_else(|_| DEFAULT_PORTAL_API_URL.to_string());
    let parsed = Url::parse(&format!("{}/", raw.trim_end_matches('/')))
        .map_err(|error| PortalIpcError::local("invalid_request", error.to_string(), false))?;
    let host = parsed.host_str().ok_or_else(|| {
        PortalIpcError::local("invalid_request", "Wander Portal URL 缺少主机名", false)
    })?;
    let allowed_path = matches!(parsed.path(), "" | "/");
    let secure = parsed.scheme() == "https"
        && host == PORTAL_HOST
        && parsed.port_or_known_default() == Some(443);
    let local_dev = cfg!(debug_assertions)
        && parsed.scheme() == "http"
        && matches!(host, "127.0.0.1" | "localhost");
    if (!secure && !local_dev) || !allowed_path {
        return Err(PortalIpcError::local(
            "invalid_request",
            "Wander Portal URL 不在允许的主机或路径内",
            false,
        ));
    }
    if !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err(PortalIpcError::local(
            "invalid_request",
            "Wander Portal URL 不得包含凭据、查询参数或片段",
            false,
        ));
    }
    Ok(parsed)
}

fn portal_client() -> Result<reqwest::Client, PortalIpcError> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(HTTP_TIMEOUT)
        .build()
        .map_err(|error| PortalIpcError::local("relay_unavailable", error.to_string(), true))
}

async fn portal_request(
    method: Method,
    path: &str,
    body: Option<Value>,
    idempotency_key: Option<&str>,
) -> Result<Value, PortalIpcError> {
    let (access_token, _) = access_token_for_portal().await.map_err(map_local_error)?;
    let url = portal_api_base_url()?
        .join(path.trim_start_matches('/'))
        .map_err(|error| PortalIpcError::local("invalid_request", error.to_string(), false))?;
    let mut request = portal_client()?
        .request(method, url)
        .bearer_auth(access_token)
        .header("Accept", "application/json");
    if let Some(value) = body {
        request = request.json(&value);
    }
    if let Some(key) = idempotency_key {
        request = request.header("Idempotency-Key", key);
    }
    let response = request
        .send()
        .await
        .map_err(|error| PortalIpcError::local("relay_unavailable", error.to_string(), true))?;
    let status = response.status();
    let bytes = response
        .bytes()
        .await
        .map_err(|error| PortalIpcError::local("relay_unavailable", error.to_string(), true))?;
    if !status.is_success() {
        if let Ok(error) = serde_json::from_slice::<PortalErrorBody>(&bytes) {
            return Err(PortalIpcError {
                code: error.code,
                message: error.message,
                request_id: error
                    .request_id
                    .unwrap_or_else(|| "portal-missing".to_string()),
                retryable: error.retryable,
                billing_url: error.billing_url,
            });
        }
        return Err(PortalIpcError::local(
            "relay_unavailable",
            format!("Wander Portal 返回 HTTP {}", status.as_u16()),
            status.is_server_error(),
        ));
    }
    if status.as_u16() == 204 || bytes.is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_slice(&bytes)
        .map_err(|error| PortalIpcError::local("relay_unavailable", error.to_string(), true))
}

#[tauri::command]
pub async fn wander_portal_account_state() -> Result<Value, PortalIpcError> {
    portal_request(Method::GET, "/v1/account/state", None, None).await
}

#[tauri::command]
pub async fn wander_portal_plans() -> Result<Value, PortalIpcError> {
    portal_request(Method::GET, "/v1/plans", None, None).await
}

#[tauri::command]
pub async fn wander_portal_redeem_invite(
    input: RedeemInviteInput,
) -> Result<Value, PortalIpcError> {
    portal_request(
        Method::POST,
        "/v1/invites/redeem",
        Some(json!({ "code": input.code })),
        None,
    )
    .await
}

#[tauri::command]
pub async fn wander_portal_create_checkout(
    input: CreateCheckoutInput,
) -> Result<Value, PortalIpcError> {
    if !matches!(input.kind.as_str(), "subscription" | "topup") {
        return Err(PortalIpcError::local(
            "invalid_request",
            "结算类型无效",
            false,
        ));
    }
    if input.idempotency_key.trim().is_empty() || input.idempotency_key.len() > 255 {
        return Err(PortalIpcError::local(
            "invalid_request",
            "结算幂等键无效",
            false,
        ));
    }
    portal_request(
        Method::POST,
        "/v1/checkout-sessions",
        Some(json!({
            "kind": input.kind,
            "plan_slug": input.plan_slug,
        })),
        Some(&input.idempotency_key),
    )
    .await
}

#[tauri::command]
pub async fn wander_portal_order(input: OrderInput) -> Result<Value, PortalIpcError> {
    let path = format!("/v1/orders/{}", urlencoding::encode(input.order_id.trim()));
    portal_request(Method::GET, &path, None, None).await
}

#[tauri::command]
pub async fn wander_portal_usage(input: UsageInput) -> Result<Value, PortalIpcError> {
    let mut url = portal_api_base_url()?
        .join("v1/usage")
        .map_err(|error| PortalIpcError::local("invalid_request", error.to_string(), false))?;
    if let Some(cursor) = input.cursor.filter(|value| !value.trim().is_empty()) {
        url.query_pairs_mut().append_pair("cursor", &cursor);
    }
    let path = match url.query() {
        Some(query) => format!("/v1/usage?{query}"),
        None => "/v1/usage".to_string(),
    };
    portal_request(Method::GET, &path, None, None).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn production_portal_url_requires_https_and_no_credentials() {
        let parsed = Url::parse(DEFAULT_PORTAL_API_URL).unwrap();
        assert_eq!(parsed.host_str(), Some(PORTAL_HOST));
        assert!(portal_api_base_url().is_ok());
    }

    #[test]
    fn portal_error_shape_preserves_recovery_fields() {
        let parsed: PortalErrorBody = serde_json::from_value(json!({
            "code": "insufficient_credit",
            "message": "额度不足",
            "request_id": "req_1",
            "retryable": false,
            "billing_url": "https://portal-staging.wanderminds.ai/portal"
        }))
        .unwrap();
        assert_eq!(parsed.code, "insufficient_credit");
        assert_eq!(parsed.request_id.as_deref(), Some("req_1"));
        assert!(parsed.billing_url.is_some());
    }
}
