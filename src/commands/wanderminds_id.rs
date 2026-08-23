use std::collections::HashMap;
use std::net::Ipv4Addr;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use url::Url;

use crate::error::{AppError, AppResult};

const CLIENT_ID: &str = "a89c9gb12i6228xc29cxl";
const AUTH_ENDPOINT: &str = "https://id.wanderminds.ai/oidc/auth";
const TOKEN_ENDPOINT: &str = "https://id.wanderminds.ai/oidc/token";
const USERINFO_ENDPOINT: &str = "https://id.wanderminds.ai/oidc/me";
const REVOCATION_ENDPOINT: &str = "https://id.wanderminds.ai/oidc/token/revocation";
const PORTAL_RESOURCE: &str = "https://portal.wanderminds.ai/api";
const SCOPES: &str = "openid profile email offline_access portal:read inference:invoke";
/// 换取 refresh_token 的前提：Logto 只在显式 consent 时授予 offline_access。
const PROMPT: &str = "consent";
const CALLBACK_PATH: &str = "/callback";
const REDIRECT_PORTS: [u16; 3] = [17171, 17172, 17173];
const LOGIN_TIMEOUT: Duration = Duration::from_secs(300);
const HTTP_TIMEOUT: Duration = Duration::from_secs(30);
const CALLBACK_READ_TIMEOUT: Duration = Duration::from_secs(3);
const TOKEN_EXPIRY_SKEW_SECS: u64 = 60;

