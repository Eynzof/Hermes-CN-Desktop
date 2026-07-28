import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchJSON } from "@/lib/transport";
import { exportSessionJson, sessionExportFileName } from "./session-export";

vi.mock("@/lib/transport", () => ({ fetchJSON: vi.fn() }));

const mockedFetchJSON = vi.mocked(fetchJSON);
const nativeExport = vi.fn();

beforeEach(() => {
  mockedFetchJSON.mockReset();
  nativeExport.mockReset();
  vi.stubGlobal("window", { hermesDesktop: { exportSessionJson: nativeExport } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sessionExportFileName", () => {
  it("keeps official session-id naming while removing path characters", () => {
    expect(sessionExportFileName("abc-123")).toBe("session-abc-123.json");
    expect(sessionExportFileName(" abc/123 ")).toBe("session-abc_123.json");
  });
});

describe("exportSessionJson", () => {
  it("fetches the Core export and opens the native JSON save dialog", async () => {
    mockedFetchJSON.mockResolvedValue({
      id: "abc/123",
      messages: [{ role: "user", content: "你好" }],
    });
    nativeExport.mockResolvedValue({
      ok: true,
      canceled: false,
      path: "/tmp/session.json",
      bytes: 100,
    });

    const result = await exportSessionJson("abc/123", "profile one");

    expect(mockedFetchJSON).toHaveBeenCalledWith(
      "/api/sessions/abc%2F123/export?profile=profile%20one",
    );
    expect(nativeExport).toHaveBeenCalledWith({
      fileName: "session-abc_123.json",
      content: expect.stringContaining('"messages": ['),
    });
    expect(result).toMatchObject({ ok: true, fileName: "session-abc_123.json" });
  });

  it("surfaces native write failures", async () => {
    mockedFetchJSON.mockResolvedValue({ id: "abc" });
    nativeExport.mockResolvedValue({
      ok: false,
      canceled: false,
      bytes: 0,
      error: "disk full",
    });

    await expect(exportSessionJson("abc")).rejects.toThrow("disk full");
  });
});
