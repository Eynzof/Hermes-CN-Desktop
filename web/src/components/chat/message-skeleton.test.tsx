// 与 pill.test.tsx 同款：ReactDOMServer.renderToStaticMarkup，不引 jsdom /
// @testing-library，只锁渲染契约（无障碍语义 + 对话骨架结构）。
import ReactDOMServer from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MessageSkeleton } from "./message-skeleton";

describe("MessageSkeleton", () => {
  it("renders an accessible loading status container", () => {
    const html = ReactDOMServer.renderToStaticMarkup(<MessageSkeleton />);
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-label="加载对话中"');
  });

  it("mimics the conversation layout with user bubbles and assistant lines", () => {
    const html = ReactDOMServer.renderToStaticMarkup(<MessageSkeleton />);
    // 2 组用户气泡 + 2 组助手段落（共 5 行）——结构变了说明骨架被改动，
    // 需要同步确认视觉效果仍接近真实对话布局。
    expect(html.match(/user/g)?.length).toBe(2);
    expect(html.match(/line/g)?.length).toBe(5);
  });
});
