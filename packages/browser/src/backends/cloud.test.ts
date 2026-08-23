import { describe, expect, it } from "vitest";
import {
  BrowserbaseProvider,
  BrowserUseCloudProvider,
  CamofoxProvider,
  FirecrawlProvider,
} from "./cloud.js";
import { BrowserConfig, BrowserBackendKind, BrowserSessionRecord } from "../schemas.js";

const config = BrowserConfig.parse({});

describe("cloud backend availability", () => {
  it("browserbase is available when BROWSERBASE_API_KEY is set", async () => {
    const provider = new BrowserbaseProvider({ BROWSERBASE_API_KEY: "bb-123" });
    await expect(provider.isAvailable(config)).resolves.toBe(true);
  });

  it("browserbase is unavailable when the key is missing, empty, or a placeholder", async () => {
    await expect(new BrowserbaseProvider({}).isAvailable(config)).resolves.toBe(false);
    await expect(new BrowserbaseProvider({ BROWSERBASE_API_KEY: "" }).isAvailable(config)).resolves.toBe(
      false,
    );
    // Slack-style placeholder tokens are rejected by envKeyAvailable.
    await expect(new BrowserbaseProvider({ BROWSERBASE_API_KEY: "xoxb-abc" }).isAvailable(config)).resolves.toBe(
      false,
    );
  });

  it("browser-use is gated on BROWSER_USE_API_KEY", async () => {
    const provider = new BrowserUseCloudProvider({ BROWSER_USE_API_KEY: "bu-1" });
    await expect(provider.isAvailable(config)).resolves.toBe(true);
    await expect(new BrowserUseCloudProvider({}).isAvailable(config)).resolves.toBe(false);
  });

  it("firecrawl is gated on FIRECRAWL_API_KEY", async () => {
    const provider = new FirecrawlProvider({ FIRECRAWL_API_KEY: "fc-1" });
    await expect(provider.isAvailable(config)).resolves.toBe(true);
    await expect(new FirecrawlProvider({ FIRECRAWL_API_KEY: "" }).isAvailable(config)).resolves.toBe(false);
  });

  it("camofox is gated on CAMOFOX_URL", async () => {
    const provider = new CamofoxProvider({ CAMOFOX_URL: "https://camofox.local" });
    await expect(provider.isAvailable(config)).resolves.toBe(true);
    await expect(new CamofoxProvider({ CAMOFOX_URL: "" }).isAvailable(config)).resolves.toBe(false);
  });
});

describe("cloud backend identity", () => {
  it("exposes stable names and display names", () => {
    expect(new BrowserbaseProvider({}).name).toBe("browserbase");
    expect(new BrowserbaseProvider({}).displayName).toBe("Browserbase");
    expect(new BrowserUseCloudProvider({}).name).toBe("browser-use");
    expect(new BrowserUseCloudProvider({}).displayName).toBe("Browser Use Cloud");
    expect(new FirecrawlProvider({}).name).toBe("firecrawl");
    expect(new FirecrawlProvider({}).displayName).toBe("Firecrawl");
    expect(new CamofoxProvider({}).name).toBe("camofox");
    expect(new CamofoxProvider({}).displayName).toBe("Camofox");
  });
});

describe("cloud backend createSession", () => {
  it("browserbase creates a bb-<taskId> session with stub features", async () => {
    const provider = new BrowserbaseProvider({ BROWSERBASE_API_KEY: "bb-1" });
    const result = await provider.createSession("task-1", config);
    expect(result).toEqual({
      taskId: "task-1",
      backend: BrowserBackendKind.Enum.browserbase,
      sessionName: "bb-task-1",
      bbSessionId: undefined,
      features: { proxies: false, advancedStealth: false, keepAlive: false },
    });
  });

  it("browser-use creates a bu-<taskId> session with empty features", async () => {
    const provider = new BrowserUseCloudProvider({ BROWSER_USE_API_KEY: "bu-1" });
    const result = await provider.createSession("task-9", config);
    expect(result).toEqual({
      taskId: "task-9",
      backend: BrowserBackendKind.Enum["browser-use"],
      sessionName: "bu-task-9",
      features: {},
    });
  });

  it("firecrawl creates a fc-<taskId> session with a 300 s ttl feature", async () => {
    const provider = new FirecrawlProvider({ FIRECRAWL_API_KEY: "fc-1" });
    const result = await provider.createSession("task-2", config);
    expect(result).toEqual({
      taskId: "task-2",
      backend: BrowserBackendKind.Enum.firecrawl,
      sessionName: "fc-task-2",
      features: { ttl: 300 },
    });
  });

  it("camofox mirrors config.camofox.url and managedPersistence", async () => {
    const provider = new CamofoxProvider({ CAMOFOX_URL: "https://camofox.local" });
    const camoConfig = BrowserConfig.parse({
      camofox: { url: "https://camofox.local/connect", managedPersistence: true },
    });
    const result = await provider.createSession("task-3", camoConfig);
    expect(result).toEqual({
      taskId: "task-3",
      backend: BrowserBackendKind.Enum.camofox,
      sessionName: "camo-task-3",
      cdpUrl: "https://camofox.local/connect",
      features: { managedPersistence: true },
    });
  });

  it("camofox defaults cdpUrl and managedPersistence from the empty default config", async () => {
    const provider = new CamofoxProvider({ CAMOFOX_URL: "https://camofox.local" });
    const result = await provider.createSession("task-4", config);
    expect(result.cdpUrl).toBeUndefined();
    expect(result.features).toEqual({ managedPersistence: false });
  });
});

describe("cloud backend stubs", () => {
  it("navigate/snapshot return not-yet-implemented errors with the backend name", async () => {
    for (const provider of [
      new BrowserbaseProvider({ BROWSERBASE_API_KEY: "k" }),
      new BrowserUseCloudProvider({ BROWSER_USE_API_KEY: "k" }),
      new FirecrawlProvider({ FIRECRAWL_API_KEY: "k" }),
      new CamofoxProvider({ CAMOFOX_URL: "https://x" }),
    ]) {
      const record = BrowserSessionRecord.parse({ taskId: "t", backend: provider.name });
      const navigate = await provider.navigate?.(record, "https://example.com");
      expect(navigate).toEqual({
        success: false,
        error: `${provider.name} navigate not yet implemented`,
      });
      const snapshot = await provider.snapshot?.(record, true);
      expect(snapshot).toEqual({
        success: false,
        error: `${provider.name} snapshot not yet implemented`,
      });
    }
  });

  it("closeSession and emergencyCleanup resolve as stubs", async () => {
    const provider = new BrowserbaseProvider({ BROWSERBASE_API_KEY: "k" });
    await expect(
      provider.closeSession(BrowserSessionRecord.parse({ taskId: "t", backend: "browserbase" })),
    ).resolves.toBeUndefined();
    await expect(provider.emergencyCleanup()).resolves.toBeUndefined();
  });

  it("cloud providers do not implement local-only operations", () => {
    const provider = new BrowserbaseProvider({ BROWSERBASE_API_KEY: "k" });
    expect("click" in provider).toBe(false);
    expect("type" in provider).toBe(false);
    expect("scroll" in provider).toBe(false);
    expect("back" in provider).toBe(false);
    expect("press" in provider).toBe(false);
    expect("console" in provider).toBe(false);
  });
});
