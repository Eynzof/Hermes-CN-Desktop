/**
 * URL gate for Google Meet.
 *
 * Mirrors Python `plugins/google_meet/meet_bot.py`:
 * - Only https://meet.google.com/<id>, /lookup/<id>, /new are accepted.
 * - Meeting id extraction; /new gets a synthetic id.
 * - Human-speaker heuristic and duration parser.
 */

const MEET_URL_RE =
  /^https:\/\/meet\.google\.com\/(?:(?:lookup\/)?[a-z]{3}-?[a-z]{4}-?[a-z]{3}|[a-z]{3}-?[a-z]{4}-?[a-z]{3}|new)(?:\?.*)?$/i;

const MEET_ID_RE = /(?:^|\/)([a-z]{3}-?[a-z]{4}-?[a-z]{3})$/i;

/** True if the URL looks like a valid Meet entry point. */
export function isSafeMeetUrl(url: string): boolean {
  if (!url || typeof url !== "string") return false;
  return MEET_URL_RE.test(url.trim());
}

/** Extract a stable meeting id from a Meet URL. */
export function meetingIdFromUrl(url: string): string | undefined {
  const trimmed = url.trim();
  const lower = trimmed.toLowerCase();
  if (lower.endsWith("/new") || lower.endsWith("/new/")) {
    return `new-${Date.now()}`;
  }
  const match = trimmed.match(MEET_ID_RE);
  if (match?.[1]) {
    return normalizeMeetingId(match[1]);
  }
  return undefined;
}

/** Remove optional dashes from the meeting code. */
export function normalizeMeetingId(id: string): string {
  return id.toLowerCase().replace(/-/g, "");
}

/**
 * Parse a duration value into minutes.
 * Accepts number (minutes) or strings like "30m", "1h", "90".
 */
export function parseDurationMinutes(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? value : undefined;
  }
  const str = String(value).trim().toLowerCase();
  if (!str) return undefined;

  const hours = str.match(/^(\d+(?:\.\d+)?)\s*h$/);
  if (hours) return Math.round(parseFloat(hours[1]) * 60);

  const minutes = str.match(/^(\d+(?:\.\d+)?)\s*m?$/);
  if (minutes) return Math.round(parseFloat(minutes[1]));

  return undefined;
}

/**
 * Heuristic used to filter self captions from other speakers.
 * In the Python bot this avoids echoing the bot's own TTS captions.
 */
export function looksLikeHumanSpeaker(speaker: string, guestName: string): boolean {
  const lower = speaker.trim().toLowerCase();
  const bot = guestName.trim().toLowerCase();
  if (lower === bot) return false;
  if (lower.includes("you")) return false;
  if (lower.includes("hermes") && !lower.includes("agent")) return false;
  return lower.length > 0;
}
