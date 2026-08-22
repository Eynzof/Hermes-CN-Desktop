import { describe, expect, it } from "vitest";
import {
  applyWakeStart,
  applyWakeStatus,
  applyWakeStop,
  setWakeError,
  setWakePending,
  type WakeWordState,
} from "./wake-word-store";
import type { WakeStartResponse, WakeStatusResponse, WakeStopResponse } from "./types";

const baseState: WakeWordState = {
  available: false,
  enabled: false,
  listening: false,
  pending: false,
  phrase: "hey hermes",
  notice: null,
  lastError: null,
};

const status: WakeStatusResponse = {
  listening: true,
  ownedByCaller: true,
  ownerSurface: "gui",
  phrase: "hey hermes",
  provider: "sherpa",
  configuredSurface: "gui",
  available: true,
  enabled: true,
  audioSilent: false,
  capture: "client",
  localInputAvailable: false,
  sampleRate: 16000,
  frameLength: 1280,
};

describe("applyWakeStatus", () => {
  it("updates availability, listening state, and phrase", () => {
    const next = applyWakeStatus(baseState, status);
    expect(next.available).toBe(true);
    expect(next.listening).toBe(true);
    expect(next.enabled).toBe(true);
    expect(next.phrase).toBe("hey hermes");
    expect(next.notice?.type).toBe("armed");
    expect(next.lastError).toBeNull();
  });
});

describe("applyWakeStart", () => {
  it("sets listening and armed notice on success", () => {
    const start: WakeStartResponse = {
      started: true,
      phrase: "hey hermes",
      provider: "sherpa",
      capture: "client",
      sampleRate: 16000,
      frameLength: 1280,
    };
    const next = applyWakeStart(baseState, start);
    expect(next.listening).toBe(true);
    expect(next.pending).toBe(false);
    expect(next.notice?.type).toBe("armed");
  });

  it("surfaces refusal reason on failure", () => {
    const start: WakeStartResponse = {
      started: false,
      reason: "mic unavailable",
      phrase: "hey hermes",
      provider: "sherpa",
      capture: "client",
      sampleRate: 16000,
      frameLength: 1280,
    };
    const next = applyWakeStart(baseState, start);
    expect(next.listening).toBe(false);
    expect(next.pending).toBe(false);
    expect(next.notice).toEqual({ type: "refused", reason: "mic unavailable" });
    expect(next.lastError).toBe("mic unavailable");
  });
});

describe("applyWakeStop", () => {
  it("clears listening and notice on success", () => {
    const listening: WakeWordState = { ...baseState, listening: true };
    const stop: WakeStopResponse = { stopped: true };
    const next = applyWakeStop(listening, stop);
    expect(next.listening).toBe(false);
    expect(next.notice).toBeNull();
  });

  it("keeps error notice on failure", () => {
    const stop: WakeStopResponse = { stopped: false, reason: "not owner" };
    const next = applyWakeStop(baseState, stop);
    expect(next.notice?.type).toBe("error");
    expect(next.lastError).toBe("not owner");
  });
});

describe("setWakePending", () => {
  it("toggles pending flag", () => {
    expect(setWakePending(baseState, true).pending).toBe(true);
    expect(setWakePending(baseState, false).pending).toBe(false);
  });
});

describe("setWakeError", () => {
  it("sets error notice and clears pending", () => {
    const pending: WakeWordState = { ...baseState, pending: true };
    const next = setWakeError(pending, "boom");
    expect(next.pending).toBe(false);
    expect(next.lastError).toBe("boom");
    expect(next.notice).toEqual({ type: "error", message: "boom" });
  });
});
