import { z } from "zod";

// ---------------------------------------------------------------------------
// Spotify token state — persisted in ~/.hermes/auth.json providers.spotify
// ---------------------------------------------------------------------------

export const SpotifyLastAuthError = z.object({
  error: z.string(),
  error_description: z.string().optional(),
  timestamp: z.string(),
});
export type SpotifyLastAuthError = z.infer<typeof SpotifyLastAuthError>;

export const SpotifyTokenState = z.object({
  client_id: z.string(),
  redirect_uri: z.string(),
  api_base_url: z.string().default("https://api.spotify.com/v1"),
  accounts_base_url: z.string().default("https://accounts.spotify.com"),
  scope: z.string(),
  granted_scope: z.string().optional(),
  access_token: z.string(),
  refresh_token: z.string(),
  token_type: z.literal("Bearer"),
  expires_at: z.string(),
  expires_in: z.number(),
  obtained_at: z.string(),
  auth_type: z.literal("oauth_pkce"),
  last_auth_error: SpotifyLastAuthError.optional(),
});
export type SpotifyTokenState = z.infer<typeof SpotifyTokenState>;

export const SpotifyAuthJson = z.object({
  providers: z.object({
    spotify: SpotifyTokenState.optional(),
  }).passthrough().optional(),
}).passthrough();
export type SpotifyAuthJson = z.infer<typeof SpotifyAuthJson>;

// ---------------------------------------------------------------------------
// Spotify API response shapes
// ---------------------------------------------------------------------------

export const SpotifyDevice = z.object({
  id: z.string().optional(),
  is_active: z.boolean().optional(),
  is_private_session: z.boolean().optional(),
  is_restricted: z.boolean().optional(),
  name: z.string(),
  type: z.string(),
  volume_percent: z.number().optional(),
}).passthrough();
export type SpotifyDevice = z.infer<typeof SpotifyDevice>;

export const SpotifyDevicesResponse = z.object({
  devices: z.array(SpotifyDevice),
}).passthrough();
export type SpotifyDevicesResponse = z.infer<typeof SpotifyDevicesResponse>;

export const SpotifyContext = z.object({
  type: z.string(),
  uri: z.string(),
}).passthrough();
export type SpotifyContext = z.infer<typeof SpotifyContext>;

export const SpotifyPlaybackState = z.object({
  device: SpotifyDevice.optional(),
  shuffle_state: z.boolean().optional(),
  repeat_state: z.string().optional(),
  timestamp: z.number().optional(),
  context: SpotifyContext.nullable().optional(),
  progress_ms: z.number().optional(),
  item: z.unknown().nullable().optional(),
  currently_playing_type: z.string().optional(),
  is_playing: z.boolean().optional(),
}).passthrough();
export type SpotifyPlaybackState = z.infer<typeof SpotifyPlaybackState>;

export const SpotifyQueueResponse = z.object({
  currently_playing: z.unknown().nullable().optional(),
  queue: z.array(z.unknown()).optional(),
}).passthrough();
export type SpotifyQueueResponse = z.infer<typeof SpotifyQueueResponse>;

export const SpotifyPlaylist = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable().optional(),
  uri: z.string(),
  owner: z.unknown().optional(),
  tracks: z.object({ total: z.number() }).passthrough().optional(),
}).passthrough();
export type SpotifyPlaylist = z.infer<typeof SpotifyPlaylist>;

export const SpotifyAlbum = z.object({
  id: z.string(),
  name: z.string(),
  album_type: z.string().optional(),
  total_tracks: z.number().optional(),
  uri: z.string(),
  artists: z.array(z.unknown()).optional(),
}).passthrough();
export type SpotifyAlbum = z.infer<typeof SpotifyAlbum>;

export const SpotifyTrack = z.object({
  id: z.string(),
  name: z.string(),
  uri: z.string(),
  artists: z.array(z.object({ name: z.string() }).passthrough()).optional(),
  album: z.object({ name: z.string() }).passthrough().optional(),
}).passthrough();
export type SpotifyTrack = z.infer<typeof SpotifyTrack>;

export const SpotifySearchResponse = z.object({
  tracks: z.object({ items: z.array(SpotifyTrack) }).passthrough().optional(),
  albums: z.object({ items: z.array(SpotifyAlbum) }).passthrough().optional(),
  artists: z.object({ items: z.array(z.unknown()) }).passthrough().optional(),
  playlists: z.object({ items: z.array(SpotifyPlaylist) }).passthrough().optional(),
}).passthrough();
export type SpotifySearchResponse = z.infer<typeof SpotifySearchResponse>;

