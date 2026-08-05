import { describe, expect, it } from "vitest";
import {
  expandMediaDirectives,
  extractVideoPartsFromUnknown,
  safeVideoSrc,
  splitMediaDirectives,
  videoSourceNeedsConsent,
} from "./message-media";
import { safeImageSrc } from "./message-images";

describe("splitMediaDirectives", () => {
  it("turns standalone Windows image and video tags into ordered message parts", () => {
    const parts = splitMediaDirectives([
      "图片和视频如下：",
      "MEDIA:C:\\Users\\TU\\Desktop\\86版美猴王无尾版.png",
      'MEDIA:"C:\\Users\\TU\\Desktop\\demo clip.mp4"',
      "已经生成。",
    ].join("\n"));

    expect(parts).toEqual([
      { type: "text", text: "图片和视频如下：" },
      expect.objectContaining({
        type: "image",
        url: "C:\\Users\\TU\\Desktop\\86版美猴王无尾版.png",
      }),
      expect.objectContaining({
        type: "video",
        url: "C:\\Users\\TU\\Desktop\\demo clip.mp4",
      }),
      { type: "text", text: "已经生成。" },
    ]);
  });

  it("keeps MEDIA examples inside fenced code as ordinary text", () => {
    const text = [
      "示例：",
      "```text",
      "MEDIA:C:\\Users\\TU\\Desktop\\example.mp4",
      "```",
    ].join("\n");

    expect(splitMediaDirectives(text)).toEqual([{ type: "text", text }]);
  });

  it("does not close a longer backtick fence with a shorter run", () => {
    const text = [
      "````text",
      "```",
      "MEDIA:C:\\Users\\TU\\Desktop\\example.mp4",
      "````",
    ].join("\n");

    expect(splitMediaDirectives(text)).toEqual([{ type: "text", text }]);
  });

  it("keeps four-space and tab-indented MEDIA examples as code", () => {
    const text = [
      "示例：",
      "    MEDIA:C:\\Users\\TU\\Desktop\\space.png",
      "\tMEDIA:C:\\Users\\TU\\Desktop\\tab.mp4",
    ].join("\n");

    expect(splitMediaDirectives(text)).toEqual([{ type: "text", text }]);
  });

  it("keeps fenced MEDIA examples split across adjacent text parts", () => {
    const parts = [
      { type: "text" as const, text: "````text\n```" },
      { type: "text" as const, text: "MEDIA:C:\\media\\inside.mp4\n````" },
    ];

    expect(expandMediaDirectives(parts)).toEqual(parts);
  });

  it("keeps unsupported and relative directives visible", () => {
    const text = [
      "MEDIA:C:\\Users\\TU\\Desktop\\notes.txt",
      "MEDIA:relative/video.mp4",
    ].join("\n");

    expect(splitMediaDirectives(text)).toEqual([{ type: "text", text }]);
  });

  it("recognizes formats supported across the desktop media pipeline", () => {
    const imageExtensions = ["bmp", "gif", "ico", "jpeg", "jpg", "png", "webp"];
    const videoExtensions = ["avi", "m4v", "mkv", "mov", "mp4", "mpeg", "mpg", "ogv", "webm"];
    const text = [
      ...imageExtensions.map((extension) => `MEDIA:C:\\media\\image.${extension}`),
      ...videoExtensions.map((extension) => `MEDIA:C:\\media\\video.${extension}`),
    ].join("\n");

    expect(splitMediaDirectives(text).map((part) => part.type)).toEqual([
      ...imageExtensions.map(() => "image"),
      ...videoExtensions.map(() => "video"),
    ]);
  });

  it("leaves unsupported image formats and SVG directives visible as text", () => {
    const text = ["apng", "avif", "heic", "heif", "svg", "tif", "tiff"]
      .map((extension) => `MEDIA:C:\\media\\image.${extension}`)
      .join("\n");

    expect(splitMediaDirectives(text)).toEqual([{ type: "text", text }]);
    expect(safeImageSrc("data:image/svg+xml;base64,PHN2Zy8+")).toBeUndefined();
  });
});

describe("video source handling", () => {
  it("extracts structured video payloads", () => {
    expect(extractVideoPartsFromUnknown({
      type: "video",
      video_url: { url: "https://example.test/demo.webm" },
      title: "演示",
      mime_type: "video/webm",
    })).toEqual([
      expect.objectContaining({
        type: "video",
        url: "https://example.test/demo.webm",
        title: "演示",
        mimeType: "video/webm",
      }),
    ]);
  });

  it("allows browser-safe video sources and rejects local schemes", () => {
    expect(safeVideoSrc("data:video/mp4;base64,AAAA")).toBe("data:video/mp4;base64,AAAA");
    expect(safeVideoSrc("https://example.test/demo.mp4")).toBe("https://example.test/demo.mp4");
    expect(safeVideoSrc("data:video/svg+xml;base64,PHN2Zy8+")).toBeUndefined();
    expect(safeVideoSrc("file:///Users/me/demo.mp4")).toBeUndefined();
    expect(safeVideoSrc("javascript:alert(1)")).toBeUndefined();
  });

  it("requires consent before a message source can make a request", () => {
    expect(videoSourceNeedsConsent("https://example.test/demo.mp4")).toBe(true);
    expect(videoSourceNeedsConsent("/api/probe.mp4")).toBe(true);
    expect(videoSourceNeedsConsent("relative/probe.mp4")).toBe(true);
    expect(videoSourceNeedsConsent("blob:https://app.test/id")).toBe(false);
    expect(videoSourceNeedsConsent("data:video/mp4;base64,AAAA")).toBe(false);
  });
});
