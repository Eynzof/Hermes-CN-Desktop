import { describe, expect, it } from "vitest";
import { extractVideoPartsFromUnknown, videoPartFromSource } from "./message-videos";

describe("videoPartFromSource", () => {
  it("parses a video URL string", () => {
    const part = videoPartFromSource("https://example.com/clip.mp4");
    expect(part).toEqual({
      type: "video",
      url: "https://example.com/clip.mp4",
      name: "clip.mp4",
      alt: "clip.mp4",
    });
  });

  it("parses a video data URL", () => {
    const part = videoPartFromSource("data:video/mp4;base64,AAA");
    expect(part).toEqual({ type: "video", url: "data:video/mp4;base64,AAA" });
  });

  it("parses a record with video_url object", () => {
    const part = videoPartFromSource({ video_url: { url: "https://example.com/x.webm" }, name: "x" });
    expect(part).toEqual({
      type: "video",
      url: "https://example.com/x.webm",
      name: "x",
      alt: "x",
    });
  });

  it("returns null for non-video strings", () => {
    expect(videoPartFromSource("https://example.com/readme.md")).toBeNull();
  });
});

describe("extractVideoPartsFromUnknown", () => {
  it("extracts from tool output JSON envelope", () => {
    const value = {
      success: true,
      video: "https://cdn.example.com/output.mp4",
      model: "x",
    };
    const parts = extractVideoPartsFromUnknown(value);
    expect(parts).toHaveLength(1);
    expect(parts[0].url).toBe("https://cdn.example.com/output.mp4");
  });

  it("dedupes repeated URLs", () => {
    const value = ["https://x/a.mp4", "https://x/a.mp4", "https://x/b.mp4"];
    const parts = extractVideoPartsFromUnknown(value);
    expect(parts).toHaveLength(2);
  });

  it("returns empty for non-video content", () => {
    expect(extractVideoPartsFromUnknown({ text: "hello" })).toEqual([]);
  });
});
