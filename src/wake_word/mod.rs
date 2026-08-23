// Wake-word / hotword detection for the standalone Tauri desktop.
//
// Mirrors the Python `tools/wake_word.py` design in Rust:
//   - Engine trait abstracts ONNX/openWakeWord, sherpa KWS, Porcupine, etc.
//   - WakeWordDetector owns the engine, an external-audio queue, silence
//     detection, a fire cooldown, and confirmation-streak logic.
//   - Tauri commands (`src/commands/wake_word.rs`) expose the detector over IPC.
//
// The default in-process engine is a lightweight template matcher that works
// without model downloads. A production build can slot a `sherpa-onnx` engine
// behind the same `WakeWordEngine` trait.

use std::collections::VecDeque;
use std::fs::{File, OpenOptions};
use std::io::{Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

pub const TARGET_SAMPLE_RATE: usize = 16000;
pub const DEFAULT_FRAME_LENGTH: usize = 1280; // 80 ms @ 16 kHz
const SILENCE_ALERT_SECONDS: u64 = 10;
const SILENCE_ALERT_FRAMES: usize =
    (SILENCE_ALERT_SECONDS as usize * TARGET_SAMPLE_RATE) / DEFAULT_FRAME_LENGTH;
const COOLDOWN_SECONDS: u64 = 2;
const MAX_QUEUE_FRAMES: usize = 16;
const MAX_FEED_BYTES: usize = 64 * 1024;

/// Per-profile wake-word configuration.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct WakeWordConfig {
    pub enabled: bool,
    pub surface: String,
    pub capture: String,
    pub provider: String,
    pub phrase: String,
    pub sensitivity: f32,
    pub confirmation_frames: usize,
    pub start_new_session: bool,
}

impl Default for WakeWordConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            surface: "auto".to_string(),
            capture: "auto".to_string(),
            provider: "sherpa".to_string(), // desktop in-process default (plan §9)
            phrase: "hey hermes".to_string(),
            sensitivity: 0.6,
            confirmation_frames: 3,
            start_new_session: true,
        }
    }
}

impl WakeWordConfig {
    pub fn clamp(&mut self) {
        self.sensitivity = self.sensitivity.clamp(0.0, 1.0);
        self.confirmation_frames = self.confirmation_frames.max(1);
    }
}

/// A single detection event emitted to the renderer.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WakeDetectedEvent {
    pub phrase: String,
    pub profile: Option<String>,
    pub start_new_session: bool,
}

/// Engine abstraction. Any concrete engine must consume 16 kHz mono i16 PCM
/// frames and return `true` when its wake phrase is detected.
pub trait WakeWordEngine: Send {
    /// Number of samples the engine prefers per process call.
    fn frame_length(&self) -> usize;

    /// Process one frame. Return `true` if the wake phrase fired this frame.
    fn process(&mut self, frame: &[i16]) -> bool;

    /// Reset internal state (e.g., after a fire or a pause).
    fn reset(&mut self);

    /// Release native resources.
    fn close(&mut self);

    /// Last matched phrase / profile, if the engine supports phrase routing.
    fn last_match(&self) -> Option<(String, String)>;
}

/// Default lightweight engine: cross-correlates a synthetic "hey hermes"
/// template against incoming audio energy envelopes. This is intentionally
/// simple so the feature works out-of-the-box without model downloads.
pub struct TemplateEngine {
    phrase: String,
    sensitivity: f32,
    frame_length: usize,
    template: Vec<f32>,
    ring: VecDeque<f32>,
    last_match: Option<(String, String)>,
}

impl TemplateEngine {
    pub fn new(phrase: impl Into<String>, sensitivity: f32, frame_length: usize) -> Self {
        let phrase = phrase.into();
        let template = Self::build_template(&phrase, frame_length);
        Self {
            phrase,
            sensitivity: sensitivity.clamp(0.0, 1.0),
            frame_length,
            template,
            ring: VecDeque::with_capacity(frame_length * 4),
            last_match: None,
        }
    }

