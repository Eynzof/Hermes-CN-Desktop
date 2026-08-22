import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkSkillUpdates,
  installSkill,
  uninstallSkill,
  updateSkill,
} from "./hub";

describe("Skills Hub web helpers", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    // Pretend web mode so the transport layer skips the version gate.
    (globalThis as { window?: { __HERMES_RUNTIME__?: { platform?: string } } }).window = {
      __HERMES_RUNTIME__: { platform: "web" },
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete (globalThis as { window?: unknown }).window;
  });

  function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
    globalThis.fetch = vi.fn(async (url, init) =>
      handler(String(url), init as RequestInit | undefined),
    ) as unknown as typeof globalThis.fetch;
  }

  function jsonResponse(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  it("installSkill posts identifier and options", async () => {
    stubFetch((url, init) => {
      expect(url).toBe("/api/skills/hub/install");
      expect(init?.method).toBe("POST");
      const body = JSON.parse(init?.body as string);
      expect(body).toEqual({
        identifier: "official/coding/rust",
        registry_url: "https://example.com/index.json",
        force: true,
      });
      return jsonResponse({ ok: true, message: "installed" });
    });

    const result = await installSkill("official/coding/rust", {
      registryUrl: "https://example.com/index.json",
      force: true,
    });
    expect(result.ok).toBe(true);
    expect(result.message).toBe("installed");
  });

  it("uninstallSkill posts name", async () => {
    stubFetch((url, init) => {
      expect(url).toBe("/api/skills/hub/uninstall");
      expect(init?.method).toBe("POST");
      const body = JSON.parse(init?.body as string);
      expect(body).toEqual({ name: "rust" });
      return jsonResponse({ ok: true });
    });

    const result = await uninstallSkill("rust");
    expect(result.ok).toBe(true);
  });

  it("checkSkillUpdates fetches all updates by default", async () => {
    stubFetch((url) => {
      expect(url).toBe("/api/skills/hub/check");
      return jsonResponse({
        updates: [{ name: "rust", current: "1.0.0", latest: "1.1.0", has_update: true }],
      });
    });

    const result = await checkSkillUpdates();
    expect(result.updates).toHaveLength(1);
    expect(result.updates[0].has_update).toBe(true);
  });

  it("checkSkillUpdates scopes to a single skill", async () => {
    stubFetch((url) => {
      expect(url).toBe("/api/skills/hub/check?name=rust");
      return jsonResponse({ updates: [] });
    });

    await checkSkillUpdates("rust");
  });

  it("updateSkill updates all skills when no name is given", async () => {
    stubFetch((url, init) => {
      expect(url).toBe("/api/skills/hub/update");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(init?.body as string)).toEqual({});
      return jsonResponse({ ok: true, updated: ["rust"] });
    });

    const result = await updateSkill();
    expect(result.updated).toEqual(["rust"]);
  });

  it("updateSkill updates a single named skill", async () => {
    stubFetch((url, init) => {
      expect(url).toBe("/api/skills/hub/update");
      expect(JSON.parse(init?.body as string)).toEqual({ name: "rust" });
      return jsonResponse({ ok: true, updated: ["rust"] });
    });

    await updateSkill("rust");
  });

  it("propagates HTTP errors", async () => {
    stubFetch(() => new Response("bad request", { status: 400 }));

    await expect(installSkill("x")).rejects.toThrow(/HTTP 400/);
  });
});
