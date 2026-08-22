import { describe, expect, it, vi } from "vitest";
import { createVoiceModeController } from "./controller";

describe("VoiceModeController", () => {
  const cfg = {
    silenceThreshold: 200,
    silenceDurationMs: 3000,
    minSpeechMs: 300,
    maxDipToleranceMs: 300,
    maxWaitMs: 15000,
    maxRecordingSeconds: 120,
  };

  it("starts in listening status", () => {
    const controller = createVoiceModeController(cfg);
    const onStatus = vi.fn();
    controller.startContinuous({ onTranscript: vi.fn(), onStatus });
    expect(controller.status).toBe("listening");
    expect(onStatus).toHaveBeenCalledWith("listening");
  });

  it("transitions to recording on speech", () => {
    const controller = createVoiceModeController(cfg);
    controller.startContinuous({ onTranscript: vi.fn(), onStatus: vi.fn() });
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      controller.processAudioFrame(300, now + i * 100);
    }
    expect(controller.status).toBe("recording");
  });

  it("stops on explicit stopContinuous", () => {
    const controller = createVoiceModeController(cfg);
    controller.startContinuous({ onTranscript: vi.fn(), onStatus: vi.fn() });
    controller.stopContinuous();
    expect(controller.status).toBe("idle");
  });
});
