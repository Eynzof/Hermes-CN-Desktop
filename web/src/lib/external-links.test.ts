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
    expect(normalizeExternalUrl("obsidian://open?vault=Hermes&file=Twitter%20%E6%97%B6%E9%97%B4%E7%BA%BF")).toBe(
      "obsidian://open?vault=Hermes&file=Twitter%20%E6%97%B6%E9%97%B4%E7%BA%BF",
    );
  });

  it("rejects non-browser schemes", () => {
    expect(normalizeExternalUrl("file:///etc/passwd")).toBeNull();
    expect(normalizeExternalUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeExternalUrl("tauri://localhost")).toBeNull();
    expect(normalizeExternalUrl("obsidian:open")).toBeNull();
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