    /// Build a synthetic amplitude envelope that loosely follows the syllables
    /// of the phrase. Used as the correlation target.
    fn build_template(phrase: &str, frame_length: usize) -> Vec<f32> {
        let word_count = phrase.split_whitespace().count().max(1);
        let samples = (frame_length * 8).max(320);
        let syllable_width = samples / (word_count * 2).max(1);
        let mut template = vec![0.0f32; samples];
        for i in 0..(word_count * 2) {
            let center = i * syllable_width + syllable_width / 2;
            let half = syllable_width / 4;
            for j in center.saturating_sub(half)..(center + half).min(samples) {
                let dist = ((j as isize) - (center as isize)).unsigned_abs();
                template[j] = (1.0 - (dist as f32) / (half as f32).max(1.0)).max(0.0);
            }
        }
        // Normalize
        let sum: f32 = template.iter().map(|v| v * v).sum();
        if sum > 0.0 {
            let norm = sum.sqrt();
            template.iter_mut().for_each(|v| *v /= norm);
        }
        template
    }

    fn energy_envelope(frame: &[i16]) -> f32 {
        let sum: f64 = frame.iter().map(|&s| (s as f64) * (s as f64)).sum();
        ((sum / frame.len().max(1) as f64).sqrt() / 32768.0) as f32
    }
}

impl WakeWordEngine for TemplateEngine {
    fn frame_length(&self) -> usize {
        self.frame_length
    }

    fn process(&mut self, frame: &[i16]) -> bool {
        let energy = Self::energy_envelope(frame);
        self.ring.push_back(energy);
        if self.ring.len() > self.template.len() {
            self.ring.pop_front();
        }
        if self.ring.len() < self.template.len() {
            return false;
        }

        let window: Vec<f32> = self.ring.iter().copied().collect();
        let power: f32 = window.iter().map(|v| v * v).sum();
        if power < 1e-6 {
            self.last_match = None;
            return false;
        }

        let window_norm = power.sqrt();
        let score: f32 = window
            .iter()
            .zip(self.template.iter())
            .map(|(a, b)| a * b)
            .sum::<f32>()
            / window_norm;

        // Sensitivity maps to a threshold: higher = easier to fire.
        let threshold = 0.6 - self.sensitivity * 0.35;
        if score >= threshold {
            self.last_match = Some((self.phrase.clone(), "default".to_string()));
            true
        } else {
            self.last_match = None;
            false
        }
    }

    fn reset(&mut self) {
        self.ring.clear();
        self.last_match = None;
    }

    fn close(&mut self) {
        self.ring.clear();
    }

    fn last_match(&self) -> Option<(String, String)> {
        self.last_match.clone()
    }
}

/// Deterministic stub engine for unit tests: fires when the average absolute
/// sample exceeds a configurable threshold.
pub struct StubEngine {
    frame_length: usize,
    threshold: i16,
    consecutive: usize,
    required: usize,
    last_match: Option<(String, String)>,
}

impl StubEngine {
    pub fn new(frame_length: usize, threshold: i16, required: usize) -> Self {
        Self {
            frame_length,
            threshold,
            consecutive: 0,
            required,
            last_match: None,
        }
    }
}

impl WakeWordEngine for StubEngine {
    fn frame_length(&self) -> usize {
        self.frame_length
    }

    fn process(&mut self, frame: &[i16]) -> bool {
        let peak = frame.iter().map(|&s| s.abs()).max().unwrap_or(0);
        if peak >= self.threshold {
            self.consecutive += 1;
        } else {
            self.consecutive = 0;
        }
        if self.consecutive >= self.required {
            self.last_match = Some(("stub phrase".to_string(), "default".to_string()));
            true
        } else {
            self.last_match = None;
            false
        }
    }

    fn reset(&mut self) {
        self.consecutive = 0;
        self.last_match = None;
    }

    fn close(&mut self) {
        self.reset();
    }

    fn last_match(&self) -> Option<(String, String)> {
        self.last_match.clone()
    }
}

/// Shared detector state. Held inside an `Arc<Mutex<...>>` by `WakeWordService`.
pub struct WakeWordDetector {
    config: WakeWordConfig,
    engine: Box<dyn WakeWordEngine>,
    queue: VecDeque<i16>,
    paused: bool,
    silence_since: Option<Instant>,
    last_fire: Option<Instant>,
    confirmation_streak: usize,
    silent_frame_count: usize,
    audio_silent: bool,
    phrase: String,
    provider: String,
}

impl WakeWordDetector {
    pub fn new(config: WakeWordConfig, engine: Box<dyn WakeWordEngine>) -> Self {
        let phrase = config.phrase.clone();
        let provider = config.provider.clone();
        Self {
            config,
            engine,
            queue: VecDeque::with_capacity(MAX_QUEUE_FRAMES * DEFAULT_FRAME_LENGTH),
            paused: false,
            silence_since: None,
            last_fire: None,
            confirmation_streak: 0,
            silent_frame_count: 0,
            audio_silent: false,
            phrase,
            provider,
        }
    }

