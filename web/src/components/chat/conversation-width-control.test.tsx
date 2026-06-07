import ReactDOMServer from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ConversationWidthControl } from "./conversation-width-control";

describe("ConversationWidthControl", () => {
  it("renders the four width choices and marks the current value", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      <ConversationWidthControl value="medium" onChange={() => {}} />,
    );

    expect(html).toContain("aria-label=\"对话宽度\"");
    expect(html).toContain("data-width-value=\"small\"");
    expect(html).toContain("data-width-value=\"medium\"");
    expect(html).toContain("data-width-value=\"large\"");
    expect(html).toContain("data-width-value=\"full\"");
    expect(html).toContain("data-width-value=\"medium\" title=\"对话宽度：中等宽度（medium）\"");
    expect(html).toContain("aria-checked=\"true\"");
  });
});
