import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isUiUpdateOverlayActive,
  listenForUiUpdateReady,
  uiUpdatingActivePayload,
  uiUpdatingSettledPayload,
} from "./use-ui-update";
import type { UiUpdateReadyPayload } from "@hermes/protocol";

describe("uiUpdatingActivePayload", () => {
  it("raises the blocking overlay in ui-update mode for install AND rollback", () => {
    // Both install and rollback funnel through the same overlay state.
    expect(uiUpdatingActivePayload()).toEqual({ active: true, mode: "ui-update" });
  });
});

describe("uiUpdatingSettledPayload", () => {
  it("clears the overlay on settle (success AND failure)", () => {
    expect(uiUpdatingSettledPayload()).toEqual({ active: false });
  });
});

describe("isUiUpdateOverlayActive", () => {
  it("is true only when active with mode ui-update", () => {
    expect(isUiUpdateOverlayActive(true, "ui-update")).toBe(true);
    expect(isUiUpdateOverlayActive(false, "ui-update")).toBe(false);
    expect(isUiUpdateOverlayActive(true, "install")).toBe(false);
    expect(isUiUpdateOverlayActive(true, "app-update")).toBe(false);
    expect(isUiUpdateOverlayActive(true, undefined)).toBe(false);
  });
});

describe("listenForUiUpdateReady", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const payload: UiUpdateReadyPayload = { uiVersion: "2.0.0" };

  function stubTauriBridge() {
    const listener = vi.fn((handler: (p: UiUpdateReadyPayload) => void) => {
      handler(payload);
      return () => {};
    });
    vi.stubGlobal("window", {
      __HERMES_RUNTIME__: { platform: "tauri" },
      hermesDesktop: { onUiUpdateReady: listener },
      location: { reload: vi.fn() },
    });
    return listener;
  }

  it("registers the listener and reloads on ui-update-ready", () => {
    const listener = stubTauriBridge();
    const unlisten = listenForUiUpdateReady();
    expect(listener).toHaveBeenCalledTimes(1);
    // Default reload path invoked with the payload.
    expect((window as any).location.reload).toHaveBeenCalledTimes(1);
    expect(typeof unlisten).toBe("function");
  });

  it("notifies the caller and honors a custom reload override", () => {
    stubTauriBridge();
    const onReady = vi.fn();
    const reload = vi.fn();
    listenForUiUpdateReady(onReady, reload);
    expect(onReady).toHaveBeenCalledWith(payload);
    expect(reload).toHaveBeenCalledWith(payload);
  });

  it("no-ops on the web platform (no tauri bridge)", () => {
    vi.stubGlobal("window", {
      __HERMES_RUNTIME__: { platform: "web" },
      hermesDesktop: {},
      location: { reload: vi.fn() },
    });
    const unlisten = listenForUiUpdateReady();
    expect(unlisten).toBeInstanceOf(Function);
  });

  it("no-ops when the bridge lacks onUiUpdateReady", () => {
    vi.stubGlobal("window", {
      __HERMES_RUNTIME__: { platform: "tauri" },
      hermesDesktop: {},
      location: { reload: vi.fn() },
    });
    const unlisten = listenForUiUpdateReady();
    expect(typeof unlisten).toBe("function");
    expect((window as any).location.reload).not.toHaveBeenCalled();
  });
});
