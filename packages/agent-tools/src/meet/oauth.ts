/**
 * Google OAuth PKCE helpers for the Meet REST API path.
 *
 * The loopback listener runs in Rust; this module builds the auth URL and
 * exchanges/refreshs tokens via the Meet REST token endpoint.
 */

import type {
  GoogleOAuthStartInput,
  GoogleOAuthStartResult,
  GoogleOAuthTokenInput,
  GoogleOAuthRefreshInput,
  GoogleOAuthTokenResponse,
  GoogleOAuthTokenState,
} from "@hermes/protocol";

export const GOOGLE_ACCOUNTS_BASE = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const DEFAULT_MEET_OAUTH_PORT = 43828;
export const DEFAULT_MEET_CALLBACK_PATH = "/google-meet/callback";
export const DEFAULT_MEET_SCOPE = [
  "https://www.googleapis.com/auth/meetings.space.readonly",
  "https://www.googleapis.com/auth/meetings.media.readonly",
  "openid",
  "email",
  "profile",
].join(" ");

function base64UrlEncode(bytes: Uint8Array): string {
  const bin = Array.from(bytes, (b) => String.fromCharCode(b)).join("");
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256(text: string): Promise<Uint8Array> {
  const data = new TextEncoder().encode(text);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data));
}

export async function generateCodeVerifier(): Promise<string> {
  const bytes = crypto.getRandomValues(new Uint8Array(64));
  return base64UrlEncode(bytes);
}

export async function generateState(): Promise<string> {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return base64UrlEncode(bytes);
}

export async function generateCodeChallenge(verifier: string): Promise<string> {
  return base64UrlEncode(await sha256(verifier));
}

export async function buildGoogleAuthUrl(
  input: GoogleOAuthStartInput,
): Promise<GoogleOAuthStartResult> {
  const redirectUri = input.redirectUri ?? `http://127.0.0.1:${DEFAULT_MEET_OAUTH_PORT}${DEFAULT_MEET_CALLBACK_PATH}`;
  const state = await generateState();
  const codeVerifier = await generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);

  const params = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: input.scope ?? DEFAULT_MEET_SCOPE,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    access_type: "offline",
    prompt: "consent",
  });

  return {
    authUrl: `${GOOGLE_ACCOUNTS_BASE}?${params.toString()}`,
    codeVerifier,
    state,
    redirectUri,
  };
}

export function tokenResponseToState(
  response: GoogleOAuthTokenResponse,
  clientId: string,
  redirectUri: string,
  scope: string,
): GoogleOAuthTokenState {
  const expiresIn = response.expires_in ?? 3600;
  const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
  return {
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: response.scope ?? scope,
    access_token: response.access_token,
    refresh_token: response.refresh_token ?? "",
    token_type: "Bearer",
    expires_at: expiresAt,
    expires_in: expiresIn,
    obtained_at: new Date().toISOString(),
  };
}

export async function exchangeGoogleCode(
  input: GoogleOAuthTokenInput,
): Promise<GoogleOAuthTokenResponse> {
  const params = new URLSearchParams({
    client_id: input.clientId,
    code: input.code,
    code_verifier: input.codeVerifier,
    redirect_uri: input.redirectUri,
    grant_type: "authorization_code",
  });

  const response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  const data = (await response.json()) as GoogleOAuthTokenResponse;
  if (!response.ok) {
    throw new Error(`Google token exchange failed: ${response.status} ${JSON.stringify(data)}`);
  }
  return data;
}

export async function refreshGoogleToken(
  input: GoogleOAuthRefreshInput,
): Promise<GoogleOAuthTokenResponse> {
  const params = new URLSearchParams({
    client_id: input.clientId,
    refresh_token: input.refreshToken,
    grant_type: "refresh_token",
  });

  const response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  const data = (await response.json()) as GoogleOAuthTokenResponse;
  if (!response.ok) {
    throw new Error(`Google token refresh failed: ${response.status} ${JSON.stringify(data)}`);
  }
  return data;
}
