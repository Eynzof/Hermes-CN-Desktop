/**
 * Voice Mode — stop phrase detection.
 *
 * Mirrors Python `is_voice_stop_phrase`: strict whole-utterance match,
 * punctuation/case normalized, empty config disables.
 */

export function isVoiceStopPhrase(transcript: string, stopPhrases: string[]): boolean {
  if (!stopPhrases.length) return false;
  const normalized = normalizeStopPhrase(transcript);
  for (const phrase of stopPhrases) {
    if (normalizeStopPhrase(phrase) === normalized) return true;
  }
  return false;
}

function normalizeStopPhrase(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .trim();
}

export function voiceStopHint(stopPhrases: string[]): string {
  if (!stopPhrases.length) return "";
  return `说完“${stopPhrases.join(" / ")}”可结束语音对话。`;
}
