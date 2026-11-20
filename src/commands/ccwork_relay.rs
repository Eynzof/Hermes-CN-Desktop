//! Authenticated loopback OpenAI compatibility boundary for Core. ccwork
//! receives the original messages/tools plus its JWT and organization header.
//! Its proxy handles model authorization, freezing, usage settlement and release.
use std::collections::{BTreeMap, HashSet};
use std::convert::Infallible;
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use bytes::Bytes;
use futures_util::StreamExt;
use http_body_util::combinators::UnsyncBoxBody;
use http_body_util::{BodyExt, Full, Limited, StreamBody};
use hyper::body::{Frame, Incoming};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Request, Response};
use hyper_util::rt::TokioIo;
use serde_json::{json, Value};
use tokio::net::TcpListener;
use tokio::sync::{mpsc, watch, Mutex, RwLock};

use super::{api_base, session};
use crate::error::AppError;

type Body = UnsyncBoxBody<Bytes, Infallible>;
static HTTP: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(30))
        .read_timeout(Duration::from_secs(180))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("ccwork inference client")
});
static RELAY: Mutex<Option<Handle>> = Mutex::const_new(None);
#[derive(Clone)]
pub(super) struct Local {
    pub base_url: String,
    pub token: String,
}
struct Handle {
    local: Local,
    models: Arc<RwLock<HashSet<String>>>,
    shutdown: watch::Sender<bool>,
}

pub(super) async fn active() -> bool {
    RELAY.lock().await.is_some()
}
pub(super) async fn stop() {
    if let Some(handle) = RELAY.lock().await.take() {
        let _ = handle.shutdown.send(true);
    }
}
pub(super) async fn ensure(ids: &[String]) -> Result<Local, AppError> {
    let mut guard = RELAY.lock().await;
    if let Some(handle) = guard.as_mut() {
        *handle.models.write().await = ids.iter().cloned().collect();
        return Ok(handle.local.clone());
    }
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;
    let port = listener
        .local_addr()
        .map_err(|e| AppError::Internal(e.to_string()))?
        .port();
    let mut entropy = [0u8; 32];
    getrandom::fill(&mut entropy).map_err(|e| AppError::Internal(e.to_string()))?;
    let token = entropy
        .iter()
        .map(|v| format!("{v:02x}"))
        .collect::<String>();
    let local = Local {
        base_url: format!("http://127.0.0.1:{port}/v1"),
        token,
    };
    let models = Arc::new(RwLock::new(ids.iter().cloned().collect::<HashSet<_>>()));
    let (shutdown, mut cancelled) = watch::channel(false);
    let served = local.clone();
    let allowed = models.clone();
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _=cancelled.changed()=>break,
                accepted=listener.accept()=>{
                    let Ok((socket,_))=accepted else {break};
                    let local=served.clone();let models=allowed.clone();let mut stopped=cancelled.clone();
                    tokio::spawn(async move {
                        let worker_cancel=stopped.clone();
                        let service=service_fn(move |req|handle(req,local.clone(),models.clone(),worker_cancel.clone()));
                        tokio::select! { _=stopped.changed()=>{}, _=http1::Builder::new().serve_connection(TokioIo::new(socket),service)=>{} }
                    });
                }
            }
        }
    });
    *guard = Some(Handle {
        local: local.clone(),
        models,
        shutdown,
    });
    Ok(local)
}
fn json_response(code: u16, value: Value) -> Response<Body> {
    Response::builder()
        .status(code)
        .header("Content-Type", "application/json")
        .header("Cache-Control", "no-store")
        .body(Full::new(Bytes::from(value.to_string())).boxed_unsync())
        .expect("valid JSON response")
}
fn error(code: u16, message: &str) -> Response<Body> {
    json_response(
        code,
        json!({"error":{"message":message,"type":"ccwork_error","code":code}}),
    )
}

