/**
 * Voice Mode — controller state machine (scaffold).
 *
 * Mirrors Python `hermes_cli/voice.py` push-to-talk + continuous loop.
 */

import type { VadConfig, VadState } from "./vad";
import { createVadState, updateVad } from "./vad";
import { isVoiceStopPhrase } from "./stop-phrase";
import { isWhisperHallucination } from "./hallucination";

export type VoiceStatus = "idle" | "recording" | "transcribing" | "listening" | "speaking";

export interface VoiceModeCallbacks {
  onTranscript(transcript: string): void;
  onStatus(status: VoiceStatus): void;
  onSilentLimit?(): void;
  onStopPhrase?(phrase: string): void;
}

export interface VoiceModeController {
  startContinuous(opts: VoiceModeCallbacks): void;
  stopContinuous(): void;
  startPushToTalk(): void;
  stopPushToTalkAndTranscribe(): Promise<string | null>;
  processAudioFrame(rms: number, timestampMs: number): void;
  get status(): VoiceStatus;
  get silentStrikes(): number;
}

export function createVoiceModeController(vadConfig: VadConfig): VoiceModeController {
  let status: VoiceStatus = "idle";
  let callbacks: VoiceModeCallbacks | null = null;
  let vad: VadState = createVadState();
  let silentStrikes = 0;

  const setStatus = (next: VoiceStatus) => {
    status = next;
    callbacks?.onStatus?.(next);
  };

  return {
    get status() {
      return status;
    },
    get silentStrikes() {
      return silentStrikes;
    },

    startContinuous(opts) {
      callbacks = opts;
      vad = createVadState();
      silentStrikes = 0;
      setStatus("listening");
    },

    stopContinuous() {
      callbacks = null;
      setStatus("idle");
    },

    startPushToTalk() {
      vad = createVadState();
      setStatus("recording");
    },

    async stopPushToTalkAndTranscribe() {
      setStatus("transcribing");
      // Real transcription wired here in a full implementation.
      setStatus("idle");
      return null;
    },

    processAudioFrame(rms, timestampMs) {
      vad = updateVad(vad, { rms, timestampMs }, vadConfig);

      if (vad.speaking && status === "listening") {
        setStatus("recording");
      }

      if (vad.aborted) {
        silentStrikes += 1;
        if (silentStrikes >= 3) {
          callbacks?.onStopPhrase?.("stop");
          setStatus("idle");
          return;
        }
        callbacks?.onSilentLimit?.();
        setStatus("listening");
        return;
      }

      if (vad.stopped) {
        setStatus("transcribing");
        // In a full implementation, feed captured PCM to STT here.
        const transcript = "stop";
        if (isWhisperHallucination(transcript)) {
          setStatus("listening");
          return;
        }
        if (isVoiceStopPhrase(transcript, ["stop"])) {
          callbacks?.onStopPhrase?.("stop");
          setStatus("idle");
          return;
        }
        callbacks?.onTranscript(transcript);
        setStatus("listening");
      }
    },
  };
}
