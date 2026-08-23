import { describe, expect, it, beforeEach, vi } from "vitest";
import "./catalog.js";
import { registry } from "../registry.js";

const TOOL_NAMES = [
  "spotify_playback",
  "spotify_devices",
  "spotify_queue",
  "spotify_search",
  "spotify_playlists",
  "spotify_albums",
  "spotify_library",
];

const authedCtx = {
  env: {
    spotify_access_token: "test-token",
    spotify_client_id: "test-client",
  },
};

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    headers: new Headers(),
  } as unknown as Response;
}

describe("spotify catalog registration", () => {
  it("registers the seven Spotify tools under the spotify toolset", () => {
    for (const name of TOOL_NAMES) {
      const entry = registry.get(name);
      expect(entry, `expected ${name}`).toBeDefined();
      expect(entry!.toolset).toBe("spotify");
      expect(entry!.handler).toBeTypeOf("function");
      expect(entry!.tags).toContain("spotify");
    }
  });

  it("exposes enums for playback actions and search fields", () => {
    const playback = registry.get("spotify_playback")!.schema;
    const action = playback.properties?.action as { enum?: string[] } | undefined;
    expect(action?.enum).toEqual([
      "play", "pause", "toggle", "next", "previous", "seek", "volume",
      "transfer", "shuffle", "repeat", "play_uris", "play_context",
    ]);
    const search = registry.get("spotify_search")!.schema;
    // kind/limit/offset are zod unions/defaults; the converter emits plain schemas.
    expect(search.properties).toHaveProperty("query");
    expect(search.properties).toHaveProperty("kind");
    expect(search.properties).toHaveProperty("limit");
    expect(search.properties).toHaveProperty("offset");
  });

  it("playback schema exposes devices, uris and repeat modes", () => {
    const playback = registry.get("spotify_playback")!.schema;
    const repeatMode = playback.properties?.repeat_mode as { enum?: string[] } | undefined;
    expect(repeatMode?.enum).toEqual(["track", "context", "off"]);
    expect(playback.properties).toHaveProperty("device_id");
    expect(playback.properties).toHaveProperty("uris");
    expect(playback.properties).toHaveProperty("context_uri");
  });
});

describe("spotify validation errors (no network)", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("requires an authenticated context", async () => {
    const res = await registry.dispatch("spotify_search", { query: "daft punk" }, { env: {} });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("Spotify authentication required");
  });

  it("playback seek requires position_ms", async () => {
    const res = await registry.dispatch("spotify_playback", { action: "seek" }, authedCtx);
    expect(res.isError).toBe(true);
    expect(res.content).toBe("position_ms is required for seek");
  });

  it("playback volume requires volume_percent", async () => {
    const res = await registry.dispatch("spotify_playback", { action: "volume" }, authedCtx);
    expect(res.isError).toBe(true);
    expect(res.content).toBe("volume_percent is required for volume");
  });

  it("playback transfer requires device_id", async () => {
    const res = await registry.dispatch("spotify_playback", { action: "transfer" }, authedCtx);
    expect(res.isError).toBe(true);
    expect(res.content).toBe("device_id is required for transfer");
  });

  it("playback play_context requires context_uri", async () => {
    const res = await registry.dispatch("spotify_playback", { action: "play_context" }, authedCtx);
    expect(res.isError).toBe(true);
    expect(res.content).toBe("context_uri is required for play_context");
  });

  it("playback rejects unknown actions", async () => {
    const res = await registry.dispatch("spotify_playback", { action: "teleport" }, authedCtx);
    expect(res.isError).toBe(true);
    expect(res.content).toBe("Unknown playback action: teleport");
  });

  it("queue clear is unsupported by the API", async () => {
    const res = await registry.dispatch("spotify_queue", { action: "clear" }, authedCtx);
    expect(res.isError).toBe(true);
    expect(res.content).toContain("does not support clearing the queue");
  });

  it("queue add requires uri", async () => {
    const res = await registry.dispatch("spotify_queue", { action: "add" }, authedCtx);
    expect(res.isError).toBe(true);
    expect(res.content).toBe("uri is required to add to queue");
  });

  it("playlist create defers to the UI", async () => {
    const res = await registry.dispatch("spotify_playlists", { action: "create", name: "x" }, authedCtx);
    expect(res.isError).toBe(true);
    expect(res.content).toContain("Use the spotify_web UI");
  });

  it("playlist tracks requires playlist_id", async () => {
    const res = await registry.dispatch("spotify_playlists", { action: "tracks" }, authedCtx);
    expect(res.isError).toBe(true);
    expect(res.content).toBe("playlist_id is required for tracks");
  });

  it("albums get requires album_id", async () => {
    const res = await registry.dispatch("spotify_albums", { action: "get" }, authedCtx);
    expect(res.isError).toBe(true);
    expect(res.content).toBe("album_id is required for get");
  });

  it("library save_tracks requires ids", async () => {
    const res = await registry.dispatch("spotify_library", { action: "save_tracks" }, authedCtx);
    expect(res.isError).toBe(true);
    expect(res.content).toBe("ids are required for save_tracks");
  });

  it("library contains requires ids", async () => {
    const res = await registry.dispatch("spotify_library", { action: "contains" }, authedCtx);
    expect(res.isError).toBe(true);
    expect(res.content).toBe("ids are required for contains");
  });
});

describe("spotify happy paths with mocked HTTP", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("search returns parsed results", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ tracks: { items: [{ id: "t1", name: "One More Time" }] } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await registry.dispatch(
      "spotify_search",
      { query: "daft punk", kind: "track", limit: 5 },
      authedCtx,
    );
    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse(res.content);
    expect(parsed.tracks.items).toHaveLength(1);
    expect(parsed.tracks.items[0].name).toBe("One More Time");

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/search");
    expect(String(url)).toContain("q=daft+punk");
    expect(String(url)).toContain("type=track");
    expect(String(url)).toContain("limit=5");
    expect(init?.headers).toMatchObject({ Authorization: "Bearer test-token" });
  });

  it("devices lists devices", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ devices: [{ id: "d1", name: "Mac" }] })));
    const res = await registry.dispatch("spotify_devices", {}, authedCtx);
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(res.content).devices).toHaveLength(1);
  });

  it("playback play succeeds against the API", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({}, 204)));
    const res = await registry.dispatch("spotify_playback", { action: "play" }, authedCtx);
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(res.content)).toEqual({ action: "play", status: "ok" });
  });

  it("surfaces API errors as tool errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ error: { message: "expired" } }, 401)));
    const res = await registry.dispatch("spotify_search", { query: "x" }, authedCtx);
    expect(res.isError).toBe(true);
    // The client attempts a token refresh before surfacing the auth error.
    expect(res.content).toMatch(/refresh token|authentication/i);
  });
});
