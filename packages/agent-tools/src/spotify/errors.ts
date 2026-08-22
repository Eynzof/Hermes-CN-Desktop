export class SpotifyError extends Error {
  constructor(
    message: string,
    public status?: number,
    public code?: string,
    public retryAfter?: number,
  ) {
    super(message);
    this.name = "SpotifyError";
  }
}

export class SpotifyAuthRequiredError extends SpotifyError {
  constructor(message = "Spotify authentication required. Please run Spotify login.") {
    super(message, 401, "AUTH_REQUIRED");
    this.name = "SpotifyAuthRequiredError";
  }
}

export class SpotifyApiError extends SpotifyError {
  constructor(
    message: string,
    status: number,
    public body?: unknown,
  ) {
    super(message, status, "SPOTIFY_API_ERROR");
    this.name = "SpotifyApiError";
  }
}

export function friendlySpotifyErrorMessage(status: number, body: unknown): string {
  const msg = extractMessage(body);
  if (status === 401) return "Spotify authentication expired. Please log in again.";
  if (status === 403) {
    if (typeof msg === "string" && /premium/i.test(msg)) {
      return "This action requires a Spotify Premium account.";
    }
    return "Spotify action forbidden. Make sure Spotify is open and an active device is selected.";
  }
  if (status === 404) {
    return "No active Spotify device found. Open Spotify on a device and try again.";
  }
  if (status === 429) {
    return "Spotify rate limit hit. Please wait a moment and try again.";
  }
  if (status >= 500) {
    return "Spotify service error. Please try again later.";
  }
  return msg || `Spotify request failed (HTTP ${status}).`;
}

function extractMessage(body: unknown): string {
  if (typeof body === "string") return body;
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    if (typeof b.message === "string") return b.message;
    if (typeof b.error === "string") return b.error;
    if (b.error && typeof b.error === "object") {
      const e = b.error as Record<string, unknown>;
      if (typeof e.message === "string") return e.message;
    }
  }
  return "";
}
