import { describe, expect, it } from "vitest";
import {
  extractImagePartsFromUnknown,
  extractMarkdownImageParts,
  isLikelyLocalFilePath,
  normalizeLocalFilePath,
  safeImageSrc,
} from "./message-images";

describe("message image extraction", () => {
  it("extracts Markdown image paths that contain spaces", () => {
    const parts = extractMarkdownImageParts(
      "结果：![预览](/Users/enzo/Library/Application Support/cn.org.hermesagent.desktop/runtime/hermes-home/images/out.png)",
    );

    expect(parts).toEqual([{
      type: "image",
      url: "/Users/enzo/Library/Application Support/cn.org.hermesagent.desktop/runtime/hermes-home/images/out.png",
      alt: "预览",
      name: "预览",
    }]);
  });

  it("extracts bare local image paths that contain spaces", () => {
    const parts = extractImagePartsFromUnknown(
      "图片保存在 /Users/enzo/Library/Application Support/cn.org.hermesagent.desktop/runtime/hermes-home/images/out.png",
    );

    expect(parts[0]?.url).toBe(
      "/Users/enzo/Library/Application Support/cn.org.hermesagent.desktop/runtime/hermes-home/images/out.png",
    );
  });

  it("decodes encoded local image paths before media loading", () => {
    expect(normalizeLocalFilePath("/Users/enzo/Library/Application%20Support/out.png"))
      .toBe("/Users/enzo/Library/Application Support/out.png");
  });

  it("recognizes POSIX-style Windows drive paths as local file paths", () => {
    expect(isLikelyLocalFilePath("/D:/Hermes-CN-Desktop/e2e/.runtime/hermes-home/images/model output.png")).toBe(true);
    expect(isLikelyLocalFilePath("/D:/data/shot.png")).toBe(true);
    expect(isLikelyLocalFilePath("/Users/enzo/Downloads/chart.png")).toBe(true);
    expect(isLikelyLocalFilePath("/about")).toBe(false);
  });

  it("keeps POSIX-style Windows drive paths out of the browser-safe src bucket", () => {
    // These are local filesystem paths (rendered by MessageImage through the
    // media bridge), not web-relative URLs, so safeImageSrc must reject them.
    expect(safeImageSrc("/D:/Hermes-CN-Desktop/e2e/.runtime/hermes-home/images/model output.png")).toBeUndefined();
    expect(safeImageSrc("/D:/data/shot.png")).toBeUndefined();
  });

  it("maps POSIX-style Windows drive paths back to the real filesystem path", () => {
    expect(
      normalizeLocalFilePath("/D:/Hermes-CN-Desktop/e2e/.runtime/hermes-home/images/generated%20previews/model%20output.png"),
    ).toBe("D:/Hermes-CN-Desktop/e2e/.runtime/hermes-home/images/generated previews/model output.png");
    expect(normalizeLocalFilePath("/D:/data/shot.png")).toBe("D:/data/shot.png");
  });
});
