//! Spotify PKCE OAuth helper: one-shot localhost callback listener and
//! `~/.hermes/auth.json` atomic read/write.
//!
//! The TS side generates the PKCE verifier/challenge, builds the Spotify
//! authorize URL, and calls `spotify_oauth_start` to open the loopback listener.
//! After the user authorizes, Spotify redirects to this listener; TS calls
//! `spotify_oauth_wait` to receive `{ code, state }`, then exchanges the code
//! for tokens via Spotify's token endpoint (or refreshes) in-process. Token
//! persistence goes through `spotify_oauth_read` / `spotify_oauth_write` so the
//! desktop shares the same auth.json shape as the Hermes CLI.

use std::convert::Infallible;
use std::net::Ipv4Addr;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use bytes::Bytes;
use http_body_util::Full;
use hyper::body::Incoming;
use hyper::header::{CONTENT_LENGTH, CONTENT_TYPE};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use serde::{Deserialize, Serialize};
use tokio::net::TcpListener;
use tokio::sync::mpsc;

use crate::error::{AppError, AppResult};
use crate::state::AppState;

const DEFAULT_SPOTIFY_PORT: u16 = 43827;
const DEFAULT_CALLBACK_PATH: &str = "/spotify/callback";
const LISTEN_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpotifyProviderState {
    pub client_id: String,
    pub redirect_uri: String,
    pub api_base_url: String,
    pub accounts_base_url: String,
    pub scope: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub granted_scope: Option<String>,
    pub access_token: String,
    pub refresh_token: String,
    pub token_type: String,
    pub expires_at: String,
    pub expires_in: i64,
    pub obtained_at: String,
    pub auth_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_auth_error: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpotifyStartResult {
    pub port: u16,
    pub redirect_uri: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpotifyCallbackResult {
    pub code: String,
    pub state: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpotifyAuthJsonResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<SpotifyProviderState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpotifyStartInput {
    #[serde(default = "default_port")]
    pub port: u16,
    #[serde(default = "default_callback_path")]
    pub path: String,
}

fn default_port() -> u16 {
    DEFAULT_SPOTIFY_PORT
}

fn default_callback_path() -> String {
    DEFAULT_CALLBACK_PATH.to_string()
}

fn auth_json_path(state: &AppState) -> AppResult<PathBuf> {
    let inner = state
        .inner
        .lock()
        .map_err(|e| AppError::Internal(e.to_string()))?;
    Ok(PathBuf::from(&inner.hermes_home).join("auth.json"))
}

fn read_auth_json(path: &std::path::Path) -> AppResult<serde_json::Map<String, serde_json::Value>> {
    if !path.exists() {
        return Ok(serde_json::Map::new());
    }
    let content = std::fs::read_to_string(path)
        .map_err(|e| AppError::Internal(format!("无法读取 auth.json: {e}")))?;
    let value: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| AppError::Internal(format!("auth.json 解析失败: {e}")))?;
    match value {
        serde_json::Value::Object(map) => Ok(map),
        _ => Ok(serde_json::Map::new()),
    }
}

fn write_auth_json(
    path: &std::path::Path,
    root: &serde_json::Map<String, serde_json::Value>,
) -> AppResult<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| AppError::Internal(format!("无法创建 auth.json 目录: {e}")))?;
    }
    let json = serde_json::to_string_pretty(root)
        .map_err(|e| AppError::Internal(format!("auth.json 序列化失败: {e}")))?;
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, format!("{}\n", json))
        .map_err(|e| AppError::Internal(format!("无法写入临时 auth.json: {e}")))?;
    std::fs::rename(&tmp, path)
        .map_err(|e| AppError::Internal(format!("无法重命名 auth.json: {e}")))?;
    Ok(())
}

/// Read the persisted Spotify provider blob from `~/.hermes/auth.json`.
#[tauri::command]
pub async fn spotify_oauth_read(
    state: tauri::State<'_, AppState>,
) -> AppResult<SpotifyAuthJsonResult> {
    let path = auth_json_path(&state)?;
    let root = read_auth_json(&path)?;
    let provider = root
        .get("providers")
        .and_then(|p| p.get("spotify"))
        .and_then(|v| serde_json::from_value::<SpotifyProviderState>(v.clone()).ok());
    Ok(SpotifyAuthJsonResult {
        ok: true,
        provider,
        error: None,
    })
}

/// Atomically write the Spotify provider blob to `~/.hermes/auth.json`.
#[tauri::command]
pub async fn spotify_oauth_write(
    provider: SpotifyProviderState,
    state: tauri::State<'_, AppState>,
) -> AppResult<SpotifyAuthJsonResult> {
    let path = auth_json_path(&state)?;
    let mut root = read_auth_json(&path)?;
    let providers = root
        .entry("providers")
        .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()));
    if let serde_json::Value::Object(map) = providers {
        map.insert(
            "spotify".to_string(),
            serde_json::to_value(&provider)
                .map_err(|e| AppError::Internal(format!("无法序列化 Spotify 凭证: {e}")))?,
        );
    }
    write_auth_json(&path, &root)?;
    Ok(SpotifyAuthJsonResult {
        ok: true,
        provider: Some(provider),
        error: None,
    })
}

