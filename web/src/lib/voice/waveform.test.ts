import { describe, expect, it } from "vitest";
import { computeWaveformPeaks } from "./waveform";

describe("computeWaveformPeaks", () => {
  it("returns requested number of peaks", () => {
    const pcm = new Float32Array(600);
    for (let i = 0; i < pcm.length; i++) pcm[i] = Math.sin(i);
    const peaks = computeWaveformPeaks(pcm, { samples: 30 });
    expect(peaks.length).toBe(30);
    expect(peaks.every((p) => p >= 0 && p <= 1)).toBe(true);
  });

  it("handles Int16Array", () => {
    const pcm = new Int16Array(100);
    pcm.fill(32767);
    const peaks = computeWaveformPeaks(pcm, { samples: 10 });
    expect(peaks.length).toBe(10);
    expect(peaks.every((p) => p >= 0.99 && p <= 1)).toBe(true);
  });

  it("returns zeros for empty input", () => {
    expect(computeWaveformPeaks(new Float32Array(0), { samples: 5 })).toEqual([0, 0, 0, 0, 0]);
  });
});
