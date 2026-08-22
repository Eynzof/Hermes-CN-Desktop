/**
 * TTS / Voice Messages — waveform peak extraction.
 *
 * Computes RMS peaks from PCM data for voice-bubble visualization.
 */

export function computeWaveformPeaks(
  pcm: Float32Array | Int16Array,
  options: { samples?: number; channelCount?: number } = {},
): number[] {
  const samples = options.samples ?? 60;
  const channelCount = options.channelCount ?? 1;
  const frameCount = Math.floor(pcm.length / channelCount);
  if (frameCount === 0) return new Array(samples).fill(0);
  const step = Math.max(1, Math.floor(frameCount / samples));
  const peaks: number[] = [];

  for (let i = 0; i < samples; i++) {
    const start = i * step * channelCount;
    const end = Math.min(start + step * channelCount, pcm.length);
    let sum = 0;
    let count = 0;
    for (let j = start; j < end; j += channelCount) {
      const sample = pcm instanceof Int16Array ? pcm[j] / 32768 : pcm[j];
      sum += sample * sample;
      count++;
    }
    peaks.push(count ? Math.min(1, Math.sqrt(sum / count)) : 0);
  }

  return peaks;
}
