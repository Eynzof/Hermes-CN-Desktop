import { describe, expect, it } from "vitest";
import {
  SpotifyAlbum,
  SpotifyAlbumTracksResponse,
  SpotifyAlbumsInput,
  SpotifyAuthJson,
  SpotifyAuthJsonResult,
  SpotifyAuthUrlInput,
  SpotifyAuthUrlResult,
  SpotifyCallbackStartInput,
  SpotifyCallbackStartResult,
  SpotifyCallbackWaitResult,
  SpotifyDevice,
  SpotifyDevicesInput,
  SpotifyDevicesResponse,
  SpotifyExchangeInput,
  SpotifyLibraryAction,
  SpotifyLibraryInput,
  SpotifyPlaybackAction,
  SpotifyPlaybackInput,
  SpotifyPlaybackState,
  SpotifyPlaylist,
  SpotifyPlaylistTracksResponse,
  SpotifyPlaylistsInput,
  SpotifyQueueInput,
  SpotifyQueueResponse,
  SpotifyRefreshInput,
  SpotifySavedTracksResponse,
  SpotifySearchInput,
  SpotifySearchKind,
  SpotifySearchResponse,
  SpotifyTokenResponse,
  SpotifyTokenState,
  SpotifyTrack,
  SpotifyUserPlaylistsResponse,
} from "./spotify";

const tokenState = {
  client_id: "client",
  redirect_uri: "http://localhost:8888/callback",
  scope: "user-read-playback-state",
  access_token: "at",
  refresh_token: "rt",
  token_type: "Bearer",
  expires_at: "2026-01-02T00:00:00Z",
  expires_in: 3600,
  obtained_at: "2026-01-01T00:00:00Z",
  auth_type: "oauth_pkce",
} as const;

describe("SpotifyTokenState", () => {
  it("parses a full token state and applies base-url defaults", () => {
    const parsed = SpotifyTokenState.parse(tokenState);
    expect(parsed.api_base_url).toBe("https://api.spotify.com/v1");
    expect(parsed.accounts_base_url).toBe("https://accounts.spotify.com");
    expect(parsed.granted_scope).toBeUndefined();
    expect(parsed.last_auth_error).toBeUndefined();
  });

  it("keeps explicit base urls, granted_scope and last_auth_error", () => {
    const parsed = SpotifyTokenState.parse({
      ...tokenState,
      api_base_url: "http://localhost:8080",
      granted_scope: "user-read-playback-state",
      last_auth_error: { error: "invalid_grant", error_description: "expired", timestamp: "2026-01-01T00:00:00Z" },
    });
    expect(parsed.api_base_url).toBe("http://localhost:8080");
    expect(parsed.granted_scope).toBe("user-read-playback-state");
    expect(parsed.last_auth_error?.error).toBe("invalid_grant");
  });

  it("rejects wrong literal token_type/auth_type and missing fields", () => {
    expect(SpotifyTokenState.safeParse({ ...tokenState, token_type: "bearer" }).success).toBe(false);
    expect(SpotifyTokenState.safeParse({ ...tokenState, auth_type: "client_credentials" }).success).toBe(false);
    expect(SpotifyTokenState.safeParse({ ...tokenState, access_token: undefined }).success).toBe(false);
    expect(SpotifyTokenState.safeParse({ ...tokenState, scope: 1 }).success).toBe(false);
  });
});

describe("SpotifyAuthJson", () => {
  it("parses the auth.json wrapper with optional spotify provider", () => {
    const parsed = SpotifyAuthJson.parse({ providers: { spotify: tokenState } });
    expect(parsed.providers?.spotify?.client_id).toBe("client");
    expect(SpotifyAuthJson.parse({}).providers).toBeUndefined();
  });

  it("keeps unknown top-level and provider keys (passthrough)", () => {
    const parsed = SpotifyAuthJson.parse({ providers: { openai: { key: "sk" } }, extra: 1 });
    expect(parsed.providers?.openai).toEqual({ key: "sk" });
    expect((parsed as any).extra).toBe(1);
  });

  it("rejects an invalid spotify token state inside the wrapper", () => {
    const result = SpotifyAuthJson.safeParse({ providers: { spotify: { token_type: "bad" } } });
    expect(result.success).toBe(false);
  });
});

