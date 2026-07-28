import ReactDOMServer from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { HERMES_PERSONA_TAB_LABEL, HermesPersonaEditor } from "./soul";

describe("HermesPersonaEditor", () => {
  it("renames the custom personality tab", () => {
    expect(HERMES_PERSONA_TAB_LABEL).toBe("Hermes 人格");
  });

  it("keeps editing while removing preview and template insertion controls", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      <HermesPersonaEditor
        exists
        text="# 我的 Hermes 人格"
        dirty
        over={false}
        saving={false}
        saved={false}
        onTextChange={vi.fn()}
        onSave={vi.fn()}
      />,
    );

    expect(html).toContain("编辑");
    expect(html).toContain("# 我的 Hermes 人格");
    expect(html).toContain("保存人格");
    expect(html).not.toContain("预览");
    expect(html).not.toContain("插入模板");
  });
});
