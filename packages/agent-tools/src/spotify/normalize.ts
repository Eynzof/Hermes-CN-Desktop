const SPOTIFY_URI_RE = /^spotify:([a-z]+):([a-zA-Z0-9]+)$/;

export function normalizeSpotifyId(value: string, expectedType?: string): string {
  const uri = normalizeSpotifyUri(value, expectedType);
  const match = uri.match(SPOTIFY_URI_RE);
  if (!match) {
    throw new Error(`Invalid Spotify identifier: ${value}`);
  }
  return match[2];
}

export function normalizeSpotifyUri(value: string, expectedType?: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("spotify:")) {
    const match = trimmed.match(SPOTIFY_URI_RE);
    if (!match) {
      throw new Error(`Invalid Spotify URI: ${value}`);
    }
    if (expectedType && match[1] !== expectedType) {
      throw new Error(`Expected Spotify ${expectedType} URI, got ${match[1]}`);
    }
    return trimmed;
  }

  try {
    const url = new URL(trimmed);
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length >= 2) {
      const type = parts[parts.length - 2];
      const id = parts[parts.length - 1];
      if (expectedType && type !== expectedType) {
        throw new Error(`Expected Spotify ${expectedType} URL, got ${type}`);
      }
      return `spotify:${type}:${id}`;
    }
  } catch {
    // fall through to plain-id handling
  }

  const plainId = trimmed.replace(/^https?:\/\//, "").replace(/\//g, "");
  if (!plainId) {
    throw new Error(`Invalid Spotify identifier: ${value}`);
  }
  if (expectedType) {
    return `spotify:${expectedType}:${plainId}`;
  }
  throw new Error(`Cannot infer Spotify type for: ${value}`);
}

export function normalizeSpotifyUris(value: unknown, expectedType?: string): string[] {
  if (Array.isArray(value)) {
    return value.map((v) => normalizeSpotifyUri(String(v), expectedType));
  }
  return String(value)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => normalizeSpotifyUri(s, expectedType));
}

export function compactJson(value: unknown): string {
  return JSON.stringify(value);
}
