import ReactDOMServer from "react-dom/server";
import { describe, expect, it } from "vitest";

import { TopBarActionButton } from "./top-bar";

describe("TopBarActionButton", () => {
  it("固定使用通栏 sm 按钮尺寸", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      <TopBarActionButton>操作</TopBarActionButton>,
    );

    expect(html).toContain('data-size="sm"');
  });
});
