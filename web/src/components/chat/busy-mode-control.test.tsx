// @vitest-environment jsdom
import ReactDOMServer from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BusyModeControl } from "./busy-mode-control";

describe("BusyModeControl", () => {
  it("renders a radiogroup with all three modes", () => {
    const html = ReactDOMServer.renderToStaticMarkup(<BusyModeControl />);
    expect(html).toContain("中断");
    expect(html).toContain("排队");
    expect(html).toContain("引导");
    expect(html).toContain('role="radiogroup"');
  });
});
