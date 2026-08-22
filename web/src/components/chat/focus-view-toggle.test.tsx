// @vitest-environment jsdom
import ReactDOMServer from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FocusViewToggle } from "./focus-view-toggle";

describe("FocusViewToggle", () => {
  it("renders a focus-view toggle button", () => {
    const html = ReactDOMServer.renderToStaticMarkup(<FocusViewToggle />);
    expect(html).toContain("焦点视图");
    expect(html).toContain("button");
  });
});
