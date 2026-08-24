//! Serde mirror of `@hermes/protocol/src/egress-proxy.ts` plus the command args
//! used by `src/commands/egress_proxy.rs`.
//!
//! Wire shapes are mostly `camelCase` (`importedAt`, `rulesJson`, `secretsJson`).

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::schema::util;

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum EgressAction {
    Allow,
    Deny,
    Rewrite,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EgressProxyRule {
    pub id: String,
    pub pattern: String,
    pub action: EgressAction,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EgressProxyStatus {
    pub running: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    #[serde(default)]
    pub rules: Vec<EgressProxyRule>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SecretImport {
    pub key: String,
    pub value: String,
    #[serde(default = "util::default_secret_source")]
    pub source: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SecretBundle {
    #[serde(default)]
    pub secrets: HashMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub imported_at: Option<String>,
}

// ── Command args ─────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EgressProxyStartArgs {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EgressProxySetRulesArgs {
    pub rules_json: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EgressProxyDownloadArgs {
    pub url: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EgressProxyImportSecretsArgs {
    pub secrets_json: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn egress_proxy_rule_round_trips_camel_case() {
        let v = serde_json::json!({
            "id": "r1",
            "pattern": "https://example.com/*",
            "action": "rewrite",
            "target": "https://proxy.example.com"
        });
        let r: EgressProxyRule = serde_json::from_value(v.clone()).unwrap();
        assert_eq!(r.action, EgressAction::Rewrite);
        assert_eq!(r.target.as_deref(), Some("https://proxy.example.com"));
        assert_eq!(serde_json::to_value(&r).unwrap(), v);
    }

    #[test]
    fn egress_proxy_status_defaults_and_omits_port() {
        let s: EgressProxyStatus =
            serde_json::from_value(serde_json::json!({ "running": false })).unwrap();
        assert_eq!(s.port, None);
        assert!(s.rules.is_empty());
        let out = serde_json::to_value(&s).unwrap();
        assert!(out.get("port").is_none());
        assert_eq!(out["rules"], serde_json::json!([]));
    }

    #[test]
    fn egress_proxy_status_round_trips_with_rules() {
        let v = serde_json::json!({
            "running": true,
            "port": 8650,
            "rules": [{"id": "r1", "pattern": "*", "action": "allow"}]
        });
        let s: EgressProxyStatus = serde_json::from_value(v.clone()).unwrap();
        assert_eq!(s.port, Some(8650));
        assert_eq!(s.rules.len(), 1);
        assert_eq!(serde_json::to_value(&s).unwrap(), v);
    }

    #[test]
    fn secret_bundle_round_trips() {
        let v = serde_json::json!({
            "secrets": {"A": "1"},
            "importedAt": "2024-01-01T00:00:00Z"
        });
        let b: SecretBundle = serde_json::from_value(v.clone()).unwrap();
        assert_eq!(b.secrets["A"], "1");
        assert_eq!(serde_json::to_value(&b).unwrap(), v);
    }

    #[test]
    fn secret_import_defaults_source_env() {
        let s: SecretImport = serde_json::from_value(serde_json::json!({
            "key": "K", "value": "V"
        }))
        .unwrap();
        assert_eq!(s.source, "env");
    }
}