const KEYCHAIN_SERVICE: &str = "cn.org.hermesagent.desktop.wanderminds-id";
const KEYCHAIN_ACCOUNT: &str = "refresh-token";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UserInfo {
    pub sub: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AuthResult {
    pub user: UserInfo,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredRefreshToken {
    refresh_token: String,
    expires_at: Option<u64>,
}

#[derive(Debug, Clone)]
struct RuntimeTokens {
    access_token: String,
    access_expires_at: u64,
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    expires_in: Option<u64>,
    #[serde(default)]
    refresh_token_expires_in: Option<u64>,
    #[serde(default)]
    refresh_expires_in: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct TokenErrorResponse {
    error: String,
    #[serde(default)]
    error_description: Option<String>,
}

#[derive(Debug)]
struct OidcTokens {
    access_token: String,
    access_expires_at: u64,
    refresh_token: Option<String>,
    refresh_expires_at: Option<u64>,
}

#[derive(Debug)]
struct CallbackCode {
    code: String,
}

#[derive(Debug)]
enum CallbackOutcome {
    Code(CallbackCode),
    Continue,
}

fn runtime_tokens() -> &'static Mutex<Option<RuntimeTokens>> {
    static TOKENS: OnceLock<Mutex<Option<RuntimeTokens>>> = OnceLock::new();
    TOKENS.get_or_init(|| Mutex::new(None))
}

fn login_in_flight() -> &'static Mutex<bool> {
    static IN_FLIGHT: OnceLock<Mutex<bool>> = OnceLock::new();
    IN_FLIGHT.get_or_init(|| Mutex::new(false))
}

fn refresh_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn random_urlsafe(bytes_len: usize) -> AppResult<String> {
    let mut bytes = vec![0u8; bytes_len];
    getrandom::fill(&mut bytes)
        .map_err(|e| AppError::Internal(format!("generate random bytes: {e}")))?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

fn generate_pkce_pair() -> AppResult<(String, String)> {
    let verifier = random_urlsafe(32)?;
    let digest = Sha256::digest(verifier.as_bytes());
    let challenge = URL_SAFE_NO_PAD.encode(digest);
    Ok((verifier, challenge))
}

fn auth_url(redirect_uri: &str, state: &str, code_challenge: &str) -> AppResult<String> {
    let mut url = Url::parse(AUTH_ENDPOINT)
        .map_err(|e| AppError::Internal(format!("invalid Wanderminds ID auth endpoint: {e}")))?;
    url.query_pairs_mut()
        .append_pair("client_id", CLIENT_ID)
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("response_type", "code")
        .append_pair("scope", SCOPES)
        .append_pair("resource", PORTAL_RESOURCE)
        .append_pair("state", state)
        .append_pair("code_challenge", code_challenge)
        .append_pair("code_challenge_method", "S256")
        // Logto 内核 node-oidc-provider 只在 prompt=consent 时才把 offline_access
        // 计入已授予 scope；缺这个参数时 token 响应会静默降级为
        // `openid profile email` 且不带 refresh_token，登录随即失败在
        // "token response missing refresh_token"。实测确认，勿删。
        .append_pair("prompt", PROMPT);
    Ok(url.to_string())
}

fn http_client() -> AppResult<reqwest::Client> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(HTTP_TIMEOUT)
        .build()
        .map_err(|e| AppError::Internal(format!("build Wanderminds ID http client: {e}")))
}

fn access_expires_at(expires_in: Option<u64>) -> u64 {
    now_secs()
        .saturating_add(expires_in.unwrap_or(3600))
        .saturating_sub(TOKEN_EXPIRY_SKEW_SECS)
}

fn refresh_expires_at(tokens: &TokenResponse) -> Option<u64> {
    tokens
        .refresh_token_expires_in
        .or(tokens.refresh_expires_in)
        .map(|ttl| now_secs().saturating_add(ttl))
}

fn remember_access_token(access_token: String, access_expires_at: u64) {
    let mut guard = runtime_tokens().lock().unwrap();
    *guard = Some(RuntimeTokens {
        access_token,
        access_expires_at,
    });
}

fn clear_runtime_tokens() {
    let mut guard = runtime_tokens().lock().unwrap();
    *guard = None;
}

fn current_access_token() -> Option<String> {
    let guard = runtime_tokens().lock().unwrap();
    guard.as_ref().and_then(|tokens| {
        (tokens.access_expires_at > now_secs()).then(|| tokens.access_token.clone())
    })
}

fn current_access_token_with_expiry() -> Option<(String, u64)> {
    let guard = runtime_tokens().lock().unwrap();
    guard.as_ref().and_then(|tokens| {
        (tokens.access_expires_at > now_secs())
            .then(|| (tokens.access_token.clone(), tokens.access_expires_at))
    })
}

/// Resolve a short-lived Portal audience access token without exposing the
/// refresh token outside this module. The managed Core token broker and the
/// native Portal IPC commands are the only callers.
pub(crate) async fn access_token_for_portal() -> AppResult<(String, u64)> {
    if let Some(tokens) = current_access_token_with_expiry() {
        return Ok(tokens);
    }

    let client = http_client()?;
    refresh_from_keychain(&client).await?.ok_or_else(|| {
        AppError::AuthSessionExpired("Wanderminds ID refresh token missing".to_string())
    })?;
    current_access_token_with_expiry().ok_or_else(|| {
        AppError::AuthSessionExpired("Wanderminds ID access token missing".to_string())
    })
}

async fn exchange_authorization_code(
    client: &reqwest::Client,
    code: &str,
    redirect_uri: &str,
    code_verifier: &str,
) -> AppResult<OidcTokens> {
    let mut form = HashMap::new();
    form.insert("grant_type", "authorization_code".to_string());
    form.insert("client_id", CLIENT_ID.to_string());
    form.insert("code", code.to_string());
    form.insert("redirect_uri", redirect_uri.to_string());
    form.insert("code_verifier", code_verifier.to_string());
    form.insert("resource", PORTAL_RESOURCE.to_string());
    post_token_form(client, form).await
}

async fn refresh_access_token(
    client: &reqwest::Client,
    refresh_token: &str,
) -> AppResult<OidcTokens> {
    let mut form = HashMap::new();
    form.insert("grant_type", "refresh_token".to_string());
    form.insert("client_id", CLIENT_ID.to_string());
    form.insert("refresh_token", refresh_token.to_string());
    form.insert("resource", PORTAL_RESOURCE.to_string());
    post_token_form(client, form).await
}

async fn post_token_form(
    client: &reqwest::Client,
    form: HashMap<&'static str, String>,
) -> AppResult<OidcTokens> {
    let response = client
        .post(TOKEN_ENDPOINT)
        .form(&form)
        .send()
        .await
        .map_err(|e| AppError::DashboardProbe(format!("Wanderminds ID token request: {e}")))?;
    let status = response.status();
    let body = response.text().await.map_err(|e| {
        AppError::DashboardProbe(format!("read Wanderminds ID token response: {e}"))
    })?;

    if !status.is_success() {
        if let Ok(err) = serde_json::from_str::<TokenErrorResponse>(&body) {
            let code = err.error;
            let description = err.error_description.unwrap_or_else(|| code.clone());
            if code == "invalid_grant" {
                return Err(AppError::AuthSessionExpired(description));
            }
            return Err(AppError::DashboardProbe(format!(
                "Wanderminds ID token endpoint returned {code}: {description}"
            )));
        }
        return Err(AppError::DashboardProbe(format!(
            "Wanderminds ID token endpoint returned HTTP {}",
            status.as_u16()
        )));
    }

    let parsed: TokenResponse = serde_json::from_str(&body).map_err(|e| {
        AppError::DashboardProbe(format!("parse Wanderminds ID token response: {e}"))
    })?;
    Ok(OidcTokens {
        access_expires_at: access_expires_at(parsed.expires_in),
        refresh_expires_at: refresh_expires_at(&parsed),
        access_token: parsed.access_token,
        refresh_token: parsed.refresh_token,
    })
}

async fn fetch_user_info(client: &reqwest::Client, access_token: &str) -> AppResult<UserInfo> {
    let response = client
        .get(USERINFO_ENDPOINT)
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|e| AppError::DashboardProbe(format!("Wanderminds ID userinfo request: {e}")))?;
    if response.status().as_u16() == 401 {
        return Err(AppError::AuthSessionExpired(
            "Wanderminds ID access token expired".to_string(),
        ));
    }
    if !response.status().is_success() {
        return Err(AppError::DashboardProbe(format!(
            "Wanderminds ID userinfo returned HTTP {}",
            response.status().as_u16()
        )));
    }
    response
        .json::<UserInfo>()
        .await
        .map_err(|e| AppError::DashboardProbe(format!("parse Wanderminds ID userinfo: {e}")))
}

