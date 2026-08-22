import { describe, expect, it } from "vitest";
import {
  isSafeMeetUrl,
  meetingIdFromUrl,
  normalizeMeetingId,
  parseDurationMinutes,
  looksLikeHumanSpeaker,
} from "./url-gate";

describe("isSafeMeetUrl", () => {
  it("accepts valid meet codes", () => {
    expect(isSafeMeetUrl("https://meet.google.com/abc-defg-hij")).toBe(true);
    expect(isSafeMeetUrl("https://meet.google.com/abc-defg-hij")).toBe(true);
    expect(isSafeMeetUrl("https://meet.google.com/lookup/abc-defg-hij")).toBe(true);
    expect(isSafeMeetUrl("https://meet.google.com/new")).toBe(true);
    expect(isSafeMeetUrl("https://meet.google.com/abc-defg-hij?authuser=0")).toBe(true);
  });

  it("rejects non-https, wrong hosts, and malformed ids", () => {
    expect(isSafeMeetUrl("http://meet.google.com/abc-defg-hij")).toBe(false);
    expect(isSafeMeetUrl("https://meet.google.com/")).toBe(false);
    expect(isSafeMeetUrl("https://example.com/abc-defg-hij")).toBe(false);
    expect(isSafeMeetUrl("")).toBe(false);
    expect(isSafeMeetUrl("not a url")).toBe(false);
  });
});

describe("meetingIdFromUrl", () => {
  it("extracts normalized ids", () => {
    expect(meetingIdFromUrl("https://meet.google.com/abc-defg-hij")).toBe("abcdefghij");
    expect(meetingIdFromUrl("https://meet.google.com/lookup/abc-defg-hij")).toBe("abcdefghij");
  });

  it("returns a synthetic id for /new", () => {
    const id = meetingIdFromUrl("https://meet.google.com/new");
    expect(id).toMatch(/^new-\d+$/);
  });

  it("returns undefined for unparseable urls", () => {
    expect(meetingIdFromUrl("https://meet.google.com/")).toBeUndefined();
  });
});

describe("normalizeMeetingId", () => {
  it("lowercases and removes dashes", () => {
    expect(normalizeMeetingId("ABC-DEFG-HIJ")).toBe("abcdefghij");
    expect(normalizeMeetingId("abc def")).toBe("abc def");
  });
});

describe("parseDurationMinutes", () => {
  it("parses numbers as minutes", () => {
    expect(parseDurationMinutes(30)).toBe(30);
    expect(parseDurationMinutes("45")).toBe(45);
  });

  it("parses hour and minute suffixes", () => {
    expect(parseDurationMinutes("1h")).toBe(60);
    expect(parseDurationMinutes("30m")).toBe(30);
  });

  it("returns undefined for invalid values", () => {
    expect(parseDurationMinutes(undefined)).toBeUndefined();
    expect(parseDurationMinutes("")).toBeUndefined();
    expect(parseDurationMinutes("abc")).toBeUndefined();
    expect(parseDurationMinutes(-5)).toBeUndefined();
  });
});

describe("looksLikeHumanSpeaker", () => {
  it("allows human speakers", () => {
    expect(looksLikeHumanSpeaker("Alice", "Hermes Agent")).toBe(true);
    expect(looksLikeHumanSpeaker("Hermes Agent", "Hermes Agent")).toBe(false);
    expect(looksLikeHumanSpeaker("You", "Hermes Agent")).toBe(false);
  });
});
