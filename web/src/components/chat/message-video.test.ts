import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { resolveVideoStreamSource } from "./message-video";

describe("resolveVideoStreamSource", () => {
  let windowStubbed = false;

  beforeAll(() => {
    if (typeof (globalThis as { window?: unknown }).window === "undefined") {
      (globalThis as { window?: unknown }).window = {};
      windowStubbed = true;
    }
  });

  afterAll(() => {
    if (windowStubbed) delete (globalThis as { window?: unknown }).window;
  });

  afterEach(() => {
    delete window.__HERMES_RUNTIME__;
    delete window.__TAURI_INTERNALS__;
  });

  it("retries the same path when the runtime session token rotates", () => {
    window.__HERMES_RUNTIME__ = {
      platform: "tauri",
      connectionMode: "managed",
      dashboardApiBaseUrl: "http://127.0.0.1:9120",
      sessionToken: "old-token",
    };
    const path = "C:\\Users\\TU\\Desktop\\large.mp4";
    const first = resolveVideoStreamSource(path, undefined);
    expect(first.activeStreamSrc).toBe(first.streamSrc);

    window.__HERMES_RUNTIME__.sessionToken = "new-token";
    const retried = resolveVideoStreamSource(path, first.streamSrc);
    expect(retried.streamSrc).not.toBe(first.streamSrc);
    expect(retried.activeStreamSrc).toBe(retried.streamSrc);
    expect(new URL(retried.activeStreamSrc!).searchParams.get("token")).toBe("new-token");
  });
});
