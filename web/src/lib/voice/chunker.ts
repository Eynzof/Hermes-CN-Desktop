/**
 * TTS / Voice Messages — SentenceChunker.
 *
 * Mirrors Python `tools/tts_streaming.py SentenceChunker`:
 * buffer text deltas, emit complete sentences when punctuation/line break is
 * encountered, merge tiny fragments, and flush the remainder on done.
 */

export interface SentenceChunkerOptions {
  minLength?: number;
  maxLength?: number;
}

const SENTENCE_END_RE = /[.!?。！？](?:\s+|$)|\n{2,}/;
const SENTENCE_END_CAPTURE_RE = /([.!?。！？])(\s+|$)|(\n{2,})/;

export class SentenceChunker {
  private buffer = "";
  private done = false;
  private minLength: number;
  private maxLength: number;

  constructor(options: SentenceChunkerOptions = {}) {
    this.minLength = options.minLength ?? 20;
    this.maxLength = options.maxLength ?? 400;
  }

  push(delta: string): string[] {
    if (this.done) return [];
    this.buffer += delta;
    return this.drain();
  }

  flush(): string[] {
    if (this.done) return [];
    this.done = true;
    const remainder = this.buffer.trim();
    this.buffer = "";
    if (!remainder) return [];
    if (remainder.length < this.minLength) return [];
    return [remainder];
  }

  private drain(): string[] {
    const sentences: string[] = [];
    while (this.buffer.length >= this.minLength) {
      const match = this.buffer.match(SENTENCE_END_CAPTURE_RE);
      if (!match || match.index === undefined) break;
      const endIndex = match.index + (match[1]?.length || 0) + (match[2]?.length || 0) + (match[3]?.length || 0);
      const sentence = this.buffer.slice(0, endIndex).trim();
      if (sentence.length >= this.minLength) {
        sentences.push(sentence);
      }
      this.buffer = this.buffer.slice(endIndex).trimStart();
    }

    // Hard break if a single fragment exceeds maxLength.
    if (this.buffer.length > this.maxLength) {
      const splitAt = this.buffer.lastIndexOf(" ", this.maxLength);
      const boundary = splitAt > this.minLength ? splitAt : this.maxLength;
      const chunk = this.buffer.slice(0, boundary).trim();
      if (chunk.length >= this.minLength) sentences.push(chunk);
      this.buffer = this.buffer.slice(boundary).trimStart();
    }

    return sentences;
  }
}

export function createSentenceChunker(options?: SentenceChunkerOptions): SentenceChunker {
  return new SentenceChunker(options);
}
