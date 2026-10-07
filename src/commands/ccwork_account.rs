//! ccwork JWT account adapter. All credentials remain in Rust/keyring. Core
//! receives only a process-local relay credential; inference uses ccwork billing.
use std::collections::BTreeMap;
use std::sync::LazyLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::State;
use tokio::sync::Mutex;

use super::account::{
    self, AccountBalance, AccountUser, AccountUserId, LoginInput, SaveModelsInput, SetupResult,
    StatusResult, TestModelResult,
};
use crate::brand_generated::{
    BRAND_ACCOUNT_BACKEND, BRAND_APP_NAME, BRAND_PROVIDER_KEY, BRAND_RECHARGE_URL,
    BRAND_SERVICE_URL,
};
use crate::error::AppError;
use crate::model_registry::{
    apply_managed_providers_json, managed_provider_id, set_default_model_json, ApiMode,
    ManagedModel, ManagedNamespace, ManagedProvider,
};
use crate::state::AppState;

#[path = "ccwork_relay.rs"]
mod relay;

static HTTP: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("ccwork HTTP client")
});
static SESSION: Mutex<Option<Session>> = Mutex::const_new(None);
static ACCOUNT_CHANGE: Mutex<()> = Mutex::const_new(());

#[derive(Clone, Serialize, Deserialize)]
struct Session {
    base_url: String,
    access_token: String,
    refresh_token: String,
    expires_at: u64,
    user: AccountUser,
    organization_id: String,
}

pub fn enabled() -> bool {
    BRAND_ACCOUNT_BACKEND == "ccwork"
}
fn store_name() -> String {
    format!("{BRAND_PROVIDER_KEY}-jwt-session")
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
fn missing() -> AppError {
    AppError::InvalidRequest("请登录 ccwork 账号".into())
}

fn api_base(base: &str) -> Result<String, AppError> {
    let url = url::Url::parse(base.trim())
        .map_err(|_| AppError::InvalidRequest("ccwork 服务地址无效".into()))?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(AppError::InvalidRequest(
            "ccwork 服务地址不能包含凭证或查询参数".into(),
        ));
    }
    let is_loopback = matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"));
    if url.scheme() != "https" && !(url.scheme() == "http" && is_loopback) {
        return Err(AppError::InvalidRequest("ccwork 服务必须使用 HTTPS".into()));
    }
    let root = url.as_str().trim_end_matches('/');
    Ok(if root.ends_with("/api") {
        root.to_string()
    } else {
        format!("{root}/api")
    })
}

async fn request(
    base: &str,
    path: &str,
    token: Option<&str>,
    body: Option<Value>,
) -> Result<(u16, Value), AppError> {
    let url = format!("{}{path}", api_base(base)?);
    let mut req = if body.is_some() {
        HTTP.post(url)
    } else {
        HTTP.get(url)
    };
    if let Some(token) = token {
        req = req.bearer_auth(token);
    }
    if let Some(body) = body {
        req = req.json(&body);
    }
    let response = req.send().await?;
    let status = response.status().as_u16();
    let value = response
        .json::<Value>()
        .await
        .map_err(|_| AppError::ProxyError(format!("ccwork 返回非 JSON 响应 (HTTP {status})")))?;
    Ok((status, value))
}

fn data(status: u16, body: Value) -> Result<Value, AppError> {
    if !(200..300).contains(&status) || body.get("success").and_then(Value::as_bool) == Some(false)
    {
        let message = body
            .get("message")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .unwrap_or("ccwork 请求失败");
        return Err(AppError::ProxyError(format!("{message} (HTTP {status})")));
    }
    body.get("data")
        .cloned()
        .ok_or_else(|| AppError::ProxyError("ccwork 响应缺少 data".into()))
}

fn required(value: &Value, key: &str) -> Result<String, AppError> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .ok_or_else(|| AppError::ProxyError(format!("ccwork 响应缺少 {key}")))
}
fn user(value: &Value) -> Result<AccountUser, AppError> {
    let id = required(value, "id")?;
    let username = ["username", "email", "phone"]
        .iter()
        .find_map(|key| {
            value
                .get(key)
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
        })
        .unwrap_or(&id)
        .to_string();
    Ok(AccountUser {
        id: AccountUserId::Uuid(id),
        display_name: value
            .get("nickname")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .unwrap_or(&username)
            .into(),
        username,
        role: 0,
        status: 1,
        group: String::new(),
    })
}
fn persist(session: &Session) -> Result<(), AppError> {
    account::secret_store::set(
        &store_name(),
        &serde_json::to_string(session).map_err(|e| AppError::Internal(e.to_string()))?,
    )
}