/// Clear the Spotify provider blob from `~/.hermes/auth.json`.
#[tauri::command]
pub async fn spotify_oauth_disconnect(
    state: tauri::State<'_, AppState>,
) -> AppResult<SpotifyAuthJsonResult> {
    let path = auth_json_path(&state)?;
    let mut root = read_auth_json(&path)?;
    if let Some(serde_json::Value::Object(map)) = root.get_mut("providers") {
        map.remove("spotify");
    }
    write_auth_json(&path, &root)?;
    Ok(SpotifyAuthJsonResult {
        ok: true,
        provider: None,
        error: None,
    })
}

struct PendingCallback {
    #[allow(dead_code)]
    port: u16,
    #[allow(dead_code)]
    path: String,
    result_rx: Option<mpsc::Receiver<AppResult<SpotifyCallbackResult>>>,
    abort: Arc<AtomicBool>,
}

fn pending_callback() -> Arc<Mutex<Option<PendingCallback>>> {
    static INSTANCE: std::sync::OnceLock<Arc<Mutex<Option<PendingCallback>>>> =
        std::sync::OnceLock::new();
    INSTANCE.get_or_init(|| Arc::new(Mutex::new(None))).clone()
}

/// Start a one-shot loopback HTTP listener for the Spotify OAuth callback.
#[tauri::command]
pub async fn spotify_oauth_start(input: SpotifyStartInput) -> AppResult<SpotifyStartResult> {
    let listener = match TcpListener::bind((Ipv4Addr::LOCALHOST, input.port)).await {
        Ok(l) => l,
        Err(_) => TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .map_err(|e| AppError::Internal(format!("无法监听 Spotify OAuth 回调端口: {e}")))?,
    };
    let port = listener
        .local_addr()
        .map_err(|e| AppError::Internal(format!("无法读取监听端口: {e}")))?
        .port();
    let redirect_uri = format!("http://127.0.0.1:{}{}", port, input.path);

    let (tx, rx) = mpsc::channel::<AppResult<SpotifyCallbackResult>>(1);
    let abort = Arc::new(AtomicBool::new(false));

    {
        let handle = pending_callback();
        let mut guard = handle
            .lock()
            .map_err(|e| AppError::Internal(e.to_string()))?;
        *guard = Some(PendingCallback {
            port,
            path: input.path.clone(),
            result_rx: Some(rx),
            abort: abort.clone(),
        });
    }

    let path = input.path;
    tauri::async_runtime::spawn(async move {
        let result = serve_one_callback(listener, &path, tx, abort.clone()).await;
        // Best-effort cleanup of the pending handle; the result has already
        // been sent or the sender dropped.
        let _ = pending_callback().lock().map(|mut g| *g = None);
        let _ = result;
    });

    Ok(SpotifyStartResult { port, redirect_uri })
}

async fn serve_one_callback(
    listener: TcpListener,
    expected_path: &str,
    result_tx: mpsc::Sender<AppResult<SpotifyCallbackResult>>,
    abort: Arc<AtomicBool>,
) {
    let result = tokio::time::timeout(LISTEN_TIMEOUT, async {
        loop {
            if abort.load(Ordering::Relaxed) {
                return Err(AppError::InvalidRequest("OAuth 回调已取消".to_string()));
            }
            let (stream, _) = match listener.accept().await {
                Ok(s) => s,
                Err(e) => {
                    return Err(AppError::Internal(format!(
                        "Spotify OAuth 回调连接失败: {e}"
                    )))
                }
            };
            let io = TokioIo::new(stream);
            let path = expected_path.to_string();
            let (inner_tx, mut inner_rx) = mpsc::channel::<AppResult<SpotifyCallbackResult>>(1);
            tauri::async_runtime::spawn(async move {
                let service = service_fn(move |request: Request<Incoming>| {
                    let path = path.clone();
                    let tx = inner_tx.clone();
                    async move { handle_callback(request, &path, tx).await }
                });
                let _ = http1::Builder::new()
                    .serve_connection(io, service)
                    .with_upgrades()
                    .await;
            });
            if let Some(r) = inner_rx.recv().await {
                match r {
                    Ok(result) => return Ok(result),
                    Err(e) => return Err(e),
                }
            }
        }
    })
    .await;

    let resolved = match result {
        Ok(r) => r,
        Err(_) => Err(AppError::Internal("Spotify OAuth 回调等待超时".to_string())),
    };
    let _ = result_tx.send(resolved).await;
}

