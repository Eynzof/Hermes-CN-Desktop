// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SkillsHubPanel } from "./skills-hub-panel";

const INDEX_URL = "https://example.com/index.json";

describe("SkillsHubPanel", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    const g = globalThis as { window?: { __HERMES_RUNTIME__?: { platform?: string } } };
    if (!g.window) g.window = {};
    g.window.__HERMES_RUNTIME__ = { platform: "web" };
  });

  afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
  });

  function mockFetchSequence(
    handlers: Array<{ url: string | RegExp; method?: string; response: unknown; status?: number }>,
  ) {
    let index = 0;
    globalThis.fetch = vi.fn(async (url, init) => {
      const u = String(url);
      const method = (init as RequestInit | undefined)?.method ?? "GET";
      const handler = handlers[index];
      if (!handler) {
        return new Response(JSON.stringify({ error: "unexpected fetch" }), { status: 500 });
      }
      const matches =
        typeof handler.url === "string" ? u === handler.url && method === (handler.method ?? "GET") : handler.url.test(u);
      if (!matches) {
        return new Response(JSON.stringify({ error: `unexpected fetch ${method} ${u}` }), { status: 500 });
      }
      index += 1;
      return new Response(JSON.stringify(handler.response), {
        status: handler.status ?? 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch;
  }

  it("searches the registry and renders results", async () => {
    mockFetchSequence([
      {
        url: INDEX_URL,
        response: {
          entries: [
            {
              name: "Rust",
              identifier: "official/coding/rust",
              source: "official",
              trust_level: "builtin",
              description: "Systems programming skill",
              tags: ["coding"],
            },
          ],
        },
      },
    ]);

    render(<SkillsHubPanel registryUrl={INDEX_URL} />);

    const input = screen.getByPlaceholderText("搜索 Skills Hub…");
    fireEvent.change(input, { target: { value: "rust" } });
    fireEvent.click(screen.getByRole("button", { name: /搜索/ }));

    await waitFor(() => {
      expect(screen.getByText("Rust")).toBeDefined();
    });
    expect(screen.getByText("builtin")).toBeDefined();
  });

  it("installs a skill from the hub", async () => {
    const onInstalled = vi.fn();
    mockFetchSequence([
      {
        url: INDEX_URL,
        response: {
          entries: [
            {
              name: "TypeScript",
              identifier: "official/coding/typescript",
              source: "official",
              trust_level: "trusted",
              description: "Typed JavaScript",
            },
          ],
        },
      },
      {
        url: "/api/skills/hub/install",
        method: "POST",
        response: { ok: true, message: "installed TypeScript" },
      },
    ]);

    render(<SkillsHubPanel registryUrl={INDEX_URL} onInstalled={onInstalled} />);

    fireEvent.change(screen.getByPlaceholderText("搜索 Skills Hub…"), {
      target: { value: "type" },
    });
    fireEvent.click(screen.getByRole("button", { name: /搜索/ }));

    await waitFor(() => {
      expect(screen.getByText("TypeScript")).toBeDefined();
    });

    fireEvent.click(screen.getByRole("button", { name: /安装/ }));

    await waitFor(() => {
      expect(onInstalled).toHaveBeenCalled();
    });
    expect(screen.getByText(/installed TypeScript/)).toBeDefined();
  });

  it("uninstalls a skill", async () => {
    const onUninstalled = vi.fn();
    mockFetchSequence([
      {
        url: INDEX_URL,
        response: {
          entries: [
            {
              name: "Helper",
              identifier: "community/helper",
              source: "community",
              trust_level: "community",
              description: "Helper skill",
            },
          ],
        },
      },
      {
        url: "/api/skills/hub/uninstall",
        method: "POST",
        response: { ok: true, message: "uninstalled Helper" },
      },
    ]);

    render(<SkillsHubPanel registryUrl={INDEX_URL} onUninstalled={onUninstalled} />);

    fireEvent.change(screen.getByPlaceholderText("搜索 Skills Hub…"), {
      target: { value: "helper" },
    });
    fireEvent.click(screen.getByRole("button", { name: /搜索/ }));

    await waitFor(() => {
      expect(screen.getByText("Helper")).toBeDefined();
    });

    fireEvent.click(screen.getByRole("button", { name: /卸载/ }));

    await waitFor(() => {
      expect(onUninstalled).toHaveBeenCalled();
    });
    expect(screen.getByText(/uninstalled Helper/)).toBeDefined();
  });

  it("shows an error when the registry is unreachable", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response("not found", { status: 404 }),
    ) as unknown as typeof globalThis.fetch;

    render(<SkillsHubPanel registryUrl={INDEX_URL} />);
    fireEvent.click(screen.getByRole("button", { name: /搜索/ }));

    await waitFor(() => {
      expect(screen.getByText(/HTTP 404/)).toBeDefined();
    });
  });
});
