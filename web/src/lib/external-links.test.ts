import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeExternalUrl, openExternalUrl } from "./external-links";

afterEach(() => {
  delete (globalThis as any).window;
});

describe("external-links", () => {
  it("normalizes safe browser URLs", () => {
    expect(normalizeExternalUrl(" https://hermesagent.org.cn/docs?q=1 ")).toBe(
      "https://hermesagent.org.cn/docs?q=1",
    );
    expect(normalizeExternalUrl("http://example.com")).toBe("http://example.com/");
    expect(normalizeExternalUrl("mailto:hello@example.com")).toBe("mailto:hello@example.com");
  });

  it("rejects non-browser schemes", () => {
    expect(normalizeExternalUrl("file:///etc/passwd")).toBeNull();
    expect(normalizeExternalUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeExternalUrl("tauri://localhost")).toBeNull();
    expect(normalizeExternalUrl("/advanced/about")).toBeNull();
  });

  it("uses the desktop opener before falling back to window.open", async () => {
    const desktopOpen = vi.fn().mockResolvedValue({ ok: true });
    const fallbackOpen = vi.fn();
    (globalThis as any).window = {
      hermesDesktop: { openExternalUrl: desktopOpen },
      open: fallbackOpen,
    };

    await expect(openExternalUrl("https://hermesagent.org.cn")).resolves.toBe(true);

    expect(desktopOpen).toHaveBeenCalledWith({ url: "https://hermesagent.org.cn/" });
    expect(fallbackOpen).not.toHaveBeenCalled();
  });
});
