import { SpotifyTokenResponse } from "@hermes/protocol";
import type { SpotifyTokenState } from "@hermes/protocol";
import { SpotifyAuthRequiredError, SpotifyError } from "./errors.js";
export { SpotifyAuthRequiredError };

const VERIFIER_LENGTH = 64;
const SKEW_SECONDS = 120;

export interface SpotifyAuthConfig {
  clientId: string;
  redirectUri: string;
  accountsBaseUrl?: string;
  apiBaseUrl?: string;
  scope?: string;
}

export const DEFAULT_SPOTIFY_SCOPE = [
  "user-modify-playback-state",
  "user-read-playback-state",
  "user-read-currently-playing",
  "user-read-recently-played",
  "playlist-read-private",
  "playlist-read-collaborative",
  "playlist-modify-public",
  "playlist-modify-private",
  "user-library-read",
  "user-library-modify",
].join(" ");

function base64UrlEncode(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function generateCodeVerifier(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(VERIFIER_LENGTH));
  return base64UrlEncode(bytes.buffer);
}

export async function generateCodeChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return base64UrlEncode(digest);
}

export function generateState(): string {
  return generateCodeVerifier();
}

export function buildAuthorizeUrl(
  config: SpotifyAuthConfig,
  challenge: string,
  state: string,
): string {
  const base = config.accountsBaseUrl || "https://accounts.spotify.com";
  const params = new URLSearchParams({
    client_id: config.clientId,
    response_type: "code",
    redirect_uri: config.redirectUri,
    code_challenge_method: "S256",
    code_challenge: challenge,
    state,
    scope: config.scope || DEFAULT_SPOTIFY_SCOPE,
  });
  return `${base}/authorize?${params.toString()}`;
}

export function tokenResponseToState(
  response: SpotifyTokenResponse,
  config: SpotifyAuthConfig,
  obtainedAt: Date,
): SpotifyTokenState {
  const expiresIn = response.expires_in ?? 3600;
  const expiresAt = new Date(obtainedAt.getTime() + expiresIn * 1000).toISOString();
  return {
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    api_base_url: config.apiBaseUrl || "https://api.spotify.com/v1",
    accounts_base_url: config.accountsBaseUrl || "https://accounts.spotify.com",
    scope: config.scope || DEFAULT_SPOTIFY_SCOPE,
    granted_scope: response.scope,
    access_token: response.access_token,
    refresh_token: response.refresh_token!,
    token_type: "Bearer",
    expires_at: expiresAt,
    expires_in: expiresIn,
    obtained_at: obtainedAt.toISOString(),
    auth_type: "oauth_pkce",
  };
}

export interface SpotifyCredentialProvider {
  getState: () => Promise<SpotifyTokenState | null>;
  saveState: (state: SpotifyTokenState) => Promise<void>;
}

let credentialProvider: SpotifyCredentialProvider | null = null;

export function setCredentialProvider(provider: SpotifyCredentialProvider): void {
  credentialProvider = provider;
}

export function getCredentialProvider(): SpotifyCredentialProvider | null {
  return credentialProvider;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

async function tokenRequest(
  params: URLSearchParams,
  accountsBaseUrl: string,
  fetchImpl: FetchLike,
): Promise<SpotifyTokenResponse> {
  const url = `${accountsBaseUrl}/api/token`;
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  const text = await response.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = text;
  }

  if (!response.ok) {
    const b = body as Record<string, unknown> | undefined;
    const error = typeof b?.error === "string" ? b.error : `HTTP ${response.status}`;
    const description = typeof b?.error_description === "string" ? b.error_description : "";
    if (error === "invalid_grant") {
      throw new SpotifyAuthRequiredError(description || "Authorization code or refresh token expired. Please log in again.");
    }
    throw new SpotifyError(`${error}: ${description}`.trim(), response.status, error);
  }

  return SpotifyTokenResponse.parse(body);
}