fn friendly_upstream_error(code: u16, value: &Value) -> String {
    let error = &value["error"];
    let category = error["error_category"]
        .as_str()
        .or_else(|| error["error_type"].as_str())
        .unwrap_or_default();
    let topup_reason = error["topup_reason"].as_str().unwrap_or_default();
    if category == "organization_insufficient_credits"
        || category == "insufficient_credits"
        || category == "freeze_failed"
        || topup_reason == "wallet_insufficient"
    {
        return if category == "organization_insufficient_credits" && !topup_reason.is_empty() {
            "本月 LLM 代币已用完，请充值或开启自动补充后重试".into()
        } else if category == "organization_insufficient_credits" {
            "团队钱包余额不足，请充值后重试".into()
        } else {
            "模型代币余额不足，请充值后重试".into()
        };
    }
    if matches!(category, "budget_exceeded" | "conversation_quota_exceeded") {
        return "已达到当前用量限制，请调整额度或稍后重试".into();
    }
    if matches!(category, "upstream_rate_limited" | "rate_limited") || code == 429 {
        return "请求过于频繁，请稍后重试或切换模型".into();
    }
    if matches!(category, "unauthorized" | "auth_failed") || matches!(code, 401 | 403) {
        return "模型服务认证已失效，请重新登录或检查模型配置".into();
    }
    if code == 408 || code == 504 || category.contains("timeout") {
        return "模型响应超时，请稍后重试或减少上下文内容".into();
    }
    if code >= 500 || category == "upstream_error" {
        return "模型上游暂时不可用，请稍后重试或切换模型".into();
    }
    value["error"]["message"]
        .as_str()
        .unwrap_or("模型请求失败")
        .to_string()
}
fn authorized(req: &Request<Incoming>, local: &Local) -> bool {
    let expected = format!("Bearer {}", local.token);
    let origin = local
        .base_url
        .trim_end_matches("/v1")
        .trim_start_matches("http://");
    req.headers()
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        == Some(expected.as_str())
        && req.headers().get("host").and_then(|v| v.to_str().ok()) == Some(origin)
        && !req.headers().contains_key("origin")
}
async fn handle(
    req: Request<Incoming>,
    local: Local,
    models: Arc<RwLock<HashSet<String>>>,
    cancelled: watch::Receiver<bool>,
) -> Result<Response<Body>, Infallible> {
    if !authorized(&req, &local) {
        return Ok(error(401, "ccworkhermes 本机推理凭证无效"));
    }
    if req.method() != hyper::Method::POST || req.uri().path() != "/v1/chat/completions" {
        return Ok(error(404, "推理端点不存在"));
    }
    let bytes = match Limited::new(req.into_body(), 16 * 1024 * 1024)
        .collect()
        .await
    {
        Ok(v) => v.to_bytes(),
        Err(_) => return Ok(error(413, "推理请求过大")),
    };
    let mut body: Value = match serde_json::from_slice(&bytes) {
        Ok(Value::Object(obj)) => Value::Object(obj),
        _ => return Ok(error(400, "推理请求必须为 JSON 对象")),
    };
    let id = body["model"].as_str().unwrap_or_default().to_string();
    if !models.read().await.contains(&id) {
        return Ok(error(403, "模型不在 ccwork 账号目录中"));
    }
    if body["messages"].as_array().is_none_or(|m| m.is_empty()) {
        return Ok(error(400, "messages 不能为空"));
    }
    let streaming = body["stream"].as_bool().unwrap_or(false);
    // ccwork only accepts streaming inference. Aggregate locally when the Core
    // SDK asks for a completion, without creating a second billed request.
    body["stream"] = true.into();
    let upstream = match open_proxy(body).await {
        Ok(v) => v,
        Err(e) => return Ok(error(502, &e.to_string())),
    };
    if !upstream.status().is_success() {
        let status = upstream.status().as_u16();
        let value: Value = upstream.json().await.unwrap_or(json!({}));
        return Ok(error(status, &friendly_upstream_error(status, &value)));
    }
    if !upstream
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|s| s.starts_with("text/event-stream"))
    {
        return Ok(error(502, "ccwork 未返回推理事件流"));
    }
    let (tx, rx) = mpsc::channel::<Bytes>(16);
    let done = tokio::spawn(pump(upstream, id, streaming, tx, cancelled));
    if streaming {
        let stream = futures_util::stream::unfold(rx, |mut rx| async move {
            rx.recv()
                .await
                .map(|bytes| (Ok::<_, Infallible>(Frame::data(bytes)), rx))
        });
        Ok(Response::builder()
            .header("Content-Type", "text/event-stream")
            .header("Cache-Control", "no-store")
            .body(StreamBody::new(stream).boxed_unsync())
            .expect("SSE response"))
    } else {
        drop(rx);
        match done.await {
            Ok(Ok(value)) => Ok(json_response(200, value)),
            Ok(Err(message)) => Ok(error(502, &message)),
            Err(_) => Ok(error(502, "ccwork 推理中断")),
        }
    }
}
async fn open_proxy(body: Value) -> Result<reqwest::Response, AppError> {
    let current = session().await?;
    let build = |token: &str| {
        HTTP.post(format!(
            "{}/llm/proxy",
            api_base(&current.base_url).unwrap_or_default()
        ))
        .bearer_auth(token)
        .header("X-Tabtin-Organization-Id", &current.organization_id)
        .header("X-Tabtin-Request-Source", "ccworkhermes")
        .json(&body)
    };
    let result = build(&current.access_token).send().await?;
    if result.status() != reqwest::StatusCode::UNAUTHORIZED {
        return Ok(result);
    }
    let mut guard = super::SESSION.lock().await;
    if let Some(stored) = guard.as_mut() {
        if stored.access_token == current.access_token {
            stored.expires_at = 0;
        }
    }
    drop(guard);
    let refreshed = session().await?;
    // Retrying only a rejected authentication attempt never repeats a billed
    // inference. Stream/network errors must be returned to Core, not retried here.
    build(&refreshed.access_token)
        .send()
        .await
        .map_err(Into::into)
}

