import { describe, it, expect, vi } from "vitest";
import { convertBase64ImagesToLinks, truncateWithFooter, clampExtractCharLimit, storeFullText } from "./truncate.js";

describe("truncate", () => {
  it("converts base64 <img> to [IMAGE] placeholders", () => {
    const html = `<p><img src="data:image/png;base64,ABC" alt="diagram"></p><img src="data:image/jpeg;base64,DEF">`;
    const out = convertBase64ImagesToLinks(html);
    expect(out).toContain("[IMAGE: diagram]");
    expect(out).toContain("[IMAGE]");
    expect(out).not.toContain("data:image");
  });

  it("returns whole text when under char limit", async () => {
    const text = "short text";
    const result = await truncateWithFooter(text, 100);
    expect(result.text).toBe(text);
    expect(result.wasTruncated).toBe(false);
  });

  it("truncates long text with head+tail and footer", async () => {
    const text = Array.from({ length: 20 }, (_, i) => `line-${i}`).join("\n");
    const result = await truncateWithFooter(text, 80);
    expect(result.wasTruncated).toBe(true);
    expect(result.text).toContain("[TRUNCATED");
    expect(result.text).toContain("line-0");
    expect(result.text).toContain("line-19");
  });

  it("snaps truncation to line boundaries", async () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line-${i}`);
    const text = lines.join("\n");
    const result = await truncateWithFooter(text, 45); // mid line-4
    expect(result.text.startsWith("line-0")).toBe(true);
    expect(result.text).toContain("line-9");
    expect(result.text).not.toContain("line-4");
  });

  it("clamps extract_char_limit", () => {
    expect(clampExtractCharLimit(undefined)).toBe(15_000);
    expect(clampExtractCharLimit(1000)).toBe(2000);
    expect(clampExtractCharLimit(600_000)).toBe(500_000);
  });

  it("stores full text when bridge available", async () => {
    const store = vi.fn().mockResolvedValue({ path: "/tmp/cache/web/example-abc.md", storedChars: 3, truncated: false });
    (globalThis as any).hermesDesktop = { webStoreFullText: store };
    const path = await storeFullText("https://example.com/a", "abc");
    expect(path).toContain("example-");
    expect(store).toHaveBeenCalledOnce();
    delete (globalThis as any).hermesDesktop;
  });
});