describe("Spotify API response shapes", () => {
  it("parses a device and keeps passthrough keys", () => {
    const parsed = SpotifyDevice.parse({
      id: "dev1",
      is_active: true,
      is_private_session: false,
      is_restricted: false,
      name: "Speakers",
      type: "Computer",
      volume_percent: 80,
      brand: "Sonos", // passthrough
    });
    expect(parsed.name).toBe("Speakers");
    expect((parsed as any).brand).toBe("Sonos");
    expect(SpotifyDevice.safeParse({ name: "x", type: "Computer" }).success).toBe(true);
    expect(SpotifyDevice.safeParse({}).success).toBe(false);
  });

  it("parses devices response", () => {
    const parsed = SpotifyDevicesResponse.parse({ devices: [{ name: "A", type: "Computer" }] });
    expect(parsed.devices).toHaveLength(1);
  });

  it("parses playback state with optional fields", () => {
    const parsed = SpotifyPlaybackState.parse({
      device: { name: "A", type: "Computer" },
      shuffle_state: false,
      repeat_state: "off",
      timestamp: 1,
      context: { type: "playlist", uri: "spotify:playlist:1" },
      progress_ms: 1000,
      item: null,
      currently_playing_type: "track",
      is_playing: true,
    });
    expect(parsed.context?.uri).toBe("spotify:playlist:1");
    expect(parsed.is_playing).toBe(true);
    expect(SpotifyPlaybackState.parse({}).is_playing).toBeUndefined();
  });

  it("parses queue, playlist, album and track shapes", () => {
    const queue = SpotifyQueueResponse.parse({ currently_playing: null, queue: [{ name: "t" }] });
    expect(queue.queue).toHaveLength(1);

    const playlist = SpotifyPlaylist.parse({
      id: "pl1",
      name: "Focus",
      description: null,
      uri: "spotify:playlist:pl1",
      owner: { id: "u1" },
      tracks: { total: 5 },
    });
    expect(playlist.tracks?.total).toBe(5);

    const album = SpotifyAlbum.parse({ id: "al1", name: "Album", album_type: "album", total_tracks: 10, uri: "spotify:album:al1", artists: [] });
    expect(album.total_tracks).toBe(10);

    const track = SpotifyTrack.parse({
      id: "t1",
      name: "Song",
      uri: "spotify:track:t1",
      artists: [{ name: "Artist" }],
      album: { name: "Album" },
    });
    expect(track.artists?.[0]?.name).toBe("Artist");
  });

  it("parses search response with optional entity buckets", () => {
    const parsed = SpotifySearchResponse.parse({
      tracks: { items: [{ id: "t1", name: "S", uri: "spotify:track:t1" }] },
      albums: { items: [] },
    });
    expect(parsed.tracks?.items).toHaveLength(1);
    expect(SpotifySearchResponse.parse({}).tracks).toBeUndefined();
  });

  it("parses saved-tracks / playlists / album-tracks paged responses", () => {
    const saved = SpotifySavedTracksResponse.parse({
      items: [{ track: { id: "t1", name: "S", uri: "spotify:track:t1" } }],
      total: 1,
      limit: 20,
      offset: 0,
    });
    expect(saved.items?.[0]?.track?.id).toBe("t1");
    expect(SpotifyUserPlaylistsResponse.parse({ items: [] }).total).toBeUndefined();
    expect(SpotifyAlbumTracksResponse.parse({ items: [], total: 0 }).total).toBe(0);
    expect(SpotifyPlaylistTracksResponse.parse({ items: [{ track: { id: "t", name: "n", uri: "u" } }] }).items).toHaveLength(1);
  });
});

describe("SpotifyTokenResponse", () => {
  it("parses an OAuth token response and keeps passthrough keys", () => {
    const parsed = SpotifyTokenResponse.parse({
      access_token: "at",
      token_type: "Bearer",
      scope: "user-read",
      expires_in: 3600,
      refresh_token: "rt",
      foo: "bar",
    });
    expect(parsed.refresh_token).toBe("rt");
    expect((parsed as any).foo).toBe("bar");
    expect(SpotifyTokenResponse.safeParse({ access_token: "a", token_type: "bearer", scope: "", expires_in: 1 }).success).toBe(false);
  });
});

describe("Spotify OAuth input schemas", () => {
  it("parses auth-url input/result", () => {
    const input = SpotifyAuthUrlInput.parse({ clientId: "c", redirectUri: "http://localhost:8888/callback" });
    expect(input.scope).toBeUndefined();
    const result = SpotifyAuthUrlResult.parse({ authUrl: "https://accounts.spotify.com/authorize?x=1", codeVerifier: "v", state: "s" });
    expect(result.codeVerifier).toBe("v");
    expect(SpotifyAuthUrlInput.safeParse({ redirectUri: "x" }).success).toBe(false);
    expect(SpotifyAuthUrlResult.safeParse({ authUrl: "u" }).success).toBe(false);
  });

  it("parses exchange and refresh inputs", () => {
    expect(
      SpotifyExchangeInput.parse({ clientId: "c", redirectUri: "r", code: "c1", codeVerifier: "v" }).code,
    ).toBe("c1");
    expect(
      SpotifyRefreshInput.parse({ clientId: "c", refreshToken: "rt" }).refreshToken,
    ).toBe("rt");
    expect(SpotifyExchangeInput.safeParse({ clientId: "c", redirectUri: "r", codeVerifier: "v" }).success).toBe(false);
    expect(SpotifyRefreshInput.safeParse({ clientId: "c" }).success).toBe(false);
  });
});