#[derive(Default)]
struct Decoder {
    buffer: Vec<u8>,
}
impl Decoder {
    fn feed(&mut self, bytes: &[u8]) -> Result<Vec<(String, String)>, String> {
        self.buffer.extend_from_slice(bytes);
        let mut frames = Vec::new();
        while let Some((position, width)) = self
            .buffer
            .windows(2)
            .position(|w| w == b"\n\n")
            .map(|p| (p, 2))
            .or_else(|| {
                self.buffer
                    .windows(4)
                    .position(|w| w == b"\r\n\r\n")
                    .map(|p| (p, 4))
            })
        {
            if position > 4 * 1024 * 1024 {
                return Err("ccwork 事件过大".into());
            }
            let raw = String::from_utf8(self.buffer.drain(..position + width).collect())
                .map_err(|_| "ccwork 事件编码无效")?;
            let mut event = String::new();
            let mut data = Vec::new();
            for line in raw.lines() {
                if let Some(v) = line.strip_prefix("event:") {
                    event = v.trim().into();
                } else if let Some(v) = line.strip_prefix("data:") {
                    data.push(v.strip_prefix(' ').unwrap_or(v));
                }
            }
            if !data.is_empty() {
                frames.push((event, data.join("\n")));
            }
        }
        if self.buffer.len() > 4 * 1024 * 1024 {
            return Err("ccwork 事件过大".into());
        }
        Ok(frames)
    }
}
struct Normalizer {
    id: String,
    model: String,
    created: u64,
    usage: Value,
}
impl Normalizer {
    fn new(model: String) -> Self {
        Self {
            id: format!("chatcmpl-ccwork-{}", super::now()),
            model,
            created: super::now(),
            usage: json!({}),
        }
    }
    fn chunk(&self, delta: Value, finish: Value) -> Value {
        json!({"id":self.id,"object":"chat.completion.chunk","created":self.created,"model":self.model,"choices":[{"index":0,"delta":delta,"finish_reason":finish}]})
    }
    fn convert(&mut self, event: &str, mut value: Value) -> Result<Option<Value>, String> {
        if event == "tabtin.billing" {
            if value["charge_status"] == "failed"
                || value["error_category"]
                    .as_str()
                    .is_some_and(|s| !s.is_empty())
            {
                return Err("ccwork 用量结算失败，请查看 ccwork 账单".into());
            }
            return Ok(None);
        }
        if event == "capability_downgrade" {
            return Ok(None);
        }
        if value.get("error").is_some() || value["type"] == "error" {
            let category = value["error"]["error_category"]
                .as_str()
                .or_else(|| value["error"]["type"].as_str())
                .unwrap_or_default();
            let message = if category == "organization_insufficient_credits"
                || category == "insufficient_credits"
            {
                value["error"]["message"]
                    .as_str()
                    .filter(|message| !message.contains("模型服务暂时不可用"))
                    .unwrap_or("模型代币余额不足，请充值后重试")
            } else {
                value["error"]["message"]
                .as_str()
                .or_else(|| value["message"].as_str())
                .or_else(|| value["error"].as_str())
                .unwrap_or("ccwork 模型或计费请求失败")
            };
            return Err(message.into());
        }
        match value["type"].as_str().unwrap_or_default() {
            "message_start" => {
                let message = &value["message"];
                if let Some(id) = message["id"].as_str() {
                    self.id = id.into();
                }
                self.usage = message["usage"].clone();
                return Ok(Some(self.chunk(json!({"role":"assistant"}), Value::Null)));
            }
            "content_block_start" => {
                let b = &value["content_block"];
                if b["type"] == "text" && b["text"].as_str().is_some_and(|s| !s.is_empty()) {
                    return Ok(Some(self.chunk(json!({"content":b["text"]}), Value::Null)));
                }
                return Ok(None);
            }
            "content_block_delta" => {
                let delta = &value["delta"];
                let converted = match delta["type"].as_str() {
                    Some("text_delta") => json!({"content":delta["text"]}),
                    Some("thinking_delta") => json!({"reasoning_content":delta["thinking"]}),
                    _ => return Ok(None),
                };
                return Ok(Some(self.chunk(converted, Value::Null)));
            }
            "message_delta" => {
                if let Some(map) = value["usage"].as_object() {
                    if !self.usage.is_object() {
                        self.usage = json!({});
                    }
                    for (k, v) in map {
                        self.usage[k] = v.clone();
                    }
                }
                let finish = match value["delta"]["stop_reason"].as_str() {
                    Some("tool_use") => "tool_calls",
                    Some("max_tokens") => "length",
                    _ => "stop",
                };
                let mut chunk = self.chunk(json!({}), finish.into());
                chunk["usage"] = normalize_usage(&self.usage);
                return Ok(Some(chunk));
            }
            "message_stop" | "content_block_stop" | "ping" => return Ok(None),
            _ => {}
        }
        // ccwork already translates native Claude tool blocks to OpenAI deltas.
        if value.get("choices").is_none() && value.get("usage").is_none() {
            return Ok(None);
        }
        if let Some(id) = value["id"].as_str() {
            self.id = id.into();
        }
        value["id"] = self.id.clone().into();
        value["model"] = self.model.clone().into();
        value["object"] = "chat.completion.chunk".into();
        if value["created"].is_null() {
            value["created"] = self.created.into();
        }
        if !value["usage"].is_null() {
            value["usage"] = normalize_usage(&value["usage"]);
        }
        if value["choices"].is_null() {
            value["choices"] = json!([]);
        }
        Ok(Some(value))
    }
}
fn normalize_usage(value: &Value) -> Value {
    let mut usage = value.clone();
    if !usage.is_object() {
        usage = json!({});
    }
    let input = value["prompt_tokens"]
        .as_u64()
        .or_else(|| value["input_tokens"].as_u64())
        .unwrap_or(0);
    let output = value["completion_tokens"]
        .as_u64()
        .or_else(|| value["output_tokens"].as_u64())
        .unwrap_or(0);
    usage["prompt_tokens"] = input.into();
    usage["completion_tokens"] = output.into();
    usage["total_tokens"] = value["total_tokens"]
        .as_u64()
        .unwrap_or(input + output)
        .into();
    usage
}
#[derive(Default)]
struct Completion {
    choices: BTreeMap<u64, Value>,
    tools: BTreeMap<(u64, u64), Value>,
    usage: Option<Value>,
    bytes: usize,
}
impl Completion {
    fn add(&mut self, chunk: &Value) -> Result<(), String> {
        self.bytes += chunk.to_string().len();
        if self.bytes > 32 * 1024 * 1024 {
            return Err("ccwork 非流式响应过大".into());
        }
        if !chunk["usage"].is_null() {
            self.usage = Some(chunk["usage"].clone());
        }
        for choice in chunk["choices"].as_array().into_iter().flatten() {
            let index = choice["index"].as_u64().unwrap_or(0);
            let out=self.choices.entry(index).or_insert_with(||json!({"index":index,"message":{"role":"assistant","content":null},"finish_reason":null}));
            let delta = &choice["delta"];
            for key in ["content", "reasoning_content", "refusal"] {
                if let Some(text) = delta[key].as_str() {
                    let mut full = out["message"][key].as_str().unwrap_or_default().to_string();
                    full.push_str(text);
                    out["message"][key] = full.into();
                }
            }
            if !choice["finish_reason"].is_null() {
                out["finish_reason"] = choice["finish_reason"].clone();
            }
            for tool in delta["tool_calls"].as_array().into_iter().flatten() {
                let ti = tool["index"].as_u64().unwrap_or(0);
                let entry = self.tools.entry((index, ti)).or_insert_with(
                    || json!({"id":"","type":"function","function":{"name":"","arguments":""}}),
                );
                if let Some(id) = tool["id"].as_str() {
                    entry["id"] = id.into();
                }
                for key in ["name", "arguments"] {
                    if let Some(text) = tool["function"][key].as_str() {
                        let full = format!(
                            "{}{text}",
                            entry["function"][key].as_str().unwrap_or_default()
                        );
                        entry["function"][key] = full.into();
                    }
                }
            }
        }
        Ok(())
    }
    fn finish(mut self, n: &Normalizer) -> Result<Value, String> {
        if self.choices.is_empty() {
            return Err("ccwork 返回空推理结果".into());
        }
        for ((ci, _), tool) in self.tools {
            let Some(choice) = self.choices.get_mut(&ci) else {
                continue;
            };
            if choice["message"]["tool_calls"].is_null() {
                choice["message"]["tool_calls"] = json!([]);
            }
            choice["message"]["tool_calls"]
                .as_array_mut()
                .expect("tools array")
                .push(tool);
        }
        if self.choices.values().any(|c| c["finish_reason"].is_null()) {
            return Err("ccwork 推理流未完成".into());
        }
        let mut out = json!({"id":n.id,"object":"chat.completion","created":n.created,"model":n.model,"choices":self.choices.into_values().collect::<Vec<_>>()});
        if let Some(usage) = self.usage {
            out["usage"] = usage;
        }
        Ok(out)
    }
}
async fn pump(
    upstream: reqwest::Response,
    model: String,
    streaming: bool,
    tx: mpsc::Sender<Bytes>,
    mut cancelled: watch::Receiver<bool>,
) -> Result<Value, String> {
    let result = pump_inner(upstream, model, streaming, &tx, &mut cancelled).await;
    if let Err(message) = &result {
        if streaming {
            let value = json!({"error":{"message":message,"type":"ccwork_error"}});
            let _ = tx
                .send(Bytes::from(format!("data: {value}\n\ndata: [DONE]\n\n")))
                .await;
        }
    }
    result
}
async fn pump_inner(
    upstream: reqwest::Response,
    model: String,
    streaming: bool,
    tx: &mpsc::Sender<Bytes>,
    cancelled: &mut watch::Receiver<bool>,
) -> Result<Value, String> {
    let mut stream = upstream.bytes_stream();
    let mut decoder = Decoder::default();
    let mut n = Normalizer::new(model);
    let mut completion = Completion::default();
    let mut done = false;
    let mut billing_confirmed = false;
    let mut terminal_chunks = Vec::new();
    loop {
        let next = tokio::select! {_=cancelled.changed()=>return Err("ccwork 账号已退出".into()),next=stream.next()=>next};
        let Some(chunk) = next else { break };
        let chunk = chunk.map_err(|_| "ccwork 推理连接中断")?;
        for (event, payload) in decoder.feed(&chunk)? {
            if payload.trim() == "[DONE]" {
                done = true;
                break;
            }
            let value: Value =
                serde_json::from_str(&payload).map_err(|_| "ccwork 返回无效推理事件")?;
            if event == "tabtin.billing" {
                billing_confirmed = matches!(
                    value["charge_status"].as_str(),
                    Some("success" | "byok_exempt" | "charged")
                );
            }
            if let Some(value) = n.convert(&event, value)? {
                if streaming {
                    // Core may stop reading as soon as finish_reason arrives.
                    // Hold the terminal chunk until ccwork confirms settlement.
                    if value["choices"].as_array().is_some_and(|choices| {
                        choices.iter().any(|c| !c["finish_reason"].is_null())
                    }) {
                        terminal_chunks.push(value);
                        continue;
                    }
                    tx.send(Bytes::from(format!("data: {value}\n\n")))
                        .await
                        .map_err(|_| "推理调用已取消")?;
                } else {
                    completion.add(&value)?;
                }
            }
        }
        if done {
            break;
        }
    }
    if !done {
        return Err("ccwork 推理流意外结束".into());
    }
    if !billing_confirmed {
        return Err("ccwork 未确认用量结算".into());
    }
    if streaming {
        if terminal_chunks.is_empty() {
            return Err("ccwork 推理流未完成".into());
        }
        for value in terminal_chunks {
            tx.send(Bytes::from(format!("data: {value}\n\n")))
                .await
                .map_err(|_| "推理调用已取消")?;
        }
        tx.send(Bytes::from_static(b"data: [DONE]\n\n"))
            .await
            .map_err(|_| "推理调用已取消")?;
        Ok(Value::Null)
    } else {
        completion.finish(&n)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;
    #[test]
    fn split_sse_unicode_and_metadata() {
        let raw="event: tabtin.billing\r\ndata: {\"charge_status\":\"charged\",\"模型\":\"测试\"}\r\n\r\n";
        let mut decoder = Decoder::default();
        let mut events = Vec::new();
        for byte in raw.as_bytes() {
            events.extend(decoder.feed(&[*byte]).unwrap());
        }
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].0, "tabtin.billing");
    }
    #[test]
    fn claude_text_reasoning_tools_and_usage_become_completion() {
        let mut n = Normalizer::new("model-uuid".into());
        let mut c = Completion::default();
        for v in [
            json!({"type":"message_start","message":{"id":"claude-id","usage":{"input_tokens":12}}}),
            json!({"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"think"}}),
            json!({"type":"content_block_delta","delta":{"type":"text_delta","text":"你好"}}),
            json!({"choices":[{"index":0,"delta":{"tool_calls":[{"index":2,"id":"tool-id","function":{"name":"read_file","arguments":"{\"path\":"}}]}}]}),
            json!({"choices":[{"index":0,"delta":{"tool_calls":[{"index":2,"function":{"arguments":"\"a\"}"}}]}}]}),
            json!({"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":4}}),
        ] {
            if let Some(v) = n.convert("", v).unwrap() {
                c.add(&v).unwrap();
            }
        }
        let result = c.finish(&n).unwrap();
        assert_eq!(result["model"], "model-uuid");
        assert_eq!(result["choices"][0]["message"]["content"], "你好");
        assert_eq!(
            result["choices"][0]["message"]["tool_calls"][0]["function"]["arguments"],
            "{\"path\":\"a\"}"
        );
        assert_eq!(result["usage"]["prompt_tokens"], 12);
        assert_eq!(result["choices"][0]["finish_reason"], "tool_calls");
    }
    #[test]
    fn model_and_billing_errors_fail_closed() {
        let mut n = Normalizer::new("x".into());
        assert!(n
            .convert("", json!({"error":{"message":"余额不足"}}))
            .is_err());
        assert!(n
            .convert(
                "tabtin.billing",
                json!({"charge_status":"failed","error_category":"settlement"})
            )
            .is_err());
        assert!(n
            .convert(
                "tabtin.billing",
                json!({"charge_status":"charged","credits_charged":"0.001"})
            )
            .unwrap()
            .is_none());
        assert!(Completion::default().finish(&n).is_err());
    }

    #[test]
    fn friendly_upstream_errors_preserve_actionable_billing_messages() {
        let quota = json!({"error":{"error_category":"organization_insufficient_credits","topup_reason":"wallet_insufficient","message":"模型服务暂时不可用，请稍后重试"}});
        assert_eq!(friendly_upstream_error(402, &quota), "本月 LLM 代币已用完，请充值或开启自动补充后重试");
        let wallet = json!({"error":{"error_category":"organization_insufficient_credits","message":"模型服务暂时不可用，请稍后重试"}});
        assert_eq!(friendly_upstream_error(402, &wallet), "团队钱包余额不足，请充值后重试");
        let auth = json!({"error":{"error_category":"unauthorized"}});
        assert_eq!(friendly_upstream_error(401, &auth), "模型服务认证已失效，请重新登录或检查模型配置");
        let rate = json!({"error":{"error_category":"upstream_rate_limited"}});
        assert_eq!(friendly_upstream_error(429, &rate), "请求过于频繁，请稍后重试或切换模型");
    }
    #[tokio::test]
    #[serial_test::serial]
    async fn proxy_sends_jwt_organization_and_original_model_body() {
        use wiremock::matchers::{body_json, header, method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};
        let server = MockServer::start().await;
        let body =
            json!({"model":"model-uuid","messages":[{"role":"user","content":"hi"}],"stream":true});
        Mock::given(method("POST"))
            .and(path("/api/llm/proxy"))
            .and(header("authorization", "Bearer access-token"))
            .and(header("x-tabtin-organization-id", "org-uuid"))
            .and(header("x-tabtin-request-source", "ccworkhermes"))
            .and(body_json(body.clone()))
            .respond_with(ResponseTemplate::new(200).set_body_string("ok"))
            .expect(1)
            .mount(&server)
            .await;
        *super::super::SESSION.lock().await = Some(super::super::Session {
            base_url: server.uri(),
            access_token: "access-token".into(),
            refresh_token: "refresh-token".into(),
            expires_at: super::super::now() + 3600,
            user: super::super::AccountUser {
                id: super::super::AccountUserId::Uuid("user-uuid".into()),
                username: "user@example.com".into(),
                display_name: "User".into(),
                role: 0,
                status: 1,
                group: String::new(),
            },
            organization_id: "org-uuid".into(),
        });
        let response = super::open_proxy(body).await.unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::OK);
        *super::super::SESSION.lock().await = None;
    }

    #[tokio::test]
    async fn streaming_proxy_aggregates_one_billed_request() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};
        let server = MockServer::start().await;
        let raw="data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"OK\"},\"finish_reason\":null}]}\n\ndata: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":1,\"completion_tokens\":2,\"total_tokens\":3}}\n\nevent: tabtin.billing\ndata: {\"charge_status\":\"charged\",\"credits_charged\":\"0.03\"}\n\ndata: [DONE]\n\n";
        Mock::given(method("POST"))
            .and(path("/proxy"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("content-type", "text/event-stream")
                    .set_body_string(raw),
            )
            .expect(1)
            .mount(&server)
            .await;
        let response = HTTP
            .post(format!("{}/proxy", server.uri()))
            .send()
            .await
            .unwrap();
        let (tx, _rx) = mpsc::channel(1);
        let (_cancel, mut stopped) = watch::channel(false);
        let v = pump_inner(response, "id".into(), false, &tx, &mut stopped)
            .await
            .unwrap();
        assert_eq!(v["choices"][0]["message"]["content"], "OK");
        assert_eq!(v["usage"]["total_tokens"], 3);
    }
}
