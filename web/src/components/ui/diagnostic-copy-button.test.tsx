import ReactDOMServer from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DiagnosticCopyButton } from "./diagnostic-copy-button";

describe("DiagnosticCopyButton", () => {
  it("固定使用 md 尺寸和 outline 外观", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      <DiagnosticCopyButton text="{}" />,
    );

    expect(html).toContain('data-diagnostic-copy="true"');
    expect(html).toContain('data-variant="outline"');
    expect(html).toContain('data-size="md"');
    expect(html).toContain("复制诊断 JSON");
  });
});
