import { afterEach, describe, expect, it, vi } from "vitest";
import { installBrowserCompanionRuntime, parseBrowserCompanionLaunch } from "./browser-companion";

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe("browser companion bootstrap", () => {
  it("accepts only a loopback companion origin", () => {
    expect(parseBrowserCompanionLaunch({
      hash: "#hermes-browser-origin=http%3A%2F%2F127.0.0.1%3A9546&hermes-browser-token=abc",
      pathname: "/",
      search: "",
    })).toEqual({ origin: "http://127.0.0.1:9546", token: "abc" });
    expect(parseBrowserCompanionLaunch({
      hash: "#hermes-browser-origin=https%3A%2F%2Fexample.com&hermes-browser-token=abc",
      pathname: "/",
      search: "",
    })).toBeNull();
  });

  it("loads runtime config with the companion token and clears the fragment", async () => {
    const replaceState = vi.fn();
    (globalThis as { window?: unknown }).window = {
      location: {
        hash: "#hermes-browser-origin=http%3A%2F%2Flocalhost%3A9550&hermes-browser-token=secret",
        pathname: "/connection",
        search: "?tab=advanced",
      },
      history: { replaceState },
    };
    const config = {
      platform: "web" as const,
      apiBaseUrl: "http://localhost:9550",
      gatewayUrl: "ws://localhost:9550/api/ws?token=secret",
      sessionToken: "secret",
      browserCompanion: true,
    };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(config), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));

    await expect(installBrowserCompanionRuntime(fetchImpl as typeof fetch)).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith("http://localhost:9550/__hermes_runtime", {
      headers: {
        Authorization: "Bearer secret",
        "X-Hermes-Browser-Token": "secret",
      },
    });
    expect(window.__HERMES_RUNTIME__).toEqual(config);
    expect(window.__HERMES_SESSION_TOKEN__).toBe("secret");
    expect(replaceState).toHaveBeenCalledWith(null, "", "/connection?tab=advanced");
  });
});
