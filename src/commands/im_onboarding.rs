use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{LazyLock, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::State;
use url::Url;

use crate::error::AppError;
use crate::state::AppState;

static HTTP: LazyLock<Client> = LazyLock::new(|| {
    Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .expect("valid IM onboarding HTTP client")
});

static FLOWS: LazyLock<Mutex<HashMap<String, FlowState>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

const FEISHU_ACCOUNTS_BASE: &str = "https://accounts.feishu.cn";
const FEISHU_OPEN_BASE: &str = "https://open.feishu.cn";
const LARK_ACCOUNTS_BASE: &str = "https://accounts.larksuite.com";
const LARK_OPEN_BASE: &str = "https://open.larksuite.com";
const FEISHU_REGISTRATION_PATH: &str = "/oauth/v1/app/registration";
const WEIXIN_BASE_URL: &str = "https://ilinkai.weixin.qq.com";
const WEIXIN_CDN_BASE_URL: &str = "https://novac2c.cdn.weixin.qq.com/c2c";
const WEIXIN_CLIENT_VERSION: &str = "131584";
const WEIXIN_QR_REFRESH_LIMIT: u8 = 3;
const FEISHU_SCANNED_OPEN_ID_TOKEN: &str = "__HERMES_SCANNED_FEISHU_OPEN_ID__";
const WEIXIN_SCANNED_USER_ID_TOKEN: &str = "__HERMES_SCANNED_WEIXIN_USER_ID__";

const FEISHU_SECRET_KEYS: &[&str] = &[
    "FEISHU_APP_SECRET",
    "FEISHU_ENCRYPT_KEY",
    "FEISHU_VERIFICATION_TOKEN",
];
const WEIXIN_SECRET_KEYS: &[&str] = &["WEIXIN_TOKEN"];

const FEISHU_ALLOWED_KEYS: &[&str] = &[
    "FEISHU_DOMAIN",
    "FEISHU_APP_ID",
    "FEISHU_APP_SECRET",
    "FEISHU_CONNECTION_MODE",
    "FEISHU_WEBHOOK_HOST",
    "FEISHU_WEBHOOK_PORT",
    "FEISHU_WEBHOOK_PATH",
    "FEISHU_ENCRYPT_KEY",
    "FEISHU_VERIFICATION_TOKEN",
    "FEISHU_ALLOW_ALL_USERS",
    "FEISHU_ALLOWED_USERS",
    "FEISHU_GROUP_POLICY",
    "FEISHU_REQUIRE_MENTION",
    "FEISHU_HOME_CHANNEL",
];
const WEIXIN_ALLOWED_KEYS: &[&str] = &[
    "WEIXIN_ACCOUNT_ID",
    "WEIXIN_TOKEN",
    "WEIXIN_BASE_URL",
    "WEIXIN_CDN_BASE_URL",
    "WEIXIN_DM_POLICY",
    "WEIXIN_ALLOW_ALL_USERS",
    "WEIXIN_ALLOWED_USERS",
    "WEIXIN_GROUP_POLICY",
    "WEIXIN_GROUP_ALLOWED_USERS",
    "WEIXIN_HOME_CHANNEL",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ImPlatform {
    Feishu,
    Weixin,
}

impl ImPlatform {
    fn as_str(self) -> &'static str {
        match self {
            ImPlatform::Feishu => "feishu",
            ImPlatform::Weixin => "weixin",
        }
    }

    fn allowed_keys(self) -> &'static [&'static str] {
        match self {
            ImPlatform::Feishu => FEISHU_ALLOWED_KEYS,
            ImPlatform::Weixin => WEIXIN_ALLOWED_KEYS,
        }
    }

    fn secret_keys(self) -> &'static [&'static str] {
        match self {
            ImPlatform::Feishu => FEISHU_SECRET_KEYS,
            ImPlatform::Weixin => WEIXIN_SECRET_KEYS,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImOnboardingStateInput {
    pub platform: ImPlatform,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImOnboardingBeginInput {
    pub platform: ImPlatform,
    pub domain: Option<String>,
    pub bot_type: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImOnboardingPollInput {
    pub platform: ImPlatform,
    pub flow_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImManualCredentials {
    pub app_id: Option<String>,
    pub app_secret: Option<String>,
    pub account_id: Option<String>,
    pub token: Option<String>,
    pub base_url: Option<String>,
    pub user_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImOnboardingApplyInput {
    pub platform: ImPlatform,
    pub flow_id: Option<String>,
    pub manual_credentials: Option<ImManualCredentials>,
    pub settings: BTreeMap<String, String>,
    pub restart_gateway: Option<bool>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RedactedValue {
    pub is_set: bool,
    pub redacted_value: Option<String>,
    pub fingerprint: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImOnboardingStateResult {
    pub platform: String,
    pub current_profile: String,
    pub hermes_home: String,
    pub env_path: String,
    pub configured: BTreeMap<String, RedactedValue>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImOnboardingBeginResult {
    pub flow_id: String,
    pub platform: String,
    pub status: String,
    pub qr_url: Option<String>,
    pub qr_scan_data: Option<String>,
    pub user_code: Option<String>,
    pub interval_seconds: u64,
    pub expires_at_ms: u64,
    pub message: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialSummary {
    pub app_id: Option<RedactedValue>,
    pub app_secret: Option<RedactedValue>,
    pub account_id: Option<RedactedValue>,
    pub token: Option<RedactedValue>,
    pub base_url: Option<String>,
    pub domain: Option<String>,
    pub user_id: Option<RedactedValue>,
    pub bot_name: Option<String>,
    pub bot_open_id: Option<RedactedValue>,
    pub open_id: Option<RedactedValue>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImOnboardingPollResult {
    pub flow_id: String,
    pub platform: String,
    pub status: String,
    pub qr_url: Option<String>,
    pub qr_scan_data: Option<String>,
    pub interval_seconds: u64,
    pub expires_at_ms: u64,
    pub credential_summary: Option<CredentialSummary>,
    pub message: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImRestartResult {
    pub requested: bool,
    pub ok: bool,
    pub status: Option<u16>,
    pub message: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImOnboardingApplyResult {
    pub ok: bool,
    pub platform: String,
    pub current_profile: String,
    pub env_path: String,
    pub backup_path: Option<String>,
    pub written: BTreeMap<String, RedactedValue>,
    pub restart: ImRestartResult,
}

#[derive(Debug, Clone)]
enum FlowState {
    Feishu(FeishuFlow),
    Weixin(WeixinFlow),
}

#[derive(Debug, Clone)]
struct FeishuFlow {
    device_code: String,
    domain: String,
    interval_seconds: u64,
    expires_at: Instant,
    expires_at_ms: u64,
    credential: Option<FeishuCredential>,
}

#[derive(Debug, Clone)]
struct FeishuCredential {
    app_id: String,
    app_secret: String,
    domain: String,
    open_id: Option<String>,
    bot_name: Option<String>,
    bot_open_id: Option<String>,
}

#[derive(Debug, Clone)]
struct WeixinFlow {
    qrcode_value: String,
    qrcode_url: Option<String>,
    current_base_url: String,
    refresh_count: u8,
    interval_seconds: u64,
    expires_at: Instant,
    expires_at_ms: u64,
    credential: Option<WeixinCredential>,
}

#[derive(Debug, Clone)]
struct WeixinCredential {
    account_id: String,
    token: String,
    base_url: String,
    user_id: Option<String>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn new_flow_id(platform: ImPlatform) -> String {
    let seed = format!("{}:{}:{}", platform.as_str(), std::process::id(), now_ms());
    let digest = Sha256::digest(seed.as_bytes());
    format!("{}-{}", platform.as_str(), bytes_to_lower_hex(&digest[..8]))
}

fn bytes_to_lower_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn same_path(left: &str, right: &str) -> bool {
    let left = fs::canonicalize(left).unwrap_or_else(|_| PathBuf::from(left));
    let right = fs::canonicalize(right).unwrap_or_else(|_| PathBuf::from(right));
    left == right
}

fn expires_at_ms_from(timeout: Duration) -> u64 {
    now_ms() + timeout.as_millis() as u64
}

fn normalized_domain(value: Option<String>) -> String {
    match value
        .unwrap_or_else(|| "feishu".to_string())
        .trim()
        .to_lowercase()
        .as_str()
    {
        "lark" => "lark".to_string(),
        _ => "feishu".to_string(),
    }
}

fn feishu_accounts_base(domain: &str) -> String {
    if let Ok(base) = std::env::var("HERMES_IM_ONBOARDING_FEISHU_ACCOUNTS_URL") {
        return base.trim_end_matches('/').to_string();
    }
    match domain {
        "lark" => LARK_ACCOUNTS_BASE.to_string(),
        _ => FEISHU_ACCOUNTS_BASE.to_string(),
    }
}

fn feishu_open_base(domain: &str) -> String {
    if let Ok(base) = std::env::var("HERMES_IM_ONBOARDING_FEISHU_OPEN_URL") {
        return base.trim_end_matches('/').to_string();
    }
    match domain {
        "lark" => LARK_OPEN_BASE.to_string(),
        _ => FEISHU_OPEN_BASE.to_string(),
    }
}

fn weixin_base_url() -> String {
    std::env::var("HERMES_IM_ONBOARDING_WEIXIN_BASE_URL")
        .unwrap_or_else(|_| WEIXIN_BASE_URL.to_string())
        .trim_end_matches('/')
        .to_string()
}

fn redacted(value: Option<&str>, secret: bool) -> RedactedValue {
    let value = value.unwrap_or("");
    if value.is_empty() {
        return RedactedValue {
            is_set: false,
            redacted_value: None,
            fingerprint: None,
        };
    }
    let digest = Sha256::digest(value.as_bytes());
    let fingerprint = format!("sha256:{}", bytes_to_lower_hex(&digest[..4]));
    let chars: Vec<char> = value.chars().collect();
    let suffix_len = if secret { 4 } else { 6 }.min(chars.len());
    let suffix: String = chars[chars.len() - suffix_len..].iter().collect();
    let prefix: String = if !secret && chars.len() > suffix_len + 6 {
        chars[..6].iter().collect::<String>()
    } else {
        String::new()
    };
    let redacted_value = if secret {
        format!("••••{}", suffix)
    } else if prefix.is_empty() {
        format!("••{}", suffix)
    } else {
        format!("{}••••{}", prefix, suffix)
    };
    RedactedValue {
        is_set: true,
        redacted_value: Some(redacted_value),
        fingerprint: Some(fingerprint),
    }
}

fn credential_from_feishu(value: &FeishuCredential) -> CredentialSummary {
    CredentialSummary {
        app_id: Some(redacted(Some(&value.app_id), false)),
        app_secret: Some(redacted(Some(&value.app_secret), true)),
        account_id: None,
        token: None,
        base_url: None,
        domain: Some(value.domain.clone()),
        user_id: None,
        bot_name: value.bot_name.clone(),
        bot_open_id: value
            .bot_open_id
            .as_deref()
            .map(|v| redacted(Some(v), false)),
        open_id: value.open_id.as_deref().map(|v| redacted(Some(v), false)),
    }
}

fn credential_from_weixin(value: &WeixinCredential) -> CredentialSummary {
    CredentialSummary {
        app_id: None,
        app_secret: None,
        account_id: Some(redacted(Some(&value.account_id), false)),
        token: Some(redacted(Some(&value.token), true)),
        base_url: Some(value.base_url.clone()),
        domain: None,
        user_id: value.user_id.as_deref().map(|v| redacted(Some(v), false)),
        bot_name: None,
        bot_open_id: None,
        open_id: None,
    }
}

fn env_path(hermes_home: &str) -> PathBuf {
    Path::new(hermes_home).join(".env")
}

fn parse_env(path: &Path) -> Result<BTreeMap<String, String>, AppError> {
    let mut result = BTreeMap::new();
    if !path.exists() {
        return Ok(result);
    }
    let raw = fs::read_to_string(path)?;
    for line in raw.lines() {
        let trimmed = line.trim_start();
        if trimmed.is_empty() || trimmed.starts_with('#') || !line.contains('=') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        if is_valid_env_key(key) {
            result.insert(key.to_string(), value.to_string());
        }
    }
    Ok(result)
}

fn is_valid_env_key(key: &str) -> bool {
    let mut chars = key.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn validate_env_patch(
    platform: ImPlatform,
    patch: &BTreeMap<String, String>,
) -> Result<(), AppError> {
    for (key, value) in patch {
        if !is_valid_env_key(key) {
            return Err(AppError::InvalidRequest(format!("Invalid env key: {key}")));
        }
        if !platform.allowed_keys().contains(&key.as_str()) {
            return Err(AppError::InvalidRequest(format!(
                "{key} is not allowed for {} onboarding",
                platform.as_str()
            )));
        }
        if value.contains('\n') || value.contains('\r') || value.bytes().any(|b| b == 0) {
            return Err(AppError::InvalidRequest(format!(
                "Invalid value for {key}: newline and NUL are not allowed"
            )));
        }
    }
    Ok(())
}

fn backup_env(path: &Path) -> Result<Option<PathBuf>, AppError> {
    if !path.exists() {
        return Ok(None);
    }
    let Some(parent) = path.parent() else {
        return Ok(None);
    };
    let backup_dir = parent.join(".env.backups");
    fs::create_dir_all(&backup_dir)?;
    let backup_path = backup_dir.join(format!("im-onboarding-{}.bak", now_ms()));
    fs::copy(path, &backup_path)?;
    Ok(Some(backup_path))
}

fn write_env_patch(
    path: &Path,
    platform: ImPlatform,
    patch: &BTreeMap<String, String>,
) -> Result<Option<PathBuf>, AppError> {
    validate_env_patch(platform, patch)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let backup = backup_env(path)?;
    let original = if path.exists() {
        fs::read_to_string(path)?
    } else {
        String::new()
    };

    let mut seen = BTreeMap::<String, bool>::new();
    let mut lines = Vec::new();
    for line in original.lines() {
        if let Some((raw_key, _)) = line.split_once('=') {
            let key = raw_key.trim();
            if patch.contains_key(key) {
                lines.push(format!(
                    "{}={}",
                    key,
                    patch.get(key).cloned().unwrap_or_default()
                ));
                seen.insert(key.to_string(), true);
                continue;
            }
        }
        lines.push(line.to_string());
    }

    if !patch.is_empty() && !original.is_empty() && !original.ends_with('\n') {
        // `lines()` intentionally strips the trailing newline; this branch only
        // keeps the append block readable for hand-edited files without one.
    }
    for (key, value) in patch {
        if !seen.contains_key(key) {
            lines.push(format!("{}={}", key, value));
        }
    }
    let mut out = lines.join("\n");
    if !out.is_empty() {
        out.push('\n');
    }
    let tmp = path.with_extension(format!("env.tmp.{}", now_ms()));
    fs::write(&tmp, out)?;
    fs::rename(&tmp, path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    }
    Ok(backup)
}

fn configured_for(
    platform: ImPlatform,
    env: &BTreeMap<String, String>,
) -> BTreeMap<String, RedactedValue> {
    let mut result = BTreeMap::new();
    for key in platform.allowed_keys() {
        if let Some(value) = env.get(*key) {
            result.insert(
                key.to_string(),
                redacted(Some(value), platform.secret_keys().contains(key)),
            );
        }
    }
    result
}

fn resolve_feishu_scanned_open_id_token(
    raw: &str,
    scanned_open_id: Option<&str>,
    key: &str,
) -> Result<String, AppError> {
    let trimmed = raw.trim();
    if trimmed != FEISHU_SCANNED_OPEN_ID_TOKEN {
        return Ok(trimmed.to_string());
    }
    scanned_open_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| {
            AppError::InvalidRequest(format!(
                "Scanned Feishu open_id is not available; enter {key} manually"
            ))
        })
}

fn normalize_feishu_allowed_users(
    raw: &str,
    scanned_open_id: Option<&str>,
) -> Result<String, AppError> {
    let mut result: Vec<String> = Vec::new();
    for item in raw
        .split([',', '，', '\n', '\r', '\t', ' '])
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let resolved =
            resolve_feishu_scanned_open_id_token(item, scanned_open_id, "FEISHU_ALLOWED_USERS")?;
        if !result.iter().any(|existing| existing == &resolved) {
            result.push(resolved);
        }
    }
    Ok(result.join(","))
}

fn resolve_weixin_scanned_user_id_token(
    raw: &str,
    scanned_user_id: Option<&str>,
    key: &str,
) -> Result<String, AppError> {
    let trimmed = raw.trim();
    if trimmed != WEIXIN_SCANNED_USER_ID_TOKEN {
        return Ok(trimmed.to_string());
    }
    scanned_user_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| {
            AppError::InvalidRequest(format!(
                "Scanned Weixin user_id is not available; enter {key} manually"
            ))
        })
}

fn normalize_weixin_allowed_users(
    raw: &str,
    scanned_user_id: Option<&str>,
) -> Result<String, AppError> {
    let mut result: Vec<String> = Vec::new();
    for item in raw
        .split([',', '，', '\n', '\r', '\t', ' '])
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let resolved =
            resolve_weixin_scanned_user_id_token(item, scanned_user_id, "WEIXIN_ALLOWED_USERS")?;
        if !result.iter().any(|existing| existing == &resolved) {
            result.push(resolved);
        }
    }
    Ok(result.join(","))
}

async fn feishu_registration_post(domain: &str, body: &[(&str, &str)]) -> Result<Value, AppError> {
    let url = format!(
        "{}{}",
        feishu_accounts_base(domain),
        FEISHU_REGISTRATION_PATH
    );
    let res = HTTP
        .post(url)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .form(body)
        .send()
        .await?;
    let text = res.text().await.unwrap_or_default();
    serde_json::from_str(&text)
        .map_err(|e| AppError::ProxyError(format!("Invalid Feishu registration JSON: {e}")))
}

async fn begin_feishu(input: &ImOnboardingBeginInput) -> Result<ImOnboardingBeginResult, AppError> {
    let domain = normalized_domain(input.domain.clone());
    let init = feishu_registration_post(&domain, &[("action", "init")]).await?;
    let supported = init
        .get("supported_auth_methods")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .any(|item| item.as_str() == Some("client_secret"))
        })
        .unwrap_or(false);
    if !supported {
        return Err(AppError::ProxyError(
            "Feishu / Lark registration does not support client_secret auth".to_string(),
        ));
    }

    let begin = feishu_registration_post(
        &domain,
        &[
            ("action", "begin"),
            ("archetype", "PersonalAgent"),
            ("auth_method", "client_secret"),
            ("request_user_info", "open_id"),
        ],
    )
    .await?;
    let device_code = begin
        .get("device_code")
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty())
        .ok_or_else(|| {
            AppError::ProxyError("Feishu registration did not return device_code".to_string())
        })?
        .to_string();
    let mut qr_url = begin
        .get("verification_uri_complete")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if !qr_url.is_empty() {
        if qr_url.contains('?') {
            qr_url.push_str("&from=hermes&tp=hermes");
        } else {
            qr_url.push_str("?from=hermes&tp=hermes");
        }
    }
    let interval_seconds = begin
        .get("interval")
        .and_then(Value::as_u64)
        .unwrap_or(5)
        .max(1);
    let expire_in = begin
        .get("expire_in")
        .and_then(Value::as_u64)
        .unwrap_or(600)
        .min(600);
    let timeout = Duration::from_secs(expire_in);
    let expires_at_ms = expires_at_ms_from(timeout);
    let flow_id = new_flow_id(ImPlatform::Feishu);
    let flow = FeishuFlow {
        device_code,
        domain,
        interval_seconds,
        expires_at: Instant::now() + timeout,
        expires_at_ms,
        credential: None,
    };
    FLOWS
        .lock()?
        .insert(flow_id.clone(), FlowState::Feishu(flow));

    Ok(ImOnboardingBeginResult {
        flow_id,
        platform: ImPlatform::Feishu.as_str().to_string(),
        status: "pending".to_string(),
        qr_url: Some(qr_url.clone()).filter(|v| !v.is_empty()),
        qr_scan_data: Some(qr_url).filter(|v| !v.is_empty()),
        user_code: begin
            .get("user_code")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        interval_seconds,
        expires_at_ms,
        message: Some("请使用飞书或 Lark 手机端扫码并确认授权。".to_string()),
    })
}

async fn probe_feishu_bot(credential: &FeishuCredential) -> (Option<String>, Option<String>) {
    let token_url = format!(
        "{}/open-apis/auth/v3/tenant_access_token/internal",
        feishu_open_base(&credential.domain)
    );
    let Ok(resp) = HTTP
        .post(token_url)
        .json(&serde_json::json!({
            "app_id": credential.app_id,
            "app_secret": credential.app_secret,
        }))
        .send()
        .await
    else {
        return (None, None);
    };
    let Ok(token_json) = resp.json::<Value>().await else {
        return (None, None);
    };
    let Some(access_token) = token_json
        .get("tenant_access_token")
        .and_then(Value::as_str)
    else {
        return (None, None);
    };
    let bot_url = format!(
        "{}/open-apis/bot/v3/info",
        feishu_open_base(&credential.domain)
    );
    let Ok(resp) = HTTP.get(bot_url).bearer_auth(access_token).send().await else {
        return (None, None);
    };
    let Ok(bot_json) = resp.json::<Value>().await else {
        return (None, None);
    };
    if bot_json.get("code").and_then(Value::as_i64) != Some(0) {
        return (None, None);
    }
    let bot = bot_json
        .get("bot")
        .or_else(|| bot_json.get("data").and_then(|v| v.get("bot")));
    let name = bot
        .and_then(|v| v.get("app_name").or_else(|| v.get("bot_name")))
        .and_then(Value::as_str)
        .map(ToString::to_string);
    let open_id = bot
        .and_then(|v| v.get("open_id"))
        .and_then(Value::as_str)
        .map(ToString::to_string);
    (name, open_id)
}

async fn poll_feishu(flow_id: &str) -> Result<ImOnboardingPollResult, AppError> {
    let mut flow = {
        let flows = FLOWS.lock()?;
        match flows.get(flow_id) {
            Some(FlowState::Feishu(flow)) => flow.clone(),
            _ => {
                return Err(AppError::InvalidRequest(format!(
                    "Unknown Feishu flow: {flow_id}"
                )))
            }
        }
    };
    if Instant::now() > flow.expires_at {
        return Ok(ImOnboardingPollResult {
            flow_id: flow_id.to_string(),
            platform: ImPlatform::Feishu.as_str().to_string(),
            status: "expired".to_string(),
            qr_url: None,
            qr_scan_data: None,
            interval_seconds: flow.interval_seconds,
            expires_at_ms: flow.expires_at_ms,
            credential_summary: flow.credential.as_ref().map(credential_from_feishu),
            message: Some("飞书扫码授权已过期，请重新生成二维码。".to_string()),
        });
    }
    if let Some(credential) = &flow.credential {
        return Ok(ImOnboardingPollResult {
            flow_id: flow_id.to_string(),
            platform: ImPlatform::Feishu.as_str().to_string(),
            status: "confirmed".to_string(),
            qr_url: None,
            qr_scan_data: None,
            interval_seconds: flow.interval_seconds,
            expires_at_ms: flow.expires_at_ms,
            credential_summary: Some(credential_from_feishu(credential)),
            message: Some("飞书机器人凭据已确认。".to_string()),
        });
    }

    let res = feishu_registration_post(
        &flow.domain,
        &[
            ("action", "poll"),
            ("device_code", &flow.device_code),
            ("tp", "ob_app"),
        ],
    )
    .await?;
    if let Some(tenant_brand) = res
        .get("user_info")
        .and_then(|v| v.get("tenant_brand"))
        .and_then(Value::as_str)
    {
        if tenant_brand == "lark" {
            flow.domain = "lark".to_string();
        }
    }
    if let (Some(app_id), Some(app_secret)) = (
        res.get("client_id").and_then(Value::as_str),
        res.get("client_secret").and_then(Value::as_str),
    ) {
        let mut credential = FeishuCredential {
            app_id: app_id.to_string(),
            app_secret: app_secret.to_string(),
            domain: flow.domain.clone(),
            open_id: res
                .get("user_info")
                .and_then(|v| v.get("open_id"))
                .and_then(Value::as_str)
                .map(ToString::to_string),
            bot_name: None,
            bot_open_id: None,
        };
        let (bot_name, bot_open_id) = probe_feishu_bot(&credential).await;
        credential.bot_name = bot_name;
        credential.bot_open_id = bot_open_id;
        flow.credential = Some(credential.clone());
        FLOWS
            .lock()?
            .insert(flow_id.to_string(), FlowState::Feishu(flow.clone()));
        return Ok(ImOnboardingPollResult {
            flow_id: flow_id.to_string(),
            platform: ImPlatform::Feishu.as_str().to_string(),
            status: "confirmed".to_string(),
            qr_url: None,
            qr_scan_data: None,
            interval_seconds: flow.interval_seconds,
            expires_at_ms: flow.expires_at_ms,
            credential_summary: Some(credential_from_feishu(&credential)),
            message: Some("飞书机器人凭据已确认。".to_string()),
        });
    }
    let error = res.get("error").and_then(Value::as_str).unwrap_or("");
    let (status, message) = match error {
        "access_denied" => ("denied", "用户取消或拒绝了飞书授权。"),
        "expired_token" => ("expired", "飞书扫码授权已过期，请重新生成二维码。"),
        _ => ("pending", "等待飞书扫码确认。"),
    };
    FLOWS
        .lock()?
        .insert(flow_id.to_string(), FlowState::Feishu(flow.clone()));
    Ok(ImOnboardingPollResult {
        flow_id: flow_id.to_string(),
        platform: ImPlatform::Feishu.as_str().to_string(),
        status: status.to_string(),
        qr_url: None,
        qr_scan_data: None,
        interval_seconds: flow.interval_seconds,
        expires_at_ms: flow.expires_at_ms,
        credential_summary: None,
        message: Some(message.to_string()),
    })
}

async fn weixin_get(base_url: &str, endpoint: &str) -> Result<Value, AppError> {
    let url = format!(
        "{}/{}",
        base_url.trim_end_matches('/'),
        endpoint.trim_start_matches('/')
    );
    let res = HTTP
        .get(url)
        .header("iLink-App-Id", "bot")
        .header("iLink-App-ClientVersion", WEIXIN_CLIENT_VERSION)
        .send()
        .await?;
    let text = res.text().await.unwrap_or_default();
    serde_json::from_str(&text)
        .map_err(|e| AppError::ProxyError(format!("Invalid Weixin QR JSON: {e}")))
}

async fn refresh_weixin_qr(flow: &mut WeixinFlow) -> Result<(), AppError> {
    let qr_resp = weixin_get(&weixin_base_url(), "ilink/bot/get_bot_qrcode?bot_type=3").await?;
    let qrcode_value = qr_resp
        .get("qrcode")
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty())
        .ok_or_else(|| AppError::ProxyError("Weixin QR response missing qrcode".to_string()))?
        .to_string();
    let qrcode_url = qr_resp
        .get("qrcode_img_content")
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty())
        .map(ToString::to_string);
    flow.qrcode_value = qrcode_value;
    flow.qrcode_url = qrcode_url;
    flow.current_base_url = weixin_base_url();
    Ok(())
}

async fn begin_weixin(input: &ImOnboardingBeginInput) -> Result<ImOnboardingBeginResult, AppError> {
    let bot_type = input.bot_type.clone().unwrap_or_else(|| "3".to_string());
    let base_url = weixin_base_url();
    let endpoint = format!(
        "ilink/bot/get_bot_qrcode?bot_type={}",
        urlencoding::encode(&bot_type)
    );
    let qr_resp = weixin_get(&base_url, &endpoint).await?;
    let qrcode_value = qr_resp
        .get("qrcode")
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty())
        .ok_or_else(|| AppError::ProxyError("Weixin QR response missing qrcode".to_string()))?
        .to_string();
    let qrcode_url = qr_resp
        .get("qrcode_img_content")
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty())
        .map(ToString::to_string);
    let timeout = Duration::from_secs(480);
    let expires_at_ms = expires_at_ms_from(timeout);
    let flow_id = new_flow_id(ImPlatform::Weixin);
    let flow = WeixinFlow {
        qrcode_value: qrcode_value.clone(),
        qrcode_url: qrcode_url.clone(),
        current_base_url: base_url,
        refresh_count: 0,
        interval_seconds: 1,
        expires_at: Instant::now() + timeout,
        expires_at_ms,
        credential: None,
    };
    FLOWS
        .lock()?
        .insert(flow_id.clone(), FlowState::Weixin(flow));
    let scan_data = qrcode_url.clone().unwrap_or(qrcode_value);
    Ok(ImOnboardingBeginResult {
        flow_id,
        platform: ImPlatform::Weixin.as_str().to_string(),
        status: "pending".to_string(),
        qr_url: qrcode_url,
        qr_scan_data: Some(scan_data),
        user_code: None,
        interval_seconds: 1,
        expires_at_ms,
        message: Some("请使用微信手机端扫码，并在手机端确认绑定 iLink bot。".to_string()),
    })
}

async fn poll_weixin(flow_id: &str) -> Result<ImOnboardingPollResult, AppError> {
    let mut flow = {
        let flows = FLOWS.lock()?;
        match flows.get(flow_id) {
            Some(FlowState::Weixin(flow)) => flow.clone(),
            _ => {
                return Err(AppError::InvalidRequest(format!(
                    "Unknown Weixin flow: {flow_id}"
                )))
            }
        }
    };
    if Instant::now() > flow.expires_at {
        return Ok(ImOnboardingPollResult {
            flow_id: flow_id.to_string(),
            platform: ImPlatform::Weixin.as_str().to_string(),
            status: "expired".to_string(),
            qr_url: flow.qrcode_url.clone(),
            qr_scan_data: Some(
                flow.qrcode_url
                    .clone()
                    .unwrap_or_else(|| flow.qrcode_value.clone()),
            ),
            interval_seconds: flow.interval_seconds,
            expires_at_ms: flow.expires_at_ms,
            credential_summary: flow.credential.as_ref().map(credential_from_weixin),
            message: Some("微信二维码已过期，请重新开始扫码。".to_string()),
        });
    }
    if let Some(credential) = &flow.credential {
        return Ok(ImOnboardingPollResult {
            flow_id: flow_id.to_string(),
            platform: ImPlatform::Weixin.as_str().to_string(),
            status: "confirmed".to_string(),
            qr_url: None,
            qr_scan_data: None,
            interval_seconds: flow.interval_seconds,
            expires_at_ms: flow.expires_at_ms,
            credential_summary: Some(credential_from_weixin(credential)),
            message: Some("微信 iLink bot 已确认绑定。".to_string()),
        });
    }
    let endpoint = format!(
        "ilink/bot/get_qrcode_status?qrcode={}",
        urlencoding::encode(&flow.qrcode_value)
    );
    let status_resp = weixin_get(&flow.current_base_url, &endpoint).await?;
    let status = status_resp
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("wait");
    match status {
        "scaned_but_redirect" => {
            if let Some(host) = status_resp.get("redirect_host").and_then(Value::as_str) {
                if !host.is_empty() {
                    flow.current_base_url = format!("https://{}", host.trim_end_matches('/'));
                }
            }
        }
        "expired" => {
            flow.refresh_count += 1;
            if flow.refresh_count <= WEIXIN_QR_REFRESH_LIMIT {
                refresh_weixin_qr(&mut flow).await?;
                FLOWS
                    .lock()?
                    .insert(flow_id.to_string(), FlowState::Weixin(flow.clone()));
                return Ok(ImOnboardingPollResult {
                    flow_id: flow_id.to_string(),
                    platform: ImPlatform::Weixin.as_str().to_string(),
                    status: "expired_refreshed".to_string(),
                    qr_url: flow.qrcode_url.clone(),
                    qr_scan_data: Some(
                        flow.qrcode_url
                            .clone()
                            .unwrap_or_else(|| flow.qrcode_value.clone()),
                    ),
                    interval_seconds: flow.interval_seconds,
                    expires_at_ms: flow.expires_at_ms,
                    credential_summary: None,
                    message: Some(format!(
                        "微信二维码已过期，已自动刷新（{}/3）。",
                        flow.refresh_count
                    )),
                });
            }
        }
        "confirmed" => {
            let account_id = status_resp
                .get("ilink_bot_id")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let token = status_resp
                .get("bot_token")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            if account_id.is_empty() || token.is_empty() {
                return Err(AppError::ProxyError(
                    "Weixin QR confirmed but credential payload was incomplete".to_string(),
                ));
            }
            let credential = WeixinCredential {
                account_id,
                token,
                base_url: status_resp
                    .get("baseurl")
                    .and_then(Value::as_str)
                    .unwrap_or(WEIXIN_BASE_URL)
                    .to_string(),
                user_id: status_resp
                    .get("ilink_user_id")
                    .and_then(Value::as_str)
                    .filter(|v| !v.is_empty())
                    .map(ToString::to_string),
            };
            flow.credential = Some(credential.clone());
            FLOWS
                .lock()?
                .insert(flow_id.to_string(), FlowState::Weixin(flow.clone()));
            return Ok(ImOnboardingPollResult {
                flow_id: flow_id.to_string(),
                platform: ImPlatform::Weixin.as_str().to_string(),
                status: "confirmed".to_string(),
                qr_url: None,
                qr_scan_data: None,
                interval_seconds: flow.interval_seconds,
                expires_at_ms: flow.expires_at_ms,
                credential_summary: Some(credential_from_weixin(&credential)),
                message: Some("微信 iLink bot 已确认绑定。".to_string()),
            });
        }
        _ => {}
    }
    FLOWS
        .lock()?
        .insert(flow_id.to_string(), FlowState::Weixin(flow.clone()));
    let normalized = match status {
        "scaned" => "scanned",
        "expired" => "expired",
        "wait" => "pending",
        other => other,
    };
    let message = match status {
        "scaned" => "已扫码，请在微信手机端确认。",
        "expired" => "微信二维码多次过期，请重新开始扫码。",
        "scaned_but_redirect" => "微信扫码已跳转，继续等待确认。",
        _ => "等待微信扫码。",
    };
    Ok(ImOnboardingPollResult {
        flow_id: flow_id.to_string(),
        platform: ImPlatform::Weixin.as_str().to_string(),
        status: normalized.to_string(),
        qr_url: flow.qrcode_url.clone(),
        qr_scan_data: Some(
            flow.qrcode_url
                .clone()
                .unwrap_or_else(|| flow.qrcode_value.clone()),
        ),
        interval_seconds: flow.interval_seconds,
        expires_at_ms: flow.expires_at_ms,
        credential_summary: None,
        message: Some(message.to_string()),
    })
}

fn state_snapshot(
    platform: ImPlatform,
    hermes_home: &str,
    current_profile: &str,
) -> Result<ImOnboardingStateResult, AppError> {
    let path = env_path(hermes_home);
    let env = parse_env(&path)?;
    Ok(ImOnboardingStateResult {
        platform: platform.as_str().to_string(),
        current_profile: current_profile.to_string(),
        hermes_home: hermes_home.to_string(),
        env_path: path.to_string_lossy().to_string(),
        configured: configured_for(platform, &env),
    })
}

fn apply_patch_from_input(
    input: &ImOnboardingApplyInput,
) -> Result<BTreeMap<String, String>, AppError> {
    let mut patch = input.settings.clone();
    match input.platform {
        ImPlatform::Feishu => {
            let mut scanned_open_id: Option<String> = None;
            let credential = if let Some(flow_id) = &input.flow_id {
                let flows = FLOWS.lock()?;
                match flows.get(flow_id) {
                    Some(FlowState::Feishu(flow)) => flow.credential.clone(),
                    _ => None,
                }
            } else {
                None
            };
            if let Some(credential) = credential {
                scanned_open_id = credential.open_id.clone();
                patch.insert("FEISHU_APP_ID".to_string(), credential.app_id);
                patch.insert("FEISHU_APP_SECRET".to_string(), credential.app_secret);
                patch.insert("FEISHU_DOMAIN".to_string(), credential.domain);
            } else if let Some(manual) = &input.manual_credentials {
                if let Some(app_id) = manual.app_id.as_ref().filter(|v| !v.trim().is_empty()) {
                    patch.insert("FEISHU_APP_ID".to_string(), app_id.trim().to_string());
                }
                if let Some(secret) = manual.app_secret.as_ref().filter(|v| !v.trim().is_empty()) {
                    patch.insert("FEISHU_APP_SECRET".to_string(), secret.trim().to_string());
                }
            }
            patch
                .entry("FEISHU_DOMAIN".to_string())
                .or_insert_with(|| "feishu".to_string());
            patch
                .entry("FEISHU_CONNECTION_MODE".to_string())
                .or_insert_with(|| "websocket".to_string());
            if let Some(connection_mode) = patch.get("FEISHU_CONNECTION_MODE").cloned() {
                patch.insert(
                    "FEISHU_CONNECTION_MODE".to_string(),
                    connection_mode.trim().to_lowercase(),
                );
            }
            if let Some(allowed_users) = patch.get("FEISHU_ALLOWED_USERS").cloned() {
                patch.insert(
                    "FEISHU_ALLOWED_USERS".to_string(),
                    normalize_feishu_allowed_users(&allowed_users, scanned_open_id.as_deref())?,
                );
            }
            if let Some(home_channel) = patch.get("FEISHU_HOME_CHANNEL").cloned() {
                patch.insert(
                    "FEISHU_HOME_CHANNEL".to_string(),
                    resolve_feishu_scanned_open_id_token(
                        &home_channel,
                        scanned_open_id.as_deref(),
                        "FEISHU_HOME_CHANNEL",
                    )?,
                );
            }
        }
        ImPlatform::Weixin => {
            let mut scanned_user_id: Option<String> = None;
            let credential = if let Some(flow_id) = &input.flow_id {
                let flows = FLOWS.lock()?;
                match flows.get(flow_id) {
                    Some(FlowState::Weixin(flow)) => flow.credential.clone(),
                    _ => None,
                }
            } else {
                None
            };
            if let Some(credential) = credential {
                scanned_user_id = credential.user_id.clone();
                patch.insert("WEIXIN_ACCOUNT_ID".to_string(), credential.account_id);
                patch.insert("WEIXIN_TOKEN".to_string(), credential.token);
                patch.insert("WEIXIN_BASE_URL".to_string(), credential.base_url);
                if let Some(user_id) = credential.user_id {
                    if patch
                        .get("WEIXIN_HOME_CHANNEL")
                        .map(|value| value.trim().is_empty())
                        .unwrap_or(true)
                    {
                        patch.insert("WEIXIN_HOME_CHANNEL".to_string(), user_id);
                    }
                }
            } else if let Some(manual) = &input.manual_credentials {
                if let Some(account_id) =
                    manual.account_id.as_ref().filter(|v| !v.trim().is_empty())
                {
                    patch.insert(
                        "WEIXIN_ACCOUNT_ID".to_string(),
                        account_id.trim().to_string(),
                    );
                }
                if let Some(token) = manual.token.as_ref().filter(|v| !v.trim().is_empty()) {
                    patch.insert("WEIXIN_TOKEN".to_string(), token.trim().to_string());
                }
                if let Some(base_url) = manual.base_url.as_ref().filter(|v| !v.trim().is_empty()) {
                    patch.insert(
                        "WEIXIN_BASE_URL".to_string(),
                        base_url.trim().trim_end_matches('/').to_string(),
                    );
                }
                if let Some(user_id) = manual.user_id.as_ref().filter(|v| !v.trim().is_empty()) {
                    if patch
                        .get("WEIXIN_HOME_CHANNEL")
                        .map(|value| value.trim().is_empty())
                        .unwrap_or(true)
                    {
                        patch.insert(
                            "WEIXIN_HOME_CHANNEL".to_string(),
                            user_id.trim().to_string(),
                        );
                    }
                }
            }
            patch
                .entry("WEIXIN_BASE_URL".to_string())
                .or_insert_with(|| WEIXIN_BASE_URL.to_string());
            patch
                .entry("WEIXIN_CDN_BASE_URL".to_string())
                .or_insert_with(|| WEIXIN_CDN_BASE_URL.to_string());
            if let Some(dm_policy) = patch.get("WEIXIN_DM_POLICY").cloned() {
                patch.insert(
                    "WEIXIN_DM_POLICY".to_string(),
                    dm_policy.trim().to_lowercase(),
                );
            }
            if let Some(allowed_users) = patch.get("WEIXIN_ALLOWED_USERS").cloned() {
                patch.insert(
                    "WEIXIN_ALLOWED_USERS".to_string(),
                    normalize_weixin_allowed_users(&allowed_users, scanned_user_id.as_deref())?,
                );
            }
            if let Some(home_channel) = patch.get("WEIXIN_HOME_CHANNEL").cloned() {
                patch.insert(
                    "WEIXIN_HOME_CHANNEL".to_string(),
                    resolve_weixin_scanned_user_id_token(
                        &home_channel,
                        scanned_user_id.as_deref(),
                        "WEIXIN_HOME_CHANNEL",
                    )?,
                );
            }
        }
    }
    validate_required(input.platform, &patch)?;
    Ok(patch)
}

fn validate_required(
    platform: ImPlatform,
    patch: &BTreeMap<String, String>,
) -> Result<(), AppError> {
    match platform {
        ImPlatform::Feishu => {
            if patch
                .get("FEISHU_APP_ID")
                .map(|v| v.trim().is_empty())
                .unwrap_or(true)
                || patch
                    .get("FEISHU_APP_SECRET")
                    .map(|v| v.trim().is_empty())
                    .unwrap_or(true)
            {
                return Err(AppError::InvalidRequest(
                    "FEISHU_APP_ID and FEISHU_APP_SECRET are required".to_string(),
                ));
            }
            let mode = patch
                .get("FEISHU_CONNECTION_MODE")
                .map(|v| v.trim().to_lowercase())
                .unwrap_or_else(|| "websocket".to_string());
            if !matches!(mode.as_str(), "websocket" | "webhook") {
                return Err(AppError::InvalidRequest(
                    "FEISHU_CONNECTION_MODE must be websocket or webhook".to_string(),
                ));
            }
            if mode == "webhook" {
                let has_verification_token = patch
                    .get("FEISHU_VERIFICATION_TOKEN")
                    .map(|v| !v.trim().is_empty())
                    .unwrap_or(false);
                let has_encrypt_key = patch
                    .get("FEISHU_ENCRYPT_KEY")
                    .map(|v| !v.trim().is_empty())
                    .unwrap_or(false);
                if !has_verification_token && !has_encrypt_key {
                    return Err(AppError::InvalidRequest(
                        "FEISHU_VERIFICATION_TOKEN or FEISHU_ENCRYPT_KEY is required for webhook mode"
                            .to_string(),
                    ));
                }
            }
        }
        ImPlatform::Weixin => {
            if patch
                .get("WEIXIN_ACCOUNT_ID")
                .map(|v| v.trim().is_empty())
                .unwrap_or(true)
                || patch
                    .get("WEIXIN_TOKEN")
                    .map(|v| v.trim().is_empty())
                    .unwrap_or(true)
            {
                return Err(AppError::InvalidRequest(
                    "WEIXIN_ACCOUNT_ID and WEIXIN_TOKEN are required".to_string(),
                ));
            }
            let dm_policy = patch
                .get("WEIXIN_DM_POLICY")
                .map(|v| v.trim().to_lowercase())
                .unwrap_or_else(|| "open".to_string());
            if !matches!(
                dm_policy.as_str(),
                "open" | "allowlist" | "pairing" | "disabled"
            ) {
                return Err(AppError::InvalidRequest(
                    "WEIXIN_DM_POLICY must be open, allowlist, pairing, or disabled".to_string(),
                ));
            }
        }
    }
    Ok(())
}

fn write_weixin_account_store(
    hermes_home: &str,
    patch: &BTreeMap<String, String>,
) -> Result<(), AppError> {
    let Some(account_id) = patch
        .get("WEIXIN_ACCOUNT_ID")
        .filter(|v| !v.trim().is_empty())
    else {
        return Ok(());
    };
    validate_path_segment(account_id, "WEIXIN_ACCOUNT_ID")?;
    let Some(token) = patch.get("WEIXIN_TOKEN").filter(|v| !v.trim().is_empty()) else {
        return Ok(());
    };
    let account_dir = Path::new(hermes_home).join("weixin").join("accounts");
    fs::create_dir_all(&account_dir)?;
    let account_path = account_dir.join(format!("{}.json", account_id));
    let payload = serde_json::json!({
        "token": token,
        "base_url": patch.get("WEIXIN_BASE_URL").cloned().unwrap_or_else(|| WEIXIN_BASE_URL.to_string()),
        "user_id": patch.get("WEIXIN_HOME_CHANNEL").cloned().unwrap_or_default(),
        "saved_at": now_ms().to_string(),
    });
    let tmp = account_path.with_extension(format!("json.tmp.{}", now_ms()));
    fs::write(
        &tmp,
        serde_json::to_vec_pretty(&payload).unwrap_or_default(),
    )?;
    fs::rename(&tmp, &account_path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&account_path, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

fn validate_path_segment(value: &str, label: &str) -> Result<(), AppError> {
    let trimmed = value.trim();
    if trimmed.is_empty()
        || trimmed == "."
        || trimmed == ".."
        || trimmed.contains('/')
        || trimmed.contains('\\')
        || trimmed.bytes().any(|b| b == 0)
    {
        return Err(AppError::InvalidRequest(format!(
            "{label} cannot be used as a file name"
        )));
    }
    Ok(())
}

fn validate_managed_gateway_target(
    api_base_url: &str,
    dashboard_owned: bool,
    dashboard_home: Option<&str>,
    hermes_home: &str,
) -> Result<(), String> {
    if api_base_url.is_empty() {
        return Err("Dashboard 尚未就绪，无法重启 Gateway。".to_string());
    }

    let parsed = Url::parse(api_base_url)
        .map_err(|_| format!("Dashboard API 地址无效，无法重启 Gateway：{api_base_url}"))?;
    let port = parsed.port();
    let host = parsed.host_str().unwrap_or_default();
    if host != "127.0.0.1" || port == Some(9119) {
        return Err(format!(
            "拒绝重启非桌面端 managed runtime Gateway：{}",
            api_base_url
        ));
    }
    if !dashboard_owned {
        return Err("拒绝重启 Gateway：当前 dashboard 不是桌面端托管进程。".to_string());
    }
    if let Some(marker_home) = dashboard_home {
        if !same_path(marker_home, hermes_home) {
            return Err(
                "拒绝重启 Gateway：dashboard 所属 HERMES_HOME 与当前 profile 不一致。".to_string(),
            );
        }
    }

    Ok(())
}

fn spawn_managed_gateway_process(hermes_home: &str) -> Result<(u32, PathBuf), String> {
    let record = crate::process::runtime::read_current_record().ok_or_else(|| {
        format!(
            "Managed runtime 未安装或 current.json 无效，无法启动 Gateway。请先在运行时管理里安装 runtime：{}",
            crate::process::runtime::current_record_path_display()
        )
    })?;

    let gateway_runtime_dir = crate::process::runtime::gateway_runtime_dir();
    let gateway_lock_dir = gateway_runtime_dir.join("token-locks");
    fs::create_dir_all(&gateway_runtime_dir)
        .map_err(|err| format!("无法创建 Gateway runtime 目录：{err}"))?;
    fs::create_dir_all(&gateway_lock_dir)
        .map_err(|err| format!("无法创建 Gateway lock 目录：{err}"))?;

    let log_dir = Path::new(hermes_home).join("logs");
    fs::create_dir_all(&log_dir).map_err(|err| format!("无法创建 Gateway 日志目录：{err}"))?;
    let log_path = log_dir.join("desktop-gateway-restart.log");
    let mut log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|err| format!("无法打开 Gateway 重启日志：{err}"))?;
    let _ = writeln!(
        log,
        "\n=== desktop managed gateway restart {} ===\nexecutable={}\nHERMES_HOME={}\nHERMES_GATEWAY_RUNTIME_DIR={}\n",
        now_ms(),
        record.executable_path,
        hermes_home,
        gateway_runtime_dir.to_string_lossy(),
    );

    let stdout = log
        .try_clone()
        .map(Stdio::from)
        .unwrap_or_else(|_| Stdio::null());
    let stderr = Stdio::from(log);

    let mut cmd = Command::new(&record.executable_path);
    cmd.args(["gateway", "run", "--replace"])
        .current_dir(&record.path)
        .env("HERMES_HOME", hermes_home)
        .env("HERMES_GATEWAY_RUNTIME_DIR", &gateway_runtime_dir)
        .env("HERMES_GATEWAY_LOCK_DIR", &gateway_lock_dir)
        .env("HERMES_GATEWAY_DETACHED", "1")
        .env("HERMES_NONINTERACTIVE", "1")
        .env("PYTHONUNBUFFERED", "1")
        .stdout(stdout)
        .stderr(stderr)
        .stdin(Stdio::null());
    if let Some(skills_dir) = crate::process::runtime::current_bundled_skills_dir() {
        cmd.env("HERMES_BUNDLED_SKILLS", skills_dir);
    }
    if let Some(web_dist) = crate::process::runtime::current_dashboard_web_dist_dir() {
        cmd.env("HERMES_WEB_DIST", web_dist);
    }

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x00000200;
        const DETACHED_PROCESS: u32 = 0x00000008;
        cmd.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS);
    }

    let mut child = cmd
        .spawn()
        .map_err(|err| format!("无法启动桌面端 managed Gateway：{err}"))?;
    let pid = child.id();
    thread::sleep(Duration::from_millis(350));
    match child.try_wait() {
        Ok(Some(status)) => Err(format!(
            "Gateway 启动进程过早退出：{status}。请查看日志：{}",
            log_path.to_string_lossy()
        )),
        Ok(None) => {
            thread::spawn(move || {
                let _ = child.wait();
            });
            Ok((pid, log_path))
        }
        Err(err) => Err(format!("无法确认 Gateway 启动状态：{err}")),
    }
}

async fn restart_gateway(state: &State<'_, AppState>, requested: bool) -> ImRestartResult {
    if !requested {
        return ImRestartResult {
            requested: false,
            ok: true,
            status: None,
            message: Some("未请求重启 Gateway。".to_string()),
        };
    }
    let (api_base_url, hermes_home, dashboard_owned, dashboard_home) = match state.inner.lock() {
        Ok(inner) => (
            inner.api_base_url.clone(),
            inner.hermes_home.clone(),
            inner
                .dashboard_handle
                .as_ref()
                .map(|handle| handle.owns_process)
                .unwrap_or(false),
            inner.dashboard_handle.as_ref().and_then(|handle| {
                handle
                    .ownership_marker_path
                    .as_ref()
                    .and_then(|path| fs::read_to_string(path).ok())
                    .and_then(|content| {
                        serde_json::from_str::<crate::process::dashboard::DashboardOwnershipMarker>(
                            &content,
                        )
                        .ok()
                    })
                    .map(|marker| marker.hermes_home)
            }),
        ),
        Err(_) => {
            return ImRestartResult {
                requested: true,
                ok: false,
                status: None,
                message: Some("无法读取桌面端运行状态。".to_string()),
            }
        }
    };

    if let Err(message) = validate_managed_gateway_target(
        &api_base_url,
        dashboard_owned,
        dashboard_home.as_deref(),
        &hermes_home,
    ) {
        return ImRestartResult {
            requested: true,
            ok: false,
            status: None,
            message: Some(message),
        };
    }

    match spawn_managed_gateway_process(&hermes_home) {
        Ok((pid, log_path)) => ImRestartResult {
            requested: true,
            ok: true,
            status: None,
            message: Some(format!(
                "已在桌面端 managed runtime 中启动 Gateway（PID {pid}）。本次没有调用 dashboard /api/gateway/restart，因此不会重启 9119 上的用户全局 Hermes Agent。日志：{}",
                log_path.to_string_lossy()
            )),
        },
        Err(err) => ImRestartResult {
            requested: true,
            ok: false,
            status: None,
            message: Some(err),
        },
    }
}

#[tauri::command]
pub fn im_onboarding_state(
    input: ImOnboardingStateInput,
    state: State<'_, AppState>,
) -> Result<ImOnboardingStateResult, AppError> {
    let (hermes_home, current_profile) = {
        let inner = state.inner.lock()?;
        (inner.hermes_home.clone(), inner.current_profile.clone())
    };
    state_snapshot(input.platform, &hermes_home, &current_profile)
}

#[tauri::command]
pub async fn im_onboarding_begin(
    input: ImOnboardingBeginInput,
) -> Result<ImOnboardingBeginResult, AppError> {
    match input.platform {
        ImPlatform::Feishu => begin_feishu(&input).await,
        ImPlatform::Weixin => begin_weixin(&input).await,
    }
}

#[tauri::command]
pub async fn im_onboarding_poll(
    input: ImOnboardingPollInput,
) -> Result<ImOnboardingPollResult, AppError> {
    match input.platform {
        ImPlatform::Feishu => poll_feishu(&input.flow_id).await,
        ImPlatform::Weixin => poll_weixin(&input.flow_id).await,
    }
}

#[tauri::command]
pub async fn im_onboarding_apply(
    input: ImOnboardingApplyInput,
    state: State<'_, AppState>,
) -> Result<ImOnboardingApplyResult, AppError> {
    let (hermes_home, current_profile) = {
        let inner = state.inner.lock()?;
        (inner.hermes_home.clone(), inner.current_profile.clone())
    };
    let patch = apply_patch_from_input(&input)?;
    let path = env_path(&hermes_home);
    let backup = write_env_patch(&path, input.platform, &patch)?;
    if input.platform == ImPlatform::Weixin {
        write_weixin_account_store(&hermes_home, &patch)?;
    }
    let restart = restart_gateway(&state, input.restart_gateway.unwrap_or(true)).await;
    let mut written = BTreeMap::new();
    for (key, value) in &patch {
        written.insert(
            key.clone(),
            redacted(
                Some(value),
                input.platform.secret_keys().contains(&key.as_str()),
            ),
        );
    }
    Ok(ImOnboardingApplyResult {
        ok: true,
        platform: input.platform.as_str().to_string(),
        current_profile,
        env_path: path.to_string_lossy().to_string(),
        backup_path: backup.map(|p| p.to_string_lossy().to_string()),
        written,
        restart,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;
    use serial_test::serial;
    use tempfile::TempDir;
    use wiremock::matchers::{body_string_contains, method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn clear_im_env_overrides() {
        for key in [
            "HERMES_IM_ONBOARDING_FEISHU_ACCOUNTS_URL",
            "HERMES_IM_ONBOARDING_FEISHU_OPEN_URL",
            "HERMES_IM_ONBOARDING_WEIXIN_BASE_URL",
        ] {
            std::env::remove_var(key);
        }
    }

    #[test]
    fn redaction_does_not_expose_secret() {
        let value = redacted(Some("secret-abcdef"), true);
        assert!(value.is_set);
        let shown = value.redacted_value.unwrap();
        assert!(shown.ends_with("cdef"));
        assert!(!shown.contains("secret-ab"));
    }

    #[test]
    fn env_patch_preserves_comments_and_updates_keys() {
        let dir = TempDir::new().unwrap();
        let env_path = dir.path().join(".env");
        fs::write(
            &env_path,
            "# hello\nFEISHU_APP_ID=old\nOTHER=value\nFEISHU_APP_SECRET=old-secret\n",
        )
        .unwrap();
        let patch = BTreeMap::from([
            ("FEISHU_APP_ID".to_string(), "cli_new".to_string()),
            ("FEISHU_APP_SECRET".to_string(), "new-secret".to_string()),
            (
                "FEISHU_CONNECTION_MODE".to_string(),
                "websocket".to_string(),
            ),
        ]);
        let backup = write_env_patch(&env_path, ImPlatform::Feishu, &patch).unwrap();
        assert!(backup.unwrap().exists());
        let out = fs::read_to_string(&env_path).unwrap();
        assert!(out.contains("# hello"));
        assert!(out.contains("OTHER=value"));
        assert!(out.contains("FEISHU_APP_ID=cli_new"));
        assert!(out.contains("FEISHU_APP_SECRET=new-secret"));
        assert!(out.contains("FEISHU_CONNECTION_MODE=websocket"));
    }

    #[test]
    fn env_patch_rejects_cross_platform_keys() {
        let dir = TempDir::new().unwrap();
        let env_path = dir.path().join(".env");
        let patch = BTreeMap::from([("WEIXIN_TOKEN".to_string(), "x".to_string())]);
        let err = write_env_patch(&env_path, ImPlatform::Feishu, &patch).unwrap_err();
        assert!(err.to_string().contains("not allowed"));
    }

    #[test]
    fn env_state_returns_only_platform_keys() {
        let dir = TempDir::new().unwrap();
        fs::write(
            dir.path().join(".env"),
            "FEISHU_APP_ID=cli_abc123\nWEIXIN_TOKEN=wx-secret\n",
        )
        .unwrap();
        let state =
            state_snapshot(ImPlatform::Feishu, dir.path().to_str().unwrap(), "default").unwrap();
        assert!(state.configured.contains_key("FEISHU_APP_ID"));
        assert!(!state.configured.contains_key("WEIXIN_TOKEN"));
    }

    #[test]
    fn apply_patch_requires_core_credentials() {
        let input = ImOnboardingApplyInput {
            platform: ImPlatform::Weixin,
            flow_id: None,
            manual_credentials: None,
            settings: BTreeMap::new(),
            restart_gateway: Some(false),
        };
        let err = apply_patch_from_input(&input).unwrap_err();
        assert!(err.to_string().contains("WEIXIN_ACCOUNT_ID"));
    }

    #[test]
    fn feishu_apply_expands_scanned_open_id_tokens() {
        let flow_id = "feishu-test-allowlist-token".to_string();
        {
            let mut flows = FLOWS.lock().unwrap();
            flows.insert(
                flow_id.clone(),
                FlowState::Feishu(FeishuFlow {
                    device_code: "device-test".to_string(),
                    domain: "feishu".to_string(),
                    interval_seconds: 5,
                    expires_at: Instant::now() + Duration::from_secs(60),
                    expires_at_ms: now_ms() + 60_000,
                    credential: Some(FeishuCredential {
                        app_id: "cli_test".to_string(),
                        app_secret: "secret-test".to_string(),
                        domain: "feishu".to_string(),
                        open_id: Some("ou_scanner_123456".to_string()),
                        bot_name: None,
                        bot_open_id: None,
                    }),
                }),
            );
        }
        let input = ImOnboardingApplyInput {
            platform: ImPlatform::Feishu,
            flow_id: Some(flow_id.clone()),
            manual_credentials: None,
            settings: BTreeMap::from([
                ("FEISHU_ALLOW_ALL_USERS".to_string(), "false".to_string()),
                (
                    "FEISHU_ALLOWED_USERS".to_string(),
                    format!(
                        "{FEISHU_SCANNED_OPEN_ID_TOKEN}, ou_extra_1, {FEISHU_SCANNED_OPEN_ID_TOKEN}"
                    ),
                ),
                (
                    "FEISHU_HOME_CHANNEL".to_string(),
                    FEISHU_SCANNED_OPEN_ID_TOKEN.to_string(),
                ),
            ]),
            restart_gateway: Some(false),
        };

        let patch = apply_patch_from_input(&input).unwrap();

        assert_eq!(
            patch.get("FEISHU_ALLOWED_USERS").map(String::as_str),
            Some("ou_scanner_123456,ou_extra_1")
        );
        assert_eq!(
            patch.get("FEISHU_HOME_CHANNEL").map(String::as_str),
            Some("ou_scanner_123456")
        );
        FLOWS.lock().unwrap().remove(&flow_id);
    }

    #[test]
    fn feishu_apply_rejects_scanned_token_without_open_id() {
        let flow_id = "feishu-test-missing-open-id".to_string();
        {
            let mut flows = FLOWS.lock().unwrap();
            flows.insert(
                flow_id.clone(),
                FlowState::Feishu(FeishuFlow {
                    device_code: "device-test".to_string(),
                    domain: "feishu".to_string(),
                    interval_seconds: 5,
                    expires_at: Instant::now() + Duration::from_secs(60),
                    expires_at_ms: now_ms() + 60_000,
                    credential: Some(FeishuCredential {
                        app_id: "cli_test".to_string(),
                        app_secret: "secret-test".to_string(),
                        domain: "feishu".to_string(),
                        open_id: None,
                        bot_name: None,
                        bot_open_id: None,
                    }),
                }),
            );
        }
        let input = ImOnboardingApplyInput {
            platform: ImPlatform::Feishu,
            flow_id: Some(flow_id.clone()),
            manual_credentials: None,
            settings: BTreeMap::from([(
                "FEISHU_ALLOWED_USERS".to_string(),
                FEISHU_SCANNED_OPEN_ID_TOKEN.to_string(),
            )]),
            restart_gateway: Some(false),
        };

        let err = apply_patch_from_input(&input).unwrap_err();

        assert!(err.to_string().contains("Scanned Feishu open_id"));
        FLOWS.lock().unwrap().remove(&flow_id);
    }

    #[test]
    fn feishu_webhook_mode_requires_callback_secret() {
        let base = ImManualCredentials {
            app_id: Some("cli_test".to_string()),
            app_secret: Some("secret-test".to_string()),
            account_id: None,
            token: None,
            base_url: None,
            user_id: None,
        };
        let input = ImOnboardingApplyInput {
            platform: ImPlatform::Feishu,
            flow_id: None,
            manual_credentials: Some(base),
            settings: BTreeMap::from([(
                "FEISHU_CONNECTION_MODE".to_string(),
                "webhook".to_string(),
            )]),
            restart_gateway: Some(false),
        };

        let err = apply_patch_from_input(&input).unwrap_err();
        assert!(err.to_string().contains("FEISHU_VERIFICATION_TOKEN"));

        let ok_input = ImOnboardingApplyInput {
            platform: ImPlatform::Feishu,
            flow_id: None,
            manual_credentials: Some(ImManualCredentials {
                app_id: Some("cli_test".to_string()),
                app_secret: Some("secret-test".to_string()),
                account_id: None,
                token: None,
                base_url: None,
                user_id: None,
            }),
            settings: BTreeMap::from([
                ("FEISHU_CONNECTION_MODE".to_string(), "Webhook".to_string()),
                (
                    "FEISHU_VERIFICATION_TOKEN".to_string(),
                    "verify-token".to_string(),
                ),
            ]),
            restart_gateway: Some(false),
        };
        let patch = apply_patch_from_input(&ok_input).unwrap();
        assert_eq!(
            patch.get("FEISHU_CONNECTION_MODE").map(String::as_str),
            Some("webhook")
        );
    }

    #[test]
    fn weixin_apply_expands_scanned_user_tokens() {
        let flow_id = "weixin-test-allowlist-token".to_string();
        {
            let mut flows = FLOWS.lock().unwrap();
            flows.insert(
                flow_id.clone(),
                FlowState::Weixin(WeixinFlow {
                    qrcode_value: "qr-test".to_string(),
                    qrcode_url: Some("https://example.test/qr.png".to_string()),
                    current_base_url: WEIXIN_BASE_URL.to_string(),
                    refresh_count: 0,
                    interval_seconds: 1,
                    expires_at: Instant::now() + Duration::from_secs(60),
                    expires_at_ms: now_ms() + 60_000,
                    credential: Some(WeixinCredential {
                        account_id: "wx_bot_123456".to_string(),
                        token: "token-test".to_string(),
                        base_url: "https://mock.weixin.test".to_string(),
                        user_id: Some("wxid_scanner_123456".to_string()),
                    }),
                }),
            );
        }
        let input = ImOnboardingApplyInput {
            platform: ImPlatform::Weixin,
            flow_id: Some(flow_id.clone()),
            manual_credentials: None,
            settings: BTreeMap::from([
                ("WEIXIN_DM_POLICY".to_string(), "allowlist".to_string()),
                (
                    "WEIXIN_ALLOWED_USERS".to_string(),
                    format!(
                        "{WEIXIN_SCANNED_USER_ID_TOKEN}, wxid_extra_1, {WEIXIN_SCANNED_USER_ID_TOKEN}"
                    ),
                ),
                (
                    "WEIXIN_HOME_CHANNEL".to_string(),
                    WEIXIN_SCANNED_USER_ID_TOKEN.to_string(),
                ),
            ]),
            restart_gateway: Some(false),
        };

        let patch = apply_patch_from_input(&input).unwrap();

        assert_eq!(
            patch.get("WEIXIN_ALLOWED_USERS").map(String::as_str),
            Some("wxid_scanner_123456,wxid_extra_1")
        );
        assert_eq!(
            patch.get("WEIXIN_HOME_CHANNEL").map(String::as_str),
            Some("wxid_scanner_123456")
        );
        FLOWS.lock().unwrap().remove(&flow_id);
    }

    #[test]
    fn weixin_apply_accepts_pairing_policy() {
        let input = ImOnboardingApplyInput {
            platform: ImPlatform::Weixin,
            flow_id: None,
            manual_credentials: Some(ImManualCredentials {
                app_id: None,
                app_secret: None,
                account_id: Some("wx_bot_123456".to_string()),
                token: Some("token-test".to_string()),
                base_url: Some(WEIXIN_BASE_URL.to_string()),
                user_id: None,
            }),
            settings: BTreeMap::from([("WEIXIN_DM_POLICY".to_string(), "pairing".to_string())]),
            restart_gateway: Some(false),
        };

        let patch = apply_patch_from_input(&input).unwrap();

        assert_eq!(
            patch.get("WEIXIN_DM_POLICY").map(String::as_str),
            Some("pairing")
        );
        assert_eq!(
            patch.get("WEIXIN_ACCOUNT_ID").map(String::as_str),
            Some("wx_bot_123456")
        );
    }

    #[test]
    fn parse_env_ignores_comments() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join(".env");
        fs::write(&path, "# A=B\nGOOD=value\nBAD LINE\n").unwrap();
        let parsed = parse_env(&path).unwrap();
        assert_eq!(parsed.get("GOOD").map(String::as_str), Some("value"));
        assert!(!parsed.contains_key("A"));
    }

    #[test]
    fn weixin_account_store_rejects_path_segments() {
        let dir = TempDir::new().unwrap();
        let patch = BTreeMap::from([
            ("WEIXIN_ACCOUNT_ID".to_string(), "../escape".to_string()),
            ("WEIXIN_TOKEN".to_string(), "secret".to_string()),
        ]);
        let err = write_weixin_account_store(dir.path().to_str().unwrap(), &patch).unwrap_err();
        assert!(err.to_string().contains("WEIXIN_ACCOUNT_ID"));
    }

    #[test]
    fn managed_gateway_target_rejects_global_9119() {
        let dir = TempDir::new().unwrap();
        let home = dir.path().to_str().unwrap();
        let err = validate_managed_gateway_target("http://127.0.0.1:9119", true, Some(home), home)
            .unwrap_err();
        assert!(err.contains("非桌面端 managed runtime"));
    }

    #[test]
    fn managed_gateway_target_rejects_unowned_dashboard() {
        let dir = TempDir::new().unwrap();
        let home = dir.path().to_str().unwrap();
        let err = validate_managed_gateway_target("http://127.0.0.1:9120", false, Some(home), home)
            .unwrap_err();
        assert!(err.contains("不是桌面端托管进程"));
    }

    #[test]
    fn managed_gateway_target_rejects_marker_home_mismatch() {
        let current = TempDir::new().unwrap();
        let other = TempDir::new().unwrap();
        let err = validate_managed_gateway_target(
            "http://127.0.0.1:9120",
            true,
            Some(other.path().to_str().unwrap()),
            current.path().to_str().unwrap(),
        )
        .unwrap_err();
        assert!(err.contains("HERMES_HOME 与当前 profile 不一致"));
    }

    #[test]
    fn managed_gateway_target_accepts_owned_runtime_dashboard() {
        let dir = TempDir::new().unwrap();
        let home = dir.path().to_str().unwrap();
        validate_managed_gateway_target("http://127.0.0.1:9120", true, Some(home), home).unwrap();
    }

    #[tokio::test]
    #[serial]
    async fn feishu_qr_mock_state_machine_confirms_credentials() {
        clear_im_env_overrides();
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path(FEISHU_REGISTRATION_PATH))
            .and(body_string_contains("action=init"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "supported_auth_methods": ["client_secret"]
            })))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path(FEISHU_REGISTRATION_PATH))
            .and(body_string_contains("action=begin"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "device_code": "device-1",
                "verification_uri_complete": "https://example.test/scan",
                "interval": 1,
                "expire_in": 600,
                "user_code": "ABC123"
            })))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path(FEISHU_REGISTRATION_PATH))
            .and(body_string_contains("action=poll"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "client_id": "cli_mock_123456",
                "client_secret": "secret-feishu-123456",
                "user_info": { "tenant_brand": "feishu", "open_id": "ou_mock_123456" }
            })))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/open-apis/auth/v3/tenant_access_token/internal"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "tenant_access_token": "tenant-token"
            })))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/open-apis/bot/v3/info"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "code": 0,
                "bot": { "app_name": "Hermes Bot", "open_id": "ou_bot_123456" }
            })))
            .mount(&server)
            .await;
        std::env::set_var("HERMES_IM_ONBOARDING_FEISHU_ACCOUNTS_URL", server.uri());
        std::env::set_var("HERMES_IM_ONBOARDING_FEISHU_OPEN_URL", server.uri());

        let flow = begin_feishu(&ImOnboardingBeginInput {
            platform: ImPlatform::Feishu,
            domain: Some("feishu".to_string()),
            bot_type: None,
        })
        .await
        .unwrap();
        let result = poll_feishu(&flow.flow_id).await.unwrap();

        assert_eq!(result.status, "confirmed");
        let credential = result.credential_summary.expect("credential summary");
        assert_eq!(credential.bot_name.as_deref(), Some("Hermes Bot"));
        let app_secret = credential.app_secret.expect("redacted app secret");
        assert!(app_secret.is_set);
        assert!(!app_secret.redacted_value.unwrap().contains("secret-feishu"));

        clear_im_env_overrides();
    }

    #[tokio::test]
    #[serial]
    async fn weixin_qr_mock_state_machine_confirms_credentials() {
        clear_im_env_overrides();
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/ilink/bot/get_bot_qrcode"))
            .and(query_param("bot_type", "3"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "qrcode": "qr-one",
                "qrcode_img_content": "https://example.test/qr.png"
            })))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/ilink/bot/get_qrcode_status"))
            .and(query_param("qrcode", "qr-one"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "status": "confirmed",
                "ilink_bot_id": "bot_123456",
                "bot_token": "token-weixin-123456",
                "baseurl": "https://mock.weixin.test",
                "ilink_user_id": "wxid_mock"
            })))
            .mount(&server)
            .await;
        std::env::set_var("HERMES_IM_ONBOARDING_WEIXIN_BASE_URL", server.uri());

        let flow = begin_weixin(&ImOnboardingBeginInput {
            platform: ImPlatform::Weixin,
            domain: None,
            bot_type: None,
        })
        .await
        .unwrap();
        let result = poll_weixin(&flow.flow_id).await.unwrap();

        assert_eq!(result.status, "confirmed");
        let credential = result.credential_summary.expect("credential summary");
        assert_eq!(
            credential.base_url.as_deref(),
            Some("https://mock.weixin.test")
        );
        let token = credential.token.expect("redacted token");
        assert!(token.is_set);
        assert!(!token.redacted_value.unwrap().contains("token-weixin"));

        clear_im_env_overrides();
    }
}
