//! Serde mirror of `@hermes/protocol/src/subscription-proxy.ts`.
//!
//! These structs are used by the subscription proxy (`src/subscription_proxy`)
//! and its Tauri commands. The wire shape is `camelCase` (`baseUrl`,
//! `tokenType`, `expiresAt`).

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UpstreamCredential {
    pub bearer: String,
    pub base_url: String,
    pub token_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ProxyProvider {
    Nous,
    Xai,
}

impl ProxyProvider {
    pub fn as_str(&self) -> &'static str {
        match self {
            ProxyProvider::Nous => "nous",
            ProxyProvider::Xai => "xai",
        }
    }

    pub fn parse(s: &str) -> Option<ProxyProvider> {
        match s {
            "nous" => Some(ProxyProvider::Nous),
            "xai" => Some(ProxyProvider::Xai),
            _ => None,
        }
    }
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct ProxyStatus {
    pub running: bool,
    pub port: u16,
    pub provider: ProxyProvider,
    pub authenticated: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upstream_credential_round_trips_camel_case() {
        let v = serde_json::json!({
            "bearer": "x",
            "baseUrl": "https://api.example.com",
            "tokenType": "bearer",
            "expiresAt": "2030-01-01T00:00:00Z"
        });
        let c: UpstreamCredential = serde_json::from_value(v.clone()).unwrap();
        assert_eq!(c.base_url, "https://api.example.com");
        assert_eq!(c.token_type, "bearer");
        assert_eq!(c.expires_at.as_deref(), Some("2030-01-01T00:00:00Z"));
        assert_eq!(serde_json::to_value(&c).unwrap(), v);
    }

    #[test]
    fn upstream_credential_omits_expires_at_when_none() {
        let c = UpstreamCredential {
            bearer: "x".into(),
            base_url: "https://example.com".into(),
            token_type: "bearer".into(),
            expires_at: None,
        };
        let out = serde_json::to_value(&c).unwrap();
        assert!(out.get("expires_at").is_none());
        assert_eq!(out["baseUrl"], "https://example.com");
    }

    #[test]
    fn proxy_provider_parse_and_serialize() {
        assert_eq!(ProxyProvider::parse("nous"), Some(ProxyProvider::Nous));
        assert_eq!(ProxyProvider::parse("xai"), Some(ProxyProvider::Xai));
        assert_eq!(ProxyProvider::parse("other"), None);
        assert_eq!(ProxyProvider::Nous.as_str(), "nous");
        assert_eq!(
            serde_json::to_value(ProxyProvider::Xai).unwrap(),
            serde_json::json!("xai")
        );
    }

    #[test]
    fn proxy_status_round_trips() {
        let v = serde_json::json!({
            "running": true,
            "port": 8645,
            "provider": "nous",
            "authenticated": true
        });
        let s: ProxyStatus = serde_json::from_value(v.clone()).unwrap();
        assert_eq!(s.provider, ProxyProvider::Nous);
        assert_eq!(s.port, 8645);
        assert_eq!(serde_json::to_value(&s).unwrap(), v);
    }
}
