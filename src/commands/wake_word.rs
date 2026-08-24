// Tauri IPC commands for wake-word / hotword detection.
//
// These replace the JSON-RPC `wake.*` methods previously sent over the gateway
// WebSocket. The renderer captures microphone audio and feeds 16 kHz mono i16
// PCM via `wake_feed`; the detector runs in-process in Rust and emits
// `wake.detected` through Tauri's event system.
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, State};

use crate::error::{AppError, AppResult};
use crate::schema::wake::{
    WakeDetectedEvent as SchemaWakeDetectedEvent, WakeFeedInput, WakeFeedResult,
    WakeFrameInfoResult, WakeStartInput, WakeStopInput, WakeWordConfig as SchemaWakeWordConfig,
};
use crate::state::AppState;
use crate::wake_word::{
    decode_feed_payload, WakePauseInfo, WakeResumeInfo, WakeStartInfo, WakeStatusInfo,
    WakeStopInfo, WakeWordConfig,
};

fn to_internal_config(cfg: SchemaWakeWordConfig) -> WakeWordConfig {
    WakeWordConfig {
        enabled: cfg.enabled,
        surface: cfg.surface,
        capture: cfg.capture,
        provider: cfg.provider,
        phrase: cfg.phrase,
        sensitivity: cfg.sensitivity as f32,
        confirmation_frames: cfg.confirmation_frames,
        start_new_session: cfg.start_new_session,
    }
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
    let config = input.config.map(to_internal_config);
    inner
        .wake_word
        .start(surface, input.client_capture, config, lock_path)
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
    let detected = inner
        .wake_word
        .feed(&samples)?
        .map(|e| SchemaWakeDetectedEvent {
            phrase: e.phrase,
            profile: e.profile,
            start_new_session: e.start_new_session,
        });

    if let Some(ref event) = detected {
        app.emit("wake.detected", event)?;
    }

    Ok(WakeFeedResult {
        fed: true,
        reason: None,
        detected,
    })
}

#[tauri::command]
pub async fn wake_frame_info(state: State<'_, AppState>) -> AppResult<WakeFrameInfoResult> {
    let inner = state.inner.lock()?;
    Ok(WakeFrameInfoResult {
        sample_rate: inner.wake_word.detector_sample_rate(),
        frame_length: inner.wake_word.detector_frame_length(),
    })
}
