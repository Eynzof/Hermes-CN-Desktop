// 与 pill.test.tsx 同款：ReactDOMServer.renderToStaticMarkup，不引 jsdom /
// @testing-library，只锁统一 Loading 的无障碍语义与文案。
import ReactDOMServer from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MessageSkeleton } from "./message-skeleton";

describe("MessageSkeleton", () => {
  it("renders an accessible loading status container", () => {
    const html = ReactDOMServer.renderToStaticMarkup(<MessageSkeleton />);
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("正在加载对话…");
  });

  it("uses the shared loading indicator instead of a pulsing skeleton", () => {
    const html = ReactDOMServer.renderToStaticMarkup(<MessageSkeleton />);
    expect(html).toContain("<svg");
    expect(html).not.toContain("skeleton-pulse");
  });
});