fn store_refresh_token(refresh_token: String, expires_at: Option<u64>) -> AppResult<()> {
    let stored = StoredRefreshToken {
        refresh_token,
        expires_at,
    };
    let payload = serde_json::to_string(&stored)
        .map_err(|e| AppError::Internal(format!("serialize Wanderminds ID token: {e}")))?;
    keychain::set_password(&payload)
}

fn read_refresh_token() -> AppResult<Option<StoredRefreshToken>> {
    let Some(payload) = keychain::get_password()? else {
        return Ok(None);
    };
    let parsed: StoredRefreshToken = serde_json::from_str(&payload)
        .map_err(|e| AppError::Internal(format!("parse Wanderminds ID keychain item: {e}")))?;
    if parsed
        .expires_at
        .map(|expires_at| expires_at <= now_secs())
        .unwrap_or(false)
    {
        let _ = keychain::delete_password();
        return Ok(None);
    }
    Ok(Some(parsed))
}

fn clear_refresh_token() -> AppResult<()> {
    keychain::delete_password()
}

async fn refresh_from_keychain(client: &reqwest::Client) -> AppResult<Option<String>> {
    let _guard = refresh_lock().lock().await;
    let Some(stored) = read_refresh_token()? else {
        clear_runtime_tokens();
        return Ok(None);
    };

    match refresh_access_token(client, &stored.refresh_token).await {
        Ok(tokens) => {
            let refresh_token = tokens.refresh_token.clone().unwrap_or(stored.refresh_token);
            store_refresh_token(
                refresh_token,
                tokens.refresh_expires_at.or(stored.expires_at),
            )?;
            remember_access_token(tokens.access_token.clone(), tokens.access_expires_at);
            Ok(Some(tokens.access_token))
        }
        Err(AppError::AuthSessionExpired(_)) => {
            let _ = clear_refresh_token();
            clear_runtime_tokens();
            Ok(None)
        }
        Err(err) => Err(err),
    }
}

async fn user_from_current_or_refresh(client: &reqwest::Client) -> AppResult<Option<UserInfo>> {
    if let Some(access_token) = current_access_token() {
        match fetch_user_info(client, &access_token).await {
            Ok(user) => return Ok(Some(user)),
            Err(AppError::AuthSessionExpired(_)) => {
                clear_runtime_tokens();
            }
            Err(err) => return Err(err),
        }
    }

    let Some(access_token) = refresh_from_keychain(client).await? else {
        return Ok(None);
    };
    match fetch_user_info(client, &access_token).await {
        Ok(user) => Ok(Some(user)),
        Err(AppError::AuthSessionExpired(_)) => {
            let _ = clear_refresh_token();
            clear_runtime_tokens();
            Ok(None)
        }
        Err(err) => Err(err),
    }
}

async fn bind_loopback_listener() -> AppResult<(TcpListener, u16, String)> {
    for port in REDIRECT_PORTS {
        match TcpListener::bind((Ipv4Addr::LOCALHOST, port)).await {
            Ok(listener) => {
                let redirect_uri = format!("http://127.0.0.1:{port}{CALLBACK_PATH}");
                return Ok((listener, port, redirect_uri));
            }
            Err(err) => {
                log::debug!("Wanderminds ID redirect port {port} unavailable: {err}");
            }
        }
    }
    Err(AppError::InvalidRequest(
        "Wanderminds ID 登录需要 17171/17172/17173 之一可用，请关闭占用该端口的进程后重试"
            .to_string(),
    ))
}

async fn wait_for_callback(
    listener: TcpListener,
    port: u16,
    expected_state: String,
) -> AppResult<CallbackCode> {
    let deadline = Instant::now() + LOGIN_TIMEOUT;
    loop {
        let now = Instant::now();
        if now >= deadline {
            return Err(AppError::InvalidRequest(
                "Wanderminds ID 登录超时（5 分钟）".to_string(),
            ));
        }
        let remaining = deadline.saturating_duration_since(now);
        let accepted = tokio::time::timeout(remaining, listener.accept())
            .await
            .map_err(|_| {
                AppError::InvalidRequest("Wanderminds ID 登录超时（5 分钟）".to_string())
            })?;
        let (stream, _) = accepted.map_err(|e| {
            AppError::DashboardProbe(format!("accept Wanderminds ID callback: {e}"))
        })?;
        match handle_callback_stream(stream, port, &expected_state).await? {
            CallbackOutcome::Code(code) => return Ok(code),
            CallbackOutcome::Continue => {}
        }
    }
}

