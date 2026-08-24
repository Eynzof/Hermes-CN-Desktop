import { describe, it, expect, beforeAll } from "vitest";
import {
  generateCodeVerifier,
  generateCodeChallenge,
  generateState,
  buildAuthorizeUrl,
  tokenResponseToState,
  exchangeCode,
  quarantineTokenState,
  SpotifyAuthManager,
  SpotifyAuthRequiredError,
  DEFAULT_SPOTIFY_SCOPE,
  getCredentialProvider,
  setCredentialProvider,
} from "./auth.js";
import type { SpotifyCredentialProvider } from "./auth.js";
import type { SpotifyTokenResponse, SpotifyTokenState } from "@hermes/protocol";

// Type sanity check: ensure the protocol schema infers a usable type.
const _typeCheck: SpotifyTokenState = {
  client_id: "c",
  redirect_uri: "r",
  api_base_url: "a",
  accounts_base_url: "a",
  scope: "s",
  access_token: "a",
  refresh_token: "r",
  token_type: "Bearer",
  expires_at: "e",
  expires_in: 1,
  obtained_at: "o",
  auth_type: "oauth_pkce",
};
void _typeCheck;

describe("PKCE", () => {
  it("verifier is base64url and ≤128 chars", () => {
    const v = generateCodeVerifier();
    expect(v.length).toBeGreaterThanOrEqual(43);
    expect(v.length).toBeLessThanOrEqual(128);
    expect(/^[A-Za-z0-9_-]+$/.test(v)).toBe(true);
  });

  it("challenge is deterministic S256 of verifier", async () => {
    const v = generateCodeVerifier();
    const c1 = await generateCodeChallenge(v);
    const c2 = await generateCodeChallenge(v);
    expect(c1).toBe(c2);
    expect(c1).not.toBe(v);
    expect(/^[A-Za-z0-9_-]+$/.test(c1)).toBe(true);
  });

  it("state nonce is unique", () => {
    const s1 = generateState();
    const s2 = generateState();
    expect(s1).not.toBe(s2);
  });

  it("builds authorize URL with required PKCE params", () => {
    const url = buildAuthorizeUrl(
      { clientId: "cid", redirectUri: "http://127.0.0.1/cb" },
      "challenge",
      "state",
    );
    expect(url).toContain("https://accounts.spotify.com/authorize");
    expect(url).toContain("client_id=cid");
    expect(url).toContain("response_type=code");
    expect(url).toContain("code_challenge_method=S256");
    expect(url).toContain("code_challenge=challenge");
    expect(url).toContain("state=state");
  });
});

describe("tokenResponseToState", () => {
  it("computes expires_at and preserves config", () => {
    const obtainedAt = new Date("2025-01-01T00:00:00.000Z");
    const response: SpotifyTokenResponse = {
      access_token: "at",
      token_type: "Bearer",
      scope: "user-read-playback-state",
      expires_in: 3600,
      refresh_token: "rt",
    };
    const state = tokenResponseToState(response, {
      clientId: "cid",
      redirectUri: "http://127.0.0.1/cb",
      apiBaseUrl: "https://api.spotify.com/v1",
      scope: "user-read-playback-state",
    }, obtainedAt);
    expect(state.access_token).toBe("at");
    expect(state.refresh_token).toBe("rt");
    expect(state.expires_in).toBe(3600);
    expect(state.expires_at).toBe("2025-01-01T01:00:00.000Z");
    expect(state.auth_type).toBe("oauth_pkce");
  });
});

