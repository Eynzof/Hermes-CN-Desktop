import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildGoogleAuthUrl,
  tokenResponseToState,
  exchangeGoogleCode,
  refreshGoogleToken,
  DEFAULT_MEET_CALLBACK_PATH,
  DEFAULT_MEET_OAUTH_PORT,
  DEFAULT_MEET_SCOPE,
  GOOGLE_ACCOUNTS_BASE,
  GOOGLE_TOKEN_ENDPOINT,
} from "./oauth";

describe("buildGoogleAuthUrl", () => {
  it("builds a PKCE auth URL", async () => {
    const result = await buildGoogleAuthUrl({ clientId: "test-client" });
    expect(result.authUrl).toContain("accounts.google.com");
    expect(result.authUrl).toContain("client_id=test-client");
    expect(result.authUrl).toContain("response_type=code");
    expect(result.authUrl).toContain("code_challenge_method=S256");
    expect(result.authUrl).toContain(
      `scope=${encodeURIComponent("https://www.googleapis.com/auth/meetings.space.readonly")}`,
    );
    expect(result.authUrl).toContain("code_challenge=");
    expect(result.codeVerifier).toHaveLength(86);
    expect(result.redirectUri).toContain("127.0.0.1");
    expect(result.state).toBeTruthy();
  });
});

describe("tokenResponseToState", () => {
  it("maps a token response to state", () => {
    const state = tokenResponseToState(
      {
        access_token: "at",
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token: "rt",
        scope: "meetings.space.readonly",
      },
      "client",
      "http://127.0.0.1/callback",
      "meetings.space.readonly",
    );
    expect(state.access_token).toBe("at");
    expect(state.refresh_token).toBe("rt");
    expect(state.token_type).toBe("Bearer");
    expect(state.expires_in).toBe(3600);
    expect(state.client_id).toBe("client");
  });
});

describe("Google OAuth constants", () => {
  it("exposes the expected Meet OAuth endpoints and defaults", () => {
    expect(GOOGLE_ACCOUNTS_BASE).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(GOOGLE_TOKEN_ENDPOINT).toBe("https://oauth2.googleapis.com/token");
    expect(DEFAULT_MEET_OAUTH_PORT).toBe(43828);
    expect(DEFAULT_MEET_CALLBACK_PATH).toBe("/google-meet/callback");
  });
});

describe("exchangeGoogleCode", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts an authorization_code grant and returns the token response", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: "at",
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token: "rt",
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await exchangeGoogleCode({
      clientId: "client",
      code: "code-1",
      codeVerifier: "verifier",
      redirectUri: "http://127.0.0.1:43828/google-meet/callback",
    });
    expect(result.access_token).toBe("at");
    expect(result.refresh_token).toBe("rt");
    expect(fetchMock).toHaveBeenCalledWith(
      GOOGLE_TOKEN_ENDPOINT,
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "client_id=client&code=code-1&code_verifier=verifier&redirect_uri=http%3A%2F%2F127.0.0.1%3A43828%2Fgoogle-meet%2Fcallback&grant_type=authorization_code",
      }),
    );
  });

  it("throws when the token endpoint returns an error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 400,
        json: async () => ({ error: "invalid_grant" }),
      })),
    );
    await expect(
      exchangeGoogleCode({
        clientId: "c",
        code: "bad",
        codeVerifier: "v",
        redirectUri: "http://127.0.0.1/cb",
      }),
    ).rejects.toThrow("Google token exchange failed: 400");
  });
});

describe("refreshGoogleToken", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts a refresh_token grant and returns the token response", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: "new-at",
        token_type: "Bearer",
        expires_in: 3600,
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await refreshGoogleToken({ clientId: "client", refreshToken: "rt" });
    expect(result.access_token).toBe("new-at");
    expect(fetchMock).toHaveBeenCalledWith(
      GOOGLE_TOKEN_ENDPOINT,
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "client_id=client&refresh_token=rt&grant_type=refresh_token",
      }),
    );
  });

  it("throws when refresh fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 401,
        json: async () => ({ error: "invalid_grant" }),
      })),
    );
    await expect(refreshGoogleToken({ clientId: "c", refreshToken: "bad" })).rejects.toThrow(
      "Google token refresh failed: 401",
    );
  });
});
