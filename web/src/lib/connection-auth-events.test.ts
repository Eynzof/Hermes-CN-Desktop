import { afterEach, describe, expect, it, vi } from "vitest";

import {
  notifyConnectionAuthRestored,
  onConnectionAuthRestored,
} from "./connection-auth-events";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("connection auth restored event", () => {
  it("notifies active listeners and supports unsubscribe", () => {
    vi.stubGlobal("window", new EventTarget());
    const listener = vi.fn();
    const off = onConnectionAuthRestored(listener);

    notifyConnectionAuthRestored();
    expect(listener).toHaveBeenCalledOnce();

    off();
    notifyConnectionAuthRestored();
    expect(listener).toHaveBeenCalledOnce();
  });

  it("is safe during server-side rendering", () => {
    vi.stubGlobal("window", undefined);

    expect(() => notifyConnectionAuthRestored()).not.toThrow();
    expect(() => onConnectionAuthRestored(() => {})()).not.toThrow();
  });
});
