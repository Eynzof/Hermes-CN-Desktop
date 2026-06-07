import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isSessionPinned,
  readPinnedSessionIds,
  subscribeSessionUiStateChanges,
  togglePinnedSession,
  unpinSessions,
  writePinnedSessionIds,
} from "./session-ui-state";
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

describe("pinned session UI state", () => {
  it("persists clean pinned session ids with de-duplication", () => {
    writePinnedSessionIds([" s1 ", "", "s2", "s1", "   ", "s3"]);

    expect(Array.from(readPinnedSessionIds())).toEqual(["s1", "s2", "s3"]);
    expect(isSessionPinned("s2")).toBe(true);
    expect(isSessionPinned("missing")).toBe(false);
  });

  it("toggles pin and unpin for one session", () => {
    expect(Array.from(togglePinnedSession("s1"))).toEqual(["s1"]);
    expect(isSessionPinned("s1")).toBe(true);

    expect(Array.from(togglePinnedSession("s1"))).toEqual([]);
    expect(isSessionPinned("s1")).toBe(false);
  });

  it("ignores empty session ids", () => {
    writePinnedSessionIds(["s1"]);

    expect(Array.from(togglePinnedSession("   "))).toEqual(["s1"]);
    expect(Array.from(readPinnedSessionIds())).toEqual(["s1"]);
  });

  it("unpinned multiple sessions without touching others", () => {
    writePinnedSessionIds(["s1", "s2", "s3"]);

    expect(Array.from(unpinSessions(["s2", "missing", "s1"]))).toEqual(["s3"]);
    expect(Array.from(readPinnedSessionIds())).toEqual(["s3"]);
  });

  it("notifies subscribers when pinned state changes", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeSessionUiStateChanges(listener);

    writePinnedSessionIds(["s1"]);
    unsubscribe();
    writePinnedSessionIds(["s2"]);

    expect(listener).toHaveBeenCalledTimes(1);
  });
});
