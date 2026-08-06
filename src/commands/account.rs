// Account login + model provisioning (ported from HuanXing-Claw's Electron
// electron/utils/account-session.ts + electron/services/account-api.ts).
//
// Logs in to a newapi-style account server (brand `serviceUrl`), fetches the
// account's usable models and a full `sk-` API key, and registers the selected
// models as account-backed custom providers in the runtime config so they
// become usable in chat. Models advertised as Anthropic/Messages-compatible are
// split into a separate provider because Core stores api_mode at provider level.
//
// Security model:
//   - The server authenticates with an HttpOnly `session` cookie that a webview
//     fetch cannot hold, so the cookie + logged-in user id live in main-process
//     memory here (SESSION). Protected endpoints also require a
//     `New-Api-User: <id>` header matching the session user.
//   - The full `sk-` key never crosses the IPC boundary to the frontend. It is
//     held in the OS credential store (keyring on Windows/macOS) and injected
//     into the runtime config by `account_save_models` server-side. Commands
//     only ever return a masked preview + `hasKey`.

use std::collections::{BTreeMap, HashSet};
use std::sync::LazyLock;
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::State;

use crate::brand_generated::{BRAND_ACCOUNT_DEFAULT_MODELS, BRAND_APP_NAME, BRAND_PROVIDER_KEY};
use crate::error::AppError;
use crate::model_registry::{
    apply_managed_providers_json, clear_default_model_if_managed_json, managed_provider_id,
    migrate_legacy_config_json, set_default_model_json, ApiMode, ManagedModel, ManagedNamespace,
    ManagedProvider,
};
use crate::state::AppState;

/// HTTP client for the account server (newapi). Short timeout, no redirect
/// following so a relay catch-all 404 surfaces as a real status rather than a
/// silent hop.
static HTTP: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .expect("valid account HTTP client")
});

/// Dashboard client for reading/writing the runtime config (longer timeout to
/// match the api_proxy dashboard client).
static DASHBOARD_HTTP: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .expect("valid account dashboard HTTP client")
});

/// In-memory login session. Single user per app lifetime.
static SESSION: LazyLock<Mutex<Option<SessionState>>> = LazyLock::new(|| Mutex::new(None));

type ModelEndpointTypes = BTreeMap<String, Vec<String>>;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct AccountModelCatalog {
    models: Vec<String>,
    endpoint_types: ModelEndpointTypes,
}

