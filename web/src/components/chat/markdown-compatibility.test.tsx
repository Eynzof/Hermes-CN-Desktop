import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

it("loads Markdown with lookbehind constructors unavailable and preserves GFM text", async () => {
  // Safari 15 rejects the constructors that previously prevented app startup.
  const guardedRegExp = new Proxy(RegExp, {
    construct(target, args) {
      if (typeof args[0] === "string" && /\(\?<([=!])/.test(args[0])) {
        throw new SyntaxError("Lookbehind is unavailable");
      }
      return Reflect.construct(target, args);
    },
  });
  vi.stubGlobal("RegExp", guardedRegExp);
  try {
    const { MarkdownText } = await import("./markdown-renderer");
    const html = renderToStaticMarkup(<MarkdownText streaming text={
      "Contact a+b@example.com and next@example.org.\n\n中文~字符 and a~b~c; `x~y`; ~~deleted~~"
    } />);
    expect(html).toContain('href="mailto:a+b@example.com"');
    expect(html).toContain('href="mailto:next@example.org"');
    expect(html).toContain("中文~字符 and a~b~c");
    expect(html).toContain("x~y");
    expect(html).toContain("<del>deleted</del>");
    expect(html).not.toContain('href="mailto:字符');
  } finally {
    vi.unstubAllGlobals();
  }
});
