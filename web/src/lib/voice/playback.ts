/**
 * TTS / Voice Messages — Web Audio playback engine.
 *
 * Provides a simple PCM/AudioBuffer playback queue with stop/barge-in support.
 * Mirrors Python `stream_tts_to_speaker` behaviour in the browser.
 */

export interface PlaybackEngine {
  playBuffer(buffer: AudioBuffer): Promise<void>;
  playPcm(pcm: Int16Array, sampleRate: number, channelCount?: number): Promise<void>;
  stop(): void;
  isPlaying(): boolean;
}

export function createPlaybackEngine(audioContext?: AudioContext): PlaybackEngine {
  const ctx = audioContext ?? (typeof AudioContext !== "undefined" ? new AudioContext() : undefined);
  let currentSource: AudioBufferSourceNode | undefined;

  return {
    isPlaying: () => ctx?.state === "running" && currentSource !== undefined,

    async playBuffer(buffer: AudioBuffer): Promise<void> {
      if (!ctx) throw new Error("AudioContext not available");
      if (ctx.state === "suspended") await ctx.resume();
      this.stop();
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      currentSource = source;
      await new Promise<void>((resolve) => {
        source.onended = () => {
          if (currentSource === source) currentSource = undefined;
          resolve();
        };
        source.start();
      });
    },

    async playPcm(pcm: Int16Array, sampleRate: number, channelCount = 1): Promise<void> {
      if (!ctx) throw new Error("AudioContext not available");
      const frames = Math.floor(pcm.length / channelCount);
      const buffer = ctx.createBuffer(channelCount, frames, sampleRate);
      for (let ch = 0; ch < channelCount; ch++) {
        const channel = buffer.getChannelData(ch);
        for (let i = 0; i < frames; i++) {
          channel[i] = pcm[i * channelCount + ch] / 32768;
        }
      }
      return this.playBuffer(buffer);
    },

    stop() {
      if (currentSource) {
        try {
          currentSource.stop();
        } catch {
          // ignore
        }
        currentSource = undefined;
      }
    },
  };
}
