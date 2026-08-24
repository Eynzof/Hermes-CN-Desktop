// Home Assistant origin-locked HTTP proxy command (`ha_request`).
//
// The default HASS_URL is `http://homeassistant.local:8123`: http + LAN + mDNS.
// This is rejected by `external_request`, which only allows https or local http.
// `ha_request` relaxes the policy *only* for the user-configured HASS_URL origin
// so LAN/Home Assistant targets are reachable while SSRF exposure stays limited
// to that single origin.

use std::collections::HashMap;

use serde::Deserialize;

use crate::error::AppError;

use super::api_proxy::{ApiRequestResult, EXTERNAL_HTTP_CLIENT};

const HASS_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HaRequestInput {
    pub url: String,
    #[serde(default)]
    pub method: Option<String>,
    pub path: String,
    #[serde(default)]
    pub headers: Option<HashMap<String, String>>,
    #[serde(default)]
    pub body: Option<String>,
}

/// Defense-in-depth HA path validation: reject blocked service domains and
/// malformed entity ids / service names (mirror of `homeassistant/security.ts`).
fn validate_ha_path(path: &str) -> Result<(), AppError> {
    use crate::toolkit::ha_security::{
        is_blocked_domain, is_valid_entity_id, is_valid_service_name,
    };

    let trimmed = path.trim_start_matches('/');

    // Service call: `/api/services/<domain>/<service>`
    if let Some(rest) = trimmed.strip_prefix("api/services/") {
        let parts: Vec<&str> = rest.split('/').collect();
        if parts.len() >= 2 {
            let domain = parts[0];
            let service = parts[1];
            if is_blocked_domain(domain) {
                return Err(AppError::InvalidRequest(format!(
                    "blocked Home Assistant domain '{}'",
                    domain
                )));
            }
            if !is_valid_service_name(service) {
                return Err(AppError::InvalidRequest(format!(
                    "invalid Home Assistant service name '{}'",
                    service
                )));
            }
        }
    }

    // Entity state: `/api/states/<entity_id>`
    if let Some(rest) = trimmed.strip_prefix("api/states/") {
        let entity_id = rest.split('/').next().unwrap_or("");
        if !entity_id.is_empty() && !is_valid_entity_id(entity_id) {
            return Err(AppError::InvalidRequest(format!(
                "invalid Home Assistant entity id '{}'",
                entity_id
            )));
        }
    }

    Ok(())
}

/// Validate that `target` stays within the configured HASS_URL origin.
fn validate_hass_url(base: &str, target: &str) -> Result<url::Url, AppError> {
    let base_url = url::Url::parse(base)
        .map_err(|e| AppError::InvalidRequest(format!("Invalid HASS_URL '{}': {}", base, e)))?;

    // Build the full target URL. If path is already absolute, require it to share
    // the same origin as the configured base URL.
    let target_url = if target.starts_with("http://") || target.starts_with("https://") {
        url::Url::parse(target).map_err(|e| {
            AppError::InvalidRequest(format!(
                "Invalid Home Assistant request URL '{}': {}",
                target, e
            ))
        })?
    } else {
        base_url.join(target).map_err(|e| {
            AppError::InvalidRequest(format!(
                "Invalid Home Assistant request path '{}': {}",
                target, e
            ))
        })?
    };

    if target_url.scheme() != "http" && target_url.scheme() != "https" {
        return Err(AppError::InvalidRequest(
            "Home Assistant requests must use http or https".to_string(),
        ));
    }

    // Origin-lock: scheme, host and port must match the configured HASS_URL.
    // We compare the textual host so mDNS names like `homeassistant.local` are
    // preserved; if the host is an IP it must match literally.
    let base_host = base_url.host_str().unwrap_or("");
    let target_host = target_url.host_str().unwrap_or("");
    let base_port = base_url.port_or_known_default();
    let target_port = target_url.port_or_known_default();

    if base_host.is_empty()
        || target_host.is_empty()
        || base_host != target_host
        || base_port != target_port
    {
        return Err(AppError::OriginViolation(format!(
            "Home Assistant request target '{}' does not match configured HASS_URL origin",
            target_url
        )));
    }

    Ok(target_url)
}

#[tauri::command]
pub async fn ha_request(input: HaRequestInput) -> Result<ApiRequestResult, AppError> {
    validate_ha_path(&input.path)?;
    let target_url = validate_hass_url(&input.url, &input.path)?;
    let method = input.method.as_deref().unwrap_or("GET");
    let display_url = target_url.as_str().to_string();

    let mut req =
        EXTERNAL_HTTP_CLIENT.request(method.parse().unwrap_or(reqwest::Method::GET), target_url);

    if let Some(headers) = input.headers {
        for (key, value) in headers {
            req = req.header(key.as_str(), value.as_str());
        }
    }

    if let Some(body) = input.body {
        req = req.body(body);
    }

    // reqwest's timeout on the shared external client is 15s; enforce it here
    // explicitly so future client changes don't silently extend exposure.
    req = req.timeout(HASS_TIMEOUT);

    let result = req.send().await;

    match result {
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
                    format!(
                        "Home Assistant request to {} timed out after 15s",
                        display_url
                    )
                } else {
                    e.to_string()
                },
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    #[test]
    fn validates_same_origin_request() {
        let target = validate_hass_url("http://homeassistant.local:8123", "/api/states").unwrap();
        assert_eq!(
            target.as_str(),
            "http://homeassistant.local:8123/api/states"
        );
    }

    #[test]
    fn validates_absolute_path_matching_origin() {
        let target = validate_hass_url(
            "http://homeassistant.local:8123",
            "http://homeassistant.local:8123/api/services",
        )
        .unwrap();
        assert_eq!(target.path(), "/api/services");
    }

    #[test]
    fn rejects_wrong_host() {
        let err = validate_hass_url(
            "http://homeassistant.local:8123",
            "http://evil.local:8123/api/states",
        )
        .unwrap_err();
        assert!(err.to_string().contains("Request outside allowed origin"));
    }

    #[test]
    fn rejects_wrong_port() {
        let err = validate_hass_url(
            "http://homeassistant.local:8123",
            "http://homeassistant.local:8124/api/states",
        )
        .unwrap_err();
        assert!(err.to_string().contains("Request outside allowed origin"));
    }

    #[test]
    fn rejects_non_http_scheme() {
        let err = validate_hass_url(
            "http://homeassistant.local:8123",
            "ftp://homeassistant.local:8123/file",
        )
        .unwrap_err();
        assert!(err.to_string().contains("http or https"));
    }

    #[test]
    fn rejects_path_traversal() {
        let err = validate_hass_url(
            "http://homeassistant.local:8123",
            "http://other.host/api/../etc",
        )
        .unwrap_err();
        assert!(err.to_string().contains("Request outside allowed origin"));
    }
}
