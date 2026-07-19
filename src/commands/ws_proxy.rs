//! Rust-side WebSocket relay to the runtime's native JSON-RPC gateway (`/api/ws`).
//!
//! The official Hermes desktop connects its renderer DIRECTLY to the dashboard's
//! `/api/ws` JSON-RPC WebSocket. A Tauri webview can't always do that (a packaged
//! WKWebView may refuse `ws://127.0.0.1` from the `tauri://` origin as mixed
//! content), so this module lets the *Rust* process — which has no webview origin
//! restriction — open that exact official socket and relay frames to/from the
//! webview over Tauri events + commands. The kernel therefore always sees a
//! standard official JSON-RPC/WS client, regardless of platform.
//!
//! This supersedes the removed fork-only SSE+POST relay path (P-009): one
//! ordered bidirectional channel, no per-RPC HTTP round trip, no async-ack split,
//! and the session token never leaves Rust (no query-string leak).
//!
//! Wire contract with the JS shim (`web/src/lib/gateway-relay-socket.ts`):
//!   - `gateway_ws_open { connectionId }`  → resolves once the WS handshake succeeds
//!   - emits `gateway-ws-message { connectionId, data }` per inbound text frame
//!   - emits `gateway-ws-closed  { connectionId, message }` on close/error/EOF
//!   - `gateway_ws_send  { connectionId, data }` → write one text frame
//!   - `gateway_ws_close { connectionId }`        → tear the connection down
//!
//! Every event is tagged with `connectionId` so a stale relay from a prior
//! connection can never deliver into a freshly-opened socket's shim.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager, State};
use tokio::sync::{mpsc, Notify};
use tokio_tungstenite::tungstenite::Message;