async fn session() -> Result<Session, AppError> {
    // Serialize refresh-token rotation. Never let parallel API requests reuse
    // a refresh token that ccwork has already rotated.
    let mut guard = SESSION.lock().await;
    if guard.is_none() {
        *guard = account::secret_store::get(&store_name())?
            .map(|raw| serde_json::from_str(&raw))
            .transpose()
            .map_err(|_| AppError::InvalidRequest("ccwork 登录信息无效，请重新登录".into()))?;
    }
    let current = guard.as_mut().ok_or_else(missing)?;
    if current.expires_at <= now() + 60 {
        let (status, body) = request(
            &current.base_url,
            "/auth/refresh-token",
            None,
            Some(json!({"refresh_token": current.refresh_token})),
        )
        .await?;
        if status == 401 || status == 403 {
            *guard = None;
            account::secret_store::delete(&store_name())?;
            return Err(missing());
        }
        let value = data(status, body)?;
        current.access_token = required(&value, "access_token")?;
        current.refresh_token = required(&value, "refresh_token")?;
        current.expires_at = now() + value["expires_in"].as_u64().unwrap_or(0);
        persist(current)?;
    }
    Ok(current.clone())
}

async fn authenticated(path: &str) -> Result<Value, AppError> {
    authenticated_request(path, None).await
}

async fn authenticated_request(path: &str, payload: Option<Value>) -> Result<Value, AppError> {
    let mut current = session().await?;
    let (mut status, mut body) =
        request(&current.base_url, path, Some(&current.access_token), payload.clone()).await?;
    if status == 401 {
        let mut guard = SESSION.lock().await;
        if let Some(stored) = guard.as_mut() {
            if stored.access_token == current.access_token {
                stored.expires_at = 0;
            }
        }
        drop(guard);
        current = session().await?;
        (status, body) =
            request(&current.base_url, path, Some(&current.access_token), payload).await?;
        if status == 401 {
            *SESSION.lock().await = None;
            account::secret_store::delete(&store_name())?;
            return Err(missing());
        }
    }
    data(status, body)
}

fn organization(value: &Value) -> Result<String, AppError> {
    let list = value["organizations"]
        .as_array()
        .ok_or_else(|| AppError::ProxyError("ccwork 未返回组织目录".into()))?;
    let personal = list
        .iter()
        .find(|item| item["type"] == "personal")
        .ok_or_else(|| {
            AppError::ProxyError("ccwork 账号尚无个人组织，请先在 ccwork 完成账号设置".into())
        })?;
    required(personal, "id")
}

async fn accept_session(
    base: &str,
    value: Value,
    state: &State<'_, AppState>,
) -> Result<AccountUser, AppError> {
    let mut current = Session {
        base_url: base.trim_end_matches('/').trim_end_matches("/api").into(),
        access_token: required(&value, "access_token")?,
        refresh_token: required(&value, "refresh_token")?,
        expires_at: now() + value["expires_in"].as_u64().unwrap_or(0),
        user: user(&value["user"])?,
        organization_id: String::new(),
    };
    let (code, value) = request(
        &current.base_url,
        "/context/organizations?type=personal",
        Some(&current.access_token),
        None,
    )
    .await?;
    current.organization_id = organization(&data(code, value)?)?;
    relay::stop().await;
    // Authentication must remain usable while the local Core dashboard is
    // starting. Provider cleanup is retried by status/provision once it is
    // available, so a dashboard outage cannot strand a newly authenticated
    // ccwork session.
    if let Err(error) = account::clear_account_providers(state).await {
        log::warn!("ccwork login: unable to clear previous account providers: {error}");
    }
    persist(&current)?;
    *SESSION.lock().await = Some(current.clone());
    Ok(current.user)
}

