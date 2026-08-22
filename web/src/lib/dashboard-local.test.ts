/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  listFs,
  uploadAttachment,
  getMcpSummary,
  getActiveProfile,
  setActiveProfile,
  getMemoryProviderStatus,
  getOAuthProviders,
  mediaDataUrl,
  mediaFileUrl,
} from "./dashboard-local";
import type { FsListResponse, AttachmentUploadResult, McpServersResponse } from "@hermes/protocol";

describe("dashboard-local", () => {
  const originalWindow = window;
  let fetchCalls: { path: string; init?: RequestInit }[] = [];

  beforeEach(() => {
    fetchCalls = [];
    Object.defineProperty(window, "hermesDesktop", {
      writable: true,
      configurable: true,
      value: undefined,
    });
    Object.defineProperty(window, "__HERMES_RUNTIME__", {
      writable: true,
      configurable: true,
      value: { connectionMode: "managed" },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockDesktopApi(dapi: Partial<NonNullable<typeof window.hermesDesktop>>) {
    Object.defineProperty(window, "hermesDesktop", {
      writable: true,
      configurable: true,
      value: dapi as unknown as NonNullable<typeof window.hermesDesktop>,
    });
  }

  it("listFs uses desktop command in managed mode", async () => {
    const expected: FsListResponse = { entries: [{ name: "a", path: "/a", is_dir: false }], path: "/" };
    mockDesktopApi({ fsList: vi.fn().mockResolvedValue(expected) });
    const result = await listFs("/");
    expect(result).toEqual(expected);
  });

  it("listFs falls back to fetchJSON in remote mode", async () => {
    Object.defineProperty(window, "__HERMES_RUNTIME__", {
      value: { connectionMode: "remote", apiBaseUrl: "http://x" },
      writable: true,
      configurable: true,
    });
    const expected: FsListResponse = { entries: [], path: "/" };
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(expected),
    } as Response);
    const result = await listFs("/");
    expect(result).toEqual(expected);
  });

  it("uploadAttachment forwards bytes as base64", async () => {
    const expected: AttachmentUploadResult = {
      ok: true,
      filename: "x.txt",
      path: "/x.txt",
      size: 3,
      mime_type: "text/plain",
    };
    const upload = vi.fn().mockResolvedValue(expected);
    mockDesktopApi({ uploadAttachmentLocal: upload });
    const data = new Uint8Array([97, 98, 99]);
    await uploadAttachment({ sessionId: "s", name: "x.txt", mimeType: "text/plain", data });
    expect(upload).toHaveBeenCalledOnce();
    const args = upload.mock.calls[0]![0];
    expect(args.sessionId).toBe("s");
    expect(args.data).toBe("YWJj");
  });

  it("getMcpSummary returns desktop result when managed", async () => {
    const expected: McpServersResponse = {
      summary: { total: 1, enabled: 1 },
      servers: [{ name: "fs", enabled: true }],
    };
    mockDesktopApi({ getMcpSummary: vi.fn().mockResolvedValue(expected) });
    const result = await getMcpSummary();
    expect(result).toEqual(expected);
  });

  it("getActiveProfile returns desktop result", async () => {
    mockDesktopApi({
      getActiveProfile: vi.fn().mockResolvedValue({ name: "p", active: "p", current: "p" }),
    });
    const result = await getActiveProfile();
    expect(result.active).toBe("p");
  });

  it("setActiveProfile forwards name", async () => {
    const set = vi.fn().mockResolvedValue({ name: "q", active: "q", current: "p" });
    mockDesktopApi({ setActiveProfile: set });
    const result = await setActiveProfile("q");
    expect(set).toHaveBeenCalledWith({ name: "q" });
    expect(result.active).toBe("q");
  });

  it("getMemoryProviderStatus calls desktop with provider", async () => {
    const get = vi.fn().mockResolvedValue({
      provider: "hindsight",
      active: false,
      configured: false,
      reachable: false,
      healthy: false,
      endpoint: "",
      console_url: "",
      version: "",
      checked_at: "",
      error: "",
      details: null,
    });
    mockDesktopApi({ getMemoryProviderStatus: get });
    await getMemoryProviderStatus("hindsight");
    expect(get).toHaveBeenCalledWith("hindsight");
  });

  it("getOAuthProviders passes refresh flag", async () => {
    const get = vi.fn().mockResolvedValue({ providers: [] });
    mockDesktopApi({ getOAuthProviders: get });
    await getOAuthProviders({ refresh: true });
    expect(get).toHaveBeenCalledWith({ refresh: true });
  });

  it("mediaDataUrl returns data URL", async () => {
    mockDesktopApi({ mediaDataUrl: vi.fn().mockResolvedValue({ dataUrl: "data:x", mimeType: "x", size: 1 }) });
    const url = await mediaDataUrl("/x");
    expect(url).toBe("data:x");
  });

  it("mediaFileUrl returns custom protocol URL", async () => {
    mockDesktopApi({ mediaFileUrl: vi.fn().mockResolvedValue({ url: "hermes-media://file?path=x" }) });
    const url = await mediaFileUrl("/x");
    expect(url).toBe("hermes-media://file?path=x");
  });
});