async fn handle_callback(
    request: Request<Incoming>,
    expected_path: &str,
    sender: mpsc::Sender<AppResult<SpotifyCallbackResult>>,
) -> Result<Response<Full<Bytes>>, Infallible> {
    if request.method() != Method::GET {
        let _ = sender.send(Err(AppError::InvalidRequest(
            "Spotify OAuth callback expected GET".to_string(),
        )));
        return Ok(callback_html_response(
            StatusCode::METHOD_NOT_ALLOWED,
            "Method not allowed",
        ));
    }

    let path = request.uri().path();
    if path != expected_path {
        let _ = sender.send(Err(AppError::InvalidRequest(format!(
            "Spotify OAuth callback path mismatch: {path}"
        ))));
        return Ok(callback_html_response(StatusCode::NOT_FOUND, "Not found"));
    }

    let query = request.uri().query().unwrap_or("");
    let params: std::collections::HashMap<String, String> =
        url::form_urlencoded::parse(query.as_bytes())
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect();

    if let Some(error) = params.get("error") {
        let description = params.get("error_description").cloned().unwrap_or_default();
        let _ = sender.send(Err(AppError::InvalidRequest(format!(
            "Spotify OAuth error: {error} - {description}"
        ))));
        return Ok(callback_html_response(
            StatusCode::BAD_REQUEST,
            "Authorization failed. You may close this window and return to Hermes.",
        ));
    }

    match (params.get("code"), params.get("state")) {
        (Some(code), Some(state)) => {
            let _ = sender.send(Ok(SpotifyCallbackResult {
                code: code.clone(),
                state: state.clone(),
            }));
            Ok(callback_html_response(
                StatusCode::OK,
                "Authorization successful. You may close this window and return to Hermes.",
            ))
        }
        _ => {
            let _ = sender.send(Err(AppError::InvalidRequest(
                "Spotify OAuth callback missing code or state".to_string(),
            )));
            Ok(callback_html_response(
                StatusCode::BAD_REQUEST,
                "Authorization failed: missing code or state.",
            ))
        }
    }
}

fn callback_html_response(status: StatusCode, message: &str) -> Response<Full<Bytes>> {
    let body = format!(
        r#"<!DOCTYPE html><html><head><meta charset="utf-8"><title>Hermes Spotify</title></head><body><p>{}</p></body></html>"#,
        html_escape(message)
    );
    Response::builder()
        .status(status)
        .header(CONTENT_TYPE, "text/html; charset=utf-8")
        .header(CONTENT_LENGTH, body.len())
        .body(Full::new(Bytes::from(body)))
        .unwrap()
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// Wait for the Spotify callback to complete and return `{ code, state }`.
#[tauri::command]
pub async fn spotify_oauth_wait() -> AppResult<SpotifyCallbackResult> {
    let mut rx = {
        let handle = pending_callback();
        let mut guard = handle
            .lock()
            .map_err(|e| AppError::Internal(e.to_string()))?;
        guard
            .as_mut()
            .and_then(|cb| cb.result_rx.take())
            .ok_or_else(|| {
                AppError::InvalidRequest(
                    "No Spotify OAuth listener is running. Call spotify_oauth_start first."
                        .to_string(),
                )
            })?
    };

    match rx.recv().await {
        Some(Ok(result)) => Ok(result),
        Some(Err(e)) => Err(e),
        None => Err(AppError::Internal(
            "Spotify OAuth callback channel closed unexpectedly".to_string(),
        )),
    }
}

/// Cancel an in-progress Spotify OAuth listener.
#[tauri::command]
pub async fn spotify_oauth_cancel() -> AppResult<()> {
    let handle = pending_callback();
    let guard = handle
        .lock()
        .map_err(|e| AppError::Internal(e.to_string()))?;
    if let Some(cb) = guard.as_ref() {
        cb.abort.store(true, Ordering::Relaxed);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn auth_json_round_trip() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("auth.json");

        let mut root = serde_json::Map::new();
        root.insert(
            "version".to_string(),
            serde_json::Value::String("1".to_string()),
        );

        let provider = SpotifyProviderState {
            client_id: "client-1".to_string(),
            redirect_uri: "http://127.0.0.1:43827/spotify/callback".to_string(),
            api_base_url: "https://api.spotify.com/v1".to_string(),
            accounts_base_url: "https://accounts.spotify.com".to_string(),
            scope: "user-read-playback-state".to_string(),
            access_token: "at".to_string(),
            refresh_token: "rt".to_string(),
            token_type: "Bearer".to_string(),
            expires_at: "2025-01-01T00:00:00Z".to_string(),
            expires_in: 3600,
            obtained_at: "2025-01-01T00:00:00Z".to_string(),
            auth_type: "oauth_pkce".to_string(),
            ..Default::default()
        };

        write_auth_json(&path, &root).unwrap();
        let mut root = read_auth_json(&path).unwrap();
        let providers = root
            .entry("providers")
            .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()));
        if let serde_json::Value::Object(map) = providers {
            map.insert(
                "spotify".to_string(),
                serde_json::to_value(&provider).unwrap(),
            );
        }
        write_auth_json(&path, &root).unwrap();

        let root = read_auth_json(&path).unwrap();
        let saved = root
            .get("providers")
            .and_then(|p| p.get("spotify"))
            .and_then(|v| serde_json::from_value::<SpotifyProviderState>(v.clone()).ok())
            .unwrap();
        assert_eq!(saved.client_id, "client-1");
        assert_eq!(saved.access_token, "at");
        assert_eq!(saved.auth_type, "oauth_pkce");
    }
}