export const SpotifySavedTracksResponse = z.object({
  items: z.array(z.object({ track: SpotifyTrack.optional() }).passthrough()).optional(),
  total: z.number().optional(),
  limit: z.number().optional(),
  offset: z.number().optional(),
}).passthrough();
export type SpotifySavedTracksResponse = z.infer<typeof SpotifySavedTracksResponse>;

export const SpotifyUserPlaylistsResponse = z.object({
  items: z.array(SpotifyPlaylist).optional(),
  total: z.number().optional(),
  limit: z.number().optional(),
  offset: z.number().optional(),
}).passthrough();
export type SpotifyUserPlaylistsResponse = z.infer<typeof SpotifyUserPlaylistsResponse>;

export const SpotifyAlbumTracksResponse = z.object({
  items: z.array(SpotifyTrack).optional(),
  total: z.number().optional(),
  limit: z.number().optional(),
  offset: z.number().optional(),
}).passthrough();
export type SpotifyAlbumTracksResponse = z.infer<typeof SpotifyAlbumTracksResponse>;

export const SpotifyPlaylistTracksResponse = z.object({
  items: z.array(z.object({ track: SpotifyTrack.optional() }).passthrough()).optional(),
  total: z.number().optional(),
  limit: z.number().optional(),
  offset: z.number().optional(),
}).passthrough();
export type SpotifyPlaylistTracksResponse = z.infer<typeof SpotifyPlaylistTracksResponse>;

// ---------------------------------------------------------------------------
// OAuth exchange / refresh payloads
// ---------------------------------------------------------------------------

export const SpotifyTokenResponse = z.object({
  access_token: z.string(),
  token_type: z.literal("Bearer"),
  scope: z.string(),
  expires_in: z.number(),
  refresh_token: z.string().optional(),
}).passthrough();
export type SpotifyTokenResponse = z.infer<typeof SpotifyTokenResponse>;

export const SpotifyAuthUrlInput = z.object({
  clientId: z.string(),
  redirectUri: z.string(),
  accountsBaseUrl: z.string().optional(),
  scope: z.string().optional(),
});
export type SpotifyAuthUrlInput = z.infer<typeof SpotifyAuthUrlInput>;

export const SpotifyAuthUrlResult = z.object({
  authUrl: z.string(),
  codeVerifier: z.string(),
  state: z.string(),
});
export type SpotifyAuthUrlResult = z.infer<typeof SpotifyAuthUrlResult>;

export const SpotifyExchangeInput = z.object({
  clientId: z.string(),
  redirectUri: z.string(),
  code: z.string(),
  codeVerifier: z.string(),
  accountsBaseUrl: z.string().optional(),
});
export type SpotifyExchangeInput = z.infer<typeof SpotifyExchangeInput>;

export const SpotifyRefreshInput = z.object({
  clientId: z.string(),
  refreshToken: z.string(),
  accountsBaseUrl: z.string().optional(),
});
export type SpotifyRefreshInput = z.infer<typeof SpotifyRefreshInput>;

// ---------------------------------------------------------------------------
// Tool I/O schemas
// ---------------------------------------------------------------------------

export const SpotifyPlaybackAction = z.enum([
  "play",
  "pause",
  "toggle",
  "next",
  "previous",
  "seek",
  "volume",
  "transfer",
  "shuffle",
  "repeat",
  "play_uris",
  "play_context",
]);
export type SpotifyPlaybackAction = z.infer<typeof SpotifyPlaybackAction>;

export const SpotifySearchKind = z.enum(["track", "album", "artist", "playlist", "show", "episode"]);
export type SpotifySearchKind = z.infer<typeof SpotifySearchKind>;

export const SpotifyLibraryAction = z.enum(["saved_tracks", "saved_albums", "contains", "save_tracks", "remove_tracks"]);
export type SpotifyLibraryAction = z.infer<typeof SpotifyLibraryAction>;

