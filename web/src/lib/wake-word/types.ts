import type {
  WakeDetectedEvent,
  WakeFeedInput,
  WakeFeedResponse,
  WakeFrameInfoResponse,
  WakePauseResponse,
  WakeResumeResponse,
  WakeStartInput,
  WakeStartResponse,
  WakeStatusResponse,
  WakeStopResponse,
  WakeWordConfig,
} from "@hermes/protocol";

export type {
  WakeDetectedEvent,
  WakeFeedInput,
  WakeFeedResponse,
  WakeFrameInfoResponse,
  WakePauseResponse,
  WakeResumeResponse,
  WakeStartInput,
  WakeStartResponse,
  WakeStatusResponse,
  WakeStopResponse,
  WakeWordConfig,
};

export type WakeWordNotice =
  | { type: "armed" }
  | { type: "refused"; reason: string }
  | { type: "silent" }
  | { type: "error"; message: string };

export interface WakeWordState {
  available: boolean;
  enabled: boolean;
  listening: boolean;
  pending: boolean;
  phrase: string;
  notice: WakeWordNotice | null;
  lastError: string | null;
}
