import { describe, expect, it, vi } from "vitest";
import {
  meetJoin,
  meetLeave,
  meetSay,
  meetSetup,
  meetStatus,
  meetTranscript,
  readGoogleOAuthState,
} from "./tools";
import type { MeetToolContext } from "./types";
import type { GoogleOAuthTokenState } from "@hermes/protocol";

function makeMockInvoker(calls: { command: string; args: Record<string, unknown> }[], responses: Record<string, unknown>) {
  return async (command: string, args: Record<string, unknown>) => {
    calls.push({ command, args });
    if (command in responses) return responses[command];
    throw new Error(`Unexpected command: ${command}`);
  };
}

describe("meetJoin", () => {
  it("rejects invalid urls", async () => {
    const result = await meetJoin({ url: "https://example.com" }, {} as MeetToolContext);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Invalid");
  });

  it("rejects missing url", async () => {
    const result = await meetJoin({}, {} as MeetToolContext);
    expect(result.isError).toBe(true);
  });

  it("dispatches meet_join to rust and returns success", async () => {
    const calls: { command: string; args: Record<string, unknown> }[] = [];
    const ctx: MeetToolContext = {
      invoke: makeMockInvoker(calls, {
        meet_join: { success: true, meeting_id: "abcdefghi", out_dir: "/tmp/abcdefghi" },
      }),
    };
    const result = await meetJoin({ url: "https://meet.google.com/abc-defg-hij" }, ctx);
    expect(result.isError).toBeFalsy();
    expect(calls[0]?.command).toBe("meet_join");
    expect(calls[0]?.args).toMatchObject({
      url: "https://meet.google.com/abc-defg-hij",
      meetingId: "abcdefghij",
    });
    expect(result.content).toContain("abcdefghi");
  });

  it("propagates rust errors", async () => {
    const ctx: MeetToolContext = {
      invoke: async () => {
        throw new Error("boom");
      },
    };
    const result = await meetJoin({ url: "https://meet.google.com/abc-defg-hij" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("boom");
  });
});

describe("meetStatus", () => {
  it("returns summary and status", async () => {
    const calls: { command: string; args: Record<string, unknown> }[] = [];
    const ctx: MeetToolContext = {
      invoke: makeMockInvoker(calls, {
        meet_status: {
          success: true,
          active: true,
          status: { meetingId: "abc", inCall: true, transcriptLines: 3 },
        },
      }),
    };
    const result = await meetStatus({}, ctx);
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("in call");
    expect(calls[0]?.args).toEqual({});
  });
});

describe("meetTranscript", () => {
  it("returns last N lines", async () => {
    const ctx: MeetToolContext = {
      invoke: makeMockInvoker([], {
        meet_transcript: {
          success: true,
          lines: [
            { ts: "10:00", speaker: "A", text: "one" },
            { ts: "10:01", speaker: "B", text: "two" },
          ],
        },
      }),
    };
    const result = await meetTranscript({ last: 2 }, ctx);
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("line_count");
  });
});

describe("meetLeave", () => {
  it("dispatches meet_leave", async () => {
    const calls: { command: string; args: Record<string, unknown> }[] = [];
    const ctx: MeetToolContext = {
      invoke: makeMockInvoker(calls, {
        meet_leave: { success: true, meeting_id: "abc" },
      }),
    };
    const result = await meetLeave({ meeting_id: "abc", reason: "done" }, ctx);
    expect(result.isError).toBeFalsy();
    expect(calls[0]?.command).toBe("meet_leave");
  });
});

describe("meetSay", () => {
  it("requires text", async () => {
    const result = await meetSay({ text: "" }, {} as MeetToolContext);
    expect(result.content).toContain("text is required");
  });

  it("returns ok=false for v1", async () => {
    const ctx: MeetToolContext = {
      invoke: makeMockInvoker([], {
        meet_say: { ok: false, reason: "realtime deferred" },
      }),
    };
    const result = await meetSay({ text: "hello" }, ctx);
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("ok");
  });
});

describe("meetSetup", () => {
  it("dispatches meet_setup", async () => {
    const calls: { command: string; args: Record<string, unknown> }[] = [];
    const ctx: MeetToolContext = {
      invoke: makeMockInvoker(calls, { meet_setup: { ok: true } }),
    };
    const result = await meetSetup({}, ctx);
    expect(result.isError).toBeFalsy();
    expect(calls[0]?.command).toBe("meet_setup");
  });
});

describe("readGoogleOAuthState", () => {
  const tokenState: GoogleOAuthTokenState = {
    client_id: "client",
    redirect_uri: "http://127.0.0.1/callback",
    scope: "meetings.space.readonly",
    access_token: "at",
    refresh_token: "rt",
    token_type: "Bearer",
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
    expires_in: 3600,
    obtained_at: new Date().toISOString(),
  };

  it("returns state from ctx.googleOAuth.getState when present", async () => {
    const getState = vi.fn(async () => tokenState);
    const result = await readGoogleOAuthState({
      googleOAuth: { getState, saveState: async () => {} },
    } as MeetToolContext);
    expect(result).toBe(tokenState);
    expect(getState).toHaveBeenCalledTimes(1);
  });

  it("falls back to meet_oauth_read invoke when no googleOAuth is provided", async () => {
    const invoke = vi.fn(async () => ({ ok: true, provider: tokenState }));
    const result = await readGoogleOAuthState({ invoke } as MeetToolContext);
    expect(result).toBe(tokenState);
    expect(invoke).toHaveBeenCalledWith("meet_oauth_read", {});
  });

  it("does not call invoke when googleOAuth.getState returns state", async () => {
    const getState = vi.fn(async () => tokenState);
    const invoke = vi.fn(async () => ({ ok: true, provider: tokenState }));
    const result = await readGoogleOAuthState({
      invoke,
      googleOAuth: { getState, saveState: async () => {} },
    } as MeetToolContext);
    expect(result).toBe(tokenState);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("returns undefined when both providers are missing", async () => {
    expect(await readGoogleOAuthState({} as MeetToolContext)).toBeUndefined();
  });

  it("returns undefined when invoke reports ok: false", async () => {
    const invoke = vi.fn(async () => ({ ok: false, error: "no provider" }));
    const result = await readGoogleOAuthState({ invoke } as MeetToolContext);
    expect(result).toBeUndefined();
  });

  it("returns undefined when googleOAuth.getState returns null and invoke has no provider", async () => {
    const getState = vi.fn(async () => null);
    const invoke = vi.fn(async () => ({ ok: true }));
    const result = await readGoogleOAuthState({
      invoke,
      googleOAuth: { getState, saveState: async () => {} },
    } as MeetToolContext);
    expect(result).toBeUndefined();
  });
});
