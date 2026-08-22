import { describe, expect, it } from "vitest";
import {
  buildGoogleAuthUrl,
  tokenResponseToState,
  DEFAULT_MEET_SCOPE,
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
