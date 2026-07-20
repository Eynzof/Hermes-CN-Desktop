import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareComposerPrompt, stripHermesUiWorkspaceContext } from "./composer-prompt";

// Minimal FileReader for the node test env (no DOM): turns a File-like into a
// data URL so the image-bytes path can be exercised.
class FakeFileReader {
  result: string | null = null;
  private onLoad: (() => void) | null = null;
  addEventListener(type: string, cb: () => void) {
    if (type === "load") this.onLoad = cb;
  }
  readAsDataURL(file: { type: string; arrayBuffer: () => Promise<ArrayBuffer> }) {
    void file.arrayBuffer().then((buf) => {
      this.result = `data:${file.type};base64,${Buffer.from(buf).toString("base64")}`;
      this.onLoad?.();
    });
  }
}

describe("composer prompt preparation", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("attaches an in-browser image File via image.attach_bytes, never REST upload", async () => {
    vi.stubGlobal("FileReader", FakeFileReader);
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const file = {
      name: "pasted.png",
      type: "image/png",
      arrayBuffer: async () => bytes.buffer,
    } as unknown as File;
    const attachImageBytes = vi.fn(async () => ({
      attached: true,
      text: "[User attached image: pasted.png]",
      name: "pasted.png",
      path: "/img/pasted.png",
    }));
    const uploadFile = vi.fn();
    const attachImage = vi.fn();

    const result = await prepareComposerPrompt(
      "s1",
      {
        text: "看看这张图",
        attachments: [{
          id: "a1",
          source: "browser",
          file,
          name: "pasted.png",
          kind: "image",
          status: "ready",
          mimeType: "image/png",
        }],
      },
      { attachImage, attachImageBytes, uploadFile, detectDroppedPath: vi.fn() },
    );

    // Bytes go over the gateway; the fork-only REST /api/upload is never touched.
    expect(attachImageBytes).toHaveBeenCalledWith("s1", "AQIDBA==", "pasted.png");
    expect(uploadFile).not.toHaveBeenCalled();
    expect(attachImage).not.toHaveBeenCalled();
    expect(result.promptText).toContain("[Hermes UI Image]");
    expect(result.displayText).toBe("看看这张图\n\n附件：pasted.png");
  });

  it("in remote mode, a path-only image uploads its bytes (image.attach_bytes), not the path", async () => {
    const readImageBytes = vi.fn(async () => ({
      contentBase64: "QUJD",
      filename: "screenshot.png",
    }));
    const attachImageBytes = vi.fn(async () => ({
      attached: true,
      text: "[User attached image: screenshot.png]",
      name: "screenshot.png",
      path: "/remote/img/screenshot.png",
    }));
    const attachImage = vi.fn();

    const result = await prepareComposerPrompt(
      "s1",
      {
        text: "看看这张图",
        attachments: [{
          id: "a1",
          source: "path",
          path: "/home/me/screenshot.png",
          name: "screenshot.png",
          kind: "image",
          status: "ready",
        }],
      },
      { attachImage, attachImageBytes, remote: true, readImageBytes, detectDroppedPath: vi.fn() },
    );

    // The remote gateway can't read the client path, so bytes are read locally
    // and uploaded — image.attach{path} is never used.
    expect(readImageBytes).toHaveBeenCalledWith("/home/me/screenshot.png");
    expect(attachImageBytes).toHaveBeenCalledWith("s1", "QUJD", "screenshot.png");
    expect(attachImage).not.toHaveBeenCalled();
    expect(result.promptText).toContain("[Hermes UI Image]");
  });

  it("in local mode, a path image still attaches by path (image.attach), no byte read", async () => {
    const attachImageBytes = vi.fn();
    const readImageBytes = vi.fn();
    const attachImage = vi.fn(async () => ({
      attached: true,
      text: "[User attached image: local.png]",
      name: "local.png",
    }));

    await prepareComposerPrompt(
      "s1",
      {
        text: "本地图",
        attachments: [{
          id: "a1",
          source: "path",
          path: "/home/me/local.png",
          name: "local.png",
          kind: "image",
          status: "ready",
        }],
      },
      { attachImage, attachImageBytes, remote: false, readImageBytes, detectDroppedPath: vi.fn() },
    );

    expect(attachImage).toHaveBeenCalledWith("s1", "/home/me/local.png");
    expect(attachImageBytes).not.toHaveBeenCalled();
    expect(readImageBytes).not.toHaveBeenCalled();
  });

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

  it("uses a dispatched skill invocation as transport text without changing display text", async () => {
    const result = await prepareComposerPrompt(
      "s1",
      {
        text: "/codex 修复类型错误",
        attachments: [],
      },
      {
        attachImage: vi.fn(),
        detectDroppedPath: vi.fn(),
      },
      {
        transportText: "[Skill: codex]\n修复类型错误",
      },
    );

    expect(result.promptText).toContain("[Skill: codex]");
    expect(result.promptText).toContain("修复类型错误");
    expect(result.promptText).not.toContain("/codex 修复类型错误");
    expect(result.displayText).toBe("/codex 修复类型错误");
  });

  it("strips full-description image preamble", () => {
    const input = `[The user attached an image. Here's what it contains:\nA screenshot of a dashboard with charts.]\n[If you need a closer look, use vision_analyze with image_url: /tmp/img.png]\n\nWhat do you see?`;
    const result = stripHermesUiWorkspaceContext(input);
    expect(result).not.toContain("[The user attached an image");
    expect(result).toContain("What do you see?");
  });

  it("strips short-fallback image preamble (existing behavior)", () => {
    const input = `[The user attached an image.]\n[You can examine it with vision_analyze using image_url: /tmp/img.png]\n\nDescribe this.`;
    const result = stripHermesUiWorkspaceContext(input);
    expect(result).not.toContain("[The user attached an image");
    expect(result).toContain("Describe this.");
  });

  it("strips failed-analysis preamble", () => {
    const input = `[The user attached an image but analysis failed.]\n[You can examine it with vision_analyze using image_url: /tmp/img.png]\n\nTry again.`;
    const result = stripHermesUiWorkspaceContext(input);
    expect(result).not.toContain("[The user attached an image");
    expect(result).toContain("Try again.");
  });

  it("preserves normal text without image metadata", () => {
    const input = "Just a normal message.";
    expect(stripHermesUiWorkspaceContext(input)).toBe("Just a normal message.");
  });
});
