import { invoke } from "@tauri-apps/api/core";
import type {
  SpotifyAuthUrlResult,
  SpotifyCallbackStartResult,
  SpotifyCallbackWaitResult,
  SpotifyTokenState,
} from "@hermes/protocol";
import {
  SpotifyAuthManager,
  buildAuthorizeUrl,
  exchangeCode,
  generateCodeChallenge,
  generateCodeVerifier,
  generateState,
  registerSpotifyTools,
  setCredentialProvider,
} from "@hermes/agent-tools";
import { openExternalUrl } from "./external-links";

export const DEFAULT_SPOTIFY_REDIRECT_URI = "http://127.0.0.1:43827/spotify/callback";

export interface SpotifyLoginInput {
  clientId: string;
  redirectUri?: string;
  accountsBaseUrl?: string;
  apiBaseUrl?: string;
  scope?: string;
}

async function readTokenState(): Promise<SpotifyTokenState | null> {
  const result = (await invoke("spotify_oauth_read")) as {
    ok: boolean;
    provider?: SpotifyTokenState;
    error?: string;
  };
  if (!result.ok) {
    throw new Error(result.error ?? "Failed to read Spotify auth state");
  }
  return result.provider ?? null;
}

async function writeTokenState(state: SpotifyTokenState): Promise<void> {
  const result = (await invoke("spotify_oauth_write", { provider: state })) as {
    ok: boolean;
    error?: string;
  };
  if (!result.ok) {
    throw new Error(result.error ?? "Failed to write Spotify auth state");
  }
}

async function clearTokenState(): Promise<void> {
  const result = (await invoke("spotify_oauth_disconnect")) as { ok: boolean; error?: string };
  if (!result.ok) {
    throw new Error(result.error ?? "Failed to disconnect Spotify");
  }
}

export function initSpotifyCredentialProvider(): void {
  registerSpotifyTools();
  setCredentialProvider({
    getState: readTokenState,
    saveState: writeTokenState,
  });
}

export async function buildSpotifyAuthUrl(input: SpotifyLoginInput): Promise<SpotifyAuthUrlResult> {
  const verifier = generateCodeVerifier();
  const challenge = await generateCodeChallenge(verifier);
  const state = generateState();
  const redirectUri = input.redirectUri ?? DEFAULT_SPOTIFY_REDIRECT_URI;
  const authUrl = buildAuthorizeUrl(
    {
      clientId: input.clientId,
      redirectUri,
      accountsBaseUrl: input.accountsBaseUrl,
      scope: input.scope,
    },
    challenge,
    state,
  );
  return { authUrl, codeVerifier: verifier, state };
}

export async function startSpotifyCallbackListener(port?: number): Promise<SpotifyCallbackStartResult> {
  return (await invoke("spotify_oauth_start", { port, path: "/spotify/callback" })) as SpotifyCallbackStartResult;
}

export async function waitForSpotifyCallback(): Promise<SpotifyCallbackWaitResult> {
  return (await invoke("spotify_oauth_wait")) as SpotifyCallbackWaitResult;
}

export async function cancelSpotifyCallback(): Promise<void> {
  await invoke("spotify_oauth_cancel");
}

export async function completeSpotifyLogin(
  input: SpotifyLoginInput,
  code: string,
  codeVerifier: string,
): Promise<SpotifyTokenState> {
  const state = await exchangeCode(
    {
      clientId: input.clientId,
      redirectUri: input.redirectUri ?? DEFAULT_SPOTIFY_REDIRECT_URI,
      accountsBaseUrl: input.accountsBaseUrl,
      scope: input.scope,
    },
    code,
    codeVerifier,
  );
  await writeTokenState(state);
  return state;
}

export async function refreshSpotifyToken(): Promise<SpotifyTokenState | null> {
  const state = await readTokenState();
  if (!state) return null;
  const manager = new SpotifyAuthManager(state, async (newState: SpotifyTokenState) => {
    await writeTokenState(newState);
  });
  const result = await manager.refresh();
  return result.state;
}

export async function getSpotifyLoginStatus(): Promise<SpotifyTokenState | null> {
  return readTokenState();
}

export async function disconnectSpotify(): Promise<void> {
  await clearTokenState();
}

export async function openSpotifyAuthUrl(url: string): Promise<void> {
  await openExternalUrl(url);
}
