/**
 * Voice Mode — two-stage silence / VAD detector.
 *
 * Mirrors Python `AudioRecorder` RMS thresholds:
 * - speech confirmation after minSpeechMs
 * - silence stop after silenceDurationMs
 * - no-speech abort after maxWaitMs
 * - hard maxRecordingSeconds cap
 */

export interface VadFrame {
  rms: number;
  timestampMs: number;
}

export interface VadConfig {
  silenceThreshold: number;
  silenceDurationMs: number;
  minSpeechMs: number;
  maxDipToleranceMs: number;
  maxWaitMs: number;
  maxRecordingSeconds: number;
}

export interface VadState {
  speaking: boolean;
  speechStartedAtMs: number | null;
  lastSpeechAtMs: number | null;
  stopped: boolean;
  aborted: boolean;
  reason?: "silence" | "max_wait" | "max_recording";
}

export function createVadState(): VadState {
  return {
    speaking: false,
    speechStartedAtMs: null,
    lastSpeechAtMs: null,
    stopped: false,
    aborted: false,
  };
}

export function updateVad(state: VadState, frame: VadFrame, config: VadConfig): VadState {
  if (state.stopped || state.aborted) return state;

  const isSpeech = frame.rms >= config.silenceThreshold;
  const now = frame.timestampMs;
  const next: VadState = { ...state };

  // Track when we started listening so no-speech timeout can fire.
  if (next.speechStartedAtMs == null) {
    next.speechStartedAtMs = now;
  }

  if (isSpeech) {
    next.lastSpeechAtMs = now;
    if (!next.speaking) {
      const startCandidate = next.speechStartedAtMs ?? now;
      if (now - startCandidate >= config.minSpeechMs) {
        next.speaking = true;
      }
      next.speechStartedAtMs = startCandidate;
    }
  }

  if (!next.speaking && next.speechStartedAtMs != null && now - next.speechStartedAtMs > config.maxWaitMs) {
    next.aborted = true;
    next.reason = "max_wait";
    return next;
  }

  if (next.speaking && next.lastSpeechAtMs != null && now - next.lastSpeechAtMs >= config.silenceDurationMs) {
    next.stopped = true;
    next.reason = "silence";
    return next;
  }

  if (next.speechStartedAtMs != null && now - next.speechStartedAtMs >= config.maxRecordingSeconds * 1000) {
    next.stopped = true;
    next.reason = "max_recording";
  }

  return next;
}
