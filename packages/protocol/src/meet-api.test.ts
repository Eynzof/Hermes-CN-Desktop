import { describe, expect, it } from "vitest";
import {
  MeetActivePointer,
  MeetBotStatus,
  MeetJoinInput,
  MeetJoinResult,
  MeetLeaveInput,
  MeetMode,
  MeetSayInput,
  MeetStatusResult,
  MeetTranscriptInput,
  MeetTranscriptResult,
  MeetTranscriptLine,
} from "./meet-api";

describe("MeetActivePointer", () => {
  it("parses a valid active pointer", () => {
    const parsed = MeetActivePointer.parse({
      meetingId: "abc-defg-hij",
      outDir: "/tmp/meetings/abc-defg-hij",
      url: "https://meet.google.com/abc-defg-hij",
      startedAt: "2026-01-01T00:00:00Z",
      mode: "transcribe",
    });
    expect(parsed.meetingId).toBe("abc-defg-hij");
    expect(parsed.mode).toBe("transcribe");
  });

  it("defaults mode to transcribe", () => {
    const parsed = MeetActivePointer.parse({
      meetingId: "abc",
      outDir: "/tmp",
      url: "https://meet.google.com/abc",
      startedAt: "2026-01-01T00:00:00Z",
    });
    expect(parsed.mode).toBe("transcribe");
  });
});

describe("MeetMode", () => {
  it("accepts known modes", () => {
    expect(MeetMode.parse("transcribe")).toBe("transcribe");
    expect(MeetMode.parse("realtime")).toBe("realtime");
  });

  it("rejects unknown modes", () => {
    expect(() => MeetMode.parse("unknown")).toThrow();
  });
});

describe("MeetJoinInput", () => {
  it("requires a url", () => {
    const parsed = MeetJoinInput.parse({
      url: "https://meet.google.com/abc-defg-hij",
      guest_name: "Test Bot",
    });
    expect(parsed.url).toBe("https://meet.google.com/abc-defg-hij");
    expect(parsed.mode).toBe("transcribe");
  });

  it("defaults guest_name and mode", () => {
    const parsed = MeetJoinInput.parse({ url: "https://meet.google.com/new" });
    expect(parsed.mode).toBe("transcribe");
    expect(parsed.guest_name).toBe("Hermes Agent");
  });
});

describe("MeetTranscriptLine", () => {
  it("parses a transcript line entry", () => {
    const parsed = MeetTranscriptLine.parse({
      ts: "10:05:01",
      speaker: "Alice",
      text: "Hello",
    });
    expect(parsed.speaker).toBe("Alice");
    expect(parsed.text).toBe("Hello");
  });
});

describe("MeetResult schemas", () => {
  it("parses join result", () => {
    const parsed = MeetJoinResult.parse({ success: true, meeting_id: "abc" });
    expect(parsed.success).toBe(true);
    expect(parsed.meeting_id).toBe("abc");
  });

  it("parses status result", () => {
    const parsed = MeetStatusResult.parse({
      success: true,
      active: true,
      status: { meetingId: "abc", inCall: true },
    });
    expect(parsed.active).toBe(true);
    expect(parsed.status?.inCall).toBe(true);
  });

  it("parses transcript result", () => {
    const parsed = MeetTranscriptResult.parse({
      success: true,
      lines: [{ ts: "10:05", speaker: "A", text: "hi" }],
    });
    expect(parsed.lines).toHaveLength(1);
  });

  it("parses leave input with defaults", () => {
    const parsed = MeetLeaveInput.parse({});
    expect(parsed.reason).toBe("user request");
  });

  it("requires text in say input", () => {
    const parsed = MeetSayInput.parse({ text: "hello" });
    expect(parsed.text).toBe("hello");
  });

  it("parses transcript input with last", () => {
    const parsed = MeetTranscriptInput.parse({ last: 10 });
    expect(parsed.last).toBe(10);
  });
});

describe("MeetBotStatus passthrough", () => {
  it("keeps arbitrary bot status keys", () => {
    const parsed = MeetBotStatus.parse({
      meetingId: "abc",
      customField: "value",
    });
    expect(parsed.customField).toBe("value");
  });
});
