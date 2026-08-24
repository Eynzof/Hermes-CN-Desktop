import { afterEach, describe, expect, it, vi } from "vitest";
import { MeetRestClient, MeetApiError, MEET_API_BASE, makeMeetClient } from "./client";
import type { GoogleOAuthTokenState } from "@hermes/protocol";

describe("MeetRestClient", () => {
  function makeClient(tokenState?: Partial<GoogleOAuthTokenState>) {
    const state: GoogleOAuthTokenState = {
      client_id: "client",
      redirect_uri: "http://127.0.0.1/callback",
      scope: "meetings.space.readonly",
      access_token: "access-token",
      refresh_token: "refresh-token",
      token_type: "Bearer",
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
      expires_in: 3600,
      obtained_at: new Date().toISOString(),
      ...tokenState,
    };
    return new MeetRestClient({
      tokenState: state,
      refreshToken: async () => ({ ...state, access_token: "refreshed" }),
    });
  }

  it("lists conference records", async () => {
    const client = makeClient();
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ conferenceRecords: [{ name: "conferenceRecords/1" }] }),
    });

    const result = await client.listConferenceRecords();
    expect(result.conferenceRecords).toHaveLength(1);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      `${MEET_API_BASE}/conferenceRecords`,
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer access-token" }),
      }),
    );
  });

  it("refreshes token before request when expired", async () => {
    const client = makeClient({
      expires_at: new Date(Date.now() - 60_000).toISOString(),
    });
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ conferenceRecords: [] }),
    });

    await client.listConferenceRecords();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer refreshed" }),
      }),
    );
  });

  it("throws MeetApiError on failure", async () => {
    const client = makeClient();
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 403,
      statusText: "Forbidden",
      json: async () => ({ error: "denied" }),
    });

    await expect(client.listConferenceRecords()).rejects.toBeInstanceOf(MeetApiError);
  });

  it("lists transcripts for a conference record", async () => {
    const client = makeClient();
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ transcripts: [{ name: "transcripts/1" }] }),
    });

    const result = await client.listTranscripts("conferenceRecords/1");
    expect(result.transcripts).toHaveLength(1);
  });
});

describe("makeMeetClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function makeTokenState(overrides?: Partial<GoogleOAuthTokenState>): GoogleOAuthTokenState {
    return {
      client_id: "client",
      redirect_uri: "http://127.0.0.1/callback",
      scope: "meetings.space.readonly",
      access_token: "access-token",
      refresh_token: "refresh-token",
      token_type: "Bearer",
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
      expires_in: 3600,
      obtained_at: new Date().toISOString(),
      ...overrides,
    };
  }

  it("returns a MeetRestClient that lists conference records", async () => {
    const client = makeMeetClient(makeTokenState(), async () => makeTokenState());
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ conferenceRecords: [{ name: "conferenceRecords/1" }] }),
      }),
    );

    const result = await client.listConferenceRecords();
    expect(result.conferenceRecords).toHaveLength(1);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      `${MEET_API_BASE}/conferenceRecords`,
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer access-token" }),
      }),
    );
  });

  it("uses the injected refresh callback when the token is expired", async () => {
    const refresh = vi.fn(async () => makeTokenState({ access_token: "refreshed" }));
    const client = makeMeetClient(makeTokenState({ expires_at: new Date(Date.now() - 60_000).toISOString() }), refresh);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ conferenceRecords: [] }),
      }),
    );

    await client.listConferenceRecords();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer refreshed" }),
      }),
    );
  });

  it("surfaces non-ok responses as MeetApiError", async () => {
    const client = makeMeetClient(makeTokenState(), async () => makeTokenState());
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        json: async () => ({ error: "denied" }),
      }),
    );

    await expect(client.listConferenceRecords()).rejects.toBeInstanceOf(MeetApiError);
  });
});
