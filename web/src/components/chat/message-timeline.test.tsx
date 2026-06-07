import ReactDOMServer from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MarkdownText } from "./markdown-renderer";
import { MessageTimeline } from "./message-timeline";
import type { ChatMessage } from "./chat-types";

describe("MessageTimeline", () => {
  it("uses the optimistic progress model instead of stale session usage", () => {
    const messages: ChatMessage[] = [
      {
        id: "assistant-1",
        role: "assistant",
        createdAt: 1,
        status: "streaming",
        blocks: [{ type: "progress", text: "正在启动Hermes Agent内核..." }],
      },
    ];

    const html = ReactDOMServer.renderToStaticMarkup(
      <MessageTimeline
        messages={messages}
        turnStartedAt={1}
        sessionUsage={{ model: "deepseek-v4-flash" } as any}
        progressModel="qwen3.6-plus"
      />,
    );

    expect(html).toContain("qwen3.6-plus");
    expect(html).not.toContain("deepseek-v4-flash");
  });

  it("shows live context tokens instead of cumulative session totals", () => {
    const messages: ChatMessage[] = [
      {
        id: "assistant-1",
        role: "assistant",
        createdAt: 1,
        status: "streaming",
        blocks: [{ type: "progress", text: "正在分析项目..." }],
      },
    ];

    const html = ReactDOMServer.renderToStaticMarkup(
      <MessageTimeline
        messages={messages}
        turnStartedAt={1}
        sessionUsage={{
          model: "deepseek-v4-flash",
          total: 1_033_698,
          input: 1_027_212,
          output: 6_486,
          context_used: 87_382,
        } as any}
      />,
    );

    expect(html).toContain("87.4k tokens");
    expect(html).not.toContain("1.0M tokens");
  });

  it("renders Markdown image syntax as an image preview", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      <MarkdownText text="结果图：![趋势图](https://example.test/chart.png)" />,
    );

    expect(html).toContain("https://example.test/chart.png");
    expect(html).toContain("alt=\"趋势图\"");
  });

  it("renders single-dollar inline LaTeX formulas", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      <MarkdownText text={String.raw`设 $\boldsymbol{v}_i \in \mathbb{R}^n$ 且 $A\boldsymbol{v}_i = \boldsymbol{0}$。`} />,
    );

    expect(html).toContain("katex");
    expect(html).not.toContain("$\\boldsymbol");
  });

  it("shows a readable fallback for unsupported local image URLs", () => {
    const messages: ChatMessage[] = [
      {
        id: "user-image",
        role: "user",
        createdAt: 1,
        images: [{ url: "/Users/enzo/Downloads/chart.png", alt: "chart.png", name: "chart.png" }],
      },
    ];

    const html = ReactDOMServer.renderToStaticMarkup(
      <MessageTimeline messages={messages} />,
    );

    expect(html).toContain("图片暂不能直接预览");
    expect(html).toContain("chart.png");
    expect(html).toContain("/Users/enzo/Downloads/chart.png");
  });

  it("shows turn navigation for multi-turn conversations", () => {
    const messages: ChatMessage[] = [
      { id: "user-1", role: "user", createdAt: 1, text: "第一轮问题" },
      { id: "assistant-1", role: "assistant", createdAt: 2, text: "第一轮回答" },
      { id: "user-2", role: "user", createdAt: 3, text: "第二轮追问" },
      { id: "assistant-2", role: "assistant", createdAt: 4, text: "第二轮回答" },
    ];

    const html = ReactDOMServer.renderToStaticMarkup(
      <MessageTimeline messages={messages} />,
    );

    expect(html).toContain("aria-label=\"对话轮次定位\"");
    expect(html).toContain("aria-label=\"定位到第 1 轮对话\"");
    expect(html).toContain("aria-label=\"定位到第 2 轮对话\"");
  });

  it("does not show turn navigation for a single user turn", () => {
    const messages: ChatMessage[] = [
      { id: "user-1", role: "user", createdAt: 1, text: "只有一轮" },
      { id: "assistant-1", role: "assistant", createdAt: 2, text: "回答" },
    ];

    const html = ReactDOMServer.renderToStaticMarkup(
      <MessageTimeline messages={messages} />,
    );

    expect(html).not.toContain("对话轮次定位");
  });
});
