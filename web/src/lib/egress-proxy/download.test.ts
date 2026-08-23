import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadText } from "./download";

describe("downloadText", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the response body text on success", async () => {
    const fetchImpl = vi.fn(async () => new Response("hello world", { status: 200 }));
    await expect(downloadText("https://example.test/a.txt", fetchImpl)).resolves.toBe("hello world");
    expect(fetchImpl).toHaveBeenCalledWith("https://example.test/a.txt");
  });

  it("throws with the status code on non-ok responses", async () => {
    const fetchImpl = vi.fn(async () => new Response("missing", { status: 404 }));
    await expect(downloadText("https://example.test/a.txt", fetchImpl)).rejects.toThrow(
      "download failed: 404",
    );
  });

  it("throws for server errors too", async () => {
    const fetchImpl = vi.fn(async () => new Response("boom", { status: 500 }));
    await expect(downloadText("https://example.test/a.txt", fetchImpl)).rejects.toThrow(
      "download failed: 500",
    );
  });

  it("propagates network failures from fetch", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(downloadText("https://example.test/a.txt", fetchImpl)).rejects.toThrow(
      "Failed to fetch",
    );
  });

  it("propagates body read failures", async () => {
    const fetchImpl = vi.fn(async () => {
      const response = new Response("x", { status: 200 });
      vi.spyOn(response, "text").mockRejectedValueOnce(new Error("stream interrupted"));
      return response;
    });
    await expect(downloadText("https://example.test/a.txt", fetchImpl)).rejects.toThrow(
      "stream interrupted",
    );
  });

  it("uses the global fetch when no fetchImpl is provided", async () => {
    const globalFetch = vi.fn(async () => new Response("global", { status: 200 }));
    vi.stubGlobal("fetch", globalFetch);
    await expect(downloadText("https://example.test/a.txt")).resolves.toBe("global");
    expect(globalFetch).toHaveBeenCalledWith("https://example.test/a.txt");
  });
});
