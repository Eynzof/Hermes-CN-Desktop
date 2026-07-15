// Connection-config commands: managed runtime vs local/remote Hermes Agent.
//
// IPC surface mirrors the official desktop (Hermes-CN-Core apps/desktop
// preload: getConnectionConfig / saveConnectionConfig / applyConnectionConfig /
// testConnectionConfig / probeConnectionConfig), token-auth only.
//
// `apply_connection_config` switches modes live, without an app restart:
//   - managed → local/remote: probe the target FIRST, then stop the owned
//     dashboard and adopt the attachment into AppState.
//   - local/remote → managed: run the full bootstrap acquire path (which can
//     download a managed runtime on a machine that has never run it).
// Both directions hold the shared dashboard-restart guard so they cannot race
// a profile switch or YOLO toggle. The frontend reloads the webview after a
// successful apply, which rebuilds all JS-side state from get_runtime_config.

use std::sync::LazyLock;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{Manager, State};

use crate::commands::restart;
use crate::connection::{self, ConnectionConfig, ConnectionMode, SanitizedConnectionConfig};
use crate::error::{AppError, AppResult};
use crate::process::dashboard;
use crate::process::runtime;
use crate::state::{AppState, DashboardHandle};

static CONNECTION_HTTP_CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .expect("failed to build connection test HTTP client")
});

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionConfigView {
    #[serde(flatten)]
    pub config: SanitizedConnectionConfig,
    /// What the running desktop is actually attached to right now. Differs
    /// from `mode` between a save and the apply/reload that enacts it.
    pub effective_mode: String,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionConfigInput {
    pub mode: Option<String>,
    pub local_url: Option<String>,
    pub remote_url: Option<String>,
    /// Empty/absent keeps the previously saved token (so the user can edit the
    /// URL without re-entering the secret), matching the official desktop's
    /// coerce behavior.
    pub remote_token: Option<String>,
    /// "token" (default) or "oauth". Absent keeps the saved mode.
    pub remote_auth_mode: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthProviderInfo {
    pub name: String,
    pub display_name: String,
    pub supports_password: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeConnectionResult {
    pub reachable: bool,
    pub auth_required: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// Login providers registered on a gated gateway (empty for token mode or
    /// when the providers endpoint is unavailable / returns 503).
    #[serde(default)]
    pub auth_providers: Vec<AuthProviderInfo>,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestConnectionResult {
    pub ok: bool,
    pub base_url: String,
    pub http_ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub http_status: Option<u16>,
    pub ws_ok: bool,
    pub auth_required: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// True when a gated gateway's OAuth session is missing/expired so the UI
    /// should route to (re-)login rather than showing a generic failure.
    pub needs_oauth_login: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyConnectionResult {
    pub ok: bool,
    pub mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_base_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gateway_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Merge a settings-form submission into the saved config and validate it.
/// Pure so the coerce rules are unit-testable.
fn coerce_config(
    existing: &ConnectionConfig,
    input: &ConnectionConfigInput,
) -> AppResult<ConnectionConfig> {
    let mode = match input.mode.as_deref() {
        Some("managed") | None => ConnectionMode::Managed,
        Some("local") => ConnectionMode::Local,
        Some("remote") => ConnectionMode::Remote,
        Some(other) => {
            return Err(AppError::InvalidRequest(format!(
                "未知的连接模式: {}",
                other
            )))
        }
    };

    let local_url = match input.local_url.as_deref().map(str::trim) {
        Some(url) if !url.is_empty() => Some(connection::normalize_local_base_url(url)?),
        Some(_) => Some(connection::DEFAULT_LOCAL_DASHBOARD_URL.to_string()),
        None => existing.local_url.clone(),
    };
    let remote_url = match input.remote_url.as_deref().map(str::trim) {
        Some(url) if !url.is_empty() => Some(connection::normalize_remote_base_url(url)?),
        // An explicitly empty URL clears the saved one; absent keeps it.
        Some(_) => None,
        None => existing.remote_url.clone(),
    };
    let remote_token = match input.remote_token.as_deref().map(str::trim) {
        Some(token) if !token.is_empty() => Some(token.to_string()),
        // Empty or absent keeps the saved secret — the form never round-trips it.
        _ => existing.remote_token.clone(),
    };

    let local_url = if mode == ConnectionMode::Local {
        Some(local_url.unwrap_or_else(|| connection::DEFAULT_LOCAL_DASHBOARD_URL.to_string()))
    } else {
        local_url
    };

    // Auth mode: explicit input wins, else keep the saved mode (mirrors the
    // official desktop's resolveAuthMode).
    let remote_auth_mode = match input.remote_auth_mode.as_deref() {
        Some(v) => connection::RemoteAuthMode::from_str_opt(Some(v)),
        None => existing.remote_auth_mode,
    };

    if mode == ConnectionMode::Remote {
        if remote_url.is_none() {
            return Err(AppError::InvalidRequest(
                "远程模式需要填写远程 Hermes Agent 地址".to_string(),
            ));
        }
        // OAuth mode needs only the URL — the cookie session is provisioned by
        // the interactive login flow, not this form.
        if remote_auth_mode == connection::RemoteAuthMode::Token && remote_token.is_none() {
            return Err(AppError::InvalidRequest(
                "远程 token 模式需要填写 session token".to_string(),
            ));
        }
    }

    // Editing the URL invalidates any saved cookie session (it belonged to the
    // old gateway) so it is never sent to a different host.
    let url_changed = remote_url != existing.remote_url;
    let remote_session = if url_changed {
        None
    } else {
        existing.remote_session.clone()
    };

    Ok(ConnectionConfig {
        mode,
        local_url,
        remote_url,
        remote_token,
        remote_auth_mode,
        remote_session,
    })
}

fn reject_env_override() -> AppResult<()> {
    if connection::env_override_active() {
        return Err(AppError::InvalidRequest(format!(
            "连接配置由环境变量 {} 强制，无法在设置中修改",
            connection::ENV_REMOTE_URL
        )));
    }
    Ok(())
}

enum TestTarget {
    Local { base_url: String },
    Remote { base_url: String, token: String },
}

/// Resolve the URL/token a test should run against: explicit form input wins,
/// then the env override, then the saved config.
fn test_target(input: &ConnectionConfigInput) -> AppResult<TestTarget> {
    let saved = connection::read_config();
    let mode = match input.mode.as_deref() {
        Some("local") => ConnectionMode::Local,
        Some("remote") => ConnectionMode::Remote,
        Some("managed") | None => saved.mode,
        Some(other) => {
            return Err(AppError::InvalidRequest(format!(
                "未知的连接模式: {}",
                other
            )))
        }
    };

    if mode == ConnectionMode::Local {
        let raw_url = input
            .local_url
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(str::to_string)
            .or(saved.local_url)
            .unwrap_or_else(|| connection::DEFAULT_LOCAL_DASHBOARD_URL.to_string());
        return Ok(TestTarget::Local {
            base_url: connection::normalize_local_base_url(&raw_url)?,
        });
    }

    let env_url = std::env::var(connection::ENV_REMOTE_URL)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty());
    let env_token = std::env::var(connection::ENV_REMOTE_TOKEN)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty());

    let raw_url = input
        .remote_url
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_string)
        .or(env_url)
        .or(saved.remote_url)
        .ok_or_else(|| {
            AppError::InvalidRequest("没有可测试的远程地址：请先填写 URL".to_string())
        })?;
    let token = input
        .remote_token
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_string)
        .or(env_token)
        .or(saved.remote_token)
        .ok_or_else(|| {
            AppError::InvalidRequest("没有可测试的 token：请先填写 session token".to_string())
        })?;

    Ok(TestTarget::Remote {
        base_url: connection::normalize_remote_base_url(&raw_url)?,
        token,
    })
}

async fn fetch_status(
    base_url: &str,
    token: Option<&str>,
) -> Result<(u16, Option<serde_json::Value>), reqwest::Error> {
    let mut request = CONNECTION_HTTP_CLIENT
        .get(format!("{}/api/status", base_url))
        .header("Accept", "application/json");
    if let Some(token) = token {
        request = request
            .header("Authorization", format!("Bearer {}", token))
            .header("X-Hermes-Session-Token", token);
    }
    let response = request.send().await?;
    let status = response.status().as_u16();
    let body = response.json::<serde_json::Value>().await.ok();
    Ok((status, body))
}

fn status_field<'a>(
    body: &'a Option<serde_json::Value>,
    key: &str,
) -> Option<&'a serde_json::Value> {
    body.as_ref().and_then(|b| b.get(key))
}

