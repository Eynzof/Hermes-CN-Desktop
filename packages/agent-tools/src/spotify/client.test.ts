import { describe, it, expect } from "vitest";
import { SpotifyClient } from "./client.js";
import { SpotifyAuthRequiredError } from "./errors.js";
import type { SpotifyTokenState } from "@hermes/protocol";

function makeState(overrides?: Partial<SpotifyTokenState>): SpotifyTokenState {
  return {
    client_id: "cid",
    redirect_uri: "http://127.0.0.1/cb",
    api_base_url: "https://api.spotify.com/v1",
    accounts_base_url: "https://accounts.spotify.com",
    scope: "s",
    access_token: overrides?.access_token ?? "token-1",
    refresh_token: "rt",
    token_type: "Bearer",
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
    expires_in: 3600,
    obtained_at: new Date().toISOString(),
    auth_type: "oauth_pkce",
    ...overrides,
  };
}

function mockFetch(
  handler: (url: string, init: RequestInit) => Promise<Response>,
): (url: string, init?: RequestInit) => Promise<Response> {
  return (url, init) => handler(url, init ?? {});
}

describe("SpotifyClient.request", () => {
  it("returns parsed JSON on success", async () => {
    const state = makeState();
    const client = new SpotifyClient({
      tokenState: state,
      refreshToken: async () => state,
      fetchImpl: mockFetch(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })),
    });
    const result = await client.request("GET", "/me");
    expect(result).toEqual({ ok: true });
  });

  it("retries once on 401 with refreshed token", async () => {
    let first = true;
    const state = makeState({ access_token: "token-1" });
    const refreshed = makeState({ access_token: "token-2" });
    const fetchImpl = mockFetch(async (_url, init) => {
      const auth = (init.headers as Record<string, string>)?.Authorization;
      if (first) {
        first = false;
        expect(auth).toBe("Bearer token-1");
        return new Response(JSON.stringify({ error: "Invalid token" }), { status: 401 });
      }
      expect(auth).toBe("Bearer token-2");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    let refreshCalled = false;
    const client = new SpotifyClient({
      tokenState: state,
      refreshToken: async () => {
        refreshCalled = true;
        return refreshed;
      },
      fetchImpl,
    });
    const result = await client.request("GET", "/me");
    expect(refreshCalled).toBe(true);
    expect(result).toEqual({ ok: true });
  });

  it("throws SpotifyAuthRequiredError after refresh fails", async () => {
    const state = makeState();
    const fetchImpl = mockFetch(async () =>
      new Response(JSON.stringify({ error: "Invalid token" }), { status: 401 }),
    );
    const client = new SpotifyClient({
      tokenState: state,
      refreshToken: async () => makeState({ access_token: "token-2" }),
      fetchImpl,
    });
    await expect(client.request("GET", "/me")).rejects.toBeInstanceOf(SpotifyAuthRequiredError);
  });

  it("returns empty explanatory payload for 204 when requested", async () => {
    const client = new SpotifyClient({
      tokenState: makeState(),
      refreshToken: async () => makeState(),
      fetchImpl: mockFetch(async () => new Response(null, { status: 204 })),
    });
    const result = await client.request("GET", "/me/player", { emptyResponse: true });
    expect(result).toMatchObject({ status_code: 204, empty: true });
  });

  it("maps 403 Premium errors to friendly message", async () => {
    const client = new SpotifyClient({
      tokenState: makeState(),
      refreshToken: async () => makeState(),
      fetchImpl: mockFetch(async () =>
        new Response(JSON.stringify({ error: { message: "Premium required" } }), { status: 403 }),
      ),
    });
    await expect(client.request("PUT", "/me/player/play")).rejects.toThrow("Premium");
  });

  it("maps 404 to no active device message", async () => {
    const client = new SpotifyClient({
      tokenState: makeState(),
      refreshToken: async () => makeState(),
      fetchImpl: mockFetch(async () => new Response(JSON.stringify({}), { status: 404 })),
    });
    await expect(client.request("GET", "/me/player")).rejects.toThrow("No active Spotify device found. Open Spotify on a device and try again.");
  });

  it("includes retry-after hint on 429", async () => {
    const client = new SpotifyClient({
      tokenState: makeState(),
      refreshToken: async () => makeState(),
      fetchImpl: mockFetch(async () =>
        new Response(JSON.stringify({ error: "rate limit" }), {
          status: 429,
          headers: { "Retry-After": "5" },
        }),
      ),
    });
    try {
      await client.request("GET", "/me");
      expect.fail("should throw");
    } catch (err) {
      expect((err as Error).message).toContain("rate limit");
    }
  });
});

describe("SpotifyClient.normalize helpers", () => {
  it("normalizes URL to URI in queue add", async () => {
    const state = makeState();
    const client = new SpotifyClient({
      tokenState: state,
      refreshToken: async () => state,
      fetchImpl: mockFetch(async (url) => {
        expect(url).toContain("uri=spotify%3Atrack%3Aabc");
        return new Response(null, { status: 204 });
      }),
    });
    await client.addToQueue("https://open.spotify.com/track/abc");
  });
});