describe("Spotify action enums", () => {
  it("accepts every playback action", () => {
    const actions = [
      "play", "pause", "toggle", "next", "previous", "seek", "volume",
      "transfer", "shuffle", "repeat", "play_uris", "play_context",
    ];
    for (const a of actions) expect(SpotifyPlaybackAction.parse(a)).toBe(a);
    expect(SpotifyPlaybackAction.safeParse("resume").success).toBe(false);
  });

  it("accepts every search kind and library action", () => {
    for (const k of ["track", "album", "artist", "playlist", "show", "episode"]) {
      expect(SpotifySearchKind.parse(k)).toBe(k);
    }
    expect(SpotifySearchKind.safeParse("podcast").success).toBe(false);
    for (const a of ["saved_tracks", "saved_albums", "contains", "save_tracks", "remove_tracks"]) {
      expect(SpotifyLibraryAction.parse(a)).toBe(a);
    }
    expect(SpotifyLibraryAction.safeParse("delete").success).toBe(false);
  });
});

describe("Tool input schemas", () => {
  it("parses playback input with all optional fields", () => {
    const parsed = SpotifyPlaybackInput.parse({
      action: "seek",
      device_id: "d1",
      uris: ["spotify:track:t1"],
      context_uri: "spotify:album:a1",
      offset: 2,
      position_ms: 1000,
      volume_percent: 50,
      state: true,
      repeat_mode: "track",
    });
    expect(parsed.action).toBe("seek");
    expect(parsed.uris).toEqual(["spotify:track:t1"]);
    expect(parsed.repeat_mode).toBe("track");
    expect(SpotifyPlaybackInput.safeParse({ action: "skip" }).success).toBe(false);
    expect(SpotifyPlaybackInput.safeParse({}).success).toBe(false);
  });

  it("parses devices input with optional device_id", () => {
    expect(SpotifyDevicesInput.parse({}).device_id).toBeUndefined();
    expect(SpotifyDevicesInput.parse({ device_id: "d" }).device_id).toBe("d");
  });

  it("defaults queue action to get", () => {
    expect(SpotifyQueueInput.parse({}).action).toBe("get");
    expect(SpotifyQueueInput.parse({ action: "add", uri: "spotify:track:t1" }).uri).toBe("spotify:track:t1");
    expect(SpotifyQueueInput.safeParse({ action: "pop" }).success).toBe(false);
  });

  it("validates search input bounds and defaults", () => {
    const parsed = SpotifySearchInput.parse({ query: "daft" });
    expect(parsed.kind).toBe("track");
    expect(parsed.limit).toBe(10);
    expect(parsed.offset).toBe(0);
    expect(SpotifySearchInput.parse({ query: "x", kind: ["track", "album"], limit: 50 }).kind).toEqual(["track", "album"]);
    expect(SpotifySearchInput.safeParse({ query: "x", limit: 0 }).success).toBe(false);
    expect(SpotifySearchInput.safeParse({ query: "x", limit: 51 }).success).toBe(false);
    expect(SpotifySearchInput.safeParse({ query: "x", kind: "podcast" }).success).toBe(false);
    expect(SpotifySearchInput.safeParse({}).success).toBe(false);
  });

  it("defaults playlists/albums/library actions and validates limits", () => {
    expect(SpotifyPlaylistsInput.parse({}).action).toBe("list");
    expect(SpotifyPlaylistsInput.parse({}).limit).toBe(20);
    expect(SpotifyPlaylistsInput.safeParse({ limit: 0 }).success).toBe(false);
    expect(SpotifyAlbumsInput.parse({}).action).toBe("get");
    expect(SpotifyAlbumsInput.parse({ action: "tracks", album_id: "al1" }).album_id).toBe("al1");
    expect(SpotifyLibraryInput.parse({}).action).toBe("saved_tracks");
    expect(SpotifyLibraryInput.safeParse({ action: "wipe" }).success).toBe(false);
  });
});

describe("Rust callback schemas", () => {
  it("defaults the callback path", () => {
    expect(SpotifyCallbackStartInput.parse({}).path).toBe("/spotify/callback");
    expect(SpotifyCallbackStartInput.parse({ port: 9999 }).port).toBe(9999);
  });

  it("parses callback start/wait results", () => {
    const start = SpotifyCallbackStartResult.parse({ port: 8888, redirectUri: "http://localhost:8888/callback" });
    expect(start.redirectUri).toContain("8888");
    const wait = SpotifyCallbackWaitResult.parse({ code: "auth", state: "st", extra: "kept" });
    expect(wait.code).toBe("auth");
    expect((wait as any).extra).toBe("kept");
    expect(SpotifyCallbackStartResult.safeParse({ port: 1 }).success).toBe(false);
  });

  it("parses auth-json result with optional provider/error", () => {
    const parsed = SpotifyAuthJsonResult.parse({ ok: true, provider: tokenState });
    expect(parsed.provider?.client_id).toBe("client");
    expect(SpotifyAuthJsonResult.parse({ ok: false, error: "no auth" }).error).toBe("no auth");
    expect(SpotifyAuthJsonResult.safeParse({}).success).toBe(false);
  });
});