async fn handle_callback_stream(
    mut stream: TcpStream,
    port: u16,
    expected_state: &str,
) -> AppResult<CallbackOutcome> {
    let Some(request) = read_callback_request(&mut stream, CALLBACK_READ_TIMEOUT).await? else {
        return Ok(CallbackOutcome::Continue);
    };
    let request_line = request.lines().next().unwrap_or_default();
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or_default();
    let target = parts.next().unwrap_or_default();

    if method != "GET" {
        write_callback_response(&mut stream, "405 Method Not Allowed", "请求方法不支持。").await?;
        return Ok(CallbackOutcome::Continue);
    }

    let url = Url::parse(&format!("http://127.0.0.1:{port}{target}"))
        .map_err(|e| AppError::InvalidRequest(format!("invalid Wanderminds ID callback: {e}")))?;
    if url.path() != CALLBACK_PATH {
        write_callback_response(
            &mut stream,
            "404 Not Found",
            "Wanderminds ID 回调地址无效。",
        )
        .await?;
        return Ok(CallbackOutcome::Continue);
    }

    let query: HashMap<String, String> = url.query_pairs().into_owned().collect();
    if let Some(error) = query.get("error") {
        let description = query
            .get("error_description")
            .cloned()
            .unwrap_or_else(|| error.clone());
        write_callback_response(
            &mut stream,
            "400 Bad Request",
            "登录未完成，请回到桌面端重试。",
        )
        .await?;
        return Err(AppError::InvalidRequest(format!(
            "Wanderminds ID authorization failed: {description}"
        )));
    }
    if query.get("state").map(String::as_str) != Some(expected_state) {
        write_callback_response(
            &mut stream,
            "400 Bad Request",
            "登录校验失败，请回到桌面端重试。",
        )
        .await?;
        return Err(AppError::InvalidRequest(
            "Wanderminds ID callback state mismatch".to_string(),
        ));
    }
    let Some(code) = query.get("code").filter(|value| !value.is_empty()) else {
        write_callback_response(&mut stream, "400 Bad Request", "登录回调缺少 code。").await?;
        return Err(AppError::InvalidRequest(
            "Wanderminds ID callback missing code".to_string(),
        ));
    };

    write_callback_response(&mut stream, "200 OK", "登录成功，可关闭此页面。").await?;
    Ok(CallbackOutcome::Code(CallbackCode { code: code.clone() }))
}

async fn read_callback_request(
    stream: &mut TcpStream,
    timeout: Duration,
) -> AppResult<Option<String>> {
    let mut buffer = [0u8; 8192];
    let n = match tokio::time::timeout(timeout, stream.read(&mut buffer)).await {
        Ok(result) => result
            .map_err(|e| AppError::DashboardProbe(format!("read Wanderminds ID callback: {e}")))?,
        Err(_) => return Ok(None),
    };
    if n == 0 {
        return Ok(None);
    }
    Ok(Some(String::from_utf8_lossy(&buffer[..n]).into_owned()))
}

async fn write_callback_response(
    stream: &mut TcpStream,
    status: &str,
    message: &str,
) -> AppResult<()> {
    let body = format!(
        "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><title>Wanderminds ID</title></head><body style=\"font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:32px;line-height:1.6\"><h1>Wanderminds ID</h1><p>{message}</p></body></html>"
    );
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(response.as_bytes()).await.map_err(|e| {
        AppError::DashboardProbe(format!("write Wanderminds ID callback response: {e}"))
    })?;
    let _ = stream.shutdown().await;
    Ok(())
}

async fn revoke_refresh_token(client: &reqwest::Client, refresh_token: &str) {
    let mut form = HashMap::new();
    form.insert("client_id", CLIENT_ID.to_string());
    form.insert("token", refresh_token.to_string());
    form.insert("token_type_hint", "refresh_token".to_string());
    let _ = client.post(REVOCATION_ENDPOINT).form(&form).send().await;
}

#[tauri::command]
pub async fn wanderminds_id_login(_app: tauri::AppHandle) -> AppResult<AuthResult> {
    {
        let mut guard = login_in_flight().lock().unwrap();
        if *guard {
            return Err(AppError::InvalidRequest(
                "Wanderminds ID 登录流程已打开，请在浏览器中完成登录".to_string(),
            ));
        }
        *guard = true;
    }
    let _guard = InFlightGuard;

    let (listener, port, redirect_uri) = bind_loopback_listener().await?;
    let (code_verifier, code_challenge) = generate_pkce_pair()?;
    let state = random_urlsafe(32)?;
    let url = auth_url(&redirect_uri, &state, &code_challenge)?;

    open::that(&url)
        .map_err(|e| AppError::InvalidRequest(format!("打开 Wanderminds ID 登录页失败：{e}")))?;
    let callback = wait_for_callback(listener, port, state).await?;

    let client = http_client()?;
    let _token_guard = refresh_lock().lock().await;
    let tokens =
        exchange_authorization_code(&client, &callback.code, &redirect_uri, &code_verifier).await?;
    let refresh_token = tokens.refresh_token.clone().ok_or_else(|| {
        AppError::AuthSessionExpired(
            "Wanderminds ID token response missing refresh_token".to_string(),
        )
    })?;
    store_refresh_token(refresh_token, tokens.refresh_expires_at)?;
    remember_access_token(tokens.access_token.clone(), tokens.access_expires_at);
    let user = fetch_user_info(&client, &tokens.access_token).await?;
    Ok(AuthResult {
        user,
        expires_at: Some(tokens.access_expires_at),
    })
}

