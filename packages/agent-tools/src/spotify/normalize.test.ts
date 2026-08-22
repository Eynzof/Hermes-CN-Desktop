import { describe, it, expect } from "vitest";
import {
  normalizeSpotifyId,
  normalizeSpotifyUri,
  normalizeSpotifyUris,
  compactJson,
} from "./normalize.js";

describe("normalizeSpotifyUri", () => {
  it("passes through spotify URIs", () => {
    expect(normalizeSpotifyUri("spotify:track:4uLU6hMCjMI75M1A2tKUQC", "track")).toBe(
      "spotify:track:4uLU6hMCjMI75M1A2tKUQC",
    );
  });

  it("converts open.spotify.com URLs to URIs", () => {
    expect(
      normalizeSpotifyUri("https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC", "track"),
    ).toBe("spotify:track:4uLU6hMCjMI75M1A2tKUQC");
  });

  it("infers type when expectedType is omitted and value is a URL", () => {
    expect(normalizeSpotifyUri("https://open.spotify.com/album/0sNOF9WDwhWunNAHPD3Baj")).toBe(
      "spotify:album:0sNOF9WDwhWunNAHPD3Baj",
    );
  });

  it("wraps a plain id when expectedType is given", () => {
    expect(normalizeSpotifyUri("4uLU6hMCjMI75M1A2tKUQC", "track")).toBe(
      "spotify:track:4uLU6hMCjMI75M1A2tKUQC",
    );
  });

  it("throws on type mismatch", () => {
    expect(() => normalizeSpotifyUri("spotify:album:0sNOF9WDwhWunNAHPD3Baj", "track")).toThrow();
  });

  it("throws on invalid input", () => {
    expect(() => normalizeSpotifyUri("")).toThrow();
  });
});

describe("normalizeSpotifyId", () => {
  it("extracts id from URI", () => {
    expect(normalizeSpotifyId("spotify:track:4uLU6hMCjMI75M1A2tKUQC", "track")).toBe(
      "4uLU6hMCjMI75M1A2tKUQC",
    );
  });

  it("extracts id from URL", () => {
    expect(normalizeSpotifyId("https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M", "playlist")).toBe(
      "37i9dQZF1DXcBWIGoYBM5M",
    );
  });
});

describe("normalizeSpotifyUris", () => {
  it("handles arrays", () => {
    expect(
      normalizeSpotifyUris([
        "spotify:track:abc",
        "https://open.spotify.com/track/def",
        "ghi",
      ], "track"),
    ).toEqual(["spotify:track:abc", "spotify:track:def", "spotify:track:ghi"]);
  });

  it("handles comma-separated strings", () => {
    expect(normalizeSpotifyUris("abc, https://open.spotify.com/track/def", "track")).toEqual([
      "spotify:track:abc",
      "spotify:track:def",
    ]);
  });
});

describe("compactJson", () => {
  it("serializes without whitespace", () => {
    expect(compactJson({ a: 1, b: [2, 3] })).toBe('{"a":1,"b":[2,3]}');
  });
});
