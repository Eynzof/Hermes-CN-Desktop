export type PetState = "idle" | "wave" | "run" | "failed" | "review" | "jump" | "waiting";

export interface PetInfo {
  enabled: boolean;
  slug?: string;
  displayName?: string;
  mime?: string;
  spritesheetBase64?: string;
  framesByState?: Record<string, number>;
  framesByRow?: Record<string, number>;
  scale?: number;
  loopMs?: number;
  stateRows?: string[];
  frameW?: number;
  frameH?: number;
  framesPerState?: number;
}

export interface PetActivity {
  busy?: boolean;
  awaitingInput?: boolean;
  error?: boolean;
  celebrate?: boolean;
  justCompleted?: boolean;
  toolRunning?: boolean;
  reasoning?: boolean;
}

export const FRAME_W = 192;
export const FRAME_H = 208;
export const FRAMES_PER_STATE = 6;
export const LOOP_MS = 1100;
export const DEFAULT_SCALE = 0.33;
export const MIN_SCALE = 0.1;
export const MAX_SCALE = 3.0;

export const STATE_ALIASES: Record<string, PetState> = { waving: "wave" };

export function clampScale(scale: number): number {
  return Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale));
}
