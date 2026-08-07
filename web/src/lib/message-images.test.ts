import { describe, expect, it } from "vitest";
import { extractImagePartsFromUnknown, extractMarkdownImageParts, normalizeLocalFilePath } from "./message-images";

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
});
