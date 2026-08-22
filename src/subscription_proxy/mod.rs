//! Subscription proxy: loopback OpenAI-compatible passthrough that attaches
//! Nous Portal / xAI OAuth credentials.

use std::collections::HashSet;
use std::convert::Infallible;
use std::net::Ipv4Addr;
use std::sync::Arc;

use async_trait::async_trait;
use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper::header::CONTENT_TYPE;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use serde::{Deserialize, Serialize};
use tauri::Manager;
use tokio::net::TcpListener;
use tokio::sync::Notify;

use crate::error::AppError;
use crate::state::{AppState, SubscriptionProxyHandle};

const PREFERRED_PORT: u16 = 8645;
const MAX_REQUEST_BYTES: u64 = 10 * 1024 * 1024;

type ProxyBody = Full<Bytes>;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpstreamCredential {
    pub bearer: String,
    pub base_url: String,
    pub token_type: String,
    pub expires_at: Option<String>,
}

#[async_trait]
pub trait UpstreamAdapter: Send + Sync {
    fn name(&self) -> &'static str;
    fn allowed_paths(&self) -> HashSet<String>;
    fn is_authenticated(&self) -> bool;
    async fn get_credential(&self) -> Result<UpstreamCredential, String>;
}

#[derive(Clone)]
struct NousAdapter;

#[async_trait]
impl UpstreamAdapter for NousAdapter {
    fn name(&self) -> &'static str { "nous" }
    fn allowed_paths(&self) -> HashSet<String> {
        ["/v1/chat/completions", "/v1/completions", "/v1/embeddings", "/v1/models"]
            .into_iter()
            .map(String::from)
            .collect()
    }
    fn is_authenticated(&self) -> bool { true }
    async fn get_credential(&self) -> Result<UpstreamCredential, String> {
        Ok(UpstreamCredential {
            bearer: "nous-stub".into(),
            base_url: "https://api.nousresearch.com".into(),
            token_type: "bearer".into(),
            expires_at: None,
        })
    }
}

#[derive(Clone)]
struct XaiAdapter;

#[async_trait]
impl UpstreamAdapter for XaiAdapter {
    fn name(&self) -> &'static str { "xai" }
    fn allowed_paths(&self) -> HashSet<String> {
        ["/v1/chat/completions", "/v1/responses"].into_iter().map(String::from).collect()
    }
    fn is_authenticated(&self) -> bool { true }
    async fn get_credential(&self) -> Result<UpstreamCredential, String> {
        Ok(UpstreamCredential {
            bearer: "xai-stub".into(),
            base_url: "https://api.x.ai".into(),
            token_type: "bearer".into(),
            expires_at: None,
        })
    }
}

pub fn build_adapter(name: &str) -> Option<Box<dyn UpstreamAdapter>> {
    match name {
        "nous" => Some(Box::new(NousAdapter)),
        "xai" => Some(Box::new(XaiAdapter)),
        _ => None,
    }
}

pub async fn start_subscription_proxy(
    app: tauri::AppHandle,
    provider: String,
) -> Result<SubscriptionProxyHandle, AppError> {
    let adapter = build_adapter(&provider).ok_or_else(|| AppError::Internal("unknown provider".into()))?;
    let listener = match TcpListener::bind((Ipv4Addr::LOCALHOST, PREFERRED_PORT)).await {
        Ok(l) => l,
        Err(_) => TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .map_err(|e| AppError::Internal(format!("proxy bind failed: {e}")))?,
    };
    let port = listener
        .local_addr()
        .map_err(|e| AppError::Internal(format!("proxy port: {e}")))?
        .port();
    let cancel = Arc::new(Notify::new());
    let handle = SubscriptionProxyHandle { port, provider, cancel: cancel.clone() };

    {
        let state = app.state::<AppState>();
        state.inner.lock().map_err(|e| AppError::Internal(e.to_string()))?.subscription_proxy = Some(handle.clone());
    }

    let server_app = app.clone();
    let adapter = Arc::from(adapter);
    tauri::async_runtime::spawn(async move {
        if let Err(e) = proxy_serve(listener, server_app, cancel, adapter).await {
            log::error!("subscription proxy stopped: {e}");
        }
    });

    Ok(handle)
}

async fn proxy_serve(
    listener: TcpListener,
    app: tauri::AppHandle,
    cancel: Arc<Notify>,
    adapter: Arc<dyn UpstreamAdapter>,
) -> Result<(), AppError> {
    loop {
        tokio::select! {
            _ = cancel.notified() => break,
            res = listener.accept() => {
                let (stream, _) = res.map_err(|e| AppError::Internal(format!("proxy accept: {e}")))?;
                let io = TokioIo::new(stream);
                let adapter = adapter.clone();
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let service = service_fn(move |req| {
                        let adapter = adapter.clone();
                        let app = app.clone();
                        async move { handle_proxy_request(req, app, adapter).await }
                    });
                    let _ = http1::Builder::new().serve_connection(io, service).await;
                });
            }
        }
    }
    {
        let state = app.state::<AppState>();
        state.inner.lock().map_err(|e| AppError::Internal(e.to_string()))?.subscription_proxy = None;
    }
    Ok(())
}

async fn handle_proxy_request(
    req: Request<Incoming>,
    _app: tauri::AppHandle,
    adapter: Arc<dyn UpstreamAdapter>,
) -> Result<Response<ProxyBody>, Infallible> {
    let path = req.uri().path().to_string();
    let method = req.method().clone();

    if method == Method::GET && path == "/health" {
        return Ok(json_response(StatusCode::OK, serde_json::json!({
            "status": "ok",
            "upstream": adapter.name(),
            "authenticated": adapter.is_authenticated(),
        })));
    }

    if !adapter.allowed_paths().contains(&path) {
        return Ok(json_response(StatusCode::NOT_FOUND, serde_json::json!({"error": "path_not_allowed"})));
    }

    let credential = match adapter.get_credential().await {
        Ok(c) => c,
        Err(_) => return Ok(json_response(StatusCode::UNAUTHORIZED, serde_json::json!({"error": "upstream_auth_failed"}))),
    };

    let bytes = match read_body(req).await {
        Ok(b) => b,
        Err(e) => return Ok(json_response(StatusCode::PAYLOAD_TOO_LARGE, serde_json::json!({"error": e}))),
    };

    // v1: echo the request metadata rather than making a real upstream call.
    Ok(json_response(StatusCode::OK, serde_json::json!({
        "proxy": true,
        "provider": adapter.name(),
        "base_url": credential.base_url,
        "path": path,
        "body_length": bytes.len(),
    })))
}

async fn read_body(req: Request<Incoming>) -> Result<Vec<u8>, String> {
    let mut body = req.into_body();
    let mut collected = Vec::new();
    while let Some(frame) = body.frame().await {
        let frame = frame.map_err(|e| e.to_string())?;
        if let Some(chunk) = frame.data_ref() {
            if collected.len() + chunk.len() > MAX_REQUEST_BYTES as usize {
                return Err("request too large".into());
            }
            collected.extend_from_slice(chunk);
        }
    }
    Ok(collected)
}

fn json_response(status: StatusCode, body: serde_json::Value) -> Response<ProxyBody> {
    let bytes = serde_json::to_vec(&body).unwrap_or_default();
    Response::builder()
        .status(status)
        .header(CONTENT_TYPE, "application/json")
        .header("Access-Control-Allow-Origin", "*")
        .body(Full::new(Bytes::from(bytes)))
        .unwrap()
}

pub fn stop_subscription_proxy(handle: &SubscriptionProxyHandle) {
    handle.cancel.notify_waiters();
}
