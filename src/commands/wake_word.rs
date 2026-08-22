// Tauri IPC commands for wake-word / hotword detection.
//
// These replace the JSON-RPC `wake.*` methods previously sent over the gateway
// WebSocket. The renderer captures microphone audio and feeds 16 kHz mono i16
// PCM via `wake_feed`; the detector runs in-process in Rust and emits
// `wake.detected` through Tauri's event system.
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, State};

use crate::error::{AppError, AppResult};
use crate::state::AppState;
use crate::wake_word::{
    decode_feed_payload, WakeDetectedEvent, WakePauseInfo, WakeResumeInfo, WakeStartInfo,
    WakeStatusInfo, WakeStopInfo, WakeWordConfig,
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WakeStartInput {
    pub surface: String,
    #[serde(default)]
    pub client_capture: bool,
    #[serde(default)]
    pub persist: bool,
    #[serde(default)]
    pub config: Option<WakeWordConfig>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WakeStopInput {
    #[serde(default)]
    pub persist: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WakeFeedInput {
    pub pcm: String,
    #[serde(default = "default_sample_rate")]
    pub sample_rate: usize,
}

fn default_sample_rate() -> usize {
    crate::wake_word::TARGET_SAMPLE_RATE
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WakeFeedResult {
    pub fed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detected: Option<WakeDetectedEvent>,
}

#[tauri::command]
pub async fn wake_start(
    input: WakeStartInput,
    state: State<'_, AppState>,
) -> AppResult<WakeStartInfo> {
    let surface = input.surface.trim().to_string();
    if surface.is_empty() {
        return Err(AppError::InvalidRequest("surface is required".to_string()));
    }

    let lock_path = {
        let inner = state.inner.lock()?;
        let hermes_home = PathBuf::from(&inner.hermes_home);
        Some(hermes_home.join("runtime").join("wake-word.lock"))
    };

    let mut inner = state.inner.lock()?;
    inner.wake_word.start(
        surface,
        input.client_capture,
        input.config,
        lock_path,
    )
}

#[tauri::command]
pub async fn wake_stop(
    input: WakeStopInput,
    state: State<'_, AppState>,
) -> AppResult<WakeStopInfo> {
    let mut inner = state.inner.lock()?;
    Ok(inner.wake_word.stop(input.persist))
}

#[tauri::command]
pub async fn wake_pause(state: State<'_, AppState>) -> AppResult<WakePauseInfo> {
    let mut inner = state.inner.lock()?;
    Ok(inner.wake_word.pause())
}

#[tauri::command]
pub async fn wake_resume(state: State<'_, AppState>) -> AppResult<WakeResumeInfo> {
    let mut inner = state.inner.lock()?;
    Ok(inner.wake_word.resume())
}

#[tauri::command]
pub async fn wake_status(state: State<'_, AppState>) -> AppResult<WakeStatusInfo> {
    let inner = state.inner.lock()?;
    Ok(inner.wake_word.status())
}

#[tauri::command]
pub async fn wake_feed(
    input: WakeFeedInput,
    app: AppHandle,
    state: State<'_, AppState>,
) -> AppResult<WakeFeedResult> {
    if input.sample_rate != crate::wake_word::TARGET_SAMPLE_RATE {
        return Ok(WakeFeedResult {
            fed: false,
            reason: Some(format!(
                "unsupported sample rate {}; expected {}",
                input.sample_rate,
                crate::wake_word::TARGET_SAMPLE_RATE
            )),
            detected: None,
        });
    }

    let samples = decode_feed_payload(&input.pcm)?;
    let mut inner = state.inner.lock()?;
    let detected = inner.wake_word.feed(&samples)?;

    if let Some(ref event) = detected {
        app.emit("wake.detected", event)?;
    }

    Ok(WakeFeedResult {
        fed: true,
        reason: None,
        detected,
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WakeFrameInfoResult {
    pub sample_rate: usize,
    pub frame_length: usize,
}

#[tauri::command]
pub async fn wake_frame_info(state: State<'_, AppState>) -> AppResult<WakeFrameInfoResult> {
    let inner = state.inner.lock()?;
    Ok(WakeFrameInfoResult {
        sample_rate: inner.wake_word.detector_sample_rate(),
        frame_length: inner.wake_word.detector_frame_length(),
    })
}
