import { z } from "zod";

export const WakeWordConfigSchema = z.object({
  enabled: z.boolean().default(false),
  surface: z.string().default("auto"),
  capture: z.string().default("auto"),
  provider: z.string().default("sherpa"),
  phrase: z.string().default("hey hermes"),
  sensitivity: z.number().min(0).max(1).default(0.6),
  confirmationFrames: z.number().int().min(1).default(3),
  startNewSession: z.boolean().default(true),
});

export type WakeWordConfig = z.infer<typeof WakeWordConfigSchema>;

export const WakeStatusResponseSchema = z.object({
  listening: z.boolean(),
  ownedByCaller: z.boolean(),
  ownerSurface: z.string().optional(),
  phrase: z.string(),
  provider: z.string(),
  configuredSurface: z.string(),
  inputDevice: z.string().optional(),
  available: z.boolean(),
  hint: z.string().optional(),
  enabled: z.boolean(),
  audioSilent: z.boolean(),
  capture: z.string(),
  localInputAvailable: z.boolean(),
  sampleRate: z.number(),
  frameLength: z.number(),
});

export type WakeStatusResponse = z.infer<typeof WakeStatusResponseSchema>;

export const WakeStartResponseSchema = z.object({
  started: z.boolean(),
  reason: z.string().optional(),
  hint: z.string().optional(),
  phrase: z.string(),
  provider: z.string(),
  ownerSurface: z.string().optional(),
  enabledPersisted: z.boolean().optional(),
  capture: z.string(),
  sampleRate: z.number(),
  frameLength: z.number(),
});

export type WakeStartResponse = z.infer<typeof WakeStartResponseSchema>;

export const WakeStopResponseSchema = z.object({
  stopped: z.boolean(),
  reason: z.string().optional(),
  disabledPersisted: z.boolean().optional(),
});

export type WakeStopResponse = z.infer<typeof WakeStopResponseSchema>;

export const WakePauseResponseSchema = z.object({
  paused: z.boolean(),
  reason: z.string().optional(),
});

export type WakePauseResponse = z.infer<typeof WakePauseResponseSchema>;

export const WakeResumeResponseSchema = z.object({
  resumed: z.boolean(),
  reason: z.string().optional(),
});

export type WakeResumeResponse = z.infer<typeof WakeResumeResponseSchema>;

export const WakeFeedResponseSchema = z.object({
  fed: z.boolean(),
  reason: z.string().optional(),
  detected: z
    .object({
      phrase: z.string(),
      profile: z.string().nullable(),
      startNewSession: z.boolean(),
    })
    .optional(),
});

export type WakeFeedResponse = z.infer<typeof WakeFeedResponseSchema>;

export const WakeFrameInfoResponseSchema = z.object({
  sampleRate: z.number(),
  frameLength: z.number(),
});

export type WakeFrameInfoResponse = z.infer<typeof WakeFrameInfoResponseSchema>;

export const WakeDetectedEventSchema = z.object({
  phrase: z.string(),
  profile: z.string().nullable(),
  startNewSession: z.boolean(),
});

export type WakeDetectedEvent = z.infer<typeof WakeDetectedEventSchema>;

export const WakeStartInputSchema = z.object({
  surface: z.string(),
  clientCapture: z.boolean().default(true),
  persist: z.boolean().default(false),
  config: WakeWordConfigSchema.optional(),
});

export type WakeStartInput = z.infer<typeof WakeStartInputSchema>;

export const WakeStopInputSchema = z.object({
  persist: z.boolean().default(false),
});

export type WakeStopInput = z.infer<typeof WakeStopInputSchema>;

export const WakeFeedInputSchema = z.object({
  pcm: z.string(),
  sampleRate: z.number().default(16000),
});

export type WakeFeedInput = z.infer<typeof WakeFeedInputSchema>;
