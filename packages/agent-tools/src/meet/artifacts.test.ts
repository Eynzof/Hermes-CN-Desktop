import { describe, expect, it } from "vitest";
import {
  parseTranscript,
  formatTranscript,
  formatTranscriptLine,
  TRANSCRIPT_LINE_RE,
  transcriptTail,
  dedupeKey,
  CaptionStore,
  parseStatus,
  mergeStatus,
  botStatusSummary,
} from "./artifacts";
import type { MeetBotStatus } from "@hermes/protocol";

describe("parseTranscript", () => {
  it("reads formatted lines", () => {
    const raw = "[10:05:01] Alice: Hello everyone\n[10:05:03] Bob: Hi Alice\n";
    const lines = parseTranscript(raw);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual({ ts: "10:05:01", speaker: "Alice", text: "Hello everyone" });
  });

  it("ignores malformed and blank lines", () => {
    const raw = "[10:05:01] Alice: Hello\nnot a caption\n\n[10:05:02] Bob: Hi";
    expect(parseTranscript(raw)).toHaveLength(2);
  });

  it("returns empty for empty input", () => {
    expect(parseTranscript("")).toHaveLength(0);
  });
});

describe("formatTranscript", () => {
  it("round-trips lines", () => {
    const lines = [{ ts: "10:05:01", speaker: "Alice", text: "Hello" }];
    expect(formatTranscript(lines)).toBe("[10:05:01] Alice: Hello");
  });
});

describe("transcriptTail", () => {
  it("returns last N lines", () => {
    const raw = Array.from({ length: 5 }, (_, i) => `[10:0${i}:00] A: ${i}`).join("\n");
    expect(transcriptTail(raw, 2)).toHaveLength(2);
    expect(transcriptTail(raw)).toHaveLength(5);
    expect(transcriptTail(raw, 0)).toHaveLength(5);
  });
});

describe("dedupeKey", () => {
  it("normalizes case and spacing", () => {
    expect(dedupeKey("  Alice  ", " Hello ")).toBe("alice|hello");
  });
});

describe("CaptionStore", () => {
  it("stores unique captions", () => {
    const store = new CaptionStore();
    expect(store.add({ ts: "10:05", speaker: "A", text: "hi" })).toBe(true);
    expect(store.add({ ts: "10:06", speaker: "A", text: "hi" })).toBe(false);
    expect(store.count()).toBe(1);
    expect(store.getLines()).toHaveLength(1);
  });

  it("clears captions", () => {
    const store = new CaptionStore();
    store.add({ ts: "10:05", speaker: "A", text: "hi" });
    store.clear();
    expect(store.count()).toBe(0);
  });
});

describe("parseStatus", () => {
  it("parses valid json", () => {
    const status: MeetBotStatus = { meetingId: "abc", inCall: true };
    expect(parseStatus(JSON.stringify(status))).toEqual(status);
  });

  it("returns undefined for invalid json", () => {
    expect(parseStatus("not json")).toBeUndefined();
  });
});

describe("mergeStatus", () => {
  it("merges active and bot status", () => {
    const active: MeetBotStatus = { meetingId: "abc" };
    const bot: MeetBotStatus = { inCall: true };
    const merged = mergeStatus(active, bot);
    expect(merged?.meetingId).toBe("abc");
    expect(merged?.inCall).toBe(true);
  });

  it("returns undefined when both missing", () => {
    expect(mergeStatus(undefined, undefined)).toBeUndefined();
  });
});

describe("botStatusSummary", () => {
  it("summarizes in-call status", () => {
    expect(botStatusSummary({ meetingId: "abc", inCall: true, captioning: true, transcriptLines: 5 })).toContain(
      "in call",
    );
  });

  it("summarizes lobby waiting", () => {
    expect(botStatusSummary({ meetingId: "abc", lobbyWaiting: true })).toContain("waiting in lobby");
  });

  it("handles missing status", () => {
    expect(botStatusSummary(undefined)).toBe("No meeting status available.");
  });
});

describe("formatTranscriptLine", () => {
  it("formats a transcript line as [ts] speaker: text", () => {
    expect(formatTranscriptLine({ ts: "10:05:01", speaker: "Alice", text: "Hello everyone" })).toBe(
      "[10:05:01] Alice: Hello everyone",
    );
  });
});

describe("TRANSCRIPT_LINE_RE", () => {
  it("matches formatted caption lines and captures ts, speaker, text", () => {
    const match = "[10:05:01] Alice: Hello".match(TRANSCRIPT_LINE_RE);
    expect(match).not.toBeNull();
    expect(match![1]).toBe("10:05:01");
    expect(match![2]).toBe("Alice");
    expect(match![3]).toBe("Hello");
  });

  it("tolerates extra whitespace after brackets and colon", () => {
    const match = "[10:05:01]   Alice   :   Hello  ".match(TRANSCRIPT_LINE_RE);
    expect(match).not.toBeNull();
    expect(match![2]).toBe("Alice   ");
    expect(match![3]).toBe("Hello  ");
  });

  it("rejects malformed lines", () => {
    expect("10:05:01 Alice: Hello".match(TRANSCRIPT_LINE_RE)).toBeNull();
    expect("[10:05] Alice: Hi".match(TRANSCRIPT_LINE_RE)).toBeNull();
    expect("[10:05:01] Alice no colon".match(TRANSCRIPT_LINE_RE)).toBeNull();
  });
});