#[tauri::command]
pub async fn wanderminds_id_refresh(_app: tauri::AppHandle) -> AppResult<AuthResult> {
    let client = http_client()?;
    let access_token = refresh_from_keychain(&client).await?.ok_or_else(|| {
        AppError::AuthSessionExpired("Wanderminds ID refresh token missing".to_string())
    })?;
    let user = fetch_user_info(&client, &access_token).await?;
    let expires_at = runtime_tokens()
        .lock()
        .unwrap()
        .as_ref()
        .map(|tokens| tokens.access_expires_at);
    Ok(AuthResult { user, expires_at })
}

#[tauri::command]
pub async fn wanderminds_id_logout(_app: tauri::AppHandle) -> AppResult<()> {
    let stored = read_refresh_token()?;
    clear_runtime_tokens();
    clear_refresh_token()?;
    if let Some(stored) = stored {
        if let Ok(client) = http_client() {
            revoke_refresh_token(&client, &stored.refresh_token).await;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn wanderminds_id_status(_app: tauri::AppHandle) -> AppResult<Option<UserInfo>> {
    let client = http_client()?;
    user_from_current_or_refresh(&client).await
}

struct InFlightGuard;

impl Drop for InFlightGuard {
    fn drop(&mut self) {
        if let Ok(mut guard) = login_in_flight().lock() {
            *guard = false;
        }
    }
}

#[cfg(target_os = "macos")]
mod keychain {
    use std::ffi::CString;
    use std::ptr;

    use libc::{c_char, c_void};

    use super::{AppError, AppResult, KEYCHAIN_ACCOUNT, KEYCHAIN_SERVICE};

    type OSStatus = i32;
    type SecKeychainRef = *const c_void;
    type SecKeychainItemRef = *mut c_void;

    const ERR_SEC_SUCCESS: OSStatus = 0;
    const ERR_SEC_ITEM_NOT_FOUND: OSStatus = -25300;
    const ERR_SEC_DUPLICATE_ITEM: OSStatus = -25299;

    #[link(name = "Security", kind = "framework")]
    unsafe extern "C" {
        fn SecKeychainAddGenericPassword(
            keychain: SecKeychainRef,
            serviceNameLength: u32,
            serviceName: *const c_char,
            accountNameLength: u32,
            accountName: *const c_char,
            passwordLength: u32,
            passwordData: *const c_void,
            itemRef: *mut SecKeychainItemRef,
        ) -> OSStatus;
        fn SecKeychainFindGenericPassword(
            keychain: SecKeychainRef,
            serviceNameLength: u32,
            serviceName: *const c_char,
            accountNameLength: u32,
            accountName: *const c_char,
            passwordLength: *mut u32,
            passwordData: *mut *mut c_void,
            itemRef: *mut SecKeychainItemRef,
        ) -> OSStatus;
        fn SecKeychainItemModifyAttributesAndData(
            itemRef: SecKeychainItemRef,
            attrList: *const c_void,
            length: u32,
            data: *const c_void,
        ) -> OSStatus;
        fn SecKeychainItemDelete(itemRef: SecKeychainItemRef) -> OSStatus;
        fn SecKeychainItemFreeContent(attrList: *const c_void, data: *mut c_void) -> OSStatus;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFRelease(cf: *const c_void);
    }

    /// 命中的 keychain item 及其密码明文（仅读取路径会取回 data）。
    type FoundItem = (SecKeychainItemRef, Option<Vec<u8>>);

    fn keychain_error(action: &str, status: OSStatus) -> AppError {
        AppError::Internal(format!("macOS Keychain {action} failed: OSStatus {status}"))
    }

    fn key_parts() -> AppResult<(CString, CString)> {
        let service = CString::new(KEYCHAIN_SERVICE)
            .map_err(|e| AppError::Internal(format!("invalid keychain service: {e}")))?;
        let account = CString::new(KEYCHAIN_ACCOUNT)
            .map_err(|e| AppError::Internal(format!("invalid keychain account: {e}")))?;
        Ok((service, account))
    }

    unsafe fn find_item(
        service: &CString,
        account: &CString,
    ) -> Result<Option<FoundItem>, AppError> {
        let mut length = 0u32;
        let mut data: *mut c_void = ptr::null_mut();
        let mut item: SecKeychainItemRef = ptr::null_mut();
        let status = SecKeychainFindGenericPassword(
            ptr::null(),
            service.as_bytes().len() as u32,
            service.as_ptr(),
            account.as_bytes().len() as u32,
            account.as_ptr(),
            &mut length,
            &mut data,
            &mut item,
        );
        if status == ERR_SEC_ITEM_NOT_FOUND {
            return Ok(None);
        }
        if status != ERR_SEC_SUCCESS {
            return Err(keychain_error("read", status));
        }
        let bytes = if data.is_null() {
            None
        } else {
            let slice = std::slice::from_raw_parts(data as *const u8, length as usize);
            let out = slice.to_vec();
            let _ = SecKeychainItemFreeContent(ptr::null(), data);
            Some(out)
        };
        Ok(Some((item, bytes)))
    }

    pub fn get_password() -> AppResult<Option<String>> {
        let (service, account) = key_parts()?;
        unsafe {
            let Some((item, bytes)) = find_item(&service, &account)? else {
                return Ok(None);
            };
            if !item.is_null() {
                CFRelease(item as *const c_void);
            }
            let Some(bytes) = bytes else {
                return Ok(None);
            };
            String::from_utf8(bytes).map(Some).map_err(|e| {
                AppError::Internal(format!("decode Wanderminds ID keychain item: {e}"))
            })
        }
    }

    pub fn set_password(value: &str) -> AppResult<()> {
        let (service, account) = key_parts()?;
        let bytes = value.as_bytes();
        unsafe {
            let status = SecKeychainAddGenericPassword(
                ptr::null(),
                service.as_bytes().len() as u32,
                service.as_ptr(),
                account.as_bytes().len() as u32,
                account.as_ptr(),
                bytes.len() as u32,
                bytes.as_ptr() as *const c_void,
                ptr::null_mut(),
            );
            if status == ERR_SEC_SUCCESS {
                return Ok(());
            }
            if status != ERR_SEC_DUPLICATE_ITEM {
                return Err(keychain_error("write", status));
            }
            let Some((item, _)) = find_item(&service, &account)? else {
                return Err(AppError::Internal(
                    "macOS Keychain item disappeared before update".to_string(),
                ));
            };
            if item.is_null() {
                return Err(AppError::Internal(
                    "macOS Keychain item reference missing before update".to_string(),
                ));
            }
            let update_status = SecKeychainItemModifyAttributesAndData(
                item,
                ptr::null(),
                bytes.len() as u32,
                bytes.as_ptr() as *const c_void,
            );
            if !item.is_null() {
                CFRelease(item as *const c_void);
            }
            if update_status == ERR_SEC_SUCCESS {
                Ok(())
            } else {
                Err(keychain_error("update", update_status))
            }
        }
    }

    pub fn delete_password() -> AppResult<()> {
        let (service, account) = key_parts()?;
        unsafe {
            let Some((item, _)) = find_item(&service, &account)? else {
                return Ok(());
            };
            if item.is_null() {
                return Err(AppError::Internal(
                    "macOS Keychain item reference missing before delete".to_string(),
                ));
            }
            let status = SecKeychainItemDelete(item);
            if !item.is_null() {
                CFRelease(item as *const c_void);
            }
            if status == ERR_SEC_SUCCESS || status == ERR_SEC_ITEM_NOT_FOUND {
                Ok(())
            } else {
                Err(keychain_error("delete", status))
            }
        }
    }
}

#[cfg(target_os = "windows")]
mod keychain {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use std::ptr::null_mut;

    use windows_sys::Win32::Foundation::FILETIME;
    use windows_sys::Win32::Security::Credentials::{
        CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE,
        CRED_TYPE_GENERIC,
    };

    use super::{AppError, AppResult, KEYCHAIN_ACCOUNT, KEYCHAIN_SERVICE};

    const ERROR_NOT_FOUND: i32 = 1168;

    fn target_name() -> String {
        format!("{}:{}", KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
    }

    fn wide(value: &str) -> Vec<u16> {
        OsStr::new(value).encode_wide().chain(Some(0)).collect()
    }

    fn last_error(action: &str) -> AppError {
        AppError::Internal(format!(
            "Windows Credential Manager {action} failed: {}",
            std::io::Error::last_os_error()
        ))
    }

    fn is_not_found() -> bool {
        std::io::Error::last_os_error().raw_os_error() == Some(ERROR_NOT_FOUND)
    }

    pub fn get_password() -> AppResult<Option<String>> {
        let target = wide(&target_name());
        unsafe {
            let mut credential: *mut CREDENTIALW = null_mut();
            if CredReadW(target.as_ptr(), CRED_TYPE_GENERIC, 0, &mut credential) == 0 {
                if is_not_found() {
                    return Ok(None);
                }
                return Err(last_error("read"));
            }
            let cred = &*credential;
            let bytes = std::slice::from_raw_parts(
                cred.CredentialBlob as *const u8,
                cred.CredentialBlobSize as usize,
            )
            .to_vec();
            CredFree(credential as *const _);
            String::from_utf8(bytes)
                .map(Some)
                .map_err(|e| AppError::Internal(format!("decode Wanderminds ID credential: {e}")))
        }
    }

    pub fn set_password(value: &str) -> AppResult<()> {
        let mut target = wide(&target_name());
        let mut account = wide(KEYCHAIN_ACCOUNT);
        let mut bytes = value.as_bytes().to_vec();
        if bytes.len() > u32::MAX as usize {
            return Err(AppError::InvalidRequest(
                "Wanderminds ID refresh token is too large".to_string(),
            ));
        }
        let credential = CREDENTIALW {
            Flags: 0,
            Type: CRED_TYPE_GENERIC,
            TargetName: target.as_mut_ptr(),
            Comment: null_mut(),
            LastWritten: FILETIME {
                dwLowDateTime: 0,
                dwHighDateTime: 0,
            },
            CredentialBlobSize: bytes.len() as u32,
            CredentialBlob: bytes.as_mut_ptr(),
            Persist: CRED_PERSIST_LOCAL_MACHINE,
            AttributeCount: 0,
            Attributes: null_mut(),
            TargetAlias: null_mut(),
            UserName: account.as_mut_ptr(),
        };
        unsafe {
            if CredWriteW(&credential, 0) == 0 {
                return Err(last_error("write"));
            }
        }
        Ok(())
    }

    pub fn delete_password() -> AppResult<()> {
        let target = wide(&target_name());
        unsafe {
            if CredDeleteW(target.as_ptr(), CRED_TYPE_GENERIC, 0) == 0 {
                if is_not_found() {
                    return Ok(());
                }
                return Err(last_error("delete"));
            }
        }
        Ok(())
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod keychain {
    use super::{AppError, AppResult};

    pub fn get_password() -> AppResult<Option<String>> {
        Ok(None)
    }

    pub fn set_password(_value: &str) -> AppResult<()> {
        Err(AppError::Internal(
            "Wanderminds ID keychain storage is not implemented on this platform".to_string(),
        ))
    }

    pub fn delete_password() -> AppResult<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_challenge_is_s256_urlsafe() {
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        let digest = Sha256::digest(verifier.as_bytes());
        let challenge = URL_SAFE_NO_PAD.encode(digest);
        assert_eq!(challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    }

    #[test]
    fn generated_pkce_verifier_is_valid_length() {
        let (verifier, challenge) = generate_pkce_pair().unwrap();
        assert!((43..=128).contains(&verifier.len()));
        assert_eq!(challenge.len(), 43);
        assert!(verifier
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_')));
        assert!(challenge
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_')));
    }

    #[test]
    fn auth_url_keeps_exact_loopback_redirect_uri() {
        let redirect_uri = "http://127.0.0.1:17172/callback";
        let url = auth_url(redirect_uri, "STATE", "CHALLENGE").unwrap();
        let parsed = Url::parse(&url).unwrap();
        let pairs: HashMap<String, String> = parsed.query_pairs().into_owned().collect();
        assert_eq!(parsed.as_str().split('?').next().unwrap(), AUTH_ENDPOINT);
        assert_eq!(
            pairs.get("redirect_uri").map(String::as_str),
            Some(redirect_uri)
        );
        assert_eq!(
            pairs.get("code_challenge_method").map(String::as_str),
            Some("S256")
        );
    }

    #[test]
    fn auth_url_requests_offline_access_for_refresh_token() {
        let url = auth_url("http://127.0.0.1:17171/callback", "S", "C").unwrap();
        let parsed = Url::parse(&url).unwrap();
        let pairs: HashMap<String, String> = parsed.query_pairs().into_owned().collect();
        // 没有 offline_access 就拿不到 refresh_token，登录态无法跨重启保持。
        let scope = pairs.get("scope").expect("scope present");
        assert!(scope.split(' ').any(|s| s == "offline_access"), "{scope}");
        assert!(scope.split(' ').any(|s| s == "openid"), "{scope}");
        assert!(scope.split(' ').any(|s| s == "portal:read"), "{scope}");
        assert!(scope.split(' ').any(|s| s == "inference:invoke"), "{scope}");
        assert!(!scope.split(' ').any(|s| s == "billing:manage"), "{scope}");
        assert_eq!(
            pairs.get("resource").map(String::as_str),
            Some(PORTAL_RESOURCE)
        );
        assert_eq!(pairs.get("client_id").map(String::as_str), Some(CLIENT_ID));
        assert_eq!(pairs.get("response_type").map(String::as_str), Some("code"));
    }

    #[test]
    fn auth_url_forces_consent_prompt_to_obtain_refresh_token() {
        // 实测：不带 prompt=consent 时 Logto 只授予 `openid profile email`，
        // 不发 refresh_token，登录会失败在 missing refresh_token。
        // 这个断言是防止参数被当成冗余清理掉的回归闸门。
        let url = auth_url("http://127.0.0.1:17171/callback", "S", "C").unwrap();
        let pairs: HashMap<String, String> = Url::parse(&url)
            .unwrap()
            .query_pairs()
            .into_owned()
            .collect();
        assert_eq!(pairs.get("prompt").map(String::as_str), Some("consent"));
    }

    #[test]
    fn pkce_pairs_are_unique_per_login() {
        let (v1, c1) = generate_pkce_pair().unwrap();
        let (v2, c2) = generate_pkce_pair().unwrap();
        assert_ne!(v1, v2, "verifier 必须每次随机，否则可被重放");
        assert_ne!(c1, c2);
    }

    /// 起一个临时 loopback listener，把 `request_target` 当作回调请求打进
    /// `handle_callback_stream`，返回处理结果与回给浏览器的原始响应。
    async fn drive_callback(
        request_target: &str,
        expected_state: &str,
    ) -> (AppResult<CallbackOutcome>, String) {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let request = format!("GET {request_target} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");

        let client = tokio::spawn(async move {
            let mut stream = TcpStream::connect((Ipv4Addr::LOCALHOST, port))
                .await
                .unwrap();
            stream.write_all(request.as_bytes()).await.unwrap();
            let mut response = Vec::new();
            stream.read_to_end(&mut response).await.unwrap();
            String::from_utf8_lossy(&response).into_owned()
        });

        let (stream, _) = listener.accept().await.unwrap();
        let outcome = handle_callback_stream(stream, port, expected_state).await;
        (outcome, client.await.unwrap())
    }

    #[tokio::test]
    async fn callback_accepts_matching_state_and_returns_code() {
        let (outcome, response) =
            drive_callback("/callback?code=AUTH_CODE&state=GOOD_STATE", "GOOD_STATE").await;
        match outcome.expect("callback handled") {
            CallbackOutcome::Code(code) => assert_eq!(code.code, "AUTH_CODE"),
            CallbackOutcome::Continue => panic!("应当取到 code"),
        }
        assert!(response.starts_with("HTTP/1.1 200 OK"), "{response}");
        assert!(response.contains("登录成功"), "{response}");
    }

    #[tokio::test]
    async fn callback_rejects_state_mismatch() {
        // state 不符即 CSRF 嫌疑：必须报错且不得把 code 交出去。
        let (outcome, response) =
            drive_callback("/callback?code=AUTH_CODE&state=ATTACKER", "GOOD_STATE").await;
        let err = outcome.expect_err("state 不匹配必须失败");
        assert!(
            matches!(err, AppError::InvalidRequest(ref m) if m.contains("state mismatch")),
            "{err:?}"
        );
        assert!(response.starts_with("HTTP/1.1 400"), "{response}");
    }

    #[tokio::test]
    async fn callback_rejects_missing_state() {
        let (outcome, _) = drive_callback("/callback?code=AUTH_CODE", "GOOD_STATE").await;
        assert!(outcome.is_err(), "缺 state 必须失败");
    }

    #[tokio::test]
    async fn callback_surfaces_issuer_error() {
        let (outcome, response) = drive_callback(
            "/callback?error=access_denied&error_description=user+declined&state=GOOD_STATE",
            "GOOD_STATE",
        )
        .await;
        let err = outcome.expect_err("issuer 返回 error 必须失败");
        assert!(
            matches!(err, AppError::InvalidRequest(ref m) if m.contains("user declined")),
            "{err:?}"
        );
        assert!(response.starts_with("HTTP/1.1 400"), "{response}");
    }

    #[tokio::test]
    async fn callback_ignores_unrelated_path_and_keeps_waiting() {
        // 浏览器/系统常会顺手请求 /favicon.ico，不能因此中断等待真回调。
        let (outcome, response) = drive_callback("/favicon.ico", "GOOD_STATE").await;
        assert!(matches!(
            outcome.expect("不应报错"),
            CallbackOutcome::Continue
        ));
        assert!(response.starts_with("HTTP/1.1 404"), "{response}");
    }

    #[tokio::test]
    async fn callback_drops_stalled_peer_and_keeps_waiting() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let _stalled_client = TcpStream::connect((Ipv4Addr::LOCALHOST, port))
            .await
            .unwrap();
        let (mut server_stream, _) = listener.accept().await.unwrap();

        let request = read_callback_request(&mut server_stream, Duration::from_millis(20))
            .await
            .unwrap();

        assert!(request.is_none(), "无数据连接超时后必须被忽略");
    }

    #[test]
    fn stored_refresh_token_round_trips_as_json() {
        let stored = StoredRefreshToken {
            refresh_token: "RT_VALUE".to_string(),
            expires_at: Some(1_800_000_000),
        };
        let parsed: StoredRefreshToken =
            serde_json::from_str(&serde_json::to_string(&stored).unwrap()).unwrap();
        assert_eq!(parsed.refresh_token, "RT_VALUE");
        assert_eq!(parsed.expires_at, Some(1_800_000_000));
    }

    #[test]
    fn access_expiry_applies_skew_and_default_ttl() {
        let before = now_secs();
        // 提前 TOKEN_EXPIRY_SKEW_SECS 过期，避免边界上拿着刚失效的 token 发请求。
        let with_ttl = access_expires_at(Some(3600));
        assert!(with_ttl >= before + 3600 - TOKEN_EXPIRY_SKEW_SECS);
        assert!(with_ttl <= now_secs() + 3600 - TOKEN_EXPIRY_SKEW_SECS);

        let default_ttl = access_expires_at(None);
        assert!(default_ttl >= before + 3600 - TOKEN_EXPIRY_SKEW_SECS);
    }

    #[test]
    fn refresh_expiry_prefers_either_ttl_field_name() {
        // Logto 用 refresh_token_expires_in，其他 issuer 可能给 refresh_expires_in。
        let a = TokenResponse {
            access_token: "A".into(),
            refresh_token: None,
            expires_in: None,
            refresh_token_expires_in: Some(7_776_000),
            refresh_expires_in: None,
        };
        assert!(refresh_expires_at(&a).unwrap() >= now_secs() + 7_776_000 - 5);

        let b = TokenResponse {
            refresh_token_expires_in: None,
            refresh_expires_in: Some(600),
            ..a
        };
        let b_expiry = refresh_expires_at(&b).unwrap();
        assert!(b_expiry >= now_secs() + 595 && b_expiry <= now_secs() + 600);

        let c = TokenResponse {
            access_token: "A".into(),
            refresh_token: None,
            expires_in: None,
            refresh_token_expires_in: None,
            refresh_expires_in: None,
        };
        assert_eq!(
            refresh_expires_at(&c),
            None,
            "两个字段都缺时不应臆造过期时间"
        );
    }
}
