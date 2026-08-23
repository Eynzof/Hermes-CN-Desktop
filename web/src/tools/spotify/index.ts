// Spotify tool adapter for the Hermes desktop webview.
//
// The core implementation lives in @hermes/agent-tools/spotify so it can be
// consumed by both the web UI and headless/desktop runtimes. This module is
// the web-specific entry point for the desktop: it wires the
// Rust auth.json persistence into the in-process credential provider.

export {
  SpotifyClient,
  SpotifyAuthManager,
  SpotifyAuthRequiredError,
  SpotifyApiError,
  SpotifyError,
  registerSpotifyTools,
  setCredentialProvider,
  generateCodeVerifier,
  generateCodeChallenge,
  generateState,
  buildAuthorizeUrl,
  exchangeCode,
  quarantineTokenState,
  normalizeSpotifyUri,
  normalizeSpotifyId,
  normalizeSpotifyUris,
  DEFAULT_SPOTIFY_SCOPE,
} from "@hermes/agent-tools/spotify";

export type {
  SpotifyCredentialProvider,
  SpotifyAuthConfig,
  SpotifyToolContext,
} from "@hermes/agent-tools/spotify";

export { initSpotifyCredentialProvider } from "@/lib/spotify";