#[tauri::command]
pub fn get_connection_config(state: State<'_, AppState>) -> Result<ConnectionConfigView, AppError> {
    let effective_mode = {
        let inner = state.inner.lock()?;
        inner.connection_mode.as_str().to_string()
    };
    Ok(ConnectionConfigView {
        config: connection::sanitize(&connection::read_config()),
        effective_mode,
    })
}

#[tauri::command]
pub fn save_connection_config(
    input: ConnectionConfigInput,
    state: State<'_, AppState>,
) -> Result<ConnectionConfigView, AppError> {
    reject_env_override()?;
    let config = coerce_config(&connection::read_config(), &input)?;
    connection::write_config(&config)?;

    let effective_mode = {
        let inner = state.inner.lock()?;
        inner.connection_mode.as_str().to_string()
    };
    Ok(ConnectionConfigView {
        config: connection::sanitize(&config),
        effective_mode,
    })
}

/// Unauthenticated reachability probe for the as-you-type settings UX.
#[tauri::command]
pub async fn probe_connection_config(
    remote_url: String,
) -> Result<ProbeConnectionResult, AppError> {
    let base_url = connection::normalize_remote_base_url(&remote_url)?;
    match fetch_status(&base_url, None).await {
        Ok((status, body)) => {
            let auth_required = status_field(&body, "auth_required")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            // On a gated gateway, list the login providers so the UI can render
            // the right buttons (OAuth vs password). Public endpoint; a 503
            // (zero providers) yields an empty list.
            let auth_providers = if auth_required {
                fetch_auth_providers(&base_url).await
            } else {
                Vec::new()
            };
            Ok(ProbeConnectionResult {
                // Mirror dashboard::probe_dashboard: 2xx or 401 both prove a
                // dashboard is answering; 401 just means status is token-gated.
                reachable: (200..300).contains(&status) || status == 401,
                auth_required,
                version: status_field(&body, "version")
                    .and_then(|v| v.as_str())
                    .map(str::to_string),
                auth_providers,
            })
        }
        Err(_) => Ok(ProbeConnectionResult {
            reachable: false,
            auth_required: false,
            version: None,
            auth_providers: Vec::new(),
        }),
    }
}

