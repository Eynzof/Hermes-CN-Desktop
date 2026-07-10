//! Interactive login for gated remote gateways (OAuth window + password form).
//!
//! Mirrors the official desktop's `openOauthLoginWindow` / password flow
//! (Hermes-CN-Core apps/desktop/electron/main.ts): open `{base}/login` in a
//! dedicated webview, let the user complete the IDP round-trip, then read the
//! resulting HttpOnly `hermes_session_at`/`rt` cookies out of the webview and
//! hand them to the Rust `OauthSession` cookie jar. Password providers skip
//! the webview entirely — a Rust `POST /auth/password-login` lands the same
//! Set-Cookie into the jar.
//!
//! The cookie session is verified (mint a ws-ticket + fetch identity) before
//! we report success, and persisted into connection.json so a saved login
//! survives restarts.

use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

use crate::connection;
use crate::error::{AppError, AppResult};
use crate::oauth_session::{
    self, AuthIdentity, PersistedCookie, AT_COOKIE_VARIANTS, RT_COOKIE_VARIANTS,
};
use crate::state::AppState;

const LOGIN_WINDOW_LABEL: &str = "hermes-oauth-login";
const LOGIN_POLL_INTERVAL: Duration = Duration::from_millis(750);
const LOGIN_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OauthLoginInput {
    pub remote_url: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PasswordLoginInput {
    pub remote_url: String,
    pub provider: String,
    pub username: String,
    pub password: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OauthLoginResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub identity: Option<AuthIdentity>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// In-progress logins, keyed by normalized base URL — single-flight so a
/// second click focuses the existing window instead of stacking a new one.
fn in_flight() -> &'static Mutex<std::collections::HashSet<String>> {
    static SET: OnceLock<Mutex<std::collections::HashSet<String>>> = OnceLock::new();
    SET.get_or_init(|| Mutex::new(std::collections::HashSet::new()))
}

/// Persist the current session cookies into connection.json when it is the
/// configured oauth remote for this URL (so a fresh login is remembered).
fn persist_login(base_url: &str, cookies: Vec<PersistedCookie>) {
    let mut config = connection::read_config();
    let is_target = config.remote_url.as_deref() == Some(base_url);
    if is_target {
        config.remote_session = Some(cookies);
        if config.remote_auth_mode == connection::RemoteAuthMode::Token {
            config.remote_auth_mode = connection::RemoteAuthMode::Oauth;
        }
        let _ = connection::write_config(&config);
    }
}

/// Verify a freshly-populated session (mint ticket + identity) and persist it.
async fn finish_login(
    base_url: &str,
    session: &oauth_session::OauthSession,
) -> Result<AuthIdentity, AppError> {
    // A live ticket already proves the session; identity is best-effort.
    session.mint_ws_ticket().await?; // 401 → AuthSessionExpired
    let identity = session.fetch_me().await.unwrap_or(AuthIdentity {
        user_id: None,
        email: None,
        display_name: None,
        org_id: None,
        provider: None,
        expires_at: None,
    });
    persist_login(base_url, session.export_cookies());
    Ok(identity)
}

/// Open the OAuth login window and wait for the session cookie to appear.
#[tauri::command]
pub async fn connection_oauth_login(
    input: OauthLoginInput,
    app: tauri::AppHandle,
) -> Result<OauthLoginResult, AppError> {
    let base_url = connection::normalize_remote_base_url(&input.remote_url)?;

    // Single-flight: focus the existing window if a login is already open.
    {
        let mut guard = in_flight().lock().unwrap();
        if guard.contains(&base_url) {
            if let Some(win) = app.get_webview_window(LOGIN_WINDOW_LABEL) {
                let _ = win.set_focus();
            }
            return Err(AppError::InvalidRequest(
                "登录窗口已打开，请在窗口内完成登录".to_string(),
            ));
        }
        guard.insert(base_url.clone());
    }
    // Ensure we always clear the in-flight marker.
    let _guard = InFlightGuard(base_url.clone());

    let login_url = format!("{}/login", base_url);
    let url = url::Url::parse(&login_url)
        .map_err(|e| AppError::InvalidRequest(format!("invalid login url {login_url}: {e}")))?;

    // A prior window may linger if a previous attempt was force-closed.
    if let Some(existing) = app.get_webview_window(LOGIN_WINDOW_LABEL) {
        let _ = existing.destroy();
    }
    let window = WebviewWindowBuilder::new(&app, LOGIN_WINDOW_LABEL, WebviewUrl::External(url))
        .title("登录远程 Hermes Agent")
        .inner_size(520.0, 720.0)
        .build()
        .map_err(|e| AppError::Internal(format!("open login window: {e}")))?;

    let session = oauth_session::session_for(&base_url)?;
    let probe_url = url::Url::parse(&base_url)
        .map_err(|e| AppError::InvalidRequest(format!("invalid base url: {e}")))?;

    let start = std::time::Instant::now();
    loop {
        // Window closed by the user before completing.
        if app.get_webview_window(LOGIN_WINDOW_LABEL).is_none() {
            return Ok(OauthLoginResult {
                ok: false,
                identity: None,
                error: Some("登录窗口已关闭".to_string()),
            });
        }
        if start.elapsed() > LOGIN_TIMEOUT {
            let _ = window.destroy();
            return Ok(OauthLoginResult {
                ok: false,
                identity: None,
                error: Some("登录超时（5 分钟）".to_string()),
            });
        }

        // Read cookies out of the webview (includes HttpOnly). Windows/WebView2
        // deadlocks if this is called from a sync command — we are inside an
        // async task, which is the documented-safe context.
        if let Ok(cookies) = window.cookies_for_url(probe_url.clone()) {
            let extracted = extract_session_cookies(&cookies);
            if extracted.iter().any(|c| is_at_variant(&c.name)) {
                session.import_cookies(&extracted);
                match finish_login(&base_url, &session).await {
                    Ok(identity) => {
                        let _ = window.destroy();
                        return Ok(OauthLoginResult {
                            ok: true,
                            identity: Some(identity),
                            error: None,
                        });
                    }
                    // Cookie present but not yet usable (mid-redirect); keep waiting.
                    Err(AppError::AuthSessionExpired(_)) => {}
                    Err(other) => {
                        let _ = window.destroy();
                        return Err(other);
                    }
                }
            }
        }
        tokio::time::sleep(LOGIN_POLL_INTERVAL).await;
    }
}

/// Password-provider login (no webview): POST credentials, land Set-Cookie.
#[tauri::command]
pub async fn connection_password_login(
    input: PasswordLoginInput,
) -> Result<OauthLoginResult, AppError> {
    let base_url = connection::normalize_remote_base_url(&input.remote_url)?;
    let session = oauth_session::session_for(&base_url)?;
    let url = format!("{}/auth/password-login", base_url);

    let resp = session
        .client()
        .post(&url)
        .json(&serde_json::json!({
            "provider": input.provider,
            "username": input.username,
            "password": input.password,
        }))
        .send()
        .await
        .map_err(|e| AppError::DashboardProbe(format!("password login request: {e}")))?;

    let status = resp.status().as_u16();
    match status {
        s if (200..300).contains(&s) => {}
        401 => {
            return Ok(OauthLoginResult {
                ok: false,
                identity: None,
                error: Some("用户名或密码错误".to_string()),
            })
        }
        404 => {
            return Ok(OauthLoginResult {
                ok: false,
                identity: None,
                error: Some("该网关不支持密码登录（provider 未启用）".to_string()),
            })
        }
        429 => {
            return Ok(OauthLoginResult {
                ok: false,
                identity: None,
                error: Some("尝试过于频繁，请稍后再试".to_string()),
            })
        }
        503 => {
            return Ok(OauthLoginResult {
                ok: false,
                identity: None,
                error: Some("网关未注册任何登录方式".to_string()),
            })
        }
        other => {
            return Ok(OauthLoginResult {
                ok: false,
                identity: None,
                error: Some(format!("登录失败（HTTP {other}）")),
            })
        }
    }

    match finish_login(&base_url, &session).await {
        Ok(identity) => Ok(OauthLoginResult {
            ok: true,
            identity: Some(identity),
            error: None,
        }),
        Err(AppError::AuthSessionExpired(_)) => Ok(OauthLoginResult {
            ok: false,
            identity: None,
            error: Some("登录未生效，请重试".to_string()),
        }),
        Err(other) => Err(other),
    }
}

/// Return the logged-in identity for a URL, or `ok:false` if not authenticated.
#[tauri::command]
pub async fn connection_auth_me(input: OauthLoginInput) -> Result<OauthLoginResult, AppError> {
    let base_url = connection::normalize_remote_base_url(&input.remote_url)?;
    let session = oauth_session::session_for(&base_url)?;
    if let Some(cookies) = connection::read_config().remote_session {
        session.import_cookies(&cookies);
    }
    match session.fetch_me().await {
        Ok(identity) => Ok(OauthLoginResult {
            ok: true,
            identity: Some(identity),
            error: None,
        }),
        Err(_) => Ok(OauthLoginResult {
            ok: false,
            identity: None,
            error: None,
        }),
    }
}

/// Log out: best-effort revoke on the server, clear the jar, persisted session,
/// and (if open) the login window's browsing data.
#[tauri::command]
pub async fn connection_oauth_logout(
    input: OauthLoginInput,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> AppResult<()> {
    let base_url = connection::normalize_remote_base_url(&input.remote_url)?;
    let session = oauth_session::session_for(&base_url)?;
    // Best-effort server-side revoke so the refresh token is invalidated.
    let _ = session
        .client()
        .post(format!("{}/auth/logout", base_url))
        .send()
        .await;
    session.clear();
    oauth_session::drop_session(&base_url);

    // Clear persisted session cookies.
    let mut config = connection::read_config();
    if config.remote_url.as_deref() == Some(base_url.as_str()) {
        config.remote_session = None;
        let _ = connection::write_config(&config);
    }

    // If the live connection uses this session, drop it so REST/WS stop.
    {
        let mut inner = state.inner.lock()?;
        if inner.api_base_url == base_url {
            inner.oauth_session = None;
        }
    }

    // Best-effort: clear the login webview's cookies for a clean re-login.
    if let Some(win) = app.get_webview_window(LOGIN_WINDOW_LABEL) {
        let _ = win.clear_all_browsing_data();
        let _ = win.destroy();
    }
    Ok(())
}

fn is_at_variant(name: &str) -> bool {
    AT_COOKIE_VARIANTS.contains(&name)
}

fn is_session_cookie(name: &str) -> bool {
    AT_COOKIE_VARIANTS.contains(&name) || RT_COOKIE_VARIANTS.contains(&name)
}

/// Pull just the session AT/RT cookies out of the webview's cookie list.
fn extract_session_cookies(cookies: &[cookie::Cookie<'static>]) -> Vec<PersistedCookie> {
    cookies
        .iter()
        .filter(|c| is_session_cookie(c.name()))
        .map(|c| PersistedCookie {
            name: c.name().to_string(),
            value: c.value().to_string(),
            expires_at_ms: c
                .expires_datetime()
                .map(|t| (t.unix_timestamp().max(0) as u64) * 1000),
        })
        .collect()
}

/// RAII marker clearing the single-flight entry when a login attempt ends.
struct InFlightGuard(String);
impl Drop for InFlightGuard {
    fn drop(&mut self) {
        in_flight().lock().unwrap().remove(&self.0);
    }
}
