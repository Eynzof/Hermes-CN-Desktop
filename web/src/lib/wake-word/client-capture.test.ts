import { describe, expect, it, vi } from "vitest";
import { setWakeWordRequester, type WakeWordRequester } from "./wake-word-store";
import { createWakeWordClientCapture, DEFAULT_FRAME_LENGTH } from "./client-capture";

const mockRequester: WakeWordRequester = {
  status: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  feed: vi.fn().mockResolvedValue({ fed: true }),
  frameInfo: vi.fn(),
};

setWakeWordRequester(mockRequester);

describe("createWakeWordClientCapture helper logic", () => {
  it("stops gracefully when never started", () => {
    const capture = createWakeWordClientCapture();
    expect(() => capture.stop()).not.toThrow();
  });
});

describe("frame constants", () => {
  it("uses the expected detector frame length", () => {
    expect(DEFAULT_FRAME_LENGTH).toBe(1280);
  });
});