use crate::error::AppError;
use crate::process::dashboard::{
    build_gateway_url, build_gateway_ws_url_with_ticket, fetch_session_token,
};
use crate::state::{AppState, GatewayWsHandle};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayWsOpenInput {
    pub connection_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayWsSendInput {
    pub connection_id: String,
    pub data: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayWsCloseInput {
    pub connection_id: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WsMessagePayload {
    connection_id: String,
    data: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WsClosedPayload {
    connection_id: String,
    message: String,
    /// WebSocket close code, when the peer sent a Close frame. 4401 = bad
    /// credentials, 4403 = host/origin rejected. The frontend uses this to
    /// stop blindly reconnecting and surface a re-login prompt instead.
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<u16>,
}

/// Tear down whatever connection is currently active (if any). Caller holds no lock.
fn shutdown_active(state: &State<'_, AppState>) -> Result<(), AppError> {
    let mut inner = state.inner.lock()?;
    if let Some(prev) = inner.gateway_ws.take() {
        prev.abort.store(true, Ordering::Relaxed);
        prev.notify.notify_waiters();
    }
    Ok(())
}

/// Open the official `/api/ws` WebSocket from Rust and start relaying frames.
///
/// Resolves once the handshake completes; the JS shim treats that as `onopen`.
/// On token rotation (dashboard restart between launches) the first connect can
/// fail auth — we refresh the session token once and retry before surfacing the error.
#[tauri::command]
pub async fn gateway_ws_open(
    input: GatewayWsOpenInput,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<(), AppError> {
    let connection_id = input.connection_id;
    shutdown_active(&state)?;

    let (api_base_url, auth, is_remote) = {
        let inner = state.inner.lock()?;
        (
            inner.api_base_url.clone(),
            inner.dashboard_auth(),
            inner.connection_mode == crate::connection::ConnectionMode::Remote,
        )
    };

    let stream = match &auth {
        // Gated remote: mint a single-use 30s ticket per connect. A 401 mint
        // means the session is dead → surface an auth error (frontend prompts
        // re-login); one retry covers a TTL race between mint and connect.
        crate::state::DashboardAuth::Oauth(session) => {
            let ticket = match session.mint_ws_ticket().await {
                Ok(t) => t,
                Err(err) => {
                    if let AppError::AuthSessionExpired(_) = &err {
                        emit_ws_auth_expired(&app, &api_base_url);
                    }
                    return Err(err);
                }
            };
            let url = build_gateway_ws_url_with_ticket(&api_base_url, &ticket);
            match tokio_tungstenite::connect_async(url).await {
                Ok((ws, _)) => ws,
                Err(_) => {
                    // Ticket may have expired (single-use, 30s); mint fresh once.
                    let ticket2 = match session.mint_ws_ticket().await {
                        Ok(t) => t,
                        Err(err) => {
                            if let AppError::AuthSessionExpired(_) = &err {
                                emit_ws_auth_expired(&app, &api_base_url);
                            }
                            return Err(err);
                        }
                    };
                    let url2 = build_gateway_ws_url_with_ticket(&api_base_url, &ticket2);
                    match tokio_tungstenite::connect_async(url2).await {
                        Ok((ws, _)) => ws,
                        Err(e) => return Err(map_ws_connect_error(e)),
                    }
                }
            }
        }
        crate::state::DashboardAuth::Token(token) => {
            let token = token.clone();
            match tokio_tungstenite::connect_async(build_gateway_url(
                &api_base_url,
                token.as_deref(),
            ))
            .await
            {
                Ok((ws, _resp)) => ws,
                // Remote tokens are static; scraping the remote's HTML for a
                // fresh one would just hammer it with a doomed retry.
                Err(first_err) if is_remote => {
                    return Err(AppError::GatewayWs(first_err.to_string()))
                }
                Err(first_err) => {
                    // Token may have rotated (dashboard restarted). Refresh once.
                    match fetch_session_token(&api_base_url).await {
                        Some(fresh) => {
                            let fresh_url = build_gateway_url(&api_base_url, Some(&fresh));
                            {
                                let mut inner = state.inner.lock()?;
                                inner.session_token = Some(fresh.clone());
                                inner.gateway_url = fresh_url.clone();
                            }
                            match tokio_tungstenite::connect_async(fresh_url).await {
                                Ok((ws, _resp)) => ws,
                                Err(e) => return Err(AppError::GatewayWs(e.to_string())),
                            }
                        }
                        None => return Err(AppError::GatewayWs(first_err.to_string())),
                    }
                }
            }
        }
    };

    let (mut sink, mut read) = stream.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    let abort = Arc::new(AtomicBool::new(false));
    let notify = Arc::new(Notify::new());

    {
        let mut inner = state.inner.lock()?;
        inner.gateway_ws = Some(GatewayWsHandle {
            connection_id: connection_id.clone(),
            tx,
            abort: abort.clone(),
            notify: notify.clone(),
        });
    }

    // Writer task: drains outbound frames; closes the socket on abort / channel drop.
    {
        let abort_w = abort.clone();
        let notify_w = notify.clone();
        tauri::async_runtime::spawn(async move {
            // The dashboard's uvicorn pings every 20s and closes the socket when it
            // doesn't see a pong within 20s (ws_ping_timeout). On this split
            // sink/stream relay, tungstenite's automatic pong only flushes when the
            // write half is polled — and the writer sits idle between RPCs. So on an
            // otherwise-quiet gateway the queued pong never goes out, uvicorn drops
            // the connection, and the desktop reconnects every ~20-40s ("网关经常
            // 中断，需要重连"). Send our own keepalive ping well under that window:
            // it keeps the socket warm and, by driving the sink, flushes any pending
            // pong. The reader already ignores inbound Ping/Pong frames.
            let mut keepalive = tokio::time::interval(std::time::Duration::from_secs(10));
            keepalive.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                if abort_w.load(Ordering::Relaxed) {
                    break;
                }
                tokio::select! {
                    _ = notify_w.notified() => break,
                    _ = keepalive.tick() => {
                        // Empty payload; uvicorn just needs the frame to keep the
                        // socket alive (and the send flushes any pending pong).
                        if sink.send(Message::Ping(Default::default())).await.is_err() {
                            break;
                        }
                    }
                    out = rx.recv() => match out {
                        Some(text) => {
                            if sink.send(Message::text(text)).await.is_err() {
                                break;
                            }
                        }
                        None => break,
                    }
                }
            }
            let _ = sink.close().await;
        });
    }

    // Reader task: relays inbound text frames to the webview; emits closed on end.
    {
        let app_r = app.clone();
        let cid = connection_id.clone();
        let abort_r = abort.clone();
        let notify_r = notify.clone();
        tauri::async_runtime::spawn(async move {
            let mut reason = String::from("closed");
            let mut close_code: Option<u16> = None;
            loop {
                if abort_r.load(Ordering::Relaxed) {
                    break;
                }
                tokio::select! {
                    _ = notify_r.notified() => break,
                    item = read.next() => match item {
                        Some(Ok(Message::Text(t))) => {
                            let _ = app_r.emit(
                                "gateway-ws-message",
                                WsMessagePayload { connection_id: cid.clone(), data: t.to_string() },
                            );
                        }
                        // The JSON-RPC gateway speaks text frames only; ping/pong are
                        // handled inside tungstenite, binary is unexpected — ignore both.
                        Some(Ok(Message::Binary(_))) | Some(Ok(Message::Ping(_)))
                        | Some(Ok(Message::Pong(_))) | Some(Ok(Message::Frame(_))) => {}
                        Some(Ok(Message::Close(frame))) => {
                            // Capture the numeric close code (4401 auth, 4403
                            // host/origin) so the frontend can stop reconnecting.
                            close_code = frame.as_ref().map(|f| u16::from(f.code));
                            reason = frame
                                .map(|f| f.reason.to_string())
                                .filter(|r| !r.is_empty())
                                .unwrap_or_else(|| "closed".to_string());
                            break;
                        }
                        Some(Err(e)) => {
                            reason = e.to_string();
                            break;
                        }
                        None => {
                            reason = "stream ended".to_string();
                            break;
                        }
                    }
                }
            }
            // Wake the writer so it closes the socket too.
            abort_r.store(true, Ordering::Relaxed);
            notify_r.notify_waiters();
            // Drop the handle if it is still ours (a newer open may have replaced it).
            if let Ok(mut inner) = app_r.state::<AppState>().inner.lock() {
                if inner
                    .gateway_ws
                    .as_ref()
                    .is_some_and(|h| h.connection_id == cid)
                {
                    inner.gateway_ws = None;
                }
            }
            // A 4401 (auth) close on an oauth remote means re-login is needed;
            // tell the frontend explicitly (the close-code event handles the
            // reconnect-suppression, this drives the banner).
            if close_code == Some(4401) {
                if let Ok(inner) = app_r.state::<AppState>().inner.lock() {
                    if inner.oauth_session.is_some() {
                        emit_ws_auth_expired(&app_r, &inner.api_base_url.clone());
                    }
                }
            }
            let _ = app_r.emit(
                "gateway-ws-closed",
                WsClosedPayload {
                    connection_id: cid,
                    message: reason,
                    code: close_code,
                },
            );
        });
    }

    Ok(())
}

/// Map a tungstenite connect error to an auth error when the upgrade was
/// rejected with HTTP 401/403 (some servers reject before accepting the WS).
fn map_ws_connect_error(err: tokio_tungstenite::tungstenite::Error) -> AppError {
    use tokio_tungstenite::tungstenite::Error as WsErr;
    if let WsErr::Http(resp) = &err {
        let status = resp.status().as_u16();
        if status == 401 || status == 403 {
            return AppError::AuthSessionExpired(format!(
                "gateway rejected the WebSocket upgrade with HTTP {status}"
            ));
        }
    }
    AppError::GatewayWs(err.to_string())
}

/// Emit `connection-auth-expired` from the WS path (mint 401 / close 4401).
fn emit_ws_auth_expired(app: &tauri::AppHandle, base_url: &str) {
    let _ = app.emit(
        "connection-auth-expired",
        serde_json::json!({ "baseUrl": base_url, "reason": "session_expired", "loginUrl": null }),
    );
}

#[tauri::command]
pub async fn gateway_ws_send(
    input: GatewayWsSendInput,
    state: State<'_, AppState>,
) -> Result<(), AppError> {
    let inner = state.inner.lock()?;
    match &inner.gateway_ws {
        Some(handle) if handle.connection_id == input.connection_id => handle
            .tx
            .send(input.data)
            .map_err(|_| AppError::GatewayWs("relay send channel closed".to_string())),
        _ => Err(AppError::GatewayWs(
            "no active relay connection".to_string(),
        )),
    }
}

#[tauri::command]
pub async fn gateway_ws_close(
    input: GatewayWsCloseInput,
    state: State<'_, AppState>,
) -> Result<(), AppError> {
    let mut inner = state.inner.lock()?;
    if let Some(handle) = inner.gateway_ws.as_ref() {
        if handle.connection_id == input.connection_id {
            handle.abort.store(true, Ordering::Relaxed);
            handle.notify.notify_waiters();
            inner.gateway_ws = None;
        }
    }
    Ok(())
}
