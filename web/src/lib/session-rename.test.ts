import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renameSession } from "./session-rename";
import { readSessionTitleOverrides } from "./session-ui-state";
import { __resetUiStoreForTests } from "./ui-store";

beforeEach(() => {
  __resetUiStoreForTests();
  vi.stubGlobal("window", {
    dispatchEvent: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("renameSession", () => {
  it("rejects empty titles", async () => {
    const setSessionTitle = vi.fn();
    const resumeSession = vi.fn();
    await expect(
      renameSession("sess_1", "   ", { setSessionTitle, resumeSession }),
    ).rejects.toThrow(/请输入会话名称/);
    expect(setSessionTitle).not.toHaveBeenCalled();
    expect(resumeSession).not.toHaveBeenCalled();
  });

  it("persists the title returned by the gateway", async () => {
    const setSessionTitle = vi.fn().mockResolvedValue("整理后的标题");
    const resumeSession = vi.fn();
    const result = await renameSession("sess_1", "  我的标题  ", {
      setSessionTitle,
      resumeSession,
    });
    expect(result).toBe("整理后的标题");
    expect(setSessionTitle).toHaveBeenCalledWith("sess_1", "我的标题");
    expect(resumeSession).not.toHaveBeenCalled();
    expect(readSessionTitleOverrides()).toEqual({ sess_1: "整理后的标题" });
  });

  it("falls back to the trimmed input when the gateway returns nothing", async () => {
    const setSessionTitle = vi.fn().mockResolvedValue(undefined);
    const resumeSession = vi.fn();
    const result = await renameSession("sess_2", "新标题", {
      setSessionTitle,
      resumeSession,
    });
    expect(result).toBe("新标题");
    expect(readSessionTitleOverrides()).toEqual({ sess_2: "新标题" });
  });

  it("retries via resumeSession when the live session is gone", async () => {
    const setSessionTitle = vi
      .fn()
      .mockRejectedValueOnce(new Error("Session not found"))
      .mockResolvedValueOnce("OK");
    const resumeSession = vi.fn().mockResolvedValue("sess_3_resumed");
    const result = await renameSession("sess_3", "标题", {
      setSessionTitle,
      resumeSession,
    });
    expect(result).toBe("OK");
    expect(setSessionTitle).toHaveBeenCalledTimes(2);
    expect(setSessionTitle).toHaveBeenNthCalledWith(2, "sess_3_resumed", "标题");
    expect(resumeSession).toHaveBeenCalledWith("sess_3");
    const overrides = readSessionTitleOverrides();
    expect(overrides.sess_3).toBe("OK");
    expect(overrides.sess_3_resumed).toBe("OK");
  });

  it("persists locally when resume also reports session-not-found", async () => {
    const setSessionTitle = vi.fn().mockRejectedValue(new Error("session not found"));
    const resumeSession = vi.fn().mockRejectedValue(new Error("Session not found"));
    const result = await renameSession("sess_dead", "存档名", {
      setSessionTitle,
      resumeSession,
    });
    expect(result).toBe("存档名");
    expect(readSessionTitleOverrides()).toEqual({ sess_dead: "存档名" });
  });

  it("propagates non-not-found errors from the gateway", async () => {
    const setSessionTitle = vi.fn().mockRejectedValue(new Error("network down"));
    const resumeSession = vi.fn();
    await expect(
      renameSession("sess_x", "x", { setSessionTitle, resumeSession }),
    ).rejects.toThrow(/network down/);
    expect(resumeSession).not.toHaveBeenCalled();
  });
});