    pub fn from_config(mut config: WakeWordConfig) -> Self {
        config.clamp();
        let phrase = config.phrase.clone();
        let frame_length = DEFAULT_FRAME_LENGTH;
        let engine: Box<dyn WakeWordEngine> = match config.provider.as_str() {
            "stub" => Box::new(StubEngine::new(frame_length, 1000, 1)),
            _ => Box::new(TemplateEngine::new(phrase.clone(), config.sensitivity, frame_length)),
        };
        Self::new(config, engine)
    }

    /// Feed raw 16 kHz mono i16 PCM. Returns the detection event if the engine
    /// fired, respecting cooldown and pause state.
    pub fn feed(&mut self, samples: &[i16]) -> Option<WakeDetectedEvent> {
        if self.paused {
            return None;
        }
        self.push_samples(samples);
        self.drain_queue()
    }

    fn push_samples(&mut self, samples: &[i16]) {
        // Bounded queue: drop oldest to keep latency under control.
        for &sample in samples {
            if self.queue.len() >= self.queue.capacity() {
                self.queue.pop_front();
            }
            self.queue.push_back(sample);
        }
    }

    fn drain_queue(&mut self) -> Option<WakeDetectedEvent> {
        let frame_length = self.engine.frame_length();
        while self.queue.len() >= frame_length {
            let frame: Vec<i16> = self.queue.drain(0..frame_length).collect();
            if let Some(event) = self.process_frame(&frame) {
                return Some(event);
            }
        }
        None
    }

    fn process_frame(&mut self, frame: &[i16]) -> Option<WakeDetectedEvent> {
        // Silence detection: peak <= 10 for the configured number of frames.
        let peak = frame.iter().map(|&s| s.abs()).max().unwrap_or(0);
        if peak <= 10 {
            self.silent_frame_count += 1;
        } else {
            self.silent_frame_count = 0;
        }
        self.audio_silent = self.silent_frame_count >= SILENCE_ALERT_FRAMES;

        // Cooldown.
        if let Some(last) = self.last_fire {
            if last.elapsed() < Duration::from_secs(COOLDOWN_SECONDS) {
                return None;
            }
        }

        let fired = self.engine.process(frame);
        if fired {
            if self.confirmation_streak + 1 >= self.config.confirmation_frames {
                let (phrase, profile) = self
                    .engine
                    .last_match()
                    .unwrap_or_else(|| (self.phrase.clone(), "default".to_string()));
                self.last_fire = Some(Instant::now());
                self.confirmation_streak = 0;
                self.engine.reset();
                return Some(WakeDetectedEvent {
                    phrase,
                    profile: if profile == "default" {
                        None
                    } else {
                        Some(profile)
                    },
                    start_new_session: self.config.start_new_session,
                });
            }
            self.confirmation_streak += 1;
        } else {
            // Only reset streak on a clear non-match; engines may report false
            // positives for a single frame.
            self.confirmation_streak = 0;
        }
        None
    }

    pub fn pause(&mut self) {
        self.paused = true;
    }

    pub fn resume(&mut self) {
        self.paused = false;
        self.silent_frame_count = 0;
        self.silence_since = None;
        self.audio_silent = false;
    }

    pub fn is_paused(&self) -> bool {
        self.paused
    }

    pub fn is_silent(&self) -> bool {
        self.audio_silent
    }

    pub fn frame_length(&self) -> usize {
        self.engine.frame_length()
    }

    pub fn phrase(&self) -> &str {
        &self.phrase
    }

    pub fn provider(&self) -> &str {
        &self.provider
    }

    pub fn sample_rate(&self) -> usize {
        TARGET_SAMPLE_RATE
    }

    pub fn reset(&mut self) {
        self.queue.clear();
        self.engine.reset();
        self.confirmation_streak = 0;
        self.silent_frame_count = 0;
        self.silence_since = None;
        self.audio_silent = false;
    }
}

impl Drop for WakeWordDetector {
    fn drop(&mut self) {
        self.engine.close();
    }
}

/// Process-scoped service that owns the detector and the machine-wide mic lock.
pub struct WakeWordService {
    detector: Option<WakeWordDetector>,
    config: WakeWordConfig,
    lock: Option<MachineLock>,
    owner_surface: Option<String>,
    lock_path: Option<PathBuf>,
}

