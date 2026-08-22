import { describe, expect, it } from "vitest";
import { createVadState, updateVad, type VadConfig } from "./vad";

const cfg: VadConfig = {
  silenceThreshold: 200,
  silenceDurationMs: 3000,
  minSpeechMs: 300,
  maxDipToleranceMs: 300,
  maxWaitMs: 15000,
  maxRecordingSeconds: 120,
};

function frames(
  state: ReturnType<typeof createVadState>,
  rms: number,
  count: number,
  startMs: number,
  step = 100,
) {
  let s = state;
  for (let i = 0; i < count; i++) {
    s = updateVad(s, { rms, timestampMs: startMs + i * step }, cfg);
  }
  return s;
}

describe("VAD", () => {
  it("transitions to speaking after min speech duration", () => {
    let state = createVadState();
    const now = Date.now();
    state = frames(state, 300, 5, now);
    expect(state.speaking).toBe(true);
  });

  it("stops after silence duration", () => {
    const now = Date.now();
    let state = createVadState();
    state = frames(state, 300, 5, now);
    expect(state.speaking).toBe(true);
    state = frames(state, 0, 31, now + 500); // 3100ms silence after speech frames
    expect(state.stopped).toBe(true);
    expect(state.reason).toBe("silence");
  });

  it("aborts on no-speech timeout", () => {
    let state = createVadState();
    const now = Date.now();
    for (let i = 0; i < 160; i++) {
      state = updateVad(state, { rms: 100, timestampMs: now + i * 100 }, cfg);
    }
    expect(state.aborted).toBe(true);
    expect(state.reason).toBe("max_wait");
  });

  it("stops at max recording seconds", () => {
    let state = createVadState();
    const now = Date.now();
    for (let i = 0; i <= 1201; i++) {
      state = updateVad(state, { rms: 300, timestampMs: now + i * 100 }, cfg);
    }
    expect(state.stopped).toBe(true);
    expect(state.reason).toBe("max_recording");
  });
});
