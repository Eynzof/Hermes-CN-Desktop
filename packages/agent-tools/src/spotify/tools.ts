import type {
  SpotifyAlbumsInput,
  SpotifyDevicesInput,
  SpotifyLibraryInput,
  SpotifyPlaybackInput,
  SpotifyPlaylistsInput,
  SpotifyQueueInput,
  SpotifySearchInput,
  SpotifyTokenState,
} from "@hermes/protocol";
import { SpotifyClient } from "./client.js";
import { SpotifyAuthManager, getCredentialProvider } from "./auth.js";
import { SpotifyAuthRequiredError } from "./errors.js";
import { compactJson, normalizeSpotifyId, normalizeSpotifyUris } from "./normalize.js";
import type { SpotifyToolContext } from "./types.js";
import type { ToolResult } from "../types.js";

function asBool(value: unknown): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Boolean(value);
  if (typeof value === "string") {
    const lower = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(lower)) return true;
    if (["false", "0", "no", "off"].includes(lower)) return false;
  }
  return undefined;
}

function asList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (value === undefined || value === null) return [];
  return String(value)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function clampLimit(value: number | undefined, min: number, max: number, fallback: number): number {
  if (value === undefined || Number.isNaN(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function toolError(message: string): ToolResult {
  return { content: message, isError: true };
}

function toolSuccess(value: unknown): ToolResult {
  return { content: compactJson(value) };
}

async function getTokenState(ctx: SpotifyToolContext): Promise<SpotifyTokenState> {
  if (ctx.spotify?.getState) {
    const state = await ctx.spotify.getState();
    if (state) return state;
  }
  const provider = getCredentialProvider();
  if (provider) {
    const state = await provider.getState();
    if (state) return state;
  }
  const env = ctx.env ?? {};
  if (env.spotify_access_token && env.spotify_client_id) {
    return {
      client_id: env.spotify_client_id,
      redirect_uri: env.spotify_redirect_uri ?? "http://127.0.0.1:43827/spotify/callback",
      api_base_url: env.spotify_api_base_url ?? "https://api.spotify.com/v1",
      accounts_base_url: env.spotify_accounts_base_url ?? "https://accounts.spotify.com",
      scope: env.spotify_scope ?? "",
      access_token: env.spotify_access_token,
      refresh_token: env.spotify_refresh_token ?? "",
      token_type: (env.spotify_token_type as "Bearer") ?? "Bearer",
      expires_at: env.spotify_expires_at ?? new Date(Date.now() + 3600_000).toISOString(),
      expires_in: 3600,
      obtained_at: new Date().toISOString(),
      auth_type: "oauth_pkce",
    };
  }
  throw new SpotifyAuthRequiredError();
}

async function makeClient(ctx: SpotifyToolContext): Promise<SpotifyClient> {
  const state = await getTokenState(ctx);
  const provider = getCredentialProvider();
  const manager = new SpotifyAuthManager(state, async (newState) => {
    if (ctx.spotify?.saveState) {
      await ctx.spotify.saveState(newState);
    } else if (provider) {
      await provider.saveState(newState);
    }
  });

  return new SpotifyClient({
    tokenState: state,
    refreshToken: async () => {
      const result = await manager.refresh();
      await ctx.spotify?.saveState?.(result.state);
      return result.state;
    },
  });
}

export async function spotifyPlayback(args: unknown, ctx: SpotifyToolContext): Promise<ToolResult> {
  const a = args as SpotifyPlaybackInput;
  try {
    const client = await makeClient(ctx);
    const deviceId = a.device_id;

    switch (a.action) {
      case "play":
        await client.play(deviceId);
        return toolSuccess({ action: a.action, status: "ok" });
      case "pause":
        await client.pause(deviceId);
        return toolSuccess({ action: a.action, status: "ok" });
      case "toggle": {
        const state = await client.getPlaybackState();
        if ("is_playing" in state && state.is_playing) {
          await client.pause(deviceId);
        } else {
          await client.play(deviceId);
        }
        return toolSuccess({ action: a.action, status: "ok" });
      }
      case "next":
        await client.next(deviceId);
        return toolSuccess({ action: a.action, status: "ok" });
      case "previous":
        await client.previous(deviceId);
        return toolSuccess({ action: a.action, status: "ok" });
      case "seek": {
        if (a.position_ms === undefined) return toolError("position_ms is required for seek");
        await client.seek(a.position_ms, deviceId);
        return toolSuccess({ action: a.action, position_ms: a.position_ms, status: "ok" });
      }
      case "volume": {
        if (a.volume_percent === undefined) return toolError("volume_percent is required for volume");
        await client.volume(a.volume_percent, deviceId);
        return toolSuccess({ action: a.action, volume_percent: a.volume_percent, status: "ok" });
      }
      case "transfer": {
        if (!deviceId) return toolError("device_id is required for transfer");
        await client.transferPlayback(deviceId, true);
        return toolSuccess({ action: a.action, device_id: deviceId, status: "ok" });
      }
      case "shuffle": {
        const shuffleState = asBool(a.state);
        if (shuffleState === undefined) return toolError("state is required for shuffle");
        await client.setShuffle(shuffleState, deviceId);
        return toolSuccess({ action: a.action, state: shuffleState, status: "ok" });
      }
      case "repeat": {
        const repeatMode = a.repeat_mode ?? "off";
        await client.setRepeat(repeatMode, deviceId);
        return toolSuccess({ action: a.action, repeat_mode: repeatMode, status: "ok" });
      }
      case "play_uris": {
        const uris = normalizeSpotifyUris(a.uris, "track");
        await client.play(deviceId, uris, undefined, a.offset, a.position_ms);
        return toolSuccess({ action: a.action, uris, status: "ok" });
      }
      case "play_context": {
        if (!a.context_uri) return toolError("context_uri is required for play_context");
        const contextUri = normalizeSpotifyUris([a.context_uri])[0];
        await client.play(deviceId, undefined, contextUri, a.offset, a.position_ms);
        return toolSuccess({ action: a.action, context_uri: contextUri, status: "ok" });
      }
      default:
        return toolError(`Unknown playback action: ${String(a.action)}`);
    }
  } catch (err) {
    return toolError(err instanceof Error ? err.message : String(err));
  }
}

export async function spotifyDevices(args: unknown, ctx: SpotifyToolContext): Promise<ToolResult> {
  const a = args as SpotifyDevicesInput;
  try {
    const client = await makeClient(ctx);
    if (a.device_id) {
      await client.transferPlayback(a.device_id, true);
      return toolSuccess({ transferred_to: a.device_id, status: "ok" });
    }
    const devices = await client.getDevices();
    return toolSuccess(devices);
  } catch (err) {
    return toolError(err instanceof Error ? err.message : String(err));
  }
}

export async function spotifyQueue(args: unknown, ctx: SpotifyToolContext): Promise<ToolResult> {
  const a = args as SpotifyQueueInput;
  try {
    const client = await makeClient(ctx);
    switch (a.action) {
      case "get": {
        const queue = await client.getQueue();
        return toolSuccess(queue);
      }
      case "add": {
        if (!a.uri) return toolError("uri is required to add to queue");
        await client.addToQueue(a.uri);
        return toolSuccess({ added: a.uri, status: "ok" });
      }
      case "clear":
        return toolError("Spotify Web API does not support clearing the queue directly.");
      default:
        return toolError(`Unknown queue action: ${String(a.action)}`);
    }
  } catch (err) {
    return toolError(err instanceof Error ? err.message : String(err));
  }
}

export async function spotifySearch(args: unknown, ctx: SpotifyToolContext): Promise<ToolResult> {
  const a = args as SpotifySearchInput;
  try {
    const client = await makeClient(ctx);
    const kinds = Array.isArray(a.kind) ? a.kind : [a.kind ?? "track"];
    const results = await client.search(
      a.query,
      kinds as string[],
      clampLimit(a.limit, 1, 50, 10),
      a.offset ?? 0,
      a.market,
    );
    return toolSuccess(results);
  } catch (err) {
    return toolError(err instanceof Error ? err.message : String(err));
  }
}

export async function spotifyPlaylists(args: unknown, ctx: SpotifyToolContext): Promise<ToolResult> {
  const a = args as SpotifyPlaylistsInput;
  try {
    const client = await makeClient(ctx);
    switch (a.action) {
      case "list": {
        const playlists = await client.getMyPlaylists(
          clampLimit(a.limit, 1, 50, 20),
          a.offset ?? 0,
        );
        return toolSuccess(playlists);
      }
      case "tracks": {
        if (!a.playlist_id) return toolError("playlist_id is required for tracks");
        const tracks = await client.getPlaylistTracks(
          a.playlist_id,
          clampLimit(a.limit, 1, 50, 20),
          a.offset ?? 0,
        );
        return toolSuccess(tracks);
      }
      case "create": {
        if (!a.name) return toolError("name is required to create a playlist");
        // Creating a playlist requires the current user's id; we do not expose a
        // separate me endpoint, so report a clear error.
        return toolError(
          "Creating a playlist requires the current Spotify user id. Use the spotify_web UI or supply a playlist_id target.",
        );
      }
      case "add_items": {
        if (!a.playlist_id) return toolError("playlist_id is required for add_items");
        const uris = asList(a.uris);
        if (!uris.length) return toolError("uris are required for add_items");
        await client.addTracksToPlaylist(a.playlist_id, uris);
        return toolSuccess({ added: uris.length, status: "ok" });
      }
      case "remove_items": {
        if (!a.playlist_id) return toolError("playlist_id is required for remove_items");
        const uris = asList(a.uris);
        if (!uris.length) return toolError("uris are required for remove_items");
        await client.removeTracksFromPlaylist(a.playlist_id, uris);
        return toolSuccess({ removed: uris.length, status: "ok" });
      }
      default:
        return toolError(`Unknown playlist action: ${String(a.action)}`);
    }
  } catch (err) {
    return toolError(err instanceof Error ? err.message : String(err));
  }
}

export async function spotifyAlbums(args: unknown, ctx: SpotifyToolContext): Promise<ToolResult> {
  const a = args as SpotifyAlbumsInput;
  try {
    const client = await makeClient(ctx);
    switch (a.action) {
      case "get": {
        if (!a.album_id) return toolError("album_id is required for get");
        const album = await client.getAlbum(a.album_id, a.market);
        return toolSuccess(album);
      }
      case "tracks": {
        if (!a.album_id) return toolError("album_id is required for tracks");
        const tracks = await client.getAlbumTracks(
          a.album_id,
          clampLimit(a.limit, 1, 50, 20),
          a.offset ?? 0,
          a.market,
        );
        return toolSuccess(tracks);
      }
      case "saved": {
        const albums = await client.getSavedAlbums(
          clampLimit(a.limit, 1, 50, 20),
          a.offset ?? 0,
          a.market,
        );
        return toolSuccess(albums);
      }
      default:
        return toolError(`Unknown album action: ${String(a.action)}`);
    }
  } catch (err) {
    return toolError(err instanceof Error ? err.message : String(err));
  }
}

export async function spotifyLibrary(args: unknown, ctx: SpotifyToolContext): Promise<ToolResult> {
  const a = args as SpotifyLibraryInput;
  try {
    const client = await makeClient(ctx);
    switch (a.action) {
      case "saved_tracks": {
        const tracks = await client.getSavedTracks(
          clampLimit(a.limit, 1, 50, 20),
          a.offset ?? 0,
          a.market,
        );
        return toolSuccess(tracks);
      }
      case "save_tracks": {
        const ids = asList(a.ids);
        if (!ids.length) return toolError("ids are required for save_tracks");
        await client.saveTracks(ids);
        return toolSuccess({ saved: ids.length, status: "ok" });
      }
      case "remove_tracks": {
        const ids = asList(a.ids);
        if (!ids.length) return toolError("ids are required for remove_tracks");
        await client.removeSavedTracks(ids);
        return toolSuccess({ removed: ids.length, status: "ok" });
      }
      case "contains": {
        const ids = asList(a.ids);
        if (!ids.length) return toolError("ids are required for contains");
        const contains = await client.containsSavedTracks(ids);
        return toolSuccess(ids.map((id, i) => ({ id, saved: contains[i] ?? false })));
      }
      default:
        return toolError(`Unknown library action: ${String(a.action)}`);
    }
  } catch (err) {
    return toolError(err instanceof Error ? err.message : String(err));
  }
}