impl WakeWordService {
    pub fn new() -> Self {
        Self {
            detector: None,
            config: WakeWordConfig::default(),
            lock: None,
            owner_surface: None,
            lock_path: None,
        }
    }

    /// Start listening. `surface` identifies the caller (e.g. "gui").
    /// `client_capture: true` means the renderer will stream audio via `feed`;
    /// the Rust side does not open the local mic.
    pub fn start(
        &mut self,
        surface: String,
        client_capture: bool,
        config: Option<WakeWordConfig>,
        lock_path: Option<PathBuf>,
    ) -> AppResult<WakeStartInfo> {
        if self.detector.is_some() {
            return Err(AppError::WakeWordInUse(
                self.owner_surface.clone().unwrap_or_default(),
            ));
        }

        let mut cfg = config.unwrap_or_else(WakeWordConfig::default);
        cfg.clamp();

        let lock = if client_capture {
            // Renderer-capture path still acquires the machine lock so it cannot
            // race with a concurrently-running CLI/TUI instance.
            Some(MachineLock::acquire(lock_path.as_deref())?)
        } else {
            None
        };

        let detector = WakeWordDetector::from_config(cfg.clone());
        let info = WakeStartInfo {
            started: true,
            phrase: detector.phrase().to_string(),
            provider: detector.provider().to_string(),
            capture: if client_capture { "client".to_string() } else { "local".to_string() },
            sample_rate: detector.sample_rate(),
            frame_length: detector.frame_length(),
        };

        self.detector = Some(detector);
        self.config = cfg;
        self.lock = lock;
        self.owner_surface = Some(surface);
        self.lock_path = lock_path;
        Ok(info)
    }

    pub fn stop(&mut self, _persist: bool) -> WakeStopInfo {
        if self.detector.is_none() {
            return WakeStopInfo {
                stopped: true,
                reason: Some("was not listening".to_string()),
            };
        }
        self.detector = None;
        self.lock = None;
        self.owner_surface = None;
        WakeStopInfo {
            stopped: true,
            reason: None,
        }
    }

    pub fn pause(&mut self) -> WakePauseInfo {
        match self.detector.as_mut() {
            Some(d) if !d.is_paused() => {
                d.pause();
                WakePauseInfo {
                    paused: true,
                    reason: None,
                }
            }
            _ => WakePauseInfo {
                paused: false,
                reason: Some("not listening".to_string()),
            },
        }
    }

    pub fn resume(&mut self) -> WakeResumeInfo {
        match self.detector.as_mut() {
            Some(d) if d.is_paused() => {
                d.resume();
                WakeResumeInfo {
                    resumed: true,
                    reason: None,
                }
            }
            _ => WakeResumeInfo {
                resumed: false,
                reason: Some("not listening".to_string()),
            },
        }
    }

    pub fn status(&self) -> WakeStatusInfo {
        WakeStatusInfo {
            listening: self.detector.is_some(),
            owned_by_caller: true,
            owner_surface: self.owner_surface.clone(),
            phrase: self.config.phrase.clone(),
            provider: self.config.provider.clone(),
            configured_surface: self.config.surface.clone(),
            input_device: None,
            available: true,
            hint: None,
            enabled: self.config.enabled,
            audio_silent: self.detector.as_ref().map(|d| d.is_silent()).unwrap_or(false),
            capture: "client".to_string(),
            local_input_available: false,
            sample_rate: TARGET_SAMPLE_RATE,
            frame_length: self.detector.as_ref().map(|d| d.frame_length()).unwrap_or(DEFAULT_FRAME_LENGTH),
        }
    }

    pub fn feed(&mut self, pcm: &[i16]) -> AppResult<Option<WakeDetectedEvent>> {
        match self.detector.as_mut() {
            Some(d) => Ok(d.feed(pcm)),
            None => Err(AppError::WakeWordNotInitialized),
        }
    }

    pub fn detector_frame_length(&self) -> usize {
        self.detector
            .as_ref()
            .map(|d| d.frame_length())
            .unwrap_or(DEFAULT_FRAME_LENGTH)
    }

    pub fn detector_sample_rate(&self) -> usize {
        TARGET_SAMPLE_RATE
    }
}

