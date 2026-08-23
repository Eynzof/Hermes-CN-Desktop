// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { applyPlatformToDOM, usePlatform } from "./use-platform";

function cleanupDom() {
  delete document.documentElement.dataset.hermesWindowType;
  delete document.body.dataset.hermesWindowType;
  delete (window as unknown as { __HERMES_RUNTIME__?: unknown }).__HERMES_RUNTIME__;
}

describe("applyPlatformToDOM", () => {
  beforeEach(() => cleanupDom());

  it("writes the platform to the html and body datasets", () => {
    applyPlatformToDOM("tauri");
    expect(document.documentElement.dataset.hermesWindowType).toBe("tauri");
    expect(document.body.dataset.hermesWindowType).toBe("tauri");
  });

  it("overwrites a previous platform", () => {
    applyPlatformToDOM("tauri");
    applyPlatformToDOM("web");
    expect(document.documentElement.dataset.hermesWindowType).toBe("web");
    expect(document.body.dataset.hermesWindowType).toBe("web");
  });
});

describe("usePlatform", () => {
  beforeEach(() => cleanupDom());

  it("defaults to 'web' when nothing declares a platform", () => {
    const { result } = renderHook(() => usePlatform());
    expect(result.current).toBe("web");
  });

  it("reads the platform from the body dataset (highest precedence)", () => {
    document.body.dataset.hermesWindowType = "electron";
    const { result } = renderHook(() => usePlatform());
    expect(result.current).toBe("electron");
  });

  it("reads the platform from the documentElement dataset", () => {
    document.documentElement.dataset.hermesWindowType = "tauri";
    const { result } = renderHook(() => usePlatform());
    expect(result.current).toBe("tauri");
  });

  it("falls back to the runtime bridge platform", () => {
    (window as unknown as { __HERMES_RUNTIME__: { platform: string } }).__HERMES_RUNTIME__ = {
      platform: "tauri",
    };
    const { result } = renderHook(() => usePlatform());
    expect(result.current).toBe("tauri");
  });

  it("prefers the body dataset over the runtime bridge", () => {
    document.body.dataset.hermesWindowType = "web";
    (window as unknown as { __HERMES_RUNTIME__: { platform: string } }).__HERMES_RUNTIME__ = {
      platform: "tauri",
    };
    const { result } = renderHook(() => usePlatform());
    expect(result.current).toBe("web");
  });

  it("re-renders when the body dataset changes (MutationObserver)", async () => {
    const { result } = renderHook(() => usePlatform());
    expect(result.current).toBe("web");

    act(() => {
      document.body.dataset.hermesWindowType = "electron";
    });
    await waitFor(() => expect(result.current).toBe("electron"));

    act(() => {
      document.body.dataset.hermesWindowType = "tauri";
    });
    await waitFor(() => expect(result.current).toBe("tauri"));
  });

  it("stops observing the body after unmount", async () => {
    const { result, unmount } = renderHook(() => usePlatform());
    expect(result.current).toBe("web");

    unmount();
    act(() => {
      document.body.dataset.hermesWindowType = "electron";
    });
    expect(result.current).toBe("web");
  });
});
