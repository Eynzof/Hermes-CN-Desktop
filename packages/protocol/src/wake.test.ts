import { describe, expect, it } from "vitest";
import {
  WakeDetectedEventSchema,
  WakeFeedInputSchema,
  WakeFeedResponseSchema,
  WakeFrameInfoResponseSchema,
  WakePauseResponseSchema,
  WakeResumeResponseSchema,
  WakeStartInputSchema,
  WakeStartResponseSchema,
  WakeStatusResponseSchema,
  WakeStopInputSchema,
  WakeStopResponseSchema,
  WakeWordConfigSchema,
} from "./wake";

describe("WakeWordConfigSchema", () => {
  it("applies the full default config", () => {
    const parsed = WakeWordConfigSchema.parse({});
    expect(parsed).toEqual({
      enabled: false,
      surface: "auto",
      capture: "auto",
      provider: "sherpa",
      phrase: "hey hermes",
      sensitivity: 0.6,
      confirmationFrames: 3,
      startNewSession: true,
    });
  });

  it("parses an explicit config", () => {
    const parsed = WakeWordConfigSchema.parse({
      enabled: true,
      surface: "desktop",
      capture: "local",
      provider: "porcupine",
      phrase: "hey agent",
      sensitivity: 0.2,
      confirmationFrames: 5,
      startNewSession: false,
    });
    expect(parsed.provider).toBe("porcupine");
    expect(parsed.sensitivity).toBe(0.2);
    expect(parsed.confirmationFrames).toBe(5);
  });

  it("rejects out-of-range sensitivity, non-integer frames and non-boolean toggles", () => {
    expect(WakeWordConfigSchema.safeParse({ sensitivity: 1.1 }).success).toBe(false);
    expect(WakeWordConfigSchema.safeParse({ sensitivity: -0.1 }).success).toBe(false);
    expect(WakeWordConfigSchema.safeParse({ confirmationFrames: 0 }).success).toBe(false);
    expect(WakeWordConfigSchema.safeParse({ confirmationFrames: 1.5 }).success).toBe(false);
    expect(WakeWordConfigSchema.safeParse({ enabled: "yes" }).success).toBe(false);
  });
});

describe("Wake status/start/stop/pause/resume responses", () => {
  it("parses a full status response", () => {
    const parsed = WakeStatusResponseSchema.parse({
      listening: true,
      ownedByCaller: true,
      ownerSurface: "desktop",
      phrase: "hey hermes",
      provider: "sherpa",
      configuredSurface: "auto",
      inputDevice: "default",
      available: true,
      hint: "say the phrase",
      enabled: true,
      audioSilent: false,
      capture: "local",
      localInputAvailable: true,
      sampleRate: 16000,
      frameLength: 640,
    });
    expect(parsed.listening).toBe(true);
    expect(parsed.sampleRate).toBe(16000);
    expect(parsed.frameLength).toBe(640);
  });

  it("parses a minimal status response", () => {
    const parsed = WakeStatusResponseSchema.parse({
      listening: false,
      ownedByCaller: false,
      phrase: "hey hermes",
      provider: "sherpa",
      configuredSurface: "auto",
      available: false,
      enabled: false,
      audioSilent: true,
      capture: "auto",
      localInputAvailable: false,
      sampleRate: 0,
      frameLength: 0,
    });
    expect(parsed.ownerSurface).toBeUndefined();
    expect(parsed.hint).toBeUndefined();
  });

  it("rejects a status missing required fields", () => {
    expect(WakeStatusResponseSchema.safeParse({ listening: false }).success).toBe(false);
  });

  it("parses start/stop/pause/resume responses with optional reason fields", () => {
    expect(WakeStartResponseSchema.parse({ started: true, phrase: "p", provider: "sherpa", capture: "auto", sampleRate: 16000, frameLength: 640 }).reason).toBeUndefined();
    const start = WakeStartResponseSchema.parse({
      started: false,
      reason: "mic busy",
      hint: "free the mic",
      phrase: "p",
      provider: "sherpa",
      ownerSurface: "desktop",
      enabledPersisted: true,
      capture: "local",
      sampleRate: 16000,
      frameLength: 640,
    });
    expect(start.reason).toBe("mic busy");
    expect(start.enabledPersisted).toBe(true);

    expect(WakeStopResponseSchema.parse({ stopped: true }).reason).toBeUndefined();
    expect(WakeStopResponseSchema.parse({ stopped: false, reason: "x", disabledPersisted: false }).disabledPersisted).toBe(false);
    expect(WakePauseResponseSchema.parse({ paused: true }).paused).toBe(true);
    expect(WakePauseResponseSchema.parse({ paused: false, reason: "r" }).reason).toBe("r");
    expect(WakeResumeResponseSchema.parse({ resumed: true }).resumed).toBe(true);
    expect(WakeResumeResponseSchema.parse({ resumed: false, reason: "r" }).reason).toBe("r");
  });

  it("rejects start responses missing required fields", () => {
    expect(WakeStartResponseSchema.safeParse({ started: true }).success).toBe(false);
    expect(WakeStopResponseSchema.safeParse({}).success).toBe(false);
  });
});

