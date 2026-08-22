import type {
  SpotifyAlbum,
  SpotifyAlbumTracksResponse,
  SpotifyDevice,
  SpotifyDevicesResponse,
  SpotifyPlaybackState,
  SpotifyPlaylist,
  SpotifyPlaylistTracksResponse,
  SpotifyQueueResponse,
  SpotifySavedTracksResponse,
  SpotifySearchResponse,
  SpotifyTokenState,
  SpotifyUserPlaylistsResponse,
} from "@hermes/protocol";
import {
  friendlySpotifyErrorMessage,
  SpotifyApiError,
  SpotifyAuthRequiredError,
  SpotifyError,
} from "./errors.js";
import { normalizeSpotifyId, normalizeSpotifyUri, normalizeSpotifyUris } from "./normalize.js";
import type { FetchLike } from "./auth.js";

export interface SpotifyClientOptions {
  tokenState: SpotifyTokenState;
  refreshToken: () => Promise<SpotifyTokenState>;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

interface RequestOptions {
  params?: Record<string, string | number | boolean | undefined>;
  jsonBody?: unknown;
  allowRetryOn401?: boolean;
  emptyResponse?: boolean;
  headers?: Record<string, string>;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export class SpotifyClient {
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(private readonly opts: SpotifyClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? ((url, init) => fetch(url, init));
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private apiBase(): string {
    return this.opts.tokenState.api_base_url || "https://api.spotify.com/v1";
  }

  private bearer(): string {
    return `Bearer ${this.opts.tokenState.access_token}`;
  }

  async request(
    method: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<unknown> {
    const url = new URL(path, this.apiBase());
    if (options.params) {
      for (const [key, value] of Object.entries(options.params)) {
        if (value === undefined || value === null) continue;
        url.searchParams.set(key, String(value));
      }
    }

    const init: RequestInit = {
      method,
      headers: {
        Authorization: this.bearer(),
        "Content-Type": "application/json",
        ...(options.headers ?? {}),
      },
      signal: AbortSignal.timeout(this.timeoutMs),
    };

    if (options.jsonBody !== undefined && method !== "GET") {
      init.body = JSON.stringify(options.jsonBody);
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url.toString(), init);
    } catch (err) {
      throw new SpotifyError(`Request to Spotify failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (response.status === 204) {
      if (options.emptyResponse) {
        return { status_code: 204, empty: true, message: "No content ( playback likely paused or nothing playing )." };
      }
      return {};
    }

    if (response.status === 401 && options.allowRetryOn401 !== false) {
      const refreshed = await this.opts.refreshToken();
      return new SpotifyClient({ ...this.opts, tokenState: refreshed }).request(method, path, {
        ...options,
        allowRetryOn401: false,
      });
    }

    let body: unknown;
    const text = await response.text();
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }

    if (!response.ok) {
      const message = friendlySpotifyErrorMessage(response.status, body);
      if (response.status === 401) {
        throw new SpotifyAuthRequiredError(message);
      }
      throw new SpotifyApiError(message, response.status, body);
    }

    return body ?? {};
  }

  // -----------------------------------------------------------------------
  // Devices
  // -----------------------------------------------------------------------

  async getDevices(): Promise<SpotifyDevicesResponse> {
    return (await this.request("GET", "/me/player/devices")) as SpotifyDevicesResponse;
  }

  async transferPlayback(deviceId: string, play = false): Promise<void> {
    await this.request("PUT", "/me/player", {
      jsonBody: { device_ids: [deviceId], play },
    });
  }

  // -----------------------------------------------------------------------
  // Playback
  // -----------------------------------------------------------------------

  async getPlaybackState(): Promise<SpotifyPlaybackState | { status_code: number; empty: boolean; message: string }> {
    return await this.request("GET", "/me/player", { emptyResponse: true }) as SpotifyPlaybackState | {
      status_code: number;
      empty: boolean;
      message: string;
    };
  }

  async getCurrentlyPlaying(): Promise<SpotifyPlaybackState | { status_code: number; empty: boolean; message: string }> {
    return await this.request("GET", "/me/player/currently-playing", { emptyResponse: true }) as SpotifyPlaybackState | {
      status_code: number;
      empty: boolean;
      message: string;
    };
  }

  async pause(deviceId?: string): Promise<void> {
    await this.request("PUT", "/me/player/pause", { params: deviceId ? { device_id: deviceId } : undefined });
  }

  async play(deviceId?: string, uris?: string[], contextUri?: string, offset?: string | number, positionMs?: number): Promise<void> {
    const jsonBody: Record<string, unknown> = {};
    if (uris?.length) jsonBody.uris = uris;
    if (contextUri) jsonBody.context_uri = contextUri;
    if (offset !== undefined) {
      if (typeof offset === "string" && offset.startsWith("spotify:")) {
        jsonBody.offset = { uri: offset };
      } else {
        jsonBody.offset = { position: Number(offset) };
      }
    }
    if (positionMs !== undefined) jsonBody.position_ms = positionMs;
    await this.request("PUT", "/me/player/play", {
      params: deviceId ? { device_id: deviceId } : undefined,
      jsonBody: Object.keys(jsonBody).length ? jsonBody : undefined,
    });
  }

  async next(deviceId?: string): Promise<void> {
    await this.request("POST", "/me/player/next", { params: deviceId ? { device_id: deviceId } : undefined });
  }

  async previous(deviceId?: string): Promise<void> {
    await this.request("POST", "/me/player/previous", { params: deviceId ? { device_id: deviceId } : undefined });
  }

  async seek(positionMs: number, deviceId?: string): Promise<void> {
    await this.request("PUT", "/me/player/seek", {
      params: { position_ms: positionMs, ...(deviceId ? { device_id: deviceId } : {}) },
    });
  }

  async volume(volumePercent: number, deviceId?: string): Promise<void> {
    await this.request("PUT", "/me/player/volume", {
      params: { volume_percent: volumePercent, ...(deviceId ? { device_id: deviceId } : {}) },
    });
  }

  async setShuffle(state: boolean, deviceId?: string): Promise<void> {
    await this.request("PUT", "/me/player/shuffle", {
      params: { state, ...(deviceId ? { device_id: deviceId } : {}) },
    });
  }

  async setRepeat(state: "track" | "context" | "off", deviceId?: string): Promise<void> {
    await this.request("PUT", "/me/player/repeat", {
      params: { state, ...(deviceId ? { device_id: deviceId } : {}) },
    });
  }

  // -----------------------------------------------------------------------
  // Queue
  // -----------------------------------------------------------------------

  async getQueue(): Promise<SpotifyQueueResponse> {
    return (await this.request("GET", "/me/player/queue")) as SpotifyQueueResponse;
  }

  async addToQueue(uri: string, deviceId?: string): Promise<void> {
    const normalized = normalizeSpotifyUri(uri, "track");
    await this.request("POST", "/me/player/queue", {
      params: { uri: normalized, ...(deviceId ? { device_id: deviceId } : {}) },
    });
  }

  // -----------------------------------------------------------------------
  // Search
  // -----------------------------------------------------------------------

  async search(
    query: string,
    kinds: string[],
    limit = 10,
    offset = 0,
    market?: string,
  ): Promise<SpotifySearchResponse> {
    return (await this.request("GET", "/search", {
      params: {
        q: query,
        type: kinds.join(","),
        limit,
        offset,
        market: market ?? "from_token",
      },
    })) as SpotifySearchResponse;
  }

  // -----------------------------------------------------------------------
  // Playlists
  // -----------------------------------------------------------------------

  async getMyPlaylists(limit = 20, offset = 0): Promise<SpotifyUserPlaylistsResponse> {
    return (await this.request("GET", "/me/playlists", { params: { limit, offset } })) as SpotifyUserPlaylistsResponse;
  }

  async getPlaylist(playlistId: string, market?: string): Promise<SpotifyPlaylist> {
    const id = normalizeSpotifyId(playlistId, "playlist");
    return (await this.request("GET", `/playlists/${id}`, { params: market ? { market } : undefined })) as SpotifyPlaylist;
  }

  async getPlaylistTracks(playlistId: string, limit = 20, offset = 0, market?: string): Promise<SpotifyPlaylistTracksResponse> {
    const id = normalizeSpotifyId(playlistId, "playlist");
    return (await this.request("GET", `/playlists/${id}/tracks`, {
      params: { limit, offset, ...(market ? { market } : {}) },
    })) as SpotifyPlaylistTracksResponse;
  }

  async createPlaylist(userId: string, name: string, description?: string, isPublic?: boolean): Promise<SpotifyPlaylist> {
    return (await this.request("POST", `/users/${userId}/playlists`, {
      jsonBody: {
        name,
        description,
        public: isPublic ?? true,
      },
    })) as SpotifyPlaylist;
  }

  async addTracksToPlaylist(playlistId: string, uris: string[]): Promise<void> {
    const id = normalizeSpotifyId(playlistId, "playlist");
    const normalized = normalizeSpotifyUris(uris, "track");
    await this.request("POST", `/playlists/${id}/tracks`, { jsonBody: { uris: normalized } });
  }

  async removeTracksFromPlaylist(playlistId: string, uris: string[]): Promise<void> {
    const id = normalizeSpotifyId(playlistId, "playlist");
    const normalized = normalizeSpotifyUris(uris, "track");
    await this.request("DELETE", `/playlists/${id}/tracks`, {
      jsonBody: { tracks: normalized.map((uri) => ({ uri })) },
    });
  }

  // -----------------------------------------------------------------------
  // Albums
  // -----------------------------------------------------------------------

  async getAlbum(albumId: string, market?: string): Promise<SpotifyAlbum> {
    const id = normalizeSpotifyId(albumId, "album");
    return (await this.request("GET", `/albums/${id}`, { params: market ? { market } : undefined })) as SpotifyAlbum;
  }

  async getAlbumTracks(albumId: string, limit = 20, offset = 0, market?: string): Promise<SpotifyAlbumTracksResponse> {
    const id = normalizeSpotifyId(albumId, "album");
    return (await this.request("GET", `/albums/${id}/tracks`, {
      params: { limit, offset, ...(market ? { market } : {}) },
    })) as SpotifyAlbumTracksResponse;
  }

  async getSavedAlbums(limit = 20, offset = 0, market?: string): Promise<unknown> {
    return await this.request("GET", "/me/albums", {
      params: { limit, offset, ...(market ? { market } : {}) },
    });
  }

  // -----------------------------------------------------------------------
  // Library
  // -----------------------------------------------------------------------

  async getSavedTracks(limit = 20, offset = 0, market?: string): Promise<SpotifySavedTracksResponse> {
    return (await this.request("GET", "/me/tracks", {
      params: { limit, offset, ...(market ? { market } : {}) },
    })) as SpotifySavedTracksResponse;
  }

  async saveTracks(ids: string[]): Promise<void> {
    const plainIds = ids.map((id) => normalizeSpotifyId(id, "track"));
    await this.request("PUT", "/me/tracks", { jsonBody: { ids: plainIds } });
  }

  async removeSavedTracks(ids: string[]): Promise<void> {
    const plainIds = ids.map((id) => normalizeSpotifyId(id, "track"));
    await this.request("DELETE", "/me/tracks", { jsonBody: { ids: plainIds } });
  }

  async containsSavedTracks(ids: string[]): Promise<boolean[]> {
    const plainIds = ids.map((id) => normalizeSpotifyId(id, "track"));
    return (await this.request("GET", "/me/tracks/contains", {
      params: { ids: plainIds.join(",") },
    })) as boolean[];
  }
}


