import { describe, expect, it, vi } from "vitest";
import { prepareComposerPrompt, stripHermesUiWorkspaceContext } from "./composer-prompt";

describe("composer prompt preparation", () => {
  it("includes image attach/vision text in the transport prompt but hides it from display text", async () => {
    const result = await prepareComposerPrompt(
      "s1",
      {
        text: "这张图说明了什么？",
        attachments: [{
          id: "a1",
          source: "path",
          path: "/tmp/screenshot.png",
          name: "screenshot.png",
          kind: "image",
          status: "ready",
        }],
      },
      {
        attachImage: vi.fn(async () => ({ attached: true, text: "图中是一张任务管理看板。", name: "screenshot.png" })),
        detectDroppedPath: vi.fn(),
      },
    );

    expect(result.promptText).toContain("[Hermes UI Image]");
    expect(result.promptText).toContain("图中是一张任务管理看板。");
    expect(result.promptText.endsWith("这张图说明了什么？")).toBe(true);
    expect(result.displayText).toBe("这张图说明了什么？\n\n附件：screenshot.png");
    expect(stripHermesUiWorkspaceContext(result.promptText)).toBe(result.displayText);
  });

  it("hides legacy image analysis prompt blocks from rendered stored user messages", () => {
    const legacyPrompt = [
      "[User attached image: ga.png]",
      "This image shows a Google Analytics 4 dashboard.",
      "",
      "Header Section",
      "Navigation and metrics are visible.",
      "",
      "阅读这张图片的内容",
    ].join("\n");

    expect(stripHermesUiWorkspaceContext(legacyPrompt)).toBe("阅读这张图片的内容\n\n附件：ga.png");
  });

  it("hides image fallback preamble plus internal image/workspace blocks from stored prompts", () => {
    const storedPrompt = [
      "[The user attached an image but analysis failed.]",
      "[You can examine it with vision_analyze using image_url: /Users/enzo/Downloads/ga.png]",
      "",
      "[Hermes UI Workspace]",
      "workspace=/Users/enzo/Documents/GithubProjects/hermes/hermes-agent-cn-desktop",
      "instruction=Treat this as the active workspace/root for file paths and shell commands.",
      "[/Hermes UI Workspace]",
      "",
      "[Hermes UI Image]",
      "name=ga.png",
      "description:",
      "[User attached image: ga.png]",
      "[/Hermes UI Image]",
      "",
      "看一下这张图里面是什么内容",
    ].join("\n");

    expect(stripHermesUiWorkspaceContext(storedPrompt)).toBe("看一下这张图里面是什么内容\n\n附件：ga.png");
  });
});