export const SpotifyPlaybackInput = z.object({
  action: SpotifyPlaybackAction.describe("Playback action to perform"),
  device_id: z.string().optional().describe("Target device id"),
  uris: z.union([z.string(), z.array(z.string())]).optional().describe("Track URIs to play"),
  context_uri: z.string().optional().describe("Album/playlist/artist URI to play"),
  offset: z.union([z.string(), z.number()]).optional().describe("Offset URI or zero-based position"),
  position_ms: z.number().optional().describe("Position in milliseconds"),
  volume_percent: z.number().optional().describe("Volume 0-100"),
  state: z.boolean().optional().describe("For shuffle/repeat"),
  repeat_mode: z.enum(["track", "context", "off"]).optional().describe("Repeat mode"),
});
export type SpotifyPlaybackInput = z.infer<typeof SpotifyPlaybackInput>;

export const SpotifyDevicesInput = z.object({
  device_id: z.string().optional().describe("Device id to transfer playback to"),
});
export type SpotifyDevicesInput = z.infer<typeof SpotifyDevicesInput>;

export const SpotifyQueueInput = z.object({
  action: z.enum(["get", "add", "clear"]).default("get").describe("Queue action"),
  uri: z.string().optional().describe("Track URI to add to queue"),
});
export type SpotifyQueueInput = z.infer<typeof SpotifyQueueInput>;

export const SpotifySearchInput = z.object({
  query: z.string().describe("Search query"),
  kind: z.union([SpotifySearchKind, z.array(SpotifySearchKind)]).default("track").describe("Entity kind(s) to search"),
  limit: z.number().min(1).max(50).default(10).describe("Max results per kind"),
  offset: z.number().default(0).describe("Result offset"),
  market: z.string().optional().describe("Market code (default from_token)"),
});
export type SpotifySearchInput = z.infer<typeof SpotifySearchInput>;

export const SpotifyPlaylistsInput = z.object({
  action: z.enum(["list", "tracks", "create", "add_items", "remove_items"]).default("list").describe("Playlist action"),
  playlist_id: z.string().optional().describe("Playlist id or URI"),
  name: z.string().optional().describe("Name for create"),
  description: z.string().optional().describe("Description for create"),
  public_: z.boolean().optional().describe("Public playlist flag"),
  uris: z.union([z.string(), z.array(z.string())]).optional().describe("Track URIs to add/remove"),
  limit: z.number().min(1).max(50).default(20).describe("Pagination limit"),
  offset: z.number().default(0).describe("Pagination offset"),
});
export type SpotifyPlaylistsInput = z.infer<typeof SpotifyPlaylistsInput>;

export const SpotifyAlbumsInput = z.object({
  action: z.enum(["get", "tracks", "saved"]).default("get").describe("Album action"),
  album_id: z.string().optional().describe("Album id or URI"),
  limit: z.number().min(1).max(50).default(20).describe("Pagination limit"),
  offset: z.number().default(0).describe("Pagination offset"),
  market: z.string().optional().describe("Market code"),
});
export type SpotifyAlbumsInput = z.infer<typeof SpotifyAlbumsInput>;

export const SpotifyLibraryInput = z.object({
  action: SpotifyLibraryAction.default("saved_tracks").describe("Library action"),
  ids: z.union([z.string(), z.array(z.string())]).optional().describe("Track/album ids or URIs"),
  limit: z.number().min(1).max(50).default(20).describe("Pagination limit"),
  offset: z.number().default(0).describe("Pagination offset"),
  market: z.string().optional().describe("Market code"),
});
export type SpotifyLibraryInput = z.infer<typeof SpotifyLibraryInput>;

// ---------------------------------------------------------------------------
// Rust command I/O
// ---------------------------------------------------------------------------

export const SpotifyCallbackStartInput = z.object({
  port: z.number().optional(),
  path: z.string().default("/spotify/callback"),
});
export type SpotifyCallbackStartInput = z.infer<typeof SpotifyCallbackStartInput>;

export const SpotifyCallbackStartResult = z.object({
  port: z.number(),
  redirectUri: z.string(),
});
export type SpotifyCallbackStartResult = z.infer<typeof SpotifyCallbackStartResult>;

export const SpotifyCallbackWaitResult = z.object({
  code: z.string(),
  state: z.string(),
}).passthrough();
export type SpotifyCallbackWaitResult = z.infer<typeof SpotifyCallbackWaitResult>;

export const SpotifyAuthJsonResult = z.object({
  ok: z.boolean(),
  provider: SpotifyTokenState.optional(),
  error: z.string().optional(),
});
export type SpotifyAuthJsonResult = z.infer<typeof SpotifyAuthJsonResult>;