describe("Wake feed/frame/detected schemas", () => {
  it("parses a feed response with an optional detection", () => {
    const parsed = WakeFeedResponseSchema.parse({
      fed: true,
      detected: { phrase: "hey hermes", profile: "default", startNewSession: true },
    });
    expect(parsed.detected?.profile).toBe("default");
    expect(WakeFeedResponseSchema.parse({ fed: false, reason: "not owner" }).detected).toBeUndefined();
    expect(WakeFeedResponseSchema.safeParse({}).success).toBe(false);
  });

  it("parses frame info", () => {
    expect(WakeFrameInfoResponseSchema.parse({ sampleRate: 16000, frameLength: 640 })).toEqual({
      sampleRate: 16000,
      frameLength: 640,
    });
    expect(WakeFrameInfoResponseSchema.safeParse({ sampleRate: 16000 }).success).toBe(false);
  });

  it("parses detected events with nullable profile", () => {
    expect(WakeDetectedEventSchema.parse({ phrase: "p", profile: null, startNewSession: false }).profile).toBeNull();
    expect(WakeDetectedEventSchema.parse({ phrase: "p", profile: "default", startNewSession: true }).profile).toBe("default");
    expect(WakeDetectedEventSchema.safeParse({ phrase: "p", startNewSession: true }).success).toBe(false);
  });
});

describe("Wake input schemas", () => {
  it("defaults start input fields", () => {
    const parsed = WakeStartInputSchema.parse({ surface: "desktop" });
    expect(parsed.clientCapture).toBe(true);
    expect(parsed.persist).toBe(false);
    expect(parsed.config).toBeUndefined();
    expect(WakeStartInputSchema.safeParse({}).success).toBe(false);
  });

  it("accepts an embedded config", () => {
    const parsed = WakeStartInputSchema.parse({
      surface: "desktop",
      clientCapture: false,
      persist: true,
      config: { phrase: "hey agent" },
    });
    expect(parsed.config?.phrase).toBe("hey agent");
    expect(parsed.persist).toBe(true);
  });

  it("defaults stop input persist to false", () => {
    expect(WakeStopInputSchema.parse({}).persist).toBe(false);
    expect(WakeStopInputSchema.parse({ persist: true }).persist).toBe(true);
  });

  it("parses feed input with default sample rate", () => {
    expect(WakeFeedInputSchema.parse({ pcm: "base64==" }).sampleRate).toBe(16000);
    expect(WakeFeedInputSchema.parse({ pcm: "base64==", sampleRate: 48000 }).sampleRate).toBe(48000);
    expect(WakeFeedInputSchema.safeParse({}).success).toBe(false);
  });
});
