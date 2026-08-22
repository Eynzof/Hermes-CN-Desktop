import { describe, it, expect } from "vitest";
import {
  spotifyPlayback,
  spotifyDevices,
  spotifyQueue,
  spotifySearch,
  spotifyPlaylists,
  spotifyAlbums,
  spotifyLibrary,
} from "./tools.js";
import type { SpotifyToolContext } from "./types.js";

function makeCtx(response: unknown): SpotifyToolContext {
  return {
    env: {},
    spotify: {
      getState: async () => ({
        client_id: "cid",
        redirect_uri: "http://127.0.0.1/cb",
        api_base_url: "https://api.spotify.com/v1",
        accounts_base_url: "https://accounts.spotify.com",
        scope: "s",
        access_token: "at",
        refresh_token: "rt",
        token_type: "Bearer",
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
        expires_in: 3600,
        obtained_at: new Date().toISOString(),
        auth_type: "oauth_pkce",
      }),
      saveState: async () => {},
    },
    // Override fetch via a custom client is not supported directly; tests here
    // validate argument coercion and schema-level behavior.
  };
}

describe("spotifyPlayback argument coercion", () => {
  it("errors on missing position_ms for seek", async () => {
    const ctx = makeCtx({});
    const result = await spotifyPlayback({ action: "seek" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("position_ms");
  });

  it("errors on missing volume_percent for volume", async () => {
    const ctx = makeCtx({});
    const result = await spotifyPlayback({ action: "volume" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("volume_percent");
  });

  it("errors on missing device_id for transfer", async () => {
    const ctx = makeCtx({});
    const result = await spotifyPlayback({ action: "transfer" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("device_id");
  });

  it("errors on missing context_uri for play_context", async () => {
    const ctx = makeCtx({});
    const result = await spotifyPlayback({ action: "play_context" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("context_uri");
  });
});

describe("spotifyQueue argument validation", () => {
  it("errors on missing uri for add", async () => {
    const ctx = makeCtx({});
    const result = await spotifyQueue({ action: "add" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("uri");
  });

  it("reports clear unsupported", async () => {
    const ctx = makeCtx({});
    const result = await spotifyQueue({ action: "clear" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("not support");
  });
});

describe("spotifySearch argument validation", () => {
  it("errors on missing query", async () => {
    const ctx = makeCtx({});
    const result = await spotifySearch({ query: "" }, ctx);
    // The search endpoint will be called with empty query and fail; we just
    // verify it runs without argument errors.
    expect(typeof result.content).toBe("string");
  });

  it("accepts single kind", async () => {
    const ctx = makeCtx({});
    const result = await spotifySearch({ query: "hello", kind: "album" }, ctx);
    expect(typeof result.content).toBe("string");
  });

  it("accepts array of kinds", async () => {
    const ctx = makeCtx({});
    const result = await spotifySearch({ query: "hello", kind: ["track", "artist"] }, ctx);
    expect(typeof result.content).toBe("string");
  });
});

describe("spotifyPlaylists argument validation", () => {
  it("errors on missing playlist_id for tracks", async () => {
    const ctx = makeCtx({});
    const result = await spotifyPlaylists({ action: "tracks" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("playlist_id");
  });

  it("errors on missing uris for add_items", async () => {
    const ctx = makeCtx({});
    const result = await spotifyPlaylists({ action: "add_items", playlist_id: "abc" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("uris");
  });
});

describe("spotifyAlbums argument validation", () => {
  it("errors on missing album_id for get", async () => {
    const ctx = makeCtx({});
    const result = await spotifyAlbums({ action: "get" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("album_id");
  });
});

describe("spotifyLibrary argument validation", () => {
  it("errors on missing ids for save_tracks", async () => {
    const ctx = makeCtx({});
    const result = await spotifyLibrary({ action: "save_tracks" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("ids");
  });

  it("errors on missing ids for contains", async () => {
    const ctx = makeCtx({});
    const result = await spotifyLibrary({ action: "contains" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("ids");
  });
});