pub async fn login(
    input: LoginInput,
    state: &State<'_, AppState>,
) -> Result<AccountUser, AppError> {
    let _change = ACCOUNT_CHANGE.lock().await;
    let (code, value) = request(
        &input.base_url,
        "/auth/login",
        None,
        Some(
            json!({"username":input.username.trim(),"password":input.password,"remember_me":true}),
        ),
    )
    .await?;
    accept_session(&input.base_url, data(code, value)?, state).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerificationCodeLoginInput {
    pub base_url: String,
    pub username: String,
    pub verification_code: String,
    /// ccwork binds a `login` code to the challenge key it was issued under, so
    /// this must be the exact value the send-code call carried.
    pub challenge_key: String,
}

/// Verification-code login. ccwork registers an unknown identifier on first use,
/// so this doubles as the lowest-friction signup.
#[tauri::command]
pub async fn account_login_with_verification_code(
    input: VerificationCodeLoginInput,
    state: State<'_, AppState>,
) -> Result<AccountUser, AppError> {
    if !enabled() {
        return Err(AppError::InvalidRequest(
            "当前品牌不支持 ccwork 验证码登录".into(),
        ));
    }
    let _change = ACCOUNT_CHANGE.lock().await;
    let (code, value) = request(
        &input.base_url,
        "/auth/login/verification-code",
        None,
        Some(json!({
            "username":input.username.trim(),
            "verification_code":input.verification_code.trim(),
            "challenge_key":input.challenge_key.trim(),
            "remember_me":true,
        })),
    )
    .await?;
    accept_session(&input.base_url, data(code, value)?, &state).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterInput {
    pub base_url: String,
    pub contact: String,
    pub password: String,
    pub verification_code: String,
    pub invite_code: Option<String>,
}

#[tauri::command]
pub async fn account_register(
    input: RegisterInput,
    state: State<'_, AppState>,
) -> Result<AccountUser, AppError> {
    if !enabled() {
        return Err(AppError::InvalidRequest(
            "当前品牌不支持 ccwork 注册".into(),
        ));
    }
    let _change = ACCOUNT_CHANGE.lock().await;
    let contact = input.contact.trim();
    let mut body = json!({"password":input.password,"verification_code":input.verification_code,"language":"zh-CN"});
    body[if contact.contains('@') {
        "email"
    } else {
        "phone"
    }] = contact.into();
    if let Some(invite) = input.invite_code.filter(|s| !s.trim().is_empty()) {
        body["invite_code"] = invite.trim().into();
    }
    let (code, value) = request(&input.base_url, "/auth/register", None, Some(body)).await?;
    accept_session(&input.base_url, data(code, value)?, &state).await
}

#[tauri::command]
pub async fn account_send_verification_code(
    contact: String,
    code_type: String,
    challenge_key: Option<String>,
    invite_code: Option<String>,
) -> Result<(), AppError> {
    if !enabled() {
        return Err(AppError::InvalidRequest(
            "当前品牌不支持 ccwork 验证码".into(),
        ));
    }
    // ccwork scopes a code by its `code_type`: a `register` code is refused once
    // the identifier exists, and a `login` code is bound to the challenge key it
    // was issued under. Neither may be substituted.
    let code_type = if code_type.trim() == "register" {
        "register"
    } else {
        "login"
    };
    let mut body = json!({"username":contact.trim(),"code_type":code_type});
    if code_type == "login" {
        let challenge = challenge_key
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| AppError::InvalidRequest("验证码登录缺少 challenge_key".into()))?;
        body["challenge_key"] = challenge.into();
    }
    if let Some(invite) = invite_code.filter(|s| !s.trim().is_empty()) {
        body["invite_code"] = invite.trim().into();
    }
    let (status, value) = request(
        BRAND_SERVICE_URL,
        "/auth/send-verification-code",
        None,
        Some(body),
    )
    .await?;
    // The send-code endpoint can return only success/message, without data.
    if !(200..300).contains(&status) || value["success"] != true {
        return Err(AppError::ProxyError(
            value["message"].as_str().unwrap_or("发送验证码失败").into(),
        ));
    }
    Ok(())
}

#[derive(Clone)]
struct Catalog {
    models: Vec<Value>,
}
impl Catalog {
    fn ids(&self) -> Vec<String> {
        self.models
            .iter()
            .filter_map(|m| m["id"].as_str().map(str::to_string))
            .collect()
    }
    fn names(&self) -> BTreeMap<String, String> {
        self.models
            .iter()
            .filter_map(|m| {
                Some((
                    m["id"].as_str()?.into(),
                    m["display_name"]
                        .as_str()
                        .or_else(|| m["name"].as_str())?
                        .into(),
                ))
            })
            .collect()
    }
}
fn parse_catalog(value: Value) -> Result<Catalog, AppError> {
    let models = value["models"]
        .as_array()
        .ok_or_else(|| AppError::ProxyError("ccwork 未返回模型目录".into()))?;
    let default = value["default_model_id"].as_str();
    let mut models: Vec<Value> = models
        .iter()
        .filter(|m| {
            m["id"].as_str().is_some_and(|id| !id.is_empty())
                && m["routing_enabled"] != false
                && m["provider_routing_enabled"] != false
                && m["supports_streaming"] != false
                && m["capability_domain"]
                    .as_str()
                    .is_none_or(|d| d == "chat" || d == "vision")
        })
        .cloned()
        .collect();
    models.sort_by_key(|m| Some(m["id"].as_str().unwrap_or_default()) != default);
    Ok(Catalog { models })
}
async fn catalog() -> Result<Catalog, AppError> {
    let current = session().await?;
    parse_catalog(
        authenticated(&format!(
            "/services/llm/catalog?organization_id={}&use_case=chat",
            urlencoding::encode(&current.organization_id)
        ))
        .await?,
    )
}
pub async fn setup() -> Result<SetupResult, AppError> {
    let current = session().await?;
    let catalog = catalog().await?;
    Ok(SetupResult {
        user: current.user,
        base_url: current.base_url,
        models: catalog.ids(),
        model_endpoint_types: BTreeMap::new(),
        model_names: catalog.names(),
        has_key: relay::active().await,
        masked_key: None,
    })
}
fn logged_out() -> StatusResult {
    StatusResult {
        logged_in: false,
        user: None,
        server_url: None,
        has_key: false,
        masked_key: None,
    }
}
pub async fn status(state: &State<'_, AppState>) -> Result<StatusResult, AppError> {
    let _change = ACCOUNT_CHANGE.lock().await;
    if SESSION.lock().await.is_none() && account::secret_store::get(&store_name())?.is_none() {
        return Ok(logged_out());
    }
    let profile = match authenticated("/auth/profile").await {
        Ok(profile) => profile,
        Err(AppError::InvalidRequest(message)) if message == "请登录 ccwork 账号" => {
            relay::stop().await;
            if let Err(error) = account::clear_account_providers(state).await {
                log::warn!("ccwork status: unable to clear expired providers: {error}");
            }
            return Ok(logged_out());
        }
        Err(error) => return Err(error),
    };
    let mut current = session().await?;
    current.user = user(&profile)?;
    {
        let mut guard = SESSION.lock().await;
        *guard = Some(current.clone());
        persist(&current)?;
    }
    // Rewrite the ephemeral relay URL on launch and whenever the Core profile
    // changes. The backend remains the source of permitted models.
    provision(state, None).await?;
    Ok(StatusResult {
        logged_in: true,
        user: Some(current.user),
        server_url: Some(current.base_url),
        has_key: true,
        masked_key: None,
    })
}

async fn provision(
    state: &State<'_, AppState>,
    input: Option<&SaveModelsInput>,
) -> Result<(), AppError> {
    let catalog = catalog().await?;
    let ids = catalog.ids();
    if let Some(input) = input {
        if input.models.is_empty() || input.models.iter().any(|id| !ids.contains(id)) {
            return Err(AppError::InvalidRequest(
                "请选择 ccwork 允许使用的模型".into(),
            ));
        }
    }
    let (dash, token) = account::dashboard_state(state)?;
    let mut config = account::read_config(&dash, token.as_deref()).await?;
    let provider_id = managed_provider_id(ManagedNamespace::Account, BRAND_PROVIDER_KEY);
    let existing = config["providers"][&provider_id].clone();
    let selected: Vec<Value> = catalog
        .models
        .into_iter()
        .filter(|m| input.is_none_or(|i| i.models.iter().any(|id| m["id"].as_str() == Some(id))))
        .collect();
    let model_ids: Vec<String> = selected
        .iter()
        .filter_map(|m| m["id"].as_str().map(str::to_string))
        .collect();
    if model_ids.is_empty() {
        relay::stop().await;
        return account::clear_account_providers(state).await;
    }
    let current = input
        .and_then(|i| i.primary_model_id.as_deref())
        .or_else(|| existing["model"].as_str())
        .filter(|id| model_ids.iter().any(|m| m == id))
        .unwrap_or(&model_ids[0])
        .to_string();
    let local = relay::ensure(&model_ids).await?;
    let provider = ManagedProvider {
        id: provider_id.clone(),
        namespace: ManagedNamespace::Account,
        name: BRAND_APP_NAME.into(),
        base_url: local.base_url,
        api_key: local.token,
        api_mode: ApiMode::ChatCompletions,
        model: current.clone(),
        models: selected
            .iter()
            .map(|m| ManagedModel {
                id: m["id"].as_str().unwrap_or_default().into(),
                context_length: m["context_window_tokens"].as_u64(),
                supports_tools: m["supports_function_calling"].as_bool(),
                supports_vision: m["supports_vision"].as_bool(),
                supports_reasoning: None,
            })
            .collect(),
        extra: Vec::new(),
    };
    apply_managed_providers_json(
        &mut config,
        &[ManagedNamespace::Account],
        std::slice::from_ref(&provider),
    )
    .map_err(AppError::ProxyError)?;
    // Core supports display_name in model metadata; keep the UUID as the wire ID.
    for model in selected {
        if let (Some(id), Some(name)) = (model["id"].as_str(), model["display_name"].as_str()) {
            config["providers"][&provider_id]["models"][id]["display_name"] = name.into();
        }
    }
    if input.is_some()
        || config["model"]["provider"]
            .as_str()
            .is_none_or(|p| p.starts_with("custom:acct-"))
    {
        set_default_model_json(&mut config, &provider, &current).map_err(AppError::ProxyError)?;
    }
    account::write_config(&dash, token.as_deref(), &config).await
}
pub async fn save_models(
    input: SaveModelsInput,
    state: &State<'_, AppState>,
) -> Result<StatusResult, AppError> {
    let _change = ACCOUNT_CHANGE.lock().await;
    provision(state, Some(&input)).await?;
    let current = session().await?;
    Ok(StatusResult {
        logged_in: true,
        user: Some(current.user),
        server_url: Some(current.base_url),
        has_key: true,
        masked_key: None,
    })
}

fn decimal(value: &Value, key: &str) -> Result<String, AppError> {
    match &value[key] {
        Value::String(s) => Ok(s.clone()),
        Value::Number(n) => Ok(n.to_string()),
        _ => Err(AppError::ProxyError(format!("ccwork 钱包缺少 {key}"))),
    }
}
/// Wallet balance plus this month's/today's consumption.
///
/// The wallet and the usage dashboard are two different services, and only the
/// wallet is required to show a balance. A dashboard outage used to propagate
/// through `?` and turn the whole call into an error, so the popup showed
/// "ccwork 钱包暂时不可用" even though the wallet had answered — reporting an
/// unknown consumption as a missing balance. Consumption now degrades to empty
/// while the wallet stays authoritative.
pub async fn balance() -> Result<AccountBalance, AppError> {
    let current = session().await?;
    let wallet = authenticated(&format!(
        "/wallet/organizations/{}/wallet",
        urlencoding::encode(&current.organization_id)
    ))
    .await?;
    let usage = authenticated(&format!(
        "/services/billing/organizations/{}/usage-dashboard",
        urlencoding::encode(&current.organization_id)
    ))
    .await
    .unwrap_or_else(|error| {
        log::warn!("ccwork usage dashboard unavailable, reporting balance only: {error}");
        Value::Null
    });
    let consumed = decimal(&usage, "current_month_total_credits").ok();
    let today = decimal(&usage, "today_total_credits").ok();
    let available = decimal(&wallet, "available_credits_precise")?;
    let frozen = decimal(&wallet, "credits_frozen_precise")?;
    Ok(AccountBalance {
        quota: available
            .parse()
            .map_err(|_| AppError::ProxyError("ccwork 钱包余额无效".into()))?,
        used_quota: consumed
            .as_deref()
            .unwrap_or("0")
            .parse()
            .map_err(|_| AppError::ProxyError("ccwork 消耗积分无效".into()))?,
        quota_per_unit: 1.,
        display_in_currency: false,
        top_up_url: BRAND_RECHARGE_URL.into(),
        available_credits: Some(available),
        frozen_credits: Some(frozen),
        monthly_consumed_credits: consumed,
        today_consumed_credits: today,
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountTransaction {
    pub id: String,
    pub description: String,
    pub amount_precise: String,
    pub created_at: String,
    pub transaction_type: String,
    pub model_name: Option<String>,
    pub provider_key: Option<String>,
    pub meter_key: Option<String>,
    pub quantity: Option<String>,
    pub unit: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountTransactions {
    pub total: u64,
    pub transactions: Vec<AccountTransaction>,
}

pub async fn transactions(limit: u32, offset: u32) -> Result<AccountTransactions, AppError> {
    let current = session().await?;
    let limit = limit.clamp(1, 100);
    let value = authenticated(&format!(
        "/wallet/organizations/{}/transactions?transaction_type=consume&limit={limit}&offset={offset}",
        urlencoding::encode(&current.organization_id)
    )).await?;
    let rows = value["transactions"].as_array().cloned().unwrap_or_default();
    let transactions = rows.iter().map(|row| AccountTransaction {
        id: row["id"].as_str().unwrap_or_default().to_string(),
        description: row["description"].as_str().unwrap_or("模型消费").to_string(),
        amount_precise: row["amount_precise"].as_str().map(str::to_string).unwrap_or_else(|| row["amount_precise"].to_string()),
        created_at: row["created_at"].as_str().unwrap_or_default().to_string(),
        transaction_type: row["transaction_type"].as_str().unwrap_or("consume").to_string(),
        model_name: row["model_name"].as_str().map(str::to_string),
        provider_key: row["provider_key"].as_str().map(str::to_string),
        meter_key: row["meter_key"].as_str().map(str::to_string),
        quantity: row["quantity"].as_str().map(str::to_string).or_else(|| row["quantity"].as_f64().map(|v| v.to_string())),
        unit: row["unit"].as_str().map(str::to_string),
    }).collect();
    Ok(AccountTransactions { total: value["total"].as_u64().unwrap_or(0), transactions })
}

#[tauri::command]
pub async fn account_credit_packages() -> Result<Value, AppError> {
    authenticated("/wallet/packages?active_only=true").await
}

#[tauri::command]
pub async fn account_create_recharge(package_id: String, payment_method: String) -> Result<Value, AppError> {
    if package_id.trim().is_empty() || !matches!(payment_method.as_str(), "alipay" | "wechat") {
        return Err(AppError::InvalidRequest("请选择代币套餐和支付方式".into()));
    }
    let current = session().await?;
    let payment_type = if payment_method == "alipay" { "qr" } else { "native" };
    let query = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("package_id", &package_id)
        .append_pair("payment_method", &payment_method)
        .append_pair("payment_type", payment_type)
        .append_pair("organization_id", &current.organization_id)
        .finish();
    authenticated_request(&format!("/wallet/recharge?{query}"), Some(json!({}))).await
}

#[tauri::command]
pub async fn account_recharge_status(order_no: String) -> Result<Value, AppError> {
    authenticated(&format!("/services/payment/query-order?order_no={}", urlencoding::encode(&order_no))).await
}

#[tauri::command]
pub async fn account_cancel_recharge(order_no: String) -> Result<Value, AppError> {
    authenticated_request(&format!("/services/payment/cancel-order?order_no={}", urlencoding::encode(&order_no)), Some(json!({}))).await
}
pub async fn logout(state: &State<'_, AppState>) -> Result<StatusResult, AppError> {
    let _change = ACCOUNT_CHANGE.lock().await;
    let current = SESSION.lock().await.take();
    relay::stop().await;
    account::secret_store::delete(&store_name())?;
    // Stop local inference even if ccwork is temporarily unreachable.
    if let Some(current) = current {
        let _ = request(
            &current.base_url,
            "/auth/logout",
            Some(&current.access_token),
            Some(json!({})),
        )
        .await;
    }
    account::clear_account_providers(state).await?;
    Ok(logged_out())
}
pub async fn test_model(id: &str) -> Result<TestModelResult, AppError> {
    let ids = catalog().await?.ids();
    if !ids.iter().any(|model| model == id) {
        return Err(AppError::InvalidRequest("ccwork 模型不可用".into()));
    }
    let started = std::time::Instant::now();
    let local = relay::ensure(&ids).await?;
    let result = HTTP.post(format!("{}/chat/completions",local.base_url)).bearer_auth(&local.token).json(&json!({"model":id,"messages":[{"role":"user","content":"Reply OK"}],"max_tokens":8,"stream":false})).send().await?;
    let code = result.status();
    let body: Value = result.json().await?;
    Ok(TestModelResult {
        ok: code.is_success(),
        latency_ms: Some(started.elapsed().as_millis() as u64),
        reply: body["choices"][0]["message"]["content"]
            .as_str()
            .map(str::to_string),
        error: (!code.is_success()).then(|| {
            body["error"]["message"]
                .as_str()
                .unwrap_or("ccwork 推理失败")
                .into()
        }),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;
    #[test]
    fn contracts_preserve_uuid_and_personal_billing_scope() {
        let value =
            json!({"id":"user-uuid","username":null,"email":"a@example.com","nickname":"昵称"});
        assert_eq!(
            serde_json::to_value(user(&value).unwrap()).unwrap()["id"],
            "user-uuid"
        );
        assert_eq!(organization(&json!({"organizations":[{"id":"team","type":"team"},{"id":"personal","type":"personal"}]})).unwrap(),"personal");
        assert!(organization(&json!({"organizations":[{"id":"team","type":"team"}]})).is_err());
    }
    #[test]
    fn catalog_uses_ids_defaults_and_server_permissions() {
        let c=parse_catalog(json!({"default_model_id":"b","models":[{"id":"a","display_name":"A","capability_domain":"chat"},{"id":"b","display_name":"B"},{"id":"disabled","routing_enabled":false},{"id":"embedding","capability_domain":"embedding"}]})).unwrap();
        assert_eq!(c.ids(), vec!["b", "a"]);
        assert_eq!(c.names()["b"], "B");
    }
    #[test]
    fn api_urls_and_precision() {
        assert_eq!(
            api_base("https://ccwork.site/api/").unwrap(),
            "https://ccwork.site/api"
        );
        assert!(api_base("http://ccwork.site").is_err());
        assert!(api_base("https://user:secret@ccwork.site").is_err());
        assert_eq!(
            decimal(&json!({"available":"0.000000001234"}), "available").unwrap(),
            "0.000000001234"
        );
    }
    #[tokio::test]
    async fn auth_contract_sends_jwt_not_legacy_cookie() {
        use wiremock::matchers::{body_json, header, method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/auth/login"))
            .and(body_json(
                json!({"username":"a","password":"p","remember_me":true}),
            ))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(json!({"success":true,"data":{"access_token":"jwt"}})),
            )
            .expect(1)
            .mount(&server)
            .await;
        let (code, body) = request(
            &server.uri(),
            "/auth/login",
            None,
            Some(json!({"username":"a","password":"p","remember_me":true})),
        )
        .await
        .unwrap();
        assert_eq!(data(code, body).unwrap()["access_token"], "jwt");
        Mock::given(method("GET"))
            .and(path("/api/auth/profile"))
            .and(header("authorization", "Bearer jwt"))
            .respond_with(
                ResponseTemplate::new(401)
                    .set_body_json(json!({"success":false,"message":"expired"})),
            )
            .mount(&server)
            .await;
        let (code, body) = request(&server.uri(), "/auth/profile", Some("jwt"), None)
            .await
            .unwrap();
        assert!(data(code, body).is_err());
        for req in server.received_requests().await.unwrap() {
            assert!(!req.headers.contains_key("cookie"));
            assert!(!req.headers.contains_key("new-api-user"));
        }
    }
}