#[derive(Clone)]
struct SessionState {
    base_url: String,
    session_cookie: String,
    user: AccountUser,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AccountUser {
    pub id: i64,
    pub username: String,
    pub display_name: String,
    pub role: i64,
    pub status: i64,
    pub group: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountToken {
    pub id: i64,
    pub name: String,
    pub group: String,
    pub status: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountBalance {
    pub quota: f64,
    pub used_quota: f64,
    pub quota_per_unit: f64,
    pub display_in_currency: bool,
    pub top_up_url: String,
}

// ---- inputs -------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginInput {
    pub base_url: String,
    pub username: String,
    pub password: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveModelsInput {
    /// Model ids selected in the login dialog.
    pub models: Vec<String>,
    /// Optional per-model endpoint metadata from /api/pricing.
    #[serde(default)]
    pub model_endpoint_types: ModelEndpointTypes,
    /// Optional model id to set as the runtime's current/primary model.
    #[serde(default)]
    pub primary_model_id: Option<String>,
    /// Optional token id whose key backs the saved models. When omitted the
    /// account's first usable token (or a freshly created one) is used.
    #[serde(default)]
    pub token_id: Option<i64>,
}

// ---- outputs ------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusResult {
    pub logged_in: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user: Option<AccountUser>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server_url: Option<String>,
    pub has_key: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub masked_key: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupResult {
    pub user: AccountUser,
    pub base_url: String,
    pub models: Vec<String>,
    pub model_endpoint_types: ModelEndpointTypes,
    pub has_key: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub masked_key: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestModelResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latency_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedCredentialsInfo {
    pub has_saved: bool,
    /// Username for prefilling the login form. Never includes the password.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
}

// ---- helpers ------------------------------------------------------------

fn normalize_base_url(input: &str) -> String {
    input.trim().trim_end_matches('/').to_string()
}

/// 内置模型的 OpenAI 兼容 provider id。
///
/// 走 [`managed_provider_id`] 生成，与设备令牌同步共用同一套规范化规则：全小写、
/// 无 `.`、`custom:acct-` 前缀。旧版写的是 `custom:<brandProviderKey>`，那种形态
/// 由 `migrate_legacy_config` 负责清除——它带着上一个登录用户的 api_key，且没有
/// 任何代码会刷新。
fn account_provider_id() -> String {
    managed_provider_id(ManagedNamespace::Account, BRAND_PROVIDER_KEY)
}

fn account_messages_provider_id() -> String {
    managed_provider_id(
        ManagedNamespace::Account,
        &format!("{}-messages", BRAND_PROVIDER_KEY),
    )
}

/// keyring account name under which the full sk- key is stored.
fn secret_account() -> String {
    format!("{}-account-key", BRAND_PROVIDER_KEY)
}

/// Append `/v1` to the account base URL unless it already ends in `/vN` — the
/// account relay is OpenAI-compatible.
fn account_api_base(base_url: &str) -> String {
    let raw = normalize_base_url(base_url);
    if raw.is_empty() {
        return String::new();
    }
    let already_versioned = raw
        .rsplit('/')
        .next()
        .map(|seg| {
            seg.len() >= 2 && seg.starts_with('v') && seg[1..].chars().all(|c| c.is_ascii_digit())
        })
        .unwrap_or(false);
    if already_versioned {
        raw
    } else {
        format!("{}/v1", raw)
    }
}

/// Anthropic's SDK appends `/v1/messages` to `base_url`, so account-backed
/// Messages providers must use the service root even when the login URL was
/// entered as an OpenAI-style `/v1` base.
fn account_messages_base(base_url: &str) -> String {
    let raw = normalize_base_url(base_url);
    if raw.is_empty() {
        return raw;
    }
    let Some((prefix, suffix)) = raw.rsplit_once('/') else {
        return raw;
    };
    let lower = suffix.to_ascii_lowercase();
    if lower.len() > 1 && lower.starts_with('v') && lower[1..].chars().all(|c| c.is_ascii_digit()) {
        prefix.to_string()
    } else {
        raw
    }
}

/// Mask an sk- key for display: keep the `sk-` prefix + last 4 chars.
fn mask_key(key: &str) -> String {
    let trimmed = key.trim();
    if trimmed.len() <= 8 {
        return "****".to_string();
    }
    let tail = &trimmed[trimmed.len() - 4..];
    format!("sk-****{}", tail)
}

fn ensure_sk_prefix(key: &str) -> String {
    let trimmed = key.trim();
    if trimmed.starts_with("sk-") {
        trimmed.to_string()
    } else {
        format!("sk-{}", trimmed)
    }
}

/// Whether an embedded key is the full secret rather than a masked preview.
fn is_full_key(key: &str) -> bool {
    !key.is_empty() && !key.contains('*') && !key.contains('…') && !key.contains("...")
}

fn push_unique_model(names: &mut Vec<String>, seen: &mut HashSet<String>, name: &str) {
    let name = name.trim();
    if !name.is_empty() && seen.insert(name.to_string()) {
        names.push(name.to_string());
    }
}

fn collect_model_names(value: &Value) -> Vec<String> {
    fn walk(value: &Value, names: &mut Vec<String>, seen: &mut HashSet<String>) {
        match value {
            Value::String(s) => push_unique_model(names, seen, s),
            Value::Array(items) => {
                for item in items {
                    walk(item, names, seen);
                }
            }
            Value::Object(map) => {
                let before = names.len();
                for key in ["data", "models", "items"] {
                    if let Some(child) = map.get(key) {
                        walk(child, names, seen);
                    }
                }
                // 该对象自身是个容器（分组 / endpoint），它的 `name` 是分组标签而
                // 不是模型名。只有在没有嵌套出任何模型时，才把自身当作模型条目，
                // 否则中转站返回的 endpoint 名会变成一个并不存在的幽灵模型。
                if names.len() > before {
                    return;
                }
                for key in ["model_name", "model", "id", "name"] {
                    if let Some(s) = map.get(key).and_then(Value::as_str) {
                        push_unique_model(names, seen, s);
                        return;
                    }
                }
            }
            _ => {}
        }
    }

    let mut names = Vec::new();
    let mut seen = HashSet::new();
    walk(value, &mut names, &mut seen);
    names
}

fn collect_endpoint_types(entry: &Value) -> Vec<String> {
    fn push_type(types: &mut Vec<String>, seen: &mut HashSet<String>, raw: &str) {
        let normalized = raw.trim().to_ascii_lowercase();
        if !normalized.is_empty() && seen.insert(normalized.clone()) {
            types.push(normalized);
        }
    }

    let mut types = Vec::new();
    let mut seen = HashSet::new();
    for key in [
        "supported_endpoint_types",
        "supportedEndpointTypes",
        "endpoint_types",
        "endpointTypes",
    ] {
        let Some(value) = entry.get(key) else {
            continue;
        };
        match value {
            Value::Array(items) => {
                for item in items {
                    if let Some(s) = item.as_str() {
                        push_type(&mut types, &mut seen, s);
                    }
                }
            }
            Value::String(s) => {
                for part in s.split(',') {
                    push_type(&mut types, &mut seen, part);
                }
            }
            _ => {}
        }
    }
    types
}

fn model_name_prefers_messages(model: &str) -> bool {
    let normalized = model.trim().to_ascii_lowercase();
    if normalized.is_empty() {
        return false;
    }
    normalized.contains("claude") || normalized.starts_with("anthropic/")
}

fn model_uses_messages(model: &str, endpoint_types: &[String]) -> bool {
    for endpoint_type in endpoint_types {
        match endpoint_type.as_str() {
            "anthropic" | "claude" | "messages" => return true,
            "openai" | "chat_completions" | "chat-completions" | "openai-response" => return false,
            _ => {}
        }
    }
    model_name_prefers_messages(model)
}

fn endpoint_types_for_model(endpoint_types: &ModelEndpointTypes, model: &str) -> Vec<String> {
    if let Some(types) = endpoint_types.get(model) {
        return types.clone();
    }
    let target = model.trim().to_ascii_lowercase();
    endpoint_types
        .iter()
        .find_map(|(name, types)| {
            (name.trim().to_ascii_lowercase() == target).then(|| types.clone())
        })
        .unwrap_or_default()
}

fn is_brand_account_model(model: &str) -> bool {
    let model = model.trim();
    BRAND_ACCOUNT_DEFAULT_MODELS.contains(&model)
}

/// The brand JSON is authoritative. The account service may advertise many
/// more relay models, but those must never become this desktop brand's built-in
/// catalog.
fn select_brand_account_models(models: &[String]) -> Vec<String> {
    let available: HashSet<&str> = models.iter().map(|model| model.trim()).collect();
    BRAND_ACCOUNT_DEFAULT_MODELS
        .iter()
        .filter(|model| available.contains(**model))
        .map(|model| (*model).to_string())
        .collect()
}

fn select_brand_account_catalog(catalog: AccountModelCatalog) -> AccountModelCatalog {
    let models = select_brand_account_models(&catalog.models);
    let selected: HashSet<&str> = models.iter().map(String::as_str).collect();
    let endpoint_types = catalog
        .endpoint_types
        .into_iter()
        .filter(|(model, _)| selected.contains(model.as_str()))
        .collect();
    AccountModelCatalog {
        models,
        endpoint_types,
    }
}

fn split_models_by_endpoint(
    models: &[String],
    endpoint_types: &ModelEndpointTypes,
) -> (Vec<String>, Vec<String>) {
    let mut chat_models = Vec::new();
    let mut messages_models = Vec::new();
    for model in models {
        let types = endpoint_types_for_model(endpoint_types, model);
        if model_uses_messages(model, &types) {
            messages_models.push(model.clone());
        } else {
            chat_models.push(model.clone());
        }
    }
    (chat_models, messages_models)
}

fn extract_token_items(body: &Value) -> Vec<Value> {
    if let Some(items) = body
        .get("data")
        .and_then(|d| d.get("items"))
        .and_then(Value::as_array)
    {
        return items.clone();
    }
    if let Some(items) = body.get("data").and_then(Value::as_array) {
        return items.clone();
    }
    if let Some(items) = body.get("items").and_then(Value::as_array) {
        return items.clone();
    }
    Vec::new()
}

fn extract_full_key(body: &Value) -> Option<String> {
    let key = body
        .get("data")
        .and_then(Value::as_str)
        .or_else(|| {
            body.get("data")
                .and_then(|d| d.get("key"))
                .and_then(Value::as_str)
        })
        .or_else(|| {
            body.get("data")
                .and_then(|d| d.get("token"))
                .and_then(Value::as_str)
        })
        .or_else(|| body.get("key").and_then(Value::as_str))
        .or_else(|| body.get("token").and_then(Value::as_str))?;
    is_full_key(key).then(|| ensure_sk_prefix(key))
}

/// Pull `session=...` out of one or more Set-Cookie header values.
fn extract_session_cookie(values: &[String]) -> Option<String> {
    for v in values {
        for part in v.split(';') {
            let part = part.trim();
            if part.starts_with("session=") {
                return Some(part.to_string());
            }
        }
    }
    values
        .iter()
        .filter_map(|v| v.split(';').next().map(str::trim))
        .find(|v| !v.is_empty() && v.contains('='))
        .map(str::to_string)
}

fn join_cookie_values(values: &[String]) -> Option<String> {
    let pairs: Vec<String> = values
        .iter()
        .filter_map(|v| v.split(';').next().map(str::trim))
        .filter(|v| !v.is_empty() && v.contains('='))
        .map(str::to_string)
        .collect();
    if pairs.is_empty() {
        None
    } else {
        Some(pairs.join("; "))
    }
}

fn extract_auth_cookie(values: &[String]) -> Option<String> {
    join_cookie_values(values).or_else(|| extract_session_cookie(values))
}

fn snippet(raw: &str) -> String {
    let t = raw.trim();
    if t.len() > 200 {
        format!("{}…", &t[..200])
    } else {
        t.to_string()
    }
}

fn account_http_error(action: &str, status: u16, raw: &str) -> AppError {
    if status == 429 {
        return AppError::ProxyError(format!(
            "{}失败：账户服务请求过于频繁，请稍后再试 (HTTP 429)",
            action
        ));
    }
    AppError::ProxyError(format!(
        "{}失败：账户服务返回非 JSON (HTTP {}): {}",
        action,
        status,
        snippet(raw)
    ))
}

/// Issue an authenticated GET/POST to the account server and parse the JSON
/// envelope (`{ success, message, data }`). Cookie + New-Api-User are set from
/// the live session.
async fn account_json(
    method: reqwest::Method,
    url: &str,
    cookie: &str,
    user_id: i64,
    body: Option<Value>,
) -> Result<(u16, Value), AppError> {
    let mut req = HTTP
        .request(method, url)
        .header("Cookie", cookie)
        .header("New-Api-User", user_id.to_string());
    if let Some(b) = body {
        req = req.json(&b);
    }
    let res = req.send().await?;
    let status = res.status().as_u16();
    let raw = res.text().await.unwrap_or_default();
    if status == 429 {
        return Err(account_http_error("账户请求", status, &raw));
    }
    let parsed: Value = if raw.trim().is_empty() {
        json!({})
    } else {
        serde_json::from_str(&raw).map_err(|_| account_http_error("账户请求", status, &raw))?
    };
    Ok((status, parsed))
}

fn envelope_error(action: &str, status: u16, body: &Value) -> AppError {
    let msg = body
        .get("message")
        .and_then(|m| m.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty());
    match msg {
        Some(m) => AppError::ProxyError(m.to_string()),
        None => AppError::ProxyError(format!("{}失败 (HTTP {})", action, status)),
    }
}

fn require_session() -> Result<SessionState, AppError> {
    SESSION
        .lock()?
        .clone()
        .ok_or_else(|| AppError::InvalidRequest("尚未登录账户".to_string()))
}

// ---- OS secret store (keyring on Windows/macOS, in-memory elsewhere) -----
//
// Packaged targets are Windows (nsis) + macOS (dmg) only, so the in-memory
// fallback is exercised only by the ubuntu CI test runner — which has no
// Secret Service / D-Bus session. This keeps `cargo test` on Linux from
// touching a real credential store.

#[cfg(any(target_os = "windows", target_os = "macos"))]
mod secret_store {
    use crate::error::AppError;

    const SERVICE: &str = "hermes-agent-cn-desktop.account";

    fn map(e: keyring::Error) -> AppError {
        AppError::Internal(format!("凭证存储错误: {}", e))
    }

    pub fn set(account: &str, secret: &str) -> Result<(), AppError> {
        keyring::Entry::new(SERVICE, account)
            .map_err(map)?
            .set_password(secret)
            .map_err(map)
    }

    pub fn get(account: &str) -> Result<Option<String>, AppError> {
        match keyring::Entry::new(SERVICE, account)
            .map_err(map)?
            .get_password()
        {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(map(e)),
        }
    }

    pub fn delete(account: &str) -> Result<(), AppError> {
        match keyring::Entry::new(SERVICE, account)
            .map_err(map)?
            .delete_credential()
        {
            Ok(()) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(map(e)),
        }
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
mod secret_store {
    use crate::error::AppError;
    use std::collections::HashMap;
    use std::sync::{LazyLock, Mutex};

    static STORE: LazyLock<Mutex<HashMap<String, String>>> =
        LazyLock::new(|| Mutex::new(HashMap::new()));

    pub fn set(account: &str, secret: &str) -> Result<(), AppError> {
        STORE
            .lock()?
            .insert(account.to_string(), secret.to_string());
        Ok(())
    }

    pub fn get(account: &str) -> Result<Option<String>, AppError> {
        Ok(STORE.lock()?.get(account).cloned())
    }

    pub fn delete(account: &str) -> Result<(), AppError> {
        STORE.lock()?.remove(account);
        Ok(())
    }
}

fn stored_key() -> Result<Option<String>, AppError> {
    secret_store::get(&secret_account())
}

/// keyring 条目：记录当前这把 sk- key 属于哪个（服务地址, 用户）。
///
/// 没有归属记录时，换账号登录会直接复用上一个用户的 key —— 这正是
/// 「新用户重新登录后 apikey 没刷新」的成因。
fn key_owner_account() -> String {
    format!("{}-account-key-owner", BRAND_PROVIDER_KEY)
}

fn key_owner_tag(base_url: &str, user_id: i64) -> String {
    format!("{}#{}", normalize_base_url(base_url), user_id)
}

fn store_key_for(session: &SessionState, key: &str) -> Result<(), AppError> {
    secret_store::set(&secret_account(), key)?;
    secret_store::set(
        &key_owner_account(),
        &key_owner_tag(&session.base_url, session.user.id),
    )
}

/// 只在归属匹配时返回已存 key。归属不符（换了账号或换了服务地址）一律当作没有，
/// 迫使调用方为当前用户重新取一把。
fn stored_key_for(session: &SessionState) -> Result<Option<String>, AppError> {
    let Some(key) = stored_key()? else {
        return Ok(None);
    };
    let owner = secret_store::get(&key_owner_account())?;
    let expected = key_owner_tag(&session.base_url, session.user.id);
    match owner {
        Some(tag) if tag == expected => Ok(Some(key)),
        _ => Ok(None),
    }
}

/// 丢弃已存 key 及其归属记录。
fn clear_stored_key() -> Result<(), AppError> {
    secret_store::delete(&secret_account())?;
    secret_store::delete(&key_owner_account())
}

/// 若已存 key 不属于该会话，则清除之。返回 true 表示确实清掉了别人的 key。
fn discard_key_from_another_owner(session: &SessionState) -> Result<bool, AppError> {
    if stored_key()?.is_none() {
        return Ok(false);
    }
    if stored_key_for(session)?.is_some() {
        return Ok(false);
    }
    clear_stored_key()?;
    Ok(true)
}

/// keyring account name under which the login credentials (base url + username
/// and password) are stored as a JSON blob. Separate entry from the sk- key so
/// logout can clear the session key without forgetting the saved login.
fn credentials_account() -> String {
    format!("{}-account-login", BRAND_PROVIDER_KEY)
}

fn session_account() -> String {
    format!("{}-account-session", BRAND_PROVIDER_KEY)
}

/// Persist login credentials in the OS keyring. The password never leaves the
/// secret store after this — it is only read back by `account_login_saved`.
fn store_credentials(base_url: &str, username: &str, password: &str) -> Result<(), AppError> {
    let blob = json!({
        "baseUrl": base_url,
        "username": username,
        "password": password,
    })
    .to_string();
    secret_store::set(&credentials_account(), &blob)
}

/// Read saved credentials, if any. Returns (base_url, username, password).
fn load_credentials() -> Result<Option<(String, String, String)>, AppError> {
    let Some(blob) = secret_store::get(&credentials_account())? else {
        return Ok(None);
    };
    let parsed: Value = serde_json::from_str(&blob)
        .map_err(|e| AppError::Internal(format!("已保存凭据解析失败: {}", e)))?;
    let base_url = parsed
        .get("baseUrl")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let username = parsed
        .get("username")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let password = parsed
        .get("password")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if username.is_empty() || password.is_empty() {
        return Ok(None);
    }
    Ok(Some((base_url, username, password)))
}

fn store_session_state(session: &SessionState) -> Result<(), AppError> {
    let blob = json!({
        "baseUrl": session.base_url,
        "sessionCookie": session.session_cookie,
        "user": session.user,
    })
    .to_string();
    secret_store::set(&session_account(), &blob)
}

fn load_session_state() -> Result<Option<SessionState>, AppError> {
    let Some(blob) = secret_store::get(&session_account())? else {
        return Ok(None);
    };
    let parsed: Value = serde_json::from_str(&blob)
        .map_err(|e| AppError::Internal(format!("已保存会话解析失败: {}", e)))?;
    let base_url = parsed
        .get("baseUrl")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let session_cookie = parsed
        .get("sessionCookie")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let user = parsed
        .get("user")
        .cloned()
        .and_then(|v| serde_json::from_value::<AccountUser>(v).ok());
    if base_url.is_empty() || session_cookie.is_empty() {
        return Ok(None);
    }
    let Some(user) = user else {
        return Ok(None);
    };
    Ok(Some(SessionState {
        base_url,
        session_cookie,
        user,
    }))
}

fn restore_session_from_store() -> Result<Option<SessionState>, AppError> {
    if let Some(session) = SESSION.lock()?.clone() {
        return Ok(Some(session));
    }
    let Some(session) = load_session_state()? else {
        return Ok(None);
    };
    *SESSION.lock()? = Some(session.clone());
    Ok(Some(session))
}

fn data_or_root(value: &Value) -> &Value {
    value
        .get("data")
        .filter(|data| !data.is_null())
        .unwrap_or(value)
}

fn string_field(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        value
            .get(*key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    })
}

fn i64_field(value: &Value, keys: &[&str]) -> Option<i64> {
    keys.iter().find_map(|key| {
        value.get(*key).and_then(|v| {
            v.as_i64()
                .or_else(|| v.as_str()?.trim().parse::<i64>().ok())
        })
    })
}

fn f64_field(value: &Value, keys: &[&str]) -> Option<f64> {
    keys.iter().find_map(|key| {
        value.get(*key).and_then(|v| {
            v.as_f64()
                .or_else(|| v.as_str()?.trim().parse::<f64>().ok())
        })
    })
}

fn bool_field(value: &Value, keys: &[&str]) -> Option<bool> {
    keys.iter().find_map(|key| {
        let raw = value.get(*key)?;
        raw.as_bool().or_else(
            || match raw.as_str()?.trim().to_ascii_lowercase().as_str() {
                "true" | "1" | "yes" => Some(true),
                "false" | "0" | "no" => Some(false),
                _ => None,
            },
        )
    })
}

fn generic_display_name(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "" | "rootuser" | "root user"
    )
}

fn parse_account_user(
    value: &Value,
    fallback_id: Option<i64>,
    fallback_username: &str,
) -> Result<AccountUser, AppError> {
    let data = data_or_root(value);
    let id = i64_field(data, &["id", "user_id", "userId"])
        .or(fallback_id)
        .ok_or_else(|| AppError::ProxyError("登录失败：服务未返回用户信息".to_string()))?;
    let fallback_username = fallback_username.trim();
    let username = string_field(
        data,
        &[
            "username",
            "user_name",
            "userName",
            "email",
            "account",
            "name",
        ],
    )
    .or_else(|| (!fallback_username.is_empty()).then(|| fallback_username.to_string()))
    .unwrap_or_else(|| format!("user-{}", id));
    let display_name = string_field(
        data,
        &[
            "display_name",
            "displayName",
            "nickname",
            "nick_name",
            "name",
        ],
    )
    .filter(|name| !generic_display_name(name))
    .unwrap_or_else(|| username.clone());
    Ok(AccountUser {
        id,
        username,
        display_name,
        role: i64_field(data, &["role"]).unwrap_or(0),
        status: i64_field(data, &["status"]).unwrap_or(0),
        group: string_field(data, &["group", "group_name", "groupName"])
            .unwrap_or_else(|| "default".to_string()),
    })
}

async fn fetch_self_user(session: &SessionState) -> Result<AccountUser, AppError> {
    let (status, body) = account_json(
        reqwest::Method::GET,
        &format!("{}/api/user/self", session.base_url),
        &session.session_cookie,
        session.user.id,
        None,
    )
    .await?;
    if body.get("success").and_then(Value::as_bool) == Some(false) {
        return Err(envelope_error("获取账户信息", status, &body));
    }
    parse_account_user(&body, Some(session.user.id), &session.user.username)
}

async fn refresh_session_user(session: SessionState) -> Result<SessionState, AppError> {
    let mut next = session;
    next.user = fetch_self_user(&next).await?;
    store_session_state(&next)?;
    *SESSION.lock()? = Some(next.clone());
    Ok(next)
}

fn extract_balance_values(self_body: &Value) -> (f64, f64) {
    let data = data_or_root(self_body);
    let quota = f64_field(
        data,
        &[
            "quota",
            "remain_quota",
            "remainQuota",
            "balance",
            "credit",
            "available_quota",
            "availableQuota",
        ],
    )
    .unwrap_or(0.0);
    let used_quota = f64_field(
        data,
        &[
            "used_quota",
            "usedQuota",
            "used",
            "consumed_quota",
            "consumedQuota",
        ],
    )
    .unwrap_or(0.0);
    (quota, used_quota)
}

fn extract_status_settings(status_body: &Value) -> (f64, bool, String) {
    let data = data_or_root(status_body);
    let quota_per_unit = f64_field(data, &["quota_per_unit", "quotaPerUnit"])
        .filter(|v| *v > 0.0)
        .unwrap_or(500000.0);
    let display_in_currency = if string_field(data, &["quota_display_type", "quotaDisplayType"])
        .map(|v| v.eq_ignore_ascii_case("TOKENS"))
        == Some(true)
    {
        false
    } else {
        bool_field(data, &["display_in_currency", "displayInCurrency"]).unwrap_or(true)
    };
    let top_up_link = string_field(
        data,
        &[
            "top_up_link",
            "topUpLink",
            "top_up_url",
            "topUpUrl",
            "recharge_url",
            "rechargeUrl",
        ],
    )
    .unwrap_or_default();
    (quota_per_unit, display_in_currency, top_up_link)
}

// ---- account server calls ----------------------------------------------

/// POST /api/user/login — stores the session cookie + user on success.
async fn do_login(base_url: &str, username: &str, password: &str) -> Result<AccountUser, AppError> {
    let normalized = normalize_base_url(base_url);
    if normalized.is_empty() {
        return Err(AppError::InvalidRequest("服务地址不能为空".to_string()));
    }
    let res = HTTP
        .post(format!("{}/api/user/login", normalized))
        .json(&json!({ "username": username, "password": password }))
        .send()
        .await?;
    let status = res.status().as_u16();
    let set_cookies: Vec<String> = res
        .headers()
        .get_all("set-cookie")
        .iter()
        .filter_map(|v| v.to_str().ok().map(|s| s.to_string()))
        .collect();
    let raw = res.text().await.unwrap_or_default();
    if status == 429 {
        return Err(account_http_error("登录", status, &raw));
    }
    let body: Value =
        serde_json::from_str(&raw).map_err(|_| account_http_error("登录", status, &raw))?;

    if body.get("success").and_then(Value::as_bool) != Some(true) {
        return Err(envelope_error("登录", status, &body));
    }
    let data = data_or_root(&body);
    if data.get("require_2fa").and_then(Value::as_bool) == Some(true) {
        return Err(AppError::InvalidRequest(
            "该账号开启了两步验证，暂不支持".to_string(),
        ));
    }
    let cookie = extract_auth_cookie(&set_cookies)
        .ok_or_else(|| AppError::ProxyError("登录失败：服务未返回会话凭证".to_string()))?;
    let user = parse_account_user(&body, None, username)?;
    let mut session = SessionState {
        base_url: normalized,
        session_cookie: cookie,
        user,
    };
    if let Ok(refreshed_user) = fetch_self_user(&session).await {
        session.user = refreshed_user;
    }
    store_session_state(&session)?;
    *SESSION.lock()? = Some(session.clone());
    Ok(session.user)
}

/// Fetch the model names usable by this account: try GET /api/pricing first
/// (newer newapi), fall back to the legacy flat list.
async fn fetch_models(session: &SessionState) -> Result<AccountModelCatalog, AppError> {
    match fetch_models_pricing(session).await {
        Ok(catalog) if !catalog.models.is_empty() => Ok(catalog),
        Ok(_) => match fetch_models_legacy(session).await {
            Ok(models) if !models.is_empty() => Ok(AccountModelCatalog {
                models,
                endpoint_types: ModelEndpointTypes::new(),
            }),
            Ok(models) => Ok(AccountModelCatalog {
                models,
                endpoint_types: ModelEndpointTypes::new(),
            }),
            Err(e) => Err(e),
        },
        Err(pricing_err) => match fetch_models_legacy(session).await {
            Ok(models) => Ok(AccountModelCatalog {
                models,
                endpoint_types: ModelEndpointTypes::new(),
            }),
            Err(_) => Err(pricing_err),
        },
    }
}

async fn fetch_models_pricing(session: &SessionState) -> Result<AccountModelCatalog, AppError> {
    let (status, body) = account_json(
        reqwest::Method::GET,
        &format!("{}/api/pricing", session.base_url),
        &session.session_cookie,
        session.user.id,
        None,
    )
    .await?;
    // /api/pricing usually omits `success` on success; only an explicit false
    // is an error.
    if body.get("success").and_then(Value::as_bool) == Some(false) {
        return Err(envelope_error("获取模型列表", status, &body));
    }

    let mut usable_groups: HashSet<String> = body
        .get("usable_group")
        .and_then(Value::as_object)
        .map(|m| m.keys().cloned().collect())
        .unwrap_or_default();
    if !session.user.group.is_empty() {
        usable_groups.insert(session.user.group.clone());
    }

    let data = body
        .get("data")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut names: Vec<String> = Vec::new();
    let mut endpoint_types = ModelEndpointTypes::new();
    let mut seen = HashSet::new();
    for entry in data {
        let name = match entry.get("model_name").and_then(Value::as_str) {
            Some(n) if !n.is_empty() => n.to_string(),
            _ => continue,
        };
        let groups = entry.get("enable_groups").and_then(Value::as_array);
        let allowed = match groups {
            Some(g) if !g.is_empty() && !usable_groups.is_empty() => g
                .iter()
                .filter_map(Value::as_str)
                .any(|gr| usable_groups.contains(gr)),
            _ => true, // no group info → don't over-filter
        };
        if allowed && seen.insert(name.clone()) {
            let types = collect_endpoint_types(&entry);
            if !types.is_empty() {
                endpoint_types.insert(name.clone(), types);
            }
            names.push(name);
        }
    }
    Ok(AccountModelCatalog {
        models: names,
        endpoint_types,
    })
}

async fn fetch_models_legacy(session: &SessionState) -> Result<Vec<String>, AppError> {
    let mut last_err: Option<AppError> = None;
    for path in ["/api/user/self/models", "/api/user/models", "/api/models"] {
        match account_json(
            reqwest::Method::GET,
            &format!("{}{}", session.base_url, path),
            &session.session_cookie,
            session.user.id,
            None,
        )
        .await
        {
            Ok((status, body)) => {
                if body.get("success").and_then(Value::as_bool) == Some(false) {
                    last_err = Some(envelope_error("获取模型列表", status, &body));
                    continue;
                }
                let names = collect_model_names(&body);
                if !names.is_empty() {
                    return Ok(names);
                }
            }
            Err(e) => last_err = Some(e),
        }
    }
    Err(last_err.unwrap_or_else(|| AppError::ProxyError("获取模型列表失败".to_string())))
}

/// GET /api/token/?p=0&size=100 — raw token rows (id, name, group, status, key).
#[allow(dead_code)]
async fn fetch_token_items(session: &SessionState) -> Result<Vec<Value>, AppError> {
    let (status, body) = account_json(
        reqwest::Method::GET,
        &format!("{}/api/token/?p=0&size=100", session.base_url),
        &session.session_cookie,
        session.user.id,
        None,
    )
    .await?;
    if body.get("success").and_then(Value::as_bool) != Some(true) {
        return Err(envelope_error("获取令牌列表", status, &body));
    }
    Ok(body
        .get("data")
        .and_then(|d| d.get("items"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default())
}

async fn fetch_token_items_compat(session: &SessionState) -> Result<Vec<Value>, AppError> {
    let mut last_err: Option<AppError> = None;
    let mut saw_success = false;
    for url in [
        format!("{}/api/token/?p=0&size=100", session.base_url),
        format!("{}/api/token?p=0&size=100", session.base_url),
    ] {
        match account_json(
            reqwest::Method::GET,
            &url,
            &session.session_cookie,
            session.user.id,
            None,
        )
        .await
        {
            Ok((status, body)) => {
                if body.get("success").and_then(Value::as_bool) == Some(false) {
                    last_err = Some(envelope_error("token list", status, &body));
                    continue;
                }
                saw_success = true;
                let items = extract_token_items(&body);
                if !items.is_empty() {
                    return Ok(items);
                }
            }
            Err(e) => last_err = Some(e),
        }
    }
    if saw_success {
        return Ok(Vec::new());
    }
    Err(last_err.unwrap_or_else(|| AppError::ProxyError("token list is empty".to_string())))
}

#[allow(dead_code)]
async fn create_token(session: &SessionState) -> Result<(), AppError> {
    let (status, body) = account_json(
        reqwest::Method::POST,
        &format!("{}/api/token/", session.base_url),
        &session.session_cookie,
        session.user.id,
        Some(json!({
            "name": BRAND_APP_NAME,
            "unlimited_quota": true,
            "expired_time": -1,
            "remain_quota": 0,
        })),
    )
    .await?;
    if body.get("success").and_then(Value::as_bool) != Some(true) {
        return Err(envelope_error("创建 API 令牌", status, &body));
    }
    Ok(())
}

async fn create_token_compat(session: &SessionState) -> Result<Option<String>, AppError> {
    let payload = json!({
        "name": BRAND_APP_NAME,
        "unlimited_quota": true,
        "expired_time": -1,
        "remain_quota": 0,
    });
    let mut last_err: Option<AppError> = None;
    for path in ["/api/token/", "/api/token"] {
        match account_json(
            reqwest::Method::POST,
            &format!("{}{}", session.base_url, path),
            &session.session_cookie,
            session.user.id,
            Some(payload.clone()),
        )
        .await
        {
            Ok((status, body)) => {
                if body.get("success").and_then(Value::as_bool) != Some(true) {
                    last_err = Some(envelope_error("create token", status, &body));
                    continue;
                }
                if let Some(key) = extract_full_key(&body) {
                    store_key_for(session, &key)?;
                    return Ok(Some(key));
                }
                return Ok(None);
            }
            Err(e) => last_err = Some(e),
        }
    }
    Err(last_err.unwrap_or_else(|| AppError::ProxyError("create token failed".to_string())))
}

/// Fetch the full key for a token id: POST /api/token/{id}/key, fall back to
/// GET /api/token/{id} (inline key on the detail).
async fn fetch_token_key(session: &SessionState, token_id: i64) -> Result<String, AppError> {
    // 1. dedicated key endpoint
    if let Ok((_, body)) = account_json(
        reqwest::Method::POST,
        &format!("{}/api/token/{}/key", session.base_url, token_id),
        &session.session_cookie,
        session.user.id,
        None,
    )
    .await
    {
        if body.get("success").and_then(Value::as_bool) == Some(true) {
            if let Some(key) = extract_full_key(&body) {
                return Ok(key);
            }
        }
    }
    // 2. token detail
    let (_, body) = account_json(
        reqwest::Method::GET,
        &format!("{}/api/token/{}", session.base_url, token_id),
        &session.session_cookie,
        session.user.id,
        None,
    )
    .await?;
    if body.get("success").and_then(Value::as_bool) == Some(true) {
        if let Some(key) = extract_full_key(&body) {
            return Ok(key);
        }
    }
    Err(AppError::ProxyError(
        "获取令牌密钥失败：服务未提供可用的密钥接口".to_string(),
    ))
}

/// Resolve a usable sk- key, creating a token if needed, and cache it in the
/// OS secret store.
async fn ensure_api_key(session: &SessionState, token_id: Option<i64>) -> Result<String, AppError> {
    if token_id.is_none() {
        // 归属校验不能省：不带归属直接复用已存 key，换账号后新用户就会拿到
        // 上一个用户的 key，表现为「登录了但 api key 还是旧的 / 已失效」。
        if let Some(key) = stored_key_for(session)? {
            if is_full_key(&key) {
                return Ok(key);
            }
        }
    }

    let mut items = fetch_token_items_compat(session).await?;
    let mut picked = pick_token(&items, token_id);
    if picked.is_none() && token_id.is_none() {
        if let Some(key) = create_token_compat(session).await? {
            return Ok(key);
        }
        items = fetch_token_items_compat(session).await?;
        picked = pick_token(&items, None);
    }
    let token = picked.ok_or_else(|| {
        AppError::ProxyError(match token_id {
            Some(id) => format!("未找到指定的 API 令牌 (id {})", id),
            None => "未找到可用的 API 令牌，且自动创建失败".to_string(),
        })
    })?;

    // Newer backends return the full key inline on the row.
    if let Some(k) = token.get("key").and_then(Value::as_str) {
        if is_full_key(k) {
            let key = ensure_sk_prefix(k);
            store_key_for(session, &key)?;
            return Ok(key);
        }
    }
    let id = token
        .get("id")
        .and_then(Value::as_i64)
        .ok_or_else(|| AppError::ProxyError("令牌缺少 id".to_string()))?;
    let key = fetch_token_key(session, id).await?;
    store_key_for(session, &key)?;
    Ok(key)
}

fn pick_token(items: &[Value], token_id: Option<i64>) -> Option<Value> {
    match token_id {
        Some(id) => items
            .iter()
            .find(|t| t.get("id").and_then(Value::as_i64) == Some(id))
            .cloned(),
        None => items
            .iter()
            .filter(|t| t.get("status").and_then(Value::as_i64).unwrap_or(1) == 1)
            .find(|t| {
                t.get("group")
                    .and_then(Value::as_str)
                    .map(|group| group.trim().eq_ignore_ascii_case("default"))
                    .unwrap_or(false)
            })
            .or_else(|| {
                items
                    .iter()
                    .find(|t| t.get("status").and_then(Value::as_i64) == Some(1))
            })
            .or_else(|| items.first())
            .cloned(),
    }
}

// ---- dashboard config I/O ------------------------------------------------

fn dashboard_state(state: &State<'_, AppState>) -> Result<(String, Option<String>), AppError> {
    let inner = state.inner.lock()?;
    Ok((inner.api_base_url.clone(), inner.session_token.clone()))
}

fn apply_auth(mut req: reqwest::RequestBuilder, token: Option<&str>) -> reqwest::RequestBuilder {
    if let Some(t) = token {
        req = req
            .header("Authorization", format!("Bearer {}", t))
            .header("X-Hermes-Session-Token", t);
    }
    req
}

/// GET /api/config from the dashboard, returning the parsed config object.
async fn read_config(api_base: &str, token: Option<&str>) -> Result<Value, AppError> {
    let url = format!("{}/api/config", api_base.trim_end_matches('/'));
    let res = apply_auth(DASHBOARD_HTTP.get(&url), token).send().await?;
    let status = res.status().as_u16();
    let raw = res.text().await.unwrap_or_default();
    if !(200..300).contains(&status) {
        return Err(AppError::ProxyError(format!(
            "读取配置失败 (HTTP {}): {}",
            status,
            snippet(&raw)
        )));
    }
    serde_json::from_str(&raw).map_err(|e| AppError::ProxyError(format!("配置解析失败: {}", e)))
}

/// PUT /api/config with the `{ config }` envelope the dashboard expects.
async fn write_config(api_base: &str, token: Option<&str>, config: &Value) -> Result<(), AppError> {
    let url = format!("{}/api/config", api_base.trim_end_matches('/'));
    let res = apply_auth(DASHBOARD_HTTP.put(&url), token)
        .json(&json!({ "config": config }))
        .send()
        .await?;
    let status = res.status().as_u16();
    if !(200..300).contains(&status) {
        let raw = res.text().await.unwrap_or_default();
        return Err(AppError::ProxyError(format!(
            "保存配置失败 (HTTP {}): {}",
            status,
            snippet(&raw)
        )));
    }
    Ok(())
}

fn existing_provider_model(config: &Value, provider_id: &str) -> Option<String> {
    config
        .get("providers")
        .and_then(|v| v.get(provider_id))
        .and_then(|v| v.get("model"))
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// 已保存的模型集合，供「只换令牌、不改模型选择」的更新复用。
fn existing_provider_models(config: &Value, provider_id: &str) -> Vec<String> {
    config
        .get("providers")
        .and_then(|v| v.get(provider_id))
        .and_then(|v| v.get("models"))
        .and_then(Value::as_object)
        .map(|models| models.keys().cloned().collect())
        .unwrap_or_default()
}

fn choose_primary_model(
    config: &Value,
    provider_id: &str,
    models: &[String],
    requested_primary: Option<&str>,
) -> Option<String> {
    requested_primary
        .filter(|m| models.iter().any(|candidate| candidate == *m))
        .map(str::to_string)
        .or_else(|| models.first().cloned())
        .or_else(|| existing_provider_model(config, provider_id))
}

fn account_provider_for_model(model: &str, endpoint_types: &ModelEndpointTypes) -> String {
    let types = endpoint_types_for_model(endpoint_types, model);
    if model_uses_messages(model, &types) {
        account_messages_provider_id()
    } else {
        account_provider_id()
    }
}

/// 一次账号 provider 写入所需的全部输入。
pub struct AccountProvision<'a> {
    /// OpenAI 兼容端点（带 `/v1`）。
    pub chat_api_base: &'a str,
    /// Anthropic Messages 端点（服务根，SDK 自己补 `/v1/messages`）。
    pub messages_api_base: &'a str,
    /// 本次要写入的模型集合。空表示「只换令牌」，保留已选模型。
    pub models: &'a [String],
    pub model_endpoint_types: &'a ModelEndpointTypes,
    pub primary_model_id: Option<&'a str>,
    pub api_key: &'a str,
    pub token_id: Option<i64>,
}

/// 构造账号 provider 的期望状态。
///
/// 中转站把 OpenAI 兼容模型与 Anthropic Messages 模型混在同一个账号下，而 Core
/// 的 `api_mode` 是 **provider 级**而非模型级的，所以必须拆成两个 provider。
fn account_providers(config: &Value, input: &AccountProvision<'_>) -> Vec<ManagedProvider> {
    let AccountProvision {
        chat_api_base,
        messages_api_base,
        models,
        model_endpoint_types,
        primary_model_id,
        api_key,
        token_id,
    } = *input;

    let chat_provider_id = account_provider_id();
    let messages_provider_id = account_messages_provider_id();
    let selected_models = select_brand_account_models(models);
    let (chat_models, messages_models) =
        split_models_by_endpoint(&selected_models, model_endpoint_types);
    // 只换令牌、不改模型选择时，保留已有 provider 的模型集合。
    let token_only_update = models.is_empty();

    let extra = token_id
        .map(|id| vec![("token_id".to_string(), id.into())])
        .unwrap_or_default();

    let build = |id: String,
                 name: String,
                 api_base: &str,
                 api_mode: ApiMode,
                 model_ids: &[String]|
     -> Option<ManagedProvider> {
        let existing_models = select_brand_account_models(&existing_provider_models(config, &id));
        let effective: Vec<String> = if model_ids.is_empty() && token_only_update {
            existing_models
        } else {
            model_ids.to_vec()
        };
        if effective.is_empty() {
            return None;
        }
        let primary = choose_primary_model(config, &id, &effective, primary_model_id)
            .unwrap_or_else(|| effective[0].clone());
        Some(ManagedProvider {
            id,
            namespace: ManagedNamespace::Account,
            name,
            base_url: api_base.to_string(),
            api_key: api_key.to_string(),
            api_mode,
            model: primary,
            models: effective.iter().map(ManagedModel::new).collect(),
            extra: extra.clone(),
        })
    };

    [
        build(
            chat_provider_id,
            BRAND_APP_NAME.to_string(),
            chat_api_base,
            ApiMode::ChatCompletions,
            &chat_models,
        ),
        build(
            messages_provider_id,
            format!("{} Messages", BRAND_APP_NAME),
            messages_api_base,
            ApiMode::AnthropicMessages,
            &messages_models,
        ),
    ]
    .into_iter()
    .flatten()
    .collect()
}

/// Merge the account providers (and optional primary model) into a config value.
fn merge_account_provider(mut config: Value, input: &AccountProvision<'_>) -> Value {
    // 先清掉旧版账号 provisioning 留下的 `custom:<brand>` 条目。它们带着上一个
    // 登录用户的 api_key，本分支上没有任何代码会刷新——正是「换账号后 key 不
    // 刷新」的成因。
    let _ = migrate_legacy_config_json(&mut config, BRAND_PROVIDER_KEY);

    let providers = account_providers(&config, input);

    // 只接管 Account 命名空间：企业模型与用户自定义模型不归账号管。
    if let Err(error) =
        apply_managed_providers_json(&mut config, &[ManagedNamespace::Account], &providers)
    {
        log::warn!("account provider merge failed: {error}");
        return config;
    }

    if let Some(model_id) = input.primary_model_id.filter(|m| !m.is_empty()) {
        let wanted = account_provider_for_model(model_id, input.model_endpoint_types);
        // 默认模型必须落在真正声明了它的 provider 上，否则 Core 会按错误的
        // api_mode 发请求。
        if let Some(provider) = providers
            .iter()
            .find(|p| p.id == wanted && p.models.iter().any(|m| m.id == model_id))
            .or_else(|| {
                providers
                    .iter()
                    .find(|p| p.models.iter().any(|m| m.id == model_id))
            })
        {
            if let Err(error) = set_default_model_json(&mut config, provider, model_id) {
                log::warn!("account default model write failed: {error}");
            }
        }
    }
    config
}

/// 登录后把账号 provider 的凭证刷新到当前用户。
///
/// 这是「换账号后 apikey 不刷新」的正面修复：登录本身必须重新铸 key 并把它写回
/// 已有的账号 provider，而不是等用户下次手动保存模型选择。models 传空即「只换
/// 令牌」，会保留用户已选的模型集合。
///
/// 尽力而为：拿不到 key 或写配置失败都不该让登录整体失败——登录态本身是有效的。
async fn refresh_account_credentials(state: &State<'_, AppState>, session: &SessionState) {
    let api_base = account_api_base(&session.base_url);
    if api_base.is_empty() {
        return;
    }
    let key = match ensure_api_key(session, None).await {
        Ok(key) => key,
        Err(error) => {
            log::warn!("account login: could not mint an API key: {error}");
            return;
        }
    };
    let Ok((dash_base, token)) = dashboard_state(state) else {
        return;
    };
    let config = match read_config(&dash_base, token.as_deref()).await {
        Ok(config) if config.is_object() => config,
        Ok(_) => return,
        Err(error) => {
            log::warn!("account login: could not read runtime config: {error}");
            return;
        }
    };
    let merged = merge_account_provider(
        config,
        &AccountProvision {
            chat_api_base: &api_base,
            messages_api_base: &account_messages_base(&session.base_url),
            models: &[],
            model_endpoint_types: &ModelEndpointTypes::new(),
            primary_model_id: None,
            api_key: &key,
            token_id: None,
        },
    );
    if let Err(error) = write_config(&dash_base, token.as_deref(), &merged).await {
        log::warn!("account login: could not refresh provider credentials: {error}");
    }
}

// ---- commands -----------------------------------------------------------

#[tauri::command]
pub async fn account_login(
    input: LoginInput,
    state: State<'_, AppState>,
) -> Result<AccountUser, AppError> {
    let user = do_login(&input.base_url, &input.username, &input.password).await?;
    let session = require_session()?;
    // 换了账号（或换了服务地址）就丢掉上一个用户的 key，别让它被复用。
    match discard_key_from_another_owner(&session) {
        Ok(true) => {
            log::info!("account login: discarded an API key owned by a different account");
            clear_account_providers(&state).await?;
        }
        Ok(false) => {}
        Err(error) => log::warn!("account login: could not clear the previous key: {error}"),
    }
    refresh_account_credentials(&state, &session).await;
    Ok(user)
}

#[tauri::command]
pub async fn account_status() -> Result<StatusResult, AppError> {
    let session = match restore_session_from_store()? {
        Some(session) => Some(
            refresh_session_user(session.clone())
                .await
                .unwrap_or(session),
        ),
        None => None,
    };
    let key = stored_key()?;
    Ok(match session {
        Some(s) => StatusResult {
            logged_in: true,
            user: Some(s.user.clone()),
            server_url: Some(s.base_url.clone()),
            has_key: key.is_some(),
            masked_key: key.as_deref().map(mask_key),
        },
        None => StatusResult {
            logged_in: false,
            user: None,
            server_url: None,
            has_key: key.is_some(),
            masked_key: key.as_deref().map(mask_key),
        },
    })
}

/// Fetch usable models + ensure an sk- key (cached in the secret store). The
/// key itself is never returned — only a masked preview.
#[tauri::command]
pub async fn account_fetch_setup() -> Result<SetupResult, AppError> {
    let session = require_session()?;
    let catalog = select_brand_account_catalog(fetch_models(&session).await?);
    let key = stored_key()?;
    Ok(SetupResult {
        user: session.user.clone(),
        base_url: session.base_url.clone(),
        models: catalog.models,
        model_endpoint_types: catalog.endpoint_types,
        has_key: key.is_some(),
        masked_key: key.as_deref().map(mask_key),
    })
}

#[tauri::command]
pub async fn account_list_tokens() -> Result<Vec<AccountToken>, AppError> {
    let session = require_session()?;
    let items = fetch_token_items_compat(&session).await?;
    Ok(items
        .iter()
        .map(|t| {
            let id = t.get("id").and_then(Value::as_i64).unwrap_or(0);
            AccountToken {
                id,
                name: t
                    .get("name")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
                    .unwrap_or_else(|| format!("令牌 #{}", id)),
                group: t
                    .get("group")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                status: t.get("status").and_then(Value::as_i64).unwrap_or(0),
            }
        })
        .collect())
}

#[tauri::command]
pub async fn account_balance() -> Result<AccountBalance, AppError> {
    let session = require_session()?;
    let (_, self_body) = account_json(
        reqwest::Method::GET,
        &format!("{}/api/user/self", session.base_url),
        &session.session_cookie,
        session.user.id,
        None,
    )
    .await?;
    let (quota, used_quota) = extract_balance_values(&self_body);

    let (_, status_body) = account_json(
        reqwest::Method::GET,
        &format!("{}/api/status", session.base_url),
        &session.session_cookie,
        session.user.id,
        None,
    )
    .await?;
    let (quota_per_unit, display_in_currency, top_up_link) = extract_status_settings(&status_body);

    let base = session.base_url.trim_end_matches('/');
    let top_up_url = if top_up_link.is_empty() {
        format!("{}/topup", base)
    } else if top_up_link.starts_with("http://") || top_up_link.starts_with("https://") {
        top_up_link.to_string()
    } else {
        format!("{}/{}", base, top_up_link.trim_start_matches('/'))
    };

    Ok(AccountBalance {
        quota,
        used_quota,
        quota_per_unit,
        display_in_currency,
        top_up_url,
    })
}

/// Write the selected models into the runtime config as the account provider.
/// The sk- key is injected here (server-side) and never crosses to the
/// frontend.
#[tauri::command]
pub async fn account_save_models(
    input: SaveModelsInput,
    state: State<'_, AppState>,
) -> Result<StatusResult, AppError> {
    if input.models.is_empty() && input.token_id.is_none() {
        return Err(AppError::InvalidRequest("未选择任何模型或令牌".to_string()));
    }
    let selected_models = select_brand_account_models(&input.models);
    if !input.models.is_empty() && selected_models.is_empty() {
        return Err(AppError::InvalidRequest(
            "No model from the active brand allowlist was selected".to_string(),
        ));
    }
    let primary_model_id = input
        .primary_model_id
        .as_deref()
        .filter(|model| selected_models.iter().any(|selected| selected == model));
    let session = require_session()?;
    let api_base = account_api_base(&session.base_url);
    let messages_base = account_messages_base(&session.base_url);
    if api_base.is_empty() {
        return Err(AppError::InvalidRequest(
            "缺少服务地址，请重新登录账户".to_string(),
        ));
    }
    let key = ensure_api_key(&session, input.token_id).await?;

    let (dash_base, token) = dashboard_state(&state)?;
    let config = read_config(&dash_base, token.as_deref()).await?;
    if !config.is_object() {
        return Err(AppError::ProxyError(
            "配置格式异常，应为 JSON 对象".to_string(),
        ));
    }
    let merged = merge_account_provider(
        config,
        &AccountProvision {
            chat_api_base: &api_base,
            messages_api_base: &messages_base,
            models: &selected_models,
            model_endpoint_types: &input.model_endpoint_types,
            primary_model_id,
            api_key: &key,
            token_id: input.token_id,
        },
    );
    write_config(&dash_base, token.as_deref(), &merged).await?;

    account_status().await
}

#[tauri::command]
pub async fn account_test_model(model_id: String) -> Result<TestModelResult, AppError> {
    if !is_brand_account_model(&model_id) {
        return Err(AppError::InvalidRequest(
            "Model is outside the active brand allowlist".to_string(),
        ));
    }
    let session = require_session()?;
    let api_base = account_api_base(&session.base_url);
    let key = match stored_key()? {
        Some(k) => k,
        None => ensure_api_key(&session, None).await?,
    };
    let endpoint_types = fetch_models(&session)
        .await
        .map(|catalog| catalog.endpoint_types)
        .unwrap_or_default();
    let types = endpoint_types_for_model(&endpoint_types, &model_id);
    let use_messages = model_uses_messages(&model_id, &types);
    let started = std::time::Instant::now();
    let mut req = if use_messages {
        HTTP.post(format!("{}/messages", api_base))
            .header("x-api-key", &key)
            .header("anthropic-version", "2023-06-01")
            .json(&json!({
                "model": model_id,
                "messages": [{ "role": "user", "content": "ping" }],
                "max_tokens": 1,
                "stream": false,
            }))
    } else {
        HTTP.post(format!("{}/chat/completions", api_base))
            .bearer_auth(&key)
            .json(&json!({
                "model": model_id,
                "messages": [{ "role": "user", "content": "ping" }],
                "max_tokens": 1,
                "stream": false,
            }))
    };
    req = req.header("Accept", "application/json");
    let res = req.send().await?;
    let status = res.status().as_u16();
    let raw = res.text().await.unwrap_or_default();
    if !(200..300).contains(&status) {
        return Ok(TestModelResult {
            ok: false,
            latency_ms: None,
            reply: None,
            error: Some(format!("HTTP {}: {}", status, snippet(&raw))),
        });
    }
    let latency = started.elapsed().as_millis() as u64;
    let reply = serde_json::from_str::<Value>(&raw).ok().and_then(|v| {
        if use_messages {
            v.get("content")
                .and_then(Value::as_array)
                .and_then(|items| {
                    items.iter().find_map(|item| {
                        item.get("text").and_then(Value::as_str).map(str::to_string)
                    })
                })
        } else {
            v.get("choices")
                .and_then(|c| c.get(0))
                .and_then(|c| c.get("message"))
                .and_then(|m| m.get("content"))
                .and_then(Value::as_str)
                .map(str::to_string)
        }
    });
    Ok(TestModelResult {
        ok: true,
        latency_ms: Some(latency),
        reply,
        error: None,
    })
}

#[tauri::command]
pub async fn account_save_credentials(input: LoginInput) -> Result<(), AppError> {
    store_credentials(&input.base_url, &input.username, &input.password)
}

/// Report whether login credentials are saved, returning the username + base
/// url for prefilling the login form. The password is never returned.
#[tauri::command]
pub async fn account_has_saved_credentials() -> Result<SavedCredentialsInfo, AppError> {
    match load_credentials()? {
        Some((base_url, username, _password)) => Ok(SavedCredentialsInfo {
            has_saved: true,
            username: Some(username),
            base_url: if base_url.is_empty() {
                None
            } else {
                Some(base_url)
            },
        }),
        None => Ok(SavedCredentialsInfo {
            has_saved: false,
            username: None,
            base_url: None,
        }),
    }
}

/// Log in using credentials read from the OS keyring, so the password never
/// crosses the IPC boundary. Errors if nothing is saved.
#[tauri::command]
pub async fn account_login_saved(state: State<'_, AppState>) -> Result<AccountUser, AppError> {
    let (base_url, username, password) = load_credentials()?
        .ok_or_else(|| AppError::InvalidRequest("没有已保存的登录凭据".to_string()))?;
    // 与交互式登录同一条路径：自动登录同样要刷新凭证，否则开机自动登录的用户
    // 永远拿不到新 key。
    account_login(
        LoginInput {
            base_url,
            username,
            password,
        },
        state,
    )
    .await
}

#[tauri::command]
pub async fn account_clear_credentials() -> Result<(), AppError> {
    secret_store::delete(&credentials_account())
}

#[tauri::command]
pub async fn account_logout(state: State<'_, AppState>) -> Result<StatusResult, AppError> {
    *SESSION.lock()? = None;
    secret_store::delete(&session_account())?;
    // key 与它的归属记录必须一起清，否则残留的归属会让下一个登录用户被误判为
    // 「同一个人」而复用一把已经不存在的 key。
    clear_stored_key()?;
    clear_account_providers(&state).await?;
    account_status().await
}

async fn clear_account_providers(state: &State<'_, AppState>) -> Result<(), AppError> {
    let (dash_base, token) = dashboard_state(state)?;
    let mut config = read_config(&dash_base, token.as_deref()).await?;
    apply_managed_providers_json(&mut config, &[ManagedNamespace::Account], &[])
        .map_err(AppError::ProxyError)?;
    clear_default_model_if_managed_json(&mut config, &[ManagedNamespace::Account])
        .map_err(AppError::ProxyError)?;
    write_config(&dash_base, token.as_deref(), &config).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    #[test]
    fn account_api_base_appends_v1() {
        assert_eq!(
            account_api_base("https://api.huanxing.ai/"),
            "https://api.huanxing.ai/v1"
        );
        assert_eq!(
            account_api_base("https://api.huanxing.ai"),
            "https://api.huanxing.ai/v1"
        );
        assert_eq!(account_api_base("https://x.ai/v1"), "https://x.ai/v1");
        assert_eq!(account_api_base("https://x.ai/v2/"), "https://x.ai/v2");
        assert_eq!(account_api_base(""), "");
    }

    #[test]
    fn account_messages_base_strips_version_suffix() {
        assert_eq!(
            account_messages_base("https://api.huanxing.ai/"),
            "https://api.huanxing.ai"
        );
        assert_eq!(
            account_messages_base("https://api.huanxing.ai/v1"),
            "https://api.huanxing.ai"
        );
        assert_eq!(
            account_messages_base("https://api.example.com/relay/v2/"),
            "https://api.example.com/relay"
        );
        assert_eq!(
            account_messages_base("https://api.example.com/anthropic"),
            "https://api.example.com/anthropic"
        );
    }

    #[test]
    fn mask_key_keeps_prefix_and_tail() {
        assert_eq!(mask_key("sk-abcdefabcdef1234"), "sk-****1234");
        assert_eq!(mask_key("short"), "****");
    }

    #[serial_test::serial]
    #[test]
    fn credentials_round_trip_and_clear() {
        // Uses the in-memory secret_store backend on Linux CI.
        secret_store::delete(&credentials_account()).unwrap();
        assert!(load_credentials().unwrap().is_none());

        store_credentials("https://api.example.com/", "alice", "pw-secret").unwrap();
        let (base, user, pass) = load_credentials().unwrap().expect("saved");
        assert_eq!(base, "https://api.example.com/");
        assert_eq!(user, "alice");
        assert_eq!(pass, "pw-secret");

        secret_store::delete(&credentials_account()).unwrap();
        assert!(load_credentials().unwrap().is_none());
    }

    fn test_session(base_url: &str, user_id: i64) -> SessionState {
        SessionState {
            base_url: base_url.to_string(),
            session_cookie: "session=x".to_string(),
            user: AccountUser {
                id: user_id,
                username: format!("user{user_id}"),
                display_name: String::new(),
                role: 1,
                status: 1,
                group: "default".to_string(),
            },
        }
    }

    #[serial_test::serial]
    #[test]
    fn stored_key_is_scoped_to_the_account_that_minted_it() {
        // 回归 R1：没有归属校验时，换账号登录会直接复用上一个用户的 key，
        // 表现为「新用户登录后 apikey 没刷新 / 一直失效」。
        clear_stored_key().unwrap();
        let alice = test_session("https://api.example.com", 1);
        let bob = test_session("https://api.example.com", 2);

        store_key_for(&alice, "sk-alice-key").unwrap();
        assert_eq!(
            stored_key_for(&alice).unwrap().as_deref(),
            Some("sk-alice-key")
        );
        // Bob 登录时绝不能拿到 Alice 的 key。
        assert!(stored_key_for(&bob).unwrap().is_none());

        clear_stored_key().unwrap();
    }

    #[serial_test::serial]
    #[test]
    fn stored_key_is_scoped_to_the_service_url_too() {
        clear_stored_key().unwrap();
        let here = test_session("https://api.example.com", 1);
        let elsewhere = test_session("https://other.example.com", 1);

        store_key_for(&here, "sk-here").unwrap();
        // 同一个 user id 在不同中转站上是不同的账号。
        assert!(stored_key_for(&elsewhere).unwrap().is_none());

        clear_stored_key().unwrap();
    }

    #[serial_test::serial]
    #[test]
    fn switching_accounts_discards_the_previous_owners_key() {
        clear_stored_key().unwrap();
        let alice = test_session("https://api.example.com", 1);
        let bob = test_session("https://api.example.com", 2);

        store_key_for(&alice, "sk-alice-key").unwrap();
        assert!(discard_key_from_another_owner(&bob).unwrap());
        assert!(stored_key().unwrap().is_none());

        // 同一个人重新登录则应保留 key，不必重铸。
        store_key_for(&bob, "sk-bob-key").unwrap();
        assert!(!discard_key_from_another_owner(&bob).unwrap());
        assert_eq!(stored_key().unwrap().as_deref(), Some("sk-bob-key"));

        clear_stored_key().unwrap();
    }

    #[serial_test::serial]
    #[test]
    fn a_key_without_an_owner_record_is_not_trusted() {
        // 旧版本留下的无归属 key（升级场景）必须被当作陌生 key。
        clear_stored_key().unwrap();
        secret_store::set(&secret_account(), "sk-legacy-unowned").unwrap();

        let session = test_session("https://api.example.com", 1);
        assert!(stored_key_for(&session).unwrap().is_none());
        assert!(discard_key_from_another_owner(&session).unwrap());

        clear_stored_key().unwrap();
    }

    #[serial_test::serial]
    #[test]
    fn logout_clears_both_the_key_and_its_owner_record() {
        clear_stored_key().unwrap();
        let session = test_session("https://api.example.com", 1);
        store_key_for(&session, "sk-key").unwrap();

        clear_stored_key().unwrap();

        assert!(stored_key().unwrap().is_none());
        // 归属记录不能残留，否则下一个用户会被误判成同一个人。
        assert!(secret_store::get(&key_owner_account()).unwrap().is_none());
    }

    #[serial_test::serial]
    #[test]
    fn load_credentials_ignores_blank_username_or_password() {
        secret_store::set(
            &credentials_account(),
            r#"{"baseUrl":"x","username":"","password":"p"}"#,
        )
        .unwrap();
        assert!(load_credentials().unwrap().is_none());
        secret_store::delete(&credentials_account()).unwrap();
    }

    #[test]
    fn ensure_sk_prefix_is_idempotent() {
        assert_eq!(ensure_sk_prefix("sk-abc"), "sk-abc");
        assert_eq!(ensure_sk_prefix("abc"), "sk-abc");
        assert_eq!(ensure_sk_prefix("  def "), "sk-def");
    }

    #[test]
    fn is_full_key_rejects_masked() {
        assert!(is_full_key("sk-abcdef123456"));
        assert!(!is_full_key("sk-abc...xyz"));
        assert!(!is_full_key("sk-abc****"));
        assert!(!is_full_key(""));
    }

    #[test]
    fn extract_session_cookie_finds_session_pair() {
        let cookies = vec![
            "other=1; Path=/".to_string(),
            "session=abc123; HttpOnly; Path=/".to_string(),
        ];
        assert_eq!(
            extract_session_cookie(&cookies),
            Some("session=abc123".to_string())
        );
        assert_eq!(
            extract_session_cookie(&["nope=1; Path=/".to_string()]),
            Some("nope=1".to_string())
        );
    }

    #[test]
    fn extract_auth_cookie_preserves_multiple_cookie_pairs() {
        let cookies = vec![
            "csrf=abc; Path=/".to_string(),
            "one-api-session=def; HttpOnly; Path=/".to_string(),
        ];
        assert_eq!(
            extract_auth_cookie(&cookies),
            Some("csrf=abc; one-api-session=def".to_string())
        );
    }

    #[test]
    fn collect_model_names_supports_legacy_shapes() {
        assert_eq!(
            collect_model_names(&json!({ "success": true, "data": ["a", "b"] })),
            vec!["a".to_string(), "b".to_string()]
        );
        assert_eq!(
            collect_model_names(&json!({
                "data": [
                    { "name": "endpoint", "models": [{ "model_name": "m1" }, { "id": "m2" }] }
                ]
            })),
            vec!["m1".to_string(), "m2".to_string()]
        );
    }

    #[test]
    fn collect_endpoint_types_supports_newapi_pricing_shapes() {
        assert_eq!(
            collect_endpoint_types(&json!({
                "model_name": "claude-y",
                "supported_endpoint_types": ["anthropic", "openai"]
            })),
            vec!["anthropic".to_string(), "openai".to_string()]
        );
        assert_eq!(
            collect_endpoint_types(&json!({
                "model_name": "x",
                "endpointTypes": "openai, anthropic"
            })),
            vec!["openai".to_string(), "anthropic".to_string()]
        );
    }

    #[test]
    fn split_models_by_endpoint_uses_metadata_before_name_fallback() {
        let endpoint_types = ModelEndpointTypes::from([
            ("gpt-x".to_string(), vec!["openai".to_string()]),
            ("claude-y".to_string(), vec!["anthropic".to_string()]),
            (
                "claude-messages-first".to_string(),
                vec!["anthropic".to_string(), "openai".to_string()],
            ),
            ("claude-openai".to_string(), vec!["openai".to_string()]),
            (
                "claude-chat-first".to_string(),
                vec!["openai".to_string(), "anthropic".to_string()],
            ),
        ]);
        let (chat, messages) = split_models_by_endpoint(
            &[
                "gpt-x".to_string(),
                "claude-y".to_string(),
                "claude-messages-first".to_string(),
                "claude-openai".to_string(),
                "claude-chat-first".to_string(),
                "claude-legacy".to_string(),
            ],
            &endpoint_types,
        );
        assert_eq!(
            chat,
            vec![
                "gpt-x".to_string(),
                "claude-openai".to_string(),
                "claude-chat-first".to_string()
            ]
        );
        assert_eq!(
            messages,
            vec![
                "claude-y".to_string(),
                "claude-messages-first".to_string(),
                "claude-legacy".to_string()
            ]
        );
    }

    #[test]
    fn extract_token_items_supports_legacy_shapes() {
        assert_eq!(
            extract_token_items(&json!({ "data": { "items": [{ "id": 1 }] } })).len(),
            1
        );
        assert_eq!(
            extract_token_items(&json!({ "data": [{ "id": 2 }] })).len(),
            1
        );
        assert_eq!(
            extract_token_items(&json!({ "items": [{ "id": 3 }] })).len(),
            1
        );
    }

    #[test]
    fn extract_full_key_supports_legacy_shapes() {
        assert_eq!(
            extract_full_key(&json!({ "data": "abc123" })),
            Some("sk-abc123".to_string())
        );
        assert_eq!(
            extract_full_key(&json!({ "data": { "token": "sk-token123" } })),
            Some("sk-token123".to_string())
        );
        assert_eq!(
            extract_full_key(&json!({ "key": "top123" })),
            Some("sk-top123".to_string())
        );
        assert_eq!(extract_full_key(&json!({ "data": "sk-abc***xyz" })), None);
    }

    #[test]
    fn pick_token_prefers_active_default_group() {
        let items = vec![
            json!({ "id": 1, "name": "first", "group": "", "status": 1 }),
            json!({ "id": 2, "name": "disabled default", "group": "default", "status": 2 }),
            json!({ "id": 3, "name": "default", "group": "default", "status": 1 }),
        ];

        assert_eq!(
            pick_token(&items, None).and_then(|token| token.get("id").and_then(Value::as_i64)),
            Some(3)
        );
        assert_eq!(
            pick_token(&items, Some(1)).and_then(|token| token.get("id").and_then(Value::as_i64)),
            Some(1)
        );
    }

    #[test]
    fn parse_account_user_ignores_rootuser_display_name() {
        let user = parse_account_user(
            &json!({
                "data": {
                    "id": 7,
                    "username": "alice",
                    "display_name": "RootUser",
                    "group": "vip"
                }
            }),
            None,
            "fallback",
        )
        .unwrap();
        assert_eq!(user.username, "alice");
        assert_eq!(user.display_name, "alice");
        assert_eq!(user.group, "vip");
    }

    #[test]
    fn parse_account_user_supports_top_level_and_camel_case() {
        let user = parse_account_user(
            &json!({
                "id": "8",
                "userName": "bob",
                "displayName": "Bob",
                "groupName": "default"
            }),
            None,
            "",
        )
        .unwrap();
        assert_eq!(user.id, 8);
        assert_eq!(user.username, "bob");
        assert_eq!(user.display_name, "Bob");
        assert_eq!(user.group, "default");
    }

    #[test]
    fn extract_balance_values_supports_legacy_and_new_shapes() {
        assert_eq!(
            extract_balance_values(&json!({ "data": { "quota": 1200, "used_quota": 300 } })),
            (1200.0, 300.0)
        );
        assert_eq!(
            extract_balance_values(&json!({ "remainQuota": "900.5", "usedQuota": "10" })),
            (900.5, 10.0)
        );
    }

    #[test]
    fn extract_status_settings_supports_status_variants() {
        assert_eq!(
            extract_status_settings(&json!({
                "data": {
                    "quota_per_unit": 1000,
                    "display_in_currency": false,
                    "top_up_link": "/recharge"
                }
            })),
            (1000.0, false, "/recharge".to_string())
        );
        assert_eq!(
            extract_status_settings(&json!({
                "quotaPerUnit": "2000",
                "quotaDisplayType": "TOKENS",
                "topUpUrl": "https://example.com/topup"
            })),
            (2000.0, false, "https://example.com/topup".to_string())
        );
    }

    #[test]
    fn merge_account_provider_writes_custom_entry() {
        let chat_model = BRAND_ACCOUNT_DEFAULT_MODELS[0];
        let messages_model = BRAND_ACCOUNT_DEFAULT_MODELS[BRAND_ACCOUNT_DEFAULT_MODELS.len() - 1];
        let config = json!({ "providers": {} });
        let merged = merge_account_provider(
            config,
            &AccountProvision {
                chat_api_base: "https://api.huanxing.ai/v1",
                messages_api_base: "https://api.huanxing.ai",
                models: &[chat_model.to_string(), messages_model.to_string()],
                model_endpoint_types: &ModelEndpointTypes::from([
                    (chat_model.to_string(), vec!["openai".to_string()]),
                    (messages_model.to_string(), vec!["anthropic".to_string()]),
                ]),
                primary_model_id: Some(chat_model),
                api_key: "sk-secret",
                token_id: Some(42),
            },
        );
        let id = account_provider_id();
        let entry = &merged["providers"][&id];
        assert_eq!(entry["base_url"], "https://api.huanxing.ai/v1");
        assert_eq!(entry["api_mode"], "chat_completions");
        assert_eq!(entry["transport"], "openai_chat");
        assert_eq!(entry["discover_models"], false);
        assert_eq!(entry["model"], chat_model);
        assert_eq!(entry["api_key"], "sk-secret");
        assert_eq!(entry["token_id"], 42);
        assert!(entry["models"][chat_model].is_object());
        assert!(entry["models"].get(messages_model).is_none());
        let messages_id = account_messages_provider_id();
        let messages_entry = &merged["providers"][&messages_id];
        assert_eq!(messages_entry["base_url"], "https://api.huanxing.ai");
        assert_eq!(messages_entry["api_mode"], "anthropic_messages");
        assert_eq!(messages_entry["transport"], "anthropic_messages");
        assert_eq!(messages_entry["model"], messages_model);
        assert_eq!(messages_entry["api_key"], "sk-secret");
        assert_eq!(messages_entry["token_id"], 42);
        assert!(messages_entry["models"][messages_model].is_object());
        // primary model also written to config.model
        assert_eq!(merged["model"]["provider"], id);
        assert_eq!(merged["model"]["default"], chat_model);
        // `model.model` 只是 Core 在缺 `default` 时的兜底别名。既然恒写
        // `default`，就不要再写第二份可能与之漂移的副本。
        assert!(merged["model"].get("model").is_none());
        // 默认模型必须带上 provider 的 base_url / api_mode，否则 Core 会
        // 按 URL 重新猜协议。
        assert_eq!(merged["model"]["base_url"], "https://api.huanxing.ai/v1");
        assert_eq!(merged["model"]["api_mode"], "chat_completions");
    }

    #[test]
    fn merge_account_provider_sets_messages_primary_provider() {
        let messages_model = BRAND_ACCOUNT_DEFAULT_MODELS[BRAND_ACCOUNT_DEFAULT_MODELS.len() - 1];
        let merged = merge_account_provider(
            json!({ "providers": {} }),
            &AccountProvision {
                chat_api_base: "https://api.huanxing.ai/v1",
                messages_api_base: "https://api.huanxing.ai",
                models: &[messages_model.to_string()],
                model_endpoint_types: &ModelEndpointTypes::from([(
                    messages_model.to_string(),
                    vec!["anthropic".to_string()],
                )]),
                primary_model_id: Some(messages_model),
                api_key: "sk-secret",
                token_id: None,
            },
        );
        let chat_id = account_provider_id();
        let messages_id = account_messages_provider_id();
        assert!(merged["providers"].get(&chat_id).is_none());
        assert!(merged["providers"][&messages_id]["models"][messages_model].is_object());
        assert_eq!(merged["model"]["provider"], messages_id);
    }

    #[test]
    fn merge_account_provider_defaults_primary_to_first_model() {
        let first = BRAND_ACCOUNT_DEFAULT_MODELS[0];
        let second = BRAND_ACCOUNT_DEFAULT_MODELS[1];
        let merged = merge_account_provider(
            json!({}),
            &AccountProvision {
                chat_api_base: "https://x/v1",
                messages_api_base: "https://x",
                models: &[first.to_string(), second.to_string()],
                model_endpoint_types: &ModelEndpointTypes::new(),
                primary_model_id: None,
                api_key: "sk-k",
                token_id: None,
            },
        );
        let id = account_provider_id();
        assert_eq!(merged["providers"][&id]["model"], first);
        // no primary_model_id → config.model is not overwritten
        assert!(merged.get("model").is_none());
    }

    #[test]
    fn merge_account_provider_token_only_preserves_models() {
        let id = account_provider_id();
        let messages_id = account_messages_provider_id();
        let chat_model = BRAND_ACCOUNT_DEFAULT_MODELS[0];
        let messages_model = BRAND_ACCOUNT_DEFAULT_MODELS[BRAND_ACCOUNT_DEFAULT_MODELS.len() - 1];
        let merged = merge_account_provider(
            json!({
                "providers": {
                    id.clone(): {
                        "model": chat_model,
                        "models": {
                            chat_model: {},
                            "server-only-model": {}
                        }
                    },
                    messages_id.clone(): {
                        "model": messages_model,
                        "models": {
                            messages_model: {},
                            "server-only-claude": {}
                        }
                    }
                }
            }),
            &AccountProvision {
                chat_api_base: "https://x/v1",
                messages_api_base: "https://x",
                models: &[],
                model_endpoint_types: &ModelEndpointTypes::new(),
                primary_model_id: None,
                api_key: "sk-new",
                token_id: Some(7),
            },
        );
        let entry = &merged["providers"][&id];
        assert_eq!(entry["model"], chat_model);
        assert!(entry["models"][chat_model].is_object());
        assert!(entry["models"].get("server-only-model").is_none());
        assert_eq!(entry["api_key"], "sk-new");
        assert_eq!(entry["token_id"], 7);
        let messages_entry = &merged["providers"][&messages_id];
        assert_eq!(messages_entry["model"], messages_model);
        assert!(messages_entry["models"][messages_model].is_object());
        assert!(messages_entry["models"].get("server-only-claude").is_none());
        assert_eq!(messages_entry["api_key"], "sk-new");
        assert_eq!(messages_entry["token_id"], 7);
    }

    #[test]
    fn merge_account_provider_token_only_does_not_create_missing_messages_provider() {
        let id = account_provider_id();
        let messages_id = account_messages_provider_id();
        let chat_model = BRAND_ACCOUNT_DEFAULT_MODELS[0];
        let merged = merge_account_provider(
            json!({
                "providers": {
                    id.clone(): {
                        "model": chat_model,
                        "models": {
                            chat_model: {}
                        }
                    }
                }
            }),
            &AccountProvision {
                chat_api_base: "https://x/v1",
                messages_api_base: "https://x",
                models: &[],
                model_endpoint_types: &ModelEndpointTypes::new(),
                primary_model_id: None,
                api_key: "sk-new",
                token_id: Some(7),
            },
        );
        let entry = &merged["providers"][&id];
        assert_eq!(entry["model"], chat_model);
        assert!(entry["models"][chat_model].is_object());
        assert_eq!(entry["api_key"], "sk-new");
        assert_eq!(entry["token_id"], 7);
        assert!(merged["providers"].get(&messages_id).is_none());
    }
}
