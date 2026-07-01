import { afterEach, describe, expect, it, vi } from "vitest";
import { isNewSessionWindow, isSecondarySessionWindow, isWatchSessionWindow, windowSearchParams } from "./windows";

function setHash(hash: string) {
  vi.stubGlobal("window", { location: { hash, search: "" } });
}

describe("window route helpers", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reads hash-router session window parameters", () => {
    setHash("#/tasks/abc?window=session&watch=1");

    expect(windowSearchParams().get("window")).toBe("session");
    expect(isSecondarySessionWindow()).toBe(true);
    expect(isWatchSessionWindow()).toBe(true);
    expect(isNewSessionWindow()).toBe(false);
  });

  it("detects new secondary session windows", () => {
    setHash("#/?window=session&new=1");

    expect(isSecondarySessionWindow()).toBe(true);
    expect(isNewSessionWindow()).toBe(true);
  });
});
