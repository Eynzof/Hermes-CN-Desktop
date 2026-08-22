/**
 * Voice Mode — Whisper hallucination filter.
 *
 * Mirrors Python `is_whisper_hallucination`: known phrase list + repeat regex.
 */

const HALLUCINATED_PHRASES = new Set([
  "thank you",
  "thanks for watching",
  "please subscribe",
  "like and subscribe",
  "i'll see you next time",
  "goodbye",
  "see you later",
  "that's it",
  "so",
  "um",
  "uh",
  "hmm",
  "mhm",
  "okay",
  "ok",
]);

function normalizeTranscript(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\s]/gu, "").trim();
}

export function isWhisperHallucination(transcript: string): boolean {
  const normalized = normalizeTranscript(transcript);
  if (!normalized) return true;
  if (HALLUCINATED_PHRASES.has(normalized)) return true;

  // Repeated single word / sound, e.g. "谢谢 谢谢 谢谢" or "um um um"
  const words = normalized.split(/\s+/);
  if (words.length >= 3 && words.every((w) => w === words[0])) return true;

  return false;
}
