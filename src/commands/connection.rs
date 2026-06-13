// Connection-config commands: local managed runtime vs remote Hermes Agent.
//
// IPC surface mirrors the official desktop (Hermes-CN-Core apps/desktop
// preload: getConnectionConfig / saveConnectionConfig / applyConnectionConfig /
// testConnectionConfig / probeConnectionConfig), token-auth only.
//
// `apply_connection_config` switches modes live, without an app restart:
//   - local → remote: probe the remote FIRST (fail fast leaving the local
//     dashboard untouched), then stop the owned dashboard and adopt the remote
//     connection into AppState.
//   - remote → local: run the full bootstrap acquire path (which can download
//     a managed runtime on a machine that has never run local) and adopt the
//     spawned dashboard.
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
    pub remote_url: Option<String>,
    /// Empty/absent keeps the previously saved token (so the user can edit the
    /// URL without re-entering the secret), matching the official desktop's
    /// coerce behavior.
    pub remote_token: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeConnectionResult {
    pub reachable: bool,
    pub auth_required: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
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
        Some("remote") => ConnectionMode::Remote,
        Some("local") | None => ConnectionMode::Local,
        Some(other) => {
            return Err(AppError::InvalidRequest(format!(
                "未知的连接模式: {}",
                other
            )))
        }
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

    if mode == ConnectionMode::Remote {
        if remote_url.is_none() {
            return Err(AppError::InvalidRequest(
                "远程模式需要填写远程 Hermes Agent 地址".to_string(),
            ));
        }
        if remote_token.is_none() {
            return Err(AppError::InvalidRequest(
                "远程模式需要填写 session token".to_string(),
            ));
        }
    }

    Ok(ConnectionConfig {
        mode,
        remote_url,
        remote_token,
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

/// Resolve the URL/token a test should run against: explicit form input wins,
/// then the env override, then the saved config.
fn test_target(input: &ConnectionConfigInput) -> AppResult<(String, String)> {
    let saved = connection::read_config();
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

    Ok((connection::normalize_remote_base_url(&raw_url)?, token))
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
        Ok((status, body)) => Ok(ProbeConnectionResult {
            // Mirror dashboard::probe_dashboard: 2xx or 401 both prove a
            // dashboard is answering; 401 just means status is token-gated.
            reachable: (200..300).contains(&status) || status == 401,
            auth_required: status_field(&body, "auth_required")
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
            version: status_field(&body, "version")
                .and_then(|v| v.as_str())
                .map(str::to_string),
        }),
        Err(_) => Ok(ProbeConnectionResult {
            reachable: false,
            auth_required: false,
            version: None,
        }),
    }
}

/// Authenticated two-step connection test: HTTP `/api/status` with the token
/// headers, then a real WebSocket handshake against `/api/ws?token=` — the
/// same transport the app uses, so a passing test means the app can connect.
#[tauri::command]
pub async fn test_connection_config(
    input: ConnectionConfigInput,
) -> Result<TestConnectionResult, AppError> {
    let (base_url, token) = test_target(&input)?;

    let mut result = TestConnectionResult {
        base_url: base_url.clone(),
        ..Default::default()
    };

    match fetch_status(&base_url, Some(&token)).await {
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
                result.error = Some("token 无效或已过期（HTTP 401）".to_string());
            } else if !result.http_ok {
                result.error = Some(format!("远程返回 HTTP {}", status));
            }
        }
        Err(err) => {
            result.error = Some(format!("无法连接远程地址: {}", err));
            return Ok(result);
        }
    }

    if result.auth_required {
        result.error =
            Some("该网关启用了 OAuth 登录，当前版本仅支持 session token 认证".to_string());
        return Ok(result);
    }

    result.ws_ok = dashboard::dashboard_supports_ws(&base_url, Some(&token)).await;
    if result.http_ok && !result.ws_ok {
        result.error = Some(
            "HTTP 可达但 WebSocket（/api/ws）握手失败：检查代理/防火墙是否放行 WS，以及 token 是否正确".to_string(),
        );
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
        ConnectionMode::Remote => apply_remote(&state, &config).await,
        ConnectionMode::Local => apply_local(&app, &state).await,
    };

    restart::end_restart(&state);
    result
}