impl Default for WakeWordService {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WakeStartInfo {
    pub started: bool,
    pub phrase: String,
    pub provider: String,
    pub capture: String,
    pub sample_rate: usize,
    pub frame_length: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WakeStopInfo {
    pub stopped: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WakePauseInfo {
    pub paused: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WakeResumeInfo {
    pub resumed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WakeStatusInfo {
    pub listening: bool,
    pub owned_by_caller: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner_surface: Option<String>,
    pub phrase: String,
    pub provider: String,
    pub configured_surface: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_device: Option<String>,
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
    pub enabled: bool,
    pub audio_silent: bool,
    pub capture: String,
    pub local_input_available: bool,
    pub sample_rate: usize,
    pub frame_length: usize,
}

/// Cross-platform advisory lock used to prevent concurrent mic access between
/// the desktop and a CLI/TUI Python instance. The lock file lives at
/// `$HERMES_HOME/runtime/wake-word.lock`.
pub struct MachineLock {
    file: File,
}

impl MachineLock {
    pub fn acquire(path: Option<&Path>) -> AppResult<Self> {
        let path = path.map(PathBuf::from).unwrap_or_else(|| {
            crate::process::runtime::runtime_root().join("runtime").join("wake-word.lock")
        });
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&path)?;
        fs2::FileExt::lock_exclusive(&file)?;
        // Write our PID so a human can see who holds the lock.
        let pid = std::process::id();
        let mut f = file.try_clone()?;
        f.set_len(0)?;
        f.seek(SeekFrom::Start(0))?;
        write!(f, "{pid}\n")?;
        f.flush()?;
        Ok(Self { file })
    }
}

impl Drop for MachineLock {
    fn drop(&mut self) {
        let _ = fs2::FileExt::unlock(&self.file);
    }
}

/// Decode base64 int16 LE PCM, enforcing the 64 KB cap.
pub fn decode_feed_payload(b64: &str) -> AppResult<Vec<i16>> {
    if b64.len() > MAX_FEED_BYTES * 4 / 3 + 4 {
        return Err(AppError::WakeWordFeedFailed(
            "feed payload exceeds maximum size".to_string(),
        ));
    }
    let bytes = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, b64)
        .map_err(|e| AppError::WakeWordFeedFailed(format!("invalid base64: {e}")))?;
    if bytes.len() % 2 != 0 {
        return Err(AppError::WakeWordFeedFailed(
            "odd number of bytes for i16 PCM".to_string(),
        ));
    }
    let samples: Vec<i16> = bytes
        .chunks_exact(2)
        .map(|chunk| i16::from_le_bytes([chunk[0], chunk[1]]))
        .collect();
    Ok(samples)
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    fn loud_frame() -> Vec<i16> {
        // A frame full of a loud square-ish wave.
        (0..DEFAULT_FRAME_LENGTH)
            .map(|i| if i % 2 == 0 { 30000 } else { -30000 })
            .collect()
    }

    fn quiet_frame() -> Vec<i16> {
        vec![0i16; DEFAULT_FRAME_LENGTH]
    }

    #[test]
    fn config_defaults_and_clamp() {
        let mut cfg = WakeWordConfig::default();
        assert!(!cfg.enabled);
        assert_eq!(cfg.phrase, "hey hermes");
        assert_eq!(cfg.provider, "sherpa");

        cfg.sensitivity = 2.0;
        cfg.confirmation_frames = 0;
        cfg.clamp();
        assert_eq!(cfg.sensitivity, 1.0);
        assert_eq!(cfg.confirmation_frames, 1);
    }

    #[test]
    fn stub_engine_fires_when_threshold_met() {
        let mut engine = StubEngine::new(DEFAULT_FRAME_LENGTH, 1000, 2);
        assert!(!engine.process(&quiet_frame()));
        assert!(!engine.process(&loud_frame()));
        assert!(engine.process(&loud_frame()));
        assert_eq!(
            engine.last_match(),
            Some(("stub phrase".to_string(), "default".to_string()))
        );
    }

    #[test]
    fn detector_queue_split_and_pad() {
        let cfg = WakeWordConfig {
            provider: "stub".to_string(),
            confirmation_frames: 1,
            ..WakeWordConfig::default()
        };
        let mut detector = WakeWordDetector::from_config(cfg);
        // Feed one and a half frames worth of loud samples; the queue should
        // split/pad internally.
        let mut samples = loud_frame();
        samples.extend_from_slice(&loud_frame()[..loud_frame().len() / 2]);
        let event = detector.feed(&samples);
        assert!(event.is_some(), "stub engine should fire after enough loud samples");
        assert_eq!(event.unwrap().phrase, "stub phrase");
    }

    #[test]
    fn detector_cooldown_prevents_double_fire() {
        let cfg = WakeWordConfig {
            provider: "stub".to_string(),
            confirmation_frames: 1,
            ..WakeWordConfig::default()
        };
        let mut detector = WakeWordDetector::from_config(cfg);
        assert!(detector.feed(&loud_frame()).is_some());
        // Immediately feed again; cooldown should swallow it.
        assert!(detector.feed(&loud_frame()).is_none());
    }

    #[test]
    fn detector_silence_flag_raised_after_quiet_stream() {
        let cfg = WakeWordConfig::default();
        let mut detector = WakeWordDetector::from_config(cfg);
        // Fill with quiet frames; each frame is 80 ms, 125 frames ~= 10 s.
        for _ in 0..130 {
            detector.feed(&quiet_frame());
        }
        assert!(detector.is_silent());
    }

    #[test]
    fn detector_pause_blocks_feed() {
        let cfg = WakeWordConfig {
            provider: "stub".to_string(),
            confirmation_frames: 1,
            ..WakeWordConfig::default()
        };
        let mut detector = WakeWordDetector::from_config(cfg);
        detector.pause();
        assert!(detector.feed(&loud_frame()).is_none());
        detector.resume();
        assert!(detector.feed(&loud_frame()).is_some());
    }

    #[test]
    fn base64_decode_roundtrip() {
        let samples: Vec<i16> = vec![0, 1000, -1000, 16000, -16000];
        let mut bytes = Vec::new();
        for s in &samples {
            bytes.extend_from_slice(&s.to_le_bytes());
        }
        let b64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &bytes);
        let decoded = decode_feed_payload(&b64).unwrap();
        assert_eq!(decoded, samples);
    }

    #[test]
    fn base64_decode_rejects_oversized_payload() {
        let big = "A".repeat(MAX_FEED_BYTES * 2);
        assert!(decode_feed_payload(&big).is_err());
    }

    #[test]
    #[serial_test::serial]
    fn machine_lock_creates_lock_file() {
        let tmp = tempfile::TempDir::new().unwrap();
        let path = tmp.path().join("wake-word.lock");
        let _lock = MachineLock::acquire(Some(&path)).unwrap();
        // The lock file is created and held exclusively by this process.
        assert!(path.exists());
    }

    #[test]
    fn service_start_stop_status() {
        let tmp = tempfile::TempDir::new().unwrap();
        let path = tmp.path().join("wake-word.lock");
        let mut service = WakeWordService::new();
        assert!(!service.status().listening);

        let info = service
            .start(
                "gui".to_string(),
                true,
                Some(WakeWordConfig::default()),
                Some(path),
            )
            .unwrap();
        assert!(info.started);
        assert_eq!(info.sample_rate, TARGET_SAMPLE_RATE);
        assert_eq!(info.frame_length, DEFAULT_FRAME_LENGTH);

        let status = service.status();
        assert!(status.listening);
        assert_eq!(status.owner_surface.as_deref(), Some("gui"));

        let stop = service.stop(false);
        assert!(stop.stopped);
        assert!(!service.status().listening);
    }

    #[test]
    fn service_feed_emits_detection() {
        let tmp = tempfile::TempDir::new().unwrap();
        let path = tmp.path().join("wake-word.lock");
        let mut service = WakeWordService::new();
        let mut cfg = WakeWordConfig::default();
        cfg.provider = "stub".to_string();
        cfg.confirmation_frames = 1;
        service.start("gui".to_string(), true, Some(cfg), Some(path)).unwrap();

        let mut bytes = Vec::new();
        for s in &loud_frame() {
            bytes.extend_from_slice(&s.to_le_bytes());
        }
        let b64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &bytes);
        let decoded = decode_feed_payload(&b64).unwrap();
        let event = service.feed(&decoded).unwrap();
        assert!(event.is_some());
        assert_eq!(event.unwrap().start_new_session, true);
    }

    #[test]
    fn service_pause_resume() {
        let mut service = WakeWordService::new();
        assert!(!service.pause().paused);
        service
            .start("gui".to_string(), true, None, None)
            .unwrap();
        assert!(service.pause().paused);
        assert!(!service.pause().paused);
        assert!(service.resume().resumed);
        assert!(!service.resume().resumed);
    }
}
