import ReactDOMServer from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";

import { MarkdownText } from "./markdown-renderer";
import {
  MessageTimeline,
  resolveBottomFollowState,
  shouldDetachOnScroll,
  shouldForceBottomOnMessageChange,
} from "./message-timeline";
import type { ChatMessage } from "./chat-types";

// MessageTimeline 内部的资料卡用到 useNavigate，SSR 渲染需要 Router 上下文。
const renderTimeline = (node: ReactElement) =>
  ReactDOMServer.renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);

const skillInvocationText = [
  '[IMPORTANT: The user has invoked the "codex" skill, indicating they want you to follow its instructions. The full skill content is loaded below.]',
  "",
  "# Codex",
  "",
  "Always use a PTY.",
].join("\n");

describe("MessageTimeline", () => {
  it("keeps bottom auto-follow disabled after an explicit upward scroll", () => {
    expect(resolveBottomFollowState(40, true)).toEqual({
      nearBottom: false,
      userDetachedFromBottom: true,
    });
  });

  it("reattaches bottom auto-follow only after returning to the bottom", () => {
    expect(resolveBottomFollowState(8, true)).toEqual({
      nearBottom: true,
      userDetachedFromBottom: false,
    });
  });

  it("treats a genuine user upward scroll as a bottom-detach gesture", () => {
    expect(shouldDetachOnScroll(800, 1000, false)).toBe(true);
  });

  it("does not detach while a programmatic turn jump animates upward", () => {
    // The smooth scrollTo from scrollToTurn drives scrollTop down too; without the
    // guard handleScroll would cancel its own jump. This locks in the fix.
    expect(shouldDetachOnScroll(800, 1000, true)).toBe(false);
  });

  it("does not detach when scrolling downward", () => {
    expect(shouldDetachOnScroll(1000, 800, false)).toBe(false);
  });

  it("forces bottom positioning when history first loads or the session changes", () => {
    expect(shouldForceBottomOnMessageChange(0, 8, false, undefined, "user-4")).toBe(true);
    expect(shouldForceBottomOnMessageChange(8, 6, true, "user-4", "user-3")).toBe(true);
  });

  it("forces bottom positioning for a newly appended user message", () => {
    expect(shouldForceBottomOnMessageChange(8, 10, false, "user-4", "user-5")).toBe(true);
  });

  it("keeps an upward-scrolled user detached for assistant-only updates", () => {
    expect(shouldForceBottomOnMessageChange(8, 9, false, "user-4", "user-4")).toBe(false);
  });

  it("uses the optimistic progress model instead of stale session usage", () => {
    const messages: ChatMessage[] = [
      {
        id: "assistant-1",
        role: "assistant",
        createdAt: 1,
        status: "streaming",
        blocks: [{ type: "progress", text: "正在唤醒Hermes..." }],
      },
    ];

    const html = renderTimeline(
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

    const html = renderTimeline(
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


  it("renders Obsidian deep links without the blocked indicator", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      <MarkdownText text="[Twitter 时间线](obsidian://open?vault=Hermes&file=Twitter%20%E6%97%B6%E9%97%B4%E7%BA%BF)" />,
    );

    expect(html).toContain("href=\"obsidian://open?vault=Hermes&amp;file=Twitter%20%E6%97%B6%E9%97%B4%E7%BA%BF\"");
    expect(html).toContain("Twitter 时间线");
    expect(html).not.toContain("[blocked]");
  });



  it("renders footnote anchors as in-page links", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      <MarkdownText text={"正文引用[^1]\n\n[^1]: 这里是脚注内容"} />,
    );

    expect(html).toContain('href="#user-content-fn-1"');
    expect(html).toContain('href="#user-content-fnref-1"');
    expect(html).toContain("这里是脚注内容");
    expect(html).not.toContain('target="_blank"');
  });

  it("keeps safe relative Markdown links renderable", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      <MarkdownText text="[内部帮助](/about)" />,
    );

    expect(html).toContain("href=\"/about\"");
    expect(html).toContain("内部帮助");
  });

  it("renders controlled rich inline Markdown formatting", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      <MarkdownText text={'<small style="font-size: 12px; color: #999">06 月 07 日 05:30</small> · <span data-tone="muted" data-size="small">浏览 152</span>'} />,
    );

    expect(html).toContain("06 月 07 日 05:30");
    expect(html).toContain("浏览 152");
    expect(html).toContain("font-size:12px");
    expect(html).toContain("color:#999");
  });

  it("drops unsafe inline styles from rich formatting tags", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      <MarkdownText text={'<span style="background-image: url(javascript:alert(1)); font-size: 200px">日期</span>'} />,
    );

    expect(html).toContain("日期");
    expect(html).not.toContain("javascript");
    expect(html).not.toContain("background-image");
    expect(html).not.toContain("200px");
  });


  it("renders a copy button on fenced code blocks", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      <MarkdownText text={"```ts\nconst value = 1;\n```"} />,
    );

    expect(html).toContain('data-streamdown="code-block-copy-button"');
    expect(html).toContain('title="复制代码"');
  });

  it("does not render code block controls for inline code", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      <MarkdownText text={"行内 `code` 不需要复制按钮"} />,
    );

    expect(html).not.toContain('data-streamdown="code-block-copy-button"');
  });

  it("routes Mermaid fences away from the plain code block renderer", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      <MarkdownText text={"```mermaid\ngraph TD\n  A[开始] --> B{条件判断}\n  B -->|是| C[处理]\n```"} />,
    );

    expect(html).not.toContain('data-language="mermaid"');
    expect(html).not.toContain('data-streamdown="code-block"');
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
    expect(html).toContain('class="katex"');
    expect(html).toContain("style=\"height:");
    expect(html).not.toContain("_richInline");
    expect(html).not.toContain("$\\boldsymbol");
  });

  it("renders TeX parenthesis and bracket math delimiters", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      <MarkdownText
        text={String.raw`两个球体 \(S_1(c_1,r_1)\) 和 \(S_2(c_2,r_2)\) 的条件：\[\|\mathbf{c}_1-\mathbf{c}_2\|\le r_1+r_2\]`}
      />,
    );

    expect(html).toContain("katex");
    expect(html).toContain("katex-display");
    expect(html).not.toContain("\\(");
    expect(html).not.toContain("\\[");
  });

  it("does not normalize TeX delimiters inside code", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      <MarkdownText text={"代码 `\\(x_1\\)` 保持字面量。"} />,
    );

    expect(html).toContain("\\(x_1\\)");
  });

  it("starts resolving local image URLs through the gateway media endpoint", () => {
    const messages: ChatMessage[] = [
      {
        id: "user-image",
        role: "user",
        createdAt: 1,
        images: [{ url: "/Users/enzo/Downloads/chart.png", alt: "chart.png", name: "chart.png" }],
      },
    ];

    const html = renderTimeline(
      <MessageTimeline messages={messages} />,
    );

    expect(html).toContain("图片加载中");
    expect(html).toContain("chart.png");
    expect(html).toContain("/Users/enzo/Downloads/chart.png");
  });

  it("uses an in-app enlargement trigger for a resolved image", () => {
    const messages: ChatMessage[] = [
      {
        id: "assistant-inline-image",
        role: "assistant",
        createdAt: 1,
        images: [{ url: "data:image/png;base64,AAAA", alt: "测试图片" }],
      },
    ];

    const html = renderTimeline(<MessageTimeline messages={messages} />);

    expect(html).toContain("<button");
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain("放大查看图片：测试图片");
    expect(html).not.toContain('target="_blank"><img');
  });

  it("requires consent before rendering a network-backed video", () => {
    const messages: ChatMessage[] = [
      {
        id: "assistant-video",
        role: "assistant",
        createdAt: 1,
        blocks: [{
          type: "video",
          video: { url: "https://example.test/demo.mp4", title: "演示视频" },
        }],
      },
    ];

    const html = renderTimeline(<MessageTimeline messages={messages} />);

    expect(html).not.toContain("<video");
    expect(html).toContain("外部视频已阻止自动加载");
    expect(html).toContain("加载并播放");
    expect(html).toContain("https://example.test/demo.mp4");
  });

  it("renders an inline video payload with native controls", () => {
    const messages: ChatMessage[] = [
      {
        id: "assistant-inline-video",
        role: "assistant",
        createdAt: 1,
        videos: [{ url: "data:video/mp4;base64,AAAA", title: "内联视频" }],
      },
    ];

    const html = renderTimeline(<MessageTimeline messages={messages} />);

    expect(html).toContain("<video");
    expect(html).toContain("controls");
    expect(html).toContain('aria-label="内联视频"');
  });

  it("shows loading state while a local video path is being resolved", () => {
    const messages: ChatMessage[] = [
      {
        id: "assistant-local-video",
        role: "assistant",
        createdAt: 1,
        videos: [{ url: "C:\\Users\\TU\\Desktop\\demo.mp4", name: "demo.mp4" }],
      },
    ];

    const html = renderTimeline(<MessageTimeline messages={messages} />);

    expect(html).toContain("视频加载中");
    expect(html).toContain("demo.mp4");
  });

  it("shows turn navigation for multi-turn conversations", () => {
    const messages: ChatMessage[] = [
      { id: "user-1", role: "user", createdAt: 1, text: "第一轮问题" },
      { id: "assistant-1", role: "assistant", createdAt: 2, text: "第一轮回答" },
      { id: "skill-1", role: "user", createdAt: 2.5, text: skillInvocationText },
      { id: "user-2", role: "user", createdAt: 3, text: "第二轮追问" },
      { id: "assistant-2", role: "assistant", createdAt: 4, text: "第二轮回答" },
    ];

    const html = renderTimeline(
      <MessageTimeline messages={messages} />,
    );

    expect(html).toContain("aria-label=\"对话轮次定位\"");
    expect(html).toContain("aria-label=\"定位到第 1 轮对话\"");
    expect(html).toContain("aria-label=\"定位到第 2 轮对话\"");
    expect(html).not.toContain("aria-label=\"定位到第 3 轮对话\"");
    expect(html.match(/data-turn-anchor=\"true\"/g)).toHaveLength(2);
  });

  it("renders injected Skill content as a full-width system notice without user actions", () => {
    const html = renderTimeline(
      <MessageTimeline
        messages={[{
          id: "skill-1",
          role: "user",
          createdAt: 1,
          text: skillInvocationText,
        }]}
      />,
    );

    expect(html).toContain('data-role="system"');
    expect(html).toContain('data-system-kind="skill-invocation"');
    expect(html).toContain('data-kind="skill-invocation"');
    expect(html).toContain('role="status"');
    expect(html).toContain("Skill 指令已加载");
    expect(html).toContain('data-skill-invocation="true"');
    expect(html).not.toContain('data-role="user"');
    expect(html).not.toContain('data-turn-anchor="true"');
    expect(html).not.toContain("复制");
  });

  it("does not show turn navigation for a single user turn", () => {
    const messages: ChatMessage[] = [
      { id: "user-1", role: "user", createdAt: 1, text: "只有一轮" },
      { id: "assistant-1", role: "assistant", createdAt: 2, text: "回答" },
    ];

    const html = renderTimeline(
      <MessageTimeline messages={messages} />,
    );

    expect(html).not.toContain("对话轮次定位");
  });
  it("falls back to session usage stats for the latest completed assistant message", () => {
    const messages: ChatMessage[] = [
      { id: "user-1", role: "user", createdAt: 1, text: "问题" },
      { id: "assistant-1", role: "assistant", createdAt: 2, status: "complete", text: "回答" },
    ];

    const html = renderTimeline(
      <MessageTimeline
        messages={messages}
        sessionUsage={{
          model: "deepseek-v4-flash",
          input: 900,
          output: 300,
          total: 1200,
          cache_read: 100,
          calls: 1,
        } as any}
      />,
    );

    expect(html).toContain("1.2k");
    expect(html).toContain('title="详细统计"');
  });

  it("renders read-aloud controls only for completed assistant messages", () => {
    const messages: ChatMessage[] = [
      { id: "user-1", role: "user", createdAt: 1, text: "问题" },
      { id: "assistant-1", role: "assistant", createdAt: 2, status: "complete", text: "回答" },
    ];

    const html = renderTimeline(
      <MessageTimeline messages={messages} />,
    );

    expect(html).toContain('title="朗读回复"');
    expect(html).toContain("朗读");
  });

  it("does not render read-aloud controls for user or streaming assistant messages", () => {
    const messages: ChatMessage[] = [
      { id: "user-1", role: "user", createdAt: 1, text: "问题" },
      { id: "assistant-1", role: "assistant", createdAt: 2, status: "streaming", text: "回答中" },
    ];

    const html = renderTimeline(
      <MessageTimeline messages={messages} />,
    );

    expect(html).not.toContain('title="朗读回复"');
  });

});