/// Switch the running desktop onto a remote Hermes Agent. The remote is probed
/// before anything local is torn down, so a bad URL/token leaves the current
/// backend untouched.
async fn apply_remote(
    state: &State<'_, AppState>,
    config: &ConnectionConfig,
) -> Result<ApplyConnectionResult, AppError> {
    // coerce_config guarantees both are present in remote mode.
    let base_url = config.remote_url.clone().unwrap_or_default();
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

    // Tear down the local side: stop the WS relay, then gracefully stop the
    // owned dashboard (a no-op for remote/external handles).
    {
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
    }

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

/// Switch back to the local managed runtime. Runs the full bootstrap acquire
/// path — a remote-first install may not even have a managed runtime on disk
/// yet, so this can download one (with runtime-status progress events).
async fn apply_local(
    app: &tauri::AppHandle,
    state: &State<'_, AppState>,
) -> Result<ApplyConnectionResult, AppError> {
    let (hermes_home, already_local) = {
        let inner = state.inner.lock()?;
        (
            inner.hermes_home.clone(),
            inner.connection_mode == ConnectionMode::Local && inner.dashboard_handle.is_some(),
        )
    };
    if already_local {
        let inner = state.inner.lock()?;
        return Ok(ApplyConnectionResult {
            ok: true,
            mode: "local".to_string(),
            api_base_url: Some(inner.api_base_url.clone()),
            gateway_url: Some(inner.gateway_url.clone()),
            session_token: inner.session_token.clone(),
            error: None,
        });
    }

    // Drop the remote attachment (stop_with_token is a no-op for it).
    {
        let mut inner = state.inner.lock()?;
        if let Some(relay) = inner.gateway_ws.take() {
            relay
                .abort
                .store(true, std::sync::atomic::Ordering::Relaxed);
            relay.notify.notify_waiters();
        }
        inner.dashboard_handle = None;
    }

    let (host, port) = restart::host_and_port();
    let options = dashboard::EnsureDashboardOptions {
        host,
        port,
        hermes_home: hermes_home.clone(),
        allow_external_agent: dashboard::external_agent_allowed(),
        allow_port_fallback: true,
    };
    let resource_dir = app.path().resource_dir().ok();

    let handle =
        match crate::bootstrap::acquire_managed_dashboard(app, options, resource_dir, true).await {
            Ok(handle) => handle,
            Err(err) => {
                return Ok(ApplyConnectionResult {
                    ok: false,
                    mode: "local".to_string(),
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
        inner.connection_mode = ConnectionMode::Local;
        inner.yolo_mode = dashboard::yolo_mode_effective(&hermes_home);
        inner.last_runtime_error = None;
        inner.dashboard_handle = Some(handle);
    }

    log::info!("Connection switched back to local managed runtime");
    Ok(ApplyConnectionResult {
        ok: true,
        mode: "local".to_string(),
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
            remote_url: Some("http://host:9221".to_string()),
            remote_token: Some("saved-token".to_string()),
        }
    }

    #[test]
    fn coerce_defaults_to_local_keeping_remote_fields() {
        let coerced = coerce_config(&remote_config(), &ConnectionConfigInput::default()).unwrap();
        assert_eq!(coerced.mode, ConnectionMode::Local);
        assert_eq!(coerced.remote_url.as_deref(), Some("http://host:9221"));
        assert_eq!(coerced.remote_token.as_deref(), Some("saved-token"));
    }

    #[test]
    fn coerce_empty_token_keeps_saved_secret() {
        let input = ConnectionConfigInput {
            mode: Some("remote".to_string()),
            remote_url: Some("http://new-host:9120/".to_string()),
            remote_token: Some("   ".to_string()),
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
        };
        assert!(coerce_config(&ConnectionConfig::default(), &bad_url).is_err());
    }

    #[test]
    fn coerce_explicit_empty_url_clears_saved_value() {
        let input = ConnectionConfigInput {
            mode: Some("local".to_string()),
            remote_url: Some("".to_string()),
            remote_token: None,
        };
        let coerced = coerce_config(&remote_config(), &input).unwrap();
        assert_eq!(coerced.remote_url, None);
        assert_eq!(coerced.remote_token.as_deref(), Some("saved-token"));
    }
}
