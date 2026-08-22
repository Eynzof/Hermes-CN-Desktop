import { getWakeWordRequester } from "./wake-word-store";

export const TARGET_RATE = 16000;
export const DEFAULT_FRAME_LENGTH = 1280;
const MAX_COALESCED_FRAMES = 4;

export interface ClientCaptureHandle {
  start: () => Promise<void>;
  stop: () => void;
  isRunning: () => boolean;
}

function downsampleTo16k(input: Float32Array, inputRate: number): Float32Array {
  if (inputRate === TARGET_RATE) return input;
  const ratio = TARGET_RATE / inputRate;
  const outLen = Math.floor(input.length * ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const srcIndex = i / ratio;
    const i0 = Math.floor(srcIndex);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = srcIndex - i0;
    out[i] = input[i0] * (1 - frac) + input[i1] * frac;
  }
  return out;
}

function floatToInt16Le(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const sample = Math.max(-1, Math.min(1, input[i]));
    out[i] = Math.round(sample * 32767);
  }
  return out;
}

function int16ToBase64(samples: Int16Array): string {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i++) {
    view.setInt16(i * 2, samples[i], true);
  }
  const chunkSize = 0x8000;
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + chunkSize)));
  }
  return btoa(chunks.join(""));
}

class BoundedAudioQueue {
  private frames: Int16Array[] = [];
  private maxFrames: number;

  constructor(maxFrames: number) {
    this.maxFrames = maxFrames;
  }

  push(frame: Int16Array) {
    if (this.frames.length >= this.maxFrames) {
      this.frames.shift();
    }
    this.frames.push(frame);
  }

  drain(maxFrames: number): Int16Array[] {
    const count = Math.min(maxFrames, this.frames.length);
    return this.frames.splice(0, count);
  }
}

export function createWakeWordClientCapture(
  onError?: (error: Error) => void,
): ClientCaptureHandle {
  let stream: MediaStream | null = null;
  let audioContext: AudioContext | null = null;
  let scriptNode: ScriptProcessorNode | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let running = false;
  const queue = new BoundedAudioQueue(16);

  const flush = () => {
    const requester = getWakeWordRequester();
    if (!requester) return;
    const frames = queue.drain(MAX_COALESCED_FRAMES);
    if (frames.length === 0) return;
    const total = frames.reduce((sum, f) => sum + f.length, 0);
    const merged = new Int16Array(total);
    let offset = 0;
    for (const frame of frames) {
      merged.set(frame, offset);
      offset += frame.length;
    }
    const pcm = int16ToBase64(merged);
    requester.feed(pcm).catch((err) => {
      onError?.(err instanceof Error ? err : new Error(String(err)));
    });
  };

  const handle = setInterval(flush, 100);

  return {
    start: async () => {
      if (running) return;
      const mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: { ideal: TARGET_RATE },
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
      stream = mediaStream;
      const AudioContextCtor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioContextCtor) {
        throw new Error("Web Audio API is not supported");
      }
      audioContext = new AudioContextCtor({ sampleRate: TARGET_RATE });
      const sourceNode = audioContext.createMediaStreamSource(mediaStream);
      source = sourceNode;
      const processor = audioContext.createScriptProcessor(4096, 1, 1);
      scriptNode = processor;

      processor.onaudioprocess = (event) => {
        const inputBuffer = event.inputBuffer;
        const inputData = inputBuffer.getChannelData(0);
        const inputRate = inputBuffer.sampleRate;
        const resampled = downsampleTo16k(inputData, inputRate);
        const int16 = floatToInt16Le(resampled);
        // Split into detector-sized frames.
        for (let offset = 0; offset < int16.length; offset += DEFAULT_FRAME_LENGTH) {
          const end = Math.min(offset + DEFAULT_FRAME_LENGTH, int16.length);
          const slice = int16.subarray(offset, end);
          const frame = new Int16Array(DEFAULT_FRAME_LENGTH);
          frame.set(slice);
          queue.push(frame);
        }
      };

      sourceNode.connect(processor);
      processor.connect(audioContext.destination);
      running = true;
    },
    stop: () => {
      clearInterval(handle);
      running = false;
      scriptNode?.disconnect();
      source?.disconnect();
      void audioContext?.close();
      stream?.getTracks().forEach((track) => track.stop());
      scriptNode = null;
      source = null;
      audioContext = null;
      stream = null;
    },
    isRunning: () => running,
  };
}
