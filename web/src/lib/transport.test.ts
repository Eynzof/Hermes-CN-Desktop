import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { debugBus } from "./debug-bus";
import {
  downloadExternalImageFile,
  fetchExternalJSON,
  fetchJSON,
  fetchMediaDataUrl,
  uploadAttachmentFile,
} from "./transport";

type PushArg = Parameters<typeof debugBus.push>[0];

function restPushesFrom(spy: MockInstance<typeof debugBus.push>): PushArg[] {
  return spy.mock.calls
    .map((call) => call[0])
    .filter((entry): entry is PushArg => entry.type === "rest");
}

// runtime.ts reads `window.__HERMES_RUNTIME__` lazily; vitest's default node
// pool has no `window`. Stub a minimal one so the platform getter resolves
// to "web" and fetchJSON falls into the native fetch branch.
let windowStubbed = false;
beforeAll(() => {
  if (typeof (globalThis as { window?: unknown }).window === "undefined") {
    (globalThis as { window?: unknown }).window = {};
    windowStubbed = true;
  }
});
afterAll(() => {
  if (windowStubbed) {
    delete (globalThis as { window?: unknown }).window;
  }
});

describe("transport · debug-bus integration", () => {
  let pushSpy: MockInstance<typeof debugBus.push>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    debugBus.clear();
    pushSpy = vi.spyOn(debugBus, "push");
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    pushSpy.mockRestore();
    globalThis.fetch = originalFetch;
    delete window.__HERMES_RUNTIME__;
    delete window.__HERMES_SESSION_TOKEN__;
    delete window.__TAURI_INTERNALS__;
    delete window.hermesDesktop;
  });

  function stubFetch(impl: () => Response | Promise<Response>) {
    globalThis.fetch = vi.fn(async () => impl()) as unknown as typeof globalThis.fetch;
  }

  function makeResponse(status: number, body: string): Response {
    return new Response(body, {
      status,
      headers: { "Content-Type": "text/plain" },
    });
  }

  it("fetchJSON pushes a REST entry on non-ok response", async () => {
    stubFetch(() => makeResponse(401, "unauthorized"));

    await expect(fetchJSON("/api/protected")).rejects.toThrow(/HTTP 401/);

    const restPushes = restPushesFrom(pushSpy);
    expect(restPushes.length).toBeGreaterThan(0);
    const last = restPushes[restPushes.length - 1];
    expect(last.level).toBe("error");
    expect(last.summary).toContain("401");
    expect(last.summary).toContain("/api/protected");
    expect(last.payload).toMatchObject({ status: 401, url: "/api/protected" });
  });

  it("fetchJSON does not push when the response is ok", async () => {
    stubFetch(() => makeResponse(200, '{"ok":true}'));

    const out = await fetchJSON<{ ok: boolean }>("/api/x");
    expect(out).toEqual({ ok: true });

    const restPushes = restPushesFrom(pushSpy);
    expect(restPushes.length).toBe(0);
  });

  it("fetchMediaDataUrl loads an encoded gateway image path", async () => {
    stubFetch(() => makeResponse(200, '{"data_url":"data:image/png;base64,QUJD"}'));

    await expect(fetchMediaDataUrl("/Users/me/Hermes images/a 1.png"))
      .resolves.toBe("data:image/png;base64,QUJD");

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/media?path=%2FUsers%2Fme%2FHermes%20images%2Fa%201.png",
      expect.objectContaining({ headers: { "Content-Type": "application/json" } }),
    );
  });

  it("fetchMediaDataUrl rejects a malformed media response", async () => {
    stubFetch(() => makeResponse(200, '{"data_url":"https://example.com/not-inline.png"}'));

    await expect(fetchMediaDataUrl("/tmp/a.png")).rejects.toThrow(/image data URL/);
  });

  it("fetchExternalJSON pushes a REST entry on non-ok response", async () => {
    stubFetch(() => makeResponse(404, "not found"));

    await expect(
      fetchExternalJSON("https://provider.example/v1/models"),
    ).rejects.toThrow(/HTTP 404/);

    const restPushes = restPushesFrom(pushSpy);
    expect(restPushes.length).toBeGreaterThan(0);
    const last = restPushes[restPushes.length - 1];
    expect(last.summary).toContain("404");
    expect(last.summary).toContain("provider.example");
  });

  it("fetchExternalJSON pushes a REST entry on network/timeout failure", async () => {
    // Simulate timeout / network error — fetch rejects.
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("network failed");
    }) as unknown as typeof globalThis.fetch;

    await expect(
      fetchExternalJSON("https://provider.example/v1/models"),
    ).rejects.toThrow();

    const restPushes = restPushesFrom(pushSpy);
    expect(restPushes.length).toBeGreaterThan(0);
  });

  it("fetchJSON routes local cron history through desktop request on Tauri without apiBaseUrl", async () => {
    const request = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: {},
      body: JSON.stringify({ job_id: "job1", profile: "default", runs: [] }),
    }));
    globalThis.fetch = vi.fn(async () => makeResponse(500, "should not fetch")) as unknown as typeof globalThis.fetch;
    window.__HERMES_RUNTIME__ = { platform: "tauri" };
    window.hermesDesktop = {
      windowType: "tauri",
      request,
    };

    const out = await fetchJSON<{ runs: unknown[] }>("/__hermes_cron_runs/default/job1?limit=30");

    expect(out).toEqual({ job_id: "job1", profile: "default", runs: [] });
    expect(request).toHaveBeenCalledWith({
      path: "/__hermes_cron_runs/default/job1?limit=30",
      method: undefined,
      headers: { "Content-Type": "application/json" },
      body: null,
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("fetchExternalJSON uses desktop externalRequest capability on Tauri", async () => {
    const externalRequest = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: {},
      body: '{"models":[{"id":"m1"}]}',
    }));
    globalThis.fetch = vi.fn(async () => makeResponse(500, "should not fetch")) as unknown as typeof globalThis.fetch;
    window.__HERMES_RUNTIME__ = { platform: "tauri" };
    window.hermesDesktop = {
      windowType: "tauri",
      request: vi.fn(),
      externalRequest,
    };

    const out = await fetchExternalJSON<{ models: Array<{ id: string }> }>(
      "https://provider.example/v1/models",
      { method: "POST", headers: { "X-Test": "1" }, body: '{"q":1}' },
    );

    expect(out).toEqual({ models: [{ id: "m1" }] });
    expect(externalRequest).toHaveBeenCalledWith({
      path: "https://provider.example/v1/models",
      method: "POST",
      headers: { "X-Test": "1" },
      body: '{"q":1}',
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("uploadAttachmentFile uses desktop uploadFile capability on Tauri", async () => {
    const uploadFile = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: {},
      body: JSON.stringify({
        ok: true,
        filename: "hello.txt",
        path: "/tmp/hello.txt",
        size: 5,
        mime_type: "text/plain",
      }),
    }));
    window.__HERMES_RUNTIME__ = { platform: "tauri" };
    window.hermesDesktop = {
      windowType: "tauri",
      request: vi.fn(),
      uploadFile,
    };
    const onProgress = vi.fn();

    const out = await uploadAttachmentFile(
      "session-1",
      new File(["hello"], "hello.txt", { type: "text/plain" }),
      onProgress,
    );

    expect(out).toMatchObject({
      ok: true,
      filename: "hello.txt",
      path: "/tmp/hello.txt",
      size: 5,
      mime_type: "text/plain",
    });
    expect(uploadFile).toHaveBeenCalledOnce();
    const [uploadInput] = uploadFile.mock.calls[0] as unknown as [{
      sessionId: string;
      name: string;
      type?: string;
      data: ArrayBuffer;
    }];
    expect(uploadInput).toMatchObject({
      sessionId: "session-1",
      name: "hello.txt",
      type: "text/plain",
    });
    expect(uploadInput.data).toBeInstanceOf(ArrayBuffer);
    expect(onProgress).toHaveBeenNthCalledWith(1, 0);
    expect(onProgress).toHaveBeenNthCalledWith(2, 100);
  });

  it("downloadExternalImageFile uses desktop downloadExternalImage capability", async () => {
    const downloadExternalImage = vi.fn(async () => ({
      finalUrl: "https://example.com/image.png",
      filename: "image.png",
      mimeType: "image/png",
      dataBase64: btoa("png-bytes"),
      size: 9,
    }));
    window.__HERMES_RUNTIME__ = { platform: "tauri" };
    window.hermesDesktop = {
      windowType: "tauri",
      request: vi.fn(),
      downloadExternalImage,
    };

    const file = await downloadExternalImageFile("https://example.com/image.png");

    expect(downloadExternalImage).toHaveBeenCalledWith({ url: "https://example.com/image.png" });
    expect(file.name).toBe("image.png");
    expect(file.type).toBe("image/png");
    expect(await file.text()).toBe("png-bytes");
  });
});