/// Fetch registered login providers from a gated gateway (`/api/auth/providers`,
/// public). Returns empty on any error / 503 (zero providers configured).
async fn fetch_auth_providers(base_url: &str) -> Vec<AuthProviderInfo> {
    let resp = match CONNECTION_HTTP_CLIENT
        .get(format!("{}/api/auth/providers", base_url))
        .header("Accept", "application/json")
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => r,
        _ => return Vec::new(),
    };
    let Ok(body) = resp.json::<serde_json::Value>().await else {
        return Vec::new();
    };
    body.get("providers")
        .and_then(|p| p.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|p| {
                    let name = p.get("name")?.as_str()?.to_string();
                    Some(AuthProviderInfo {
                        display_name: p
                            .get("display_name")
                            .and_then(|d| d.as_str())
                            .unwrap_or(&name)
                            .to_string(),
                        supports_password: p
                            .get("supports_password")
                            .and_then(|v| v.as_bool())
                            .unwrap_or(false),
                        name,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Authenticated two-step connection test: HTTP `/api/status` with the token
/// headers, then a real WebSocket handshake against `/api/ws?token=` — the
/// same transport the app uses, so a passing test means the app can connect.
#[tauri::command]
pub async fn test_connection_config(
    input: ConnectionConfigInput,
) -> Result<TestConnectionResult, AppError> {
    // OAuth remote: verify the live cookie session end-to-end the way the app
    // will use it — authed /api/status then mint a ws-ticket and handshake
    // /api/ws?ticket=. A mint 401 means the session is dead → needs re-login.
    let is_oauth = connection::RemoteAuthMode::from_str_opt(input.remote_auth_mode.as_deref())
        == connection::RemoteAuthMode::Oauth
        && input.mode.as_deref() == Some("remote");
    if is_oauth {
        return test_oauth_connection(&input).await;
    }
    let target = test_target(&input)?;
    let (base_url, token, is_local) = match target {
        TestTarget::Local { base_url } => {
            let token = dashboard::fetch_session_token(&base_url).await;
            (base_url, token, true)
        }
        TestTarget::Remote { base_url, token } => (base_url, Some(token), false),
    };

    let mut result = TestConnectionResult {
        base_url: base_url.clone(),
        ..Default::default()
    };

    match fetch_status(&base_url, token.as_deref()).await {
        Ok((status, body)) => {
            result.http_status = Some(status);
            result.http_ok = (200..300).contains(&status);
            result.auth_required = status_field(&body, "auth_required")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            result.version = status_field(&body, "version")
                .and_then(|v| v.as_str())
                .map(str::to_string);
            if status == 401 {
                result.error = Some(if is_local {
                    "无法自动读取本地 dashboard session token，或 token 已过期（HTTP 401）"
                        .to_string()
                } else {
                    "token 无效或已过期（HTTP 401）".to_string()
                });
            } else if !result.http_ok {
                result.error = Some(format!("目标网关返回 HTTP {}", status));
            }
        }
        Err(err) => {
            result.error = Some(format!("无法连接目标地址: {}", err));
            return Ok(result);
        }
    }

    if result.auth_required {
        // The gateway is gated but the user is testing with token mode — route
        // them to the OAuth login flow instead of a dead-end.
        result.needs_oauth_login = true;
        result.error =
            Some("该网关启用了登录门，请在下方选择登录方式（OAuth / 密码）后再连接".to_string());
        return Ok(result);
    }

    if token.is_none() {
        result.error = Some("HTTP 可达，但无法自动读取 dashboard session token".to_string());
        return Ok(result);
    }

    result.ws_ok = dashboard::dashboard_supports_ws(&base_url, token.as_deref()).await;
    if result.http_ok && !result.ws_ok {
        result.error = Some(
            "HTTP 可达但 WebSocket（/api/ws）握手失败：检查代理/防火墙是否放行 WS，以及 token 是否正确".to_string(),
        );
    }

    result.ok = result.http_ok && result.ws_ok;
    Ok(result)
}

/// OAuth-mode connection test: uses the live cookie session for the URL.
async fn test_oauth_connection(
    input: &ConnectionConfigInput,
) -> Result<TestConnectionResult, AppError> {
    let raw_url = input
        .remote_url
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .ok_or_else(|| AppError::InvalidRequest("请先填写远程地址".to_string()))?;
    let base_url = connection::normalize_remote_base_url(raw_url)?;
    let mut result = TestConnectionResult {
        base_url: base_url.clone(),
        auth_required: true,
        ..Default::default()
    };

    let session = crate::oauth_session::session_for(&base_url)?;
    // Seed from persisted cookies so a saved login can test without re-auth.
    if let Some(cookies) = connection::read_config().remote_session {
        session.import_cookies(&cookies);
    }
    if !session.has_live_session() {
        result.needs_oauth_login = true;
        result.error = Some("尚未登录该网关，请先完成登录".to_string());
        return Ok(result);
    }

    match fetch_status(&base_url, None).await {
        Ok((status, _)) => {
            result.http_status = Some(status);
            result.http_ok = (200..300).contains(&status);
        }
        Err(err) => {
            result.error = Some(format!("无法连接目标地址: {}", err));
            return Ok(result);
        }
    }

    match session.mint_ws_ticket().await {
        Ok(ticket) => {
            result.ws_ok = dashboard::dashboard_supports_ws_ticket(&base_url, &ticket).await;
            if !result.ws_ok {
                result.error = Some(
                    "已登录但 WebSocket（/api/ws）握手失败：检查代理/防火墙是否放行 WS".to_string(),
                );
            }
        }
        Err(AppError::AuthSessionExpired(_)) => {
            result.needs_oauth_login = true;
            result.error = Some("登录已过期，请重新登录".to_string());
            return Ok(result);
        }
        Err(err) => {
            result.error = Some(format!("获取 WebSocket 票据失败: {}", err));
            return Ok(result);
        }
    }

    result.ok = result.http_ok && result.ws_ok;
    Ok(result)
}

#[tauri::command]
pub async fn apply_connection_config(
    input: ConnectionConfigInput,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<ApplyConnectionResult, AppError> {
    reject_env_override()?;

    // Persist first: the chosen config survives any failure below, so a boot
    // after a crashed switch still lands on what the user asked for.
    let config = coerce_config(&connection::read_config(), &input)?;
    connection::write_config(&config)?;

    if !restart::try_begin_restart(&state)? {
        return Ok(ApplyConnectionResult {
            ok: false,
            mode: config.mode.as_str().to_string(),
            error: Some("运行时正在切换中，请稍后再试".to_string()),
            ..Default::default()
        });
    }

    let result = match config.mode {
        ConnectionMode::Managed => apply_managed(&app, &state).await,
        ConnectionMode::Local => apply_local_connection(&state, &config).await,
        ConnectionMode::Remote => apply_remote(&state, &config).await,
    };

    restart::end_restart(&state);
    result
}

fn detach_current_backend(state: &State<'_, AppState>) -> Result<(), AppError> {
    let mut inner = state.inner.lock()?;
    if let Some(relay) = inner.gateway_ws.take() {
        relay
            .abort
            .store(true, std::sync::atomic::Ordering::Relaxed);
        relay.notify.notify_waiters();
    }
    let session_token = inner.session_token.clone();
    if let Some(ref mut handle) = inner.dashboard_handle {
        handle.stop_with_token(session_token.as_deref());
    }
    inner.dashboard_handle = None;
    Ok(())
}

/// Switch the running desktop onto a remote Hermes Agent. The remote is probed
/// before anything local is torn down, so a bad URL/token leaves the current
/// backend untouched.
async fn apply_remote(
    state: &State<'_, AppState>,
    config: &ConnectionConfig,
) -> Result<ApplyConnectionResult, AppError> {
    let base_url = config.remote_url.clone().unwrap_or_default();
    if config.remote_auth_mode == connection::RemoteAuthMode::Oauth {
        return apply_remote_oauth(state, config, &base_url).await;
    }
    // coerce_config guarantees the token is present in remote token mode.
    let token = config.remote_token.clone().unwrap_or_default();

    if !dashboard::probe_dashboard(&base_url).await {
        return Ok(ApplyConnectionResult {
            ok: false,
            mode: "remote".to_string(),
            error: Some(format!(
                "远程 Hermes Agent 不可达（{}/api/status 无响应），已保存配置但未切换",
                base_url
            )),
            ..Default::default()
        });
    }
    if !dashboard::dashboard_supports_ws(&base_url, Some(&token)).await {
        return Ok(ApplyConnectionResult {
            ok: false,
            mode: "remote".to_string(),
            error: Some(
                "远程 WebSocket（/api/ws）握手失败：检查 token 是否正确，已保存配置但未切换"
                    .to_string(),
            ),
            ..Default::default()
        });
    }

    detach_current_backend(state)?;

    let gateway_url = dashboard::build_gateway_url(&base_url, Some(&token));
    {
        let mut inner = state.inner.lock()?;
        inner.api_base_url = base_url.clone();
        inner.gateway_url = gateway_url.clone();
        inner.session_token = Some(token.clone());
        inner.connection_mode = ConnectionMode::Remote;
        inner.yolo_mode = false;
        inner.last_runtime_error = None;
        inner.dashboard_handle = Some(DashboardHandle::remote(base_url.clone(), token.clone()));
    }

    log::info!("Connection switched to remote Hermes Agent at {}", base_url);
    Ok(ApplyConnectionResult {
        ok: true,
        mode: "remote".to_string(),
        api_base_url: Some(base_url),
        gateway_url: Some(gateway_url),
        session_token: Some(token),
        error: None,
    })
}

/// Switch onto a gated remote gateway using an OAuth/cookie session. Requires
/// the user to have already logged in (a live session for this URL); the
/// session is verified by minting a ws-ticket before anything is torn down.
async fn apply_remote_oauth(
    state: &State<'_, AppState>,
    config: &ConnectionConfig,
    base_url: &str,
) -> Result<ApplyConnectionResult, AppError> {
    let auth_required = matches!(fetch_status(base_url, None).await, Ok((_, ref body))
        if status_field(body, "auth_required").and_then(|v| v.as_bool()).unwrap_or(false));
    if !auth_required {
        return Ok(ApplyConnectionResult {
            ok: false,
            mode: "remote".to_string(),
            error: Some(
                "该后端未启用登录门（auth_required=false），请改用会话令牌模式".to_string(),
            ),
            ..Default::default()
        });
    }

    let session = crate::oauth_session::session_for(base_url)?;
    if let Some(cookies) = config.remote_session.clone() {
        session.import_cookies(&cookies);
    }
    // Verify the session is live by minting a ticket; a 401 means re-login.
    if let Err(err) = session.mint_ws_ticket().await {
        let msg = match err {
            AppError::AuthSessionExpired(_) => {
                "远程登录已过期或尚未登录，请在设置中登录后再连接".to_string()
            }
            other => format!("远程会话校验失败：{}，已保存配置但未切换", other),
        };
        return Ok(ApplyConnectionResult {
            ok: false,
            mode: "remote".to_string(),
            error: Some(msg),
            ..Default::default()
        });
    }

    detach_current_backend(state)?;

    // Gateway URL carries no token in oauth mode; the relay mints a ticket per
    // connect. Persist any cookies the verify captured.
    let gateway_url = dashboard::build_gateway_url(base_url, None);
    let cookies = session.export_cookies();
    {
        let mut inner = state.inner.lock()?;
        inner.api_base_url = base_url.to_string();
        inner.gateway_url = gateway_url.clone();
        inner.session_token = None;
        inner.oauth_session = Some(session);
        inner.connection_mode = ConnectionMode::Remote;
        inner.yolo_mode = false;
        inner.last_runtime_error = None;
        inner.dashboard_handle = Some(DashboardHandle::remote_oauth(base_url.to_string()));
    }
    let mut persisted = config.clone();
    persisted.remote_session = Some(cookies);
    let _ = connection::write_config(&persisted);

    log::info!(
        "Connection switched to OAuth remote Hermes Agent at {}",
        base_url
    );
    Ok(ApplyConnectionResult {
        ok: true,
        mode: "remote".to_string(),
        api_base_url: Some(base_url.to_string()),
        gateway_url: Some(gateway_url),
        session_token: None,
        error: None,
    })
}

/// Switch the running desktop onto a loopback Hermes Agent CLI dashboard. The
/// session token is fetched from the dashboard HTML and never stored.
async fn apply_local_connection(
    state: &State<'_, AppState>,
    config: &ConnectionConfig,
) -> Result<ApplyConnectionResult, AppError> {
    let base_url = config
        .local_url
        .clone()
        .unwrap_or_else(|| connection::DEFAULT_LOCAL_DASHBOARD_URL.to_string());

    if !dashboard::probe_attached_dashboard(&base_url).await {
        return Ok(ApplyConnectionResult {
            ok: false,
            mode: "local".to_string(),
            error: Some(format!(
                "本地 Hermes Agent CLI 不可达（{}/api/status 无响应），已保存配置但未切换",
                base_url
            )),
            ..Default::default()
        });
    }

    let token = match dashboard::fetch_session_token(&base_url).await {
        Some(token) => token,
        None => {
            return Ok(ApplyConnectionResult {
                ok: false,
                mode: "local".to_string(),
                error: Some(
                    "无法从本地 dashboard 页面自动读取 session token，请确认 Hermes Agent CLI dashboard 正常运行"
                        .to_string(),
                ),
                ..Default::default()
            })
        }
    };

    if !dashboard::dashboard_supports_ws(&base_url, Some(&token)).await {
        return Ok(ApplyConnectionResult {
            ok: false,
            mode: "local".to_string(),
            error: Some(
                "本地 WebSocket（/api/ws）握手失败：检查本机 dashboard 状态与 session token"
                    .to_string(),
            ),
            ..Default::default()
        });
    }

    let hermes_home = match dashboard::fetch_attached_dashboard_hermes_home(&base_url)
        .await
        .filter(|h| !h.trim().is_empty())
    {
        Some(home) => home,
        None => {
            return Ok(ApplyConnectionResult {
                ok: false,
                mode: "local".to_string(),
                error: Some(
                    "本地 dashboard 未返回 hermes_home，已保存配置但未切换，避免误读桌面端内置内核的 Memory"
                        .to_string(),
                ),
                ..Default::default()
            })
        }
    };
    let gateway_url = dashboard::build_gateway_url(&base_url, Some(&token));
    detach_current_backend(state)?;

    {
        let mut inner = state.inner.lock()?;
        inner.api_base_url = base_url.clone();
        inner.gateway_url = gateway_url.clone();
        inner.session_token = Some(token.clone());
        inner.hermes_home = hermes_home.clone();
        inner.hermes_home_base = hermes_home;
        inner.current_profile = "default".to_string();
        inner.connection_mode = ConnectionMode::Local;
        inner.yolo_mode = false;
        inner.last_runtime_error = None;
        inner.dashboard_handle = Some(DashboardHandle::local(
            base_url.clone(),
            Some(token.clone()),
        ));
    }

    log::info!(
        "Connection switched to local Hermes Agent CLI at {}",
        base_url
    );
    Ok(ApplyConnectionResult {
        ok: true,
        mode: "local".to_string(),
        api_base_url: Some(base_url),
        gateway_url: Some(gateway_url),
        session_token: Some(token),
        error: None,
    })
}

/// Switch back to the desktop managed runtime. Runs the full bootstrap acquire
/// path — a remote-first install may not even have a managed runtime on disk
/// yet, so this can download one (with runtime-status progress events).
async fn apply_managed(
    app: &tauri::AppHandle,
    state: &State<'_, AppState>,
) -> Result<ApplyConnectionResult, AppError> {
    let (already_managed, api_base_url, gateway_url, session_token) = {
        let inner = state.inner.lock()?;
        (
            inner.connection_mode == ConnectionMode::Managed && inner.dashboard_handle.is_some(),
            inner.api_base_url.clone(),
            inner.gateway_url.clone(),
            inner.session_token.clone(),
        )
    };
    if already_managed {
        return Ok(ApplyConnectionResult {
            ok: true,
            mode: "managed".to_string(),
            api_base_url: Some(api_base_url),
            gateway_url: Some(gateway_url),
            session_token,
            error: None,
        });
    }

    let hermes_home_base = runtime::hermes_home_dir().to_string_lossy().to_string();
    let mut current_profile =
        crate::commands::profiles::read_active_profile_sticky(&hermes_home_base);
    let mut hermes_home = if current_profile == "default" {
        runtime::hermes_home_dir()
    } else {
        runtime::hermes_home_dir()
            .join("profiles")
            .join(&current_profile)
    };
    if current_profile != "default" && !hermes_home.exists() {
        log::warn!(
            "saved managed profile {} points to missing {}; falling back to default",
            current_profile,
            hermes_home.display()
        );
        current_profile = "default".to_string();
        hermes_home = runtime::hermes_home_dir();
        let _ = std::fs::remove_file(runtime::hermes_home_dir().join("active_profile"));
    }
    let hermes_home = hermes_home.to_string_lossy().to_string();

    // Drop the attachment (stop_with_token is a no-op for it).
    detach_current_backend(state)?;

    let (host, port) = restart::host_and_port();
    let options = dashboard::EnsureDashboardOptions {
        host,
        port,
        hermes_home: hermes_home.clone(),
        allow_external_agent: dashboard::external_agent_allowed(),
        allow_port_fallback: true,
        connection_mode: crate::connection::ConnectionMode::Managed,
        remote_base_url: None,
    };
    let resource_dir = app.path().resource_dir().ok();

    let handle =
        match crate::bootstrap::acquire_managed_dashboard(app, options, resource_dir, true).await {
            Ok(handle) => handle,
            Err(err) => {
                return Ok(ApplyConnectionResult {
                    ok: false,
                    mode: "managed".to_string(),
                    error: Some(format!("本地内核启动失败：{}", err)),
                    ..Default::default()
                })
            }
        };

    let token = match handle.session_token.clone() {
        Some(token) => Some(token),
        None => match std::env::var("HERMES_DESKTOP_SESSION_TOKEN")
            .ok()
            .or_else(|| std::env::var("HERMES_DASHBOARD_SESSION_TOKEN").ok())
        {
            Some(token) => Some(token),
            None => dashboard::fetch_session_token(&handle.api_base_url).await,
        },
    };
    let gateway_url = dashboard::build_gateway_url(&handle.api_base_url, token.as_deref());
    let api_base_url = handle.api_base_url.clone();

    {
        let mut inner = state.inner.lock()?;
        inner.api_base_url = api_base_url.clone();
        inner.gateway_url = gateway_url.clone();
        inner.session_token = token.clone();
        inner.hermes_home = hermes_home.clone();
        inner.hermes_home_base = hermes_home_base;
        inner.current_profile = current_profile;
        inner.connection_mode = ConnectionMode::Managed;
        inner.yolo_mode = dashboard::yolo_mode_effective(&hermes_home);
        inner.last_runtime_error = None;
        inner.dashboard_handle = Some(handle);
    }

    log::info!("Connection switched back to desktop managed runtime");
    Ok(ApplyConnectionResult {
        ok: true,
        mode: "managed".to_string(),
        api_base_url: Some(api_base_url),
        gateway_url: Some(gateway_url),
        session_token: token,
        error: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    fn remote_config() -> ConnectionConfig {
        ConnectionConfig {
            mode: ConnectionMode::Remote,
            local_url: Some(connection::DEFAULT_LOCAL_DASHBOARD_URL.to_string()),
            remote_url: Some("http://host:9221".to_string()),
            remote_token: Some("saved-token".to_string()),
            remote_auth_mode: connection::RemoteAuthMode::Token,
            remote_session: None,
        }
    }

    #[test]
    fn coerce_defaults_to_managed_keeping_saved_fields() {
        let coerced = coerce_config(&remote_config(), &ConnectionConfigInput::default()).unwrap();
        assert_eq!(coerced.mode, ConnectionMode::Managed);
        assert_eq!(
            coerced.local_url.as_deref(),
            Some(connection::DEFAULT_LOCAL_DASHBOARD_URL)
        );
        assert_eq!(coerced.remote_url.as_deref(), Some("http://host:9221"));
        assert_eq!(coerced.remote_token.as_deref(), Some("saved-token"));
    }

    #[test]
    fn coerce_local_defaults_to_loopback_cli_url() {
        let input = ConnectionConfigInput {
            mode: Some("local".to_string()),
            ..Default::default()
        };
        let coerced = coerce_config(&ConnectionConfig::default(), &input).unwrap();
        assert_eq!(coerced.mode, ConnectionMode::Local);
        assert_eq!(
            coerced.local_url.as_deref(),
            Some(connection::DEFAULT_LOCAL_DASHBOARD_URL)
        );
    }

    #[test]
    fn coerce_local_rejects_non_loopback_url() {
        let input = ConnectionConfigInput {
            mode: Some("local".to_string()),
            local_url: Some("http://192.168.1.10:9119".to_string()),
            ..Default::default()
        };
        assert!(coerce_config(&ConnectionConfig::default(), &input).is_err());
    }

    #[test]
    fn coerce_empty_token_keeps_saved_secret() {
        let input = ConnectionConfigInput {
            mode: Some("remote".to_string()),
            remote_url: Some("http://new-host:9120/".to_string()),
            remote_token: Some("   ".to_string()),
            ..Default::default()
        };
        let coerced = coerce_config(&remote_config(), &input).unwrap();
        assert_eq!(coerced.mode, ConnectionMode::Remote);
        assert_eq!(coerced.remote_url.as_deref(), Some("http://new-host:9120"));
        assert_eq!(coerced.remote_token.as_deref(), Some("saved-token"));
    }

    #[test]
    fn coerce_remote_without_url_is_rejected() {
        let input = ConnectionConfigInput {
            mode: Some("remote".to_string()),
            ..Default::default()
        };
        assert!(coerce_config(&ConnectionConfig::default(), &input).is_err());
    }

    #[test]
    fn coerce_remote_without_token_is_rejected() {
        let input = ConnectionConfigInput {
            mode: Some("remote".to_string()),
            remote_url: Some("http://host:9221".to_string()),
            remote_token: None,
            ..Default::default()
        };
        assert!(coerce_config(&ConnectionConfig::default(), &input).is_err());
    }

    #[test]
    fn coerce_rejects_unknown_mode_and_bad_url() {
        let bad_mode = ConnectionConfigInput {
            mode: Some("oauth".to_string()),
            ..Default::default()
        };
        assert!(coerce_config(&ConnectionConfig::default(), &bad_mode).is_err());

        let bad_url = ConnectionConfigInput {
            mode: Some("remote".to_string()),
            remote_url: Some("ftp://host".to_string()),
            remote_token: Some("tok".to_string()),
            ..Default::default()
        };
        assert!(coerce_config(&ConnectionConfig::default(), &bad_url).is_err());
    }

    #[test]
    fn coerce_explicit_empty_url_clears_saved_value() {
        let input = ConnectionConfigInput {
            mode: Some("managed".to_string()),
            remote_url: Some("".to_string()),
            remote_token: None,
            ..Default::default()
        };
        let coerced = coerce_config(&remote_config(), &input).unwrap();
        assert_eq!(coerced.remote_url, None);
        assert_eq!(coerced.remote_token.as_deref(), Some("saved-token"));
    }
}
