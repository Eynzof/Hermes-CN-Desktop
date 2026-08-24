//! Serde mirrors of the TypeScript `packages/credential-pool/src/types.ts`.
//!
//! Field names use `camelCase` to match the TS object shape. Enum variants use
//! `snake_case` to match the TS string literals (`"fill_first"`, `"oauth"`, ...).

use serde::{Deserialize, Serialize};

/// How a credential is authenticated.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthType {
    ApiKey,
    Oauth,
}

/// The credential pool rotation strategy.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RotationStrategy {
    FillFirst,
    RoundRobin,
    LeastUsed,
    Random,
}

/// Last known status of a pooled credential.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LastStatus {
    Ok,
    Exhausted,
    Dead,
}

/// Why a credential failed (drives the cooldown TTL).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FailureReason {
    RateLimit,
    Billing,
    Auth,
    UpstreamRateLimit,
    Unknown,
}

/// A single pooled credential (secret-bearing).
///
/// This mirrors the TS `PooledCredential` interface. Note: the pool logic in
/// this crate keeps the secret-bearing fields for the pure port; the
/// [`crate::credentials::vault`] module provides the secret-store boundary.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PooledCredential {
    pub provider: String,
    pub id: String,
    pub label: String,
    pub auth_type: AuthType,
    pub priority: i64,
    pub source: String,
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub last_status: Option<LastStatus>,
    pub last_status_at: Option<i64>,
    pub last_error_code: Option<i64>,
    pub last_error_reason: Option<FailureReason>,
    pub last_error_message: Option<String>,
    pub last_error_reset_at: Option<i64>,
    pub base_url: Option<String>,
    pub expires_at: Option<String>,
    pub expires_at_ms: Option<i64>,
    pub last_refresh: Option<String>,
    pub inference_base_url: Option<String>,
    pub agent_key: Option<String>,
    pub request_count: u64,
    pub extra: serde_json::Map<String, serde_json::Value>,
}

/// Context describing a credential failure.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorContext {
    pub status_code: Option<i64>,
    pub reason: Option<String>,
    pub message: Option<String>,
}

/// Options accepted by the TS `CredentialPool` constructor.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialPoolOptions {
    pub provider: String,
    pub strategy: Option<RotationStrategy>,
}
