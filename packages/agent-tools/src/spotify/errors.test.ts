import { describe, expect, it } from "vitest";
import {
  SpotifyError,
  SpotifyAuthRequiredError,
  SpotifyApiError,
  friendlySpotifyErrorMessage,
} from "./errors.js";

describe("SpotifyError", () => {
  it("is an Error with name SpotifyError and optional metadata", () => {
    const err = new SpotifyError("boom", 429, "RATE_LIMITED", 12);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(SpotifyError);
    expect(err.name).toBe("SpotifyError");
    expect(err.message).toBe("boom");
    expect(err.status).toBe(429);
    expect(err.code).toBe("RATE_LIMITED");
    expect(err.retryAfter).toBe(12);
  });

  it("defaults metadata to undefined", () => {
    const err = new SpotifyError("boom");
    expect(err.status).toBeUndefined();
    expect(err.code).toBeUndefined();
    expect(err.retryAfter).toBeUndefined();
  });
});

describe("SpotifyAuthRequiredError", () => {
  it("sets status 401 and code AUTH_REQUIRED", () => {
    const err = new SpotifyAuthRequiredError();
    expect(err).toBeInstanceOf(SpotifyError);
    expect(err.name).toBe("SpotifyAuthRequiredError");
    expect(err.status).toBe(401);
    expect(err.code).toBe("AUTH_REQUIRED");
    expect(err.message).toBe("Spotify authentication required. Please run Spotify login.");
  });

  it("accepts a custom message", () => {
    const err = new SpotifyAuthRequiredError("please connect");
    expect(err.message).toBe("please connect");
    expect(err.status).toBe(401);
  });
});

describe("SpotifyApiError", () => {
  it("sets status, code SPOTIFY_API_ERROR and body", () => {
    const body = { error: { message: "not found" } };
    const err = new SpotifyApiError("nope", 404, body);
    expect(err).toBeInstanceOf(SpotifyError);
    expect(err.name).toBe("SpotifyApiError");
    expect(err.status).toBe(404);
    expect(err.code).toBe("SPOTIFY_API_ERROR");
    expect(err.body).toBe(body);
  });
});

describe("friendlySpotifyErrorMessage", () => {
  it("maps 401 to expired-auth guidance", () => {
    expect(friendlySpotifyErrorMessage(401, {})).toBe("Spotify authentication expired. Please log in again.");
  });

  it("maps 403 with a premium message to premium guidance", () => {
    expect(friendlySpotifyErrorMessage(403, { error: { message: "requires premium" } })).toBe(
      "This action requires a Spotify Premium account.",
    );
  });

  it("maps 403 without premium to device guidance", () => {
    expect(friendlySpotifyErrorMessage(403, "forbidden")).toBe(
      "Spotify action forbidden. Make sure Spotify is open and an active device is selected.",
    );
  });

  it("maps 404 to no-active-device guidance", () => {
    expect(friendlySpotifyErrorMessage(404, {})).toBe(
      "No active Spotify device found. Open Spotify on a device and try again.",
    );
  });

  it("maps 429 to rate-limit guidance", () => {
    expect(friendlySpotifyErrorMessage(429, {})).toBe("Spotify rate limit hit. Please wait a moment and try again.");
  });

  it("maps 5xx to service-error guidance", () => {
    expect(friendlySpotifyErrorMessage(500, {})).toBe("Spotify service error. Please try again later.");
    expect(friendlySpotifyErrorMessage(503, {})).toBe("Spotify service error. Please try again later.");
  });

  it("falls back to the extracted message for other statuses", () => {
    expect(friendlySpotifyErrorMessage(400, { error: { message: "bad request" } })).toBe("bad request");
    expect(friendlySpotifyErrorMessage(400, "plain text body")).toBe("plain text body");
  });

  it("falls back to a generic message when no body message exists", () => {
    expect(friendlySpotifyErrorMessage(400, {})).toBe("Spotify request failed (HTTP 400).");
    expect(friendlySpotifyErrorMessage(400, undefined)).toBe("Spotify request failed (HTTP 400).");
  });

  it("extracts messages from nested error objects and top-level message keys", () => {
    expect(friendlySpotifyErrorMessage(400, { message: "top level" })).toBe("top level");
    expect(friendlySpotifyErrorMessage(400, { error: "string error" })).toBe("string error");
  });
});
