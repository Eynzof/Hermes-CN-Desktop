import { describe, expect, it } from "vitest";
import { meetJoin, meetLeave, meetSay, meetSetup, meetStatus, meetTranscript } from "./tools";
import type { MeetToolContext } from "./types";

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
