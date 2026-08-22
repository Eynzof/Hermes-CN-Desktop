import { describe, expect, it } from "vitest";
import {
  browserRegistry,
  BrowserProviderRegistry,
  type BrowserProvider,
  type BrowserConfig,
  type BrowserSessionRecord,
  type CreateSessionResult,
  type BrowserOperationResult,
} from "./index.js";
import { LocalBrowserProvider, BrowserbaseProvider, BrowserUseCloudProvider, CamofoxProvider } from "./index.js";
import { BrowserBackendKind } from "./schemas.js";

class StubCdpProvider implements BrowserProvider {
  readonly name = BrowserBackendKind.Enum.cdp;
  readonly displayName = "CDP Override";
  async isAvailable() {
    return true;
  }
  async createSession(taskId: string): Promise<CreateSessionResult> {
    return { taskId, backend: this.name, cdpUrl: "ws://127.0.0.1:9222" };
  }
  async closeSession() {}
  async emergencyCleanup() {}
}

function makeLocal(): BrowserProvider {
  return new LocalBrowserProvider({
    invoke: async () => ({ success: true }),
  });
}

function makeCloud(name: "browserbase" | "browser-use" | "camofox", env: Record<string, string>): BrowserProvider {
  if (name === "browserbase") return new BrowserbaseProvider(env);
  if (name === "browser-use") return new BrowserUseCloudProvider(env);
  return new CamofoxProvider(env);
}

describe("BrowserProviderRegistry", () => {
  it("registers and lists providers", () => {
    const registry = new BrowserProviderRegistry();
    registry.register(makeLocal());
    expect(registry.list()).toHaveLength(1);
    expect(registry.get("local")).toBeDefined();
  });

  it("prefers CDP URL override over configured backend", async () => {
    const registry = new BrowserProviderRegistry();
    registry.register(makeLocal());
    registry.register(makeCloud("browserbase", { BROWSERBASE_API_KEY: "key" }));
    registry.register(new StubCdpProvider());

    const resolved = await registry.resolve(
      { backend: "browserbase" },
      { cdpUrl: "ws://127.0.0.1:9222/devtools/browser/abc" },
    );
    expect(resolved.kind).toBe("cdp");
    expect(resolved.reason).toBe("cdp_url_override");
  });

  it("uses explicit configured backend when available", async () => {
    const registry = new BrowserProviderRegistry();
    registry.register(makeLocal());
    registry.register(makeCloud("browserbase", { BROWSERBASE_API_KEY: "key" }));

    const resolved = await registry.resolve({ backend: "browserbase" });
    expect(resolved.kind).toBe("browserbase");
    expect(resolved.reason).toBe("configured_backend");
  });

  it("falls back through legacy preference order", async () => {
    const registry = new BrowserProviderRegistry();
    registry.register(makeLocal());
    registry.register(makeCloud("browser-use", { BROWSER_USE_API_KEY: "key" }));
    registry.register(makeCloud("browserbase", {}));

    const resolved = await registry.resolve({ backend: "local" });
    expect(resolved.kind).toBe("browser-use");
    expect(resolved.reason).toBe("legacy_preference");
  });

  it("falls back to local when nothing else is available", async () => {
    const registry = new BrowserProviderRegistry();
    registry.register(makeLocal());

    const resolved = await registry.resolve({ backend: "browserbase" });
    expect(resolved.kind).toBe("local");
    expect(resolved.reason).toBe("local_fallback");
  });

  it("throws when no provider is registered", async () => {
    const registry = new BrowserProviderRegistry();
    await expect(registry.resolve({})).rejects.toThrow("No browser provider is available");
  });

  it("env hints influence availability", async () => {
    const registry = new BrowserProviderRegistry();
    registry.register(makeLocal());
    registry.register(makeCloud("browserbase", { BROWSERBASE_API_KEY: "key" }));

    const resolved = await registry.resolve({ backend: "browserbase" });
    expect(resolved.kind).toBe("browserbase");
  });
});
