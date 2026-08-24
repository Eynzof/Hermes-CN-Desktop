//! In-process OpenAI-compatible API server.

use std::convert::Infallible;
use std::net::Ipv4Addr;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper::header::{
    ACCESS_CONTROL_ALLOW_HEADERS, ACCESS_CONTROL_ALLOW_METHODS, ACCESS_CONTROL_ALLOW_ORIGIN,
    CONTENT_TYPE,
};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use serde_json::json;
use tauri::Manager;
use tokio::net::TcpListener;
use tokio::sync::Notify;

use crate::error::AppError;
use crate::state::{ApiServerHandle, AppState};

const PREFERRED_PORT: u16 = 8642;
const MAX_REQUEST_BYTES: u64 = 10 * 1024 * 1024;

type ApiBody = Full<Bytes>;

pub async fn start_api_server(app: tauri::AppHandle) -> Result<ApiServerHandle, AppError> {
    let listener = match TcpListener::bind((Ipv4Addr::LOCALHOST, PREFERRED_PORT)).await {
        Ok(l) => l,
        Err(_) => TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .map_err(|e| AppError::Internal(format!("api server bind failed: {e}")))?,
    };
    let port = listener
        .local_addr()
        .map_err(|e| AppError::Internal(format!("api server port: {e}")))?
        .port();
    let cancel = Arc::new(Notify::new());
    let handle = ApiServerHandle {
        port,
        cancel: cancel.clone(),
    };

    {
        let state = app.state::<AppState>();
        state
            .inner
            .lock()
            .map_err(|e| AppError::Internal(e.to_string()))?
            .api_server = Some(handle.clone());
    }

    let server_app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = serve(listener, server_app, cancel).await {
            log::error!("api server stopped: {e}");
        }
    });

    Ok(handle)
}

async fn serve(
    listener: TcpListener,
    app: tauri::AppHandle,
    cancel: Arc<Notify>,
) -> Result<(), AppError> {
    loop {
        tokio::select! {
            _ = cancel.notified() => break,
            res = listener.accept() => {
                let (stream, _) = res.map_err(|e| AppError::Internal(format!("api server accept: {e}")))?;
                let io = TokioIo::new(stream);
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let service = service_fn(move |req| {
                        let app = app.clone();
                        async move { handle_request(req, app).await }
                    });
                    let _ = http1::Builder::new().serve_connection(io, service).await;
                });
            }
        }
    }
    {
        let state = app.state::<AppState>();
        state
            .inner
            .lock()
            .map_err(|e| AppError::Internal(e.to_string()))?
            .api_server = None;
    }
    Ok(())
}

async fn handle_request(
    req: Request<Incoming>,
    _app: tauri::AppHandle,
) -> Result<Response<ApiBody>, Infallible> {
    let method = req.method().clone();
    let path = req.uri().path().to_string();

    let bytes = match read_body(req).await {
        Ok(b) => b,
        Err(e) => {
            return Ok(json_response(
                StatusCode::PAYLOAD_TOO_LARGE,
                json!({"error": e}),
            ))
        }
    };
    let body_json = serde_json::from_slice::<serde_json::Value>(&bytes).unwrap_or_default();

    let (status, body) = route(method, path, body_json);
    Ok(json_response(status, body))
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

fn route(method: Method, path: String, body: serde_json::Value) -> (StatusCode, serde_json::Value) {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    match (method.as_str(), path.as_str()) {
        ("GET", "/health") => (StatusCode::OK, json!({"status": "ok"})),
        ("GET", "/v1/models") => (StatusCode::OK, json!({"object": "list", "data": []})),
        ("GET", "/v1/capabilities") => (StatusCode::OK, json!({"capabilities": []})),
        ("GET", "/v1/skills") => (StatusCode::OK, json!({"skills": []})),
        ("GET", "/v1/toolsets") => (StatusCode::OK, json!({"toolsets": []})),
        ("POST", "/v1/chat/completions") => {
            let model = body
                .get("model")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown");
            (
                StatusCode::OK,
                json!({
                    "id": format!("chatcmpl-{now}"),
                    "object": "chat.completion",
                    "created": now,
                    "model": model,
                    "choices": [{"index":0,"message":{"role":"assistant","content":"v1 stub"},"finish_reason":"stop"}]
                }),
            )
        }
        ("POST", "/v1/responses") => (
            StatusCode::OK,
            json!({"id": format!("resp-{now}"), "output": []}),
        ),
        ("POST", "/v1/runs") => (
            StatusCode::OK,
            json!({"run_id": format!("run-{now}"), "status": "queued"}),
        ),
        ("GET", "/v1/sessions") => (StatusCode::OK, json!({"sessions": []})),
        ("GET", "/v1/jobs") => (StatusCode::OK, json!({"jobs": []})),
        _ => (
            StatusCode::NOT_FOUND,
            json!({"error": "not_found", "path": path}),
        ),
    }
}

fn json_response(status: StatusCode, body: serde_json::Value) -> Response<ApiBody> {
    let bytes = serde_json::to_vec(&body).unwrap_or_default();
    Response::builder()
        .status(status)
        .header(CONTENT_TYPE, "application/json")
        .header(ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(ACCESS_CONTROL_ALLOW_METHODS, "GET, POST, OPTIONS")
        .header(ACCESS_CONTROL_ALLOW_HEADERS, "*")
        .body(Full::new(Bytes::from(bytes)))
        .unwrap()
}

pub fn stop_api_server(handle: &ApiServerHandle) {
    handle.cancel.notify_waiters();
}