describe("SpotifyAuthManager", () => {
  beforeAll(() => {
    if (typeof globalThis.crypto === "undefined") {
      // Node test environment; skip crypto-dependent parts if missing.
      // eslint-disable-next-line no-console
      console.log("crypto unavailable in this environment");
    }
  });

  it("does not refresh when token is still fresh", () => {
    const state = tokenResponseToState(
      {
        access_token: "at",
        token_type: "Bearer",
        scope: "s",
        expires_in: 3600,
        refresh_token: "rt",
      },
      { clientId: "cid", redirectUri: "http://127.0.0.1/cb" },
      new Date(),
    );
    const manager = new SpotifyAuthManager(state);
    expect(manager.needsRefresh()).toBe(false);
  });

  it("flags refresh needed when within skew window", () => {
    const state = tokenResponseToState(
      {
        access_token: "at",
        token_type: "Bearer",
        scope: "s",
        expires_in: 60,
        refresh_token: "rt",
      },
      { clientId: "cid", redirectUri: "http://127.0.0.1/cb" },
      new Date(Date.now() - 3600_000),
    );
    const manager = new SpotifyAuthManager(state);
    expect(manager.needsRefresh()).toBe(true);
  });

  it("single-flight refresh returns same state to concurrent callers", async () => {
    let callCount = 0;
    const mockFetch: (url: string, init?: RequestInit) => Promise<Response> = async () => {
      callCount += 1;
      await new Promise((r) => setTimeout(r, 10));
      return new Response(
        JSON.stringify({
          access_token: "at2",
          token_type: "Bearer",
          scope: "s",
          expires_in: 3600,
        }),
        { status: 200 },
      );
    };
    const state = tokenResponseToState(
      {
        access_token: "at",
        token_type: "Bearer",
        scope: "s",
        expires_in: 1,
        refresh_token: "rt",
      },
      { clientId: "cid", redirectUri: "http://127.0.0.1/cb" },
      new Date(Date.now() - 3600_000),
    ) as SpotifyTokenState;
    const manager = new SpotifyAuthManager(state, undefined, mockFetch);
    const [r1, r2] = await Promise.all([manager.refresh(), manager.refresh()]);
    expect(r1.state.access_token).toBe("at2");
    expect(r2.state.access_token).toBe("at2");
    expect(callCount).toBe(1);
  });

  it("quarantines on invalid_grant and raises SpotifyAuthRequiredError", async () => {
    const mockFetch: (url: string, init?: RequestInit) => Promise<Response> = async () => {
      return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
    };
    const state = tokenResponseToState(
      {
        access_token: "at",
        token_type: "Bearer",
        scope: "s",
        expires_in: 1,
        refresh_token: "rt",
      },
      { clientId: "cid", redirectUri: "http://127.0.0.1/cb" },
      new Date(Date.now() - 3600_000),
    );
    let saved: SpotifyTokenState | null = null;
    const manager = new SpotifyAuthManager(state, async (s: SpotifyTokenState) => {
      saved = s;
    }, mockFetch);

    await expect(manager.refresh()).rejects.toBeInstanceOf(SpotifyAuthRequiredError);
    expect(saved).not.toBeNull();
    expect(saved!.access_token).toBe("");
    expect(saved!.refresh_token).toBe("");
    expect(saved!.last_auth_error).toBeDefined();
    expect(manager.getState()?.access_token).toBe("");
  });

  it("exchanges authorization code for tokens", async () => {
    const mockFetch: (url: string, init?: RequestInit) => Promise<Response> = async (_url, init) => {
      const body = new URLSearchParams(init?.body as string);
      expect(body.get("grant_type")).toBe("authorization_code");
      expect(body.get("code")).toBe("code-1");
      expect(body.get("code_verifier")).toBe("verifier");
      return new Response(
        JSON.stringify({
          access_token: "at",
          token_type: "Bearer",
          scope: "s",
          expires_in: 3600,
          refresh_token: "rt",
        }),
        { status: 200 },
      );
    };
    const state = await exchangeCode(
      { clientId: "cid", redirectUri: "http://127.0.0.1/cb" },
      "code-1",
      "verifier",
      mockFetch,
    );
    expect(state.access_token).toBe("at");
    expect(state.refresh_token).toBe("rt");
  });
});

describe("credential provider registry", () => {
  it("DEFAULT_SPOTIFY_SCOPE joins all required scopes", () => {
    expect(DEFAULT_SPOTIFY_SCOPE.split(" ")).toHaveLength(10);
    expect(DEFAULT_SPOTIFY_SCOPE).toContain("user-modify-playback-state");
    expect(DEFAULT_SPOTIFY_SCOPE).toContain("user-read-playback-state");
    expect(DEFAULT_SPOTIFY_SCOPE).toContain("user-read-currently-playing");
    expect(DEFAULT_SPOTIFY_SCOPE).toContain("playlist-modify-private");
  });

  it("getCredentialProvider returns null before any provider is set", () => {
    expect(getCredentialProvider()).toBeNull();
  });

  it("setCredentialProvider stores the provider and getCredentialProvider returns it", () => {
    const provider: SpotifyCredentialProvider = {
      getState: async () => null,
      saveState: async () => {},
    };
    setCredentialProvider(provider);
    expect(getCredentialProvider()).toBe(provider);
  });

  it("setCredentialProvider replaces an existing provider", () => {
    const first: SpotifyCredentialProvider = {
      getState: async () => null,
      saveState: async () => {},
    };
    const second: SpotifyCredentialProvider = {
      getState: async () => null,
      saveState: async () => {},
    };
    setCredentialProvider(first);
    setCredentialProvider(second);
    expect(getCredentialProvider()).toBe(second);
  });
});

describe("quarantineTokenState", () => {
  it("clears tokens and records last_auth_error", () => {
    const state = tokenResponseToState(
      { access_token: "at", token_type: "Bearer", scope: "s", expires_in: 3600, refresh_token: "rt" },
      { clientId: "cid", redirectUri: "http://127.0.0.1/cb" },
      new Date(),
    );
    const quarantined = quarantineTokenState(state, new Error("boom"));
    expect(quarantined.access_token).toBe("");
    expect(quarantined.refresh_token).toBe("");
    expect(quarantined.expires_in).toBe(0);
    expect(quarantined.last_auth_error?.error).toBe("Error");
    expect(quarantined.last_auth_error?.error_description).toBe("boom");
  });
});
