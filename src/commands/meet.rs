//! Google Meet bundled plugin commands.
//!
//! v1 implements the artifact-directory lifecycle and the Google OAuth loopback
//! flow. The live caption bot itself is expected to run in a Node sidecar
//! (packages/meet-bot); this module manages the active-meeting pointer file,
//! reads/writes status.json and transcript.txt, and cleans up on leave.

use std::collections::HashMap;
use std::convert::Infallible;
use std::net::Ipv4Addr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use bytes::Bytes;
use http_body_util::Full;
use hyper::body::Incoming;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use serde::{Deserialize, Serialize};
use tokio::net::TcpListener;
use tokio::sync::mpsc;

use crate::error::{AppError, AppResult};
use crate::state::AppState;

const MEET_URL_RE: &str = r"^https://meet\.google\.com/(?:(?:lookup/)?[a-z]{3}-?[a-z]{4}-?[a-z]{3}|[a-z]{3}-?[a-z]{4}-?[a-z]{3}|new)(?:\?.*)?$";
const DEFAULT_MEET_OAUTH_PORT: u16 = 43828;
const DEFAULT_MEET_CALLBACK_PATH: &str = "/google-meet/callback";
const LISTEN_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetActivePointer {
    pub pid: Option<u32>,
    pub meeting_id: String,
    pub out_dir: String,
    pub url: String,
    pub started_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub log_path: Option<String>,
    #[serde(default = "default_meet_mode")]
    pub mode: String,
}

