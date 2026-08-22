import { z } from "zod";
import { registry } from "../registry.js";
import { objectSchema } from "../catalog.js";
import {
  spotifyPlayback,
  spotifyDevices,
  spotifyQueue,
  spotifySearch,
  spotifyPlaylists,
  spotifyAlbums,
  spotifyLibrary,
} from "./tools.js";
import type { ToolEntry } from "../types.js";

export function registerSpotifyTools(): void {
  const tools: ToolEntry[] = [
    {
      name: "spotify_playback",
      toolset: "spotify",
      description:
        "Control Spotify playback: play, pause, toggle, next, previous, seek, volume, transfer, shuffle, repeat, play_uris, play_context.",
      emoji: "🎵",
      tags: ["spotify"],
      schema: objectSchema({
        action: z.enum([
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
        ]).describe("Playback action to perform"),
        device_id: z.string().optional().describe("Target device id"),
        uris: z.union([z.string(), z.array(z.string())]).optional().describe("Track URIs to play"),
        context_uri: z.string().optional().describe("Album/playlist/artist URI to play"),
        offset: z.union([z.string(), z.number()]).optional().describe("Offset URI or zero-based position"),
        position_ms: z.number().optional().describe("Position in milliseconds"),
        volume_percent: z.number().optional().describe("Volume 0-100"),
        state: z.boolean().optional().describe("For shuffle/repeat"),
        repeat_mode: z.enum(["track", "context", "off"]).optional().describe("Repeat mode"),
      }),
      handler: spotifyPlayback,
    },
    {
      name: "spotify_devices",
      toolset: "spotify",
      description: "List available Spotify devices or transfer playback to a device.",
      emoji: "📱",
      tags: ["spotify"],
      schema: objectSchema({
        device_id: z.string().optional().describe("Device id to transfer playback to"),
      }),
      handler: spotifyDevices,
    },
    {
      name: "spotify_queue",
      toolset: "spotify",
      description: "Get the Spotify queue or add a track to it.",
      emoji: "🎶",
      tags: ["spotify"],
      schema: objectSchema({
        action: z.enum(["get", "add", "clear"]).default("get").describe("Queue action"),
        uri: z.string().optional().describe("Track URI to add to queue"),
      }),
      handler: spotifyQueue,
    },
    {
      name: "spotify_search",
      toolset: "spotify",
      description: "Search Spotify for tracks, albums, artists, playlists, shows, or episodes.",
      emoji: "🔍",
      tags: ["spotify"],
      schema: objectSchema({
        query: z.string().describe("Search query"),
        kind: z.union([
          z.enum(["track", "album", "artist", "playlist", "show", "episode"]),
          z.array(z.enum(["track", "album", "artist", "playlist", "show", "episode"])),
        ]).default("track").describe("Entity kind(s) to search"),
        limit: z.number().min(1).max(50).default(10).describe("Max results per kind"),
        offset: z.number().default(0).describe("Result offset"),
        market: z.string().optional().describe("Market code (default from_token)"),
      }),
      handler: spotifySearch,
    },
    {
      name: "spotify_playlists",
      toolset: "spotify",
      description:
        "List current user's playlists, get playlist tracks, add or remove tracks. Create is supported via UI.",
      emoji: "📋",
      tags: ["spotify"],
      schema: objectSchema({
        action: z.enum(["list", "tracks", "create", "add_items", "remove_items"]).default("list").describe("Playlist action"),
        playlist_id: z.string().optional().describe("Playlist id or URI"),
        name: z.string().optional().describe("Name for create"),
        description: z.string().optional().describe("Description for create"),
        public_: z.boolean().optional().describe("Public playlist flag"),
        uris: z.union([z.string(), z.array(z.string())]).optional().describe("Track URIs to add/remove"),
        limit: z.number().min(1).max(50).default(20).describe("Pagination limit"),
        offset: z.number().default(0).describe("Pagination offset"),
      }),
      handler: spotifyPlaylists,
    },
    {
      name: "spotify_albums",
      toolset: "spotify",
      description: "Get an album, list album tracks, or list saved albums.",
      emoji: "💿",
      tags: ["spotify"],
      schema: objectSchema({
        action: z.enum(["get", "tracks", "saved"]).default("get").describe("Album action"),
        album_id: z.string().optional().describe("Album id or URI"),
        limit: z.number().min(1).max(50).default(20).describe("Pagination limit"),
        offset: z.number().default(0).describe("Pagination offset"),
        market: z.string().optional().describe("Market code"),
      }),
      handler: spotifyAlbums,
    },
    {
      name: "spotify_library",
      toolset: "spotify",
      description: "Read or modify the current user's saved tracks library.",
      emoji: "❤️",
      tags: ["spotify"],
      schema: objectSchema({
        action: z.enum(["saved_tracks", "save_tracks", "remove_tracks", "contains"]).default("saved_tracks").describe("Library action"),
        ids: z.union([z.string(), z.array(z.string())]).optional().describe("Track ids or URIs"),
        limit: z.number().min(1).max(50).default(20).describe("Pagination limit"),
        offset: z.number().default(0).describe("Pagination offset"),
        market: z.string().optional().describe("Market code"),
      }),
      handler: spotifyLibrary,
    },
  ];

  for (const tool of tools) {
    registry.register(tool);
  }
}

// Auto-register on module import so the global catalog contains the tools.
registerSpotifyTools();