export async function exchangeCode(
  config: SpotifyAuthConfig,
  code: string,
  codeVerifier: string,
  fetchImpl: FetchLike = fetch,
): Promise<SpotifyTokenState> {
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: config.redirectUri,
    client_id: config.clientId,
    code_verifier: codeVerifier,
  });
  const response = await tokenRequest(
    params,
    config.accountsBaseUrl || "https://accounts.spotify.com",
    fetchImpl,
  );
  if (!response.refresh_token) {
    throw new SpotifyError("Spotify token response missing refresh_token");
  }
  return tokenResponseToState(response, config, new Date());
}

function isExpiring(state: SpotifyTokenState): boolean {
  const expiresAt = Date.parse(state.expires_at);
  return Number.isNaN(expiresAt) || Date.now() >= expiresAt - SKEW_SECONDS * 1000;
}

export function quarantineTokenState(state: SpotifyTokenState, error: unknown): SpotifyTokenState {
  const lastAuthError = {
    error: error instanceof Error ? error.name : "unknown",
    error_description: error instanceof Error ? error.message : String(error),
    timestamp: new Date().toISOString(),
  };
  return {
    ...state,
    access_token: "",
    refresh_token: "",
    expires_at: new Date(0).toISOString(),
    expires_in: 0,
    last_auth_error: lastAuthError,
  };
}

export interface TokenRefreshResult {
  state: SpotifyTokenState;
  refreshed: boolean;
}

export class SpotifyAuthManager {
  private refreshPromise: Promise<SpotifyTokenState> | null = null;

  constructor(
    public state: SpotifyTokenState | null,
    public onStateChange?: (state: SpotifyTokenState) => void | Promise<void>,
    private fetchImpl: FetchLike = fetch,
  ) {}

  getState(): SpotifyTokenState | null {
    return this.state;
  }

  setState(state: SpotifyTokenState): void {
    this.state = state;
  }

  isAuthenticated(): boolean {
    return Boolean(this.state?.access_token && this.state.refresh_token);
  }

  needsRefresh(): boolean {
    if (!this.state) return true;
    return isExpiring(this.state);
  }

  async ensureFresh(): Promise<SpotifyTokenState> {
    if (!this.state) {
      throw new SpotifyAuthRequiredError();
    }
    if (!isExpiring(this.state)) {
      return this.state;
    }
    const refreshed = await this.refresh();
    return refreshed.state;
  }

  async refresh(): Promise<TokenRefreshResult> {
    if (!this.state) {
      throw new SpotifyAuthRequiredError();
    }

    if (this.refreshPromise) {
      const state = await this.refreshPromise;
      return { state, refreshed: true };
    }

    this.refreshPromise = this.doRefresh();
    try {
      const state = await this.refreshPromise;
      return { state, refreshed: true };
    } finally {
      this.refreshPromise = null;
    }
  }

  private async doRefresh(): Promise<SpotifyTokenState> {
    if (!this.state) throw new SpotifyAuthRequiredError();
    const { client_id, refresh_token, accounts_base_url } = this.state;
    if (!refresh_token) {
      throw new SpotifyAuthRequiredError("No refresh token available.");
    }

    try {
      const params = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token,
        client_id,
      });
      const response = await tokenRequest(
        params,
        accounts_base_url || "https://accounts.spotify.com",
        this.fetchImpl,
      );

      const newState = tokenResponseToState(
        { ...response, refresh_token: response.refresh_token ?? this.state.refresh_token },
        {
          clientId: this.state.client_id,
          redirectUri: this.state.redirect_uri,
          accountsBaseUrl: this.state.accounts_base_url,
          apiBaseUrl: this.state.api_base_url,
          scope: this.state.scope,
        },
        new Date(),
      );
      this.state = newState;
      await this.onStateChange?.(newState);
      return newState;
    } catch (error) {
      if (error instanceof SpotifyAuthRequiredError) {
        const quarantined = quarantineTokenState(this.state, error);
        this.state = quarantined;
        await this.onStateChange?.(quarantined);
      }
      throw error;
    }
  }
}