fn default_meet_mode() -> String {
    "transcribe".to_string()
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetBotStatus {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub meeting_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub in_call: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub captioning: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub captions_enabled_attempted: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lobby_waiting: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub join_attempted_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub joined_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_caption_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transcript_lines: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transcript_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exited: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub leave_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetTranscriptLine {
    pub ts: String,
    pub speaker: String,
    pub text: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetJoinInput {
    pub url: String,
    pub meeting_id: String,
    #[serde(default = "default_guest_name")]
    pub guest_name: String,
    #[serde(default)]
    pub duration_minutes: Option<u32>,
    #[serde(default = "default_mode")]
    pub mode: String,
    #[serde(default)]
    pub headed: bool,
}

fn default_guest_name() -> String {
    "Hermes Agent".to_string()
}

fn default_mode() -> String {
    "transcribe".to_string()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetJoinResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub meeting_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub out_dir: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetStatusInput {
    #[serde(default)]
    pub meeting_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetStatusResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<MeetBotStatus>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetTranscriptInput {
    #[serde(default)]
    pub meeting_id: Option<String>,
    #[serde(default)]
    pub last: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetTranscriptResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lines: Option<Vec<MeetTranscriptLine>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetLeaveInput {
    #[serde(default)]
    pub meeting_id: Option<String>,
    #[serde(default = "default_leave_reason")]
    pub reason: String,
}

fn default_leave_reason() -> String {
    "user request".to_string()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetLeaveResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub meeting_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetSayInput {
    #[serde(default)]
    pub meeting_id: Option<String>,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetSayResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub queued: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetSetupResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chromium_available: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

// -----------------------------------------------------------------------------
// Filesystem helpers
// -----------------------------------------------------------------------------

fn meetings_root(state: &AppState) -> AppResult<PathBuf> {
    let inner = state.inner.lock().map_err(|e| AppError::Internal(e.to_string()))?;
    Ok(PathBuf::from(&inner.hermes_home).join("workspace").join("meetings"))
}

fn active_pointer_path(root: &Path) -> PathBuf {
    root.join(".active.json")
}

fn meeting_dir(root: &Path, meeting_id: &str) -> PathBuf {
    root.join(meeting_id)
}

fn status_path(dir: &Path) -> PathBuf {
    dir.join("status.json")
}

fn transcript_path(dir: &Path) -> PathBuf {
    dir.join("transcript.txt")
}

fn write_json_atomically(path: &Path, value: &impl Serialize) -> AppResult<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| AppError::Internal(format!("无法创建目录 {}: {}", parent.display(), e)))?;
    }
    let json = serde_json::to_string_pretty(value)
        .map_err(|e| AppError::Internal(format!("JSON 序列化失败: {}", e)))?;
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, format!("{}\n", json))
        .map_err(|e| AppError::Internal(format!("无法写入临时文件 {}: {}", tmp.display(), e)))?;
    std::fs::rename(&tmp, path)
        .map_err(|e| AppError::Internal(format!("无法重命名 {} -> {}: {}", tmp.display(), path.display(), e)))?;
    Ok(())
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> AppResult<Option<T>> {
    if !path.exists() {
        return Ok(None);
    }
    let content = std::fs::read_to_string(path)
        .map_err(|e| AppError::Internal(format!("无法读取 {}: {}", path.display(), e)))?;
    serde_json::from_str(&content)
        .map(Some)
        .map_err(|e| AppError::Internal(format!("解析 {} 失败: {}", path.display(), e)))
}

fn read_text(path: &Path) -> AppResult<String> {
    if !path.exists() {
        return Ok(String::new());
    }
    std::fs::read_to_string(path)
        .map_err(|e| AppError::Internal(format!("无法读取 {}: {}", path.display(), e)))
}

fn parse_transcript(raw: &str) -> Vec<MeetTranscriptLine> {
    let mut lines = Vec::new();
    for raw_line in raw.lines() {
        let line = raw_line.trim();
        if line.is_empty() {
            continue;
        }
        if let Some(caps) = regex_captures_transcript_line(line) {
            lines.push(MeetTranscriptLine {
                ts: caps[0].clone(),
                speaker: caps[1].trim().to_string(),
                text: caps[2].trim().to_string(),
            });
        }
    }
    lines
}

fn regex_captures_transcript_line(line: &str) -> Option<Vec<String>> {
    // Simple parser for `[HH:MM:SS] Speaker: text`.
    let rest = line.strip_prefix('[')?;
    let (ts, rest) = rest.split_once(']')?;
    let rest = rest.trim_start();
    let (speaker, text) = rest.split_once(':')?;
    Some(vec![ts.to_string(), speaker.to_string(), text.to_string()])
}

fn validate_meet_url(url: &str) -> AppResult<()> {
    let re = regex::Regex::new(MEET_URL_RE)
        .map_err(|e| AppError::Internal(format!("Meet URL regex 无效: {}", e)))?;
    if !re.is_match(url.trim()) {
        return Err(AppError::InvalidRequest(format!("Invalid Google Meet URL: {}", url)));
    }
    Ok(())
}

fn now_iso() -> String {
    chrono::Local::now().to_rfc3339()
}

// -----------------------------------------------------------------------------
// Commands
// -----------------------------------------------------------------------------

#[tauri::command]
pub async fn meet_join(state: tauri::State<'_, AppState>, input: MeetJoinInput) -> AppResult<MeetJoinResult> {
    validate_meet_url(&input.url)?;

    let root = meetings_root(&state)?;
    let dir = meeting_dir(&root, &input.meeting_id);
    std::fs::create_dir_all(&dir)
        .map_err(|e| AppError::Internal(format!("无法创建会议目录: {}", e)))?;

    let out_dir = dir.to_string_lossy().to_string();
    let started_at = now_iso();

    let pointer = MeetActivePointer {
        pid: None,
        meeting_id: input.meeting_id.clone(),
        out_dir: out_dir.clone(),
        url: input.url.clone(),
        started_at: started_at.clone(),
        session_id: None,
        log_path: None,
        mode: input.mode.clone(),
    };
    write_json_atomically(&active_pointer_path(&root), &pointer)?;

    let status = MeetBotStatus {
        meeting_id: Some(input.meeting_id.clone()),
        url: Some(input.url.clone()),
        in_call: Some(false),
        captioning: Some(false),
        captions_enabled_attempted: Some(false),
        lobby_waiting: Some(true),
        join_attempted_at: Some(started_at.clone()),
        joined_at: None,
        last_caption_at: None,
        transcript_lines: Some(0),
        transcript_path: Some(transcript_path(&dir).to_string_lossy().to_string()),
        error: None,
        exited: Some(false),
        pid: None,
        leave_reason: None,
    };
    write_json_atomically(&status_path(&dir), &status)?;

    let _ = std::fs::write(transcript_path(&dir), "")
        .map_err(|e| log::warn!("Failed to create empty transcript: {}", e));

    // v1: the Playwright sidecar is not spawned here. The pointer/status files
    // are written so tests and the UI can inspect the lifecycle.
    Ok(MeetJoinResult {
        success: true,
        meeting_id: Some(input.meeting_id),
        out_dir: Some(out_dir),
        error: None,
    })
}

fn resolve_meeting_dir(root: &Path, meeting_id: Option<&String>) -> AppResult<PathBuf> {
    if let Some(id) = meeting_id {
        return Ok(meeting_dir(root, id));
    }
    let pointer: Option<MeetActivePointer> = read_json(&active_pointer_path(root))?;
    match pointer {
        Some(p) => Ok(PathBuf::from(p.out_dir)),
        None => Err(AppError::InvalidRequest("No active meeting.".to_string())),
    }
}

#[tauri::command]
pub async fn meet_status(state: tauri::State<'_, AppState>, input: MeetStatusInput) -> AppResult<MeetStatusResult> {
    let root = meetings_root(&state)?;
    let pointer: Option<MeetActivePointer> = read_json(&active_pointer_path(&root))?;

    let dir = resolve_meeting_dir(&root, input.meeting_id.as_ref())?;
    let active = pointer.as_ref().is_some_and(|p| {
        p.out_dir == dir.to_string_lossy() && p.meeting_id == input.meeting_id.as_deref().unwrap_or(&p.meeting_id)
    });

    let status: Option<MeetBotStatus> = read_json(&status_path(&dir))?;
    Ok(MeetStatusResult {
        success: true,
        active: Some(active),
        status,
        error: None,
    })
}

#[tauri::command]
pub async fn meet_transcript(
    state: tauri::State<'_, AppState>,
    input: MeetTranscriptInput,
) -> AppResult<MeetTranscriptResult> {
    let root = meetings_root(&state)?;
    let dir = resolve_meeting_dir(&root, input.meeting_id.as_ref())?;
    let raw = read_text(&transcript_path(&dir))?;
    let mut lines = parse_transcript(&raw);
    if let Some(n) = input.last {
        if n > 0 && lines.len() > n {
            lines = lines.split_off(lines.len() - n);
        }
    }
    Ok(MeetTranscriptResult {
        success: true,
        lines: Some(lines),
        raw: Some(raw),
        error: None,
    })
}

#[tauri::command]
pub async fn meet_leave(state: tauri::State<'_, AppState>, input: MeetLeaveInput) -> AppResult<MeetLeaveResult> {
    let root = meetings_root(&state)?;
    let dir = resolve_meeting_dir(&root, input.meeting_id.as_ref())?;
    let meeting_id = input.meeting_id.clone().or_else(|| {
        read_json::<MeetActivePointer>(&active_pointer_path(&root))
            .ok()
            .flatten()
            .map(|p| p.meeting_id)
    });

    let mut status: MeetBotStatus = read_json(&status_path(&dir))?.unwrap_or_default();
    status.in_call = Some(false);
    status.lobby_waiting = Some(false);
    status.exited = Some(true);
    status.leave_reason = Some(input.reason.clone());
    write_json_atomically(&status_path(&dir), &status)?;

    let pointer_path = active_pointer_path(&root);
    let _ = std::fs::remove_file(&pointer_path);

    Ok(MeetLeaveResult {
        success: true,
        meeting_id,
        error: None,
    })
}

#[tauri::command]
pub async fn meet_say(_state: tauri::State<'_, AppState>, input: MeetSayInput) -> AppResult<MeetSayResult> {
    Ok(MeetSayResult {
        ok: false,
        queued: Some(false),
        reason: Some(format!(
            "meet_say is not available in v1 (realtime audio is deferred). text={}",
            input.text
        )),
    })
}

#[tauri::command]
pub async fn meet_setup(_state: tauri::State<'_, AppState>) -> AppResult<MeetSetupResult> {
    Ok(MeetSetupResult {
        ok: true,
        chromium_available: Some(false),
        message: Some("Google Meet v1 preflight: Chromium sidecar is not spawned in this version.".to_string()),
        error: None,
    })
}

// -----------------------------------------------------------------------------
// OAuth (loopback listener + auth.json persistence)
// -----------------------------------------------------------------------------

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoogleMeetProviderState {
    pub client_id: String,
    pub redirect_uri: String,
    pub scope: String,
    pub access_token: String,
    pub refresh_token: String,
    pub token_type: String,
    pub expires_at: String,
    pub expires_in: i64,
    pub obtained_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetOauthStartResult {
    pub port: u16,
    pub redirect_uri: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetOauthCallbackResult {
    pub code: String,
    pub state: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetOauthReadResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<GoogleMeetProviderState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[tauri::command]
pub async fn meet_oauth_read(state: tauri::State<'_, AppState>) -> AppResult<MeetOauthReadResult> {
    let path = auth_json_path(&state)?;
    let root = read_auth_json(&path)?;
    let provider = root
        .get("providers")
        .and_then(|p| p.get("google_meet"))
        .and_then(|v| serde_json::from_value::<GoogleMeetProviderState>(v.clone()).ok());
    Ok(MeetOauthReadResult {
        ok: true,
        provider,
        error: None,
    })
}

#[tauri::command]
pub async fn meet_oauth_write(
    state: tauri::State<'_, AppState>,
    provider: GoogleMeetProviderState,
) -> AppResult<MeetOauthReadResult> {
    let path = auth_json_path(&state)?;
    let mut root = read_auth_json(&path)?;
    let providers = root
        .entry("providers")
        .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()));
    if let serde_json::Value::Object(map) = providers {
        map.insert(
            "google_meet".to_string(),
            serde_json::to_value(&provider)
                .map_err(|e| AppError::Internal(format!("无法序列化 Google 凭证: {}", e)))?,
        );
    }
    write_auth_json(&path, &root)?;
    Ok(MeetOauthReadResult {
        ok: true,
        provider: Some(provider),
        error: None,
    })
}

#[tauri::command]
pub async fn meet_oauth_disconnect(state: tauri::State<'_, AppState>) -> AppResult<MeetOauthReadResult> {
    let path = auth_json_path(&state)?;
    let mut root = read_auth_json(&path)?;
    if let Some(serde_json::Value::Object(map)) = root.get_mut("providers") {
        map.remove("google_meet");
    }
    write_auth_json(&path, &root)?;
    Ok(MeetOauthReadResult {
        ok: true,
        provider: None,
        error: None,
    })
}

fn auth_json_path(state: &AppState) -> AppResult<PathBuf> {
    let inner = state.inner.lock().map_err(|e| AppError::Internal(e.to_string()))?;
    Ok(PathBuf::from(&inner.hermes_home).join("auth.json"))
}

fn read_auth_json(path: &Path) -> AppResult<serde_json::Map<String, serde_json::Value>> {
    if !path.exists() {
        return Ok(serde_json::Map::new());
    }
    let content = std::fs::read_to_string(path)
        .map_err(|e| AppError::Internal(format!("无法读取 auth.json: {}", e)))?;
    let value: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| AppError::Internal(format!("auth.json 解析失败: {}", e)))?;
    match value {
        serde_json::Value::Object(map) => Ok(map),
        _ => Ok(serde_json::Map::new()),
    }
}

fn write_auth_json(path: &Path, root: &serde_json::Map<String, serde_json::Value>) -> AppResult<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| AppError::Internal(format!("无法创建 auth.json 目录: {}", e)))?;
    }
    let json = serde_json::to_string_pretty(root)
        .map_err(|e| AppError::Internal(format!("auth.json 序列化失败: {}", e)))?;
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, format!("{}\n", json))
        .map_err(|e| AppError::Internal(format!("无法写入临时 auth.json: {}", e)))?;
    std::fs::rename(&tmp, path)
        .map_err(|e| AppError::Internal(format!("无法重命名 auth.json: {}", e)))?;
    Ok(())
}

// -----------------------------------------------------------------------------
// Loopback listener (mirrors spotify_oauth.rs)
// -----------------------------------------------------------------------------

struct PendingCallback {
    result_rx: Option<mpsc::Receiver<AppResult<MeetOauthCallbackResult>>>,
    abort: Arc<AtomicBool>,
}

static PENDING_CALLBACK: Mutex<Option<PendingCallback>> = Mutex::new(None);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetOauthStartInput {
    #[serde(default = "default_meet_oauth_port")]
    pub port: u16,
    #[serde(default = "default_meet_callback_path")]
    pub path: String,
}

fn default_meet_oauth_port() -> u16 {
    DEFAULT_MEET_OAUTH_PORT
}

fn default_meet_callback_path() -> String {
    DEFAULT_MEET_CALLBACK_PATH.to_string()
}

#[tauri::command]
pub async fn meet_oauth_start(input: MeetOauthStartInput) -> AppResult<MeetOauthStartResult> {
    let port = input.port;
    let path = input.path;
    let redirect_uri = format!("http://127.0.0.1:{}{}", port, path);

    let (result_tx, result_rx) = mpsc::channel::<AppResult<MeetOauthCallbackResult>>(1);
    let abort = Arc::new(AtomicBool::new(false));

    {
        let mut pending = PENDING_CALLBACK.lock().map_err(|e| AppError::Internal(e.to_string()))?;
        if pending.is_some() {
            return Err(AppError::InvalidRequest("Another Google OAuth callback listener is already running.".to_string()));
        }
        *pending = Some(PendingCallback {
            result_rx: Some(result_rx),
            abort: abort.clone(),
        });
    }

    let path_for_handler = path.clone();
    let abort_for_task = abort.clone();
    tauri::async_runtime::spawn(async move {
        let listener = match TcpListener::bind((Ipv4Addr::LOCALHOST, port)).await {
            Ok(l) => l,
            Err(e) => {
                let _ = result_tx.send(Err(AppError::Internal(format!("绑定回调端口失败: {}", e)))).await;
                let _ = PENDING_CALLBACK.lock().map(|mut p| *p = None);
                return;
            }
        };

        loop {
            if abort_for_task.load(Ordering::Relaxed) {
                break;
            }

            let accept = tokio::time::timeout(Duration::from_millis(500), listener.accept()).await;
            let (stream, _) = match accept {
                Ok(Ok(pair)) => pair,
                Ok(Err(_)) => break,
                Err(_) => continue,
            };

            let tx = result_tx.clone();
            let path = path_for_handler.clone();
            let abort_inner = abort_for_task.clone();
            tauri::async_runtime::spawn(async move {
                let service = service_fn(move |req: Request<Incoming>| {
                    let tx = tx.clone();
                    let path = path.clone();
                    let abort = abort_inner.clone();
                    async move {
                        if req.method() != Method::GET {
                            return Ok::<_, Infallible>(Response::builder()
                                .status(StatusCode::METHOD_NOT_ALLOWED)
                                .body(Full::new(Bytes::from("Method Not Allowed")))
                                .unwrap());
                        }
                        let uri = req.uri().path().to_string();
                        if !uri.starts_with(&path) {
                            return Ok(Response::builder()
                                .status(StatusCode::NOT_FOUND)
                                .body(Full::new(Bytes::from("Not Found")))
                                .unwrap());
                        }

                        let query = req.uri().query().unwrap_or("");
                        let params: HashMap<String, String> = url::form_urlencoded::parse(query.as_bytes())
                            .map(|(k, v)| (k.to_string(), v.to_string()))
                            .collect();

                        match (params.get("code"), params.get("state")) {
                            (Some(code), Some(state)) => {
                                let result = MeetOauthCallbackResult {
                                    code: code.clone(),
                                    state: state.clone(),
                                };
                                let _ = tx.send(Ok(result)).await;
                                abort.store(true, Ordering::Relaxed);
                                Ok(Response::builder()
                                    .status(StatusCode::OK)
                                    .header(CONTENT_TYPE, "text/html; charset=utf-8")
                                    .body(Full::new(Bytes::from(include_str!("meet_oauth_callback.html"))))
                                    .unwrap())
                            }
                            _ => {
                                let error = params.get("error").cloned().unwrap_or_else(|| "invalid_request".to_string());
                                let _ = tx
                                    .send(Err(AppError::InvalidRequest(format!(
                                        "OAuth callback error: {}",
                                        error
                                    ))))
                                    .await;
                                abort.store(true, Ordering::Relaxed);
                                Ok(Response::builder()
                                    .status(StatusCode::BAD_REQUEST)
                                    .header(CONTENT_TYPE, "text/plain; charset=utf-8")
                                    .body(Full::new(Bytes::from(format!("OAuth error: {}", error))))
                                    .unwrap())
                            }
                        }
                    }
                });

                let io = TokioIo::new(stream);
                let _ = http1::Builder::new().serve_connection(io, service).await;
            });
        }
    });

    Ok(MeetOauthStartResult { port, redirect_uri })
}

#[tauri::command]
pub async fn meet_oauth_wait() -> AppResult<MeetOauthCallbackResult> {
    let mut rx = {
        let mut pending = PENDING_CALLBACK.lock().map_err(|e| AppError::Internal(e.to_string()))?;
        pending
            .as_mut()
            .and_then(|p| p.result_rx.take())
            .ok_or_else(|| AppError::InvalidRequest("No Google OAuth callback listener is running.".to_string()))?
    };

    let result = tokio::time::timeout(LISTEN_TIMEOUT, rx.recv())
        .await
        .map_err(|_| AppError::InvalidRequest("等待 Google OAuth 回调超时.".to_string()))?
        .ok_or_else(|| AppError::InvalidRequest("Google OAuth 回调通道已关闭.".to_string()))?;

    {
        let mut pending = PENDING_CALLBACK.lock().map_err(|e| AppError::Internal(e.to_string()))?;
        *pending = None;
    }

    result
}

#[tauri::command]
pub async fn meet_oauth_cancel() -> AppResult<bool> {
    let mut pending = PENDING_CALLBACK.lock().map_err(|e| AppError::Internal(e.to_string()))?;
    if let Some(p) = pending.take() {
        p.abort.store(true, Ordering::Relaxed);
    }
    Ok(true)
}

// Need hyper::header::CONTENT_TYPE for the response builder above.
use hyper::header::CONTENT_TYPE;

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    #[test]
    fn validate_meet_url_accepts_codes() {
        assert!(validate_meet_url("https://meet.google.com/abc-defg-hij").is_ok());
        assert!(validate_meet_url("https://meet.google.com/lookup/abc-defg-hij").is_ok());
        assert!(validate_meet_url("https://meet.google.com/new").is_ok());
        assert!(validate_meet_url("https://meet.google.com/abc-defg-hij?authuser=0").is_ok());
        assert!(validate_meet_url("https://meet.google.com/new").is_ok());
        assert!(validate_meet_url("https://meet.google.com/abc-defg-hij?authuser=0").is_ok());
    }

    #[test]
    fn validate_meet_url_rejects_bad_urls() {
        assert!(validate_meet_url("http://meet.google.com/abc-defg-hij").is_err());
        assert!(validate_meet_url("https://meet.google.com/").is_err());
        assert!(validate_meet_url("https://example.com/abc-defg-hij").is_err());
    }

    #[test]
    fn parse_transcript_reads_lines() {
        let raw = "[10:05:01] Alice: Hello everyone\n[10:05:03] Bob: Hi Alice\n";
        let lines = parse_transcript(raw);
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].ts, "10:05:01");
        assert_eq!(lines[0].speaker, "Alice");
        assert_eq!(lines[0].text, "Hello everyone");
    }

    #[test]
    fn parse_transcript_ignores_malformed_lines() {
        let raw = "[10:05:01] Alice: Hello\nnot a caption\n[10:05:02] Bob: Hi";
        let lines = parse_transcript(raw);
        assert_eq!(lines.len(), 2);
    }

    #[test]
    fn parse_empty_transcript_returns_empty() {
        assert!(parse_transcript("").is_empty());
    }
}
